"""Step 1 of the composition plan: cut Gen 3 routes into semantic templates and report coverage.

Every tile of every vanilla Emerald route is classed (same classifier as tools/build_tile_model.py), cliffs also get a
facing from their neighbours. Then every 4x4 block on the 2x2 lattice (cell fillers) and every 8x8 / 12x8 / 8x12 /
12x12 block on the 4x4 lattice (chunks) is recorded with its class grid, edge sockets, base mass, overlays, biome and
where it came from. Identical class grids are merged and counted. Blocks with man-made or off-colour pieces are
rejected. Nothing here drives the live generator yet.

Usage: python3 tools/build_template_atlas.py /path/to/pokeemerald-expansion [outdir]
Writes: <outdir>/templateAtlas.json, <outdir>/template_report.md, <outdir>/contact_*.png
"""
import json, re, struct, sys, os, collections
from PIL import Image, ImageDraw

PE = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/ext/pe'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'tools/out'
os.makedirs(OUT, exist_ok=True)
sys.argv = [sys.argv[0], PE, '/dev/null']
_src = open(os.path.join(os.path.dirname(__file__), 'build_tile_model.py')).read()
_OUT = OUT
exec(_src.split('layouts = [l for l in json.load(')[0])   # classify(), fits_class(), render(), behaviour()
OUT = _OUT

BIOME = {'petalburg':'temperate', 'rustboro':'temperate', 'dewford':'coast', 'slateport':'coast', 'mauville':'desert/plains',
         'lavaridge':'volcanic', 'fallarbor':'ash', 'fortree':'jungle', 'lilycove':'coast', 'mossdeep':'tropical',
         'pacifidlog':'sea', 'sootopolis':'sea', 'ever_grande':'temperate', 'cave':'sea', 'underwater':'sea'}
FACE_OF = {}   # filled per tile below

layouts = [l for l in json.load(open(f'{PE}/data/layouts/layouts.json'))['layouts'] if 'width' in l]
routes = [l for l in layouts if re.fullmatch(r'Route1\d\d_Layout', l['name']) and l['primary_tileset'] == 'gTileset_General']

_bl = {}
def _blue(prim, sec, m):
    if (sec, m) not in _bl:
        px = list(render(prim, sec, m).getdata()); _bl[(sec, m)] = sum(1 for p in px if p[2] > p[0] + 30 and p[2] > p[1])/len(px)
    return _bl[(sec, m)]

def class_grid(l):
    W, H = l['width'], l['height']; b = struct.unpack(f'<{W*H}H', open(f"{PE}/{l['blockdata_filepath']}", 'rb').read())
    prim = 'general'; sec = l['secondary_tileset'].replace('gTileset_', '').lower()
    cl = []
    for v in b:
        m, coll = v & 0x3ff, (v >> 10) & 3 != 0
        c = classify(prim, sec, m, coll)
        if c in 'GP' and not coll and _blue(prim, sec, m) > 0.3: c = 'Q'   # shallow water / puddles (walkable)
        elif not fits_class(prim, sec, m, c): c = 'X'        # man-made or off-colour piece
        cl.append(c)
    # path vs sand: both are 'P' to the classifier. A P area is sand ('D') if it is broad (some tile is 3+ tiles from
    # any non-P tile, i.e. 5+ wide) or touches water; otherwise it's a path (narrow strip, like Emerald's dirt paths)
    seen = [False]*(W*H)
    for i0 in range(W*H):
        if cl[i0] != 'P' or seen[i0]: continue
        comp, st, broad, wet = [], [i0], False, False; seen[i0] = True; rim = collections.Counter()
        while st:
            i = st.pop(); comp.append(i); x, y = i % W, i//W
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny*W + nx
                    if cl[j] in 'WQ': wet = True
                    if cl[j] != 'P': rim['rock' if cl[j] == 'C' else 'green' if cl[j] in 'GHT' else 'other'] += 1
                    if cl[j] == 'P' and not seen[j]: seen[j] = True; st.append(j)
            if not broad and all(0 <= x + dx < W and 0 <= y + dy < H and cl[(y + dy)*W + x + dx] == 'P'
                                 for dy in range(-2, 3) for dx in range(-2, 3)): broad = True
        rocky = rim['rock'] >= 0.4*max(1, sum(rim.values()))          # walkable rock tops on sea/mountain routes
        if broad or wet or rocky:
            for i in comp: cl[i] = 'D'
    # cliff facing from neighbours: the side(s) where a C tile meets open walkable ground
    out = list(cl)
    walk = set('GPDQHSsew')
    for y in range(H):
        for x in range(W):
            if cl[y*W + x] != 'C': continue
            sides = ''.join(d for d, dx, dy in (('S', 0, 1), ('N', 0, -1), ('E', 1, 0), ('W', -1, 0))
                            if 0 <= x + dx < W and 0 <= y + dy < H and cl[(y + dy)*W + x + dx] in walk)
            out[y*W + x] = {'': 'C', 'S': 'v', 'N': '^', 'E': '>', 'W': '<'}.get(sides, 'K')   # K = corner/end piece
    return W, H, out, sec, [v & 0x3ff for v in b]

