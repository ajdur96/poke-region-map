// Headless tests for overworldGen.js on a synthetic 3×3 window.
// Usage: node overworld/testOverworld.js [outDir]
// Checks: determinism, window independence, seam contracts, reachability; writes preview images as raw RGBA + JSON.
'use strict';
const fs = require('fs'), path = require('path');
const OG = require('./overworldGen.js');

const outDir = process.argv[2] || path.join(require('os').tmpdir(), 'overworldTest');
fs.mkdirSync(outDir, { recursive:true });

// Synthetic 5×5-square region (sub = 4 → 20×20 sub-cells), loosely Arlington-like:
// forest in the west, grassland/cropland in the middle, a river running north–south, hills and a mountain in the east,
// a lake in the south-east, built-up land in the north.
function makeRegion(){
  const gridW = 5, gridH = 5, sub = 4, SW = gridW*sub, SH = gridH*sub;
  const terrain = new Uint8Array(SW*SH).fill(1), cover = new Uint8Array(SW*SH), river = new Uint8Array(SW*SH), lake = new Uint8Array(SW*SH);
  const elev = new Float32Array(SW*SH);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++){
    const i = y*SW + x;
    elev[i] = 50 + x*12 + Math.sin(y/3)*10;
    if (x < 7) cover[i] = 1;                       // forest
    else if (x < 12) cover[i] = (y % 8 < 4) ? 0 : 8; // grassland / cropland bands
    else cover[i] = 5;                             // shrubland
    if (y < 4 && x >= 6 && x < 14) cover[i] = 9;   // built-up
    if (x >= 15 && y >= 3 && y < 9){ terrain[i] = 2; elev[i] += 150; }  // hills
    if (x >= 16 && y >= 5 && y < 8){ terrain[i] = 3; elev[i] += 250; }  // mountain
    if (x >= 13 && x < 16 && y >= 14 && y < 18){ terrain[i] = 0; lake[i] = 1; }  // lake
  }
  for (let y = 0; y < SH; y++){ const x = 10 + Math.round(Math.sin(y/4)*1.5); river[y*SW + x] = 1; }  // meandering river
  // Route links: a north–south route through column 2 with a branch east at row 2 (a 3-port junction square),
  // and a branch west at row 1.
  const links = [];
  const L = (ax, ay, bx, by) => links.push({ a:{ x:ax, y:ay }, b:{ x:bx, y:by } });
  L(2, 0, 2, 1); L(2, 1, 2, 2); L(2, 2, 2, 3); L(2, 3, 2, 4);
  L(2, 2, 3, 2); L(3, 2, 4, 2);
  L(1, 1, 2, 1);
  // A real road: runs down through x≈2.6 and bends east at y≈2.5
  const roads = [{ w:2.5, pts:[{ x:2.62, y:0 }, { x:2.58, y:1.2 }, { x:2.55, y:2.45 }, { x:3.4, y:2.5 }, { x:5, y:2.55 }] },
                 { w:1.5, pts:[{ x:2.55, y:2.45 }, { x:2.5, y:3.6 }, { x:2.45, y:5 }] }];
  return { gridW, gridH, sub, terrain, cover, river, lake, elev, links, roads, kmPerSquare:2 };
}

const region = makeRegion();

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log((cond ? 'PASS ' : 'FAIL ') + msg); };

// composition step 2: region-wide mass plan — deterministic, whole region, coherent masses
{
  const p1 = OG.planMasses({ ...region, seed:777, N:36 }), p2 = OG.planMasses({ ...region, seed:777, N:36 });
  check(p1.CW === region.gridW*9 && p1.CH === region.gridH*9, `mass plan covers the whole region (${p1.CW}×${p1.CH} cells)`);
  check(p1.mass.every((v, k) => v === p2.mass[k]), 'mass plan is deterministic');
  check(p1.stats.edgeContinuity > 0.8, `masses continue across map edges (${Math.round(p1.stats.edgeContinuity*100)}%)`);
  const small = Object.entries(p1.stats.medianPatchCells).filter(([n, v]) => n !== 'water' && v > 0 && v < 8);
  check(!small.length, 'no mass made of fragments below the minimum size');
}
const digest = res => res.squares.map(s => `${s.x},${s.y}:` + OG.hash32(...s.tiles)).join('|');

