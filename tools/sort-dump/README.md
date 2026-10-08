# sort-dump

One-off host tool that turns a **dump** (many unrelated maps side by side in one folder) into one folder per **map**, with each map's **variants** inside it. It is the only tool allowed to write into the collection.

It works in three steps:

1. `plan` is a dry run. It reads the dump and writes a plan file. It never changes the dump.
2. You review and edit the plan.
3. `apply` moves files exactly as the edited plan says.

Requires Bun only; no dependencies.

## Usage

```sh
bun tools/sort-dump/sort-dump.ts plan <dumpDir> [--out sort-dump.plan] [--force] [--one-per-file]
bun tools/sort-dump/sort-dump.ts apply <planFile> [--dump <dumpDir>]
```

Shorthands from the issue: `sort-dump <dumpDir>` is `plan`, `sort-dump --apply <planFile>` is `apply`.

`plan` refuses to overwrite an existing plan file (it may hold your edits) unless you pass `--force`.

`--one-per-file` skips name normalisation: every file gets its own map folder, named after the file without its extension. Only files that differ just by extension share a folder. Use it for packs, where `Ice Cave,  1x1_001_1.jpg` and `Ice Cave, 1x1_001_1.jpg` are different maps and variants of one map are never stored side by side.

### On the homelab host (no Bun installed)

Mount the collection at the **same path** inside the container, so the `dump:` path in the plan is valid both inside and outside. Run as your own user, or new map folders will belong to root.

In zsh, brace a variable that is followed by a mount option: `-v "${B}:${B}:ro"`. Unbraced, `$B:r` is read as the zsh `:r` modifier.

```sh
cd ~/ttrpg-map-viewer   # this repo
docker run --rm --user "$(id -u):$(id -g)" \
  -v /mnt/data/public/ttrpg/BattleMaps:/mnt/data/public/ttrpg/BattleMaps \
  -v "$PWD":/work -w /work \
  oven/bun:1-alpine \
  bun tools/sort-dump/sort-dump.ts plan /mnt/data/public/ttrpg/BattleMaps/battlemaps --out battlemaps.plan

# edit battlemaps.plan, then:
docker run --rm --user "$(id -u):$(id -g)" \
  -v /mnt/data/public/ttrpg/BattleMaps:/mnt/data/public/ttrpg/BattleMaps \
  -v "$PWD":/work -w /work \
  oven/bun:1-alpine \
  bun tools/sort-dump/sort-dump.ts apply battlemaps.plan
```

## What `plan` looks at

Only files directly inside `<dumpDir>` with the extensions `webp jpg jpeg png webm mp4 dd2vtt`. Subfolders and other files (zips, txt) stay where they are. Other files are listed at the end of the plan as comments.

## Plan format

Plain text, one `file -> map folder` line per file. The folder is created inside the dump.

```text
dump: /mnt/data/public/ttrpg/BattleMaps/battlemaps

# ===== Maps with several variants (2) =====

The Old Fishing Hole [30x40] (DnDavid).jpg -> The Old Fishing Hole
The Old Fishing Hole HD [30x40] (DnDavid).jpg -> The Old Fishing Hole

# ===== Single-variant maps (402) =====

# ? name extends "City Under Attack" — same map or a separate one?
City Under Attack 2 (DnDavid).jpg -> City Under Attack 2
```

- Lines that start with `#` and blank lines are ignored.
- `dump:` names the dump folder. `apply --dump <dir>` overrides it.
- To merge two maps, give their files the same folder. To split, give different folders.
- To leave a file where it is, delete its line.
- `# ?` lines mark groups to check: a name that extends another map's name, mixed **map sizes** in one group, a folder that already exists, or a name made only of variant tokens.

A single-variant map still gets its own folder.

## How file names are grouped

This section describes the default mode. With `--one-per-file`, only the extension is removed, and no `# ? name extends` notes are written.

Files whose normalised names are equal go into one folder. Names that are only prefixes of each other ("City Under Attack" and "City Under Attack 2") are **not** merged; the plan flags them for review.

Normalisation, in order:

1. Strip media extensions and `-Kopie` suffixes, also when stacked: `1stFloor.webp-Kopie.webp` becomes `1stFloor`.
2. Remove `[WxH]` map sizes anywhere in the name.
3. Remove trailing `(…)` groups, such as `(DnDavid)` or `(DnDavid)(DnDavid)`. A leading group such as `(Not) A Trap` stays.
4. Remove a bare trailing author (`… [40x40] DnDavid.jpg`), but only an author that the same dump also names in parentheses.
5. Split into words at spaces, `_`, `-`, `.` and CamelCase boundaries (`BaseDayGL` becomes `Base Day GL`).
6. Drop the variant words `Grid Gridless Gridded NoGrid GL HD Day Night DUN VTT Overlay Kopie` (case-insensitive, whole words only).
7. Compare the remaining words case-insensitively, without punctuation except parentheses, so `Dungeon, 4x1 (2)_001` and `Dungeon, 4x1_2_001` stay apart.

The folder name is the remaining text with its original casing and separators, for example `The Old Fishing Hole` or `1stFloor`. The `[WxH]` and `(Author)` parts stay in the file names, so the catalog can still read them.

If nothing is left after step 6 (a file named `Night.jpg`), the raw name is used and the plan flags it.

## What `apply` guarantees

- It checks **every** line before it moves anything. If any line has a problem, it lists all problems and moves nothing. Problems are a missing file, a file listed twice, a folder name with `/` or `..`, a folder name taken by a file, or a target file that already exists.
- It never overwrites a file.
- It uses `rename`, so files stay on the same filesystem and are not copied.
- A re-run after success reports "Nothing to do". Files already in their target folder are skipped.
- If a rename fails partway (for example a permissions error), it stops and lists what it moved. A re-run continues from there.

## Tests

```sh
cd tools/sort-dump && bun test
```

`fixtures/` holds real `ls -p` listings of the DnDavid `battlemaps/` dump and of `Pack 09/AchlysManor`. The tests recreate them as empty files in a temp folder.
