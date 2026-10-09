import type {
  CatalogPath,
  CategoryIndex,
  FolderIndex,
  MapIndex,
  MapSize,
  SearchIndex,
  SearchMap,
  Variant,
} from "../../src/catalog/model.ts";
import { ancestorPaths, visibleRows, type IndexRow } from "./index-tree.ts";
import { printSheets, variantCells } from "./print-sheets.ts";
import { filterSearchMaps } from "./search.ts";
import { variantLabel } from "./variant-label.ts";
import {
  breadcrumbTrail,
  catalogFileUrl,
  downloadUrl,
  folderUrl,
  indexUrl,
  mapZipUrl,
  originalUrl,
  pathFromLocation,
  ROOT_LABEL,
  searchIndexUrl,
  sliceUrl,
} from "./urls.ts";

type Child = Node | string;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: (Child | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child): child is Child => child !== undefined));

  return node;
}

function navLink(path: CatalogPath, ...children: Child[]): HTMLAnchorElement {
  const link = element("a", { href: folderUrl(path) }, ...children);
  link.dataset.nav = path;

  return link;
}

function kbd(key: string): HTMLElement {
  return element("kbd", {}, key);
}

function sizeLabel(size: MapSize): string {
  return `${size.width}×${size.height}`;
}

/** One line of the index list: a Category or Map of the tree, or a Map found by search. */
interface Row {
  readonly kind: "category" | "map";
  readonly path: CatalogPath;
  readonly name: string;
  readonly depth: number;
  readonly thumbnail: CatalogPath | null;
  readonly mapSize?: MapSize;
  readonly variantCount?: number;
  /** Category path shown after a search result's name. */
  readonly context?: string;
}

function treeRow(row: IndexRow): Row {
  if (row.kind === "category") return { kind: "category", path: row.card.path, name: row.card.name, depth: row.depth, thumbnail: null };

  return {
    kind: "map",
    path: row.card.path,
    name: row.card.name,
    depth: row.depth,
    thumbnail: row.card.cover.thumbnail,
    mapSize: row.card.mapSize,
    variantCount: row.card.variantCount,
  };
}

function searchRow(map: SearchMap): Row {
  return {
    kind: "map",
    path: map.path,
    name: map.name,
    depth: 0,
    thumbnail: map.thumbnail,
    variantCount: map.variantCount,
    context: map.categoryPath.join(" / "),
  };
}

// ---------- data ----------

const categories = new Map<CatalogPath, CategoryIndex>();

const maps = new Map<CatalogPath, MapIndex>();

let searchIndex: Promise<SearchIndex | null> | undefined;

async function loadIndex(path: CatalogPath): Promise<FolderIndex | null> {
  const response = await fetch(indexUrl(path), { cache: "no-cache" });

  if (!response.ok) return null;

  // SAFETY: index.json is written only by the generator against the FolderIndex contract in src/catalog/model.ts.
  const index = (await response.json()) as FolderIndex;

  if (index.kind === "category") categories.set(path, index);
  else maps.set(path, index);

  return index;
}

async function folder(path: CatalogPath): Promise<FolderIndex | null> {
  return categories.get(path) ?? maps.get(path) ?? (await loadIndex(path));
}

function loadSearchIndex(): Promise<SearchIndex | null> {
  searchIndex ??= fetch(searchIndexUrl(), { cache: "no-cache" }).then(async (response) => {
    if (!response.ok) {
      searchIndex = undefined;

      return null;
    }

    // SAFETY: search.json is written only by the generator against the SearchIndex contract in src/catalog/model.ts.
    return (await response.json()) as SearchIndex;
  });

  return searchIndex;
}

// ---------- view state ----------

const open = new Set<CatalogPath>();

let rows: readonly Row[] = [];

let cursor: CatalogPath | undefined;

/** File of the variant picked on the cursor's Map; undefined shows the Cover. */
let pickedVariant: string | undefined;

let query = "";

let showSheets = false;

/** Bumped on every stage render, so a slow fetch for a row the cursor already left draws nothing. */
let stageToken = 0;

const app = document.getElementById("app")!;

const crumbs = element("nav", { className: "crumbs" });

crumbs.setAttribute("aria-label", "Location");

const filter = element("input", { type: "search", placeholder: "Find a map by name, folder, author or tag", autocomplete: "off" });

filter.setAttribute("aria-label", "Find a map");

const tree = element("div", { className: "index", tabIndex: 0 });