MASS = {'T':'forest', 'G':'meadow', 'H':'meadow', 'P':'meadow', 'D':'sand', 'Q':'water', 'W':'water', 'C':'rock', 'v':'rock', '^':'rock',
        '>':'rock', '<':'rock', 'K':'rock', 'S':'rock', 's':'meadow', 'e':'meadow', 'w':'meadow'}
def describe(g, w, h):
    cnt = collections.Counter(g)
    mass = collections.Counter(MASS.get(c, 'other') for c in g).most_common(1)[0][0]
    ov = []
    if cnt['P']: ov.append('path')
    if cnt['H']: ov.append('tall grass')
    if cnt['W'] and mass != 'water': ov.append('water edge')
    if any(cnt[c] for c in 'v^<>K') or (cnt['C'] and mass != 'rock'): ov.append('cliff')
    if cnt['S']: ov.append('stairs')
    if any(cnt[c] for c in 'sew'): ov.append('ledge')
    if cnt['T'] and mass != 'forest': ov.append('trees')
    edges = {'N': ''.join(g[x] for x in range(w)), 'S': ''.join(g[(h - 1)*w + x] for x in range(w)),
             'W': ''.join(g[y*w] for y in range(h)), 'E': ''.join(g[y*w + w - 1] for y in range(h))}
    return mass, ov, edges

def path_shape(edges):
    """For path cells: which sides the path leaves through (e.g. 'NS' straight, 'NE' turn, 'NES' fork)."""
    return ''.join(s for s in 'NESW' if 'P' in edges[s])

SIZES = [(4, 4, 2), (8, 8, 4), (12, 8, 4), (8, 12, 4), (12, 12, 4)]
lib = {size[:2]: {} for size in SIZES}
rejected = collections.Counter(); seen_blocks = collections.Counter()
for l in routes:
    W, H, g, sec, ids = class_grid(l)
    biome = BIOME.get(sec, sec)
    for (bw, bh, stride) in SIZES:
        for y0 in range(0, H - bh + 1, stride):
            for x0 in range(0, W - bw + 1, stride):
                blk = [g[(y0 + y)*W + x0 + x] for y in range(bh) for x in range(bw)]
                seen_blocks[(bw, bh)] += 1
                if 'X' in blk: rejected[((bw, bh), 'man-made / off-colour piece')] += 1; continue
                key = ''.join(blk)
                e = lib[(bw, bh)].get(key)
                if not e:
                    mass, ov, edges = describe(blk, bw, bh)
                    e = lib[(bw, bh)][key] = {'w':bw, 'h':bh, 'grid':key, 'mass':mass, 'overlays':ov, 'sockets':edges,
                                              'pathSides':path_shape(edges), 'count':0, 'biomes':collections.Counter(), 'src':[]}
                e['count'] += 1; e['biomes'][biome] += 1
                if len(e['src']) < 3: e['src'].append([l['name'][:-7], x0, y0, sec])

