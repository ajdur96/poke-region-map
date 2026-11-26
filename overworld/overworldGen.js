/* Region Map Forge — overworld map generator (prototype "ow-proto-2").
 *
 * Turns region-map squares into walkable tile maps, one map per square, joined by seamless connections.
 * Design and decisions: the project's "Overworld Maps — Decisions Log" (claude/overworld-map-decisions.md).
 *
 * Stages:
 *   1. Base terrain for the whole window (plus a margin), keyed by global tile position, so the seam strips and
 *      corner blocks on both sides of every edge come from one region-level raster and always match.
 *      Each land cover class has a wall density (forest mostly trees with glades, grassland with scattered clumps,
 *      rocky land with outcrops), so most land stays open to explore.
 *   2. Water is structural: lakes/sea from the terrain grid and 2-tile river channels.
 *   3. Cellular automata (8 neighbours; wall opens below 4 wall neighbours, open walls at 5 or more; 3 passes).
 *   4. Relief (new in proto-2): elevation becomes terrace levels; level boundaries become cliffs, some 1-level
 *      cliffs facing south/east/west become one-way ledges, and some cliff tiles become stairs (side stairs on
 *      east/west-facing cliffs) so plateaus can be explored.
 *   5. Edge contracts: one per linked edge (port position, path width, verge width), shared by both squares.
 *   6. Paths: straight approaches through the 7-tile seam band; inside, a winding least-cost path through 1–3
 *      seeded waypoints drawn to interesting spots (water's edge, clearings, high ground); path + verge widths from
 *      local land cover (Option C); bridges over rivers; stairs where the path climbs a cliff.
 *   7. Validation and repair: reachability that understands one-way ledges (every port must reach every other and
 *      come back; any ledge that would trap the player becomes stairs), A* repair, a guaranteed fallback,
 *      region-wide checks, and an off-path exploration share.
 *
 * Tiles are abstract classes (see TILE). Picking real metatiles comes in a later step.
 * Pure functions, no DOM: runs in the browser (window.OverworldGen) and in Node (module.exports) for tests.
 */