tree.setAttribute("role", "tree");

tree.setAttribute("aria-label", "Maps and folders");

const viewport = element("div", { className: "viewport" });

const dock = element("section", { className: "dock" });

function legendItem(text: string, ...keys: string[]): HTMLElement {
  return element("span", {}, ...keys.map(kbd), ` ${text}`);
}

app.replaceChildren(
  element("header", { className: "pathbar" }, crumbs, element("label", { className: "filter" }, kbd("/"), filter)),
  tree,
  element("main", { className: "stage" }, viewport, dock),
  element(
    "footer",
    { className: "legend" },
    legendItem("move", "↑", "↓"),
    legendItem("open folder", "→"),
    legendItem("close folder", "←"),
    legendItem("pick variant", "1–9"),
    legendItem("show print sheets", "P"),
    legendItem("slice for print", "S"),
    legendItem("download", "D"),
    legendItem("open original", "O"),
    legendItem("find", "/"),
  ),
);

function showLoadError(): void {
  viewport.replaceChildren(
    element("p", { className: "notice" }, "The catalog could not be loaded. Check that the server is running, then reload."),
  );
  dock.replaceChildren();
}

function inBackground(work: Promise<void>): void {
  work.catch(showLoadError);
}

function syncUrl(): void {
  const url = new URL(folderUrl(cursor ?? ""), location.origin);

  if (query !== "") url.searchParams.set("q", query);

  if (pickedVariant !== undefined) url.searchParams.set("v", pickedVariant);
  history.replaceState(null, "", url);
}

// ---------- index list ----------

async function computeRows(): Promise<readonly Row[]> {
  if (query.trim() === "") return visibleRows(categories, open).map(treeRow);

  const index = await loadSearchIndex();

  return index === null ? [] : filterSearchMaps(index.maps, query).map(searchRow);
}

function rowId(index: number): string {
  return `row-${index}`;
}

function rowElement(row: Row, index: number): HTMLElement {
  const isOpen = row.kind === "category" && open.has(row.path);
  const thumb = element("span", { className: "thumb" });

  if (row.thumbnail !== null) {
    thumb.append(element("img", { src: catalogFileUrl(row.thumbnail), alt: "", loading: "lazy", decoding: "async" }));
  }

  const node = element(
    "div",
    { id: rowId(index), className: `row ${row.kind}${isOpen ? " open" : ""}` },
    thumb,
    element("span", { className: "name" }, row.name, row.context ? element("span", { className: "context" }, row.context) : undefined),
    element("span", { className: "size" }, row.mapSize ? sizeLabel(row.mapSize) : ""),
    element("span", { className: "count" }, row.variantCount === undefined ? "" : String(row.variantCount)),
  );

  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", String(row.depth + 1));
  node.setAttribute("aria-selected", "false");

  if (row.kind === "category") node.setAttribute("aria-expanded", String(isOpen));

  if (row.variantCount !== undefined) node.title = `${row.variantCount} variant${row.variantCount === 1 ? "" : "s"}`;
  node.style.setProperty("--depth", String(row.depth));
  node.addEventListener("click", () => {
    if (row.kind === "category" && cursor === row.path) inBackground(toggle(row.path));
    else moveCursor(row.path);
    tree.focus();
  });

  return node;
}

async function renderIndex(): Promise<void> {
  rows = await computeRows();

  if (rows.length === 0) {
    const message =
      query.trim() === ""
        ? "The catalog is being generated. Reload in a moment."
        : `No map name, folder, author or tag contains “${query.trim()}”.`;

    tree.replaceChildren(element("p", { className: "empty" }, message));
    cursor = undefined;
    renderStage();

    return;
  }

  tree.replaceChildren(...rows.map(rowElement));

  if (cursor === undefined || !rows.some((row) => row.path === cursor)) cursor = rows[0]!.path;
  markCursor();
}

function cursorIndex(): number {
  return rows.findIndex((row) => row.path === cursor);
}

function markCursor(): void {
  tree.querySelector(".cursor")?.classList.remove("cursor");
  tree.querySelector('[aria-selected="true"]')?.setAttribute("aria-selected", "false");

  const index = cursorIndex();
  const node = index < 0 ? null : document.getElementById(rowId(index));

  if (node) {
    node.classList.add("cursor");
    node.setAttribute("aria-selected", "true");
    tree.setAttribute("aria-activedescendant", node.id);
    node.scrollIntoView({ block: "nearest" });
  }

  syncUrl();
  renderStage();
}

