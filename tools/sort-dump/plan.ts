import { readdirSync } from "node:fs";
import { authorsIn, isVariantFile, normalise, stripExtensions } from "./normalise.ts";

export const ARROW = " -> ";

/**
 * `normalised` groups Grid/HD/Day/Night variants of one map (DnDavid-style dumps).
 * `one-per-file` is for packs, where names that differ only by spacing, commas or "(N)" are different maps.
 */
export type GroupingMode = "normalised" | "one-per-file";

export interface PlanEntry {
  file: string;
  folder: string;
}

export interface MapGroup {
  key: string;
  folder: string;
  files: string[];
  /** Reasons a human should look at this group before applying. */
  notes: string[];
}

export interface DumpListing {
  variants: string[];
  /** Files left alone: not a variant, or a name the plan format cannot hold. */
  ignored: string[];
  dirs: string[];
}

export function scanDump(dumpDir: string): DumpListing {
  const listing: DumpListing = { variants: [], ignored: [], dirs: [] };

  for (const entry of readdirSync(dumpDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) listing.dirs.push(entry.name);
    else if (entry.isFile() && isVariantFile(entry.name) && fitsPlanFormat(entry.name)) {
      listing.variants.push(entry.name);
    } else if (entry.isFile()) listing.ignored.push(entry.name);
  }

  for (const list of Object.values(listing)) list.sort(compareNames);

  return listing;
}

function fitsPlanFormat(name: string): boolean {
  return !name.includes(ARROW.trim()) && !/[\n\r]/.test(name) && !/^(#|dump:)/.test(name);
}

export function groupFiles(files: string[], existingDirs: string[] = [], mode: GroupingMode = "normalised"): MapGroup[] {
  const authors = new Set(files.flatMap(authorsIn));
  const byKey = new Map<string, MapGroup & { sizes: Set<string>; fellBack: boolean }>();

  for (const file of [...files].sort(compareNames)) {
    const n = mode === "normalised" ? normalise(file, authors) : byStem(file);
    let group = byKey.get(n.key);

    if (!group) {
      group = { key: n.key, folder: n.folder, files: [], notes: [], sizes: new Set(), fellBack: false };
      byKey.set(n.key, group);
    }

    group.files.push(file);

    if (n.mapSize) group.sizes.add(n.mapSize);
    group.fellBack ||= n.fellBack;
  }

  const groups = [...byKey.values()];
  const dirs = new Set(existingDirs.map((d) => d.toLowerCase()));

  for (const group of groups) {
    // Grouping uses exact keys, so "City Under Attack" and "City Under Attack 2"
    // stay apart; flag such near-misses so a human decides.
    const shorter = mode === "normalised" ? groups.filter((g) => g !== group && group.key.startsWith(g.key + " ")) : [];

    for (const other of shorter) group.notes.push(`name extends "${other.folder}" — same map or a separate one?`);

    if (group.sizes.size > 1) group.notes.push(`mixed map sizes: ${[...group.sizes].sort().join(", ")}`);

    if (group.fellBack) group.notes.push("nothing left after stripping variant tokens; kept the raw name");

    if (dirs.has(group.folder.toLowerCase())) group.notes.push("folder already exists in the dump; files will be added to it");
  }

  return groups.map(({ key, folder, files, notes }) => ({ key, folder, files, notes })).sort((a, b) => compareNames(a.folder, b.folder));
}

function byStem(file: string): ReturnType<typeof normalise> {
  // parsePlan trims the folder, so the planned name must already be trimmed.
  const stem = stripExtensions(file).trim();

  return { key: stem, folder: stem, fellBack: false };
}

export function renderPlan(dumpDir: string, groups: MapGroup[], ignored: string[] = []): string {
  const multi = groups.filter((g) => g.files.length > 1);
  const single = groups.filter((g) => g.files.length === 1);
  const suspicious = groups.filter((g) => g.notes.length > 0);
  const fileCount = groups.reduce((n, g) => n + g.files.length, 0);

  const lines = [
    "# sort-dump plan",
    `# ${fileCount} files -> ${groups.length} map folders: ${multi.length} with several variants, ${single.length} single-variant, ${suspicious.length} flagged with "# ?".`,
    "#",
    '# Each line is "file -> map folder". Edit freely before `sort-dump apply`:',
    "#   change the folder after the arrow, retype it to merge or split maps,",
    "#   or delete the line to leave that file where it is.",
    "# Lines starting with # and blank lines are ignored.",
    "# apply checks every line first and moves nothing if any line is invalid or would overwrite a file.",
    "",
    `dump: ${dumpDir}`,
  ];

  const section = (title: string, list: MapGroup[]) => {
    if (list.length === 0) return;
    lines.push("", `# ===== ${title} (${list.length}) =====`);

    for (const group of list) {
      lines.push("");

      for (const note of group.notes) lines.push(`# ? ${note}`);

      for (const file of group.files) lines.push(`${file}${ARROW}${group.folder}`);
    }
  };

  section("Maps with several variants", multi);
  section("Single-variant maps", single);

  if (ignored.length > 0) {
    lines.push("", `# ===== Ignored files, not moved (${ignored.length}) =====`);

    for (const file of ignored) lines.push(`#   ${file}`);
  }

  return lines.join("\n") + "\n";
}

export interface ParsedPlan {
  dump?: string;
  entries: PlanEntry[];
  errors: string[];
}

export function parsePlan(text: string): ParsedPlan {
  const plan: ParsedPlan = { entries: [], errors: [] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) return;
    const dumpMatch = line.match(/^dump:\s*(.+)$/);

    if (dumpMatch) {
      if (plan.dump !== undefined) plan.errors.push(`line ${i + 1}: second "dump:" line`);
      plan.dump = dumpMatch[1]!.trim();

      return;
    }

    const at = line.lastIndexOf(ARROW);

    if (at < 0) {
      plan.errors.push(`line ${i + 1}: expected "file -> folder", got: ${line}`);

      return;
    }

    plan.entries.push({ file: line.slice(0, at).trim(), folder: line.slice(at + ARROW.length).trim() });
  });

  return plan;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
}
