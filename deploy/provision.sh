#!/usr/bin/env bash
# Provision a fresh VPS to run Pakadle. Idempotent: safe to re-run.
# Run as root on the server:  bash provision.sh "<ci_deploy_public_key>"
set -euo pipefail

CI_PUBKEY="${1:-}"
APP_USER="pakadle"
APP_HOME="/srv/pakadle"
APP_DIR="$APP_HOME/app"
DATA_DIR="$APP_HOME/data"

echo "==> Detecting package manager"
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
else
  echo "Unsupported distro (need apt or dnf)"; exit 1
fi
echo "    using: $PKG"

echo "==> Installing Node.js 22, nginx, rsync"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  apt-get install -y nginx rsync
else
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  fi
  dnf install -y nginx rsync
fi
echo "    node $(node -v)"

echo "==> Creating app user '$APP_USER' and directories"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -d "$APP_HOME" -s /bin/bash "$APP_USER"
passwd -l "$APP_USER" >/dev/null 2>&1 || true   # SSH-key login only
mkdir -p "$APP_DIR" "$DATA_DIR" "$APP_HOME/.ssh"
chmod 700 "$APP_HOME/.ssh"
chown -R "$APP_USER:$APP_USER" "$APP_HOME"

if [ -n "$CI_PUBKEY" ]; then
  echo "==> Installing CI deploy key into authorized_keys"
  AK="$APP_HOME/.ssh/authorized_keys"
  touch "$AK"
  grep -qF "$CI_PUBKEY" "$AK" || echo "$CI_PUBKEY" >> "$AK"
  chmod 600 "$AK"
  chown "$APP_USER:$APP_USER" "$AK"
fi

echo "==> Granting '$APP_USER' a narrow sudo rule to restart its own service"
cat >/etc/sudoers.d/pakadle <<'EOF'
pakadle ALL=(root) NOPASSWD: /usr/bin/systemctl restart pakadle, /usr/bin/systemctl status pakadle, /bin/systemctl restart pakadle, /bin/systemctl status pakadle
EOF
chmod 440 /etc/sudoers.d/pakadle

echo "==> Installing systemd service"
cp "$APP_DIR/deploy/pakadle.service" /etc/systemd/system/pakadle.service 2>/dev/null || \
  cat >/etc/systemd/system/pakadle.service <<EOF
[Unit]
Description=Pakadle daily Umamusume word game
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=PAKADLE_DB=$DATA_DIR/pakadle.db
Environment=NODE_NO_WARNINGS=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
CPUQuota=60%
MemoryMax=256M
TasksMax=256
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pakadle >/dev/null 2>&1 || true

echo "==> Configuring nginx reverse proxy (port 80 -> 127.0.0.1:3000)"
# drop distro default sites so ours is the default_server
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
sed -i 's/listen\s*80\s*default_server;/listen 80;/g; s/listen\s*\[::\]:80\s*default_server;/listen [::]:80;/g' /etc/nginx/nginx.conf 2>/dev/null || true
install -d /etc/nginx/conf.d
cp "$APP_DIR/deploy/nginx-pakadle.conf" /etc/nginx/conf.d/pakadle.conf 2>/dev/null || \
  cat >/etc/nginx/conf.d/pakadle.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
EOF
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

echo "==> Opening firewall for HTTP/HTTPS (keeping SSH)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "==> Provision complete. App user: $APP_USER  |  App dir: $APP_DIR  |  Data: $DATA_DIR"
echo "    (start the service after the first code sync: systemctl restart pakadle)"