function moveCursor(path: CatalogPath): void {
  if (path === cursor) return;

  cursor = path;
  pickedVariant = undefined;
  markCursor();
}

async function toggle(path: CatalogPath): Promise<void> {
  if (open.has(path)) open.delete(path);
  else {
    open.add(path);
    await folder(path);
  }

  await renderIndex();
}

/** Reveals a path in the tree, loading and opening every Category above it, and puts the cursor on it. */
async function reveal(path: CatalogPath): Promise<void> {
  // The root has no ancestors, yet its index holds the top rows of the tree.
  await folder("");

  for (const ancestor of ancestorPaths(path)) {
    if (ancestor !== "") open.add(ancestor);
    await folder(ancestor);
  }

  cursor = path === "" ? undefined : path;
  await renderIndex();
}

// ---------- stage ----------

function renderStage(): void {
  const token = ++stageToken;
  const row = rows.find((candidate) => candidate.path === cursor);

  crumbs.replaceChildren(
    ...breadcrumbTrail(cursor ?? "").map((crumb, index) => (index === 0 ? navLink("", ROOT_LABEL) : navLink(crumb.path, crumb.label))),
  );

  if (!row) {
    document.title = ROOT_LABEL;
    viewport.replaceChildren();
    dock.replaceChildren();

    return;
  }

  document.title = `${row.name} · ${ROOT_LABEL}`;

  const draw = folder(row.path).then((index) => {
    if (token !== stageToken) return;

    if (index === null) {
      viewport.replaceChildren(element("p", { className: "notice" }, "This folder is not in the catalog yet. Reload in a moment."));
      dock.replaceChildren();
    } else if (index.kind === "category") renderCategory(index);
    else renderMap(index);
  });

  inBackground(draw);
}

function renderCategory(index: CategoryIndex): void {
  const sheet =
    index.maps.length === 0
      ? element(
          "p",
          { className: "notice" },
          `No maps sit directly in this folder. Press → to open its ${index.categories.length} folders.`,
        )
      : element(
          "div",
          { className: "contact" },
          ...index.maps.map((map) => {
            const ratio = map.mapSize ? map.mapSize.width / map.mapSize.height : 1;

            const tile = navLink(
              map.path,
              map.cover.thumbnail === null
                ? element("span", { className: "missing" }, "No thumbnail")
                : element("img", { src: catalogFileUrl(map.cover.thumbnail), alt: "", loading: "lazy", decoding: "async" }),
              element("span", { className: "caption" }, map.name),
            );

            tile.style.flexBasis = `${Math.round(132 * ratio)}px`;

            return tile;
          }),
        );

  const counts = [
    index.maps.length > 0 ? `${index.maps.length} map${index.maps.length === 1 ? "" : "s"}` : undefined,
    index.categories.length > 0 ? `${index.categories.length} folder${index.categories.length === 1 ? "" : "s"}` : undefined,
  ].filter((label): label is string => label !== undefined);

  viewport.replaceChildren(sheet);
  dock.replaceChildren(
    element(
      "div",
      { className: "about" },
      element("h1", { className: "title" }, index.name === "" ? ROOT_LABEL : index.name),
      element("p", { className: "facts" }, counts.length === 0 ? "This folder is empty." : `${counts.join(" and ")} in this folder.`),
    ),
  );
}

function selectedVariant(index: MapIndex): Variant {
  return (
    index.variants.find((variant) => variant.file === pickedVariant) ??
    index.variants.find((variant) => variant.file === index.cover.variant) ??
    index.variants[0]!
  );
}

function previewMedia(index: MapIndex, variant: Variant): HTMLElement {
  if (variant.animated) {
    return element("video", {
      src: originalUrl(index.originalPath, variant.file),
      poster: variant.preview === null ? "" : catalogFileUrl(variant.preview),
      muted: true,
      loop: true,
      autoplay: true,
      controls: true,
    });
  }

  if (variant.preview === null) return element("p", { className: "notice" }, "This variant has no preview. Open the original instead.");

  return element("img", { src: catalogFileUrl(variant.preview), alt: `${index.name}, ${variantLabel(variant.file, index.name)}` });
}

