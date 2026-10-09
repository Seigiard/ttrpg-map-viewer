import type { MapIndex, MapSize, Variant } from "../../src/catalog/model.ts";

const MM_PER_INCH = 25.4;

// A4 minus 10 mm margins on every side: what an ordinary home printer can reach.
const SHEET_SHORT_INCHES = (210 - 20) / MM_PER_INCH;

const SHEET_LONG_INCHES = (297 - 20) / MM_PER_INCH;

export interface PrintSheets {
  readonly columns: number;
  readonly rows: number;
  readonly sheets: number;
  readonly orientation: "portrait" | "landscape";
  /** Printable sheet width in grid cells; one cell prints as one inch. */
  readonly sheetWidth: number;
  /** Printable sheet height in grid cells. */
  readonly sheetHeight: number;
}

/** A4 sheets needed to print a map at one inch per grid cell, in whichever orientation needs fewer. */
export function printSheets(cells: MapSize): PrintSheets {
  const portrait = {
    columns: Math.ceil(cells.width / SHEET_SHORT_INCHES),
    rows: Math.ceil(cells.height / SHEET_LONG_INCHES),
  };

  const landscape = {
    columns: Math.ceil(cells.width / SHEET_LONG_INCHES),
    rows: Math.ceil(cells.height / SHEET_SHORT_INCHES),
  };

  if (portrait.columns * portrait.rows <= landscape.columns * landscape.rows) {
    return {
      ...portrait,
      sheets: portrait.columns * portrait.rows,
      orientation: "portrait",
      sheetWidth: SHEET_SHORT_INCHES,
      sheetHeight: SHEET_LONG_INCHES,
    };
  }

  return {
    ...landscape,
    sheets: landscape.columns * landscape.rows,
    orientation: "landscape",
    sheetWidth: SHEET_LONG_INCHES,
    sheetHeight: SHEET_SHORT_INCHES,
  };
}

/** The variant's extent in grid cells, from metadata or derived from its pixels and grid scale. */
export function variantCells(index: Pick<MapIndex, "mapSize">, variant: Variant): MapSize | undefined {
  if (variant.mapSize) return variant.mapSize;

  if (index.mapSize) return index.mapSize;

  if (variant.gridScale === undefined || variant.width === undefined || variant.height === undefined) return undefined;

  return {
    width: Math.round(variant.width / variant.gridScale),
    height: Math.round(variant.height / variant.gridScale),
  };
}
