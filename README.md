# poke-region-map

A prototype for a Pokémon Emerald (pokeemerald decomp) ROM hack: pick any real-world area and turn it into a Gen 4-style Town Map laid out on Emerald's 28×15 region-map grid.

## Files

| File | What it is |
|---|---|
| `regionMapForge.html` | Full version. Frame a real place on a live map and forge a region from real data. Open it in a desktop browser. |
| `demo/index.html` | Mobile demo. Generates a fictional region (no live data needed), with the same editor, cursor and pop-up. |
| `data/ne/` | Bundled map data: roads, rivers, lakes, towns and peaks, cut into 10°×10° tiles (~11 MB for the whole world; a region loads only the tiles it touches). |
| `tools/build_static_data.py` | Rebuilds `data/ne/` from the source datasets. |

## Features

- **Terrain:** coastlines and lakes from OpenStreetMap tiles (bundled lake outlines as a fallback); hills, mountains and peaks from Terrarium elevation tiles (measured relative to the region's lowlands).
- **Roads and rivers:** from the bundled Natural Earth data, so they load in a fraction of a second. Road detail follows frame width: major highways only from 150 km, plus secondary highways from 50 km, all mapped roads below that.
- **Towns:** Natural Earth cities (with populations) and GeoNames towns over 1,000 people, ranked and spaced out. The biggest cities take 2 squares. When the bundled towns are thin or the frame is zoomed in, OpenStreetMap is asked for villages and neighborhoods, with an 8–15 second limit.
- **Landmarks:** bundled mountain peaks and named lakes, plus OSM parks and attractions when available.
- **Routes:** a minimum spanning tree plus optional shortcuts. Each route is pathed with A* that prefers real roads, avoids mountains, can cross water (sea routes) and penalises turns. Numbered from Route 201 outward from the starting town.
- **Emerald-style cursor:** D-pad or arrow keys, with a pop-up showing the name of the square under the cursor.
- **Editing:** move, add, delete and link towns; paint land, water and mountains; rename, resize and rotate cities.
- **Export:** a 4× PNG, and JSON with a 28×15 `MAPSEC_*` layout, terrain sub-grid, towns and routes.

## Usage

1. Open the site (https://ajdur96.github.io/poke-region-map/), or run `python -m http.server` in this folder and open `http://localhost:8000`. Opening the file directly won't load the bundled data or the map tiles.
2. Search or pan so the dashed 28×15 frame covers your region.
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
