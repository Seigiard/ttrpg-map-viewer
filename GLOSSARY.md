# TTRPG Map Viewer

A browsable catalog over a homelab collection of TTRPG battle maps: see what a map looks like, then open, download, slice for print, or convert it.

## Language

### Source side

**Collection**:
The read-only folder tree of map images on the homelab that the catalog describes. Nothing in it is changed by the catalog.
_Avoid_: library, storage, source

**Map**:
One battle map, represented by a folder whose images are all versions of that same map.
_Avoid_: card, entry, item

**Variant**:
One image of a map, differing from its siblings by lighting, weather, grid, layer, or size (e.g. Original, Night, Gridless).
_Avoid_: version, file, image

**Animated variant**:
A variant stored as a video loop rather than a still image.
_Avoid_: animation, video map

**Category**:
A folder that groups maps and other categories rather than being a map itself.
_Avoid_: collection, group, pack

**Dump**:
A folder holding many unrelated maps side by side, waiting to be sorted into one folder per map.
_Avoid_: mess, flat folder

**Author**:
The creator a map comes from, such as Czepeku or DnDavid.
_Avoid_: publisher, source, vendor

### Scale

**Grid cell**:
One square of the map's tactical grid, normally five feet in play and one inch in print.
_Avoid_: square, tile, hex

**Map size**:
The map's extent counted in grid cells, written as width × height (e.g. 30x40).
_Avoid_: dimensions, resolution

**Grid scale**:
How many image pixels make up one grid cell of a variant.
_Avoid_: DPI, PPI, resolution

### Catalog side

**Catalog**:
The generated, browsable mirror of the collection: its pages, data, and derived images.
_Avoid_: site, index, gallery

**Cover**:
The variant chosen to represent a map in the catalog.
_Avoid_: thumbnail, poster, main image

**Thumbnail**:
A small derived image of a variant, used in grids of maps.
_Avoid_: preview, icon

**Preview**:
A screen-sized derived image of a variant, shown when a map is opened.
_Avoid_: thumbnail, original

**Original**:
The variant's file as it exists in the collection, untouched.
_Avoid_: source, full image, raw

**Print image**:
A derived image of a variant, reduced only as far as needed so a browser can slice it.
_Avoid_: printable, export

**Regeneration**:
Bringing the part of the catalog that mirrors a changed part of the collection up to date.
_Avoid_: rebuild, sync, reindex

### Actions

**Slicing**:
Splitting a map into printable paper sheets at true grid-cell scale.
_Avoid_: cutting, tiling, splitting

**Monochrome version**:
An AI-made black-and-white rendition of a variant, suited to cheap printing.
_Avoid_: ЧБ, grayscale, B/W
