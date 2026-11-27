"""Learn a real-tile model from Emerald's own routes, for the overworld preview (and later, export).

Every tile on the vanilla routes gets a class from its metatile behaviour, its collision and its colour:
  G grass/ground · P path/sand · H tall grass · T tree · C cliff/rock · W water · S stairs · s/e/w ledge (jump S/E/W)
Then, for each class, we count which real metatile Emerald uses given (a) which of the 8 neighbours share the class
and (b) the metatiles already placed to the west and north. The preview replays those counts row by row, falling back
to coarser keys when an exact context was never seen (and reports how often it had to).

Usage: python3 tools/build_tile_model.py /path/to/pokeemerald-expansion   (writes overworld/tileModel.js)
Only General (primary) + Petalburg (secondary) metatiles are placed for now; other tilesets only provide context.
"""
import json, re, struct, sys, base64, io, collections
from PIL import Image

PE = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/ext/pe'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'overworld/tileModel.js'
PRIMARY, SECONDARY = 'general', 'petalburg'
STAIR_IDS = {175, 207, 232}

def pals(d):
    out = []
    for k in range(16):
        try: lines = open(f'{d}/palettes/{k:02d}.pal').read().split('\n')[3:19]
        except FileNotFoundError: lines = []
        out.append([tuple(int(v) for v in ln.split()[:3]) for ln in lines if ln.strip()] or [(0, 0, 0)]*16)
    return out

