import type {
  CatalogPath,
  CategoryIndex,
  Cover,
  FolderIndex,
  MapIndex,
  MapMetadata,
  SearchIndex,
  SearchMap,
  Variant,
} from "../../src/catalog/model.ts";
import { filterSearchMaps } from "./search.ts";
import { catalogFileUrl, downloadUrl, folderUrl, indexUrl, originalUrl, pathFromLocation, searchIndexUrl } from "./urls.ts";

const ROOT_TITLE = "Catalog";

type Child = Node | string;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);

  return node;
}

function navLink(path: CatalogPath, ...children: Child[]): HTMLAnchorElement {
  const link = element("a", { href: folderUrl(path) }, ...children);
  link.dataset.nav = "";

  return link;
}

function displayName(name: string): string {
  return name === "" ? ROOT_TITLE : name;
}

function stripExtension(file: string): string {
  const dot = file.lastIndexOf(".");

  return dot > 0 ? file.slice(0, dot) : file;
}

function metadataBadges(metadata: Pick<MapMetadata, "author" | "mapSize">): HTMLElement | undefined {
  const labels = [metadata.mapSize ? `${metadata.mapSize.width}x${metadata.mapSize.height}` : undefined, metadata.author].filter(
    (label): label is string => label !== undefined,
  );

  return labels.length === 0
    ? undefined
    : element("span", { className: "badges" }, ...labels.map((label) => element("span", { className: "badge" }, label)));
}

function breadcrumbs(path: CatalogPath): HTMLElement {
  const nav = element("nav", { className: "breadcrumbs" }, navLink("", ROOT_TITLE));
  const segments = path === "" ? [] : path.split("/");

  segments.forEach((segment, index) => {
    nav.append(" / ", navLink(segments.slice(0, index + 1).join("/"), segment));
  });

  return nav;
}

function thumbnail(cover: Cover, alt: string): HTMLElement {
  if (cover.thumbnail === null) return element("div", { className: "thumb thumb-missing" }, "no thumbnail");

  return element("img", { className: "thumb", src: catalogFileUrl(cover.thumbnail), alt, loading: "lazy", decoding: "async" });
}

function searchThumbnail(map: SearchMap): HTMLElement {
  if (map.thumbnail === null) return element("div", { className: "search-thumb thumb-missing" }, "no thumbnail");

  return element("img", { className: "search-thumb", src: catalogFileUrl(map.thumbnail), alt: "", loading: "lazy", decoding: "async" });
}

function searchQuery(): string {
  return new URLSearchParams(location.search).get("q") ?? "";
}

function setSearchQuery(query: string): void {
  const url = new URL(location.href);

  if (query === "") url.searchParams.delete("q");
  else url.searchParams.set("q", query);
  history.replaceState(null, "", url);
}

async function loadSearchIndex(): Promise<SearchIndex | null> {
  const response = await fetch(searchIndexUrl(), { cache: "no-cache" });

  if (!response.ok) return null;

  // SAFETY: search.json is written only by the generator against the SearchIndex contract in src/catalog/model.ts.
  return (await response.json()) as SearchIndex;
}

function searchHeader(): HTMLElement {
  const input = element("input", {
    className: "search-input",
    type: "search",
    placeholder: "Search maps",
    value: searchQuery(),
  });

  input.setAttribute("aria-label", "Search maps");
  const results = element("ul", { className: "search-results" });
  let index: SearchIndex | null | undefined;
  let loading: Promise<SearchIndex | null> | undefined;

  const renderResults = (maps: readonly SearchMap[]) => {
    results.replaceChildren(
      ...maps.map((map) => {
        const badges = metadataBadges(map);

        return element(
          "li",
          {},
          navLink(
            map.path,
            searchThumbnail(map),
            element("span", { className: "name" }, map.name),
            element("span", { className: "search-context" }, map.categoryPath.join(" / ")),
            ...(badges ? [badges] : []),
            element("span", { className: "count" }, `${map.variantCount} variant${map.variantCount === 1 ? "" : "s"}`),
          ),
        );
      }),
    );
  };

  const load = async () => {
    loading ??= loadSearchIndex();
    index = await loading;
  };

  const search = async () => {
    const query = input.value;
    setSearchQuery(query);

    if (query.trim() === "") {
      results.replaceChildren();

      return;
    }

    await load();

    if (input.value !== query) return;
    renderResults(index === null ? [] : filterSearchMaps(index?.maps ?? [], query));
  };

  input.addEventListener("focus", () => void load());
  input.addEventListener("input", () => void search());

  if (input.value !== "") void search();

  return element("header", { className: "header" }, input, results);
}

