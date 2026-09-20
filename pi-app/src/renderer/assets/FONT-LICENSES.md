# Bundled UI fonts

SleepClaw bundles fonts locally; displaying English or Chinese text does not
contact a font CDN or depend on an additional font installation.

- Inter Variable: `@fontsource-variable/inter` 5.3.0, Copyright 2016 The Inter
  Project Authors, SIL Open Font License 1.1.
- Unbounded Variable: `@fontsource-variable/unbounded` 5.3.0, Copyright 2022
  The Unbounded Project Authors, SIL Open Font License 1.1. Used for the English
  brand wordmark; other headings and body text use the shared body font stack.
- Noto Sans SC Variable: `@fontsource-variable/noto-sans-sc` 5.3.0, Google Inc.,
  SIL Open Font License 1.1.

The font binaries are unmodified. The original copyright and license texts
from each package's `LICENSE` are included by `scripts/runtime.cjs` in the
packaged `THIRD_PARTY_NOTICES.txt`. Font files use Unicode subsets so the
renderer loads only the subsets needed for the text being displayed.

The imported WOFF2 resources total approximately 4.73 MiB (Inter 0.21 MiB,
Unbounded 0.21 MiB, Noto Sans SC 4.31 MiB). The typography contract test enforces
a 5 MiB budget for these imported font resources.

## Local reference-font preview

When GT Eesti Text Trial is already installed by the user, the UI can use the
local Regular, Medium and Bold faces to preview the typography used on cht.me.
The CSS alias `GT Eesti Local` uses `local()` exclusively. SleepClaw does not
install, copy, embed or download these Trial font binaries.

On machines without these local faces, English falls back to the bundled Inter
Variable; Chinese uses the bundled Noto Sans SC Variable. Embedding a licensed
GT Eesti release in a distributed app remains pending a separate redistribution
license decision. The English brand wordmark continues to use Unbounded.
