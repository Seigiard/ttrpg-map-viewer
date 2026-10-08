import { describe, expect, test } from "bun:test";
import { classifyCollection, type FileListing, type FolderListing, isVariantFile } from "../../src/catalog/classify.ts";

function file(name: string): FileListing {
  return { name, size: 1, mtimeMs: 1 };
}

function folder(path: string, files: string[], subfolders: FolderListing[] = []): FolderListing {
  return { name: path.split("/").pop() ?? "", path, files: files.map(file), subfolders };
}

describe("isVariantFile", () => {
  test("accepts still images in any letter case", () => {
    expect(["a.webp", "a.jpg", "a.JPEG", "Original Day.PNG"].map(isVariantFile)).toEqual([true, true, true, true]);
  });

  test("accepts animated variants and rejects archives, data files and hidden files", () => {
    expect(["pack.zip", "loop.webm", "loop.mp4", "map.dd2vtt", "notes.txt", ".hidden.jpg", "jpg"].map(isVariantFile)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("classifyCollection", () => {
  test("a folder with images is a map whose images are its variants", () => {
    // #given
    const root = folder("", [], [folder("Pit", ["Night.jpg", "Day.jpg", "pack.zip"])]);

    // #when
    const { root: catalog } = classifyCollection(root);

    // #then
    expect(catalog.categories).toEqual([]);
    expect(catalog.maps).toHaveLength(1);
    expect(catalog.maps[0]?.kind).toBe("map");
    expect(catalog.maps[0]?.variants.map((variant) => variant.name)).toEqual(["Day.jpg", "Night.jpg"]);
  });

  test("a folder with only subfolders is a category", () => {
    // #given
    const root = folder("", [], [folder("Czepeku", [], [folder("Czepeku/Pit", ["Day.jpg"])])]);

    // #when
    const { root: catalog } = classifyCollection(root);

    // #then
    expect(catalog.maps).toEqual([]);
    expect(catalog.categories.map((category) => [category.kind, category.path])).toEqual([["category", "Czepeku"]]);
    expect(catalog.categories[0]?.maps.map((map) => map.path)).toEqual(["Czepeku/Pit"]);
  });

  test("the cover is the first variant by name, with numbers ordered numerically", () => {
    // #given
    const root = folder("", [], [folder("Slime", ["Level 10.jpg", "level 2.jpg", "Level 1.png"])]);

    // #when
    const map = classifyCollection(root).root.maps[0];

    // #then
    expect(map?.variants.map((variant) => variant.name)).toEqual(["Level 1.png", "level 2.jpg", "Level 10.jpg"]);
    expect(map?.cover.name).toBe("Level 1.png");
  });

  test("folders without any variant in their subtree are left out", () => {
    // #given
    const root = folder("", ["pack.zip"], [folder("Empty", [], [folder("Empty/Zips", ["a.zip"])]), folder("Pit", ["Day.jpg"])]);

    // #when
    const { root: catalog } = classifyCollection(root);

    // #then
    expect(catalog.categories).toEqual([]);
    expect(catalog.maps.map((map) => map.path)).toEqual(["Pit"]);
  });

  test("an empty collection still yields a root category", () => {
    expect(classifyCollection(folder("", ["pack.zip"])).root).toEqual({ kind: "category", name: "", path: "", categories: [], maps: [] });
  });

  test("a mixed folder is a category with a loose-image map and its classified children", () => {
    // #given
    const root = folder("", [], [folder("Pack", ["Cover.jpg"], [folder("Pack/Extra", ["a.jpg"])])]);

    // #when
    const result = classifyCollection(root);

    // #then
    expect(result.root.categories).toEqual([
      {
        kind: "category",
        name: "Pack",
        path: "Pack",
        categories: [],
        maps: [
          {
            kind: "map",
            name: "Pack",
            path: "Pack/._loose",
            sourcePath: "Pack",
            variants: [file("Cover.jpg")],
            cover: file("Cover.jpg"),
          },
          {
            kind: "map",
            name: "Extra",
            path: "Pack/Extra",
            sourcePath: "Pack/Extra",
            variants: [file("a.jpg")],
            cover: file("a.jpg"),
          },
        ],
      },
    ]);
  });

  test("children are sorted by name", () => {
    // #given
    const root = folder("", [], [folder("b", ["x.jpg"]), folder("A", ["x.jpg"]), folder("Map 10", ["x.jpg"]), folder("Map 9", ["x.jpg"])]);

    // #when
    const { root: catalog } = classifyCollection(root);

    // #then
    expect(catalog.maps.map((map) => map.name)).toEqual(["A", "b", "Map 9", "Map 10"]);
  });
});
