# Logo

The mark is a small contribution graph read from the top, drawn in the app's
own status glyphs: circle = on target, diamond = warning, dashed ring = unknown.

- The **apex is the worst-of its children** (`SEVERITY` in
  `packages/core/src/constants.ts`). With an ok, a warning and an unknown child,
  the apex is a warning, never green or a neutral brand colour.
- The **amber edges are the signal**: the path from the top to the reading that
  caused it, i.e. *Follow the signal*.
- The **dashed ring is a stub** with nothing beneath it yet. It stays unknown and
  has no children. Dashes mean unknown and nothing else.
- The **thin solid edge** is a link: one leaf counts under two parents, which
  makes this a graph, not a tree.

If you change the mark, re-derive every node's status from its children so the
logo stays a rollup the engine would actually produce.

| File | Use |
|---|---|
| `logo.svg` | Mark + wordmark on light backgrounds (README default) |
| `logo-dark.svg` | Mark + wordmark on dark backgrounds |
| `logo-mark.svg` | Full mark alone, 64 grid |
| `logo-small.svg` | Simplified mark for 16–32 px; also `apps/web/public/favicon.svg` and the top bar |
| `logo-mono.svg` | One colour (`currentColor`); status is carried by shape alone |

The wordmark is outlined from Noto Sans SemiBold (SIL Open Font License), so it
renders the same everywhere.