function renderCategory(index: CategoryIndex): HTMLElement[] {
  const sections: HTMLElement[] = [];

  if (index.categories.length > 0) {
    sections.push(
      element(
        "ul",
        { className: "categories" },
        ...index.categories.map((category) => element("li", {}, navLink(category.path, category.name))),
      ),
    );
  }

  if (index.maps.length > 0) {
    sections.push(
      element(
        "ul",
        { className: "maps" },
        ...index.maps.map((map) => {
          const badges = metadataBadges(map);

          return element(
            "li",
            {},
            navLink(
              map.path,
              thumbnail(map.cover, map.name),
              element("span", { className: "name" }, map.name),
              ...(badges ? [badges] : []),
              element("span", { className: "count" }, `${map.variantCount} variant${map.variantCount === 1 ? "" : "s"}`),
            ),
          );
        }),
      ),
    );
  }

  return sections;
}

function variantUrl(path: CatalogPath, file: string): string {
  return `${folderUrl(path)}?v=${encodeURIComponent(file)}`;
}

function selectedVariant(index: MapIndex): Variant {
  const requested = new URLSearchParams(location.search).get("v");

  return (
    index.variants.find((variant) => variant.file === requested) ??
    index.variants.find((variant) => variant.file === index.cover.variant) ??
    index.variants[0]!
  );
}

function variantThumbnail(variant: Variant): HTMLElement {
  if (variant.thumbnail === null) return element("div", { className: "variant-thumb thumb-missing" }, "no thumbnail");

  return element("img", {
    className: "variant-thumb",
    src: catalogFileUrl(variant.thumbnail),
    alt: "",
    loading: "lazy",
    decoding: "async",
  });
}

function preview(index: MapIndex, variant: Variant): HTMLElement {
  if (variant.animated) {
    return element("video", {
      className: "preview",
      src: originalUrl(index.originalPath, variant.file),
      poster: variant.preview === null ? "" : catalogFileUrl(variant.preview),
      muted: true,
      loop: true,
      autoplay: true,
      controls: true,
    });
  }

  if (variant.preview === null) return element("p", { className: "notice" }, "Preview unavailable.");

  return element("img", { className: "preview", src: catalogFileUrl(variant.preview), alt: index.name });
}

function renderMap(index: MapIndex): HTMLElement[] {
  const selected = selectedVariant(index);
  const badges = metadataBadges(index);

  return [
    preview(index, selected),
    ...(badges ? [badges] : []),
    ...(index.tags?.length
      ? [element("p", { className: "tags" }, ...index.tags.map((tag) => element("span", { className: "tag" }, tag)))]
      : []),
    element(
      "p",
      { className: "actions" },
      element("a", { href: originalUrl(index.originalPath, selected.file), target: "_blank", rel: "noreferrer" }, "Open original"),
      " ",
      element("a", { href: downloadUrl(index.originalPath, selected.file) }, "Download"),
    ),
    element(
      "ul",
      { className: "variants" },
      ...index.variants.map((variant) => {
        const link = navLink("");
        link.href = variantUrl(index.path, variant.file);
        link.className = variant.file === selected.file ? "selected" : "";
        link.setAttribute("aria-current", variant.file === selected.file ? "true" : "false");
        link.append(variantThumbnail(variant), element("span", { className: "name" }, stripExtension(variant.file)));

        return element("li", {}, link);
      }),
    ),
  ];
}

type IndexLoad = { readonly found: true; readonly index: FolderIndex } | { readonly found: false; readonly status: number };

async function loadIndex(path: CatalogPath): Promise<IndexLoad> {
  const response = await fetch(indexUrl(path), { cache: "no-cache" });

  if (!response.ok) return { found: false, status: response.status };

  // SAFETY: index.json is written only by the generator against the FolderIndex contract in src/catalog/model.ts.
  return { found: true, index: (await response.json()) as FolderIndex };
}

async function render(): Promise<void> {
  const app = document.getElementById("app");

  if (!app) return;

  const path = pathFromLocation(location.pathname);
  const load = await loadIndex(path);

  if (!load.found) {
    const message =
      load.status === 404 && path === "" ? "The catalog is being generated. Reload in a moment." : `Not found (${load.status}).`;

    document.title = ROOT_TITLE;
    app.replaceChildren(searchHeader(), breadcrumbs(path), element("p", { className: "notice" }, message));

    return;
  }

  const { index } = load;
  document.title = path === "" ? ROOT_TITLE : `${index.name} · ${ROOT_TITLE}`;

  app.replaceChildren(
    searchHeader(),
    breadcrumbs(path),
    element("h1", {}, displayName(index.name)),
    ...(index.kind === "category" ? renderCategory(index) : renderMap(index)),
  );
}

function show(): Promise<void> {
  return render().catch(() => {
    document.getElementById("app")?.replaceChildren(element("p", { className: "notice" }, "Failed to load this folder."));
  });
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-nav]") : null;

  if (!link) return;

  event.preventDefault();
  history.pushState(null, "", link.href);
  void show().then(() => window.scrollTo(0, 0));
});

window.addEventListener("popstate", () => void show());

void show();
