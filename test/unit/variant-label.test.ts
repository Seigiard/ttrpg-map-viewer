import { describe, expect, test } from "bun:test";
import { variantLabel } from "../../ui/app/variant-label.ts";

describe("variantLabel", () => {
  test("drops the map's name, the size tag and the extension that every sibling repeats", () => {
    // #given
    const file = "Achlys Manor 1stFloorNight [36x28].jpg";

    // #when
    const label = variantLabel(file, "Achlys Manor");

    // #then
    expect(label).toBe("1stFloorNight");
  });

  test("drops an author tag and a separator after the map's name", () => {
    // #given
    const file = "Coastal Hideout - Night [30x40] (DnDavid).jpg";

    // #when
    const label = variantLabel(file, "Coastal Hideout");

    // #then
    expect(label).toBe("Night");
  });

  test("keeps a file name that does not repeat the map's name", () => {
    // #given
    const file = "BaseNightGrid.webp";

    // #when
    const label = variantLabel(file, "Achlys Manor");

    // #then
    expect(label).toBe("BaseNightGrid");
  });

  test("keeps the full stem when nothing but the map's name and tags is left", () => {
    // #given
    const file = "Abandoned Airship Port [20x60] (DnDavid).jpg";

    // #when
    const label = variantLabel(file, "Abandoned Airship Port");

    // #then
    expect(label).toBe("Abandoned Airship Port [20x60] (DnDavid)");
  });
});
