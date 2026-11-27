/* Region Map Forge — overworld map generator (prototype "ow-proto-5").
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
 *   4. Relief (proto-6, object-first): cliffs only from real elevation plus a mountain boost; narrow plateaus merge
 *      away before cliffs are drawn; cliffs are 1 tile thick, 2–3 on rugged ground, continuous by construction.
 *      Per square, stair flights are placed as whole prefabs (set into a straight cliff, flanked, full depth, 2 tiles of
 *      landing at both ends) by a plateau graph: fewest flights joining the ports and junction, then extras. Ledges are
 *      a separate layer on flat ground, each run kept only if nothing gets trapped. Read-only checks per square; a
 *      square that fails is regenerated with a new attempt seed and simpler relief, never patched.
 *   5. Edge contracts: one per linked edge (port position, path width, verge width), shared by both squares.
 *   6. Paths: straight approaches through the 7-tile seam band; inside, a winding least-cost path through 1–3
 *      seeded waypoints drawn to interesting spots (water's edge, clearings, high ground); path + verge widths from
 *      local land cover (Option C); bridges over rivers; stairs where the path climbs a cliff.
 *   7. Validation: reachability that understands one-way ledges (every port reaches every other and back), A* repair
 *      through walls on one level, relief checks by structure ID, region-wide checks, and an off-path exploration share.
 *
 * Tiles are abstract classes (see TILE). Picking real metatiles comes in a later step.
 * Pure functions, no DOM: runs in the browser (window.OverworldGen) and in Node (module.exports) for tests.
 */
