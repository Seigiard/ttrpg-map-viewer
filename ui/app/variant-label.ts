/**
 * A variant's short name next to its siblings: the file name without the extension, the map size and author tags, and
 * the map's own name, which every sibling repeats. A file that is nothing but those parts keeps its full stem.
 */
export function variantLabel(file: string, mapName: string): string {
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;

  const bare = stem
    .replace(/\s*\[\d+\s*x\s*\d+\]/gi, "")
    .replace(/\s*\([^)]*\)/g, "")
    .trim();

  const lowerBare = bare.toLocaleLowerCase();
  const lowerName = mapName.toLocaleLowerCase();
  const rest = lowerBare.startsWith(lowerName) ? bare.slice(mapName.length).replace(/^[\s_\-.,]+/, "") : bare;

  return rest === "" ? stem : rest;
}
