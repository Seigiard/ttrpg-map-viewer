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
    author: "Elara Voss",
    tags: ["Maps & Scenes"],
  },
  {
    name: "Village Square",
    path: "DnDavid/Medieval/Village Square",
    categoryPath: ["DnDavid", "Medieval"],
    thumbnail: null,
    variantCount: 1,
    classification: {
      tags: ["moonlit grotto"],
      summary: "A shrine overlooks an underground lake.",
    },
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

  test("finds Maps by Author and tags", () => {
    // #given
    const query = "elara scenes";

    // #when
    const results = filterSearchMaps(maps, query);

    // #then
    expect(results).toEqual([maps[0]!]);
  });

  test("finds a Map by a word that appears only in its classification", () => {
    // #given
    const query = "grotto";

    // #when
    const results = filterSearchMaps(maps, query);

    // #then
    expect(results).toEqual([maps[1]!]);
  });

  test("finds a Map by a word that appears only in its classification summary", () => {
    // #given
    const summaryOnlyMap: SearchMap = {
      name: "Fallen Observatory",
      path: "Czepeku/Arcane/Fallen Observatory",
      categoryPath: ["Czepeku", "Arcane"],
      thumbnail: null,
      variantCount: 1,
      classification: { tags: ["ruin"], summary: "A periscope overlooks a silent crater." },
    };

    // #when
    const results = filterSearchMaps([...maps, summaryOnlyMap], "periscope");

    // #then
    expect(results).toEqual([summaryOnlyMap]);
  });
});