(function (root) {
'use strict';

const VERSION = 'ow-proto-7';
const BAND = 7;                                    // seam band depth in metatiles (pokeemerald MAP_OFFSET = 7)
const PAD = 8;                                     // raster margin around the window so results don't depend on it

// ----- Tile classes -----
const TILE = { OPEN:0, PATH:1, VERGE:2, TREE:3, ROCK:4, WATER:5, BRIDGE:6, CLIFF:7,
               LEDGE_S:8, LEDGE_E:9, LEDGE_W:10, STAIRS:11, SIDE_STAIRS:12, TALL_GRASS:13, LONG_GRASS:14, LEDGE_CORNER:15, ROCK_CLIMB:16 };
const NTILE = 17;
const WALKABLE = [1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0];
const PASSABLE = [1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0];   // walkable, or crossable with Surf (water); Rock Climb walls need the move
const LEDGE_DIR = { [TILE.LEDGE_S]:[0, 1], [TILE.LEDGE_E]:[1, 0], [TILE.LEDGE_W]:[-1, 0] };
const isWall = t => t === TILE.TREE || t === TILE.ROCK;
const isCliffish = t => t === TILE.CLIFF || t === TILE.ROCK_CLIMB || t === TILE.LEDGE_S || t === TILE.LEDGE_E || t === TILE.LEDGE_W || t === TILE.LEDGE_CORNER;
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
// Relief (proto-7). mtnBoost: extra levels on rugged ground (not from the contours); mtnShelves / shelfScale: a finer
// noise octave (amplitude in levels, scale in tiles) adds narrow shelves on rugged ground; morphLow / morphMtn: closing+opening radius in tiles (lowland
// plateaus at least 2r+1 wide; mountain shelves only lose 1-tile specks); straightShare: share of hills with straight
// sides (the rest are pyramids); faceLow / faceMtn: height of south faces and east/west sides (north rims are 1);
// ruggedMin: rugged share that switches to mountain mode and lifts the stair cap to 12; steepSlope: grade that counts
// as fully rugged. Starting values (Claude's judgment).
const RELIEF = { minStepM:12, stepDivisor:3, compress:1.5, noise:0.25, mtnBoost:2.5, mtnShelves:2, shelfScale:14, morphLow:4, morphMtn:2,
                 straightShare:0.5, faceLow:2, faceMtn:3, ruggedMin:0.4, steepSlope:0.3 };
const STAIRS = { per100:1, cap:8, capRugged:12, gap:4, minNew:8 };
// Rock Climb walls (owner, 2026-11-27: both roles): reward shelves reachable only by Rock Climb, and shortcuts beside
// a longer stair route. Per square at most `rewards` and `shortcuts`; a shortcut joins shelves `minHops`+ flights apart.
const ROCK_CLIMB = { rewards:2, shortcuts:1, shortcutChance:0.5, minHops:2, minShelf:8 };
const STAIR_WIDTH = { 1:1, 6:1, 2:1, 3:3, 9:3 };
// Ledges (Emerald's routes): ledge tiles per 100 walkable tiles by land cover; runs of 3+ tiles; turn chance; share
// allowed with no wall at either end.
const LEDGES = { density:{ 0:5, 8:5, 5:4, 10:5, 4:3, 7:3, 3:1.2, 2:1, 1:0.4, 6:0.3, 9:0 }, maxExtra:9, turnChance:0.4, openBothEnds:0.15, tries:300 };
// Retry ladder: each attempt gets a new seed; later ones simplify (fewer extra flights, fewer ledges). Shared edge
// contracts never change between attempts.
const ATTEMPTS = [{ name:'full', extras:1, ledges:1 }, { name:'full, new seed', extras:1, ledges:1 }, { name:'fewer extras', extras:0.5, ledges:0.5 },
                  { name:'essential crossings only', extras:0, ledges:0 },
                  { name:'simpler interior relief (radius 2)', extras:0.5, ledges:0.5, simplify:2 },
                  { name:'simpler interior relief (radius 4)', extras:0, ledges:0, simplify:4 },
                  { name:'simpler interior relief (radius 7)', extras:0, ledges:0, simplify:7 },
                  { name:'flat interior with lead-ins', extras:0, ledges:0.5, simplify:1, flat:true }];
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
  const subClass = new Uint8Array(SW*SH), peak = new Uint8Array(SW*SH), hillSub = new Uint8Array(SW*SH);
  const PSEUDO_ELEV = [0, 20, 150, 400, 700];      // used only when the region has no elevation data
  const elevSub = new Float32Array(SW*SH);
  for (let i = 0; i < SW*SH; i++){
    const t = inp.terrain[i];
    if (t === FORGE_T.SEA || (inp.lake && inp.lake[i])) subClass[i] = CLS.WATER;
    else if (t === FORGE_T.MTN || t === FORGE_T.PEAK) { subClass[i] = CLS.ROCKY; peak[i] = t === FORGE_T.PEAK ? 1 : 0; }
    else subClass[i] = Math.min(inp.cover ? inp.cover[i] : 0, 9);
    elevSub[i] = inp.elev ? (inp.elev[i] || 0) : PSEUDO_ELEV[t] || 0;
    if (t === FORGE_T.HILL) hillSub[i] = 1;
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
  // land-only elevation (water cells at the lowest land height) for slopes, so sea-floor depths never look like steep ground
  const elevLandSub = elevSub.map((e, i) => subClass[i] === CLS.WATER ? elevMin : e);
  return {
    SW, SH, subClass, peak, stepM, elevMin,
    shares(gx, gy){ const s = new Float64Array(NCLS); for (const [i, w] of weights(gx, gy)) s[subClass[i]] += w; return s; },
    elev(gx, gy){ let e = 0; for (const [i, w] of weights(gx, gy)) e += w*elevSub[i]; return e; },
    elevLand(gx, gy){ let e = 0; for (const [i, w] of weights(gx, gy)) e += w*elevLandSub[i]; return e; },
    sub:inp.sub, SW, SH,
    isWater(gx, gy){ const sx = Math.floor(gx/N*inp.sub), sy = Math.floor(gy/N*inp.sub);
      return sx >= 0 && sy >= 0 && sx < SW && sy < SH ? subClass[sy*SW + sx] === CLS.WATER : true; },
    hill(gx, gy){ let e = 0; for (const [i, w] of weights(gx, gy)) e += w*hillSub[i]; return e; },
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
  // relief (proto-7): cliffs come only from real elevation, plus a mountain boost. Two modes, by ruggedness:
  //  · lowland — broad plateaus (narrower ones merge away), few cliffs;
  //  · mountain — more levels and narrow shelves (2–4 tiles), like Emerald's Routes 112, 114, 115.
  // Two hill shapes, both decided (2026-11-27): straight-sided hills (levels taken per B×B block) and pyramid hills
  // (levels per tile, so sides step inward going north). A smooth seeded mask mixes them across the region.
  // Face height (decided): south faces and east/west sides are `h` tiles (2, or 3 on the region's mountain levels);
  // north edges are a 1-tile rim. h depends only on the level of the high side, so a cliff keeps one height along
  // its whole length. All of this is computed on a grid with a wide margin, so it never depends on the window.
  const B = inp.terraceBlock === 3 ? 3 : 4, LM = 28;
  const EX0 = RX0 - LM, EY0 = RY0 - LM, EW = RW + 2*LM, EH = RH + 2*LM;
  const sMtn = seeds.layer('mountain'), sShape = seeds.layer('hillShape'), sShelf = seeds.layer('shelves');
  const mpt = (inp.kmPerSquare || 1)*1000/N;
  const ruggedParts = (gx, gy) => {
    const s = sampler.shares(gx, gy), cls3 = s[CLS.ROCKY] + s[CLS.SNOW] + s[CLS.TUNDRA] + sampler.hill(gx, gy);
    const ex = sampler.elevLand(gx + 2, gy) - sampler.elevLand(gx - 2, gy), ey = sampler.elevLand(gx, gy + 2) - sampler.elevLand(gx, gy - 2);
    const slope = Math.hypot(ex, ey)/(4*mpt);
    return [Math.min(1, cls3), Math.min(1, slope/RELIEF.steepSlope)];
  };
  const rugged = (gx, gy) => { const [a, b] = ruggedParts(gx, gy); return Math.max(a, b); };   // 0–1: rugged cover/terrain, or steep real ground
  // continuous height in level units: log-compressed elevation, mountain boost, and more levels on rugged ground
  const heightAt = (gx, gy) => {
    const R = rugged(gx, gy);
    const e = sampler.elev(gx, gy) + RELIEF.noise*sampler.stepM*(2*smoothNoise(sLev, gx, gy, 7) - 1);
    const d = Math.max(0, (e - sampler.elevMin)/sampler.stepM);
    const base = RELIEF.compress*Math.log2(1 + d/RELIEF.compress) + RELIEF.mtnBoost*R*smoothNoise(sMtn, gx, gy, 10);
    // mountain shelves: a finer noise octave adds extra contour rings on rugged ground (never a multiplier on absolute
    // height, which would turn changes in ruggedness into walls)
    const m = Math.max(0, Math.min(1, (R - RELIEF.ruggedMin)/0.3));
    return { h:base + m*RELIEF.mtnShelves*smoothNoise(sShelf, gx, gy, RELIEF.shelfScale), mtn:R >= RELIEF.ruggedMin };
  };
  let elev2 = new Int16Array(EW*EH); const mtnMask = new Uint8Array(EW*EH);
  const blockH = new Map();
  for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++){
    const gx = EX0 + x, gy = EY0 + y;
    const straight = smoothNoise(sShape, gx, gy, 24) < RELIEF.straightShare;
    let hv;
    if (straight){ const bx = Math.floor(gx/B), by = Math.floor(gy/B), key = bx + ',' + by;
      if (!blockH.has(key)) blockH.set(key, heightAt(bx*B + B/2, by*B + B/2)); hv = blockH.get(key); }
    else hv = heightAt(gx, gy);
    elev2[y*EW + x] = Math.floor(hv.h); mtnMask[y*EW + x] = hv.mtn ? 1 : 0;
  }
  // grey-scale closing then opening; radius by mode (lowland: broad plateaus; mountain: only 1-tile specks go)
  const morph = (src, useMax) => { const out = new Int16Array(EW*EH);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++){
      const r = mtnMask[y*EW + x] ? RELIEF.morphMtn : RELIEF.morphLow;
      let v = useMax ? -32768 : 32767;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++){
        const xx = Math.min(EW - 1, Math.max(0, x + dx)), yy = Math.min(EH - 1, Math.max(0, y + dy)), w = src[yy*EW + xx];
        v = useMax ? Math.max(v, w) : Math.min(v, w); }
      out[y*EW + x] = v; }
    return out; };
  elev2 = morph(morph(elev2, true), false);
  elev2 = morph(morph(elev2, false), true);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) lev[y*RW + x] = elev2[(y + LM)*EW + x + LM];
  // the region's mountain levels: the median level of rugged land (whole region, so the same for every window)
  const mtnLevel = (() => {
    const SN = N/sampler.sub, vals = []; let land = 0;
    for (let sy = 0; sy < sampler.SH; sy++) for (let sx = 0; sx < sampler.SW; sx++){
      const gx = (sx + 0.5)*SN, gy = (sy + 0.5)*SN; if (sampler.isWater(gx, gy)) continue; land++;
      const hv = heightAt(gx, gy); if (hv.mtn) vals.push(Math.floor(hv.h)); }
    if (vals.length < 0.1*land || !vals.length) return Infinity;
    vals.sort((a, b) => a - b); return vals[vals.length >> 1];
  })();
  const faceH = L => L >= mtnLevel ? RELIEF.faceMtn : RELIEF.faceLow;
  const baseTiles = tiles.slice();
  const depth = new Uint8Array(RW*RH), corner = new Uint8Array(RW*RH);
  const FD = [[FACE.S, 0, 1], [FACE.E, 1, 0], [FACE.W, -1, 0], [FACE.N, 0, -1]];
  // A land tile is cliff when lower land lies within its face box: h tiles south, east and west, 1 tile north. It
  // faces the one straight direction with lower land within reach; two directions, or only diagonal lower land, make
  // it a corner piece (never stairs, never a flank). depth = how far the lower land is along the face.
  const computeCliffs = () => {
    tiles.set(baseTiles); face.fill(FACE.NONE); depth.fill(0); corner.fill(0);
    const lower = (x, y, L) => { if (x < 0 || y < 0 || x >= RW || y >= RH) return false; const j = y*RW + x; return !water[j] && lev[j] < L; };
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
      const i = y*RW + x; if (water[i]) continue;
      const L = lev[i], h = faceH(L);
      let any = false;
      for (let dy = -1; dy <= h && !any; dy++) for (let dx = -h; dx <= h; dx++) if (lower(x + dx, y + dy, L)){ any = true; break; }
      if (!any) continue;
      tiles[i] = TILE.CLIFF;
      let nf = 0, f = FACE.NONE, k0 = 0;
      for (const [fc, dx, dy] of FD){
        const reach = fc === FACE.N ? 1 : h;
        for (let k = 1; k <= reach; k++){ const nx = x + dx*k, ny = y + dy*k; if (nx < 0 || ny < 0 || nx >= RW || ny >= RH) break;
          const j = ny*RW + nx; if (water[j]) break;
          if (lev[j] < L){ nf++; f = fc; k0 = k; break; } }
      }
      if (nf === 1){ face[i] = f; depth[i] = k0; } else corner[i] = 1;
    }
  };
  computeCliffs();
  const globalCorner = corner;
  const baseWater = (gx, gy) => water[ri(gx, gy)];

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
    // an approach stays on one level: slide to dry land with no cliff across it (road ports only a little)
    const lakeAt = pos => approachCells(pos, i => (water[i] && !river[i]) || tiles[i] === TILE.CLIFF);
    if (lakeAt(clamped)){
      for (let off = 1; off <= (source === 'road' ? 3 : cMax - cMin); off++){
        const cand = [clamped - off, clamped + off].find(q => q >= cMin && q <= cMax && !lakeAt(q));
        if (cand !== undefined){ notes.push(`port moved ${clamped} → ${cand} to keep the approach on dry land and on one level`); clamped = cand; break; }
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
  // approaches stay on one level: where a cliff still crosses a port's approach (both sides, path + verge + a margin,
  // through the seam band and a few tiles past it), that rectangle takes its most common level and cliffs are redrawn.
  // Region-level and position-keyed, so both sides of the seam agree.
  // Approaches near the same corner can overlap, so overlapping rectangles are levelled together as one group.
  let flattened = 0;
  const rects = contracts.map(k => {
    const sideA = k.horiz ? 0 : 2, sideB = k.horiz ? 1 : 3, m = k.verge + 3, cells = [];
    for (const [sq, side] of [[k.a, sideA], [k.b, sideB]]) for (let d = 0; d <= BAND + 4; d++) for (let t = k.pos - k.lo - m; t <= k.pos + k.hi + m; t++){
      if (t < 0 || t >= N) continue;
      const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
      const gx = sq.x*N + lx, gy = sq.y*N + ly; if (inR(gx, gy)) cells.push(ri(gx, gy)); }
    return { k, cells, set:new Set(cells) }; });
  const grp = rects.map((_, i) => i), gf = a => { while (grp[a] !== a) a = grp[a] = grp[grp[a]]; return a; };
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
    if (rects[i].cells.some(c => rects[j].set.has(c))) grp[gf(i)] = gf(j);
  for (let pass = 0; pass < 3; pass++){
    let changed = false;
    const groups = new Map(); rects.forEach((r, i) => { const g = gf(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
    for (const rs of groups.values()){
      const cells = [...new Set(rs.flatMap(r => r.cells))];
      if (!cells.some(i => tiles[i] === TILE.CLIFF)) continue;
      const cnt = new Map(); for (const i of cells) if (!water[i]) cnt.set(lev[i], (cnt.get(lev[i]) || 0) + 1);
      let best = null; for (const [v, n] of cnt) if (!best || n > best[1] || (n === best[1] && v < best[0])) best = [v, n];
      if (!best) continue;
      for (const i of cells) lev[i] = best[0];
      for (const r of rs) if (!r.k.notes.includes('approach levelled (a cliff crossed it)')) r.k.notes.push('approach levelled (a cliff crossed it)');
      flattened++; changed = true;
    }
    if (!changed) break;
    computeCliffs();
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
  const squareRugged = (x, y) => { let r = 0, n = 0;
    for (let ly = 2; ly < N; ly += 4) for (let lx = 2; lx < N; lx += 4){ r += rugged(x*N + lx, y*N + ly); n++; } return r/n; };
  const buildSquare = (sq, attempt) => {
    const sx = sq.x, sy = sq.y, id = sqId(sx, sy), sLog = [], wild = wildSet.has(id);
    const T = new Uint8Array(N*N), K = new Uint8Array(N*N), L = new Int16Array(N*N), F = new Uint8Array(N*N), RV = new Uint8Array(N*N), D = new Uint8Array(N*N);
    const protectedMask = new Uint8Array(N*N), trail = new Uint8Array(N*N);   // trail: the main route (path tiles, or natural ground in wild squares)
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ri(sx*N + lx, sy*N + ly), j = ly*N + lx;
      T[j] = tiles[i]; K[j] = cls[i]; L[j] = lev[i]; F[j] = face[i]; RV[j] = river[i]; D[j] = depth[i];
    }
    const inBand = (lx, ly) => lx < BAND || ly < BAND || lx >= N - BAND || ly >= N - BAND;
    const corner = new Uint8Array(N*N);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++) corner[ly*N + lx] = globalCorner[ri(sx*N + lx, sy*N + ly)];
    // later retries simplify the relief inside the square: levels more than 3 tiles inside the seam band get a
    // closing + opening of the given radius, and cliffs are redrawn inside the band by the same face rules. The band
    // and the 3-tile ring next to it keep their levels, so the band's cliffs (and the seams) never change.
    const simplifyR = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)].simplify || 0;
    if (simplifyR){
      const inner = (x, y) => x >= BAND + 3 && y >= BAND + 3 && x < N - BAND - 3 && y < N - BAND - 3;
      const wl = j => RV[j] || baseWater(sx*N + j % N, sy*N + ((j/N) | 0));
      const filt = (src, useMax) => { const out = src.slice();
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++){ if (!inner(x, y)) continue; let v = useMax ? -32768 : 32767;
          for (let dy = -simplifyR; dy <= simplifyR; dy++) for (let dx = -simplifyR; dx <= simplifyR; dx++){
            const xx = Math.min(N - 1, Math.max(0, x + dx)), yy = Math.min(N - 1, Math.max(0, y + dy)), w = src[yy*N + xx];
            v = useMax ? Math.max(v, w) : Math.min(v, w); }
          out[y*N + x] = v; }
        return out; };
      let L2 = filt(filt(L, true), false); L2 = filt(filt(L2, false), true); L.set(L2);
      if (ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)].flat){
        // last resort: the inner area takes one level; a lead-in in front of each port keeps that port's level, so each
        // level change is one straight cliff across the end of a lead-in, wide enough for a flight with both landings
        const leads = [];
        for (let side = 0; side < 4; side++){ const k = contractOf.get(id + ':' + side); if (!k) continue;
          const cell = (d, t) => side <= 1 ? [side === 0 ? N - 1 - d : d, t] : [t, side === 2 ? N - 1 - d : d];
          const [gx0, gy0] = cell(BAND, k.pos); leads.push({ side, k, cell, lv:L[gy0*N + gx0] }); }
        const Lstar = leads.length ? leads[0].lv : L[(N >> 1)*N + (N >> 1)];
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inner(x, y) && !wl(y*N + x)) L[y*N + x] = Lstar;
        for (const ld of leads){ const m = ld.k.verge + 3;
          for (let d = BAND + 3; d <= BAND + 10; d++) for (let t = ld.k.pos - ld.k.lo - m; t <= ld.k.pos + ld.k.hi + m; t++){
            if (t < 0 || t >= N) continue; const [x, y] = ld.cell(d, t); if (inner(x, y) && !wl(y*N + x)) L[y*N + x] = ld.lv; } }
      }
      for (let y = BAND; y < N - BAND; y++) for (let x = BAND; x < N - BAND; x++){
        const j = y*N + x, gi = ri(sx*N + x, sy*N + y); if (wl(j)) continue;
        T[j] = baseTiles[gi]; F[j] = FACE.NONE; D[j] = 0; corner[j] = 0;
        const Lj = L[j], h = faceH(Lj), lower = (xx, yy) => { if (xx < 0 || yy < 0 || xx >= N || yy >= N) return false; const k = yy*N + xx; return !wl(k) && L[k] < Lj; };
        let any = false;
        for (let dy = -1; dy <= h && !any; dy++) for (let dx = -h; dx <= h; dx++) if (lower(x + dx, y + dy)){ any = true; break; }
        if (!any) continue;
        T[j] = TILE.CLIFF; let nf = 0, f = FACE.NONE, k0 = 0;
        for (const [fc, dx, dy] of FD){ const reach = fc === FACE.N ? 1 : h;
          for (let k = 1; k <= reach; k++){ const nx = x + dx*k, ny = y + dy*k; if (nx < 0 || ny < 0 || nx >= N || ny >= N || wl(ny*N + nx)) break;
            if (L[ny*N + nx] < Lj){ nf++; f = fc; k0 = k; break; } } }
        if (nf === 1){ F[j] = f; D[j] = k0; } else corner[j] = 1;
      }
      sLog.push(ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)].flat ? 'interior flattened, with a lead-in at each port' : `relief simplified inside the square (radius ${simplifyR})`);
    }
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
          else if (T[i] === TILE.CLIFF){ /* approaches are levelled region-wide; a leftover cliff is reported by the checks */ }
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

    const sSq = attempt ? seeds.attempt(seeds.square(sx, sy), attempt) : seeds.square(sx, sy), sNoise = hash32(sSq, strHash('noise')), sWay = hash32(sSq, strHash('waypoints'));
    const rSq = mulberry32(hash32(sSq, strHash('content')));
    const roadTiles = roadTilesFor(sx, sy);
    const used = new Uint8Array(N*N);
    const tileCost = (lx, ly) => {
      const i = ly*N + lx, gx = sx*N + lx, gy = sy*N + ly;
      if (T[i] === TILE.WATER) return RV[i] ? COST.riverCrossing : COST.surf;
      let c = PROFILE[K[i]].cost;
      if (sampler.isPeak(gx, gy)) c = COST.peak;
      if (isWall(T[i])) c += 1;
      if (isCliffish(T[i])) return Infinity;      // cliffs are crossed only by placed flights
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
      // the junction must stand on ground (not a cliff or water): nearest interior ground tile
      if (T[junction.ly*N + junction.lx] === TILE.CLIFF || T[junction.ly*N + junction.lx] === TILE.WATER){
        let best = null;
        for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++){ const t = T[y*N + x]; if (t === TILE.CLIFF || t === TILE.WATER) continue;
          const d = Math.abs(x - junction.lx) + Math.abs(y - junction.ly); if (!best || d < best.d) best = { d, x, y }; }
        if (best){ junction = { lx:best.x, ly:best.y }; junctionSource += ', moved off a cliff or water'; }
      }
    }

    // --- Relief objects: stair flights (proto-6) ---
    // A flight is one prefab: straight, on a straight cliff segment, set into the cliff with cliff on both flanks for every
    // row, the full depth of the cliff, and 2 clear tiles of ground straight out at both ends (its landings). Nothing is
    // ever patched: a flight is placed whole or not at all, and every tile it uses is claimed in the reservation grid.
    // A plateau graph picks the fewest flights that join everything the route needs, then extras by what they add, up to
    // 1 flight per 100 walkable tiles (cap 8, or 12 on rugged ground).
    const RES = new Uint8Array(N*N);                 // 0 free · 1 stair · 2 landing · 3 ledge
    const flightList = [];
    const plan = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];
    const isLand = i => T[i] !== TILE.WATER && T[i] !== TILE.CLIFF && !LEDGE_DIR[T[i]] && T[i] !== TILE.LEDGE_CORNER;
    // plateaus: interior ground at one level; water joins whatever it touches (Surf)
    const pid = new Int32Array(N*N).fill(-1), pSize = [];
    for (let i0 = 0; i0 < N*N; i0++){
      const x0 = i0 % N, y0 = (i0/N) | 0;
      if (pid[i0] >= 0 || !inInterior(x0, y0) || T[i0] === TILE.CLIFF) continue;
      const id = pSize.length, q = [i0]; pid[i0] = id; let n = 0;
      while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0; if (T[c] !== TILE.WATER) n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]){ const nx = x + dx, ny = y + dy; if (!inInterior(nx, ny)) continue;
          const ni = ny*N + nx; if (pid[ni] >= 0 || T[ni] === TILE.CLIFF) continue;
          if (T[c] === TILE.WATER || T[ni] === TILE.WATER || L[ni] === L[c]){ pid[ni] = id; q.push(ni); } } }
      pSize.push(n);
    }
    const widthFor = c => STAIR_WIDTH[c] || 2;
    const FV = { [FACE.S]:[0, 1], [FACE.N]:[0, -1], [FACE.E]:[1, 0], [FACE.W]:[-1, 0] };
    const cands = [];
    const at = (x, y) => (x >= 0 && y >= 0 && x < N && y < N) ? y*N + x : -1;
    for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++){
      const e = y*N + x; if (T[e] !== TILE.CLIFF || F[e] === FACE.NONE || D[e] !== 1) continue;   // an edge tile of a straight face
      const f = F[e], [dx, dy] = FV[f], ax = dy ? 1 : 0, ay = dy ? 0 : 1;   // dx,dy: downhill · ax,ay: along the cliff
      const wl = widthFor(K[e]);
      for (let w = wl; w >= 1; w--){
        const cols = []; let ok = true, dep = -1;
        for (let u = 0; u < w && ok; u++){
          const cx = x + ax*u, cy = y + ay*u, c0 = at(cx, cy);
          if (c0 < 0 || T[c0] !== TILE.CLIFF || F[c0] !== f || D[c0] !== 1){ ok = false; break; }
          const col = [c0]; let k = 1;
          while (true){ const j = at(cx - dx*k, cy - dy*k); if (j < 0 || T[j] !== TILE.CLIFF || F[j] !== f) break; col.push(j); k++; }
          if (dep < 0) dep = col.length; else if (col.length !== dep){ ok = false; break; }
          if (dep > 6){ ok = false; break; }
          cols.push({ cx, cy, col });
        }
        if (!ok) continue;
        const tilesF = cols.flatMap(c => c.col), land = [];
        // flanks: straight cliff of the same face beside every row (never a corner, never the end of a segment)
        for (const u of [-1, w]) for (let r = 0; r < dep && ok; r++){
          const j = at(x + ax*u - dx*r, y + ay*u - dy*r); if (j < 0 || T[j] !== TILE.CLIFF || F[j] !== f || corner[j]) ok = false; }
        if (!ok) continue;
        let lowLev = null, highLev = null;
        for (const c of cols) for (const [sgn, base] of [[1, 0], [-1, dep - 1]]){
          for (let k = 1; k <= 2 && ok; k++){
            const lx = c.cx + sgn*dx*(sgn > 0 ? k : base + k), ly = c.cy + sgn*dy*(sgn > 0 ? k : base + k), j = at(lx, ly);
            if (j < 0 || !inInterior(lx, ly) || !isLand(j) || RES[j] === 1){ ok = false; break; }
            if (sgn > 0){ if (lowLev === null) lowLev = L[j]; else if (L[j] !== lowLev) ok = false; }
            else { if (highLev === null) highLev = L[j]; else if (L[j] !== highLev) ok = false; }
            land.push(j);
          }
        }
        if (!ok || highLev <= lowLev || tilesF.some(j => !inInterior(j % N, (j/N) | 0))) continue;
        const lowP = pid[at(x + dx, y + dy)], highP = pid[at(x - dx*dep, y - dy*dep)];
        if (lowP < 0 || highP < 0 || lowP === highP) continue;
        cands.push({ f, w, dep, tiles:tilesF, land, lowP, highP, x, y, cls:K[e], preferred:w === wl });
      }
    }
    // spacing: no other flight within `gap` tiles (Emerald: median 8 tiles apart). The knight's-move rule (gap 1) is the
    // hard minimum; a required crossing falls back to it only when no well-spaced site exists.
    const fits = (c, gap = STAIRS.gap) => c.tiles.every(j => RES[j] === 0) && c.land.every(j => RES[j] !== 1) &&
      c.tiles.every(j => { const x = j % N, y = (j/N) | 0;
        for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++){ const k = at(x + dx, y + dy); if (k >= 0 && RES[k] === 1) return false; }
        return true; }) &&
      c.land.every(j => { const x = j % N, y = (j/N) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]){ const k = at(x + dx, y + dy); if (k >= 0 && RES[k] === 1 && !c.tiles.includes(k)) return false; }
        return true; });
    const uf = pSize.map((_, i) => i), ufFind = a => { while (uf[a] !== a){ uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
    const place = c => { const id = flightList.length;
      for (const j of c.tiles){ RES[j] = 1; T[j] = stairsFor(c.f); }
      for (const j of c.land){ if (!RES[j]) RES[j] = 2; if (isWall(T[j])) T[j] = TILE.OPEN; }
      uf[ufFind(c.lowP)] = ufFind(c.highP);
      flightList.push({ id, face:c.f, width:c.w, depth:c.dep, tiles:c.tiles, land:c.land, x:c.x, y:c.y, lowP:c.lowP, highP:c.highP,
                        style:(CROSSING[c.cls] || { style:'stone' }).style, why:c.why }); };
    const rSt = mulberry32(hash32(sSq, strHash('stairs')));
    const reqP = [...new Set(ports.map(p => pid[p.gate.ly*N + p.gate.lx]).concat(junction ? [pid[junction.ly*N + junction.lx]] : []))].filter(p => p >= 0);
    const planIssues = [];
    // 1. required: join the plateaus of every port (and the junction) with the fewest flights (BFS over plateaus)
    for (let guard = 0; guard < 20; guard++){
      const root = reqP.length ? ufFind(reqP[0]) : -1;
      const missing = reqP.filter(p => ufFind(p) !== root); if (!missing.length) break;
      const adj = new Map();
      for (const c of cands){ if (!fits(c, 1)) continue; const a = ufFind(c.lowP), b = ufFind(c.highP); if (a === b) continue;
        for (const [p, q] of [[a, b], [b, a]]){ if (!adj.has(p)) adj.set(p, []); adj.get(p).push([q, c]); } }
      const prev = new Map([[root, null]]), queue = [root]; let goal = -1;
      const wanted = new Set(missing.map(ufFind));
      while (queue.length && goal < 0){ const p = queue.shift();
        for (const [q, c] of (adj.get(p) || [])) if (!prev.has(q)){ prev.set(q, [p, c]); if (wanted.has(q)){ goal = q; break; } queue.push(q); } }
      if (goal < 0){ planIssues.push(`PLAN: no stair site joins the plateau of a port or the junction`); break; }
      const steps = []; for (let q = goal; prev.get(q); q = prev.get(q)[0]) steps.push(prev.get(q));
      for (const [p, cFirst] of steps.reverse()){
        // among all fitting sites between these two plateau groups, prefer the land-cover width, then a seeded pick
        const a = ufFind(cFirst.lowP), b = ufFind(cFirst.highP);
        const near = cands.filter(c => fits(c, 1) && ((ufFind(c.lowP) === a && ufFind(c.highP) === b) || (ufFind(c.lowP) === b && ufFind(c.highP) === a)));
        const spaced = near.filter(c => fits(c)), opts = spaced.length ? spaced : near;
        const pref = opts.filter(c => c.preferred), pool = pref.length ? pref : opts;
        const c = pool[Math.floor(rSt()*pool.length)] || cFirst; c.why = 'required'; place(c);
      }
    }
    sLog.push(`stair sites: ${cands.length} (${cands.filter(fits).length} still free)`);
    // 2. extras, scored by what they add: a new plateau to explore (more for a bigger one), else a loop
    let walkable = 0; for (let i = 0; i < N*N; i++) if (T[i] !== TILE.WATER && T[i] !== TILE.CLIFF && !isWall(T[i])) walkable++;
    const ruggedVal = squareRugged(sx, sy), ruggedSq = ruggedVal >= RELIEF.ruggedMin;
    const target = Math.min(ruggedSq ? STAIRS.capRugged : STAIRS.cap, Math.round(walkable*STAIRS.per100/100)*plan.extras);
    for (let guard = 0; flightList.length < target && guard < 40; guard++){
      const root = reqP.length ? ufFind(reqP[0]) : -1;
      let best = null, bestS = -Infinity;
      for (const c of cands){ if (!fits(c)) continue;
        // an extra flight must open something new: one end on ground the player can already reach, the other not
        const a = ufFind(c.lowP), b = ufFind(c.highP); if ((a === root) === (b === root)) continue;
        const other = a === root ? c.highP : c.lowP; if (pSize[other] < STAIRS.minNew) continue;
        let s = 2 + Math.min(1, pSize[other]/150) - (c.preferred ? 0 : 0.3);
        for (const fl of flightList) if (Math.abs(fl.x - c.x) + Math.abs(fl.y - c.y) < 5) s -= 0.4;   // spread them out
        s += 0.5*rSt();
        if (s > bestS){ bestS = s; best = c; } }
      if (!best || bestS < 0) break;
      best.why = 'extra'; place(best);
    }
    // 3. Rock Climb walls: the same prefab geometry on a south or north face (a straight climb), tiles = ROCK_CLIMB.
    //    reward: opens a shelf nothing else reaches · shortcut: joins two reachable shelves that are 2+ flights apart.
    const climbList = [];
    const hops = (from, to) => {                      // flights between two plateau groups over placed flights only
      const adj = new Map(); for (const fl of flightList){ const a = fl.lowP, b = fl.highP;
        for (const [p, q] of [[a, b], [b, a]]){ if (!adj.has(p)) adj.set(p, []); adj.get(p).push(q); } }
      const dist = new Map([[from, 0]]), q = [from];
      while (q.length){ const p = q.shift(); if (p === to) return dist.get(p); for (const r of adj.get(p) || []) if (!dist.has(r)){ dist.set(r, dist.get(p) + 1); q.push(r); } }
      return Infinity; };
    const climbable = cands.filter(c => (c.f === FACE.S || c.f === FACE.N) && c.w <= 2 && fits(c));
    const rootNow = () => reqP.length ? ufFind(reqP[0]) : -1;
    for (let n = 0; n < ROCK_CLIMB.rewards; n++){
      const root = rootNow(), opts = climbable.filter(c => fits(c) && ((ufFind(c.lowP) === root) !== (ufFind(c.highP) === root)) &&
        pSize[ufFind(c.lowP) === root ? c.highP : c.lowP] >= ROCK_CLIMB.minShelf && !climbList.some(k => k.lowP === c.lowP || k.highP === c.highP));
      if (!opts.length) break;
      const c = opts[Math.floor(rSt()*opts.length)]; c.why = 'Rock Climb (reward)';
      for (const j of c.tiles){ RES[j] = 1; T[j] = TILE.ROCK_CLIMB; }
      for (const j of c.land){ if (!RES[j]) RES[j] = 2; if (isWall(T[j])) T[j] = TILE.OPEN; }
      climbList.push(c);
    }
    for (let n = 0; n < ROCK_CLIMB.shortcuts; n++){
      if (rSt() >= ROCK_CLIMB.shortcutChance) break;
      const root = rootNow(), opts = climbable.filter(c => fits(c) && ufFind(c.lowP) === root && ufFind(c.highP) === root && hops(c.lowP, c.highP) >= ROCK_CLIMB.minHops);
      if (!opts.length) break;
      const c = opts[Math.floor(rSt()*opts.length)]; c.why = 'Rock Climb (shortcut)';
      for (const j of c.tiles){ RES[j] = 1; T[j] = TILE.ROCK_CLIMB; }
      for (const j of c.land){ if (!RES[j]) RES[j] = 2; if (isWall(T[j])) T[j] = TILE.OPEN; }
      climbList.push(c);
    }
    for (const c of climbList) flightList.push({ id:flightList.length, face:c.f, width:c.w, depth:c.dep, tiles:c.tiles, land:c.land, x:c.x, y:c.y,
                                                 style:'rock climb', why:c.why, climb:true, lowP:c.lowP, highP:c.highP });
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
        if (isCliffish(T[i])) continue;              // stamps never touch cliffs; only placed flights cross them
        if (inPath){
          if (kind === 'main'){ T[i] = wild ? TILE.OPEN : TILE.PATH; trail[i] = 1; }
          else if (!isPathish(T[i]) && !trail[i]) T[i] = TILE.OPEN;
        } else if (!isPathish(T[i]) && !trail[i]) T[i] = kind === 'main' ? TILE.VERGE : (isWall(T[i]) ? TILE.OPEN : T[i]);
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
        if (wild){ carveDisc(q.lx, q.ly, WILD.path, WILD.verge, 'main'); return; }
        const w = clampWidth(p, v); carveDisc(q.lx, q.ly, w.p, w.v, 'main');
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
          const i = y*N + x; if (Math.hypot(dx, dy) + 0.8*(smoothNoise(sRag, sx*N + x, sy*N + y, 2) - 0.5) <= rad && !isCliffish(T[i]) && !RES[i]) T[i] = TILE.WATER; }
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
          if (isCliffish(T[i])) return Infinity; if (isWall(T[i])) return 3; return 1; };
        const pts = astar(best.from, best.to, spurCost);
        if (!pts) break;
        for (const q of pts){ carveDisc(q.lx, q.ly, type === 'gap' ? 1 : 2, 0, 'side'); }
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
            if (isCliffish(T[i])) return Infinity; if (isWall(T[i])) return 2.5; return 1 + smoothNoise(sNoise, sx*N + lx + 99, sy*N + ly, 3); };
          const lp = astar(pair[0], pair[1], loopCost);
          if (lp){ for (const q of lp){ carveDisc(q.lx, q.ly, 2, 0, 'side'); } content.loops++; }
        }
      }
    }
    // --- Ledges (proto-6): their own layer, on flat ground within one terrace ---
    // Straight runs (3+ tiles) facing S (59%), W (24%) or E (17%) as in Emerald, sometimes with a right-angle turn (a ledge
    // corner, which can't be jumped). Never on the route, never within a tile of a cliff, stairs or a landing, usually with
    // one end against trees or rock. Density by land cover (Emerald's routes). Each run is placed whole and kept only if
    // the top is reachable, every required place stays reachable both ways and nothing traps the player.
    const required = ports.map(p => ({ name:`port ${'EWSN'[p.side]}`, i:p.edgeTile.ly*N + p.edgeTile.lx, gate:p.gate }));
    if (junction) required.push({ name:'junction', i:junction.ly*N + junction.lx, gate:junction });
    const reqOk = () => { if (!required.length) return { ok:true }; const fw = flood(required[0].i, false), bw = flood(required[0].i, true);
      let traps = 0; for (let i = 0; i < N*N; i++) if (fw[i] && !bw[i]) traps++;
      return { ok:required.every(r => fw[r.i] && bw[r.i]) && !traps, fw }; };
    let ledgeRuns = 0, ledgeTilesPlaced = 0;
    if (plan.ledges > 0 && required.length && reqOk().ok){
      const fw0 = flood(required[0].i, false), byCls = new Float64Array(NCLS), pool = [];
      for (let i = 0; i < N*N; i++) if (fw0[i] && WALKABLE[T[i]]){ byCls[K[i]]++; if ((T[i] === TILE.OPEN || T[i] === TILE.VERGE) && !trail[i]) pool.push(i); }
      let want = 0; for (let c = 0; c < NCLS; c++) want += byCls[c]*(LEDGES.density[c] || 0)/100;
      want *= plan.ledges;
      const rL = mulberry32(hash32(sSq, strHash('ledges')));
      const ledgeOf = f => f === FACE.S ? TILE.LEDGE_S : f === FACE.E ? TILE.LEDGE_E : TILE.LEDGE_W;
      const clearAround = j => { const x = j % N, y = (j/N) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){ const k = at(x + dx, y + dy); if (k < 0) return false;
          const t = T[k]; if (t === TILE.CLIFF || t === TILE.STAIRS || t === TILE.SIDE_STAIRS || t === TILE.ROCK_CLIMB || RES[k] === 1 || RES[k] === 2) return false;
          if ((LEDGE_DIR[t] || t === TILE.LEDGE_CORNER) && RES[k] === 3) return false; }
        return true; };
      const groundOk = j => j >= 0 && inInterior(j % N, (j/N) | 0) && (T[j] === TILE.OPEN || T[j] === TILE.VERGE) && !trail[j] && RES[j] === 0 && clearAround(j);
      const sideOk = (j, lv) => j >= 0 && WALKABLE[T[j]] && T[j] !== TILE.STAIRS && T[j] !== TILE.SIDE_STAIRS && L[j] === lv;
      // one straight segment: tiles along the line, each with its take-off (uphill) and landing (downhill) tiles
      const segment = (x, y, f, n) => {
        const [dx, dy] = FV[f], ax = dy ? 1 : 0, ay = dy ? 0 : 1, lv = L[y*N + x], out = [];
        for (let u = 0; u < n; u++){ const tx = x + ax*u, ty = y + ay*u, j = at(tx, ty);
          if (!groundOk(j) || L[j] !== lv || !sideOk(at(tx - dx, ty - dy), lv) || !sideOk(at(tx + dx, ty + dy), lv)) return null;
          out.push(j); }
        return { tiles:out, ends:[at(x - ax, y - ay), at(x + ax*n, y + ay*n)], ax, ay };
      };
      for (let tries = 0; tries < LEDGES.tries && ledgeTilesPlaced < want && pool.length; tries++){
        const s0 = pool[Math.floor(rL()*pool.length)], x = s0 % N, y = (s0/N) | 0, r = rL();
        const f = r < 0.59 ? FACE.S : r < 0.83 ? FACE.W : FACE.E;
        const n = 3 + Math.floor(rL()*rL()*LEDGES.maxExtra);              // 3+ tiles, most 3–6, a few long ones
        const seg = segment(x, y, f, n); if (!seg) continue;
        const wallEnds = seg.ends.filter(j => j >= 0 && isWall(T[j])).length;
        if (!wallEnds && rL() >= LEDGES.openBothEnds) continue;          // usually one end against trees or rock
        const placed = seg.tiles.map(j => [j, ledgeOf(f)]);
        // a right-angle turn (S runs only): a ledge corner at an open end, then a W/E ledge running back uphill
        if (f === FACE.S && rL() < LEDGES.turnChance){
          const endIdx = seg.ends.findIndex(j => j >= 0 && !isWall(T[j]));
          if (endIdx >= 0){
            const cj = seg.ends[endIdx], cx = cj % N, cy = (cj/N) | 0, fT = endIdx ? FACE.E : FACE.W;
            const m = 2 + Math.floor(rL()*3);
            const up = []; let ok2 = groundOk(cj) && L[cj] === L[s0];
            for (let k = 1; k <= m && ok2; k++){ const j = at(cx, cy - k), [ddx] = FV[fT];
              if (!groundOk(j) || L[j] !== L[s0] || !sideOk(at(cx - ddx, cy - k), L[s0]) || !sideOk(at(cx + ddx, cy - k), L[s0])) ok2 = false; else up.push(j); }
            if (ok2){ placed.push([cj, TILE.LEDGE_CORNER]); for (const j of up) placed.push([j, ledgeOf(fT)]); }
          }
        }
        const old = placed.map(([j]) => [j, T[j]]);
        for (const [j, t] of placed){ T[j] = t; RES[j] = 3; }
        const chk = reqOk(), top = at(x - FV[f][0], y - FV[f][1]);
        if (!chk.ok || !chk.fw[top]){ for (const [j, t] of old){ T[j] = t; RES[j] = 0; } continue; }
        ledgeRuns++; ledgeTilesPlaced += placed.filter(([, t]) => t !== TILE.LEDGE_CORNER).length;
      }
    }

    // tall grass (long grass in wetland) on open ground and verges, off the route; position-keyed so seams match
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ly*N + lx; if (trail[i] || (T[i] !== TILE.OPEN && T[i] !== TILE.VERGE)) continue;
      if (grassAt(sx*N + lx, sy*N + ly, K[i])) T[i] = K[i] === CLS.WETLAND ? TILE.LONG_GRASS : TILE.TALL_GRASS;
    }

    // --- 7. Reachability with one-way ledges, and repair (a repair only carves through walls on one level) ---
    let repairs = 0, fallback = false, trapFixes = 0;
    const repairCost = (lx, ly) => { const i = ly*N + lx;
      if (T[i] === TILE.WATER) return RV[i] ? COST.repairRiver : COST.surf;
      if (isCliffish(T[i])) return Infinity;
      return isWall(T[i]) ? COST.repairWall*(sampler.isPeak(sx*N + lx, sy*N + ly) ? 2 : 1) : 1; };
    const ok = () => { if (required.length < 2) return true; const fw = flood(required[0].i, false), bw = flood(required[0].i, true);
      return required.every(r => fw[r.i] && bw[r.i]); };
    for (let tryN = 0; tryN < 3 && !ok(); tryN++){
      const fw = flood(required[0].i, false), bw = flood(required[0].i, true);
      for (const m of required.filter(r => !(fw[r.i] && bw[r.i]))){
        let target = null, bd = Infinity;
        for (let i = 0; i < N*N; i++){ if (!(fw[i] && bw[i])) continue; const x = i % N, y = (i/N) | 0; if (!inInterior(x, y)) continue;
          const d = Math.abs(x - m.gate.lx) + Math.abs(y - m.gate.ly); if (d < bd){ bd = d; target = { lx:x, ly:y }; } }
        if (!target) target = required[0].gate;
        const pts = astar(m.gate, target, repairCost);
        if (pts){ for (const q of pts){ carveDisc(q.lx, q.ly, 3, 0, 'main'); } repairs++; sLog.push(`repair ${repairs}: carved a 3-wide corridor from ${m.name} (${pts.length} tiles)`); }
      }
    }
    let fw = required.length ? flood(required[0].i, false) : null, bw = required.length ? flood(required[0].i, true) : null;
    const ledgesHidden = 0;
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
    // --- Checks (read-only; zero tolerance). Each issue names the structure it belongs to. ---
    const issues = [...planIssues];
    const isSt = t => t === TILE.STAIRS || t === TILE.SIDE_STAIRS;
    const flightOf = new Int16Array(N*N).fill(-1);
    for (const fl of flightList) for (const j of fl.tiles) flightOf[j] = fl.id;
    const P = (j) => `(${j % N}, ${(j/N) | 0})`;
    for (let j = 0; j < N*N; j++) if ((isSt(T[j]) || T[j] === TILE.ROCK_CLIMB) && flightOf[j] < 0) issues.push(`STAIR_?: stray stair or Rock Climb tile at ${P(j)}`);
    for (const fl of flightList){
      const id = `STAIR_${String(fl.id).padStart(3, '0')}`, [dx, dy] = FV[fl.face], ax = dy ? 1 : 0, ay = dy ? 0 : 1;
      const want = fl.climb ? TILE.ROCK_CLIMB : stairsFor(fl.face);
      if (fl.tiles.some(j => T[j] !== want)) issues.push(`${id}: a tile is not ${fl.climb ? 'a Rock Climb wall' : want === TILE.STAIRS ? 'stairs' : 'side stairs'}`);
      if (fl.tiles.some(j => inBand(j % N, (j/N) | 0))) issues.push(`${id}: inside the seam band`);
      for (const j of fl.land) if (!WALKABLE[T[j]] || isSt(T[j])) issues.push(`${id}: landing blocked at ${P(j)}`);
      if (fl.climb && flightList.filter(o => o.climb).length > ROCK_CLIMB.rewards + ROCK_CLIMB.shortcuts) issues.push(`${id}: too many Rock Climb walls`);
      for (const j of fl.tiles){ const x = j % N, y = (j/N) | 0;
        for (const [sx2, sy2] of [[ax, ay], [-ax, -ay]]){ const k = at(x + sx2, y + sy2);
          if (k >= 0 && flightOf[k] !== fl.id && T[k] !== TILE.CLIFF) issues.push(`${id}: flank open at ${P(k)}`); }
        for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++){ const k = at(x + ddx, y + ddy);
          if (k >= 0 && flightOf[k] >= 0 && flightOf[k] !== fl.id) issues.push(`${id}: touches STAIR_${String(flightOf[k]).padStart(3, '0')} (knight's-move rule)`); }
      }
    }
    // cliff continuity: two walkable neighbours on different levels must be joined by a flight, along its climb
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++){ const i = y*N + x;
      for (const [dx, dy] of [[1, 0], [0, 1]]){ const j = at(x + dx, y + dy); if (j < 0) continue;
        if (!WALKABLE[T[i]] || !WALKABLE[T[j]] || L[i] === L[j] || T[i] === TILE.BRIDGE || T[j] === TILE.BRIDGE) continue;
        const s = isSt(T[i]) ? i : isSt(T[j]) ? j : -1;
        if (s < 0){ issues.push(`CLIFF: gap between levels at ${P(i)}–${P(j)}`); continue; }
        const vertical = T[s] === TILE.STAIRS;
        if (vertical !== (dy === 1)) issues.push(`STAIR_${String(flightOf[s]).padStart(3, '0')}: stepped onto from the side at ${P(s)}`);
      } }
    // ledges: away from cliffs and stairs, take-off and landing on the same level
    for (let j = 0; j < N*N; j++){ const ld = LEDGE_DIR[T[j]]; if (!ld) continue; const x = j % N, y = (j/N) | 0;
      for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++){ const k = at(x + ddx, y + ddy);
        if (k >= 0 && (T[k] === TILE.CLIFF || isSt(T[k]))) { issues.push(`LEDGE: beside a cliff or stairs at ${P(j)}`); ddy = 2; break; } }
      const a = at(x - ld[0], y - ld[1]), b = at(x + ld[0], y + ld[1]);
      if (a < 0 || b < 0 || L[a] !== L[b]) issues.push(`LEDGE: take-off and landing on different levels at ${P(j)}`);
    }
    for (const r of required) if (!(fw && fw[r.i] && bw[r.i])) issues.push(`ROUTE: ${r.name} not reachable both ways`);
    if (traps) issues.push(`LEDGE: ${traps} tile(s) can be reached but not left`);
    // stair looks: one style per flight, from the land cover where it stands (flights never touch, so colours never do)
    const stairStyle = new Uint8Array(N*N);
    for (const fl of flightList) for (const j of fl.tiles) stairStyle[j] = STAIR_STYLES.indexOf(fl.style);
    let lmin = Infinity, lmax = -Infinity; for (let i = 0; i < N*N; i++) if (T[i] !== TILE.WATER){ lmin = Math.min(lmin, L[i]); lmax = Math.max(lmax, L[i]); }
    const walkAll = (() => { let n = 0; for (let i = 0; i < N*N; i++) if (WALKABLE[T[i]]) n++; return n; })();
    return { x:sx, y:sy, N, wild, border, stairStyle, flights:flightList.length, flightList:flightList.map(f => ({ id:f.id, face:'NSEW'[[FACE.N, FACE.S, FACE.E, FACE.W].indexOf(f.face)], width:f.width, depth:f.depth, x:f.x, y:f.y, style:f.style, why:f.why })),
             faceMap:F, depthMap:D, rugged:ruggedVal, rockClimbs:climbList.map(c => c.why), plateaus:pSize.length, ruggedParts:(() => { let a = 0, b = 0, n = 0; for (let ly = 2; ly < N; ly += 6) for (let lx = 2; lx < N; lx += 6){ const q = ruggedParts(sx*N + lx, sy*N + ly); a += q[0]; b += q[1]; n++; } return [+(a/n).toFixed(2), +(b/n).toFixed(2)]; })(), stairTarget:target, issues, attempt, ledgeRuns,
             tiles:T, cls:K, level:L, trail, protectedMask, ports, junction, junctionSource, bridges, repairs, fallback,
             unreachable, traps, trapFixes, needsSurf, waypoints:waypointCount, ledges, stairs, cliffs, content, walkable:walkAll,
             levels:isFinite(lmin) ? lmax - lmin + 1 : 0, offPathShare:reach && required.length ? (reach - onPath)/reach : null, grassShare:reach ? grass/reach : 0,
             ndvi:inp.ndvi ? 'NDVI' : 'estimated from land cover',
             log:sLog, connections:[...ports.map(p => ({ direction:['right', 'left', 'down', 'up'][p.side], to:p.neighbour, offset:0 })), ...sceneryLinks] };
  };
  // each square: up to ATTEMPTS.length tries, each with a new attempt seed and simpler relief; the first that passes
  // every check is kept. If none passes, the last try is kept and reported as a hard failure (never exported).
  for (const sq of winSquares){
    let res = null;
    for (let a = 0; a < ATTEMPTS.length; a++){ res = buildSquare(sq, a); if (!res.issues.length) break; }
    res.hardFailure = res.issues.length > 0;
    if (res.attempt && !res.hardFailure) res.log.push(`passed on attempt ${res.attempt + 1} (${ATTEMPTS[res.attempt].name})`);
    results.push(res);
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
    terraceBlock:B, stairFlights:results.reduce((s, r) => s + r.flights, 0), rockClimbs:results.reduce((s, r) => s + r.rockClimbs.length, 0),
    flightsPer100:+(results.reduce((s, r) => s + r.flights, 0)/Math.max(1, results.reduce((s, r) => s + r.walkable, 0))*100).toFixed(2),
    flightsPerSquare:results.map(r => `${r.x},${r.y}:${r.flights}/${r.stairTarget}${r.rugged >= RELIEF.ruggedMin ? 'R' : ''}`),
    ledgeTilesPer100:+(results.reduce((s, r) => s + r.ledges, 0)/Math.max(1, results.reduce((s, r) => s + r.walkable, 0))*100).toFixed(2),
    retries:results.filter(r => r.attempt > 0).map(r => `${r.x},${r.y}:${r.attempt + 1}`),
    hardFailures:results.filter(r => r.hardFailure).map(r => `${r.x},${r.y}: ${[...new Set(r.issues)].slice(0, 6).join('; ')}`),
    scenery:scenery.map(s2 => `${s2.x},${s2.y} (seen from ${s2.seenFrom.join(', ')})`),
    borders:results.map(r => `${r.x},${r.y}:${r.border}`)
  };
  report.ok = !seamIssues.length && !reciprocal.length && !report.unreachable.length && !report.traps && !report.hardFailures.length;
  return { version, N, band:BAND, window:win, squares:results, scenery, contracts, report, log };
}

