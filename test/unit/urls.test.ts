import { describe, expect, test } from "bun:test";
import { downloadUrl, folderUrl, indexUrl, originalUrl, pathFromLocation } from "../../ui/app/urls.ts";

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
  });
});