# ---- coverage of the cell types the planner will ask for (4x4) ----
cells = list(lib[(4, 4)].values())
def has(pred): return [c for c in cells if pred(c)]
need = collections.OrderedDict([
  ('forest interior', has(lambda c: set(c['grid']) == {'T'})),
  ('meadow (no path, no trees)', has(lambda c: set(c['grid']) <= set('GH') and 'G' in c['grid'])),
  ('tall-grass field', has(lambda c: c['grid'].count('H') >= 8)),
  ('water interior', has(lambda c: set(c['grid']) == {'W'})),
  ('forest edge (forest + meadow)', has(lambda c: set(c['grid']) <= set('TGH') and 'T' in c['grid'] and ('G' in c['grid'] or 'H' in c['grid']))),
  ('shore (water + land)', has(lambda c: 'W' in c['grid'] and set(c['grid']) - {'W'})),
  ('sand / beach', has(lambda c: c['grid'].count('D') >= 8)),
])
for sides, nm in [('NS', 'path straight N–S'), ('EW', 'path straight E–W'), ('NE', 'path turn N–E'), ('ES', 'path turn E–S'),
                  ('SW', 'path turn S–W'), ('NW', 'path turn N–W'), ('NES', 'path fork N–E–S'), ('ESW', 'path fork E–S–W'),
                  ('NSW', 'path fork N–S–W'), ('NEW', 'path fork N–E–W'), ('NESW', 'path crossing')]:
    need[nm] = has(lambda c, s=sides: c['pathSides'] == s)
for ch, nm in [('v', 'cliff south face'), ('^', 'cliff north rim'), ('>', 'cliff east side'), ('<', 'cliff west side'), ('K', 'cliff corner')]:
    need[nm] = has(lambda c, ch=ch: ch in c['grid'])
need['stairs'] = has(lambda c: 'S' in c['grid'])
need['ledge (south)'] = has(lambda c: 's' in c['grid'])
need['ledge (east/west)'] = has(lambda c: 'e' in c['grid'] or 'w' in c['grid'])

# ---- contact sheets: draw templates as class colours (shapes, not tiles) ----
COL = {'G':(120, 200, 110), 'H':(50, 140, 70), 'P':(240, 170, 60), 'D':(240, 225, 160), 'Q':(140, 200, 240), 'T':(30, 100, 50), 'W':(70, 150, 230), 'C':(110, 90, 80),
       'v':(90, 60, 50), '^':(180, 160, 140), '>':(130, 100, 90), '<':(130, 100, 90), 'K':(60, 40, 35), 'S':(230, 230, 230),
       's':(240, 150, 40), 'e':(240, 150, 40), 'w':(240, 150, 40)}