// ----- Preview colours (RGBA image of the window; inactive squares are dimmed; higher levels are lighter) -----
const COLORS = {
  [TILE.OPEN]:[120, 200, 80], [TILE.PATH]:[232, 176, 96], [TILE.VERGE]:[164, 220, 110], [TILE.TREE]:[40, 112, 56],
  [TILE.ROCK]:[150, 120, 90], [TILE.WATER]:[72, 160, 224], [TILE.BRIDGE]:[176, 120, 64], [TILE.CLIFF]:[96, 78, 70],
  [TILE.ROCK_CLIMB]:[168, 104, 64], [TILE.LEDGE_S]:[196, 168, 112], [TILE.LEDGE_E]:[196, 168, 112], [TILE.LEDGE_W]:[196, 168, 112],
  [TILE.STAIRS]:[250, 246, 236], [TILE.SIDE_STAIRS]:[250, 236, 214], [TILE.TALL_GRASS]:[56, 150, 64], [TILE.LONG_GRASS]:[40, 128, 96], [TILE.LEDGE_CORNER]:[172, 146, 98]
};
// walkability view: walk / wall / surf / ledge
const WALK_COLORS = { walk:[206, 232, 176], wall:[58, 60, 72], surf:[72, 160, 224], ledge:[240, 150, 40], climb:[200, 90, 200] };
const STAIR_COLORS = [null, [214, 214, 222], [196, 146, 96], [240, 214, 156], [236, 244, 255]];   // stone, dirt, sand, snow
const BORDER_COLORS = { trees:[[34, 96, 48], [46, 118, 58]], rock:[[120, 96, 74], [140, 114, 88]], water:[[60, 140, 210], [84, 164, 228]] };
const walkClass = t => LEDGE_DIR[t] ? 'ledge' : t === TILE.WATER ? 'surf' : t === TILE.ROCK_CLIMB ? 'climb' : WALKABLE[t] ? 'walk' : 'wall';
const OPEN_TINT = { [CLS.DESERT]:[228, 208, 152], [CLS.SNOW]:[232, 240, 248], [CLS.TUNDRA]:[180, 188, 156], [CLS.WETLAND]:[112, 176, 144],
  [CLS.CROP]:[200, 204, 96], [CLS.URBAN]:[176, 172, 180], [CLS.DRY]:[168, 200, 96], [CLS.ROCKY]:[176, 160, 128] };