(function (root) {
'use strict';

const VERSION = 'ow-proto-2';
const BAND = 7;                                    // seam band depth in metatiles (pokeemerald MAP_OFFSET = 7)
const PAD = 8;                                     // raster margin around the window so results don't depend on it

// ----- Tile classes -----
const TILE = { OPEN:0, PATH:1, VERGE:2, TREE:3, ROCK:4, WATER:5, BRIDGE:6, CLIFF:7,
               LEDGE_S:8, LEDGE_E:9, LEDGE_W:10, STAIRS:11, SIDE_STAIRS:12 };
const NTILE = 13;
const WALKABLE = [1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1];
const PASSABLE = [1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1];   // walkable, or crossable with Surf (water)
const LEDGE_DIR = { [TILE.LEDGE_S]:[0, 1], [TILE.LEDGE_E]:[1, 0], [TILE.LEDGE_W]:[-1, 0] };
const isWall = t => t === TILE.TREE || t === TILE.ROCK;
const isCliffish = t => t === TILE.CLIFF || t === TILE.LEDGE_S || t === TILE.LEDGE_E || t === TILE.LEDGE_W;
const isPathish = t => t === TILE.PATH || t === TILE.BRIDGE || t === TILE.STAIRS || t === TILE.SIDE_STAIRS;
const FACE = { N:0, S:1, E:2, W:3, NONE:255 };    // direction a cliff faces (toward the lower side)

// ----- Land cover classes (0–9 are the Forge's C codes; 10–11 come from its terrain grid) -----
const CLS = { GRASS:0, FOREST:1, WETLAND:2, DESERT:3, SNOW:4, DRY:5, MANGROVE:6, TUNDRA:7, CROP:8, URBAN:9, ROCKY:10, WATER:11 };
const NCLS = 12;
// path / verge widths (Option C, decided 2026-11-25), path cost, wall density and wall type.
// Starting values (Claude's judgment); to tune in testing.
const PROFILE = [
  { name:'grassland', path:6, verge:4, cost:1.0, wallFrac:0.10, wall:'TREE' },
  { name:'forest',    path:3, verge:1, cost:2.5, wallFrac:0.70, wall:'TREE' },
  { name:'wetland',   path:3, verge:1, cost:2.0, wallFrac:0.15, wall:'TREE' },
  { name:'desert',    path:5, verge:3, cost:1.3, wallFrac:0.10, wall:'ROCK' },
  { name:'snow',      path:4, verge:2, cost:1.5, wallFrac:0.12, wall:'ROCK' },
  { name:'shrubland', path:4, verge:2, cost:1.2, wallFrac:0.22, wall:'TREE' },
  { name:'mangrove',  path:3, verge:1, cost:3.0, wallFrac:0.65, wall:'TREE' },
  { name:'tundra',    path:5, verge:3, cost:1.2, wallFrac:0.12, wall:'ROCK' },
  { name:'cropland',  path:5, verge:3, cost:1.1, wallFrac:0.04, wall:'TREE' },
  { name:'built-up',  path:4, verge:1, cost:1.0, wallFrac:0.10, wall:'TREE' },
  { name:'rocky',     path:3, verge:1, cost:3.0, wallFrac:0.42, wall:'ROCK' },
  { name:'water',     path:3, verge:1, cost:Infinity, wallFrac:0, wall:null }
];
const LIMITS = { pathMin:3, pathMax:6, vergeMin:1, vergeMax:4 };
const COST = { roadFactor:0.3, slopeK:2, noiseM:1.5, noiseScale:4, turn:0.1, reuse:2, cliff:5, riverCrossing:8, surf:2, peak:12,
               repairWall:6, repairRiver:10 };
const RELIEF = { minStepM:12, stepDivisor:4, compress:3, noise:0.45, ledgeChance:0.35, stairChance:0.05, chunk:8 };
const WAYPOINTS = { min:1, max:3, candidates:48, spacing:6 };
const FORGE_T = { SEA:0, LAND:1, HILL:2, MTN:3, PEAK:4 };

// ----- Hashing and seeds (never Math.random) -----
function hash32(...vals){
  let h = 0x811c9dc5 | 0;
  for (const v of vals){
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  }
  return h >>> 0;
}
function strHash(s){ let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const rand01 = (...vals) => hash32(...vals) / 4294967296;
function mulberry32(a){
  return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function makeSeeds(regionSeed, version){
  const sRegion = hash32(regionSeed >>> 0, strHash(version));
  return {
    region: sRegion,
    square: (x, y) => hash32(sRegion, strHash('square'), x, y),
    edge: (idA, idB) => hash32(sRegion, strHash('edge'), Math.min(idA, idB), Math.max(idA, idB)),
    layer: (name) => hash32(sRegion, strHash(name)),
    attempt: (sSquare, n) => hash32(sSquare, strHash('attempt'), n)
  };
}
// Smooth value noise (0–1) at a scale of `L` tiles, keyed by global tile position.
function smoothNoise(seed, gx, gy, L){
  const fx = gx / L, fy = gy / L, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const sx = tx*tx*(3 - 2*tx), sy = ty*ty*(3 - 2*ty);
  const a = rand01(seed, x0, y0), b = rand01(seed, x0 + 1, y0), c = rand01(seed, x0, y0 + 1), d = rand01(seed, x0 + 1, y0 + 1);
  return (a*(1 - sx) + b*sx)*(1 - sy) + (c*(1 - sx) + d*sx)*sy;
}

// ----- Binary heap -----
class MinHeap {
  constructor(){ this.k = []; this.p = []; this.seq = []; this.n = 0; this.c = 0; }
  get size(){ return this.n; }
  push(key, pri){
    let i = this.n++; this.k[i] = key; this.p[i] = pri; this.seq[i] = this.c++;
    while (i > 0){ const j = (i - 1) >> 1; if (this.less(j, i)) break; this.swap(i, j); i = j; }
  }
  pop(){
    const top = this.k[0]; this.n--;
    if (this.n > 0){ this.k[0] = this.k[this.n]; this.p[0] = this.p[this.n]; this.seq[0] = this.seq[this.n]; let i = 0;
      for (;;){ const l = 2*i + 1, r = l + 1; let m = i;
        if (l < this.n && this.less(l, m)) m = l; if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break; this.swap(i, m); i = m; } }
    return top;
  }
  less(a, b){ return this.p[a] < this.p[b] || (this.p[a] === this.p[b] && this.seq[a] < this.seq[b]); }
  swap(a, b){ [this.k[a], this.k[b]] = [this.k[b], this.k[a]]; [this.p[a], this.p[b]] = [this.p[b], this.p[a]]; [this.seq[a], this.seq[b]] = [this.seq[b], this.seq[a]]; }
}

// ----- Input sampling -----
// The region data is a sub-grid (`sub` cells per square side). Each tile blends the four nearest sub-cells.
function makeSampler(inp){
  const SW = inp.gridW*inp.sub, SH = inp.gridH*inp.sub, N = inp.N;
  const subClass = new Uint8Array(SW*SH), peak = new Uint8Array(SW*SH);
  const PSEUDO_ELEV = [0, 20, 150, 400, 700];      // used only when the region has no elevation data
  const elevSub = new Float32Array(SW*SH);
  for (let i = 0; i < SW*SH; i++){
    const t = inp.terrain[i];
    if (t === FORGE_T.SEA || (inp.lake && inp.lake[i])) subClass[i] = CLS.WATER;
    else if (t === FORGE_T.MTN || t === FORGE_T.PEAK) { subClass[i] = CLS.ROCKY; peak[i] = t === FORGE_T.PEAK ? 1 : 0; }
    else subClass[i] = Math.min(inp.cover ? inp.cover[i] : 0, 9);
    elevSub[i] = inp.elev ? (inp.elev[i] || 0) : PSEUDO_ELEV[t] || 0;
  }
  const clampS = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;
  const weights = (gx, gy) => {                    // four sub-cells and their bilinear weights
    const u = (gx + 0.5)/N*inp.sub - 0.5, v = (gy + 0.5)/N*inp.sub - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), tx = u - x0, ty = v - y0, out = [];
    for (const [dx, dy, w] of [[0, 0, (1 - tx)*(1 - ty)], [1, 0, tx*(1 - ty)], [0, 1, (1 - tx)*ty], [1, 1, tx*ty]])
      out.push([clampS(y0 + dy, SH - 1)*SW + clampS(x0 + dx, SW - 1), w]);
    return out;
  };
  // terrace step height for the whole region: a quarter of the 75th-percentile relief inside a square
  const reliefs = [];
  for (let sy = 0; sy < inp.gridH; sy++) for (let sx = 0; sx < inp.gridW; sx++){
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < inp.sub; y++) for (let x = 0; x < inp.sub; x++){
      const i = (sy*inp.sub + y)*SW + sx*inp.sub + x; if (subClass[i] === CLS.WATER) continue;
      lo = Math.min(lo, elevSub[i]); hi = Math.max(hi, elevSub[i]);
    }
    if (hi > lo) reliefs.push(hi - lo);
  }
  reliefs.sort((a, b) => a - b);
  const p75 = reliefs.length ? reliefs[Math.floor(reliefs.length*0.75)] : 0;
  const stepM = Math.max(RELIEF.minStepM, p75/RELIEF.stepDivisor);
  let elevMin = Infinity; for (let i = 0; i < SW*SH; i++) if (subClass[i] !== CLS.WATER) elevMin = Math.min(elevMin, elevSub[i]);
  if (!isFinite(elevMin)) elevMin = 0;
  return {
    SW, SH, subClass, peak, stepM, elevMin,
    shares(gx, gy){ const s = new Float64Array(NCLS); for (const [i, w] of weights(gx, gy)) s[subClass[i]] += w; return s; },
    elev(gx, gy){ let e = 0; for (const [i, w] of weights(gx, gy)) e += w*elevSub[i]; return e; },
    isPeak(gx, gy){ const sx = Math.floor(gx/N*inp.sub), sy = Math.floor(gy/N*inp.sub);
      return sx >= 0 && sy >= 0 && sx < SW && sy < SH ? peak[sy*SW + sx] === 1 : false; }
  };
}
// Path and verge widths from cover shares (water ignored), before clamping.
function widthsFromShares(s){
  let land = 0, p = 0, v = 0;
  for (let c = 0; c < NCLS; c++){ if (c === CLS.WATER || !s[c]) continue; land += s[c]; p += s[c]*PROFILE[c].path; v += s[c]*PROFILE[c].verge; }
  if (land <= 0) return { p:LIMITS.pathMin, v:LIMITS.vergeMin };
  return { p:p/land, v:v/land };
}
const clampWidth = (p, v) => ({
  p:Math.min(LIMITS.pathMax, Math.max(LIMITS.pathMin, Math.round(p))),
  v:Math.min(LIMITS.vergeMax, Math.max(LIMITS.vergeMin, Math.round(v)))
});
function dominantLand(s){ let best = CLS.GRASS, bw = -1; for (let c = 0; c < NCLS; c++) if (c !== CLS.WATER && s[c] > bw){ bw = s[c]; best = c; } return best; }
const wallTile = c => PROFILE[c].wall === 'ROCK' ? TILE.ROCK : TILE.TREE;
const stairsFor = face => face === FACE.E || face === FACE.W ? TILE.SIDE_STAIRS : TILE.STAIRS;

// ----- Main entry -----
// inp: { seed, N, gridW, gridH, sub, terrain, cover, lake?, river?, elev?, kmPerSquare?, links:[{a:{x,y},b:{x,y}}],
//        active?:[{x,y}], roads?:[{w, pts:[{x,y}]}] (fractional square coords), window?:{x0,y0,w,h} }
function generate(inp){
  const N = inp.N, version = inp.version || VERSION, seeds = makeSeeds(inp.seed || 0, version);
  if (N - 2*BAND < LIMITS.pathMin) throw new Error(`Square size ${N} is too small for a ${BAND}-tile seam band`);
  const win = inp.window || { x0:0, y0:0, w:inp.gridW, h:inp.gridH };
  const sampler = makeSampler(inp);
  const sqId = (x, y) => y*inp.gridW + x;
  const inWin = (x, y) => x >= win.x0 && y >= win.y0 && x < win.x0 + win.w && y < win.y0 + win.h;
  const log = [`terrace step ${sampler.stepM.toFixed(0)} m`];

  // --- Topology: links (deduplicated, orthogonal only) and active squares ---
  const linkMap = new Map(), active = new Map();
  const addActive = (x, y) => { if (x >= 0 && y >= 0 && x < inp.gridW && y < inp.gridH) active.set(sqId(x, y), { x, y }); };
  for (const l of inp.links || []){
    const { a, b } = l; if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) continue;
    const ia = sqId(a.x, a.y), ib = sqId(b.x, b.y), key = Math.min(ia, ib) + ':' + Math.max(ia, ib);
    if (!linkMap.has(key)) linkMap.set(key, { a:ia < ib ? a : b, b:ia < ib ? b : a });
    addActive(a.x, a.y); addActive(b.x, b.y);
  }
  for (const s of inp.active || []) addActive(s.x, s.y);
  const winSquares = [...active.values()].filter(s => inWin(s.x, s.y)).sort((p, q) => sqId(p.x, p.y) - sqId(q.x, q.y));

  // --- 1–4. Region-level raster (window + margin): base terrain, water, cellular automata, relief ---
  const RX0 = win.x0*N - PAD, RY0 = win.y0*N - PAD, RW = win.w*N + 2*PAD, RH = win.h*N + 2*PAD;
  const tiles = new Uint8Array(RW*RH), cls = new Uint8Array(RW*RH), river = new Uint8Array(RW*RH), water = new Uint8Array(RW*RH);
  const lev = new Int16Array(RW*RH), face = new Uint8Array(RW*RH).fill(FACE.NONE);
  const ri = (gx, gy) => (gy - RY0)*RW + (gx - RX0);
  const inR = (gx, gy) => gx >= RX0 && gy >= RY0 && gx < RX0 + RW && gy < RY0 + RH;
  const sBase = seeds.layer('base'), sBlob = seeds.layer('blob'), sWater = seeds.layer('water'), sWall = seeds.layer('wall');
  const sLev = seeds.layer('levels'), sLedge = seeds.layer('ledges'), sStair = seeds.layer('stairs');
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const gx = RX0 + x, gy = RY0 + y, s = sampler.shares(gx, gy), i = y*RW + x;
    if (s[CLS.WATER] > 0.5 + 0.3*(smoothNoise(sWater, gx, gy, 4) - 0.5)){ water[i] = 1; cls[i] = CLS.WATER; continue; }
    let land = 0; for (let c = 0; c < NCLS; c++) if (c !== CLS.WATER) land += s[c];
    const r = Math.min(0.999, Math.max(0, 0.65*smoothNoise(sBlob, gx, gy, 5) + 0.35*rand01(sBase, gx, gy)))*land;
    let acc = 0, pick = CLS.GRASS;
    for (let c = 0; c < NCLS; c++){ if (c === CLS.WATER) continue; acc += s[c]; if (r < acc){ pick = c; break; } }
    cls[i] = pick;
  }
  // rivers: 2-tile channels joining the centres of neighbouring river sub-cells (and running into lakes/sea)
  if (inp.river){
    const SW = sampler.SW, SH = sampler.SH, sub = inp.sub, cell = N/sub;
    const isRiv = (sx, sy) => sx >= 0 && sy >= 0 && sx < SW && sy < SH && inp.river[sy*SW + sx] && sampler.subClass[sy*SW + sx] !== CLS.WATER;
    const isWat = (sx, sy) => sx >= 0 && sy >= 0 && sx < SW && sy < SH && sampler.subClass[sy*SW + sx] === CLS.WATER;
    const ctr = v => Math.floor((v + 0.5)*cell);
    const mark = (gx, gy) => { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++){ const x = gx + dx, y = gy + dy;
      if (inR(x, y)){ const i = ri(x, y); river[i] = 1; water[i] = 1; cls[i] = CLS.WATER; } } };
    const sx0 = Math.max(0, Math.floor(RX0/cell) - 1), sx1 = Math.min(SW - 1, Math.ceil((RX0 + RW)/cell) + 1);
    const sy0 = Math.max(0, Math.floor(RY0/cell) - 1), sy1 = Math.min(SH - 1, Math.ceil((RY0 + RH)/cell) + 1);
    for (let sy = sy0; sy <= sy1; sy++) for (let sx = sx0; sx <= sx1; sx++){
      if (!isRiv(sx, sy)) continue;
      let linked = 0;
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]){
        const nx = sx + dx, ny = sy + dy;
        if (!isRiv(nx, ny) && !isWat(nx, ny)) continue;
        linked++;
        if ((dx < 0 || dy < 0) && isRiv(nx, ny)) continue;      // draw each river–river link once
        const ax = ctr(sx), ay = ctr(sy), bx = ctr(nx), by = ctr(ny);
        if (ax === bx) for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) mark(ax, y);
        else for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) mark(x, ay);
      }
      for (const dx of [-1, 1]){                                 // diagonal steps: an L-shaped channel
        const nx = sx + dx, ny = sy + 1;
        if (!isRiv(nx, ny) || isRiv(nx, sy) || isRiv(sx, ny)) continue;
        linked++;
        const ax = ctr(sx), ay = ctr(sy), bx = ctr(nx), by = ctr(ny);
        for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) mark(x, ay);
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) mark(bx, y);
      }
      if (!linked){
        let up = false; for (const dx of [-1, 1]) if (isRiv(sx + dx, sy - 1) && !isRiv(sx + dx, sy) && !isRiv(sx, sy - 1)) up = true;
        if (!up) mark(ctr(sx), ctr(sy));                         // isolated river cell: a small pool
      }
    }
  }
  // water smoothing: one majority pass (5 of 9) on lake/sea water only; river channels stay as drawn
  { const copy = water.slice();
    for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++){
      const i = y*RW + x; if (river[i]) continue;
      let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += copy[i + dy*RW + dx];
      const w = n >= 5 ? 1 : 0;
      if (w !== water[i]){ water[i] = w; cls[i] = w ? CLS.WATER : dominantLand(sampler.shares(RX0 + x, RY0 + y)); }
    } }
  // land tiles: each class has its own wall density; smooth noise keeps walls in clumps
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const i = y*RW + x; if (water[i]){ tiles[i] = TILE.WATER; continue; }
    const gx = RX0 + x, gy = RY0 + y, n = 0.75*smoothNoise(sWall, gx, gy, 3) + 0.25*rand01(sWall, gx, gy);
    tiles[i] = n < PROFILE[cls[i]].wallFrac ? wallTile(cls[i]) : TILE.OPEN;
  }
  // cellular automata on land only (walls vs open); water counts as open and is never changed
  for (let it = 0; it < 3; it++){
    const copy = tiles.slice();
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
      const i = y*RW + x; if (copy[i] === TILE.WATER) continue;
      let walls = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= RW || ny >= RH){ walls++; continue; }
        if (isWall(copy[ny*RW + nx])) walls++;
      }
      if (isWall(copy[i]) && walls < 4) tiles[i] = TILE.OPEN;
      else if (!isWall(copy[i]) && walls >= 5) tiles[i] = wallTile(cls[i]);
    }
  }
  // relief: terrace levels from elevation (+ smooth noise so the contours wander), cliffs on level boundaries
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const gx = RX0 + x, gy = RY0 + y;
    const e = sampler.elev(gx, gy) + RELIEF.noise*sampler.stepM*(2*smoothNoise(sLev, gx, gy, 7) - 1);
    // log-compressed so big mountains get a handful of tall terraces rather than dozens of thin ones
    const d = Math.max(0, (e - sampler.elevMin)/sampler.stepM);
    lev[y*RW + x] = Math.floor(RELIEF.compress*Math.log2(1 + d/RELIEF.compress));
  }
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const i = y*RW + x; if (water[i]) continue;
    let best = FACE.NONE, drop = 0;
    for (const [f, dx, dy] of [[FACE.S, 0, 1], [FACE.E, 1, 0], [FACE.W, -1, 0], [FACE.N, 0, -1]]){
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= RW || ny >= RH) continue;
      const j = ny*RW + nx; if (water[j]) continue;
      const d = lev[i] - lev[j]; if (d > 0 && best === FACE.NONE){ best = f; drop = d; }
    }
    if (best === FACE.NONE) continue;
    face[i] = best; tiles[i] = TILE.CLIFF;
    const gx = RX0 + x, gy = RY0 + y, chunk = RELIEF.chunk;
    // one-way ledges on gentle (1-level) cliffs facing south, east or west; chosen per chunk so runs stay whole
    if (drop === 1 && best !== FACE.N && rand01(sLedge, Math.floor(gx/chunk), Math.floor(gy/chunk), best) < RELIEF.ledgeChance)
      tiles[i] = best === FACE.S ? TILE.LEDGE_S : best === FACE.E ? TILE.LEDGE_E : TILE.LEDGE_W;
    else if (rand01(sStair, gx, gy) < RELIEF.stairChance) tiles[i] = stairsFor(best);   // a way up to explore
  }

  // --- 5. Edge contracts ---
  const rng = (s) => mulberry32(s);
  const contracts = [];
  const contractOf = new Map();                    // `${sqId}:${side}` → contract; side 0=E 1=W 2=S 3=N
  const sideWidth = (x, y, side) => {              // widths from the seam-band strip on this square's side of the edge
    const acc = new Float64Array(NCLS);
    for (let d = 0; d < BAND; d += 2) for (let t = 0; t < N; t += 2){
      const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
      const s = sampler.shares(x*N + lx, y*N + ly); for (let c = 0; c < NCLS; c++) acc[c] += s[c];
    }
    const w = widthsFromShares(acc); return clampWidth(w.p, w.v);
  };
  for (const [key, l] of [...linkMap.entries()].sort((p, q) => p[0] < q[0] ? -1 : 1)){
    const a = l.a, b = l.b, horiz = a.y === b.y;           // horiz: a is west of b (shared vertical edge)
    if (!inWin(a.x, a.y) && !inWin(b.x, b.y)) continue;
    const sideA = horiz ? 0 : 2, sideB = horiz ? 1 : 3;
    const wa = sideWidth(a.x, a.y, sideA), wb = sideWidth(b.x, b.y, sideB);
    let p = Math.min(wa.p, wb.p), v = Math.min(wa.v, wb.v);
    const notes = [];
    while (p + 2*v > N - 2*BAND){                          // keep the corridor out of the corner blocks
      if (v > LIMITS.vergeMin) v--; else if (p > LIMITS.pathMin) p--; else break;
      notes.push('narrowed to fit between corner blocks');
    }
    if (p + 2*v > N - 2*BAND) v = 0;
    const lo = (p - 1) >> 1, hi = p - 1 - lo;                // path tiles: [c - lo, c + hi]
    const cMin = BAND + v + lo, cMax = N - 1 - BAND - v - hi;
    let c = null, source = 'seeded';
    const edgeX = horiz ? b.x : null, edgeY = horiz ? null : b.y;
    for (const road of (inp.roads || [])){
      const pts = road.pts;
      for (let k = 0; k < pts.length - 1; k++){
        const p0 = pts[k], p1 = pts[k + 1];
        let t, along;
        if (horiz){ if ((p0.x - edgeX)*(p1.x - edgeX) > 0 || p0.x === p1.x) continue; t = (edgeX - p0.x)/(p1.x - p0.x); along = p0.y + t*(p1.y - p0.y) - a.y; }
        else { if ((p0.y - edgeY)*(p1.y - edgeY) > 0 || p0.y === p1.y) continue; t = (edgeY - p0.y)/(p1.y - p0.y); along = p0.x + t*(p1.x - p0.x) - a.x; }
        if (t < 0 || t > 1 || along < 0 || along >= 1) continue;
        const cand = Math.floor(along*N), score = (road.w || 1)*100 - Math.abs(cand - N/2);
        if (c === null || score > c.score) c = { pos:cand, score };
      }
    }
    if (c !== null){ c = c.pos; source = 'road'; }
    else { const r = rng(seeds.edge(sqId(a.x, a.y), sqId(b.x, b.y))); c = Math.round(N/2 - 0.5 + (r() + r() - 1)*(cMax - cMin)/2*0.6); }
    let clamped = Math.min(cMax, Math.max(cMin, c));
    if (clamped !== c) notes.push(`port moved ${c} → ${clamped} to stay clear of corners`);
    const approachCells = (pos, fn) => {
      for (const [sq, side] of [[a, sideA], [b, sideB]]) for (let d = 0; d <= BAND; d++) for (let t = pos - lo; t <= pos + hi; t++){
        const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
        const gx = sq.x*N + lx, gy = sq.y*N + ly; if (inR(gx, gy) && fn(ri(gx, gy))) return true;
      }
      return false;
    };
    const lakeAt = pos => approachCells(pos, i => water[i] && !river[i]);
    if (source === 'seeded' && lakeAt(clamped)){
      for (let off = 1; off <= cMax - cMin; off++){
        const cand = [clamped - off, clamped + off].find(q => q >= cMin && q <= cMax && !lakeAt(q));
        if (cand !== undefined){ notes.push(`port moved ${clamped} → ${cand} to keep the approach on dry land`); clamped = cand; break; }
      }
    }
    let lo2 = lo, hi2 = hi;
    const bridge = approachCells(clamped, i => river[i] === 1), otherWater = approachCells(clamped, i => water[i] && !river[i]);
    if (bridge && p > 3){ p = 3; lo2 = 1; hi2 = 1; notes.push('river in the approach: path narrowed to the 3-wide bridge'); }
    if (otherWater) notes.push('lake or sea water in the approach (crossed by Surf)');
    const k = { id:contracts.length, key, a, b, horiz, pos:clamped, lo:lo2, hi:hi2, path:p, verge:v, source, notes, bridge };
    contracts.push(k);
    contractOf.set(sqId(a.x, a.y) + ':' + sideA, k); contractOf.set(sqId(b.x, b.y) + ':' + sideB, k);
  }

  // --- 6. Per-square paths ---
  const roadTilesFor = (sx, sy) => {
    const set = new Set();
    for (const road of (inp.roads || [])){
      const pts = road.pts;
      for (let k = 0; k < pts.length - 1; k++){
        const p0 = pts[k], p1 = pts[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y)*N*2));
        for (let s = 0; s <= steps; s++){
          const lx = Math.floor((p0.x + (p1.x - p0.x)*s/steps - sx)*N), ly = Math.floor((p0.y + (p1.y - p0.y)*s/steps - sy)*N);
          if (lx >= 0 && ly >= 0 && lx < N && ly < N) set.add(ly*N + lx);
        }
      }
    }
    return set;
  };
  const results = [];
  for (const sq of winSquares){
    const sx = sq.x, sy = sq.y, id = sqId(sx, sy), sLog = [];
    const T = new Uint8Array(N*N), K = new Uint8Array(N*N), L = new Int16Array(N*N), F = new Uint8Array(N*N), RV = new Uint8Array(N*N);
    const protectedMask = new Uint8Array(N*N);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ri(sx*N + lx, sy*N + ly), j = ly*N + lx;
      T[j] = tiles[i]; K[j] = cls[i]; L[j] = lev[i]; F[j] = face[i]; RV[j] = river[i];
    }
    const inBand = (lx, ly) => lx < BAND || ly < BAND || lx >= N - BAND || ly >= N - BAND;
    const ports = [];
    for (let side = 0; side < 4; side++){
      const k = contractOf.get(id + ':' + side);
      if (!k){                                     // unlinked edge: a 2-tile wall line
        for (let d = 0; d < 2; d++) for (let t = 0; t < N; t++){
          const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t, i = ly*N + lx;
          if (T[i] === TILE.WATER) continue;
          T[i] = (K[i] === CLS.DESERT || K[i] === CLS.TUNDRA || K[i] === CLS.SNOW || K[i] === CLS.ROCKY) ? TILE.ROCK : TILE.TREE;
        }
        continue;
      }
      const along = (d, a) => side <= 1 ? { lx:side === 0 ? N - 1 - d : d, ly:a } : { lx:a, ly:side === 2 ? N - 1 - d : d };
      for (let d = 0; d <= BAND; d++) for (let a = k.pos - k.lo - k.verge; a <= k.pos + k.hi + k.verge; a++){
        const { lx, ly } = along(d, a), i = ly*N + lx, isPath = a >= k.pos - k.lo && a <= k.pos + k.hi;
        if (T[i] === TILE.WATER){ if (isPath && a >= k.pos - 1 && a <= k.pos + 1 && RV[i]) T[i] = TILE.BRIDGE; }
        else if (isCliffish(T[i]) || T[i] === TILE.STAIRS || T[i] === TILE.SIDE_STAIRS){ if (isPath) T[i] = stairsFor(F[i]); }
        else T[i] = isPath ? TILE.PATH : TILE.VERGE;
        if (d < BAND) protectedMask[i] = 1;
      }
      ports.push({ side, contract:k.id, pos:k.pos, path:k.path, verge:k.verge, gate:along(BAND, k.pos), edgeTile:along(0, k.pos),
                   neighbour:k.a.x === sx && k.a.y === sy ? k.b : k.a });
    }
    for (let i = 0; i < N*N; i++) if (inBand(i % N, (i/N) | 0)) protectedMask[i] = 1;

    const sSq = seeds.square(sx, sy), sNoise = hash32(sSq, strHash('noise')), sWay = hash32(sSq, strHash('waypoints'));
    const roadTiles = roadTilesFor(sx, sy);
    const mpt = (inp.kmPerSquare || 1)*1000/N;
    const used = new Uint8Array(N*N);
    const tileCost = (lx, ly) => {
      const i = ly*N + lx, gx = sx*N + lx, gy = sy*N + ly;
      if (T[i] === TILE.WATER) return RV[i] ? COST.riverCrossing : COST.surf;
      let c = PROFILE[K[i]].cost;
      if (sampler.isPeak(gx, gy)) c = COST.peak;
      if (isWall(T[i])) c += 1;
      if (isCliffish(T[i])) c += COST.cliff;
      const ex = sampler.elev(gx + 1, gy) - sampler.elev(gx - 1, gy), ey = sampler.elev(gx, gy + 1) - sampler.elev(gx, gy - 1);
      const slope = Math.min(1, Math.hypot(ex, ey)/(2*mpt)/0.3);
      c *= (1 + COST.slopeK*slope)*(1 + COST.noiseM*smoothNoise(sNoise, gx, gy, COST.noiseScale));
      if (roadTiles.has(i)) c *= COST.roadFactor;
      if (used[i]) c *= 1 + COST.reuse;
      return c;
    };
    const lo = BAND, hi = N - 1 - BAND;
    const inInterior = (lx, ly) => lx >= lo && ly >= lo && lx <= hi && ly <= hi;
    const astar = (from, to, costFn) => {
      const NS = N*N*5, g = new Float64Array(NS).fill(Infinity), prev = new Int32Array(NS).fill(-1), closed = new Uint8Array(NS);
      const heap = new MinHeap(), s0 = (from.ly*N + from.lx)*5 + 4; g[s0] = 0; heap.push(s0, 0);
      const goal = to.ly*N + to.lx; let end = -1;
      while (heap.size){
        const s = heap.pop(); if (closed[s]) continue; closed[s] = 1;
        const cell = (s/5) | 0, dir = s % 5; if (cell === goal){ end = s; break; }
        const x = cell % N, y = (cell/N) | 0;
        for (let nd = 0; nd < 4; nd++){
          const nx = x + [1, -1, 0, 0][nd], ny = y + [0, 0, 1, -1][nd];
          if (!inInterior(nx, ny)) continue;
          let c = costFn(nx, ny); if (!isFinite(c)) continue;
          if (dir !== 4 && dir !== nd) c += COST.turn;
          const ns = (ny*N + nx)*5 + nd, ng = g[s] + c;
          if (ng < g[ns]){ g[ns] = ng; prev[ns] = s; heap.push(ns, ng + 0.5*(Math.abs(nx - to.lx) + Math.abs(ny - to.ly))); }
        }
      }
      if (end < 0) return null;
      const out = []; for (let s = end; s !== -1; s = prev[s]){ const cell = (s/5) | 0; out.push({ lx:cell % N, ly:(cell/N) | 0 }); }
      const pts = out.reverse(); return pts.filter((p, i) => i === 0 || p.lx !== pts[i - 1].lx || p.ly !== pts[i - 1].ly);
    };
    // waypoints: seeded interior spots, scored for interest (water's edge, open clearings, high ground) and for pulling
    // the path away from the straight line between its ends
    const interest = (lx, ly) => {
      const i = ly*N + lx; if (!WALKABLE[T[i]]) return -Infinity;
      let waterNear = 0, open = 0, higher = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++){
        const x = lx + dx, y = ly + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue; const j = y*N + x;
        if (T[j] === TILE.WATER) waterNear = 1; else if (WALKABLE[T[j]]) open++;
        if (L[j] > L[i]) higher++;
      }
      return 0.8*waterNear + open/49 + (higher === 0 ? 0.4 : 0);
    };
    const pickWaypoints = (A, B, legSeed) => {
      const r = mulberry32(legSeed), want = WAYPOINTS.min + Math.floor(r()*(WAYPOINTS.max - WAYPOINTS.min + 1));
      const count = roadTiles.size ? Math.min(1, want) : want;      // real roads already shape the route
      const dx = B.lx - A.lx, dy = B.ly - A.ly, len = Math.hypot(dx, dy) || 1, cands = [];
      for (let k2 = 0; k2 < WAYPOINTS.candidates; k2++){
        const lx = lo + Math.floor(r()*(hi - lo + 1)), ly = lo + Math.floor(r()*(hi - lo + 1)), sc = interest(lx, ly);
        if (!isFinite(sc)) continue;
        const off = Math.abs((lx - A.lx)*dy - (ly - A.ly)*dx)/len;       // distance from the straight line
        const t = ((lx - A.lx)*dx + (ly - A.ly)*dy)/(len*len);          // position along it
        if (t < 0.1 || t > 0.9) continue;
        cands.push({ lx, ly, t, score:sc + Math.min(off, 8)/8 + 0.3*r() });
      }
      cands.sort((p, q) => q.score - p.score);
      const chosen = [];
      for (const c2 of cands){ if (chosen.length >= count) break;
        if (chosen.every(o => Math.abs(o.lx - c2.lx) + Math.abs(o.ly - c2.ly) >= WAYPOINTS.spacing)) chosen.push(c2); }
      return chosen.sort((p, q) => p.t - q.t);
    };
    const routeVia = (A, B, legSeed) => {
      const stops = [A, ...pickWaypoints(A, B, legSeed), B], pts = [];
      for (let k2 = 0; k2 < stops.length - 1; k2++){
        const seg = astar(stops[k2], stops[k2 + 1], tileCost); if (!seg) return null;
        for (const q of seg) used[q.ly*N + q.lx] = 1;
        pts.push(...(k2 ? seg.slice(1) : seg));
      }
      return { pts, waypoints:stops.length - 2 };
    };
    // junction: a real road intersection in the interior if there is one, else the centroid of the gates
    let junction = null, junctionSource = null;
    if (ports.length >= 3 || ports.length === 1){
      const gates = ports.map(p => p.gate);
      const cx = Math.round(gates.reduce((s, g) => s + g.lx, 0)/gates.length), cy = Math.round(gates.reduce((s, g) => s + g.ly, 0)/gates.length);
      junction = ports.length === 1 ? { lx:Math.round(N/2), ly:Math.round(N/2) } : { lx:cx, ly:cy };
      junctionSource = ports.length === 1 ? 'dead end (square centre)' : 'centroid of gates';
      if (ports.length >= 3 && roadTiles.size){
        const counts = new Map();
        for (const road of (inp.roads || [])){ const seen = new Set();
          for (let k2 = 0; k2 < road.pts.length - 1; k2++){ const p0 = road.pts[k2], p1 = road.pts[k2 + 1], steps = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y)*N*2));
            for (let s = 0; s <= steps; s++){ const lx = Math.floor((p0.x + (p1.x - p0.x)*s/steps - sx)*N), ly = Math.floor((p0.y + (p1.y - p0.y)*s/steps - sy)*N);
              if (inInterior(lx, ly)) seen.add(ly*N + lx); } }
          for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1); }
        let best = null;
        for (const [t, n] of counts) if (n >= 2){ const lx = t % N, ly = (t/N) | 0, d = Math.abs(lx - cx) + Math.abs(ly - cy);
          if (!best || d < best.d || (d === best.d && t < best.t)) best = { t, d, lx, ly }; }
        if (best){ junction = { lx:best.lx, ly:best.ly }; junctionSource = 'road intersection'; }
      }
      junction.lx = Math.min(hi, Math.max(lo, junction.lx)); junction.ly = Math.min(hi, Math.max(lo, junction.ly));
    }
    const legs = [];
    if (ports.length === 2){ const r = routeVia(ports[0].gate, ports[1].gate, hash32(sWay, 0)); legs.push({ ends:[0, 1], pts:r && r.pts, waypoints:r ? r.waypoints : 0 }); }
    else if (junction) ports.forEach((p, k2) => { const r = routeVia(p.gate, junction, hash32(sWay, k2 + 1));
      legs.push({ ends:[k2, null], pts:r && r.pts, waypoints:r ? r.waypoints : 0 }); });
    const failedLegs = legs.filter(l => !l.pts);
    if (failedLegs.length) sLog.push(`${failedLegs.length} path leg(s) found no route; repair will handle it`);

    // carving: path tiles (stairs where the path meets a cliff, bridges over rivers), verge clears walls around it
    const carveBox = (cx, cy, p, v) => {
      const a = (p - 1) >> 1, b = p - 1 - a;
      for (let dy = -a - v; dy <= b + v; dy++) for (let dx = -a - v; dx <= b + v; dx++){
        const x = cx + dx, y = cy + dy; if (!inInterior(x, y)) continue;
        const i = y*N + x, inPath = dx >= -a && dx <= b && dy >= -a && dy <= b;
        if (T[i] === TILE.WATER){ if (inPath && Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && RV[i]) T[i] = TILE.BRIDGE; continue; }
        if (T[i] === TILE.BRIDGE || T[i] === TILE.STAIRS || T[i] === TILE.SIDE_STAIRS) continue;
        if (isCliffish(T[i])){ if (inPath) T[i] = stairsFor(F[i]); continue; }   // the verge never erases cliffs
        if (inPath) T[i] = TILE.PATH; else if (T[i] !== TILE.PATH) T[i] = TILE.VERGE;
      }
    };
    let waypointCount = 0;
    for (const leg of legs){
      if (!leg.pts) continue;
      waypointCount += leg.waypoints;
      const pts = leg.pts, n = pts.length;
      const raw = pts.map(q => widthsFromShares(sampler.shares(sx*N + q.lx, sy*N + q.ly)));
      const sm = raw.map((_, i) => { let p = 0, v = 0, c = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++){ p += raw[j].p; v += raw[j].v; c++; } return { p:p/c, v:v/c }; });
      const startK = ports[leg.ends[0]], endK = leg.ends[1] !== null ? ports[leg.ends[1]] : null;
      pts.forEach((q, i) => {
        let { p, v } = sm[i];
        const blend = (k2, dist) => { if (k2 && dist < 7){ const u = dist/7; p = k2.path*(1 - u) + p*u; v = k2.verge*(1 - u) + v*u; } };
        blend(startK, i); blend(endK, n - 1 - i);
        const w = clampWidth(p, v); carveBox(q.lx, q.ly, w.p, w.v);
      });
    }

    // --- 7. Reachability with one-way ledges, trap removal, repair ---
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let passable = i => PASSABLE[T[i]] === 1;
    const flood = (start, reverse) => {            // forward: where can I go from start; reverse: who can reach start
      const seen = new Uint8Array(N*N); if (!passable(start)) return seen;
      const q = [start]; seen[start] = 1;
      while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
        for (const [dx, dy] of DIRS){
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const ni = ny*N + nx;
          if (passable(ni)){ if (!seen[ni]){ seen[ni] = 1; q.push(ni); } continue; }
          const ld = LEDGE_DIR[T[ni]];               // a ledge between c and the tile beyond it
          if (!ld) continue;
          const fx = nx + dx, fy = ny + dy; if (fx < 0 || fy < 0 || fx >= N || fy >= N) continue;
          const fi = fy*N + fx; if (!passable(fi) || seen[fi]) continue;
          const jumpsThisWay = ld[0] === dx && ld[1] === dy, jumpsBack = ld[0] === -dx && ld[1] === -dy;
          if ((!reverse && jumpsThisWay) || (reverse && jumpsBack)){ seen[fi] = 1; q.push(fi); }
        }
      }
      return seen;
    };
    const required = ports.map(p => ({ name:`port ${'EWSN'[p.side]}`, i:p.edgeTile.ly*N + p.edgeTile.lx, gate:p.gate }));
    if (junction) required.push({ name:'junction', i:junction.ly*N + junction.lx, gate:junction });
    let repairs = 0, fallback = false, trapFixes = 0;
    const repairCost = (lx, ly) => { const i = ly*N + lx;
      if (T[i] === TILE.WATER) return RV[i] ? COST.repairRiver : COST.surf;
      if (isCliffish(T[i])) return COST.repairWall;
      return isWall(T[i]) ? COST.repairWall*(sampler.isPeak(sx*N + lx, sy*N + ly) ? 2 : 1) : 1; };
    const ok = () => { if (required.length < 2) return true; const fw = flood(required[0].i, false), bw = flood(required[0].i, true);
      return required.every(r => fw[r.i] && bw[r.i]); };
    for (let attempt = 0; attempt < 3 && !ok(); attempt++){
      const fw = flood(required[0].i, false), bw = flood(required[0].i, true);
      for (const m of required.filter(r => !(fw[r.i] && bw[r.i]))){
        let target = null, bd = Infinity;
        for (let i = 0; i < N*N; i++){ if (!(fw[i] && bw[i])) continue; const x = i % N, y = (i/N) | 0; if (!inInterior(x, y)) continue;
          const d = Math.abs(x - m.gate.lx) + Math.abs(y - m.gate.ly); if (d < bd){ bd = d; target = { lx:x, ly:y }; } }
        if (!target) target = required[0].gate;
        const pts = astar(m.gate, target, repairCost);
        if (pts){ for (const q of pts) carveBox(q.lx, q.ly, 3, 0); repairs++; sLog.push(`repair ${repairs}: carved a 3-wide corridor from ${m.name} (${pts.length} tiles)`); }
      }
    }
    if (!ok() && required.length > 1){             // guaranteed fallback: straight corridors through the centre
      fallback = true; const c = { lx:Math.round(N/2), ly:Math.round(N/2) };
      const force = (cx, cy) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){ const x = cx + dx, y = cy + dy;
        if (!inInterior(x, y)) continue; const i = y*N + x;
        if (T[i] === TILE.WATER){ if (RV[i]) T[i] = TILE.BRIDGE; }
        else if (isCliffish(T[i])) T[i] = stairsFor(F[i]); else if (!isPathish(T[i])) T[i] = TILE.PATH; } };
      for (const r of required){ const g = r.gate;
        for (let x = Math.min(g.lx, c.lx); x <= Math.max(g.lx, c.lx); x++) force(x, g.ly);
        for (let y = Math.min(g.ly, c.ly); y <= Math.max(g.ly, c.ly); y++) force(c.lx, y); }
      sLog.push('fallback network used: straight corridors through the square centre');
    }
    // traps: anywhere the player can get to but not get back from (only possible through ledges) — those ledges become stairs
    let fw = required.length ? flood(required[0].i, false) : null, bw = required.length ? flood(required[0].i, true) : null;
    for (let it = 0; fw && it < 12; it++){
      let changed = 0;
      for (let i = 0; i < N*N; i++){
        const ld = LEDGE_DIR[T[i]]; if (!ld) continue;
        const x = i % N, y = (i/N) | 0, fx = x + ld[0], fy = y + ld[1]; if (fx < 0 || fy < 0 || fx >= N || fy >= N) continue;
        const land = fy*N + fx;
        if (fw[land] && !bw[land]){ T[i] = stairsFor(F[i]); changed++; }
      }
      if (!changed) break;
      trapFixes += changed; fw = flood(required[0].i, false); bw = flood(required[0].i, true);
    }
    if (trapFixes) sLog.push(`${trapFixes} ledge tile(s) turned into stairs so nothing traps the player`);
    let traps = 0; if (fw) for (let i = 0; i < N*N; i++) if (fw[i] && !bw[i]) traps++;
    const unreachable = fw ? required.filter(r => !(fw[r.i] && bw[r.i])).map(r => r.name) : [];

    // metrics: Surf needed? share of reachable walkable ground that is off the path
    let needsSurf = false;
    if (required.length > 1){ passable = i => WALKABLE[T[i]] === 1;
      const land = flood(required[0].i, false); needsSurf = required.some(q => !land[q.i]); passable = i => PASSABLE[T[i]] === 1; }
    if (needsSurf) sLog.push('needs Surf: some ports are joined only across water');
    let reach = 0, onPath = 0, ledges = 0, stairs = 0, cliffs = 0, bridges = 0;
    for (let i = 0; i < N*N; i++){
      const t = T[i];
      if (fw && fw[i] && WALKABLE[t]){ reach++; if (isPathish(t)) onPath++; }
      if (LEDGE_DIR[t]) ledges++; if (t === TILE.STAIRS || t === TILE.SIDE_STAIRS) stairs++; if (t === TILE.CLIFF) cliffs++; if (t === TILE.BRIDGE) bridges++;
    }
    let lmin = Infinity, lmax = -Infinity; for (let i = 0; i < N*N; i++) if (T[i] !== TILE.WATER){ lmin = Math.min(lmin, L[i]); lmax = Math.max(lmax, L[i]); }
    results.push({ x:sx, y:sy, N, tiles:T, cls:K, level:L, protectedMask, ports, junction, junctionSource, bridges, repairs, fallback,
                   unreachable, traps, trapFixes, needsSurf, waypoints:waypointCount, ledges, stairs, cliffs,
                   levels:isFinite(lmin) ? lmax - lmin + 1 : 0, offPathShare:reach ? (reach - onPath)/reach : 0,
                   log:sLog, connections:ports.map(p => ({ direction:['right', 'left', 'down', 'up'][p.side], to:p.neighbour, offset:0 })) });
  }

  // --- Region-wide checks ---
  const bySq = new Map(results.map(r => [sqId(r.x, r.y), r]));
  const seamIssues = [], seamInfo = [];
  for (const k of contracts){
    const A = bySq.get(sqId(k.a.x, k.a.y)), B = bySq.get(sqId(k.b.x, k.b.y));
    if (!A || !B) continue;
    const pa = A.ports.find(p => p.contract === k.id), pb = B.ports.find(p => p.contract === k.id);
    if (!pa || !pb || pa.pos !== pb.pos || pa.path !== pb.path || pa.verge !== pb.verge){ seamIssues.push(`contract ${k.key}: the two sides disagree`); continue; }
    let blocked = 0, mismatch = 0;
    for (let t = 0; t < N; t++){
      const ia = k.horiz ? t*N + (N - 1) : (N - 1)*N + t, ib = k.horiz ? t*N : t;
      const wa = PASSABLE[A.tiles[ia]], wb = PASSABLE[B.tiles[ib]];
      if (t >= k.pos - k.lo && t <= k.pos + k.hi && !(wa && wb)) blocked++;
      if (wa !== wb) mismatch++;
    }
    if (blocked) seamIssues.push(`contract ${k.key}: ${blocked} path tile(s) blocked at the seam`);
    if (mismatch) seamInfo.push(`contract ${k.key}: ${mismatch} edge tile(s) passable on one side only (a wall meets open ground or water)`);
  }
  const reciprocal = [];
  for (const r of results) for (const c of r.connections){
    const o = bySq.get(sqId(c.to.x, c.to.y)); if (!o) continue;
    if (!o.connections.some(oc => oc.to.x === r.x && oc.to.y === r.y)) reciprocal.push(`${r.x},${r.y} → ${c.to.x},${c.to.y} has no return connection`);
  }
  const parent = new Map(results.map(r => [sqId(r.x, r.y), sqId(r.x, r.y)]));
  const find = a => { while (parent.get(a) !== a){ parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const k of contracts){ const ia = sqId(k.a.x, k.a.y), ib = sqId(k.b.x, k.b.y); if (parent.has(ia) && parent.has(ib)) parent.set(find(ia), find(ib)); }
  const components = new Set([...parent.keys()].map(find)).size;
  const avg = f => results.length ? results.reduce((s, r) => s + f(r), 0)/results.length : 0;

  const report = {
    version, seed:inp.seed || 0, N, band:BAND, squares:results.length, contracts:contracts.length, terraceStepM:Math.round(sampler.stepM),
    seamFailures:seamIssues, seamNotes:seamInfo, reciprocityFailures:reciprocal, components,
    unreachable:results.filter(r => r.unreachable.length).map(r => `${r.x},${r.y}: ${r.unreachable.join(', ')}`),
    traps:results.reduce((s, r) => s + r.traps, 0), trapFixes:results.reduce((s, r) => s + r.trapFixes, 0),
    repairs:results.reduce((s, r) => s + r.repairs, 0), fallbacks:results.filter(r => r.fallback).length,
    firstPassReachable:results.filter(r => !r.repairs && !r.fallback).length,
    bridgeTiles:results.reduce((s, r) => s + r.bridges, 0), needSurf:results.filter(r => r.needsSurf).map(r => `${r.x},${r.y}`),
    waypoints:results.reduce((s, r) => s + r.waypoints, 0), ledgeTiles:results.reduce((s, r) => s + r.ledges, 0),
    stairTiles:results.reduce((s, r) => s + r.stairs, 0), meanLevels:+avg(r => r.levels).toFixed(1),
    offPathShare:+avg(r => r.offPathShare).toFixed(2)
  };
  report.ok = !seamIssues.length && !reciprocal.length && !report.unreachable.length && !report.traps;
  return { version, N, band:BAND, window:win, squares:results, contracts, report, log };
}

