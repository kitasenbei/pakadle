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
