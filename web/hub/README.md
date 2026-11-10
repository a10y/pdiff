# hub: the DiffsHub UI in pdiff

This is the default pdiff UI. It is a copy of DiffsHub
(`apps/diffshub` in https://github.com/pierrecomputer/pierre, Apache-2.0, see
`LICENSE.md` and `NOTICE.md`), taken at commit
`769893a36b3dca1c9a38d46efc5d5c374d66b23b`.

- `components/`, `lib/`, `styles/`, `types/`: upstream files. Changes are
  marked with `pdiff:` comments. Files that pdiff does not use were removed.
- `pdiff/`: pdiff's own code. `main.tsx` replaces the Next.js layout,
  `PdiffReviewUI.tsx` replaces `components/ReviewUI.tsx`.

Build with `../build-hub.sh` (output: `../dist/hub/`). Check types with
`bun run typecheck`. `PDIFF_UI=classic pdiff` runs the first UI (`../src/`).

## Servo workarounds

- Inline SVG draws only literal `fill`/`stroke` attributes (no CSS, no
  `currentColor`): `pdiff/svgColorFix.ts`.
- The code view's shadow host does not restyle when its theme CSS changes:
  the viewer reloads on a theme change (`PdiffReviewUI.tsx`).
- A diffs worker start sometimes hangs: there is no worker pool
  (`components/WorkerPoolProvider.tsx`).
