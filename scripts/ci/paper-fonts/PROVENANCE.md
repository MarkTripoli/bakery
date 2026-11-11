# Paper-lane fallback font

`JetBrainsMonoNerdFont-Regular.ttf` — JetBrainsMono Nerd Font 3.5.0 (Arch
`ttf-jetbrains-mono-nerd-basic`), SIL OFL 1.1 (`OFL.txt`). sha256
`1767e08e6b207eb57c114e833b817e26c6a7625bbcf474e3b4dd0f73c10e5bdc`.

Only job: supply U+2318 `⌘`, U+2304 `⌄`, U+2713 `✓`, which Geist lacks, to the
`ui_paper` render lane via `scripts/ci/paper-fontconfig.sh`. It is not a product
font and not part of the Paper reference inputs.

Licensing: the base design is JetBrains Mono (OFL 1.1, copyright in `OFL.txt`).
The Nerd Fonts patcher merges glyphs from further fonts under their own licenses
(see https://github.com/ryanoasis/nerd-fonts/blob/master/LICENSE). Only the
three glyphs above are used; no patched icon glyph is rendered. Swap to plain
JetBrains Mono only if re-proven against all 263 Paper cases.
