#!/usr/bin/env bash
# Local dev for Pakadle / Pakachess: a tmux session with two windows,
#   window "server"  -> the Node server (port 3010, local sqlite in /tmp)
#   window "client"  -> waits for the server, then opens the browser
#
#   usage:  ./dev.sh           (Ctrl-b then 0/1 to switch windows; Ctrl-b d to detach)
#   stop:   tmux kill-session -t pakachess     (or just close the server window)
set -euo pipefail

SESSION="pakachess"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3010}"
DB="${PAKADLE_DB:-/tmp/pakadle_local.db}"
URL="http://localhost:${PORT}/pakachess"

command -v tmux >/dev/null || { echo "tmux is not installed (try: sudo dnf install tmux)"; exit 1; }

# stop any old server; the [n] keeps this very line from matching (and killing) itself
pkill -f "[n]ode server.js" 2>/dev/null || true
tmux kill-session -t "$SESSION" 2>/dev/null || true

# window 1: the server
tmux new-session -d -s "$SESSION" -n server -c "$DIR"
tmux send-keys -t "$SESSION:server" "PORT=$PORT PAKADLE_DB=$DB node server.js" C-m

# window 2: the client (poll until the server answers, then open the browser)
tmux new-window -t "$SESSION" -n client -c "$DIR"
tmux send-keys -t "$SESSION:client" \
  "until curl -sf -o /dev/null '$URL'; do sleep 0.3; done; \
   echo 'Pakachess is up -> $URL'; \
   (xdg-open '$URL' >/dev/null 2>&1 || open '$URL' >/dev/null 2>&1 || true); \
   echo 'For a 2nd player, open an Incognito/Private window to the same URL.'" C-m

tmux select-window -t "$SESSION:server"
exec tmux attach -t "$SESSION"
