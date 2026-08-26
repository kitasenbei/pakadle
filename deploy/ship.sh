#!/usr/bin/env bash
# Build Pakadle here and put it live, without depending on anyone else's CI.
#
#   ./deploy/ship.sh              build HEAD, push it, deploy it
#   ./deploy/ship.sh --no-deploy  build and push the image, stop before going live
#
# Tests and the container build run on this machine because it has cores to
# spare; the server has one. What crosses the wire is the image, and only the
# layers that actually changed, through an SSH tunnel to a registry that is
# bound to loopback on the server and reachable from nowhere else.
#
# The image is built from `git archive HEAD`, never from the working tree, so
# uncommitted edits cannot reach production by accident.
set -euo pipefail

HOST="${PAKADLE_HOST:-139.162.170.246}"
SSH_USER="${PAKADLE_SSH_USER:-pakadle}"
SSH_KEY="${PAKADLE_SSH_KEY:-$HOME/.ssh/pakadle_ci}"
REGISTRY_PORT=5000
IMAGE_NAME="pakadle"
DEPLOY=1

[ "${1:-}" = "--no-deploy" ] && DEPLOY=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ENGINE="$(command -v podman || command -v docker)" || { echo "need podman or docker"; exit 1; }
SSH="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=10"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!!\033[0m %s\n' "$*" >&2; exit 1; }

# ---- what are we shipping ------------------------------------------------
SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH', not main. Deploy from main."

if ! git diff-index --quiet HEAD --; then
    say "working tree has uncommitted changes; building HEAD ($SHA) and leaving them behind:"
    git diff-index --name-only HEAD -- | sed 's/^/      /'
fi

# ---- tests ---------------------------------------------------------------
say "tests"
npm test >/dev/null 2>&1 || { npm test; die "tests failed, nothing shipped"; }
say "tests    ok"

# ---- context -------------------------------------------------------------
# Split the commit into a media tree and a source tree so the 180MB of png
# lands in a layer that a code change does not invalidate. Sorting by kind
# rather than by directory means a new asset folder needs no edit here.
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"; [ -n "${TUNNEL:-}" ] && ssh -S "$TUNNEL" -O exit "$SSH_USER@$HOST" 2>/dev/null || true' EXIT

mkdir -p "$CTX/app" "$CTX/media"
git archive --format=tar HEAD | tar -x -C "$CTX/app"

( cd "$CTX/app" && find . -type f \
    \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \
       -o -iname '*.gif' -o -iname '*.ico' -o -iname '*.woff' -o -iname '*.woff2' \) \
    -print0 | tar --null -T - -c --remove-files -f - ) | tar -x -C "$CTX/media"

MEDIA_MB=$(du -sm "$CTX/media" | cut -f1)
APP_MB=$(du -sm "$CTX/app" | cut -f1)
say "context  media ${MEDIA_MB}MB / app ${APP_MB}MB"

# ---- build ---------------------------------------------------------------
say "build    $IMAGE_NAME:$SHA"
"$ENGINE" build -f Dockerfile -t "$IMAGE_NAME:$SHA" -t "$IMAGE_NAME:latest" "$CTX"

# ---- push through a tunnel ----------------------------------------------
# The registry listens on 127.0.0.1 on the server only. Forwarding it over SSH
# means the image never travels in the clear and the registry is never exposed.
say "tunnel   127.0.0.1:$REGISTRY_PORT -> $HOST"
TUNNEL="$CTX/ssh-ctl"
ssh -i "$SSH_KEY" -o BatchMode=yes -M -S "$TUNNEL" -fN \
    -L "$REGISTRY_PORT:127.0.0.1:$REGISTRY_PORT" "$SSH_USER@$HOST"

curl -sf "http://127.0.0.1:$REGISTRY_PORT/v2/" >/dev/null \
    || die "no registry answering through the tunnel. Run deploy/provision-container.sh on the server first."

say "push     only changed layers cross the wire"
"$ENGINE" push --tls-verify=false \
    "$IMAGE_NAME:$SHA" "127.0.0.1:$REGISTRY_PORT/$IMAGE_NAME:$SHA"

if [ "$DEPLOY" = 0 ]; then
    say "pushed $SHA, stopping before deploy as asked"
    exit 0
fi

# ---- go live -------------------------------------------------------------
# The git push is the trigger. The hook on the other end does the swap, the
# health check and the rollback, and its output streams back here.
say "deploy   git push production $BRANCH"
git push production "$BRANCH"