for (const [N, block] of [[36, 4], [36, 3]]){
  const base = { ...region, seed:12345, N, terraceBlock:block, window:{ x0:1, y0:1, w:3, h:3 } };
  const t0 = Date.now(); const res = OG.generate(base); const ms = Date.now() - t0;
  const res2 = OG.generate(base);
  console.log(`\n== N=${N}: ${res.squares.length} squares, ${res.contracts.length} contracts, ${ms} ms`);
  console.log(JSON.stringify(res.report, null, 1));
  for (const s of res.squares) if (s.log.length) console.log(`  square ${s.x},${s.y}: ${s.log.join('; ')}`);
  for (const k of res.contracts) console.log(`  contract ${k.key} pos ${k.pos} path ${k.path} verge ${k.verge} (${k.source})${k.notes.length ? ' — ' + [...new Set(k.notes)].join('; ') : ''}`);
  check(digest(res) === digest(res2), `N=${N}: same seed gives identical maps`);
  // window independence: the centre square must be identical when generated in a shifted window
  const shifted = OG.generate({ ...base, window:{ x0:2, y0:2, w:3, h:3 } });
  const a = res.squares.find(s => s.x === 2 && s.y === 2), b = shifted.squares.find(s => s.x === 2 && s.y === 2);
  check(a && b && OG.hash32(...a.tiles) === OG.hash32(...b.tiles), `N=${N}: centre square identical in a shifted window`);
  check(res.report.seamFailures.length === 0, `N=${N}: no seam failures`);
  check(res.report.reciprocityFailures.length === 0, `N=${N}: every connection has a return connection`);
  check(res.report.unreachable.length === 0, `N=${N}: every port and junction reachable`);
  check(res.report.components === 1, `N=${N}: window's map graph is connected`);
  check(res.report.traps === 0, `N=${N}: no ledge traps (everywhere reachable can get back)`);
  check(res.scenery.every(sc => sc.blocked), `N=${N} block ${block}: scenery maps are fully blocked (${res.scenery.length})`);
  check(res.report.hardFailures.length === 0, `N=${N} block ${block}: every square passes every relief check (${res.report.stairFlights} flights, ${res.report.flightsPer100}/100 walkable; retries ${res.report.retries.join(' ') || 'none'})${res.report.hardFailures.length ? '\n    ' + res.report.hardFailures.join('\n    ') : ''}`);
  // band rule: inside the 7-tile band, only straight approaches (path/verge/bridge) or base terrain — the band at
  // each port must be exactly the contract width on both sides
  for (const k of res.contracts){
    const A = res.squares.find(s => s.x === k.a.x && s.y === k.a.y), B = res.squares.find(s => s.x === k.b.x && s.y === k.b.y);
    if (!A || !B) continue;
    let same = true;
    for (let d = 0; d < OG.BAND; d++) for (let t = k.pos - k.lo - k.verge; t <= k.pos + k.hi + k.verge; t++){
      const ia = k.horiz ? t*N + (N - 1 - d) : (N - 1 - d)*N + t, ib = k.horiz ? t*N + d : d*N + t;
      const isWay = t => t === OG.TILE.PATH || t === OG.TILE.BRIDGE || t === OG.TILE.STAIRS || t === OG.TILE.SIDE_STAIRS;
      const pa = isWay(A.tiles[ia]), pb = isWay(B.tiles[ib]);
      if (pa !== pb) same = false;
    }
    check(same, `N=${N}: seam approach ${k.key} path tiles mirror exactly across the edge`);
  }
  // different seed → different result
  const other = OG.generate({ ...base, seed:999 });
  check(digest(other) !== digest(res), `N=${N}: a different seed gives a different realization`);

  const img = OG.toRGBA(res, { showSeams:true });
  fs.writeFileSync(path.join(outDir, `preview_${N}_${block}.rgba`), Buffer.from(img.data.buffer));
  fs.writeFileSync(path.join(outDir, `preview_${N}_${block}.json`), JSON.stringify({ width:img.width, height:img.height, report:res.report }, null, 1));
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exitCode = failures.length ? 1 : 0;
