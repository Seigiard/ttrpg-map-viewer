import { LOOSE_MAP_SEGMENT, PRINT_IMAGE_MAX_SIZE, type CatalogPath, type Variant } from "../../src/catalog/model.ts";

// These prefixes must match the locations in nginx.conf.template.
const CATALOG_PREFIX = "/_catalog";

const ORIGINAL_PREFIX = "/_original";

const DOWNLOAD_PREFIX = "/_download";

const PLANAR_PREFIX = "/_planar";

function encodePath(path: CatalogPath): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function folderUrl(path: CatalogPath): string {
  return path === "" ? "/" : `/${encodePath(path)}/`;
}

export function indexUrl(path: CatalogPath): string {
  return path === "" ? `${CATALOG_PREFIX}/index.json` : `${CATALOG_PREFIX}/${encodePath(path)}/index.json`;
}

export function catalogFileUrl(path: CatalogPath): string {
  return `${CATALOG_PREFIX}/${encodePath(path)}`;
}

export function searchIndexUrl(): string {
  return `${CATALOG_PREFIX}/search.json`;
}

export function originalUrl(mapPath: CatalogPath, file: string): string {
  return `${ORIGINAL_PREFIX}/${encodePath(mapPath)}/${encodeURIComponent(file)}`;
}

export function downloadUrl(mapPath: CatalogPath, file: string): string {
  return `${DOWNLOAD_PREFIX}/${encodePath(mapPath)}/${encodeURIComponent(file)}`;
}

export function mapZipUrl(path: CatalogPath): string {
  return `/api/map-zip?path=${encodeURIComponent(path)}`;
}

function printImageUrl(path: CatalogPath, file: string): string {
  return `/api/print-image?path=${encodeURIComponent(path)}&variant=${encodeURIComponent(file)}`;
}

/** Opens an Original or a cached Print image, retaining the physical Grid cell scale. */
export function sliceUrl(mapPath: CatalogPath, original: string, variant: Variant): string {
  const longSide = Math.max(variant.width ?? 0, variant.height ?? 0);
  const scale = longSide > PRINT_IMAGE_MAX_SIZE ? PRINT_IMAGE_MAX_SIZE / longSide : 1;
  const source = scale === 1 ? original : printImageUrl(mapPath, variant.file);
  const calibration = variant.gridScale === undefined ? "" : `&ppc=${encodeURIComponent(String(variant.gridScale * scale))}&cell=1in`;

  return `${PLANAR_PREFIX}/?src=${encodeURIComponent(source)}${calibration}`;
}

/** Inverse of folderUrl: the browser hands over a percent-encoded pathname. */
export function pathFromLocation(pathname: string): CatalogPath {
  return pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent)
    .join("/");
}

export interface Breadcrumb {
  readonly path: CatalogPath;
  readonly label: string;
}

export const ROOT_LABEL = "Catalog";

export function breadcrumbTrail(path: CatalogPath): readonly Breadcrumb[] {
  const segments = path === "" ? [] : path.split("/");

  return [
    { path: "", label: ROOT_LABEL },
    ...segments.map((segment, index) => ({
      path: segments.slice(0, index + 1).join("/"),
      // A loose map is named after the mixed folder it belongs to, so it shows that name instead of its internal segment.
      label: segment === LOOSE_MAP_SEGMENT ? (segments[index - 1] ?? ROOT_LABEL) : segment,
    })),
  ];
}
