import type { SearchMap } from "../../src/catalog/model.ts";

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function filterSearchMaps(maps: readonly SearchMap[], query: string): readonly SearchMap[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean);

  if (terms.length === 0) return [];

  return maps.filter((map) => {
    const searchable = normalized([map.name, ...map.categoryPath, map.author ?? "", ...(map.tags ?? [])].join("/"));

    return terms.every((term) => searchable.includes(term));
  });
}
