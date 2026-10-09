#!/usr/bin/env python3
"""Build the Pakadoom tile atlas: one whole tail per tile, on black.

Umapple composites the same tails on white, which suits a white Bad Apple
frame but leaves every tile light. Doom is mostly dark, so here each tail is
fitted whole into its tile over black. A tile's tone is then how much hair
the tail puts on black and how light that hair is, and its hue is the hair
colour. The page matches chunks on those, so every cell is a complete tail.

Writes:
  pakadoom/atlas.png   TILE px tiles, COLS per row
  pakadoom/tiles.json  {tile, cols, n, rgb: [[r,g,b], ...]} mean colour per tile

Run from the repo root:  python3 pakadoom/build-atlas.py
"""
import json
import os
import sys

from PIL import Image

SRC = "tailoftheday/cropped_horse"
OUT_PNG = "pakadoom/atlas.png"
OUT_JSON = "pakadoom/tiles.json"
TILE = 64
COLS = 32


def tile_of(path):
    im = Image.open(path).convert("RGBA")
    im = im.crop(im.getbbox() or (0, 0, im.width, im.height))
    scale = TILE / max(im.size)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 255))
    tile.alpha_composite(im, ((TILE - im.width) // 2, (TILE - im.height) // 2))
    tile = tile.convert("RGB")
    return tile, tile.resize((1, 1), Image.BOX).getpixel((0, 0))


def main():
    files = sorted(f for f in os.listdir(SRC) if f.endswith(".png"))
    if not files:
        sys.exit(f"no png files in {SRC}")
    tiles = [tile_of(os.path.join(SRC, f)) for f in files]
    rows = (len(tiles) + COLS - 1) // COLS
    atlas = Image.new("RGB", (COLS * TILE, rows * TILE), (0, 0, 0))
    rgb = []
    for k, (tile, px) in enumerate(tiles):
        atlas.paste(tile, ((k % COLS) * TILE, (k // COLS) * TILE))
        rgb.append(list(px))
    atlas.save(OUT_PNG, optimize=True)
    with open(OUT_JSON, "w") as fh:
        json.dump({"tile": TILE, "cols": COLS, "n": len(tiles), "rgb": rgb}, fh, separators=(",", ":"))
    lums = sorted(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in rgb)
    print(f"{len(tiles)} tails, luminance {lums[0]:.0f} to {lums[-1]:.0f}, median {lums[len(lums) // 2]:.0f}; "
          f"atlas {atlas.size[0]}x{atlas.size[1]}")


if __name__ == "__main__":
    main()