/** Sizes the plate to the largest box of the image's proportions that fits the viewport. */
function fitPlate(): void {
  const plate = viewport.querySelector<HTMLElement>(".plate");
  const ratio = Number(plate?.dataset.ratio);

  if (!plate || !(ratio > 0)) return;

  const style = getComputedStyle(viewport);
  const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(width / ratio, height);

  plate.style.width = `${Math.floor(scale * ratio)}px`;
  plate.style.height = `${Math.floor(scale)}px`;
}

new ResizeObserver(fitPlate).observe(viewport);

function sheetOverlay(cells: MapSize): HTMLElement {
  const sheets = printSheets(cells);
  const overlay = element("div", { className: `sheets${showSheets ? " on" : ""}` });

  // Sheets are laid from the top-left corner; the last column and row may hang past the map's edge.
  overlay.style.gridTemplateColumns = `repeat(${sheets.columns}, ${(100 * sheets.sheetWidth) / cells.width}%)`;
  overlay.style.gridTemplateRows = `repeat(${sheets.rows}, ${(100 * sheets.sheetHeight) / cells.height}%)`;

  for (let sheet = 0; sheet < sheets.sheets; sheet++) overlay.append(element("i", {}));

  return overlay;
}

function fact(term: string, value: string): HTMLElement {
  return element("div", {}, element("dt", {}, term), element("dd", {}, value));
}

function action(label: string, href: string, key: string | undefined, primary: boolean): HTMLAnchorElement {
  const link = element("a", { href, className: primary ? "primary" : "" }, element("span", {}, label), key ? kbd(key) : undefined);

  if (key) link.dataset.key = key.toLowerCase();

  return link;
}

function renderMap(index: MapIndex): void {
  const variant = selectedVariant(index);
  const cells = variantCells(index, variant);
  const media = previewMedia(index, variant);
  const plate = element("div", { className: "plate" }, media);
  const ratio = variant.width && variant.height ? variant.width / variant.height : cells ? cells.width / cells.height : undefined;

  if (ratio === undefined) {
    media.addEventListener("load", () => {
      if (media instanceof HTMLImageElement && media.naturalHeight > 0) {
        plate.dataset.ratio = String(media.naturalWidth / media.naturalHeight);
        fitPlate();
      }
    });
  } else plate.dataset.ratio = String(ratio);

  if (cells) plate.append(sheetOverlay(cells));
  viewport.replaceChildren(plate);
  fitPlate();

  const sheets = cells ? printSheets(cells) : undefined;

  const facts = element(
    "dl",
    { className: "facts" },
    index.author ? fact("Author", index.author) : undefined,
    cells ? fact("Size", `${cells.width} × ${cells.height} cells`) : undefined,
    variant.gridScale === undefined ? undefined : fact("Grid", `${variant.gridScale} px per cell`),
    sheets ? fact("Print", `${sheets.sheets} A4 sheet${sheets.sheets === 1 ? "" : "s"} at 1 inch per cell`) : undefined,
    index.tags?.length ? fact("Tags", index.tags.join(", ")) : undefined,
  );

  const variants =
    index.variants.length < 2
      ? undefined
      : element(
          "div",
          { className: "variants" },
          ...index.variants.map((candidate, position) => {
            const button = element(
              "button",
              { type: "button", className: "variant" },
              candidate.thumbnail === null
                ? element("span", { className: "missing" }, "No thumbnail")
                : element("img", { src: catalogFileUrl(candidate.thumbnail), alt: "", loading: "lazy", decoding: "async" }),
              element(
                "span",
                { className: "label" },
                position < 9 ? kbd(String(position + 1)) : "",
                variantLabel(candidate.file, index.name),
              ),
            );

            button.setAttribute("aria-pressed", String(candidate.file === variant.file));
            button.addEventListener("click", () => pickVariant(candidate.file));

            return button;
          }),
        );

  variants?.setAttribute("role", "group");
  variants?.setAttribute("aria-label", "Variants");

  const original = originalUrl(index.originalPath, variant.file);

  dock.replaceChildren(
    element("div", { className: "about" }, element("h1", { className: "title" }, index.name), facts, variants),
    element(
      "div",
      { className: "actions" },
      variant.animated ? undefined : action("Slice for print", sliceUrl(index.path, original, variant), "S", true),
      action(`Download ${variantLabel(variant.file, index.name)}`, downloadUrl(index.originalPath, variant.file), "D", variant.animated),
      index.variants.length > 1
        ? action(`Download all ${index.variants.length} variants`, mapZipUrl(index.path), undefined, false)
        : undefined,
      action("Open original", original, "O", false),
    ),
  );

  dock.querySelector('.variant[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });

  for (const link of dock.querySelectorAll<HTMLAnchorElement>('.actions a[data-key="s"], .actions a[data-key="o"]')) {
    link.target = "_blank";
    link.rel = "noreferrer";
  }
}

function pickVariant(file: string): void {
  pickedVariant = file;
  syncUrl();
  renderStage();
}

// ---------- input ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;

filter.addEventListener("focus", () => inBackground(loadSearchIndex().then(() => undefined)));

filter.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = filter.value;
    cursor = undefined;
    inBackground(renderIndex());
  }, 120);
});