def tiles(d):
    im = Image.open(f'{d}/tiles.png'); w, h = im.size; px = im.load(); T = []
    for ty in range(h//8):
        for tx in range(w//8):
            T.append([[px[tx*8 + x, ty*8 + y] for x in range(8)] for y in range(8)])
    return T

_cache = {}
def tileset_pair(prim, sec):
    key = (prim, sec)
    if key in _cache: return _cache[key]
    P, S = f'{PE}/data/tilesets/primary/{prim}', f'{PE}/data/tilesets/secondary/{sec}'
    pal = pals(P)[:6] + pals(S)[6:]
    T = tiles(P); T += [[[0]*8]*8]*(512 - len(T)); T += tiles(S)
    mbP, mbS = open(f'{P}/metatiles.bin', 'rb').read(), open(f'{S}/metatiles.bin', 'rb').read()
    atP, atS = open(f'{P}/metatile_attributes.bin', 'rb').read(), open(f'{S}/metatile_attributes.bin', 'rb').read()
    _cache[key] = (pal, T, mbP, mbS, atP, atS)
    return _cache[key]

def render(prim, sec, m):
    pal, T, mbP, mbS, _, _ = tileset_pair(prim, sec)
    mb, k = (mbP, m) if m < 512 else (mbS, m - 512)
    im = Image.new('RGB', (16, 16), (0, 0, 0))
    if k*16 + 16 > len(mb): return im
    e = struct.unpack('<8H', mb[k*16:k*16 + 16])
    for layer in range(2):
        for q in range(4):
            v = e[layer*4 + q]; ti, hf, vf, pi = v & 0x3ff, v >> 10 & 1, v >> 11 & 1, v >> 12
            if ti >= len(T): continue
            t = T[ti]
            for y in range(8):
                for x in range(8):
                    c = t[7 - y if vf else y][7 - x if hf else x]
                    if c == 0 and layer: continue
                    im.putpixel(((q % 2)*8 + x, (q//2)*8 + y), pal[pi][c] if c < len(pal[pi]) else (0, 0, 0))
    return im

def behaviour(prim, sec, m):
    _, _, _, _, atP, atS = tileset_pair(prim, sec)
    at, k = (atP, m) if m < 512 else (atS, m - 512)
    return struct.unpack('<H', at[k*2:k*2 + 2])[0] & 0xFF if k*2 + 2 <= len(at) else 0

src = open(f'{PE}/include/constants/metatile_behaviors.h').read()
MB = re.findall(r'^\s*(MB_[A-Z0-9_]+)', src[src.index('enum'):], re.M)
MBI = {n: i for i, n in enumerate(MB)}
WATER_MB = {i for n, i in MBI.items() if 'WATER' in n and 'SHALLOW' not in n and 'PUDDLE' not in n} | {MBI.get('MB_WATERFALL', -1)}
TALL = {MBI['MB_TALL_GRASS'], MBI['MB_LONG_GRASS']}
LEDGE = {MBI['MB_JUMP_SOUTH']:'s', MBI['MB_JUMP_EAST']:'e', MBI['MB_JUMP_WEST']:'w'}

_cls = {}
def classify(prim, sec, m, coll):
    key = (prim, sec, m, coll)
    if key in _cls: return _cls[key]
    b = behaviour(prim, sec, m)
    if (m & 0x3ff) in STAIR_IDS: c = 'S'
    elif b in LEDGE: c = LEDGE[b]
    elif b in WATER_MB: c = 'W'
    elif b in TALL: c = 'H'
    else:
        im = render(prim, sec, m); px = list(im.getdata()); n = len(px)
        r = sum(p[0] for p in px)/n; g = sum(p[1] for p in px)/n; bl = sum(p[2] for p in px)/n
        if coll: c = 'T' if g > r + 12 and g > bl else 'C'
        else: c = 'P' if (r > g - 8 and r - bl > 40) else 'G'
    _cls[key] = c
    return c

_fit = {}
def fits_class(prim, sec, m, c):
    """Only natural-looking pieces may stand in for a class: e.g. no roof, sign or pavement tile as 'cliff' or 'grass'."""
    key = (prim, sec, m, c)
    if key in _fit: return _fit[key]
    px = list(render(prim, sec, m).getdata()); n = len(px)
    r = sum(p[0] for p in px)/n; g = sum(p[1] for p in px)/n; b = sum(p[2] for p in px)/n
    blue = sum(1 for p in px if p[2] > p[0] + 30 and p[2] > p[1])/n          # share of water-blue pixels
    red = sum(1 for p in px if p[0] > 180 and p[1] < 110 and p[2] < 110)/n   # roofs, signs
    grey = sum(1 for p in px if abs(p[0] - p[1]) < 14 and abs(p[1] - p[2]) < 14 and p[0] > 120)/n   # pavement, metal
    ok = True
    if c == 'G': ok = g >= r and blue < 0.15 and red < 0.05 and grey < 0.25
    elif c == 'P': ok = blue < 0.15 and red < 0.05 and grey < 0.3
    elif c == 'C': ok = blue < 0.12 and red < 0.05 and grey < 0.35
    elif c == 'T': ok = blue < 0.1 and red < 0.05
    elif c == 'H': ok = blue < 0.1
    _fit[key] = ok
    return ok

layouts = [l for l in json.load(open(f'{PE}/data/layouts/layouts.json'))['layouts'] if 'width' in l]
routes = [l for l in layouts if re.fullmatch(r'Route1\d\d_Layout', l['name']) and l['primary_tileset'] == 'gTileset_General']
OURS = lambda m: m < 512 or 512 <= m < 512 + 144          # General + Petalburg (the atlas)
counts = [collections.defaultdict(collections.Counter) for _ in range(5)]
used = set()
for l in routes:
    W, H = l['width'], l['height']; b = struct.unpack(f'<{W*H}H', open(f"{PE}/{l['blockdata_filepath']}", 'rb').read())
    prim = l['primary_tileset'].replace('gTileset_', '').lower(); sec = l['secondary_tileset'].replace('gTileset_', '').lower()
    petal = sec == SECONDARY
    ids = [v & 0x3ff for v in b]
    cl = [classify(prim, sec, v & 0x3ff, (v >> 10) & 3 != 0) for v in b]
    for y in range(H):
        for x in range(W):
            i = y*W + x; m = ids[i]
            if not (m < 512 or (petal and OURS(m))): continue    # learn only General (+ Petalburg on Petalburg routes)
            c = cl[i]
            if not fits_class(prim, sec, m, c): continue          # keep man-made or off-colour pieces out of the pool
            mask = 0; bit = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0: continue
                    nx, ny = x + dx, y + dy
                    same = True if not (0 <= nx < W and 0 <= ny < H) else cl[ny*W + nx] == c
                    mask |= (1 if same else 0) << bit; bit += 1
            wid = ids[i - 1] if x > 0 else -1; nid = ids[i - W] if y > 0 else -1
            ok = lambda q: q >= 0 and (q < 512 or (petal and OURS(q)))
            if ok(wid) and ok(nid): counts[0][f'{c}{mask}|{wid}|{nid}'][m] += 1
            if ok(wid): counts[1][f'{c}{mask}|{wid}|'][m] += 1
            if ok(nid): counts[2][f'{c}{mask}||{nid}'][m] += 1
            counts[3][f'{c}{mask}'][m] += 1
            counts[4][c][m] += 1
            used.add(m)

model = []
for lv, tab in enumerate(counts):
    keep = {}
    for k, ctr in tab.items():
        tot = sum(ctr.values())
        if lv < 3 and tot < 2: continue
        keep[k] = [[m, n] for m, n in ctr.most_common(4)]
    model.append(keep)

# atlas: General 0–511, then Petalburg (512+), 16×16 each, 32 per row
ids = sorted(used | set(range(512)))
cols = 32; nAt = 512 + 144; rows = (nAt + cols - 1)//cols
atlas = Image.new('RGBA', (cols*16, rows*16), (0, 0, 0, 0))
for m in range(nAt):
    atlas.paste(render(PRIMARY, SECONDARY, m), ((m % cols)*16, (m//cols)*16))
buf = io.BytesIO(); atlas.save(buf, 'PNG', optimize=True)
data = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
js = ('// Generated by tools/build_tile_model.py from pokeemerald-expansion (General + Petalburg tilesets; graphics © Nintendo / Game Freak).\n'
      '// Real-tile model for the overworld preview: atlas + learned metatile choices. Do not edit by hand.\n'
      '(function (root){ root.OW_TILE_MODEL = ' + json.dumps({'cols':cols, 'atlas':data, 'levels':model}, separators=(',', ':')) + '; })(typeof self !== "undefined" ? self : this);\n')
open(OUT, 'w').write(js)
print('routes', len(routes), 'keys per level', [len(t) for t in model], 'atlas bytes', len(buf.getvalue()), 'js bytes', len(js))
print('class counts', collections.Counter(c for (p, s, m, co), c in _cls.items()))
