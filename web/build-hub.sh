#!/bin/sh
# Builds the DiffsHub-based UI into dist/hub/.
set -e
cd "$(dirname "$0")"
out=dist/hub
rm -rf "$out" && mkdir -p "$out/fonts"
# --production selects React's production JSX runtime (and minifies).
bun build hub/pdiff/main.tsx --outdir "$out" --target browser --production --format esm
bunx @tailwindcss/cli -i hub/pdiff/pdiff.css -o "$out/style.css" --minify
cp hub/pdiff/index.html "$out/"
cp hub/fonts/JetBrainsMonoBoxDrawing.woff2 "$out/fonts/"