// opts.scale = pixels per tile. At 4 or more, tiles get glyphs: ledges show a dark lip and an arrow on the side you
// jump toward, stairs are striped across the climb (side stairs striped the other way), cliffs have a light top edge,
// bridges show planks, trees a dark rim.
const TILE_NAMES = ['open ground', 'path', 'verge', 'trees', 'rock', 'water', 'bridge', 'cliff',
  'ledge (jump south)', 'ledge (jump east)', 'ledge (jump west)', 'stairs', 'side stairs', 'tall grass', 'long grass (no running)', 'ledge corner (can\'t be jumped)', 'Rock Climb wall'];
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
      let k = walkMode || t === TILE.WATER || isPathish(t) ? 1 : Math.min(1.25, 0.8 + 0.1*(s.level[i] - lmin));   // higher terraces are lighter
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
          else if (t === TILE.CLIFF){
            // cliffs show which way they drop: a south face is a rock wall, lit at the top and in shadow at its foot;
            // east/west sides darken toward the drop; a north edge is a thin rim with a dark line on its north side
            const f = s.faceMap ? s.faceMap[i] : FACE.NONE, dep = s.depthMap ? s.depthMap[i] : 1;
            if (f === FACE.S) col = mul(base, (py % 3 === 0 ? 0.8 : 1)*(dep === 1 ? 0.75 + 0.25*(1 - py/S) : 1.15 - 0.1*(dep - 2)));
            else if (f === FACE.E) col = mul(base, 1.15 - 0.45*(px/S));
            else if (f === FACE.W) col = mul(base, 0.7 + 0.45*(px/S));
            else if (f === FACE.N) col = py < Math.max(1, S/4) ? mul(base, 0.55) : mul(base, 1.45);
            else col = (px + py) % 3 === 0 ? mul(base, 0.7) : mul(base, 1.05);
          }
          else if (t === TILE.ROCK_CLIMB) col = (px % 3 === 1 && py % 2 === 0) ? [250, 230, 200] : base;
          else if (t === TILE.LEDGE_CORNER) col = (py >= S - Math.max(1, Math.round(S/4)) || px >= S - Math.max(1, Math.round(S/4))) ? LIP : base;
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
