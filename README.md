# poke-region-map

A prototype for a Pokémon Emerald (pokeemerald decomp) ROM hack: pick any real-world area and turn it into a Gen 4-style Town Map laid out on Emerald's 28×15 region-map grid.

## Files

| File | What it is |
|---|---|
| `regionMapForge.html` | Full version. Frame a real place on a live map and forge a region from real data. Open it in a desktop browser. |
| `demo/index.html` | Mobile demo, **generated from the full version** by `tools/build_demo.py`. Makes fictional regions (terrain, rivers, named roads, lakes, seas, ranges, towns) offline, with the same editor, naming, rerolls, locks, themes, animations and undo. No real-map overlay, share links, Wikipedia or file import/export. |
| `tools/build_demo.py` | Rebuilds the demo from `regionMapForge.html`. Run it after changing the full version. |
| `data/ne/` | Bundled map data: roads (with route numbers), rivers, lakes, seas, mountain ranges and landforms, towns and peaks, cut into 10°×10° tiles (~11 MB for the whole world; a region loads only the tiles it touches). |
| `tools/build_static_data.py` | Rebuilds `data/ne/` from the source datasets. |

## Features

- **Terrain:** coastlines and lakes from OpenStreetMap tiles (bundled lake outlines as a fallback); hills, mountains and peaks from Terrarium elevation tiles (measured relative to the region's lowlands).
- **Roads and rivers:** from the bundled Natural Earth data, so they load in a fraction of a second. Road detail follows frame width: major highways only from 150 km, plus secondary highways from 50 km, all mapped roads below that.
- **Towns:** Natural Earth cities (with populations) and GeoNames towns over 1,000 people, ranked and spaced out. The biggest cities take 2 squares. When the bundled towns are thin or the frame is zoomed in, OpenStreetMap is asked for villages and neighborhoods, with an 8–15 second limit.
- **Landmarks:** bundled mountain peaks and named lakes, plus OSM parks and attractions when available.
- **Routes:** a minimum spanning tree plus optional shortcuts. Each route is pathed with A* that prefers real roads, avoids mountains, can cross water (sea routes) and penalises turns. Numbered from Route 201 outward from the starting town.
- **Route style:** a straight ↔ bendy slider. Straight makes turns expensive so routes run in long lines; bendy makes turns cheap, pulls routes onto real roads harder, and adds a gentle random wander. Changes apply instantly.
- **Route names:** each route is named after the most distinctive real feature it passes, in priority order: roads ("I-15 Corridor"), rivers ("Jordan River Walk"), lakes ("Utah Lake Shore"), seas and bays ("Chesapeake Bay Coast"), then mountains ("Wasatch Range Pass"). Only if none apply does it fall back to terrain, using a real landform where possible ("Great Basin Flats"). A **Pokémon-style** toggle swaps in livelier versions ("I-15 Cycling Road", "Potomac Bridge"), and any route can be renamed by hand.
- **Ambient animation:** swaying sea swells, shoreline sparkles and lake glints; drifting cloud shadows (toggle); marching ants along the selected route; and a slide-in location pop-up. Motion stops if your device asks for reduced motion.
- **Route profiles:** select a route to see its real length in km and an elevation profile (climb, descent, lowest and highest point). The list shows each route's length too.
- **Place blurbs:** selecting a real town or landmark shows the first two sentences of its Wikipedia article (found near the place's real coordinates, with a link and CC BY-SA credit).
- **Themes:** Day, Night, Pokétch (4-green handheld style), Sepia, and **Live**, which tints the map by the real sun altitude at the region's centre right now (day → golden hour → dusk → twilight → night, refreshed every minute). Saved with the region and included in share links.
- **Map reveal:** after forging, the terrain sweeps in as soon as it's ready, then routes grow outward from the starting town by travel distance and towns pop in as they're reached. Rerolls replay it; tap the map to skip.
- **Fast drawing:** terrain and routes are cached as layers; each animation frame only draws the moving pixels (about 100 operations instead of ~7,400).
- **Emerald-style cursor:** D-pad or arrow keys, with a pop-up showing the name of the square under the cursor.
- **Editing:** move, add, delete and link towns; paint land, water and mountains; rename, resize and rotate cities.
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
2. Search or pan so the dashed 28×15 frame covers your region. Rotate the frame in 15° steps to fit coastlines or valleys, and type an exact **km per square** (minimum 0.112, about 1:50,000 at the OGC 0.28 mm pixel; no maximum). Rotated maps get a north arrow.
3. Set the number of towns and extra routes, then press **Forge Region**.
4. Edit as needed, then export.

## Data sources

- Roads, rivers, lakes, cities, peaks: [Natural Earth](https://www.naturalearthdata.com) 1:10m (public domain)
- Towns over 1,000 people: [GeoNames](https://www.geonames.org) (CC BY 4.0), via [lutangar/cities.json](https://github.com/lutangar/cities.json)
- Map tiles, villages, neighborhoods, extra landmarks: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (tiles and Overpass API)
- Elevation: [Terrarium tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data)
- Place search: Nominatim

### Rebuilding the bundled data

1. Download the Natural Earth GeoJSON layers used in `tools/build_static_data.py` from [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/tree/master/geojson), and `cities.json` from lutangar/cities.json saved as `geonames_cities1000.json`, into one folder.
2. `pip install shapely`
3. `python tools/build_static_data.py <that folder>`

## Status

Prototype. The next step is converting the exported layout into pokeemerald's region-map files.
