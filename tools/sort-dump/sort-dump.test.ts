import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan } from "./apply.ts";
import { authorsIn, normalise, stripExtensions } from "./normalise.ts";
import { groupFiles, parsePlan, renderPlan, scanDump } from "./plan.ts";
import { main } from "./sort-dump.ts";

const DNDAVID = readListing("dndavid-battlemaps.txt");
const ACHLYS = readListing("achlys-manor.txt");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalise", () => {
  test.each([
    ["Lake Grid [25x40] (DnDavid).jpg", "Lake", "25x40"],
    ["Lake HD [25x40] (DnDavid).jpg", "Lake", "25x40"],
    ["The Old Fishing Hole HD [30x40] (DnDavid).jpg", "The Old Fishing Hole", "30x40"],
    ["Cliffside House HD [18x17] (DnDavid).jpg", "Cliffside House", "18x17"],
    ["Green Hag Lair[40x40] (DnDavid)(DnDavid).jpg", "Green Hag Lair", "40x40"],
    ["Demon Wing Below Deck[60x80] (DnDavid).jpg", "Demon Wing Below Deck", "60x80"],
    ["500ft Bridge(DnDavid).jpg", "500ft Bridge", undefined],
    ["Abandoned Cliff Outpost  (DnDavid).jpg", "Abandoned Cliff Outpost", undefined],
    ["(Not) A Trap (DnDavid).jpg", "(Not) A Trap", undefined],
    ["Hermit_s Hut [40x30] (DnDavid).jpg", "Hermit_s Hut", "40x30"],
    ["Leomunds Hut Single (DnDavid).png", "Leomunds Hut Single", undefined],
    ["naiad.png", "naiad", undefined],
    ["Way Side Inn 2 Night Raining (DnDavid).jpg", "Way Side Inn 2 Raining", undefined],
    ["1stFloor.webp-Kopie.webp", "1stFloor", undefined],
    ["1stFloorNightOverlay-Kopie.webp", "1stFloor", undefined],
    ["1stFloorOverlayDay-Kopie.webp", "1stFloor", undefined],
    ["1stFloorVTT.dd2vtt", "1stFloor", undefined],
    ["BaseDayGL.webp-Kopie.webp", "Base", undefined],
    ["TopandBasementVTT.dd2vtt", "TopandBasement", undefined],
    ["DUN_Crypt_Gridless.webp", "Crypt", undefined],
    ["Old GridMap.png", "Old Map", undefined],
  ])("%p -> folder %p", (file, folder, mapSize) => {
    const n = normalise(file);
    expect(n.folder).toBe(folder as string);
    expect(n.mapSize).toBe(mapSize as string | undefined);
  });

  test("Grid and HD variants of one DnDavid map share a key", () => {
    expect(normalise("Lake Grid [25x40] (DnDavid).jpg").key).toBe(normalise("Lake HD [25x40] (DnDavid).jpg").key);
  });

  test("key ignores case, separators and CamelCase gluing", () => {
    const keys = ["Way Side Inn Basement Statue", "WaySide Inn Basement Statue", "way_side-inn  basement statue"].map(
      (s) => normalise(`${s}.jpg`).key,
    );
    expect(new Set(keys).size).toBe(1);
  });

  test("bare author is stripped only when the dump names it in parentheses elsewhere", () => {
    const file = "Respite from the Red Storm [40x40] DnDavid.jpg";
    expect(normalise(file).folder).toBe("Respite from the Red Storm DnDavid");
    expect(normalise(file, ["DnDavid"]).folder).toBe("Respite from the Red Storm");
  });

  test("a name made only of variant tokens falls back to the raw stem", () => {
    const n = normalise("Night.jpg");
    expect(n.folder).toBe("Night");
    expect(n.fellBack).toBe(true);
  });

  test("stacked extensions and -Kopie suffixes are stripped", () => {
    expect(stripExtensions("1stFloorNight.webp-Kopie.webp")).toBe("1stFloorNight");
    expect(stripExtensions("Map.png")).toBe("Map");
  });

  test("running numbers in parentheses are not taken as authors", () => {
    expect(authorsIn("City Under Attack (2).jpg")).toEqual([]);
    expect(authorsIn("City Under Attack (DnDavid).jpg")).toEqual(["DnDavid"]);
  });
});

