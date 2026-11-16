"""Build the static map-data tiles that regionMapForge.html loads.

Sources:
- Natural Earth 1:10m vector data (public domain), GeoJSON from
  https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
- GeoNames places with population > 1000 (CC BY 4.0, https://www.geonames.org), as JSON from
  https://github.com/lutangar/cities.json  (save it as geonames_cities1000.json next to the Natural Earth files)

Output: data/ne/<tx>_<ty>.json, one file per 10x10 degree tile
(tx = floor(lon/10), ty = floor(lat/10)), plus data/ne/index.json listing the tiles.

Each tile holds the features whose bounding box touches it:
  roads:  [id, class, label, [coords]]    class 3 = expressway/major, 2 = secondary, 1 = other;
                                          label e.g. "I-15", "US-189", "E31" ("" if unnamed)
  rivers: [id, name, [coords]]
  lakes:  [id, name, [coords]]            exterior ring only
  places: [name, lat, lon, pop, capital]  capital "2" = national, "4" = state/province, "" = none;
                                          pop 0 = a GeoNames town without a population figure (> 1000 people)
  peaks:  [name, lat, lon, elevation_m]
  seas:   [name, [coords]]                named seas, bays, straits, sounds (clipped to the tile)
  regions:[name, kind, [coords]]          kind: range, plateau, desert, plain, basin, coast (clipped to the tile)
Coordinates are integers in 1/1000 degree (~100 m), delta-encoded:
  [lon0, lat0, dlon1, dlat1, ...]

Usage:  python tools/build_static_data.py <folder with the Natural Earth .geojson files>
"""
import json, math, os, sys
from collections import defaultdict
from shapely.geometry import shape, LineString, Polygon, box

SRC = sys.argv[1] if len(sys.argv) > 1 else 'ne_raw'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'ne')
TILE = 10          # degrees
Q = 1000           # coordinate quantisation: 1/1000 degree
ROAD_TOL, RIVER_TOL, LAKE_TOL = 0.01, 0.01, 0.01   # simplification tolerance in degrees (~1 km)

tiles = defaultdict(lambda: {'roads': [], 'rivers': [], 'lakes': [], 'places': [], 'peaks': [], 'seas': [], 'regions': []})

def load(name):
    path = os.path.join(SRC, name + '.geojson')
    return json.load(open(path))['features'] if os.path.exists(path) else []

def encode(coords):
    out, px, py = [], 0, 0
    for i, (x, y) in enumerate(coords):
        qx, qy = round(x * Q), round(y * Q)
        if i and qx == px and qy == py:
            continue
        out += [qx, qy] if i == 0 else [qx - px, qy - py]
        px, py = qx, qy
    return out

def tile_keys(minx, miny, maxx, maxy):
    for tx in range(math.floor(minx / TILE), math.floor(maxx / TILE) + 1):
        for ty in range(math.floor(miny / TILE), math.floor(maxy / TILE) + 1):
            yield f'{tx}_{ty}'

def lines_of(geom):
    if geom.geom_type == 'LineString':
        return [geom]
    if geom.geom_type == 'MultiLineString':
        return list(geom.geoms)
    return []

def add_line(layer, fid, attr, geom, tol, extra=None):
    for part in lines_of(geom):
        s = part.simplify(tol, preserve_topology=False)
        if s.is_empty or len(s.coords) < 2:
            continue
        enc = encode(list(s.coords))
        if len(enc) < 4:
            continue
        for k in tile_keys(*s.bounds):
            tiles[k][layer].append([fid, attr, enc] if extra is None else [fid, attr, extra, enc])

def road_label(p):
    # "I-15" / "US-189" / "SR-201" in the US, "E31" in Europe, otherwise whatever label Natural Earth has
    if p.get('label'):
        return p['label']
    name, level = (p.get('name') or '').strip(), p.get('level')
    if not name:
        return ''
    if p.get('sov_a3') == 'USA' and name.isdigit():
        return {'Interstate': 'I-', 'Federal': 'US-', 'State': 'SR-'}.get(level, 'Hwy ') + name
    if p.get('prefix'):
        return p['prefix'] + name
    return ('Hwy ' + name) if name.isdigit() else name

def add_clipped_polys(layer, row_head, geom, tol):
    # Big polygons (oceans, deserts) would be copied into hundreds of tiles; clip each copy to its tile instead.
    g = geom.simplify(tol, preserve_topology=True)
    if g.is_empty:
        return
    for k in tile_keys(*g.bounds):
        tx, ty = map(int, k.split('_'))
        clip = g.intersection(box(tx*TILE, ty*TILE, (tx+1)*TILE, (ty+1)*TILE))
        parts = [clip] if clip.geom_type == 'Polygon' else [q for q in getattr(clip, 'geoms', []) if q.geom_type == 'Polygon']
        for q in parts:
            if q.is_empty or q.area < 1e-4:
                continue
            enc = encode(list(q.exterior.coords))
            if len(enc) >= 8:
                tiles[k][layer].append(row_head + [enc])

# ---- roads: no ferries or tracks; class from expressway flag / road type ----
fid = 0
for f in load('ne_10m_roads'):
    p = f['properties']
    t = (p.get('type') or '')
    if 'Ferry' in t or t == 'Track' or not f.get('geometry'):
        continue
    cls = 3 if (p.get('expressway') == 1 or t in ('Major Highway', 'Beltway')) else 2 if t == 'Secondary Highway' else 1
    fid += 1
    add_line('roads', fid, cls, shape(f['geometry']), ROAD_TOL, extra=road_label(p))

