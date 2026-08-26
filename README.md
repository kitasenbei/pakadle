# Pakadle 🥕

A daily [Umamusume](https://umamusume.fandom.com/) word game — guess the day's character in six tries, Wordle-style. Character names, portraits, and catchphrases are sourced from the Umamusume fandom wiki.

## Stack

Zero runtime dependencies. The frontend is plain HTML/CSS/JS; the backend is Node's built-in HTTP server plus the built-in `node:sqlite` module.

- `index.html`, `style.css`, `game.js` — the game (flat Umamusume palette, CSS-only animations)
- `words.js` — the character pool (served **only** to the backend, never to the browser)
- `server.js` — HTTP server + daily-puzzle API, persists results to SQLite
- `pakadle.db` — created automatically on first run (git-ignored)

## Run

Requires Node.js ≥ 22.5 (for `node:sqlite`).

```bash
npm start          # or: node server.js
# open http://localhost:3000
```

## How the daily works

The puzzle for a date is deterministic: `puzzleNumber = days since 2026-01-01`, and the word is `WORDS[puzzleNumber % WORDS.length]`. Each date's word is locked in the `puzzles` table the first time it's requested. Your outcome (win/loss, guess count, and the actual guesses) is stored once per day in `results`, so reloading restores your board and a finished day stays locked until the next local midnight.

## API

| Endpoint | Description |
|---|---|
| `GET /api/daily` | Today's puzzle + your saved progress + stats |
| `POST /api/result` | Persist today's outcome (one per day) |
| `GET /api/stats` | Played / win% / current streak / max streak / guess distribution |

## Pakapix (bundled sibling game)

A daily "guess the pixelated Umamusume" game is served at `/pakapix`. It is mounted
by this server via `pakapix/routes.js`, with its own data, portrait assets, and
tables (`pix_puzzles`, `pix_plays`), and it shares the visitor cookie with Pakadle.
The portrait is scored and revealed server-side, so the clear image never reaches
the browser until the player finishes. Header links cross-promote the two games.

## Deploying

Pakadle deploys itself. The pipeline is a git remote, a container registry and a
hook, all living on the same box the game runs on, so a deploy depends on
nothing but that server and the machine you are pushing from.

```bash
./deploy/ship.sh
```

That runs the tests here, builds the image here, sends it to the server and puts
it live. What crosses the wire is only the layers that changed, usually about a
megabyte, through an SSH tunnel to a registry bound to loopback on the server.

```
workstation                              server
  npm test
  podman build  ──┐
                  └── ssh tunnel ──▶  registry (127.0.0.1:5000)
  git push production main  ────────▶  post-receive hook
                                         swap  → systemctl restart pakadle
                                         probe → GET /healthz
                                         ok?   → done
                                         no?   → previous image, restart, exit 1
```

### Why it is shaped this way

The server is one core and 961MB of RAM, which rules out running a CI service on
it. Tests and builds happen on the workstation, which has cores to spare, and
the server only ever pulls an image and restarts.

The image is built from `git archive HEAD`, never from the working tree, so
uncommitted edits cannot reach production. Deploying a change means committing
it first.

The build context is split into a media tree (about 2240 png, 185MB, changes
rarely) and a source tree (about 1MB, changes every deploy), copied as separate
layers in that order. Without the split, every one-line change would re-push the
whole 185MB.

`/healthz` reports both liveness and the build id it is serving. The hook waits
for the id it just deployed, so a container still serving the previous image
cannot be mistaken for a successful deploy, and anything else triggers an
automatic rollback to the last image that was healthy.

### First-time setup

Once per server, as root:

```bash
tar cz deploy | ssh root@<host> \
  'mkdir -p /tmp/pk && tar xz -C /tmp/pk && bash /tmp/pk/deploy/provision-container.sh'
```

The whole directory has to go, not just the script: it installs the unit files
and the hook that sit beside it.

It installs podman, creates the bare repo and its hook, starts the registry, and
installs the systemd units. It leaves nginx and the database alone. The unit
keeps the name `pakadle`, so the deploy user's existing one-line sudo rule
(`systemctl restart pakadle`, and nothing else) still covers it.

Then, once, on your machine:

```bash
git remote add production ssh://pakadle@<host>/srv/pakadle/repo.git
```

The bare-metal unit this replaces is kept as `pakadle-baremetal.service`. The
first deploy is the one with no previous image behind it, so if that one fails,
`systemctl stop pakadle && systemctl start pakadle-baremetal` puts the old
process back.

### Rolling back by hand

The hook rolls back on its own when a deploy fails its health check. To go back
after a deploy that passed but turned out to be wrong, on the server:

```bash
cp /srv/pakadle/deploy/previous.env /srv/pakadle/deploy/current.env
sudo systemctl restart pakadle
```

Every image stays in the local registry, so any prior commit can be made live by
putting its short sha in `current.env`.