// ----- Preview colours (RGBA image of the window; inactive squares are dimmed; higher levels are lighter) -----
const COLORS = {
  [TILE.OPEN]:[120, 200, 80], [TILE.PATH]:[232, 176, 96], [TILE.VERGE]:[164, 220, 110], [TILE.TREE]:[40, 112, 56],
  [TILE.ROCK]:[150, 120, 90], [TILE.WATER]:[72, 160, 224], [TILE.BRIDGE]:[176, 120, 64], [TILE.CLIFF]:[96, 78, 70],
  [TILE.LEDGE_S]:[196, 168, 112], [TILE.LEDGE_E]:[196, 168, 112], [TILE.LEDGE_W]:[196, 168, 112],
  [TILE.STAIRS]:[250, 246, 236], [TILE.SIDE_STAIRS]:[250, 236, 214]
};
const OPEN_TINT = { [CLS.DESERT]:[228, 208, 152], [CLS.SNOW]:[232, 240, 248], [CLS.TUNDRA]:[180, 188, 156], [CLS.WETLAND]:[112, 176, 144],
  [CLS.CROP]:[200, 204, 96], [CLS.URBAN]:[176, 172, 180], [CLS.DRY]:[168, 200, 96], [CLS.ROCKY]:[176, 160, 128] };