describe("groupFiles on the real DnDavid battlemaps listing", () => {
  const files = DNDAVID.filter((n) => !n.endsWith("/"));
  const groups = groupFiles(files);
  const folderOf = (file: string) => groups.find((g) => g.files.includes(file))?.folder;

  test("every file gets exactly one folder", () => {
    expect(groups.reduce((n, g) => n + g.files.length, 0)).toBe(files.length);
  });

  test("HD and plain variants of The Old Fishing Hole land together", () => {
    expect(folderOf("The Old Fishing Hole HD [30x40] (DnDavid).jpg")).toBe("The Old Fishing Hole");
    expect(folderOf("The Old Fishing Hole [30x40] (DnDavid).jpg")).toBe("The Old Fishing Hole");
  });

  test("a file with and without map size lands together", () => {
    expect(folderOf("Ruins Of The Hallowed Warden [40x40] (DnDavid).jpg")).toBe("Ruins Of The Hallowed Warden");
    expect(folderOf("Ruins Of The Hallowed Warden (DnDavid).jpg")).toBe("Ruins Of The Hallowed Warden");
  });

  test("names that are prefixes of each other stay apart and get flagged", () => {
    expect(folderOf("City Under Attack (DnDavid).jpg")).toBe("City Under Attack");
    expect(folderOf("City Under Attack 2 (DnDavid).jpg")).toBe("City Under Attack 2");
    expect(folderOf("Ship (DnDavid).jpg")).toBe("Ship");
    expect(folderOf("Shipwreck (DnDavid).jpg")).toBe("Shipwreck");
    const extended = groups.find((g) => g.folder === "City Under Attack 2");
    expect(extended?.notes.join()).toContain('extends "City Under Attack"');
  });

  test("single files still get their own folder", () => {
    expect(folderOf("naiad.png")).toBe("naiad");
    expect(folderOf("Respite from the Red Storm [40x40] DnDavid.jpg")).toBe("Respite from the Red Storm");
  });
});

describe("groupFiles on the real AchlysManor listing", () => {
  test("layers group by base name across CamelCase and stacked extensions", () => {
    const groups = groupFiles(ACHLYS);
    expect(Object.fromEntries(groups.map((g) => [g.folder, g.files.length]))).toEqual({
      "1stFloor": 5,
      Base: 5,
      TopandBasement: 2,
      Trees: 2,
    });
  });
});

describe("groupFiles notes", () => {
  test("flags mixed map sizes and existing folders", () => {
    const [group] = groupFiles(["Lake [20x20].jpg", "Lake HD [40x40].jpg"], ["lake"]);
    expect(group!.notes).toContain("mixed map sizes: 20x20, 40x40");
    expect(group!.notes.some((n) => n.includes("already exists"))).toBe(true);
  });
});

