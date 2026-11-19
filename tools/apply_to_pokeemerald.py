#!/usr/bin/env python3
"""Apply a Region Map Forge export to a pokeemerald or pokeemerald-expansion checkout.

Tested against pret/pokeemerald and rh-hideout/pokeemerald-expansion (master and upcoming), using each
project's own gbagfx (and expansion's compresSmol) on the installed files.

Usage:
    python apply_to_pokeemerald.py /path/to/pokeemerald [--weather]

    --weather   also set the suggested weather on the outdoor maps (routes, towns, cities) in each of
                your region's map sections (the "weather" field of data/maps/*/map.json). Off by default.

Run it from the unzipped export folder (it reads region_export.json and the graphics/ folder next to it).

What it changes (each file is backed up once as <file>.forge-backup before the first change):
  src/data/region_map/region_map_sections.json   names and x/y/width/height of the map sections your
                                                  region reuses (IDs stay the same, so nothing else breaks)
  src/data/region_map/region_map_layout.h         the 28x15 grid of map sections
  graphics/pokenav/region_map/map.png, map.pal, map.bin   the region map picture
  src/region_map.c (or graphics_file_rules.mk)    the -num_tiles value for map.png

Why reuse IDs: map section IDs (MAPSEC_*) are referenced all over the game (map headers, Fly
destinations, met locations) and must fit in one byte, so the export renames and moves existing
Hoenn sections instead of adding new ones. Your towns take the Hoenn town slots in journey order,
routes take ROUTE_101 onward, landmarks take cave/landmark slots. region_export.json lists the mapping.

Then rebuild with `make` as usual (the build regenerates the headers from the JSON).
"""
import json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def fail(msg):
    sys.exit(f'\nERROR: {msg}\nNothing more was changed.')


