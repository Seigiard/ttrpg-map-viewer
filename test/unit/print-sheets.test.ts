import { describe, expect, test } from "bun:test";
import type { Variant } from "../../src/catalog/model.ts";
import { printSheets, variantCells } from "../../ui/app/print-sheets.ts";

// Printable A4 at 10 mm margins is 190 x 277 mm, i.e. 7.48 x 10.91 inches, so 7 x 10 whole cells fit on one sheet.

const variant: Variant = { file: "Day.jpg", size: 1, animated: false, thumbnail: null, preview: null };

describe("printSheets", () => {
  test("a 36x28 map needs 15 portrait sheets (5 x 3) rather than 16 landscape ones (4 x 4)", () => {
    // #given
    const cells = { width: 36, height: 28 };

    // #when
    const sheets = printSheets(cells);

    // #then
    expect([sheets.columns, sheets.rows, sheets.sheets, sheets.orientation]).toEqual([5, 3, 15, "portrait"]);
  });

  test("a wide 10x7 map fits one landscape sheet instead of two portrait ones", () => {
    // #given
    const cells = { width: 10, height: 7 };

    // #when
    const sheets = printSheets(cells);

    // #then
    expect([sheets.columns, sheets.rows, sheets.sheets, sheets.orientation]).toEqual([1, 1, 1, "landscape"]);
  });

  test("a map one cell wider than a sheet's printable width spills onto a second column", () => {
    // #given
    const cells = { width: 8, height: 10 };

    // #when
    const sheets = printSheets(cells);

    // #then
    expect(sheets.sheets).toBe(2);
  });
});

describe("variantCells", () => {
  test("derives cells from pixels and grid scale when no map size is recorded", () => {
    // #given
    const scaled = { ...variant, width: 4200, height: 5600, gridScale: 140 };

    // #when
    const cells = variantCells({}, scaled);

    // #then
    expect(cells).toEqual({ width: 30, height: 40 });
  });

  test("prefers the variant's own map size over the map's", () => {
    // #given
    const sized = { ...variant, mapSize: { width: 20, height: 20 } };

    // #when
    const cells = variantCells({ mapSize: { width: 40, height: 40 } }, sized);

    // #then
    expect(cells).toEqual({ width: 20, height: 20 });
  });

  test("is unknown without a map size or a grid scale", () => {
    // #given
    const bare = { ...variant, width: 4200, height: 5600 };

    // #when
    const cells = variantCells({}, bare);

    // #then
    expect(cells).toBeUndefined();
  });
});
