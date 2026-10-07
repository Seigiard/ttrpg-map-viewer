# Upstream source

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, verified by upstream `scripts/sync-skill-assets.mjs --check` against canonical `src/`.
- Installed at: `tools/oxlint/anti-slop/`, including Effect sources and vendored Stylistic license and provenance.
- Added files: this provenance record and upstream root `LICENSE`. Production plugin files are unchanged. Upstream tests are omitted by its installer.
- Coverage: all 18 generic rules plus `oxc/no-accumulating-spread`; all five Effect rules run at `error` on `src/utils/process.ts` now that Effect is a direct dependency. The override follows Effect-owned modules; plain async/neverthrow event modules retain their existing tagged unions.
- Effect activation changes configuration only. Vendored production sources still match the recorded upstream commit.
