#!/usr/bin/env python3
"""Build data/landcover/: a coarse offline copy of ESA WorldCover 2021 for the forge.

The forge reads WorldCover live (10 m) when it can. This bundle is the offline fallback, and is also used
for very large frames. It is built from the official Cloud Optimized GeoTIFFs on AWS (no account needed),
reading only their small built-in overview images, so it downloads a fraction of the full 117 GB.

Needs: pip install rasterio numpy pillow
Run from the repo root:
    python3 tools/build_landcover_data.py                       # whole world, ~1 km pixels
    python3 tools/build_landcover_data.py --res 0.02            # ~2 km pixels, a quarter of the size
    python3 tools/build_landcover_data.py --bbox=-125,24,-66,50  # only an area (west,south,east,north)
Re-running skips 10° tiles that are already built (delete data/landcover to start over).

Output: one 8-bit greyscale PNG per 10°×10° tile (row 0 = north edge), named <tx>_<ty>.png like
data/ne and data/climate, plus index.json. Pixel value = WorldCover class / 10 (1 trees, 2 shrubs,
3 grass, 4 crops, 5 built-up, 6 bare, 7 snow & ice, 8 water, 9 herbaceous wetland, 10 moss & lichen),
11 = mangroves, 0 = no data.

Attribution: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
processed by ESA WorldCover consortium (CC BY 4.0).
"""
import argparse, json, math, os, sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
except ImportError:
    sys.exit('This script needs rasterio:  pip install rasterio numpy pillow')

AWS = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map'
HERE = os.path.dirname(os.path.abspath(__file__))


def item_name(lat0, lon0):
    return (f'ESA_WorldCover_10m_2021_v200_{"S" if lat0 < 0 else "N"}{abs(lat0):02d}'
            f'{"W" if lon0 < 0 else "E"}{abs(lon0):03d}_Map.tif')


def encode(a):
    """WorldCover codes → one byte: code/10, mangroves (95) → 11."""
    out = (a // 10).astype(np.uint8)
    out[a == 95] = 11
    out[(a == 0) | (a == 255)] = 0
    return out


def build_tile(tx, ty, res, source, out_dir):
    name = f'{tx}_{ty}'
    path = os.path.join(out_dir, name + '.png')
    if os.path.exists(path):
        return name, 'kept'
    n = int(round(10 / res))
    tile = np.zeros((n, n), np.uint8)
    found = 0
    for lat0 in range(ty * 10 - (ty * 10) % 3, ty * 10 + 10, 3):          # 3° WorldCover tiles touching this 10° tile
        for lon0 in range(tx * 10 - (tx * 10) % 3, tx * 10 + 10, 3):
            w, e = max(lon0, tx * 10), min(lon0 + 3, tx * 10 + 10)
            s, nn = max(lat0, ty * 10), min(lat0 + 3, ty * 10 + 10)
            if w >= e or s >= nn:
                continue
            url = f'{source}/{item_name(lat0, lon0)}'
            c0, c1 = round((w - tx * 10) / res), round((e - tx * 10) / res)
            r0, r1 = round((ty * 10 + 10 - nn) / res), round((ty * 10 + 10 - s) / res)
            if c1 <= c0 or r1 <= r0:
                continue
            try:
                with rasterio.open(url if not url.startswith('http') else '/vsicurl/' + url) as src:
                    win = from_bounds(w, s, e, nn, src.transform)
                    a = src.read(1, window=win, out_shape=(r1 - r0, c1 - c0), resampling=Resampling.mode)
            except Exception:
                continue                                                  # open ocean: no WorldCover tile
            tile[r0:r1, c0:c1] = encode(a)
            found += 1
    if not found or not tile.any():
        return name, 'empty'
    Image.fromarray(tile, 'L').save(path, optimize=True)
    return name, 'built'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--res', type=float, default=0.01, help='pixel size in degrees (default 0.01 ≈ 1 km)')
    ap.add_argument('--bbox', help='west,south,east,north in degrees (default: whole world)')
    ap.add_argument('--source', default=AWS, help='folder or URL holding the WorldCover *_Map.tif files')
    ap.add_argument('--threads', type=int, default=8)
    a = ap.parse_args()
    out_dir = os.path.join(HERE, '..', 'data', 'landcover')
    os.makedirs(out_dir, exist_ok=True)
    w, s, e, n = (map(float, a.bbox.split(',')) if a.bbox else (-180, -60, 180, 84))
    # only 10° tiles that have land (the climate bundle already knows which those are)
    try:
        land = set(json.load(open(os.path.join(HERE, '..', 'data', 'climate', 'index.json'))))
    except OSError:
        land = None
    jobs = [(tx, ty) for ty in range(math.floor(s / 10), math.ceil(n / 10)) for tx in range(math.floor(w / 10), math.ceil(e / 10))
            if land is None or f'{tx}_{ty}' in land]
    os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')   # don't list the S3 bucket on every open
    os.environ.setdefault('CPL_VSIL_CURL_ALLOWED_EXTENSIONS', '.tif')
    print(f'{len(jobs)} tiles to check, {a.res}° pixels…')
    done = 0
    with ThreadPoolExecutor(a.threads) as pool:
        for name, what in pool.map(lambda j: build_tile(j[0], j[1], a.res, a.source.rstrip('/'), out_dir), jobs):
            done += 1
            print(f'  [{done}/{len(jobs)}] {name}: {what}', flush=True)
    index = sorted(f[:-4] for f in os.listdir(out_dir) if f.endswith('.png'))
    json.dump(index, open(os.path.join(out_dir, 'index.json'), 'w'))
    size = sum(os.path.getsize(os.path.join(out_dir, f + '.png')) for f in index)
    print(f'Done: {len(index)} tiles, {size / 1e6:.1f} MB in data/landcover/. Commit that folder to use it offline.')


if __name__ == '__main__':
    main()
