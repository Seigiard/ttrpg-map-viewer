import { describe, expect, test } from "bun:test";
import type { SearchMap } from "../../src/catalog/model.ts";
import { filterSearchMaps } from "../../ui/app/search.ts";

const maps: readonly SearchMap[] = [
  {
    name: "Cavern Entrance",
    path: "Czepeku/Underground/Cavern Entrance",
    categoryPath: ["Czepeku", "Underground"],
    thumbnail: "Czepeku/Underground/Cavern Entrance/_thumbnails/Day.jpg.webp",
    variantCount: 2,
  },
  {
    name: "Village Square",
    path: "DnDavid/Medieval/Village Square",
    categoryPath: ["DnDavid", "Medieval"],
    thumbnail: null,
    variantCount: 1,
  },
];

describe("filterSearchMaps", () => {
  test("finds Maps by name or Category path with case-insensitive, diacritics-insensitive AND terms", () => {
    // #given
    const query = "czepéku cavern";

    // #when
    const results = filterSearchMaps(maps, query);

    // #then
    expect(results).toEqual([maps[0]!]);
  });
});
