import { describe, expect, test } from "bun:test";
import {
  breadcrumbTrail,
  downloadUrl,
  folderUrl,
  indexUrl,
  mapZipUrl,
  originalUrl,
  pathFromLocation,
  searchIndexUrl,
  sliceUrl,
} from "../../ui/app/urls.ts";

describe("SPA URLs mirror folder paths", () => {
  test("a folder URL round-trips through the browser pathname, including spaces, # and non-ASCII names", () => {
    const paths = ["", "czepuku", "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit", "Pack 09/Карты #1/50% off"];

    expect(paths.map((path) => pathFromLocation(new URL(folderUrl(path), "http://catalog").pathname))).toEqual(paths);
  });

  test("a deep link without the trailing slash resolves to the same folder", () => {
    expect(pathFromLocation("/czepuku/CZEPEKU%20Fantasy%20Maps")).toBe("czepuku/CZEPEKU Fantasy Maps");
  });

  test("data and originals are fetched from their own prefixes", () => {
    expect(indexUrl("")).toBe("/_catalog/index.json");
    expect(indexUrl("Pack 09/Ruins")).toBe("/_catalog/Pack%2009/Ruins/index.json");
    expect(originalUrl("Pack 09/Ruins", "Day #2.png")).toBe("/_original/Pack%2009/Ruins/Day%20%232.png");
    expect(downloadUrl("Pack 09/Ruins", "Day #2.png")).toBe("/_download/Pack%2009/Ruins/Day%20%232.png");
    expect(mapZipUrl("Pack 09/Ruins")).toBe("/api/map-zip?path=Pack%2009%2FRuins");
    expect(searchIndexUrl()).toBe("/_catalog/search.json");
  });

  test("a grid-scaled Variant opens its Original calibrated to one inch cells", () => {
    // #given
    const original = "/_original/Pack%2009/Ruins/Day%20%232.png";

    const variant = {
      file: "Day #2.png",
      size: 1,
      width: 10_000,
      height: 5_000,
      animated: false,
      thumbnail: null,
      preview: null,
      gridScale: 100,
    };

    // #when
    const result = sliceUrl("Pack 09/Ruins", original, variant);

    // #then
    expect(result).toBe("/_planar/?src=%2F_original%2FPack%252009%2FRuins%2FDay%2520%25232.png&ppc=100&cell=1in");
  });

  test("a huge Variant opens its cached Print image with a proportionally scaled grid", () => {
    // #given
    const original = "/_original/Pack%2009/Ruins/Day%20%232.png";

    const variant = {
      file: "Day #2.png",
      size: 1,
      width: 16_000,
      height: 22_000,
      animated: false,
      thumbnail: null,
      preview: null,
      gridScale: 100,
    };

    // #when
    const result = sliceUrl("Pack 09/Ruins", original, variant);

    // #then
    expect(result).toBe(
      "/_planar/?src=%2Fapi%2Fprint-image%3Fpath%3DPack%252009%252FRuins%26variant%3DDay%2520%25232.png&ppc=54.54545454545454&cell=1in",
    );
  });

  test("a mixed folder's loose map ends its breadcrumbs at the category and the map name, without the internal segment", () => {
    // #when
    const trail = breadcrumbTrail("battlemaps/._loose");

    // #then
    expect(trail).toEqual([
      { path: "", label: "Catalog" },
      { path: "battlemaps", label: "battlemaps" },
      { path: "battlemaps/._loose", label: "battlemaps" },
    ]);
  });

  test("ordinary paths get one breadcrumb per folder", () => {
    // #when
    const trail = breadcrumbTrail("Pack 09/Ruins");

    // #then
    expect(trail).toEqual([
      { path: "", label: "Catalog" },
      { path: "Pack 09", label: "Pack 09" },
      { path: "Pack 09/Ruins", label: "Ruins" },
    ]);
  });
});
