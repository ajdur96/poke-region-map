# Template atlas — coverage report (Emerald routes)

Source: 34 Emerald routes (Route101–134). Classes: G grass · H tall grass · P path (narrow strip) · D sand / bare ground (broad, by water, or rock tops) · Q shallow water (walkable) · T tree · W water · C rock · cliff by facing v south face, ^ north rim, > east side, < west side, K corner/end · S stairs · s/e/w ledges.

## Templates by size

| Size | Blocks seen | Rejected (man-made / off-colour) | Distinct templates | Used once |
|---|---|---|---|---|
| 4×4 | 23637 | 7225 | 6459 | 5564 |
| 8×8 | 5417 | 2934 | 1876 | 1846 |
| 12×8 | 5011 | 3149 | 1510 | 1491 |
| 8×12 | 4889 | 3101 | 1446 | 1430 |
| 12×12 | 4517 | 3238 | 1089 | 1082 |

## 4×4 cells by base mass and biome

| Base mass | Templates | Biomes (template count) |
|---|---|---|
| meadow | 2074 | jungle 692, desert/plains 535, temperate 454, coast 294, ash 182, volcanic 72 |
| rock | 1629 | tropical 608, desert/plains 373, jungle 194, volcanic 148, ash 141, coast 137, temperate 80, sea 70 |
| water | 1479 | tropical 824, sea 263, coast 236, desert/plains 168, jungle 122, ash 62, temperate 53 |
| forest | 764 | jungle 318, temperate 155, desert/plains 143, coast 137, volcanic 77, ash 71 |
| sand | 513 | desert/plains 193, tropical 113, coast 81, ash 56, jungle 44, temperate 39, volcanic 20, sea 9 |

## Coverage of the cell types the planner needs (4×4)

| Cell type | Templates | Uses in Emerald | Status |
|---|---|---|---|
| forest interior | 1 | 664 | thin |
| meadow (no path, no trees) | 193 | 406 | ok |
| tall-grass field | 398 | 601 | ok |
| water interior | 1 | 4762 | thin |
| forest edge (forest + meadow) | 712 | 1231 | ok |
| shore (water + land) | 2362 | 3668 | ok |
| sand / beach | 489 | 819 | ok |
| path straight N–S | 6 | 7 | ok |
| path straight E–W | 10 | 20 | ok |
| path turn N–E | 40 | 42 | ok |
| path turn E–S | 52 | 53 | ok |
| path turn S–W | 43 | 45 | ok |
| path turn N–W | 56 | 59 | ok |
| path fork N–E–S | 40 | 54 | ok |
| path fork E–S–W | 90 | 126 | ok |
| path fork N–S–W | 44 | 55 | ok |
| path fork N–E–W | 81 | 113 | ok |
| path crossing | 52 | 60 | ok |
| cliff south face | 1293 | 1398 | ok |
| cliff north rim | 1261 | 1451 | ok |
| cliff east side | 1239 | 1381 | ok |
| cliff west side | 1298 | 1462 | ok |
| cliff corner | 2171 | 2374 | ok |
| stairs | 147 | 147 | ok |
| ledge (south) | 334 | 371 | ok |
| ledge (east/west) | 213 | 232 | ok |

**Reading this:** most templates occur once (exact class grids rarely repeat), so the planner must match by edge sockets and cell type, not by exact grid. Rejected blocks contain man-made or off-colour pieces (houses, signs, fences, docks, special tiles); these become anchored details later rather than templates.

Distinct 4-tile edge sockets: 2281 (top 10: `WWWW`×2064, `GGGG`×1364, `TTTT`×1232, `CCCC`×857, `DDDD`×733, `HHHH`×560, `QQQQ`×333, `GGTT`×317, `PPPP`×295, `TTGG`×263)

## Contact sheets

- forest edge (forest + meadow): `contact_forest_edge_forest_meadow.png`
- shore (water + land): `contact_shore_water_land.png`
- path straight N–S: `contact_path_straight_n_s.png`
- path turn N–E: `contact_path_turn_n_e.png`
- cliff south face: `contact_cliff_south_face.png`
- tall-grass field: `contact_tall_grass_field.png`
- path turn N–E (real tiles): `real_path_turn_n_e.png`
- cliff south face (real tiles): `real_cliff_south_face.png`
- forest edge (forest + meadow) (real tiles): `real_forest_edge_forest_meadow.png`
- 12×12 chunks (real tiles): `real_chunks_12x12.png`
- 8×8 chunks with the most going on: `contact_chunks_8x8.png`
- 12×12 chunks with the most going on: `contact_chunks_12x12.png`