function clearSearch(): void {
  filter.value = "";

  if (query === "") return;

  query = "";
  inBackground(reveal(cursor ?? ""));
}

function stepCursor(by: number): void {
  if (rows.length === 0) return;

  const next = Math.min(Math.max(cursorIndex() + by, 0), rows.length - 1);
  moveCursor(rows[next]!.path);
}

function parentPath(path: CatalogPath): CatalogPath {
  return path.split("/").slice(0, -1).join("/");
}

function handleTreeKey(key: string): boolean {
  const row = rows[cursorIndex()];

  switch (key) {
    case "ArrowDown":
      stepCursor(1);

      return true;
    case "ArrowUp":
      stepCursor(-1);

      return true;
    case "PageDown":
      stepCursor(10);

      return true;
    case "PageUp":
      stepCursor(-10);

      return true;
    case "Home":
      stepCursor(-rows.length);

      return true;
    case "End":
      stepCursor(rows.length);

      return true;
    case "ArrowRight":
      if (row?.kind === "category" && !open.has(row.path)) inBackground(toggle(row.path));
      else if (row?.kind === "category") stepCursor(1);

      return true;
    case "ArrowLeft":
      if (row?.kind === "category" && open.has(row.path)) inBackground(toggle(row.path));
      else if (row && query === "" && rows.some((candidate) => candidate.path === parentPath(row.path))) moveCursor(parentPath(row.path));

      return true;
    case "Enter":
      if (row?.kind === "category") inBackground(toggle(row.path));
      // Enter on a search result shows the Map in its place in the tree.
      else if (row && query !== "") clearSearch();

      return true;
    default:
      return false;
  }
}

function handleStageKey(key: string): boolean {
  const index = cursor === undefined ? undefined : maps.get(cursor);

  if (/^[1-9]$/.test(key)) {
    const variant = index?.variants[Number(key) - 1];

    if (variant) pickVariant(variant.file);

    return true;
  }

  if (key === "p") {
    showSheets = !showSheets;
    viewport.querySelector(".sheets")?.classList.toggle("on", showSheets);

    return true;
  }

  const link = dock.querySelector<HTMLAnchorElement>(`.actions a[data-key="${key}"]`);

  if (!link) return false;

  link.click();

  return true;
}

/**
 * The shortcut a key press stands for, read from the physical key so that S, D, O, P and / still work under a
 * Cyrillic or other non-Latin layout, where event.key carries a different letter.
 */
function shortcut(event: KeyboardEvent): string {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);

  if (digit) return digit[1]!;

  const letter = /^Key([A-Z])$/.exec(event.code);

  if (letter) return letter[1]!.toLowerCase();

  return event.code === "Slash" ? "/" : event.key.toLowerCase();
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.target === filter) {
    if (event.key === "Escape") {
      clearSearch();
      tree.focus();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      tree.focus();
    }

    return;
  }

  const key = shortcut(event);

  if (key === "/") {
    event.preventDefault();
    filter.focus();

    return;
  }

  // Enter and the arrows keep their native meaning on a focused button or link outside the tree.
  const handled = (event.target === tree && handleTreeKey(event.key)) || handleStageKey(key);

  if (handled) event.preventDefault();
});

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-nav]") : null;

  if (!link) return;

  event.preventDefault();
  query = "";
  filter.value = "";
  inBackground(reveal(link.dataset.nav ?? "").then(() => tree.focus()));
});

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const path = pathFromLocation(location.pathname);

  query = params.get("q") ?? "";
  filter.value = query;
  pickedVariant = params.get("v") ?? undefined;

  // A deep link to a Category opens it, as the old folder page listed its contents.
  if (path !== "" && (await folder(path))?.kind === "category") open.add(path);

  await reveal(path);
  tree.focus();
}

window.addEventListener("popstate", () => inBackground(start()));

inBackground(start());
