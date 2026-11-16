# poke-region-map

A prototype for a Pokémon Emerald (pokeemerald decomp) ROM hack: pick any real-world area and turn it into a Gen 4-style Town Map laid out on Emerald's 28×15 region-map grid.

## Files

| File | What it is |
|---|---|
| `regionMapForge.html` | Full version. Frame a real place on a live map and forge a region from real data. Open it in a desktop browser. |
| `demo/index.html` | Mobile demo. Generates a fictional region (no live data needed), with the same editor, cursor and pop-up. |

## Features

- **Terrain:** coastlines, lakes and wide rivers from OpenStreetMap tiles; hills, mountains and peaks from Terrarium elevation tiles (measured relative to the region's lowlands).
- **Rivers:** named OSM rivers drawn as thin lines; short unnamed streams are skipped.
- **Towns:** real cities and towns from OpenStreetMap, ranked by population and spaced out. The biggest cities take 2 squares.
- **Routes:** a minimum spanning tree plus optional shortcuts. Each route is pathed with A* that prefers real roads, avoids mountains, can cross water (sea routes) and penalises turns. Numbered from Route 201 outward from the starting town.
- **Emerald-style cursor:** D-pad or arrow keys, with a pop-up showing the name of the square under the cursor.
- **Editing:** move, add, delete and link towns; paint land, water and mountains; rename, resize and rotate cities.
- **Export:** a 4× PNG, and JSON with a 28×15 `MAPSEC_*` layout, terrain sub-grid, towns and routes.

## Usage

1. Open `regionMapForge.html` in a browser (it needs internet access).
2. Search or pan so the dashed 28×15 frame covers your region.
3. Set the number of towns and extra routes, then press **Forge Region**.
4. Edit as needed, then export.

## Data sources

- Map tiles and towns/roads/rivers: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via the Overpass API
- Elevation: [Terrarium tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data)
- Place search: Nominatim

## Status

Prototype. The next step is converting the exported layout into pokeemerald's region-map files.