def backup(path):
    bak = path + '.forge-backup'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if len(args) != 1 or flags - {'--weather'}:
        print(__doc__)
        sys.exit(1)
    root = os.path.abspath(args[0])
    want_weather = '--weather' in flags
    exp_path = os.path.join(HERE, 'region_export.json')
    if not os.path.exists(exp_path):
        fail('region_export.json not found next to this script. Run it from the unzipped export folder.')
    exp = json.load(open(exp_path, encoding='utf-8'))

    sec_path = os.path.join(root, 'src', 'data', 'region_map', 'region_map_sections.json')
    layout_path = os.path.join(root, 'src', 'data', 'region_map', 'region_map_layout.h')
    gfx_dir = os.path.join(root, 'graphics', 'pokenav', 'region_map')
    for p in (sec_path, layout_path, gfx_dir):
        if not os.path.exists(p):
            fail(f'{p} not found. Is {root} a pokeemerald checkout?')

    # ---- check everything before changing anything ----
    sections = json.load(open(sec_path, encoding='utf-8'))
    by_id = {s['id']: s for s in sections['map_sections']}
    missing = [e['id'] for e in exp['sections'] if e['id'] not in by_id]
    if missing:
        fail('this checkout has no ' + ', '.join(missing) + '. (Very different forks may have renamed sections.)')
    layout_text = open(layout_path, encoding='utf-8').read()
    m = re.search(r'(=\s*\{)(.*)(\}\s*;)', layout_text, re.S)
    if not m:
        fail(f'could not find the layout array in {layout_path}')
    if len(exp['layout']) != 15 or any(len(r) != 28 for r in exp['layout']):
        fail('region_export.json layout is not 28x15')

    tiles_file = None
    # the exact region-map path, so other maps (e.g. the Pokedex area map, graphics/pokedex/region_map.png) are never touched
    for cand, pattern in ((os.path.join(root, 'src', 'region_map.c'), r'(pokenav/region_map/map\.png"[^)]*?-num_tiles\s+)(\d+)'),
                          (os.path.join(root, 'graphics_file_rules.mk'), r'(pokenav/region_map/map\.8bpp[^\n]*\n[^\n]*?-num_tiles\s+)(\d+)')):
        if os.path.exists(cand) and re.search(pattern, open(cand, encoding='utf-8').read()):
            tiles_file = (cand, pattern)
            break

    # ---- region_map_sections.json ----
    backup(sec_path)
    for e in exp['sections']:
        s = by_id[e['id']]
        s['name'], s['x'], s['y'], s['width'], s['height'] = e['name'], e['x'], e['y'], e['width'], e['height']
    with open(sec_path, 'w', encoding='utf-8') as f:
        json.dump(sections, f, indent=2, ensure_ascii=False)
        f.write('\n')

    # ---- region_map_layout.h (keeps your file's own declaration line) ----
    backup(layout_path)
    rows = ''.join('    {' + ', '.join(r) + '},\n' for r in exp['layout'])
    new_layout = layout_text[:m.start(2)] + '\n' + rows + layout_text[m.end(2):]
    open(layout_path, 'w', encoding='utf-8').write(new_layout)

    # ---- graphics ----
    for name in ('map.png', 'map.pal', 'map.bin'):
        dst = os.path.join(gfx_dir, name)
        if os.path.exists(dst):
            backup(dst)
        shutil.copyfile(os.path.join(HERE, 'graphics', name), dst)

    # ---- tile count ----
    n = exp['graphics']['numTiles']
    if tiles_file:
        path, pattern = tiles_file
        backup(path)
        text = open(path, encoding='utf-8').read()
        open(path, 'w', encoding='utf-8').write(re.sub(pattern, lambda mm: mm.group(1) + str(n), text, count=1))
        tiles_msg = f'set -num_tiles {n} in {os.path.relpath(path, root)}'
    else:
        tiles_msg = f'could not find -num_tiles for map.png; set it to {n} by hand where map.png is converted'

    # ---- optional: weather on every map that belongs to one of the region's sections ----
    weather_msg = None
    if want_weather:
        want = {e['id']: e.get('weather') for e in exp['sections'] if e.get('weather')}
        changed = 0
        maps_dir = os.path.join(root, 'data', 'maps')
        for d in sorted(os.listdir(maps_dir)) if os.path.isdir(maps_dir) else []:
            mp = os.path.join(maps_dir, d, 'map.json')
            if not os.path.exists(mp):
                continue
            text = open(mp, encoding='utf-8').read()
            sec = re.search(r'"region_map_section"\s*:\s*"(\w+)"', text)
            if not sec or sec.group(1) not in want:
                continue
            mt = re.search(r'"map_type"\s*:\s*"(\w+)"', text)      # outdoor maps only: no rain inside the Pokemon Center
            if not mt or mt.group(1) not in ('MAP_TYPE_ROUTE', 'MAP_TYPE_TOWN', 'MAP_TYPE_CITY', 'MAP_TYPE_OCEAN_ROUTE'):
                continue
            new = re.sub(r'("weather"\s*:\s*")\w+(")', lambda mm: mm.group(1) + want[sec.group(1)] + mm.group(2), text, count=1)
            if new != text:
                backup(mp)
                open(mp, 'w', encoding='utf-8').write(new)
                changed += 1
        weather_msg = f'weather set on {changed} maps (data/maps/*/map.json)'

    print(f'Applied "{exp["regionName"]}" to {root}')
    print(f'  {len(exp["sections"])} map sections renamed/moved ({sum(1 for e in exp["sections"] if e["kind"] == "town")} towns, '
          f'{sum(1 for e in exp["sections"] if e["kind"] == "route")} routes, {sum(1 for e in exp["sections"] if e["kind"] == "landmark")} landmarks)')
    print('  region_map_layout.h rewritten (28x15)')
    print(f'  map.png / map.pal / map.bin installed ({n} tiles); {tiles_msg}')
    if exp.get('shortenedNames'):
        print('  names shortened to fit 16 characters:')
        for s in exp['shortenedNames']:
            print(f'    {s["from"]}  ->  {s["to"]}')
    if weather_msg:
        print('  ' + weather_msg)
    print('Backups: *.forge-backup next to each changed file.')
    print('Next: run `make`. Unused Hoenn sections keep their old names and positions; they just are not on the map.')


if __name__ == '__main__':
    main()