function toRGBA(res, opts = {}){
  const N = res.N, W = res.window.w*N, H = res.window.h*N, img = new Uint8ClampedArray(W*H*4);
  for (let i = 0; i < W*H; i++){ img[i*4] = 40; img[i*4 + 1] = 44; img[i*4 + 2] = 60; img[i*4 + 3] = 255; }
  for (const s of res.squares){
    const ox = (s.x - res.window.x0)*N, oy = (s.y - res.window.y0)*N;
    let lmin = Infinity; for (let i = 0; i < N*N; i++) lmin = Math.min(lmin, s.level[i]);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ly*N + lx, t = s.tiles[i];
      let c = COLORS[t]; if ((t === TILE.OPEN || t === TILE.VERGE) && OPEN_TINT[s.cls[i]]) c = OPEN_TINT[s.cls[i]].map((v, k) => t === TILE.VERGE ? (v + COLORS[TILE.VERGE][k])/2 : v);
      // gentle shading by terrace level; paths, stairs and bridges stay unshaded so the route always reads clearly
      let k = t === TILE.WATER || isPathish(t) ? 1 : Math.min(1.1, 0.86 + 0.06*(s.level[i] - lmin));
      if (opts.showBand && s.protectedMask[i] && !isPathish(t) && t !== TILE.VERGE) k *= 0.85;
      const [r, g, b] = c.map(v => v*k);
      const o = ((oy + ly)*W + ox + lx)*4; img[o] = r; img[o + 1] = g; img[o + 2] = b;
    }
  }
  if (opts.showSeams) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    if (x % N && y % N) continue; const o = (y*W + x)*4; img[o] = img[o]*0.6 + 102; img[o + 1] = img[o + 1]*0.6; img[o + 2] = img[o + 2]*0.6;
  }
  return { width:W, height:H, data:img };
}

const api = { VERSION, BAND, TILE, CLS, PROFILE, LIMITS, COST, RELIEF, WAYPOINTS, generate, toRGBA, makeSeeds, hash32, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.OverworldGen = api;
})(typeof self !== 'undefined' ? self : this);
