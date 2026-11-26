# poke-region-map

A prototype for a Pokémon Emerald (pokeemerald decomp) ROM hack: pick any real-world area and turn it into a Gen 3-style Town Map laid out on Emerald's 28×15 region-map grid.

## Files

| File | What it is |
|---|---|
| `regionMapForge.html` | Full version. Frame a real place on a live map and forge a region from real data. Open it in a desktop browser. |
| `demo/index.html` | Mobile demo, **generated from the full version** by `tools/build_demo.py`. Makes fictional regions (terrain, rivers, named roads, lakes, seas, ranges, towns) offline, with the same editor, naming, rerolls, locks, themes, animations and undo. No real-map overlay, share links, Wikipedia or file import/export. |
| `tools/apply_to_pokeemerald.py` | Installs a pokeemerald export into a pokeemerald checkout (bundled into each export ZIP). |
| `tools/build_demo.py` | Rebuilds the demo from `regionMapForge.html`. Run it after changing the full version. |
| `data/ne/` | Bundled map data: roads (with route numbers), rivers, lakes, seas, mountain ranges and landforms, towns and peaks, cut into 10°×10° tiles (~11 MB for the whole world; a region loads only the tiles it touches). |
| `tools/build_static_data.py` | Rebuilds `data/ne/` from the source datasets. |
| `overworld/overworldGen.js` | **Prototype** overworld map generator: walkable maps, one per region-map square (32×32 metatiles; 24×24 for comparison), with matching seams, terrain levels (cliffs, one-way ledges, stairs and side stairs), real-road ports, winding least-cost paths through seeded waypoints, path + verge widths from land cover, bridges, Surf crossings, and reachability checks. Runs in the browser (the **OVERWORLD 3×3** button previews the 3×3 block around the selected route, town or cursor) and in Node. Draws abstract tile classes for now; real metatiles come later. |
| `overworld/testOverworld.js` | Headless tests for the generator: `node overworld/testOverworld.js` (determinism, window independence, seams, reachability). |

## Features

