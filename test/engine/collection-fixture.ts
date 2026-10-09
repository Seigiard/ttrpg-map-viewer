import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export const PIT = "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit";

export const LAKESIDE = "czepuku/CZEPEKU Fantasy Maps/Serene Lakeside";

export interface Workspace {
  readonly root: string;
  readonly collection: string;
  readonly output: string;
  readonly overrides: string;
}

export async function image(path: string, width: number, height: number, format: "jpeg" | "png" | "webp"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .toFormat(format)
    .toFile(path);
}

async function video(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const process = spawn("ffmpeg", ["-f", "lavfi", "-i", "color=c=red:s=64x32:d=0.1", "-an", "-y", path]);

    process.once("error", reject);
    process.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

/** The same collection shape the generator's own tests use: Czepeku metadata, a lone map, a mixed folder and a ZIP. */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "engine-catalog-"));
  const collection = join(root, "collection");
  const pit = join(collection, PIT);

  await image(join(pit, "Original Night.jpg"), 64, 64, "jpeg");
  await image(join(pit, "Empty Day.jpg"), 300, 200, "png");
  await video(join(pit, "Rain.webm"));
  await image(join(collection, LAKESIDE, "BRIDGE DAY.webp"), 64, 32, "webp");
  await writeFile(
    join(collection, "czepuku", "czepeku_data.json"),
    JSON.stringify([
      {
        name: "Monster Fighting Pit",
        type: "map",
        cats: ["CZEPEKU Fantasy Maps", "Maps & Scenes"],
        maps: [
          { name: "EMPTY DAY", grid: "30x20@100" },
          { name: "ORIGINAL NIGHT", grid: "30x20@100" },
        ],
      },
      {
        name: "Serene Lakeside",
        type: "scene",
        cats: ["CZEPEKU Fantasy Maps", "Maps & Scenes"],
        maps: [{ name: "BRIDGE DAY", grid: "128x64@None" }],
      },
    ]),
  );
  await image(join(collection, "Pack 09", "Ancient Ruins", "Ruins_BaseDayGL.png"), 64, 64, "png");
  await image(join(collection, "Mixed", "Loose.png"), 48, 48, "png");
  await image(join(collection, "Mixed", "Inner", "Room.jpg"), 48, 48, "jpeg");
  await writeFile(join(collection, "Printable Maps.zip"), "not really a zip");
  await writeFile(join(collection, "Mixed", ".hidden-note.png"), "hidden file, never a variant");

  return { root, collection, output: join(root, "out"), overrides: join(root, "overrides.json") };
}
