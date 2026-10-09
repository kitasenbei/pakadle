# Pakadoom

Shareware Doom, drawn every frame with the Umapple portrait mosaic.

## Files

- `websockets-doom.js`, `websockets-doom.wasm`: the Chocolate Doom WebAssembly
  build published by Cloudflare at https://silentspacemarine.com, fetched on
  2026-10-10. Source: https://github.com/cloudflare/doom-wasm (GNU GPL, see
  COPYING.md). A rebuild of that source with Emscripten 3.1.64 ran but
  corrupted game state (wrong HUD values, empty level, stray netgame
  messages), so the published binaries are used as they are.
- `doom1.wad`: the Doom 1.9 shareware IWAD, freely redistributable.
  SHA-1 5b2e249b9c5133ec987b3ea77596381dc0d6bc1d.
- `default.cfg`: Chocolate Doom config, passed as both the main and the extra
  config. It forces the software renderer, so the canvas is a plain 2D canvas
  the page can read, and a 640x400 window with integer scaling, so the 320x200
  frame is an exact 2x and does not shimmer.
- `index.html`, `game.js`, `style.css`: the page. The Doom canvas must keep the
  id `canvas`, which is how SDL finds and sizes it.

## Keys

Arrows turn, W and S move, A and D strafe, Space fires, E uses. V peeks at the real Doom frame in a
corner, M mutes the music, minus and plus make the tails bigger and smaller.
