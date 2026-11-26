/* Region Map Forge — overworld map generator (prototype "ow-proto-4").
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

const VERSION = 'ow-proto-4';
const BAND = 7;                                    // seam band depth in metatiles (pokeemerald MAP_OFFSET = 7)
const PAD = 8;                                     // raster margin around the window so results don't depend on it

// ----- Tile classes -----
const TILE = { OPEN:0, PATH:1, VERGE:2, TREE:3, ROCK:4, WATER:5, BRIDGE:6, CLIFF:7,
               LEDGE_S:8, LEDGE_E:9, LEDGE_W:10, STAIRS:11, SIDE_STAIRS:12, TALL_GRASS:13, LONG_GRASS:14 };
const NTILE = 15;
const WALKABLE = [1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1];
const PASSABLE = [1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1];   // walkable, or crossable with Surf (water)
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
// grassMax: the most tall grass the class can carry (at high NDVI); ndviGuess: greenness assumed without NDVI data;
// natural: counts toward a "wild" square (no defined path).
const PROFILE = [
  { name:'grassland', path:6, verge:4, cost:1.0, wallFrac:0.10, wall:'TREE', grassMax:0.50, ndviGuess:0.55, natural:false },
  { name:'forest',    path:3, verge:1, cost:2.5, wallFrac:0.70, wall:'TREE', grassMax:0.15, ndviGuess:0.75, natural:true },
  { name:'wetland',   path:3, verge:1, cost:2.0, wallFrac:0.15, wall:'TREE', grassMax:0.60, ndviGuess:0.60, natural:true },
  { name:'desert',    path:5, verge:3, cost:1.3, wallFrac:0.10, wall:'ROCK', grassMax:0.05, ndviGuess:0.10, natural:true },
  { name:'snow',      path:4, verge:2, cost:1.5, wallFrac:0.12, wall:'ROCK', grassMax:0.00, ndviGuess:0.05, natural:true },
  { name:'shrubland', path:4, verge:2, cost:1.2, wallFrac:0.22, wall:'TREE', grassMax:0.35, ndviGuess:0.35, natural:false },
  { name:'mangrove',  path:3, verge:1, cost:3.0, wallFrac:0.65, wall:'TREE', grassMax:0.10, ndviGuess:0.70, natural:true },
  { name:'tundra',    path:5, verge:3, cost:1.2, wallFrac:0.12, wall:'ROCK', grassMax:0.25, ndviGuess:0.30, natural:true },
  { name:'cropland',  path:5, verge:3, cost:1.1, wallFrac:0.04, wall:'TREE', grassMax:0.30, ndviGuess:0.55, natural:false },
  { name:'built-up',  path:4, verge:1, cost:1.0, wallFrac:0.10, wall:'TREE', grassMax:0.10, ndviGuess:0.30, natural:false },
  { name:'rocky',     path:3, verge:1, cost:3.0, wallFrac:0.42, wall:'ROCK', grassMax:0.10, ndviGuess:0.20, natural:true },
  { name:'water',     path:3, verge:1, cost:Infinity, wallFrac:0, wall:null, grassMax:0, ndviGuess:0, natural:false }
];
const LIMITS = { pathMin:3, pathMax:6, vergeMin:1, vergeMax:4 };
const COST = { corner:25, roadFactor:0.3, slopeK:2, noiseM:1.5, noiseScale:4, turn:0.1, reuse:2, cliff:5, riverCrossing:8, surf:2, peak:12,
               repairWall:6, repairRiver:10 };
const RELIEF = { minStepM:12, stepDivisor:4, compress:3, noise:0.45 };
// What a cliff run becomes, by the land cover on its high side (starting values; Claude's judgment): the chance a
// straight run carries a ledge, the chance it gets a flight of stairs, and the stairs' look (a palette, not new shapes).
const CROSSING = {
  [0]:{ ledge:0.55, stair:0.2, style:'stone' },  [8]:{ ledge:0.55, stair:0.2, style:'stone' },  [5]:{ ledge:0.4, stair:0.2, style:'stone' },
  [1]:{ ledge:0.25, stair:0.3, style:'dirt' },   [6]:{ ledge:0.2, stair:0.3, style:'dirt' },    [2]:{ ledge:0.3, stair:0.2, style:'dirt' },
  [3]:{ ledge:0.45, stair:0.2, style:'sand' },   [7]:{ ledge:0.35, stair:0.2, style:'snow' },   [4]:{ ledge:0.35, stair:0.2, style:'snow' },
  [10]:{ ledge:0.15, stair:0.35, style:'stone' }, [9]:{ ledge:0.2, stair:0.5, style:'stone' }
};
const STAIR_STYLES = ['none', 'stone', 'dirt', 'sand', 'snow'];
const WAYPOINTS = { min:1, max:3, candidates:48, spacing:6 };
const WILD = { naturalShare:0.6, path:2, verge:1, extraNoise:1.6, minWaypoints:2 };
const CONTENT = { offPathTarget:0.8, maxSpurs:8, minPocket:4, gapShare:0.5, loopChance:0.5, wildLoopChance:0.7,
                  pockets:[1, 3], pondsPerWetland:3, pondsPerOpen:0.8, thicketCap:0.2, thicketMinTree:0.85,
                  border:[2, 5] };
const HUMID_KG = new Set([1, 2, 3, 4, 9, 10, 15]);  // Köppen Af, Am, As, Aw, Cfa, Cfb, Cwa (Forge climate codes)
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
    ndvi(gx, gy){ if (!inp.ndvi) return null; let v = 0, w = 0;
      for (const [i, wt] of weights(gx, gy)) if (inp.ndvi[i]){ v += wt*(inp.ndvi[i] - 1)/254; w += wt; }
      return w > 0.25 ? v/w : null; },
    climate(gx, gy){ if (!inp.climate) return 0; const sx = Math.floor(gx/N*inp.sub), sy = Math.floor(gy/N*inp.sub);
      return sx >= 0 && sy >= 0 && sx < SW && sy < SH ? inp.climate[sy*SW + sx] : 0; },
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
  // relief (proto-4): rectilinear terraces. Levels are decided per block of B×B tiles (B = 3 or 4, aligned to global
  // tile coordinates so seams match), lightly smoothed, so every level boundary is a straight horizontal or vertical
  // run with right-angle turns. Boundaries become cliffs (2 tiles thick where the drop is 2+ levels), straight runs can
  // carry one-way ledges (never on corners) and stairs (spaced at least a knight's move from stairs on other cliffs).
  const B = inp.terraceBlock === 3 ? 3 : 4;
  const bx0 = Math.floor(RX0/B) - 1, by0 = Math.floor(RY0/B) - 1, BW = Math.ceil(RW/B) + 3, BH = Math.ceil(RH/B) + 3;
  const blev = new Int16Array(BW*BH);
  for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++){
    const gx = (bx0 + bx)*B + B/2, gy = (by0 + by)*B + B/2;
    const e = sampler.elev(gx, gy) + RELIEF.noise*sampler.stepM*(2*smoothNoise(sLev, gx, gy, 7) - 1);
    const d = Math.max(0, (e - sampler.elevMin)/sampler.stepM);
    blev[by*BW + bx] = Math.floor(RELIEF.compress*Math.log2(1 + d/RELIEF.compress));   // log-compressed: big mountains get a few tall terraces
  }
  { const copy = blev.slice();                     // smoothing: a block that sticks out from 3+ of its 4 neighbours joins them
    for (let by = 1; by < BH - 1; by++) for (let bx = 1; bx < BW - 1; bx++){
      const i = by*BW + bx, nb = [copy[i - 1], copy[i + 1], copy[i - BW], copy[i + BW]].sort((p, q) => p - q);
      if (nb.filter(v => v !== copy[i]).length >= 3) blev[i] = nb[1];
    } }
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++)
    lev[y*RW + x] = blev[(Math.floor((RY0 + y)/B) - by0)*BW + Math.floor((RX0 + x)/B) - bx0];
  const drop = new Uint8Array(RW*RH), lowers = new Uint8Array(RW*RH);
  const FD = [[FACE.S, 0, 1], [FACE.E, 1, 0], [FACE.W, -1, 0], [FACE.N, 0, -1]];
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const i = y*RW + x; if (water[i]) continue;
    for (const [f, dx, dy] of FD){
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= RW || ny >= RH) continue;
      const j = ny*RW + nx; if (water[j]) continue;
      const d = lev[i] - lev[j];
      if (d > 0){ lowers[i]++; if (face[i] === FACE.NONE){ face[i] = f; drop[i] = Math.min(d, 9); } }
    }
    if (face[i] !== FACE.NONE) tiles[i] = TILE.CLIFF;
  }
  // tall faces: a 2+ level drop makes the cliff 2 tiles thick (the tile behind the edge, same level, same facing)
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const i = y*RW + x; if (tiles[i] !== TILE.CLIFF || drop[i] < 2 || lowers[i] !== 1) continue;
    const [, dx, dy] = FD.find(f => f[0] === face[i]), bx = x - dx, by = y - dy;
    if (bx < 0 || by < 0 || bx >= RW || by >= RH) continue;
    const j = by*RW + bx; if (water[j] || face[j] !== FACE.NONE || lev[j] !== lev[i]) continue;
    face[j] = face[i]; drop[j] = 0; tiles[j] = TILE.CLIFF;          // drop 0 marks the back row of a tall face
  }
  // straight runs: edge tiles with one lower neighbour (corners have two), same facing, same drop, side by side
  const runs = [];
  const runOf = new Int32Array(RW*RH).fill(-1);
  for (const f of [FACE.S, FACE.N, FACE.E, FACE.W]){
    const horizontal = f === FACE.S || f === FACE.N;
    const outer = horizontal ? RH : RW, inner = horizontal ? RW : RH;
    for (let o = 0; o < outer; o++){
      let start = -1;
      const at = t => horizontal ? o*RW + t : t*RW + o;
      const edge = t => { const i = at(t); return face[i] === f && drop[i] >= 1 && lowers[i] === 1; };
      for (let t = 0; t <= inner; t++){
        const ok = t < inner && edge(t) && (start < 0 || drop[at(t)] === drop[at(start)]);
        if (!ok && start >= 0){
          const id = runs.length, cells = [];
          for (let u = start; u < t; u++){ const ci = at(u); cells.push(ci); runOf[ci] = id; }
          runs.push({ face:f, cells, drop:drop[cells[0]], g:horizontal ? [RX0 + start, RY0 + o] : [RX0 + o, RY0 + start] });
          start = -1;
        }
        if (start < 0 && t < inner && edge(t)) start = t;
      }
    }
  }
  const ledgeChance = c => CROSSING[c] ? CROSSING[c].ledge : 0.3, stairChance = c => CROSSING[c] ? CROSSING[c].stair : 0.2;
  const stairAt = new Map();                        // tile → run id (for the knight's-move rule)
  const diagConflict = (i, id) => { const x = i % RW, y = (i/RW) | 0;
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]){ const j = (y + dy)*RW + x + dx; if (stairAt.has(j) && stairAt.get(j) !== id) return true; }
    return false; };
  const behind = i => { const [, dx, dy] = FD.find(f => f[0] === face[i]); const j = i - dy*RW - dx; return face[j] === face[i] && drop[j] === 0 ? j : -1; };
  for (let id = 0; id < runs.length; id++){
    const run = runs[id], n = run.cells.length, r = mulberry32(hash32(sLedge, run.g[0], run.g[1], run.face));
    const mid = run.cells[n >> 1], c = cls[mid];
    let ledge = null;
    // ledges: one level only, facing S/E/W, a segment of 3+ tiles that never touches the run's ends (corners)
    if (run.face !== FACE.N && run.drop === 1 && n >= 5 && r() < ledgeChance(c)){
      const len = 3 + Math.floor(r()*(n - 4)), start = 1 + Math.floor(r()*(n - 1 - len));
      ledge = [start, start + len - 1];
      for (let u = start; u < start + len; u++){ const i = run.cells[u];
        tiles[i] = run.face === FACE.S ? TILE.LEDGE_S : run.face === FACE.E ? TILE.LEDGE_E : TILE.LEDGE_W; }
    }
    // stairs: a 1–2-wide flight somewhere along the run (through both rows of a tall face), away from the ends and ledges
    if (n >= 3 && r() < stairChance(c)){
      const w = n >= 8 && r() < 0.5 ? 2 : 1, pos = 1 + Math.floor(r()*Math.max(1, n - 1 - w));
      const clash = ledge && pos <= ledge[1] + 1 && pos + w - 1 >= ledge[0] - 1;
      const cells = []; for (let u = pos; u < pos + w && u < n - 1; u++){ cells.push(run.cells[u]); const b2 = behind(run.cells[u]); if (b2 >= 0) cells.push(b2); }
      if (!clash && cells.length && !cells.some(i => diagConflict(i, id))){
        for (const i of cells){ tiles[i] = stairsFor(face[i]); stairAt.set(i, id); }
      }
    }
  }
  const runStats = { runs:runs.length };
  // cliff corners (where a cliff turns): paths and ports keep away, so stairs never meet diagonally at a turn
  const corner = new Uint8Array(RW*RH);
  for (let i = 0; i < RW*RH; i++) if (face[i] !== FACE.NONE && drop[i] >= 1 && (lowers[i] >= 2 || runOf[i] < 0)) corner[i] = 1;
  for (const run of runs){ corner[run.cells[0]] = 1; corner[run.cells[run.cells.length - 1]] = 1; }   // run ends: where the cliff steps or turns

  // --- Wild squares: no real road through them, not a town, and mostly natural cover → no defined path ---
  const townSet = new Set((inp.townSquares || []).map(q => sqId(q.x, q.y)));
  const roadInSquare = (x, y) => (inp.roads || []).some(road => road.pts.some((p0, k) => {
    const p1 = road.pts[Math.min(k + 1, road.pts.length - 1)], steps = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y)*8));
    for (let s2 = 0; s2 <= steps; s2++){ const fx = p0.x + (p1.x - p0.x)*s2/steps, fy = p0.y + (p1.y - p0.y)*s2/steps;
      if (fx >= x && fx < x + 1 && fy >= y && fy < y + 1) return true; }
    return false; }));
  const wildSet = new Set();
  for (const s of active.values()){
    if (townSet.has(sqId(s.x, s.y)) || roadInSquare(s.x, s.y)) continue;
    let nat = 0, land = 0;
    for (let y = 0; y < inp.sub; y++) for (let x = 0; x < inp.sub; x++){
      const c = sampler.subClass[(s.y*inp.sub + y)*sampler.SW + s.x*inp.sub + x]; if (c === CLS.WATER) continue;
      land++; if (PROFILE[c].natural) nat++; }
    if (land && nat/land >= WILD.naturalShare) wildSet.add(sqId(s.x, s.y));
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
    const wildEdge = wildSet.has(sqId(a.x, a.y)) && wildSet.has(sqId(b.x, b.y));
    let p = wildEdge ? WILD.path : Math.min(wa.p, wb.p), v = wildEdge ? WILD.verge : Math.min(wa.v, wb.v);
    const notes = wildEdge ? ['wild on both sides: a narrow natural trail'] : [];
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
    // cliffs that run along the approach (instead of across it) would turn into stairs running along a cliff
    const along = i => face[i] !== FACE.NONE && (horiz ? (face[i] === FACE.N || face[i] === FACE.S) : (face[i] === FACE.E || face[i] === FACE.W));
    const lakeAt = pos => approachCells(pos, i => (water[i] && !river[i]) || corner[i] || along(i));
    if (lakeAt(clamped)){                             // slide to dry land away from cliff corners (road ports only a little)
      for (let off = 1; off <= (source === 'road' ? 3 : cMax - cMin); off++){
        const cand = [clamped - off, clamped + off].find(q => q >= cMin && q <= cMax && !lakeAt(q));
        if (cand !== undefined){ notes.push(`port moved ${clamped} → ${cand} to keep the approach on dry land and off cliff corners`); clamped = cand; break; }
      }
    }
    let lo2 = lo, hi2 = hi;
    const bridge = approachCells(clamped, i => river[i] === 1), otherWater = approachCells(clamped, i => water[i] && !river[i]);
    if (bridge && p !== 3 && !wildEdge){ p = 3; lo2 = 1; hi2 = 1; notes.push('river in the approach: path narrowed to the 3-wide bridge'); }
    if (otherWater) notes.push('lake or sea water in the approach (crossed by Surf)');
    const k = { id:contracts.length, key, a, b, horiz, pos:clamped, lo:lo2, hi:hi2, path:p, verge:v, source, notes, bridge, wild:wildEdge };
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
  // --- Borders (B), corners (D) and scenery maps (C) ---
  // B: each map's border block (the pattern the engine repeats wherever no map is connected) suits the square:
  // water for mostly-water squares, rock for rocky/dry/cold ones, trees otherwise.
  const borderType = (x, y) => {
    let w = 0, rock = 0, n = 0;
    for (let yy = 0; yy < inp.sub; yy++) for (let xx = 0; xx < inp.sub; xx++){
      const sxx = x*inp.sub + xx, syy = y*inp.sub + yy; if (sxx < 0 || syy < 0 || sxx >= sampler.SW || syy >= sampler.SH) continue;
      const c = sampler.subClass[syy*sampler.SW + sxx]; n++;
      if (c === CLS.WATER) w++; else if (c === CLS.ROCKY || c === CLS.DESERT || c === CLS.SNOW || c === CLS.TUNDRA) rock++; }
    return n && w/n > 0.5 ? 'water' : n && rock/Math.max(1, n - w) > 0.4 ? 'rock' : 'trees';
  };
  const borderOf = new Map(); const btype = (x, y) => { const k = sqId(x, y); if (!borderOf.has(k)) borderOf.set(k, borderType(x, y)); return borderOf.get(k); };
  // D: the corner between four squares is filled with one filler, chosen from the squares around it
  const cornerFiller = (cx, cy) => { const v = [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]]
      .filter(([x, y]) => x >= 0 && y >= 0 && x < inp.gridW && y < inp.gridH).map(([x, y]) => btype(x, y));
    return v.filter(t => t === 'rock').length > v.filter(t => t === 'trees').length ? 'rock' : 'trees'; };
  // C: where a river or a cliff runs off a square through an edge with no connected map, the empty neighbour becomes an
  // unenterable scenery map (every tile blocked), connected for looks only, so the feature visibly continues
  const sceneryEdges = new Map();                   // neighbour sqId → [{ from, side }]
  for (const sq of winSquares){
    for (let side = 0; side < 4; side++){
      if (contractOf.get(sqId(sq.x, sq.y) + ':' + side)) continue;
      const nx = sq.x + [1, -1, 0, 0][side], ny = sq.y + [0, 0, 1, -1][side];
      if (nx < 0 || ny < 0 || nx >= inp.gridW || ny >= inp.gridH || active.has(sqId(nx, ny)) || !inWin(nx, ny)) continue;
      let rivers = 0, cliffs = 0;
      for (let t = 0; t < N; t++){
        const lx = side === 0 ? N - 1 : side === 1 ? 0 : t, ly = side === 2 ? N - 1 : side === 3 ? 0 : t, i = ri(sq.x*N + lx, sq.y*N + ly);
        if (river[i]) rivers++; if (isCliffish(tiles[i]) || tiles[i] === TILE.STAIRS || tiles[i] === TILE.SIDE_STAIRS) cliffs++;
      }
      if (rivers >= 1 || cliffs >= 2){ const k = sqId(nx, ny); if (!sceneryEdges.has(k)) sceneryEdges.set(k, []);
        sceneryEdges.get(k).push({ from:{ x:sq.x, y:sq.y }, side, why:rivers ? 'river' : 'cliff' }); }
    }
  }
  const scenery = [];
  for (const [k, list] of [...sceneryEdges.entries()].sort((p, q) => p[0] - q[0])){
    const x = k % inp.gridW, y = Math.floor(k/inp.gridW), T = new Uint8Array(N*N), K = new Uint8Array(N*N), Lv = new Int16Array(N*N);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){ const i = ri(x*N + lx, y*N + ly), j = ly*N + lx; T[j] = tiles[i]; K[j] = cls[i]; Lv[j] = lev[i]; }
    scenery.push({ x, y, N, tiles:T, cls:K, level:Lv, blocked:true, border:btype(x, y), seenFrom:list.map(e => `${e.from.x},${e.from.y} (${e.why})`) });
  }

  const results = [];
  const sBorder = seeds.layer('border'), sRag = seeds.layer('ragged'), sGrass = seeds.layer('grass'), sGrass2 = seeds.layer('grass2');
  // tall grass share at a tile: NDVI (or a per-class guess) scaled into the class's maximum; position-keyed placement
  const grassAt = (gx, gy, c) => {
    const nd = sampler.ndvi(gx, gy), ndvi = nd === null ? PROFILE[c].ndviGuess : nd;
    const share = Math.min(1, Math.max(0, (ndvi - 0.2)/0.5))*PROFILE[c].grassMax;
    // smooth noise bunches near 0.5; stretching it ×2.2 makes the covered fraction match `share` (checked: 0.2 → 17%, 0.35 → 36%)
    const n = Math.min(1, Math.max(0, (smoothNoise(sGrass, gx, gy, 4) - 0.5)*2.2 + 0.5));
    return 0.7*n + 0.3*rand01(sGrass2, gx, gy) < share;
  };
  for (const sq of winSquares){
    const sx = sq.x, sy = sq.y, id = sqId(sx, sy), sLog = [], wild = wildSet.has(id);
    const T = new Uint8Array(N*N), K = new Uint8Array(N*N), L = new Int16Array(N*N), F = new Uint8Array(N*N), RV = new Uint8Array(N*N), CN = new Uint8Array(N*N);
    const protectedMask = new Uint8Array(N*N), trail = new Uint8Array(N*N);   // trail: the main route (path tiles, or natural ground in wild squares)
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ri(sx*N + lx, sy*N + ly), j = ly*N + lx;
      T[j] = tiles[i]; K[j] = cls[i]; L[j] = lev[i]; F[j] = face[i]; RV[j] = river[i]; CN[j] = corner[i];
    }
    const inBand = (lx, ly) => lx < BAND || ly < BAND || lx >= N - BAND || ly >= N - BAND;
    const wallFor = i => (K[i] === CLS.DESERT || K[i] === CLS.TUNDRA || K[i] === CLS.SNOW || K[i] === CLS.ROCKY) ? TILE.ROCK : TILE.TREE;
    const border = btype(sx, sy), borderWall = border === 'trees' ? TILE.TREE : TILE.ROCK;
    const sceneryLinks = [];
    const ports = [];
    for (let side = 0; side < 4; side++){
      const k = contractOf.get(id + ':' + side);
      const cell = (d, t) => side <= 1 ? { lx:side === 0 ? N - 1 - d : d, ly:t } : { lx:t, ly:side === 2 ? N - 1 - d : d };
      if (!k){                                     // unlinked edge: a wavy 2–5-tile border in the square's border filler
        const nx = sx + [1, -1, 0, 0][side], ny = sy + [0, 0, 1, -1][side];
        if (sceneryEdges.has(sqId(nx, ny)) && sceneryEdges.get(sqId(nx, ny)).some(e => e.from.x === sx && e.from.y === sy))
          sceneryLinks.push({ direction:['right', 'left', 'down', 'up'][side], to:{ x:nx, y:ny }, offset:0, scenery:true });
        for (let t = 0; t < N; t++){
          const along = side <= 1 ? sy*N + t : sx*N + t, line = side === 0 ? sx + 1 : side === 1 ? sx : side === 2 ? sy + 1 : sy;
          const th = CONTENT.border[0] + Math.floor((CONTENT.border[1] - CONTENT.border[0] + 0.999)*smoothNoise(hash32(sBorder, line, side <= 1 ? 1 : 2), along, 0, 5));
          for (let d = 0; d < th; d++){ const { lx, ly } = cell(d, t), i = ly*N + lx;
            if (T[i] === TILE.WATER){ if (RV[i]) T[i] = TILE.ROCK; }          // rocks in the river: nothing leaves this way
            else T[i] = borderWall; }
        }
        continue;
      }
      for (let d = 0; d <= BAND; d++){
        // the path stays straight and exact (it must match the neighbour); the verge edge is ragged
        const gx0 = cell(d, 0), rag = k => Math.round(1.6*(smoothNoise(sRag, sx*N + gx0.lx + d*7, sy*N + gx0.ly + k*13, 3) - 0.5));
        const vL = Math.max(0, k.verge + rag(1)), vR = Math.max(0, k.verge + rag(2));
        for (let a = k.pos - k.lo - vL; a <= k.pos + k.hi + vR; a++){
          if (a < 0 || a >= N) continue;
          const { lx, ly } = cell(d, a), i = ly*N + lx, isPath = a >= k.pos - k.lo && a <= k.pos + k.hi;
          if (T[i] === TILE.WATER){ if (isPath && a >= k.pos - 1 && a <= k.pos + 1 && RV[i]) { T[i] = TILE.BRIDGE; trail[i] = 1; } }
          else if (isCliffish(T[i]) || T[i] === TILE.STAIRS || T[i] === TILE.SIDE_STAIRS){
            const across = side <= 1 ? (F[i] === FACE.E || F[i] === FACE.W) : (F[i] === FACE.N || F[i] === FACE.S);
            if (isPath && across){ T[i] = stairsFor(F[i]); trail[i] = 1; }
            else if (isPath){ T[i] = k.wild ? TILE.OPEN : TILE.PATH; trail[i] = 1; }   // rare: a cliff along the approach is levelled so the seam stays open
          }
          else if (isPath){ T[i] = k.wild ? TILE.OPEN : TILE.PATH; trail[i] = 1; }
          else T[i] = TILE.VERGE;
          if (d < BAND) protectedMask[i] = 1;
        }
      }
      ports.push({ side, contract:k.id, pos:k.pos, path:k.path, verge:k.verge, gate:cell(BAND, k.pos), edgeTile:cell(0, k.pos),
                   neighbour:k.a.x === sx && k.a.y === sy ? k.b : k.a });
    }
    for (let i = 0; i < N*N; i++) if (inBand(i % N, (i/N) | 0)) protectedMask[i] = 1;
    // D: corner tips (the diagonal neighbour is never drawn by the engine) blend into one shared filler
    for (const [cx, cy] of [[sx, sy], [sx + 1, sy], [sx, sy + 1], [sx + 1, sy + 1]]){
      const fill = cornerFiller(cx, cy) === 'rock' ? TILE.ROCK : TILE.TREE, px = cx*N, py = cy*N;
      for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
        const gx = sx*N + lx, gy = sy*N + ly, d = Math.hypot(gx + 0.5 - px, gy + 0.5 - py);
        if (d > 3 + 1.5*smoothNoise(sBorder, gx, gy, 3)) continue;
        const i = ly*N + lx; if (T[i] === TILE.WATER){ if (RV[i]) T[i] = TILE.ROCK; } else T[i] = fill;
      }
    }

    const sSq = seeds.square(sx, sy), sNoise = hash32(sSq, strHash('noise')), sWay = hash32(sSq, strHash('waypoints'));
    const rSq = mulberry32(hash32(sSq, strHash('content')));
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
      if (CN[i]) c += COST.corner;
      const ex = sampler.elev(gx + 1, gy) - sampler.elev(gx - 1, gy), ey = sampler.elev(gx, gy + 1) - sampler.elev(gx, gy - 1);
      const slope = Math.min(1, Math.hypot(ex, ey)/(2*mpt)/0.3);
      c *= (1 + COST.slopeK*slope)*(1 + COST.noiseM*(wild ? WILD.extraNoise : 1)*smoothNoise(sNoise, gx, gy, COST.noiseScale));
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
      const r = mulberry32(legSeed), lo2 = wild ? WILD.minWaypoints : WAYPOINTS.min;
      const want = lo2 + Math.floor(r()*(WAYPOINTS.max - lo2 + 1));
      const count = roadTiles.size ? Math.min(1, want) : want;      // real roads already shape the route
      const dx = B.lx - A.lx, dy = B.ly - A.ly, len = Math.hypot(dx, dy) || 1, cands = [];
      for (let k2 = 0; k2 < WAYPOINTS.candidates; k2++){
        const lx = lo + Math.floor(r()*(hi - lo + 1)), ly = lo + Math.floor(r()*(hi - lo + 1)), sc = interest(lx, ly);
        if (!isFinite(sc)) continue;
        const off = Math.abs((lx - A.lx)*dy - (ly - A.ly)*dx)/len, t = ((lx - A.lx)*dx + (ly - A.ly)*dy)/(len*len);
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

    // carving with round stamps: path (or natural ground in wild squares), stairs on cliffs, bridges on rivers,
    // and a ragged verge that clears walls around it. kind: 'main' (the route), 'side' (spurs, loops: natural ground)
    const carveDisc = (cx, cy, p, v, kind) => {
      const off = p % 2 ? 0 : 0.5, rp = (p - 1)/2 + 0.35, reach = Math.ceil(rp + v + 1);
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++){
        const x = cx + dx, y = cy + dy; if (!inInterior(x, y)) continue;
        const i = y*N + x, d = Math.hypot(dx - off, dy - off);
        const jitter = 1.4*(smoothNoise(sRag, sx*N + x, sy*N + y, 3) - 0.5);
        const inPath = d <= rp, inVerge = !inPath && v > 0 && d <= rp + v + jitter;
        if (!inPath && !inVerge) continue;
        if (T[i] === TILE.WATER){ if (inPath && d <= 1.5 && RV[i]){ T[i] = TILE.BRIDGE; if (kind === 'main') trail[i] = 1; } continue; }
        if (T[i] === TILE.BRIDGE || T[i] === TILE.STAIRS || T[i] === TILE.SIDE_STAIRS){ if (inPath && kind === 'main') trail[i] = 1; continue; }
        if (isCliffish(T[i])) continue;              // stamps never touch cliffs; stairFlight() cuts the crossing itself
        if (inPath){
          if (kind === 'main'){ T[i] = wild ? TILE.OPEN : TILE.PATH; trail[i] = 1; }
          else if (!isPathish(T[i]) && !trail[i]) T[i] = TILE.OPEN;
        } else if (!isPathish(T[i]) && !trail[i]) T[i] = kind === 'main' ? TILE.VERGE : (isWall(T[i]) ? TILE.OPEN : T[i]);
      }
    };
    // where a route's centre line meets a cliff: one straight flight across the route's width, along the cliff and
    // through both rows of a tall face (so stairs never run along a cliff or meet diagonally)
    const stairFlight = (cx, cy, w, kind) => {
      const i0 = cy*N + cx; if (!isCliffish(T[i0]) || F[i0] === FACE.NONE) return;
      const f = F[i0], ax = f === FACE.S || f === FACE.N ? 1 : 0, ay = 1 - ax;
      const back = [[0, -1], [0, 1], [-1, 0], [1, 0]][[FACE.S, FACE.N, FACE.E, FACE.W].indexOf(f)];   // into the high side
      const a = (w - 1) >> 1, b = w - 1 - a;
      for (let u = -a; u <= b; u++){
        let x = cx + ax*u, y = cy + ay*u;
        for (let d = 0; d < 3; d++, x += back[0], y += back[1]){
          if (!inInterior(x, y)) break; const i = y*N + x;
          if (!(isCliffish(T[i]) || T[i] === TILE.STAIRS || T[i] === TILE.SIDE_STAIRS) || F[i] !== f) break;
          T[i] = stairsFor(f); if (kind === 'main') trail[i] = 1;
        }
      }
    };
    let waypointCount = 0;
    const mainPts = [];
    for (const leg of legs){
      if (!leg.pts) continue;
      waypointCount += leg.waypoints;
      const pts = leg.pts, n = pts.length; mainPts.push(pts);
      const raw = pts.map(q => widthsFromShares(sampler.shares(sx*N + q.lx, sy*N + q.ly)));
      const sm = raw.map((_, i) => { let p = 0, v = 0, c = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++){ p += raw[j].p; v += raw[j].v; c++; } return { p:p/c, v:v/c }; });
      const startK = ports[leg.ends[0]], endK = leg.ends[1] !== null ? ports[leg.ends[1]] : null;
      pts.forEach((q, i) => {
        let { p, v } = sm[i];
        const blend = (k2, dist) => { if (k2 && dist < 7){ const u = dist/7; p = k2.path*(1 - u) + p*u; v = k2.verge*(1 - u) + v*u; } };
        blend(startK, i); blend(endK, n - 1 - i);
        if (wild){ carveDisc(q.lx, q.ly, WILD.path, WILD.verge, 'main'); stairFlight(q.lx, q.ly, WILD.path, 'main'); return; }
        const w = clampWidth(p, v); carveDisc(q.lx, q.ly, w.p, w.v, 'main'); stairFlight(q.lx, q.ly, w.p, 'main');
      });
    }
    // soften the verge's outer edge: lone wall notches open up, verge tiles boxed in by walls grow back
    { const copy = T.slice();
      for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++){
        const i = y*N + x; if (trail[i] || isPathish(copy[i])) continue;
        let walls = 0, verge = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){ if (!dx && !dy) continue; const t = copy[(y + dy)*N + x + dx];
          if (isWall(t)) walls++; else if (t === TILE.VERGE) verge++; }
        if (isWall(copy[i]) && verge >= 4 && walls <= 3) T[i] = TILE.VERGE;
        else if (copy[i] === TILE.VERGE && walls >= 6) T[i] = wallFor(i);
      } }

    // --- Off-path content ---
    const content = { thicketTiles:0, ponds:0, pockets:[], spurs:{ gap:0, trail:0 }, loops:0 };
    const interiorArea = (hi - lo + 1)**2;
    // jungle thickets: dense humid forest becomes 2×2 trees with single walkable gaps (period 3), in 8×8 chunks
    for (let cy = lo; cy <= hi; cy += 8) for (let cx = lo; cx <= hi; cx += 8){
      const gx = sx*N + cx + 4, gy = sy*N + cy + 4, sh = sampler.shares(gx, gy), kg = sampler.climate(gx, gy);
      if (inp.climate && !HUMID_KG.has(kg)) continue;
      const chance = Math.min(1, Math.max(0, (sh[CLS.FOREST] + sh[CLS.MANGROVE] - CONTENT.thicketMinTree)/(1 - CONTENT.thicketMinTree)));
      if (!(rSq() < chance) || content.thicketTiles > CONTENT.thicketCap*interiorArea) continue;
      for (let y = cy; y < Math.min(hi + 1, cy + 8); y++) for (let x = cx; x < Math.min(hi + 1, cx + 8); x++){
        const i = y*N + x; if (T[i] !== TILE.TREE || trail[i]) continue;
        const gx2 = sx*N + x, gy2 = sy*N + y;
        if (gx2 % 3 === 2 || gy2 % 3 === 2){ T[i] = TILE.OPEN; content.thicketTiles++; }
      }
    }
    // ponds: small water in wetland and open land, away from the route
    { let wet = 0, open = 0; for (let i = 0; i < N*N; i++){ if (K[i] === CLS.WETLAND) wet++; else if (K[i] === CLS.GRASS || K[i] === CLS.CROP || K[i] === CLS.DRY) open++; }
      const nP = Math.floor(rSq()*(CONTENT.pondsPerWetland*wet/(N*N) + CONTENT.pondsPerOpen*open/(N*N)) + 0.3);
      for (let k2 = 0; k2 < nP; k2++){
        const cx = lo + 2 + Math.floor(rSq()*(hi - lo - 3)), cy = lo + 2 + Math.floor(rSq()*(hi - lo - 3)), rad = 1.5 + rSq()*1.3;
        let clear = true; for (let dy = -4; dy <= 4 && clear; dy++) for (let dx = -4; dx <= 4; dx++){ const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < N && y < N && (trail[y*N + x] || isPathish(T[y*N + x]))){ clear = false; break; } }
        if (!clear) continue;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++){ const x = cx + dx, y = cy + dy; if (!inInterior(x, y)) continue;
          const i = y*N + x; if (Math.hypot(dx, dy) + 0.8*(smoothNoise(sRag, sx*N + x, sy*N + y, 2) - 0.5) <= rad && !isCliffish(T[i])) T[i] = TILE.WATER; }
        content.ponds++;
      } }
    // reachability helpers (one-way ledges understood)
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let passable = i => PASSABLE[T[i]] === 1;
    const flood = (start, reverse) => {
      const seen = new Uint8Array(N*N); if (!passable(start)) return seen;
      const q = [start]; seen[start] = 1;
      while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
        for (const [dx, dy] of DIRS){
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const ni = ny*N + nx;
          if (passable(ni)){ if (!seen[ni]){ seen[ni] = 1; q.push(ni); } continue; }
          const ld = LEDGE_DIR[T[ni]]; if (!ld) continue;
          const fx = nx + dx, fy = ny + dy; if (fx < 0 || fy < 0 || fx >= N || fy >= N) continue;
          const fi = fy*N + fx; if (!passable(fi) || seen[fi]) continue;
          if ((!reverse && ld[0] === dx && ld[1] === dy) || (reverse && ld[0] === -dx && ld[1] === -dy)){ seen[fi] = 1; q.push(fi); }
        }
      }
      return seen;
    };
    const startI = ports.length ? ports[0].edgeTile.ly*N + ports[0].edgeTile.lx : (junction ? junction.ly*N + junction.lx : -1);
    const offShare = () => { if (startI < 0) return 1; const fw = flood(startI, false); let reach = 0, on = 0;
      for (let i = 0; i < N*N; i++) if (fw[i] && WALKABLE[T[i]]){ reach++; if (trail[i] || isPathish(T[i])) on++; }
      return reach ? (reach - on)/reach : 0; };
    // dead-end pockets: small clearings carved into walls a few tiles from reachable ground (places for items later)
    { const nPk = CONTENT.pockets[0] + Math.floor(rSq()*(CONTENT.pockets[1] - CONTENT.pockets[0] + 1)) + (wild ? 1 : 0);
      for (let k2 = 0, tries = 0; k2 < nPk && tries < 60; tries++){
        const cx = lo + 1 + Math.floor(rSq()*(hi - lo - 1)), cy = lo + 1 + Math.floor(rSq()*(hi - lo - 1)), i = cy*N + cx;
        if (!isWall(T[i])) continue;
        let walls = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inInterior(cx + dx, cy + dy) && isWall(T[(cy + dy)*N + cx + dx])) walls++;
        if (walls < 18) continue;                    // pockets hide inside thick walls
        const rad = 1.3 + rSq()*1.1;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++){ const x = cx + dx, y = cy + dy;
          if (inInterior(x, y) && Math.hypot(dx, dy) <= rad && isWall(T[y*N + x])) T[y*N + x] = TILE.OPEN; }
        content.pockets.push({ lx:cx, ly:cy }); k2++;
      } }
    // side trails: join unreached open ground (glades, plateaus, pockets) to the route, most of them hidden
    // ('gap' = a single-tile gap through trees or rock; 'trail' = a 2-wide natural trail). Stops at the off-path target.
    if (startI >= 0){
      for (let spur = 0; spur < CONTENT.maxSpurs && offShare() < CONTENT.offPathTarget; spur++){
        const fw = flood(startI, false), comp = new Int32Array(N*N).fill(-1), comps = [];
        for (let i = 0; i < N*N; i++){
          if (fw[i] || !WALKABLE[T[i]] || comp[i] >= 0) continue;
          const x0 = i % N, y0 = (i/N) | 0; if (!inInterior(x0, y0)) continue;
          const list = [i], q = [i]; comp[i] = comps.length;
          while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
            for (const [dx, dy] of DIRS){ const nx = x + dx, ny = y + dy; if (!inInterior(nx, ny)) continue; const ni = ny*N + nx;
              if (comp[ni] < 0 && !fw[ni] && WALKABLE[T[ni]]){ comp[ni] = comps.length; list.push(ni); q.push(ni); } } }
          comps.push(list);
        }
        const big = comps.filter(c => c.length >= CONTENT.minPocket).sort((p, q) => q.length - p.length || p[0] - q[0]);
        if (!big.length) break;
        const target = big[Math.floor(rSq()*Math.min(3, big.length))];
        // nearest reached interior tile to this component
        let best = null;
        for (const c of target){ const x = c % N, y = (c/N) | 0;
          for (let i = 0; i < N*N; i++){ if (!fw[i] || !WALKABLE[T[i]]) continue; const x2 = i % N, y2 = (i/N) | 0; if (!inInterior(x2, y2)) continue;
            const d = Math.abs(x - x2) + Math.abs(y - y2); if (!best || d < best.d) best = { d, from:{ lx:x, ly:y }, to:{ lx:x2, ly:y2 } }; } }
        if (!best) break;
        const type = rSq() < CONTENT.gapShare ? 'gap' : 'trail';
        const spurCost = (lx, ly) => { const i = ly*N + lx; if (T[i] === TILE.WATER) return RV[i] ? 6 : COST.surf;
          if (isCliffish(T[i])) return 4; if (isWall(T[i])) return 3; return 1; };
        const pts = astar(best.from, best.to, spurCost);
        if (!pts) break;
        for (const q of pts){ carveDisc(q.lx, q.ly, type === 'gap' ? 1 : 2, 0, 'side'); stairFlight(q.lx, q.ly, type === 'gap' ? 1 : 2, 'side'); }
        content.spurs[type]++;
      }
      // loops: a second, natural way between two far-apart points of the route
      if (mainPts.length && rSq() < (wild ? CONTENT.wildLoopChance : CONTENT.loopChance)){
        const pts = mainPts[0]; let pair = null;
        for (let tries = 0; tries < 40 && !pair; tries++){
          const i = Math.floor(rSq()*pts.length), j = Math.floor(rSq()*pts.length);
          if (Math.abs(i - j) < 25) continue;
          const d = Math.abs(pts[i].lx - pts[j].lx) + Math.abs(pts[i].ly - pts[j].ly);
          if (d >= 6 && d <= 14) pair = [pts[i], pts[j]];
        }
        if (pair){
          const loopCost = (lx, ly) => { const i = ly*N + lx; if (trail[i]) return 8; if (T[i] === TILE.WATER) return RV[i] ? 6 : COST.surf;
            if (isCliffish(T[i])) return 4; if (isWall(T[i])) return 2.5; return 1 + smoothNoise(sNoise, sx*N + lx + 99, sy*N + ly, 3); };
          const lp = astar(pair[0], pair[1], loopCost);
          if (lp){ for (const q of lp){ carveDisc(q.lx, q.ly, 2, 0, 'side'); stairFlight(q.lx, q.ly, 2, 'side'); } content.loops++; }
        }
      }
    }
    // knight's-move rule: stair flights on different cliffs may not touch diagonally (the cliff needs room to turn).
    // An off-route stair tile in a diagonal clash goes back to cliff; if both are on the route, the gap between them
    // is filled with stairs so they become one flight.
    for (let pass = 0; pass < 4; pass++){
      const fl = new Int16Array(N*N).fill(-1); let nf = 0; const isSt = t => t === TILE.STAIRS || t === TILE.SIDE_STAIRS;
      for (let i0 = 0; i0 < N*N; i0++){ if (!isSt(T[i0]) || fl[i0] >= 0) continue; const q = [i0]; fl[i0] = nf;
        while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]){ const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            const ni = ny*N + nx; if (isSt(T[ni]) && fl[ni] < 0){ fl[ni] = nf; q.push(ni); } } }
        nf++; }
      let fixed = 0;
      for (let i = 0; i < N*N; i++){ if (fl[i] < 0) continue; const x = i % N, y = (i/N) | 0;
        for (const [dx, dy] of [[1, 1], [-1, 1]]){ const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const j = ny*N + nx; if (fl[j] < 0 || fl[j] === fl[i] || !isSt(T[i]) || !isSt(T[j])) continue;
          const victim = !trail[j] ? j : !trail[i] ? i : -1;
          if (victim >= 0 && !protectedMask[victim]){ T[victim] = F[victim] !== FACE.NONE ? TILE.CLIFF : TILE.ROCK; fixed++; }
          else for (const k2 of [y*N + nx, ny*N + x]) if (isCliffish(T[k2]) && !protectedMask[k2]){ T[k2] = stairsFor(F[k2]); fixed++; }
        } }
      if (!fixed) break;
    }

    // tall grass (long grass in wetland) on open ground and verges, off the route; position-keyed so seams match
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ly*N + lx; if (trail[i] || (T[i] !== TILE.OPEN && T[i] !== TILE.VERGE)) continue;
      if (grassAt(sx*N + lx, sy*N + ly, K[i])) T[i] = K[i] === CLS.WETLAND ? TILE.LONG_GRASS : TILE.TALL_GRASS;
    }

    // --- 7. Reachability with one-way ledges, trap removal, repair ---
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
        if (pts){ for (const q of pts){ carveDisc(q.lx, q.ly, 3, 0, 'main'); stairFlight(q.lx, q.ly, 3, 'main'); } repairs++; sLog.push(`repair ${repairs}: carved a 3-wide corridor from ${m.name} (${pts.length} tiles)`); }
      }
    }
    if (!ok() && required.length > 1){
      fallback = true; const c = { lx:Math.round(N/2), ly:Math.round(N/2) };
      const force = (cx, cy) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){ const x = cx + dx, y = cy + dy;
        if (!inInterior(x, y)) continue; const i = y*N + x; trail[i] = 1;
        if (T[i] === TILE.WATER){ if (RV[i]) T[i] = TILE.BRIDGE; }
        else if (isCliffish(T[i])) T[i] = stairsFor(F[i]); else if (!isPathish(T[i])) T[i] = wild ? TILE.OPEN : TILE.PATH; } };
      for (const r of required){ const g = r.gate;
        for (let x = Math.min(g.lx, c.lx); x <= Math.max(g.lx, c.lx); x++) force(x, g.ly);
        for (let y = Math.min(g.ly, c.ly); y <= Math.max(g.ly, c.ly); y++) force(c.lx, y); }
      sLog.push('fallback network used: straight corridors through the square centre');
    }
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

    let needsSurf = false;
    if (required.length > 1){ passable = i => WALKABLE[T[i]] === 1;
      const land = flood(required[0].i, false); needsSurf = required.some(q => !land[q.i]); passable = i => PASSABLE[T[i]] === 1; }
    if (needsSurf) sLog.push('needs Surf: some ports are joined only across water');
    let reach = 0, onPath = 0, ledges = 0, stairs = 0, cliffs = 0, bridges = 0, grass = 0;
    for (let i = 0; i < N*N; i++){
      const t = T[i];
      if (fw && fw[i] && WALKABLE[t]){ reach++; if (trail[i] || isPathish(t)) onPath++; if (t === TILE.TALL_GRASS || t === TILE.LONG_GRASS) grass++; }
      if (LEDGE_DIR[t]) ledges++; if (t === TILE.STAIRS || t === TILE.SIDE_STAIRS) stairs++; if (t === TILE.CLIFF) cliffs++; if (t === TILE.BRIDGE) bridges++;
    }
    content.pockets = content.pockets.filter(p => fw && fw[p.ly*N + p.lx]).length + ' reachable of ' + content.pockets.length;
    // stair looks: each connected flight gets one style (so different colours never touch); flights in the seam band
    // use the shared General tiles (stone); others take the style of the land cover around them
    const stairStyle = new Uint8Array(N*N), flightOf = new Int16Array(N*N).fill(-1), isSt = t => t === TILE.STAIRS || t === TILE.SIDE_STAIRS;
    let flights = 0, diagStairConflicts = 0;
    for (let i0 = 0; i0 < N*N; i0++){
      if (!isSt(T[i0]) || flightOf[i0] >= 0) continue;
      const list = [i0], q = [i0]; flightOf[i0] = flights;
      while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
        for (const [dx, dy] of DIRS){ const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue; const ni = ny*N + nx;
          if (isSt(T[ni]) && flightOf[ni] < 0){ flightOf[ni] = flights; list.push(ni); q.push(ni); } } }
      let style = 'stone';
      if (!list.some(i => protectedMask[i])){ const cnt = {};
        for (const i of list){ const st = (CROSSING[K[i]] || { style:'stone' }).style; cnt[st] = (cnt[st] || 0) + 1; }
        style = Object.keys(cnt).sort((p, q) => cnt[q] - cnt[p] || (p < q ? -1 : 1))[0]; }
      for (const i of list) stairStyle[i] = STAIR_STYLES.indexOf(style);
      flights++;
    }
    for (let i = 0; i < N*N; i++){ if (flightOf[i] < 0) continue; const x = i % N, y = (i/N) | 0;   // knight's-move check
      for (const [dx, dy] of [[1, 1], [-1, 1]]){ const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny*N + nx; if (flightOf[j] >= 0 && flightOf[j] !== flightOf[i]) diagStairConflicts++; } }
    let lmin = Infinity, lmax = -Infinity; for (let i = 0; i < N*N; i++) if (T[i] !== TILE.WATER){ lmin = Math.min(lmin, L[i]); lmax = Math.max(lmax, L[i]); }
    results.push({ x:sx, y:sy, N, wild, border, stairStyle, flights, diagStairConflicts, tiles:T, cls:K, level:L, trail, protectedMask, ports, junction, junctionSource, bridges, repairs, fallback,
                   unreachable, traps, trapFixes, needsSurf, waypoints:waypointCount, ledges, stairs, cliffs, content,
                   levels:isFinite(lmin) ? lmax - lmin + 1 : 0, offPathShare:reach && required.length ? (reach - onPath)/reach : null, grassShare:reach ? grass/reach : 0,
                   ndvi:inp.ndvi ? 'NDVI' : 'estimated from land cover',
                   log:sLog, connections:[...ports.map(p => ({ direction:['right', 'left', 'down', 'up'][p.side], to:p.neighbour, offset:0 })), ...sceneryLinks] });
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
    if (c.scenery) continue;                       // scenery maps are look-only: never entered, so no way back is needed
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
    offPathShare:+(() => { const v = results.map(r => r.offPathShare).filter(x => x !== null); return v.length ? v.reduce((p, q) => p + q, 0)/v.length : 1; })().toFixed(2), grassShare:+avg(r => r.grassShare).toFixed(2),
    wild:results.filter(r => r.wild).map(r => `${r.x},${r.y}`),
    spursGap:results.reduce((s, r) => s + r.content.spurs.gap, 0), spursTrail:results.reduce((s, r) => s + r.content.spurs.trail, 0),
    loops:results.reduce((s, r) => s + r.content.loops, 0), ponds:results.reduce((s, r) => s + r.content.ponds, 0),
    thicketTiles:results.reduce((s, r) => s + r.content.thicketTiles, 0), grassSource:inp.ndvi ? 'NDVI' : 'land cover estimate',
    terraceBlock:B, cliffRuns:runStats.runs, stairFlights:results.reduce((s, r) => s + r.flights, 0),
    diagStairConflicts:results.reduce((s, r) => s + r.diagStairConflicts, 0),
    scenery:scenery.map(s2 => `${s2.x},${s2.y} (seen from ${s2.seenFrom.join(', ')})`),
    borders:results.map(r => `${r.x},${r.y}:${r.border}`)
  };
  report.ok = !seamIssues.length && !reciprocal.length && !report.unreachable.length && !report.traps;
  return { version, N, band:BAND, window:win, squares:results, scenery, contracts, report, log };
}

// ----- Preview colours (RGBA image of the window; inactive squares are dimmed; higher levels are lighter) -----
const COLORS = {
  [TILE.OPEN]:[120, 200, 80], [TILE.PATH]:[232, 176, 96], [TILE.VERGE]:[164, 220, 110], [TILE.TREE]:[40, 112, 56],
  [TILE.ROCK]:[150, 120, 90], [TILE.WATER]:[72, 160, 224], [TILE.BRIDGE]:[176, 120, 64], [TILE.CLIFF]:[96, 78, 70],
  [TILE.LEDGE_S]:[196, 168, 112], [TILE.LEDGE_E]:[196, 168, 112], [TILE.LEDGE_W]:[196, 168, 112],
  [TILE.STAIRS]:[250, 246, 236], [TILE.SIDE_STAIRS]:[250, 236, 214], [TILE.TALL_GRASS]:[56, 150, 64], [TILE.LONG_GRASS]:[40, 128, 96]
};
// walkability view: walk / wall / surf / ledge
const WALK_COLORS = { walk:[206, 232, 176], wall:[58, 60, 72], surf:[72, 160, 224], ledge:[240, 150, 40] };
const STAIR_COLORS = [null, [214, 214, 222], [196, 146, 96], [240, 214, 156], [236, 244, 255]];   // stone, dirt, sand, snow
const BORDER_COLORS = { trees:[[34, 96, 48], [46, 118, 58]], rock:[[120, 96, 74], [140, 114, 88]], water:[[60, 140, 210], [84, 164, 228]] };
const walkClass = t => LEDGE_DIR[t] ? 'ledge' : t === TILE.WATER ? 'surf' : WALKABLE[t] ? 'walk' : 'wall';
const OPEN_TINT = { [CLS.DESERT]:[228, 208, 152], [CLS.SNOW]:[232, 240, 248], [CLS.TUNDRA]:[180, 188, 156], [CLS.WETLAND]:[112, 176, 144],
  [CLS.CROP]:[200, 204, 96], [CLS.URBAN]:[176, 172, 180], [CLS.DRY]:[168, 200, 96], [CLS.ROCKY]:[176, 160, 128] };
// opts.scale = pixels per tile. At 4 or more, tiles get glyphs: ledges show a dark lip and an arrow on the side you
// jump toward, stairs are striped across the climb (side stairs striped the other way), cliffs have a light top edge,
// bridges show planks, trees a dark rim.
const TILE_NAMES = ['open ground', 'path', 'verge', 'trees', 'rock', 'water', 'bridge', 'cliff',
  'ledge (jump south)', 'ledge (jump east)', 'ledge (jump west)', 'stairs', 'side stairs', 'tall grass', 'long grass (no running)'];
function toRGBA(res, opts = {}){
  const N = res.N, S = Math.max(1, opts.scale | 0 || 1), W = res.window.w*N*S, H = res.window.h*N*S, img = new Uint8ClampedArray(W*H*4);
  for (let i = 0; i < W*H; i++){ img[i*4] = 40; img[i*4 + 1] = 44; img[i*4 + 2] = 60; img[i*4 + 3] = 255; }
  const put = (x, y, c) => { const o = (y*W + x)*4; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const mul = (c, k) => [c[0]*k, c[1]*k, c[2]*k];
  const LIP = [70, 52, 40];
  // border blocks: what the engine shows beyond an edge with no connected map (within the 7 tiles the camera can see)
  const drawn = new Set([...res.squares, ...(res.scenery || [])].map(q => q.x + ',' + q.y));
  for (const s of res.squares){
    const pal = BORDER_COLORS[s.border || 'trees'];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]){
      const nx = s.x + dx, ny = s.y + dy;
      if (drawn.has(nx + ',' + ny) || nx < res.window.x0 || ny < res.window.y0 || nx >= res.window.x0 + res.window.w || ny >= res.window.y0 + res.window.h) continue;
      const ox = (nx - res.window.x0)*N, oy = (ny - res.window.y0)*N;
      for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
        const dist = dx === 1 ? lx : dx === -1 ? N - 1 - lx : dy === 1 ? ly : N - 1 - ly;
        if (dist >= BAND) continue;
        const c = pal[((lx >> 1) + (ly >> 1)) & 1];
        for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) put((ox + lx)*S + px, (oy + ly)*S + py, opts.mode === 'walk' ? WALK_COLORS.wall : c);
      }
    }
  }
  for (const s of [...res.squares, ...(res.scenery || [])]){
    const ox = (s.x - res.window.x0)*N, oy = (s.y - res.window.y0)*N;
    let lmin = Infinity; for (let i = 0; i < N*N; i++) lmin = Math.min(lmin, s.level[i]);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ly*N + lx, t = s.tiles[i];
      const walkMode = opts.mode === 'walk';
      let c = COLORS[t]; if ((t === TILE.OPEN || t === TILE.VERGE) && OPEN_TINT[s.cls[i]]) c = OPEN_TINT[s.cls[i]].map((v, k) => t === TILE.VERGE ? (v + COLORS[TILE.VERGE][k])/2 : v);
      if (t === TILE.OPEN && s.trail && s.trail[i]) c = c.map((v, k) => v*0.7 + COLORS[TILE.PATH][k]*0.3);   // a wild square's unmarked trail
      if ((t === TILE.STAIRS || t === TILE.SIDE_STAIRS) && s.stairStyle && s.stairStyle[i]) c = STAIR_COLORS[s.stairStyle[i]];
      if (s.blocked) c = c.map(v => v*0.55 + 30);   // scenery map: look-only, every tile blocked
      if (walkMode) c = s.blocked ? WALK_COLORS.wall : WALK_COLORS[walkClass(t)];
      // gentle shading by terrace level; paths, stairs and bridges stay unshaded so the route always reads clearly
      let k = walkMode || t === TILE.WATER || isPathish(t) ? 1 : Math.min(1.1, 0.86 + 0.06*(s.level[i] - lmin));
      if (opts.showBand && s.protectedMask && s.protectedMask[i] && !isPathish(t) && t !== TILE.VERGE) k *= 0.85;
      const base = mul(c, k), ld = LEDGE_DIR[t];
      for (let py = 0; py < S; py++) for (let px = 0; px < S; px++){
        let col = base;
        if (S >= 4){
          const m = (S - 1)/2;
          if (ld){
            const along = ld[1] ? py : ld[0] > 0 ? px : S - 1 - px;           // distance toward the jump side
            const across = ld[1] ? px : py;
            if (along >= S - Math.max(1, Math.round(S/4))) col = LIP;            // the lip you jump over
            else if (along >= Math.round(S/4) && Math.abs(across - m) <= (S - 1 - along - Math.round(S/4))*0.6 && along < S - Math.round(S/4)) col = mul(base, 0.6);  // arrow
          } else if (walkMode) col = base;
          else if (s.blocked && (px + py) % 4 === 0) col = mul(base, 0.75);
          else if (t === TILE.STAIRS) col = py % 2 ? mul(base, 0.72) : base;
          else if (t === TILE.TALL_GRASS || t === TILE.LONG_GRASS) col = (px % 2 === 0 && py % 3 !== 2) ? mul(base, 0.72) : base;
          else if (t === TILE.SIDE_STAIRS) col = px % 2 ? mul(base, 0.72) : base;
          else if (t === TILE.CLIFF) col = py < Math.max(1, S/4) ? mul(base, 1.6) : base;
          else if (t === TILE.BRIDGE) col = (px + py) % 3 === 0 ? mul(base, 0.7) : base;
          else if (t === TILE.TREE) col = (px === 0 || py === S - 1 || px === S - 1) ? mul(base, 0.75) : base;
        }
        put((ox + lx)*S + px, (oy + ly)*S + py, col);
      }
    }
  }
  if (opts.showSeams) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    if (x % (N*S) && y % (N*S)) continue; const o = (y*W + x)*4; img[o] = img[o]*0.6 + 102; img[o + 1] = img[o + 1]*0.6; img[o + 2] = img[o + 2]*0.6;
  }
  return { width:W, height:H, data:img, scale:S };
}
// What is at a pixel of the preview (for hover tooltips)
function describeAt(res, px, py, scale){
  const N = res.N, S = scale || 1, gx = Math.floor(px/S), gy = Math.floor(py/S);
  const sx = res.window.x0 + Math.floor(gx/N), sy = res.window.y0 + Math.floor(gy/N), lx = gx % N, ly = gy % N;
  const sq = res.squares.find(q => q.x === sx && q.y === sy), sc = (res.scenery || []).find(q => q.x === sx && q.y === sy);
  if (sc) return `square ${sx},${sy}: scenery map (look-only, nothing walkable) · ${TILE_NAMES[sc.tiles[(gy % N)*N + gx % N]]}`;
  if (!sq) return `square ${sx},${sy}: no route or town (border blocks shown where the camera would see them)`;
  const i = ly*N + lx;
  const st = (sq.tiles[i] === TILE.STAIRS || sq.tiles[i] === TILE.SIDE_STAIRS) && sq.stairStyle[i] ? ` (${STAIR_STYLES[sq.stairStyle[i]]})` : '';
  return `square ${sx},${sy}${sq.wild ? ' (wild)' : ''} · border ${sq.border} · tile ${lx},${ly} · ${TILE_NAMES[sq.tiles[i]]}${st}${sq.trail[i] ? ' · main route' : ''} · level ${sq.level[i]}${sq.protectedMask[i] ? ' · seam band' : ''}`;
}

const api = { VERSION, BAND, TILE, TILE_NAMES, CLS, PROFILE, LIMITS, COST, RELIEF, WAYPOINTS, WILD, CONTENT, generate, toRGBA, describeAt, makeSeeds, hash32, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.OverworldGen = api;
})(typeof self !== 'undefined' ? self : this);
