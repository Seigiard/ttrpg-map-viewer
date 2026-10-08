#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPlan } from "./apply.ts";
import { type GroupingMode, groupFiles, parsePlan, renderPlan, scanDump } from "./plan.ts";

const USAGE = `Usage:
  sort-dump plan <dumpDir> [--out <planFile>] [--force] [--one-per-file]
                                                          dry run: write the plan, move nothing
  sort-dump apply <planFile> [--dump <dumpDir>]           move files exactly as the plan says

Shorthands: "sort-dump <dumpDir>" = plan, "sort-dump --apply <planFile>" = apply.
--one-per-file gives every file its own map folder, named after the file; use it for packs.
Default plan file: ./sort-dump.plan (never written into the dump).`;

export function main(argv: string[]): number {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let force = false;
  let mode: GroupingMode = "normalised";
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--force") force = true;
    else if (arg === "--one-per-file") mode = "one-per-file";
    else if (arg === "--apply") command = "apply";
    else if (arg === "--out" || arg === "--dump") options.set(arg, argv[++i] ?? "");
    else if (arg.startsWith("--")) return usage();
    else positional.push(arg);
  }

  if (command === undefined && (positional[0] === "plan" || positional[0] === "apply")) command = positional.shift();
  command ??= "plan";

  if (positional.length !== 1) return usage();

  if (command === "plan") {
    return runPlan(resolve(positional[0]!), resolve(options.get("--out") || "sort-dump.plan"), force, mode);
  }

  const dump = options.get("--dump");

  return runApply(resolve(positional[0]!), dump ? resolve(dump) : undefined);
}

function usage(): number {
  console.error(USAGE);

  return 2;
}

function runPlan(dumpDir: string, planFile: string, force: boolean, mode: GroupingMode): number {
  if (existsSync(planFile) && !force) {
    console.error(`${planFile} already exists; it may hold your edits. Pass --force to overwrite or --out to pick another file.`);

    return 1;
  }

  const listing = scanDump(dumpDir);
  const groups = groupFiles(listing.variants, listing.dirs, mode);
  writeFileSync(planFile, renderPlan(dumpDir, groups, listing.ignored));

  const multi = groups.filter((g) => g.files.length > 1);
  const suspicious = groups.filter((g) => g.notes.length > 0);
  console.log(`Scanned ${dumpDir}`);
  console.log(`  variant files:          ${listing.variants.length}`);
  console.log(`  map folders planned:    ${groups.length}`);
  console.log(`    with several variants: ${multi.length} (${multi.reduce((n, g) => n + g.files.length, 0)} files)`);
  console.log(`    single-variant:        ${groups.length - multi.length}`);
  console.log(`  suspicious (# ? notes): ${suspicious.length}`);
  console.log(`  ignored files:          ${listing.ignored.length}`);
  console.log(`  subfolders left alone:  ${listing.dirs.length}`);
  console.log(`Plan written to ${planFile}. Review it, then run: sort-dump apply ${planFile}`);

  return 0;
}

function runApply(planFile: string, dumpOverride: string | undefined): number {
  const plan = parsePlan(readFileSync(planFile, "utf8"));
  const dumpDir = dumpOverride ?? plan.dump;

  if (plan.errors.length > 0 || dumpDir === undefined) {
    for (const error of plan.errors) console.error(`plan error: ${error}`);

    if (dumpDir === undefined) console.error('plan error: no "dump: <dir>" line and no --dump given');
    console.error("Nothing moved.");

    return 1;
  }

  const report = applyPlan(dumpDir, plan.entries);

  if (report.problems.length > 0) {
    for (const problem of report.problems) console.error(`problem: ${problem}`);
    console.error(`${report.problems.length} problem(s) found. Nothing moved. Fix the plan and run apply again.`);

    return 1;
  }

  for (const entry of report.moved) console.log(`moved  ${entry.file} -> ${entry.folder}/`);

  if (report.failure !== undefined) {
    console.error(`Stopped after ${report.moved.length} move(s): ${report.failure}`);
    console.error("Moves already done are kept; re-running apply skips them.");

    return 1;
  }

  if (report.moved.length === 0) {
    console.log(`Nothing to do: all ${report.alreadyDone.length} file(s) are already in place.`);
  } else {
    console.log(`Moved ${report.moved.length} file(s); ${report.alreadyDone.length} already in place.`);
  }

  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
