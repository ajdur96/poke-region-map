#!/usr/bin/env python3
"""Build data/climate/: Köppen-Geiger climate zones in 10° tiles, for offline use by the forge.

Source: the 100-arc-second (~3 km) Köppen-Geiger map by Rubel et al. (2017, 1986–2010 climate),
as shipped inside the kgcpy Python package (BSD). Download it with:
    pip download --no-deps kgcpy==1.1.8 -d /tmp/kgcpy && unzip -o /tmp/kgcpy/kgcpy-1.1.8-*.whl -d /tmp/kgcpy
then run:
    python3 tools/build_climate_data.py /tmp/kgcpy/kgcpy/kmz_int_reshape.png

Output: one 8-bit greyscale PNG per 10°×10° tile that has land (360×360 px, row 0 = north edge),
named <tx>_<ty>.png like data/ne (tx = floor(lon/10), ty = floor(lat/10)), plus index.json.
Pixel values: 1–31 = Af, Am, As, Aw, BSh, BSk, BWh, BWk, Cfa, Cfb, Cfc, Csa, Csb, Csc, Cwa, Cwb, Cwc,
Dfa, Dfb, Dfc, Dfd, Dsa, Dsb, Dsc, Dsd, Dwa, Dwb, Dwc, Dwd, EF, ET; 0 = ocean / no data.
"""
import json, os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
src = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kgcpy/kgcpy/kmz_int_reshape.png'
out = os.path.join(os.path.dirname(__file__), '..', 'data', 'climate')
os.makedirs(out, exist_ok=True)

a = np.array(Image.open(src))                     # 6480 × 12960, 36 px per degree, row 0 = 90°N
assert a.shape == (6480, 12960), a.shape
a[a == 32] = 0                                    # 32 = ocean
PX = 360                                          # pixels per 10° tile
index, total = [], 0
for ty in range(-9, 9):
    for tx in range(-18, 18):
        r0 = (8 - ty) * PX                        # tile ty spans lat ty*10 … ty*10+10
        c0 = (tx + 18) * PX
        tile = a[r0:r0 + PX, c0:c0 + PX]
        if not tile.any():
            continue
        name = f'{tx}_{ty}.png'
        Image.fromarray(tile.astype(np.uint8), 'L').save(os.path.join(out, name), optimize=True)
        total += os.path.getsize(os.path.join(out, name))
        index.append(f'{tx}_{ty}')
with open(os.path.join(out, 'index.json'), 'w') as f:
    json.dump(index, f)
print(f'{len(index)} tiles, {total/1e6:.1f} MB → {os.path.abspath(out)}')
