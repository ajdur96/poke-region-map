# Template atlas — coverage report (Emerald + FireRed/LeafGreen)

Source: 34 Emerald routes (Route101–134) and 44 FireRed/LeafGreen outdoor maps (Routes 1–25, Viridian Forest, Sevii Islands). Classes: G grass · H tall grass · P path (narrow strip) · D sand / bare ground (broad, by water, or rock tops) · Q shallow water (walkable) · T tree · W water · C rock · cliff by facing v south face, ^ north rim, > east side, < west side, K corner/end · S stairs · s/e/w ledges.

## Templates by size

| Size | Blocks seen | Rejected (man-made / off-colour) | Distinct templates | Used once |
|---|---|---|---|---|
| 4×4 | 40841 | 12008 | 9723 | 8219 |
| 8×8 | 9194 | 4827 | 3147 | 3066 |
| 12×8 | 8296 | 5059 | 2522 | 2483 |
| 8×12 | 8173 | 5027 | 2449 | 2415 |
| 12×12 | 7353 | 5132 | 1827 | 1816 |

## 4×4 cells by base mass and biome

| Base mass | Templates | Biomes (template count) |
|---|---|---|
| meadow | 3812 | temperate 1114, jungle 692, forest 554, desert/plains 535, island 529, coast 410, ash 182, mountain 125, volcanic 72 |
| rock | 2301 | tropical 608, island 464, desert/plains 373, temperate 351, jungle 194, coast 158, volcanic 148, ash 141, mountain 130, sea 70, forest 9 |
| water | 1699 | tropical 824, coast 283, sea 263, island 241, desert/plains 168, jungle 122, temperate 117, ash 62, forest 14, mountain 5 |
| forest | 1077 | jungle 318, temperate 235, forest 193, coast 172, desert/plains 143, island 98, volcanic 77, ash 71, mountain 13 |
| sand | 834 | desert/plains 193, coast 167, temperate 160, island 149, tropical 113, ash 56, jungle 44, volcanic 20, mountain 19, sea 9 |

## 4×4 cells by game

Emerald only 5922 · FRLG only 3264 · found in both 537

## Coverage of the cell types the planner needs (4×4)

| Cell type | Templates | Uses (Emerald + FRLG) | From FRLG | Status |
|---|---|---|---|---|
| forest interior | 1 | 1802 | 1 | thin |
| meadow (no path, no trees) | 368 | 922 | 225 | ok |
| tall-grass field | 873 | 1644 | 543 | ok |
| water interior | 1 | 8118 | 1 | thin |
| forest edge (forest + meadow) | 994 | 2314 | 377 | ok |
| shore (water + land) | 2841 | 4871 | 625 | ok |
| sand / beach | 817 | 1413 | 373 | ok |
| path straight N–S | 18 | 53 | 12 | ok |
| path straight E–W | 27 | 63 | 17 | ok |
| path turn N–E | 90 | 93 | 51 | ok |
| path turn E–S | 90 | 94 | 39 | ok |
| path turn S–W | 89 | 96 | 50 | ok |
| path turn N–W | 112 | 121 | 59 | ok |
| path fork N–E–S | 67 | 134 | 31 | ok |
| path fork E–S–W | 132 | 200 | 49 | ok |
| path fork N–S–W | 78 | 124 | 35 | ok |
| path fork N–E–W | 124 | 214 | 50 | ok |
| path crossing | 79 | 90 | 29 | ok |
| cliff south face | 1741 | 2095 | 487 | ok |
| cliff north rim | 1858 | 2384 | 648 | ok |
| cliff east side | 1811 | 2139 | 611 | ok |
| cliff west side | 1804 | 2139 | 567 | ok |
| cliff corner | 3033 | 3360 | 923 | ok |
| stairs | 147 | 147 | 0 | ok |
| ledge (south) | 831 | 1169 | 527 | ok |
| ledge (east/west) | 275 | 297 | 65 | ok |

**Reading this:** most templates occur once (exact class grids rarely repeat), so the planner must match by edge sockets and cell type, not by exact grid. Rejected blocks contain man-made or off-colour pieces (houses, signs, fences, docks, special tiles); these become anchored details later rather than templates.

Distinct 4-tile edge sockets: 2808 (top 10: `WWWW`×2456, `GGGG`×2295, `TTTT`×1684, `CCCC`×1425, `DDDD`×1176, `HHHH`×1080, `PPPP`×449, `GGTT`×421, `TTGG`×361, `TGGG`×356)

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
- 12×12 chunks from FRLG (real tiles): `real_chunks_12x12_frlg.png`
- 12×12 chunks (real tiles): `real_chunks_12x12.png`
- 8×8 chunks with the most going on: `contact_chunks_8x8.png`
- 12×12 chunks with the most going on: `contact_chunks_12x12.png`
