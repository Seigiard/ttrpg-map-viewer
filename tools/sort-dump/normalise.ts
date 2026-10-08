export const VARIANT_EXTENSIONS = ["webp", "jpg", "jpeg", "png", "webm", "mp4", "dd2vtt"] as const;

const EXTENSION_RE = /\.(webp|jpe?g|png|webm|mp4|dd2vtt)$/i;

const KOPIE_SUFFIX_RE = /[\s_-]*kopie$/i;

const MAP_SIZE_RE = /\[\s*(\d+)\s*[x×]\s*(\d+)\s*\]/i;

const MAP_SIZE_GLOBAL_RE = new RegExp(MAP_SIZE_RE.source, "gi");

const TRAILING_PARENS_RE = /(\s*\([^()]*\))+\s*$/;

const SEPARATOR_RE = /^[\s_.-]+$/;

const SPLIT_SEPARATORS_RE = /([\s_.-]+)/;

// Splits glued CamelCase such as "BaseDayGL" or "1stFloorNightOverlay" so the
// variant tokens inside them can be recognised as whole words.
const CAMEL_BOUNDARY_RE = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

const VARIANT_TOKENS = new Set(["grid", "gridless", "gridded", "nogrid", "gl", "hd", "day", "night", "dun", "vtt", "overlay", "kopie"]);

export interface Normalised {
  /** Case-insensitive grouping key: files with equal keys are variants of one map. */
  key: string;
  /** Human-readable map folder name, original casing kept. */
  folder: string;
  /** Map size from a `[WxH]` group, e.g. "25x40". */
  mapSize?: string;
  /** True when stripping left nothing and the raw stem was used instead. */
  fellBack: boolean;
}

interface Token {
  sep: string;
  word: string;
}

export function isVariantFile(fileName: string): boolean {
  return EXTENSION_RE.test(fileName);
}

/** Strips media extensions and `-Kopie` suffixes, including stacked ones like `.webp-Kopie.webp`. */
export function stripExtensions(fileName: string): string {
  let stem = fileName;
  let previous: string;

  do {
    previous = stem;
    stem = stem.replace(EXTENSION_RE, "").replace(KOPIE_SUFFIX_RE, "");
  } while (stem !== previous);

  return stem;
}

/** Authors named in trailing `(…)` groups, e.g. `(DnDavid)`. */
export function authorsIn(fileName: string): string[] {
  const stem = stripExtensions(fileName).replace(MAP_SIZE_GLOBAL_RE, " ");
  const trailing = stem.match(TRAILING_PARENS_RE);

  if (!trailing) return [];

  return [...trailing[0].matchAll(/\(([^()]*)\)/g)].flatMap((m) => {
    const name = m[1]!.trim();

    return isPlausibleAuthor(name) ? [name] : [];
  });
}

// A trailing "(2)" or "(Night)" is not an author; treating it as one would strip
// running numbers from Series names and merge maps that must stay apart.
function isPlausibleAuthor(name: string): boolean {
  return /[a-z]/i.test(name) && name.length >= 3 && !VARIANT_TOKENS.has(name.toLowerCase());
}

export function normalise(fileName: string, knownAuthors: Iterable<string> = []): Normalised {
  const rawStem = stripExtensions(fileName);
  const mapSizeMatch = rawStem.match(MAP_SIZE_RE);
  const mapSize = mapSizeMatch ? `${mapSizeMatch[1]}x${mapSizeMatch[2]}` : undefined;

  let stem = rawStem.replace(MAP_SIZE_GLOBAL_RE, " ").replace(TRAILING_PARENS_RE, "");

  // Some names carry the author bare, without parentheses: "… [40x40] DnDavid.jpg".
  for (const author of knownAuthors) {
    stem = stem.replace(new RegExp(`[\\s_-]+${escapeRegExp(author)}\\s*$`, "i"), "");
  }

  const tokens = tokenize(stem);
  const kept = tokens.filter((t) => !VARIANT_TOKENS.has(t.word.toLowerCase()));
  const key = toKey(kept);

  if (key === "") {
    const fallbackTokens = tokenize(rawStem);

    return {
      key: toKey(fallbackTokens) || rawStem.toLowerCase(),
      folder: tidy(rawStem) || rawStem,
      mapSize,
      fellBack: true,
    };
  }

  return { key, folder: joinTokens(tokens), mapSize, fellBack: false };
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sep = "";

  for (const part of text.split(SPLIT_SEPARATORS_RE)) {
    if (part === "") continue;

    if (SEPARATOR_RE.test(part)) {
      sep += part;
      continue;
    }

    part.split(CAMEL_BOUNDARY_RE).forEach((word, i) => {
      tokens.push({ sep: i === 0 ? sep : "", word });
    });
    sep = "";
  }

  return tokens;
}

function toKey(tokens: Token[]): string {
  return tokens
    .flatMap((t) => {
      const word = t.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

      return word === "" ? [] : [word];
    })
    .join(" ");
}

function joinTokens(tokens: Token[]): string {
  let out = "";
  let pendingSep = "";

  for (const token of tokens) {
    if (VARIANT_TOKENS.has(token.word.toLowerCase())) {
      pendingSep ||= token.sep;
      continue;
    }

    // A dropped glued token ("Old GridMap") must not glue its neighbours together.
    const sep = token.sep || pendingSep;
    out += (out === "" ? "" : sep) + token.word;
    pendingSep = "";
  }

  return tidy(out);
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^[\s_.-]+|[\s_.-]+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
