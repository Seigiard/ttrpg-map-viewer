import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapZipResponse } from "../../src/map-zip.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "map-zip-test-"));
  directories.push(directory);

  return directory;
}

async function run(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });

  const [status, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (status !== 0) throw new Error(`${command.join(" ")} failed: ${error}`);

  return output;
}

async function runBytes(command: string[]): Promise<number[]> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });

  const [status, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);

  if (status !== 0) throw new Error(`${command.join(" ")} failed: ${error}`);

  return Array.from(new Uint8Array(output));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mapZipResponse", () => {
  test("streams the known Map variants with their Original names and bytes", async () => {
    // #given
    const root = await temporaryDirectory();
    const filesPath = join(root, "collection");
    const dataPath = join(root, "catalog");
    const originalPath = join(filesPath, "Campaign", "Dragon's Lair");
    await mkdir(join(dataPath, "Campaign", "Dragon's Lair"), { recursive: true });
    await mkdir(originalPath, { recursive: true });
    await writeFile(join(originalPath, "Day #1.png"), Uint8Array.from([0, 1, 2, 3]));
    await writeFile(join(originalPath, "Night.webp"), Uint8Array.from([255, 100, 0]));
    await writeFile(
      join(dataPath, "Campaign", "Dragon's Lair", "index.json"),
      JSON.stringify({
        kind: "map",
        name: "Dragon's Lair",
        originalPath: "Campaign/Dragon's Lair",
        variants: [{ file: "Day #1.png" }, { file: "Night.webp" }],
      }),
    );

    // #when
    const response = await mapZipResponse(new Request("http://catalog/api/map-zip?path=Campaign%2FDragon's%20Lair"), {
      filesPath,
      dataPath,
    });

    const archive = join(root, "map.zip");
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));

    // #then
    expect({
      status: response.status,
      type: response.headers.get("Content-Type"),
      disposition: response.headers.get("Content-Disposition"),
      length: response.headers.get("Content-Length"),
      entries: await run(["unzip", "-Z1", archive]),
      day: await runBytes(["unzip", "-p", archive, "Day #1.png"]),
      night: await runBytes(["unzip", "-p", archive, "Night.webp"]),
    }).toEqual({
      status: 200,
      type: "application/zip",
      disposition: "attachment; filename=\"Dragon's Lair.zip\"; filename*=UTF-8''Dragon%27s%20Lair.zip",
      length: "253",
      entries: "Day #1.png\nNight.webp\n",
      day: [0, 1, 2, 3],
      night: [255, 100, 0],
    });
  });

  test("rejects a traversal path before it reads the Catalog", async () => {
    // #given
    const root = await temporaryDirectory();

    // #when
    const response = await mapZipResponse(new Request("http://catalog/api/map-zip?path=..%2Fsecret"), {
      filesPath: join(root, "collection"),
      dataPath: join(root, "catalog"),
    });

    // #then
    expect(response.status).toBe(400);
  });

  test("rejects an Original symlink that escapes the Collection", async () => {
    // #given
    const root = await temporaryDirectory();
    const filesPath = join(root, "collection");
    const dataPath = join(root, "catalog");
    await mkdir(join(filesPath, "Map"), { recursive: true });
    await mkdir(join(dataPath, "Map"), { recursive: true });
    await writeFile(join(root, "secret.png"), "secret");
    await symlink(join(root, "secret.png"), join(filesPath, "Map", "Day.png"));
    await writeFile(
      join(dataPath, "Map", "index.json"),
      JSON.stringify({ kind: "map", name: "Map", originalPath: "Map", variants: [{ file: "Day.png" }] }),
    );

    // #when
    const response = await mapZipResponse(new Request("http://catalog/api/map-zip?path=Map"), { filesPath, dataPath });

    // #then
    expect(response.status).toBe(404);
  });
});