describe("plan file", () => {
  test("render then parse gives back every file -> folder pair", () => {
    const groups = groupFiles(ACHLYS);
    const parsed = parsePlan(renderPlan("/dump", groups, ["notes.txt"]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.dump).toBe("/dump");
    expect(parsed.entries).toHaveLength(ACHLYS.length);
    expect(parsed.entries).toContainEqual({ file: "BaseDayGL.webp-Kopie.webp", folder: "Base" });
  });

  test("comments, blank lines and stray spaces are tolerated; malformed lines are errors", () => {
    const parsed = parsePlan("# hi\n\ndump: /d\n  a.jpg ->  A  \nnot a mapping\n");
    expect(parsed.entries).toEqual([{ file: "a.jpg", folder: "A" }]);
    expect(parsed.errors).toEqual(["line 5: expected \"file -> folder\", got: not a mapping"]);
  });
});

describe("applyPlan", () => {
  test("moves files into map folders and a re-run has nothing to do", () => {
    const dump = makeDump(ACHLYS);
    const entries = parsePlan(renderPlan(dump, groupFiles(scanDump(dump).variants))).entries;

    const first = applyPlan(dump, entries);
    expect(first.problems).toEqual([]);
    expect(first.moved).toHaveLength(14);
    expect(readdirSync(dump).sort()).toEqual(["1stFloor", "Base", "TopandBasement", "Trees"]);
    expect(readdirSync(join(dump, "Trees")).sort()).toEqual(["TreesDay.webp-Kopie.webp", "TreesNight.webp-Kopie.webp"]);

    const second = applyPlan(dump, entries);
    expect(second.problems).toEqual([]);
    expect(second.moved).toEqual([]);
    expect(second.alreadyDone).toHaveLength(14);
  });

  test("an edited plan is honoured: renamed folder, merged map, deleted line", () => {
    const dump = makeDump(["A HD.jpg", "A.jpg", "B.jpg", "Keep.jpg"]);
    const plan = parsePlan(`dump: ${dump}\nA HD.jpg -> Alpha\nA.jpg -> Alpha\nB.jpg -> Alpha\n`);
    const report = applyPlan(plan.dump!, plan.entries);
    expect(report.problems).toEqual([]);
    expect(readdirSync(join(dump, "Alpha")).sort()).toEqual(["A HD.jpg", "A.jpg", "B.jpg"]);
    expect(existsSync(join(dump, "Keep.jpg"))).toBe(true);
  });

  test("refuses to overwrite and moves nothing when any target already exists", () => {
    const dump = makeDump(["A.jpg", "B.jpg", "Map/B.jpg"]);
    writeFileSync(join(dump, "Map/B.jpg"), "original");
    const report = applyPlan(dump, [
      { file: "A.jpg", folder: "Map" },
      { file: "B.jpg", folder: "Map" },
    ]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("refusing to overwrite");
    expect(report.moved).toEqual([]);
    expect(existsSync(join(dump, "A.jpg"))).toBe(true);
    expect(readFileSync(join(dump, "Map/B.jpg"), "utf8")).toBe("original");
  });

  test("reports missing files, duplicates and unsafe folder names before moving anything", () => {
    const dump = makeDump(["A.jpg", "B.jpg", "C.jpg"]);
    const report = applyPlan(dump, [
      { file: "A.jpg", folder: "Ok" },
      { file: "Gone.jpg", folder: "X" },
      { file: "B.jpg", folder: "../outside" },
      { file: "C.jpg", folder: ".." },
      { file: "A.jpg", folder: "Other" },
    ]);
    expect(report.problems).toHaveLength(4);
    expect(report.moved).toEqual([]);
    expect(readdirSync(dump).sort()).toEqual(["A.jpg", "B.jpg", "C.jpg"]);
  });

  test("a folder name taken by a file is a conflict", () => {
    const dump = makeDump(["A.jpg", "Map"]);
    expect(applyPlan(dump, [{ file: "A.jpg", folder: "Map" }]).problems[0]).toContain("is not a folder");
  });
});

describe("CLI", () => {
  test("plan writes only the plan file and refuses to overwrite it without --force", () => {
    const dump = makeDump(ACHLYS);
    const out = join(makeDump([]), "achlys.plan");
    const before = readdirSync(dump).sort();

    expect(quiet(() => main(["plan", dump, "--out", out]))).toBe(0);
    expect(readdirSync(dump).sort()).toEqual(before);
    expect(readFileSync(out, "utf8")).toContain("BaseVTT.dd2vtt -> Base");

    expect(quiet(() => main([dump, "--out", out]))).toBe(1);
    expect(quiet(() => main([dump, "--out", out, "--force"]))).toBe(0);
  });

  test("apply exits non-zero on conflict and zero when nothing is left to do", () => {
    const dump = makeDump(["A.jpg", "A HD.jpg"]);
    const out = join(makeDump([]), "p.plan");
    quiet(() => main(["plan", dump, "--out", out]));
    expect(quiet(() => main(["--apply", out]))).toBe(0);
    expect(quiet(() => main(["apply", out]))).toBe(0);

    writeFileSync(join(dump, "A.jpg"), "");
    expect(quiet(() => main(["apply", out]))).toBe(1);
  });
});

function readListing(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n").filter(Boolean);
}

/** Creates a temp dump of empty files; names ending in "/" become folders. */
function makeDump(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sort-dump-"));
  tempDirs.push(dir);
  for (const name of names) {
    if (name.endsWith("/")) {
      mkdirSync(join(dir, name), { recursive: true });
      continue;
    }
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), "");
  }
  return dir;
}

function quiet<T>(fn: () => T): T {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}