def sheet(items, name, px=6, cols=12):
    if not items: return None
    bw, bh = items[0]['w'], items[0]['h']; cw, ch = bw*px + 6, bh*px + 14
    rows = (len(items) + cols - 1)//cols
    im = Image.new('RGB', (cols*cw, rows*ch), (25, 25, 35)); d = ImageDraw.Draw(im)
    for k, t in enumerate(items):
        ox, oy = (k % cols)*cw, (k//cols)*ch
        for i, c in enumerate(t['grid']):
            x, y = i % bw, i//bw; d.rectangle([ox + x*px, oy + 12 + y*px, ox + x*px + px - 1, oy + 12 + y*px + px - 1], fill=COL.get(c, (255, 0, 255)))
        d.text((ox, oy), f"x{t['count']}", fill=(255, 255, 0))
    path = os.path.join(OUT, f'contact_{name}.png'); im.save(path); return path

_lay = {l['name'][:-7]: l for l in routes}; _ids = {}
def real_sheet(items, name, cols=8, px=8):
    """The same templates drawn with the real tiles from the map each one was cut from."""
    if not items: return None
    bw, bh = items[0]['w'], items[0]['h']; cw, ch = bw*px + 6, bh*px + 14
    im = Image.new('RGB', (cols*cw, ((len(items) + cols - 1)//cols)*ch), (25, 25, 35)); d = ImageDraw.Draw(im)
    for k, t in enumerate(items):
        rname, x0, y0, sec = t['src'][0]; l = _lay[rname]
        if rname not in _ids: _ids[rname] = class_grid(l)[4]
        W = l['width']; ids = _ids[rname]; ox, oy = (k % cols)*cw, (k//cols)*ch
        for y in range(bh):
            for x in range(bw):
                im.paste(render('general', sec, ids[(y0 + y)*W + x0 + x]).resize((px, px)), (ox + x*px, oy + 12 + y*px))
        d.text((ox, oy), f"{rname[5:]} x{t['count']}", fill=(255, 255, 0))
    path = os.path.join(OUT, f'real_{name}.png'); im.save(path); return path

top = lambda lst, n=24: sorted(lst, key=lambda c: -c['count'])[:n]
sheets = []
for nm in ['forest edge (forest + meadow)', 'shore (water + land)', 'path straight N–S', 'path turn N–E', 'cliff south face', 'tall-grass field']:
    p = sheet(top(need[nm]), re.sub(r'[^a-z]+', '_', nm.lower()).strip('_'))
    if p: sheets.append((nm, p))
for nm in ['path turn N–E', 'cliff south face', 'forest edge (forest + meadow)']:
    p = real_sheet(top(need[nm], 16), re.sub(r'[^a-z]+', '_', nm.lower()).strip('_'))
    if p: sheets.append((nm + ' (real tiles)', p))
_big = sorted(lib[(12, 12)].values(), key=lambda c: (-len(c['overlays']), -c['count']))[:16]
p = real_sheet(_big, 'chunks_12x12', cols=4, px=8); sheets.append(('12×12 chunks (real tiles)', p))
for (bw, bh) in [(8, 8), (12, 12)]:
    big = sorted(lib[(bw, bh)].values(), key=lambda c: (-len(c['overlays']), -c['count']))
    p = sheet(big[:36], f'chunks_{bw}x{bh}', px=4, cols=9)
    if p: sheets.append((f'{bw}×{bh} chunks with the most going on', p))

# ---- write atlas + report ----
atlas = {'version':1, 'source':'pokeemerald-expansion 1.17.2, Emerald Route101–134', 'classes':COL and list(COL.keys()),
         'templates':{f'{w}x{h}':[{**t, 'biomes':dict(t['biomes'])} for t in lib[(w, h)].values()] for (w, h) in lib}}
json.dump(atlas, open(os.path.join(OUT, 'templateAtlas.json'), 'w'), separators=(',', ':'))
L = ['# Template atlas — coverage report (Emerald routes)', '',
     f'Source: {len(routes)} Emerald routes (Route101–134). Classes: G grass · H tall grass · P path (narrow strip) · D sand / bare ground (broad, by water, or rock tops) · Q shallow water (walkable) · T tree · W water · '
     'C rock · cliff by facing v south face, ^ north rim, > east side, < west side, K corner/end · S stairs · s/e/w ledges.', '',
     '## Templates by size', '', '| Size | Blocks seen | Rejected (man-made / off-colour) | Distinct templates | Used once |', '|---|---|---|---|---|']
for (bw, bh) in lib:
    ts = lib[(bw, bh)].values()
    L.append(f'| {bw}×{bh} | {seen_blocks[(bw, bh)]} | {rejected[((bw, bh), "man-made / off-colour piece")]} | {len(lib[(bw, bh)])} | {sum(1 for t in ts if t["count"] == 1)} |')
L += ['', '## 4×4 cells by base mass and biome', '', '| Base mass | Templates | Biomes (template count) |', '|---|---|---|']
bym = collections.defaultdict(list)
for c in cells: bym[c['mass']].append(c)
for m, lst in sorted(bym.items(), key=lambda kv: -len(kv[1])):
    bio = collections.Counter(); [bio.update(c['biomes'].keys()) for c in lst]
    L.append(f'| {m} | {len(lst)} | {", ".join(f"{b} {n}" for b, n in bio.most_common())} |')
L += ['', '## Coverage of the cell types the planner needs (4×4)', '', '| Cell type | Templates | Uses in Emerald | Status |', '|---|---|---|---|']
for nm, lst in need.items():
    uses = sum(c['count'] for c in lst)
    status = 'gap — needs authored templates' if not lst else 'thin' if len(lst) < 5 else 'ok'
    L.append(f'| {nm} | {len(lst)} | {uses} | {status} |')
socks = collections.Counter(s for c in cells for s in c['sockets'].values())
L += ['', '**Reading this:** most templates occur once (exact class grids rarely repeat), so the planner must match by edge sockets and cell type, not by exact grid. Rejected blocks contain man-made or off-colour pieces (houses, signs, fences, docks, special tiles); these become anchored details later rather than templates.', '', f'Distinct 4-tile edge sockets: {len(socks)} (top 10: ' + ', '.join(f'`{s}`×{n}' for s, n in socks.most_common(10)) + ')', '',
      '## Contact sheets', ''] + [f'- {nm}: `{os.path.basename(p)}`' for nm, p in sheets]
open(os.path.join(OUT, 'template_report.md'), 'w').write('\n'.join(L) + '\n')
print('\n'.join(L))
