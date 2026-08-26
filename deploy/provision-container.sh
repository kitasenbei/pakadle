#!/usr/bin/env bash
# Turn the Pakadle box into something that deploys itself. Run once, as root:
#
#   ssh root@<host> 'bash -s' < deploy/provision-container.sh
#
# Afterwards the machine owns its whole pipeline: a git remote to push to, a
# registry to hold its images, and a hook that swaps builds and rolls back on
# its own. Nothing outside this server and your workstation is involved.
#
# Idempotent, and it leaves the database and the nginx config alone.
set -euo pipefail

APP_USER="pakadle"
APP_HOME="/srv/pakadle"
DATA_DIR="$APP_HOME/data"
DEPLOY_DIR="$APP_HOME/deploy"
REPO_DIR="$APP_HOME/repo.git"
WORK_DIR="$APP_HOME/app"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

say "Installing podman, git and curl"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman git curl >/dev/null
say "    podman $(podman --version | awk '{print $3}')"

say "Creating deploy directories"
install -d -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$DEPLOY_DIR" "$APP_HOME/registry"

# A database from the bare-metal era lives in the app dir; move it under data so
# the container's volume mount finds it. Only ever runs once.
if [ -f "$WORK_DIR/pakadle.db" ] && [ ! -f "$DATA_DIR/pakadle.db" ]; then
    say "Moving the existing database into $DATA_DIR"
    mv "$WORK_DIR/pakadle.db" "$DATA_DIR/pakadle.db"
    chown "$APP_USER:$APP_USER" "$DATA_DIR/pakadle.db"
fi

say "Creating the bare repo to push to"
if [ ! -d "$REPO_DIR" ]; then
    sudo -u "$APP_USER" git init --bare --quiet "$REPO_DIR"
fi
install -m 0755 -o "$APP_USER" -g "$APP_USER" \
    "$SRC/hooks/post-receive" "$REPO_DIR/hooks/post-receive"

say "Installing the registry and app units"
# The container unit takes over the name "pakadle". Keep the bare-metal unit it
# replaces under another name first: the very first deploy has no previous image
# to roll back to, so this is the way back if that one deploy goes wrong.
if [ -f /etc/systemd/system/pakadle.service ] && \
   ! grep -q podman /etc/systemd/system/pakadle.service; then
    cp /etc/systemd/system/pakadle.service /etc/systemd/system/pakadle-baremetal.service
    sed -i 's/^Description=.*/Description=Pakadle on bare node (pre-container fallback)/' \
        /etc/systemd/system/pakadle-baremetal.service
    say "    saved the old unit as pakadle-baremetal.service"
fi
install -m 0644 "$SRC/pakadle-registry.service"  /etc/systemd/system/pakadle-registry.service
install -m 0644 "$SRC/pakadle-container.service" /etc/systemd/system/pakadle.service

# The unit refuses to start without this file. A placeholder keeps systemd quiet
# until the first real deploy overwrites it.
if [ ! -f "$DEPLOY_DIR/current.env" ]; then
    printf 'PAKADLE_IMAGE=\nPAKADLE_BUILD=none\n' > "$DEPLOY_DIR/current.env"
    chown "$APP_USER:$APP_USER" "$DEPLOY_DIR/current.env"
fi

say "Confirming the deploy user's sudo rule still covers the new unit"
# The unit kept the name "pakadle", so the existing rule applies unchanged.
sudo -u "$APP_USER" sudo -n -l /usr/bin/systemctl restart pakadle >/dev/null \
    && say "    ok, no new privileges granted"

systemctl daemon-reload
say "Starting the registry"
systemctl enable --now pakadle-registry >/dev/null 2>&1 || systemctl restart pakadle-registry
for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:5000/v2/ >/dev/null && break
    sleep 1
done
curl -sf http://127.0.0.1:5000/v2/ >/dev/null \
    && say "    registry answering on 127.0.0.1:5000" \
    || { echo "registry did not come up"; systemctl status pakadle-registry --no-pager | tail -20; exit 1; }

systemctl enable pakadle >/dev/null 2>&1 || true

say "Done. From your workstation:"
echo
echo "    git remote add production ssh://$APP_USER@\$(hostname -I | awk '{print \$1}')$REPO_DIR"
echo "    ./deploy/ship.sh"
echo
say "nginx and the database were left untouched."
say "If the first deploy goes wrong, the way back is:"
echo "    systemctl stop pakadle && systemctl start pakadle-baremetal"