- **Terrain:** coastlines and lakes from OpenStreetMap tiles (bundled lake outlines as a fallback); hills, mountains and peaks from Terrarium elevation tiles (measured relative to the region's lowlands).
- **Roads and rivers:** from the bundled Natural Earth data, so they load in a fraction of a second. Road detail follows frame width: major highways only from 150 km, plus secondary highways from 50 km, all mapped roads below that.
- **Towns:** Natural Earth cities (with populations) and GeoNames towns over 1,000 people, ranked and spaced out. The biggest cities take 2 squares. When the bundled towns are thin or the frame is zoomed in, Wikidata (towns, suburbs, hills, dams and parks with English names, usually about a second) and OpenStreetMap (villages and neighborhoods, 8–15 second limit) fill the gaps. If there still aren't enough towns, extra towns take the names of nearby real features (a hill or a dam, say) and if real names still run out, the map simply has fewer towns (no made-up placeholders).
- **Land cover:** forest, wetland, mangroves, desert, snow, tundra and dry grassland from [ESA WorldCover](https://esa-worldcover.org) 2021 (10 m), read live through Microsoft Planetary Computer. Offline, or for frames wider than about 9°, the forge uses `data/landcover/` if you've built it (`tools/build_landcover_data.py`, about 1 km pixels). Cover changes the look, the square's description and route names ("Whispering Woods", "Misty Marsh", "Frozen Tundra"), but not routing.
- **Climate:** Köppen-Geiger zones (Rubel et al. 2017, ~3 km), bundled in `data/climate/` (0.5 MB, built by `tools/build_climate_data.py`). Climate:
  - sets the snowline (ice caps, and tundra peaks), and settles unclear land cover: bare ground is desert in a desert climate but tundra in a polar one, "snow" on a hot desert lowland is a salt flat, grass is dry grassland only where it's arid. With no land cover at all, climate alone picks deserts, tundra and rainforest;
  - adds a line to the square and town info ("Climate: Humid subtropical (Cfa)");
  - picks weather: rain, downpour, snow, sandstorm, fog, overcast or sun. Tick **Weather** to see it animated on the map;
  - suggests weather for every map section in the pokeemerald export (listed in its README.txt; `apply_to_pokeemerald.py … --weather` writes it into the outdoor maps' `map.json`).
- **Landmarks:** bundled mountain peaks and named lakes, plus Wikidata and OSM parks, hills and attractions when available. Add your own with **+ LANDMARK**; it gets a short route from the nearest town.
- **Routes:** a minimum spanning tree plus optional shortcuts. Every landmark is connected too: landmarks near a route are moved onto it, and any others get a short spur route from the nearest town. Each route is pathed with A* that prefers real roads, avoids mountains, can cross water (sea routes) and penalises turns. Numbered from Route 101 outward (Hoenn style) from the starting town.
- **Route style:** a straight ↔ bendy slider. Straight makes turns expensive so routes run in long lines; bendy makes turns cheap, pulls routes onto real roads harder, and adds a gentle random wander. Changes apply instantly.
- **Route names:** each route is named after the most distinctive real feature it passes, in priority order: roads ("I-15 Corridor"), rivers ("Jordan River Walk"), lakes ("Utah Lake Shore"), seas and bays ("Chesapeake Bay Coast"), then mountains ("Wasatch Range Pass"). Only if none apply does it fall back to terrain, using a real landform where possible ("Great Basin Flats"). A **Pokémon-style** toggle swaps in livelier versions ("I-15 Cycling Road", "Potomac Bridge"), and any route can be renamed by hand.
- **Ambient animation:** swaying sea swells, shoreline sparkles and lake glints; drifting cloud shadows (toggle); marching ants along the selected route; and a slide-in location pop-up. Motion stops if your device asks for reduced motion.
- **Route profiles:** select a route to see its real length in km and an elevation profile (climb, descent, lowest and highest point). The list shows each route's length too.
- **Place blurbs:** selecting a real town or landmark shows the first two sentences of its Wikipedia article (found near the place's real coordinates, with a link and CC BY-SA credit).
- **Map styles:** a Style menu with four looks, all on Emerald's 224×120 grid:
  - **Pixelated** (default): the original blocky look.
  - **Sinnoh (smooth):** green lowland, brown sunlit mountains with snowy peaks, smooth depth-banded water, rounded cloud shadows.
  - **Gen 3 (smooth):** GBA-style contour bands (dark green coastal rim, brighter inland, yellow on high ground), striped sea, flat orange routes and FireRed-style pale-blue landmark squares.
  - **HGSS (smooth):** green lowland with tan high ground and brown contour lines, banded blue water, white outlined routes, two-tone red towns, green landmark dots, and small picture icons (mountain, tree, water, cave) beside landmarks and routes.
  A **Land cover** toggle (on by default) shows forests, wetlands, deserts, snow, grassland, mangroves and tundra in every style, each in that style's own colours (HGSS adds little tree clusters). It only changes the look; route names stay the same. In every style, cover and elevation share the map so neither hides the other: forest and mangrove fill everywhere with the hills' contours and shadows drawn on top, snow keeps the mountain's own bands in white, grey and ice blue (only where the data has snow), and wetland, desert, dry grass and tundra show on lowland only.
  The smooth styles draw land, coasts and rivers one pixel at a time, with the coastline traced from the real OpenStreetMap shoreline (saved with the region; older saves use a softened edge until re-forged). The pokeemerald export uses the selected style.
- **Routes see-through slider:** from 20% to 100% solid (default 75%), for every style; saved with the region and baked into exports.
- **Themes:** Day, Night, Pokétch (4-green handheld style), Sepia, and **Live**, which tints the map by the real sun altitude at the region's centre right now (day → golden hour → dusk → twilight → night, refreshed every minute). Saved with the region and included in share links.
- **Map reveal:** after forging, the terrain sweeps in as soon as it's ready, then routes grow outward from the starting town by travel distance and towns pop in as they're reached. Rerolls replay it; tap the map to skip.
- **Fast drawing:** terrain and routes are cached as layers; each animation frame only draws the moving pixels (about 100 operations instead of ~7,400).
- **Emerald-style cursor:** D-pad or arrow keys, with a pop-up showing the name of the square under the cursor.
- **Editing:** move, add, delete and link towns; add landmarks (+ LANDMARK); paint land, water and mountains; paint land cover with eight cover brushes (FOREST, WETLAND, DESERT, SNOW, DRY GRASS, MANGROVE, TUNDRA, ERASE), one sub-square at a time. Cover brushes change the look only: elevation, route names and weather stay as they are. Painted cover survives rerolls and undo, and is kept in the auto-save and in EXPORT JSON (like all hand edits, it isn't in share links); rename, resize and rotate cities.
- **Region title bar:** an auto-suggested region name above the town map, from the most prominent named feature (a mountain range, then a sea or bay, then a landform, then the biggest city): e.g. WASATCH, CHESAPEAKE. Tap it to rename.
- **Towns & routes list:** every town, landmark and route in one list. Tap a row to jump the cursor there, ✎ to rename.
- **Real-map overlay:** lay the finished town map over the live map at its true position and rotation, with an opacity slider, to check it against the real geography.
- **Share links:** 🔗 Share Link copies a URL that rebuilds the same region (frame, scale, rotation, seed, layout number and settings). Hand edits like moved towns, locks or renamed routes aren't in links; share the exported JSON for those.
- **Reroll:** same area, different towns and landmarks, with no new downloads. Each layout has a number (#0 = best-ranked picks), and the same number always rebuilds the same layout. Uses the current Towns / Extra routes / landmark settings, so you can change those and reroll.
- **Lock:** lock any town or landmark from its info box (gold padlock on the map). Locked places survive rerolls exactly where they are, can't be deleted until unlocked, and routes you renamed keep their names as long as the same two towns stay connected.
- **Undo/redo:** every edit (moving, adding, deleting, linking, painting, renaming, sliders, re-route, even forging a new region) can be undone, 50 steps back. Buttons or Ctrl+Z / Ctrl+Y.
- **Auto-save:** your current region is saved in this browser and comes back when you reopen the page.
- **Export / import:** a poster PNG (title, the map, north arrow, scale bar in km and miles, a legend in the current theme, and data credits), a plain 4× map PNG for game assets, and JSON with a 28×15 `MAPSEC_*` layout, terrain sub-grid, towns and routes. The JSON also carries the full editor state, so **Import JSON** reopens it exactly where you left off (older exports import too, minus elevation and road data).

## Usage

1. Open the site (https://ajdur96.github.io/poke-region-map/), or run `python -m http.server` in this folder and open `http://localhost:8000`. Opening the file directly won't load the bundled data or the map tiles.
2. Pick a **Grid**: Emerald 28×15 (default), Sinnoh (Platinum) 28×23, HGSS (Johto only) 26×17, or HGSS (Johto + Kanto) 45×17. The DS sizes come from the pokeplatinum and pokeheartgold decomps (Platinum's Town Map cursor covers columns 1–28 and rows 6–28; the HGSS PokéGear map scrolls over rows 1–17 and columns 1–26 for Johto, 1–45 once Kanto opens). Every grid keeps Emerald's 8×8-pixel squares, so a DS grid is a bigger map, not finer detail. The region keeps its grid through rerolls, undo, saves, JSON and share links. **Export to pokeemerald works on the Emerald grid only for now**; PNG and JSON work on all three.
   Then search or pan so the dashed frame covers your region. Rotate the frame in 15° steps to fit coastlines or valleys, and type an exact **km per square** (minimum 0.112, about 1:50,000 at the OGC 0.28 mm pixel; no maximum). Rotated maps get a north arrow.
3. Set the number of towns and extra routes, then press **Forge Region**.
4. Edit as needed, then export.

## Export to pokeemerald

**EXPORT TO POKEEMERALD** downloads a ZIP for a [pret/pokeemerald](https://github.com/pret/pokeemerald) or [pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion) checkout (tested on expansion `master` and `upcoming`, including its smol-compressed graphics):

1. Unzip it anywhere.
2. `python apply_to_pokeemerald.py /path/to/pokeemerald`
3. `make`

How it fits into Emerald:

- **Existing map-section IDs are reused, not added.** MAPSEC IDs are referenced all over the game and stored in one byte (213 already exist), so your towns take the Hoenn town slots in journey order (your starting town becomes `MAPSEC_LITTLEROOT_TOWN`), routes take `MAPSEC_ROUTE_101` onward, and landmarks take cave/landmark slots like `MAPSEC_MT_CHIMNEY`. Only names and positions change, so everything still compiles. `region_export.json` and the README in the ZIP list the mapping.
- **Names** are romanized if needed, converted to the game's character set and fit to 16 characters (`MAP_NAME_LENGTH`), abbreviating common words first (MT., L., R., XING…).
- **Map picture** in Emerald's exact format: a 64×64 affine tilemap (`map.bin`, one byte per tile, map grid at tile (1, 2)), 8-bit tiles (`map.png`, at most 256; near-duplicates are merged if needed, never under a town or landmark marker; the Sinnoh style exports its lowland without the soft patches so it fits) and a 48-colour palette (`map.pal`) loaded at index 112. Verified with pokeemerald's own `gbagfx`.
- The script edits `region_map_sections.json`, rewrites `region_map_layout.h` (keeping your file's declaration), installs the graphics and updates `-num_tiles`. Each changed file is backed up once as `*.forge-backup`.
- Fly destinations and maps still point at the original Hoenn maps until you build your own; unused Hoenn sections keep their names and positions but aren't on the map.
- Not yet included: the separate **Pokédex area map** (`graphics/pokedex/region_map.png`), which both projects use on the Pokédex "Area" screen; it still shows Hoenn.

`tools/apply_to_pokeemerald.py` is the install script (the site includes it in each ZIP).

## Place names in other scripts

Names are shown in Latin letters. The forge first uses OpenStreetMap's English or Latin-script name tags (`name:en`, `int_name`, `name:latin`, `name:xx-Latn`), then keeps the Latin half of mixed names like "Sidi Senoussi سيدي سنوسي", and only then romanizes the local script automatically. The original name stays in the town's info box. Automatic romanization is letter-by-letter, so it can read oddly: Japanese kanji get Chinese readings (名古屋 → "Mingguwu"), and Arabic or Hebrew come out without vowels. The info box flags these so you can use RENAME.

## Data sources

- Roads, rivers, lakes, cities, peaks: [Natural Earth](https://www.naturalearthdata.com) 1:10m (public domain)
- Towns over 1,000 people: [GeoNames](https://www.geonames.org) (CC BY 4.0), via [lutangar/cities.json](https://github.com/lutangar/cities.json)
- Map tiles, villages, neighborhoods, extra landmarks: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (tiles and Overpass API)
- Elevation: [Terrarium tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data)
- Place search: Nominatim
- Extra towns and landmarks: [Wikidata](https://www.wikidata.org) (CC0)
- Land cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0), served by Microsoft Planetary Computer
- Climate: Rubel, Brugger, Haslinger & Auer (2017), Köppen-Geiger 1986–2010 at 100 arc-seconds, via the kgcpy package (BSD)
- Romanization: [any-ascii](https://github.com/anyascii/anyascii) (ISC), in `vendor/any-ascii.js`, loaded only when a region needs it

### Rebuilding the bundled data

1. Download the Natural Earth GeoJSON layers used in `tools/build_static_data.py` from [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/tree/master/geojson), and `cities.json` from lutangar/cities.json saved as `geonames_cities1000.json`, into one folder.
2. `pip install shapely`
3. `python tools/build_static_data.py <that folder>`

## Status

Prototype. The next step is converting the exported layout into pokeemerald's region-map files.