def river_name(p):
    # North America has full names ("Green River"); elsewhere Natural Earth stores just "Green"
    full = p.get('name_full') or ''
    if full:
        return full
    base = p.get('name') or ''
    if not base or any(w in base.lower() for w in ('river', 'creek', 'canal', 'rio ', 'río ', 'fleuve', 'fluss')):
        return base
    return base + ' River'

# ---- rivers: global centerlines + the more detailed North America / Europe supplements ----
for name in ('ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_north_america', 'ne_10m_rivers_europe'):
    for f in load(name):
        p = f['properties']
        if not f.get('geometry') or 'Lake Centerline' in (p.get('featurecla') or ''):
            continue
        fid += 1
        add_line('rivers', fid, river_name(p), shape(f['geometry']), RIVER_TOL)

# ---- lakes: exterior rings ----
for name in ('ne_10m_lakes', 'ne_10m_lakes_north_america', 'ne_10m_lakes_europe'):
    for f in load(name):
        if not f.get('geometry'):
            continue
        p = f['properties']
        g = shape(f['geometry'])
        polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
        for poly in polys:
            s = Polygon(poly.exterior).simplify(LAKE_TOL, preserve_topology=True)
            if s.is_empty or s.geom_type != 'Polygon' or len(s.exterior.coords) < 4:
                continue
            fid += 1
            enc = encode(list(s.exterior.coords))
            for k in tile_keys(*s.bounds):
                tiles[k]['lakes'].append([fid, p.get('name') or '', enc])   # 'name' is the full form, e.g. "Utah Lake"

# ---- populated places ----
for f in load('ne_10m_populated_places'):
    p = f['properties']
    lat, lon = p['LATITUDE'], p['LONGITUDE']
    cla = p.get('FEATURECLA') or ''
    cap = '2' if 'Admin-0 capital' in cla else '4' if 'Admin-1 capital' in cla else ''
    k = next(tile_keys(lon, lat, lon, lat))
    tiles[k]['places'].append([p.get('NAMEASCII') or p['NAME'], round(lat, 4), round(lon, 4), int(p.get('POP_MAX') or 0), cap])

# ---- GeoNames towns (> 1000 people) fill in between Natural Earth's big places ----
ne_names = defaultdict(list)
for layers in tiles.values():
    for name, lat, lon, *_ in layers['places']:
        ne_names[name.lower()].append((lat, lon))
gpath = os.path.join(SRC, 'geonames_cities1000.json')
if os.path.exists(gpath):
    for c in json.load(open(gpath, encoding='utf-8')):
        lat, lon = float(c['lat']), float(c['lng'])
        if any(abs(lat - a) < 0.2 and abs(lon - b) < 0.2 for a, b in ne_names.get(c['name'].lower(), [])):
            continue                                  # already have it from Natural Earth, with a population
        k = next(tile_keys(lon, lat, lon, lat))
        tiles[k]['places'].append([c['name'], round(lat, 4), round(lon, 4), 0, ''])

# ---- mountain peaks ----
for f in load('ne_10m_geography_regions_elevation_points'):
    p = f['properties']
    if not p.get('name'):
        continue
    lat, lon = p['lat_y'], p['long_x']
    k = next(tile_keys(lon, lat, lon, lat))
    tiles[k]['peaks'].append([p.get('name_en') or p['name'], round(lat, 4), round(lon, 4), int(p.get('elevation') or 0)])

# ---- named seas / bays / straits ----
for f in load('ne_10m_geography_marine_polys'):
    p = f['properties']
    name = p.get('name_en') or p.get('name')
    if name and f.get('geometry'):
        add_clipped_polys('seas', [name], shape(f['geometry']).buffer(0), 0.03)

# ---- named mountain ranges and landforms ----
KINDS = {'Range/mtn': 'range', 'Plateau': 'plateau', 'Desert': 'desert', 'Plain': 'plain', 'Basin': 'basin', 'Coast': 'coast'}
for f in load('ne_10m_geography_regions_polys'):
    p = {k.lower(): v for k, v in f['properties'].items()}
    kind = KINDS.get(p.get('featurecla'))
    name = p.get('name_en') or p.get('name')
    if kind and name and f.get('geometry'):
        add_clipped_polys('regions', [name, kind], shape(f['geometry']).buffer(0), 0.03)

# ---- write ----
os.makedirs(OUT, exist_ok=True)
for old in os.listdir(OUT):
    os.remove(os.path.join(OUT, old))
total = 0
for k, layers in tiles.items():
    data = json.dumps(layers, separators=(',', ':'), ensure_ascii=False)
    with open(os.path.join(OUT, k + '.json'), 'w', encoding='utf-8') as fh:
        fh.write(data)
    total += len(data)
json.dump(sorted(tiles), open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
biggest = sorted(((os.path.getsize(os.path.join(OUT, k + '.json')), k) for k in tiles), reverse=True)[:5]
print(f'{len(tiles)} tiles, {total/1048576:.1f} MB total; biggest: ' + ', '.join(f'{k} {s/1024:.0f} KB' for s, k in biggest))
