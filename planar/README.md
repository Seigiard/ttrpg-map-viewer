# Vendored Planar

The Docker build clones [Mason363/Planar](https://github.com/Mason363/Planar) at the SHA in `UPSTREAM`, applies every patch in `patches/`, and copies its static Next export into the runtime image.

Planar is MIT licensed. Its license is reproduced in `LICENSE`.

## Update the upstream pin

1. Clone the upstream repository outside this repository and check out the new commit.
2. Apply the current patches with `git apply /path/to/ttrpg-map-viewer/planar/patches/*.patch`.
3. Resolve any conflicts, make the required changes, and regenerate the patch with `git diff --binary > /path/to/ttrpg-map-viewer/planar/patches/0001-static-export-and-src-query.patch`.
4. Replace the SHA on the second line of `UPSTREAM`.
5. Build the Docker image. The build fails if the patch no longer applies or if Planar cannot produce a static export.
