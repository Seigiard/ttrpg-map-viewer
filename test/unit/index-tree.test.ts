import { describe, expect, test } from "bun:test";
import type { CategoryIndex, MapCard } from "../../src/catalog/model.ts";
import { ancestorPaths, visibleRows } from "../../ui/app/index-tree.ts";

function map(path: string): MapCard {
  return { name: path.split("/").at(-1)!, path, variantCount: 1, cover: { variant: "Day.jpg", thumbnail: null } };
}

function category(path: string, categories: readonly string[], maps: readonly string[]): CategoryIndex {
  return {
    kind: "category",
    name: path.split("/").at(-1)!,
    path,
    categories: categories.map((child) => ({ name: child.split("/").at(-1)!, path: child })),
    maps: maps.map(map),
  };
}

const loaded = new Map([
  ["", category("", ["Czepeku", "DnDavid"], ["Loose Map"])],
  ["Czepeku", category("Czepeku", ["Czepeku/Caves"], ["Czepeku/Tavern"])],
  ["Czepeku/Caves", category("Czepeku/Caves", [], ["Czepeku/Caves/Lava Cave"])],
]);

function labels(rows: ReturnType<typeof visibleRows>): string[] {
  return rows.map((row) => `${row.depth}:${row.card.path}`);
}

describe("visibleRows", () => {
  test("lists an open Category's rows right after it, one level deeper, Categories before Maps", () => {
    // #given
    const open = new Set(["Czepeku", "Czepeku/Caves"]);

    // #when
    const rows = visibleRows(loaded, open);

    // #then
    expect(labels(rows)).toEqual([
      "0:Czepeku",
      "1:Czepeku/Caves",
      "2:Czepeku/Caves/Lava Cave",
      "1:Czepeku/Tavern",
      "0:DnDavid",
      "0:Loose Map",
    ]);
  });

  test("hides the rows of a closed Category even when they are loaded", () => {
    // #given
    const open = new Set(["Czepeku/Caves"]);

    // #when
    const rows = visibleRows(loaded, open);

    // #then
    expect(labels(rows)).toEqual(["0:Czepeku", "0:DnDavid", "0:Loose Map"]);
  });

  test("shows nothing under an open Category that is not loaded yet", () => {
    // #given
    const open = new Set(["DnDavid"]);

    // #when
    const rows = visibleRows(loaded, open);

    // #then
    expect(labels(rows)).toEqual(["0:Czepeku", "0:DnDavid", "0:Loose Map"]);
  });

  test("is empty before the root is loaded", () => {
    // #given
    const nothing = new Map<string, CategoryIndex>();

    // #when
    const rows = visibleRows(nothing, new Set());

    // #then
    expect(rows).toEqual([]);
  });
});

describe("ancestorPaths", () => {
  test("lists every containing Category from the root down", () => {
    // #given
    const path = "DnDavid/Castle Ravenloft/Crypts";

    // #when
    const ancestors = ancestorPaths(path);

    // #then
    expect(ancestors).toEqual(["", "DnDavid", "DnDavid/Castle Ravenloft"]);
  });

  test("the root has no ancestors", () => {
    // #given
    const root = "";

    // #when
    const ancestors = ancestorPaths(root);

    // #then
    expect(ancestors).toEqual([]);
  });
});
