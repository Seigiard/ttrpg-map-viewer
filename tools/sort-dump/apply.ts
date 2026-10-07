import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { PlanEntry } from "./plan.ts";

export interface Validation {
  todo: PlanEntry[];
  alreadyDone: PlanEntry[];
  problems: string[];
}

export interface ApplyReport extends Validation {
  moved: PlanEntry[];
  /** Set when a move failed after others had already succeeded. */
  failure?: string;
}

/** Checks every entry against the disk without changing anything. */
export function validatePlan(dumpDir: string, entries: PlanEntry[]): Validation {
  const result: Validation = { todo: [], alreadyDone: [], problems: [] };
  if (!isDir(dumpDir)) {
    result.problems.push(`dump folder not found: ${dumpDir}`);
    return result;
  }

  const seen = new Map<string, string>();
  for (const entry of entries) {
    const { file, folder } = entry;
    const where = `"${file}" -> "${folder}"`;

    const earlier = seen.get(file);
    if (earlier !== undefined) {
      result.problems.push(`${where}: file listed twice (also -> "${earlier}")`);
      continue;
    }
    seen.set(file, folder);

    if (file === "" || file.includes("/") || file === "." || file === "..") {
      result.problems.push(`${where}: file must be a plain name directly inside the dump`);
      continue;
    }
    if (folder === "" || folder.includes("/") || folder === "." || folder === ".." || folder.includes("\0")) {
      result.problems.push(`${where}: folder must be a single non-empty name inside the dump`);
      continue;
    }

    const folderPath = join(dumpDir, folder);
    const source = join(dumpDir, file);
    const target = join(folderPath, file);
    const sourceExists = exists(source);
    const targetExists = exists(target);

    if (exists(folderPath) && !isDir(folderPath)) {
      result.problems.push(`${where}: "${folder}" exists in the dump and is not a folder`);
    } else if (sourceExists && !lstatSync(source).isFile()) {
      result.problems.push(`${where}: source is not a regular file`);
    } else if (sourceExists && targetExists) {
      result.problems.push(`${where}: conflict, "${folder}/${file}" already exists; refusing to overwrite`);
    } else if (sourceExists) {
      result.todo.push(entry);
    } else if (targetExists) {
      result.alreadyDone.push(entry);
    } else {
      result.problems.push(`${where}: file not found in the dump or in the target folder`);
    }
  }
  return result;
}

/**
 * Validates the whole plan first and moves nothing if any entry has a problem,
 * so a bad edit never leaves the dump half-sorted.
 */
export function applyPlan(dumpDir: string, entries: PlanEntry[]): ApplyReport {
  const validation = validatePlan(dumpDir, entries);
  const report: ApplyReport = { ...validation, moved: [] };
  if (validation.problems.length > 0) return report;

  for (const entry of validation.todo) {
    const folderPath = join(dumpDir, entry.folder);
    const target = join(folderPath, entry.file);
    try {
      mkdirSync(folderPath, { recursive: true });
      // rename() overwrites silently on POSIX; re-check right before it in case
      // something appeared since validation.
      if (exists(target)) throw new Error(`"${entry.folder}/${entry.file}" appeared during apply; refusing to overwrite`);
      renameSync(join(dumpDir, entry.file), target);
      report.moved.push(entry);
    } catch (error) {
      report.failure = `"${entry.file}" -> "${entry.folder}": ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  return report;
}

function exists(path: string): boolean {
  return existsSync(path) || isSymlink(path);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
