/* Region Map Forge — overworld map generator (prototype "ow-proto-1").
 *
 * Turns region-map squares into walkable tile maps, one map per square, joined by seamless connections.
 * Design and decisions: the project's "Overworld Maps — Decisions Log" (claude/overworld-map-decisions.md).
 *
 * What this prototype does, in order:
 *   1. Base terrain for the whole window (plus a margin), keyed by global tile position, so the seam strips and
 *      corner blocks on both sides of every edge come from one region-level raster and always match.
 *   2. Water is structural: lakes/sea from the terrain grid and 2-tile river channels; smoothed by its own
 *      majority rule, never by the wall/open cellular automata.
 *   3. Cellular automata (8 neighbours; wall opens below 4 wall neighbours, open walls at 5 or more; 3 passes).
 *   4. Edge contracts: one per linked edge (port position, path width, verge width), shared by both squares.
 *   5. Paths: straight approaches through the 7-tile seam band, least-cost (A*) paths in the interior,
 *      a junction for 3+ ports, path + verge widths from local land cover (Option C), bridges over rivers.
 *   6. Validation and repair: 4-direction flood fill, A* repair corridors, a guaranteed fallback, region checks.
 *
 * Tiles here are abstract classes (open ground, path, verge, tree, rock, water, bridge). Picking real metatiles
 * (General + biome secondary tilesets) comes in a later step.
 *
 * Pure functions, no DOM: runs in the browser (window.OverworldGen) and in Node (module.exports) for tests.
 */
(function (root) {
'use strict';

const VERSION = 'ow-proto-1';
const BAND = 7;                                    // seam band depth in metatiles (pokeemerald MAP_OFFSET = 7)
const PAD = 8;                                     // raster margin around the window so results don't depend on it

// ----- Tile classes -----
const TILE = { OPEN:0, PATH:1, VERGE:2, TREE:3, ROCK:4, WATER:5, BRIDGE:6 };
const WALKABLE = [1, 1, 1, 0, 0, 0, 1];
const PASSABLE = [1, 1, 1, 0, 0, 1, 1];            // walkable, or crossable with Surf (water)
const isWall = t => t === TILE.TREE || t === TILE.ROCK;

// ----- Land cover classes (0–9 are the Forge's C codes; 10–11 come from its terrain grid) -----
const CLS = { GRASS:0, FOREST:1, WETLAND:2, DESERT:3, SNOW:4, DRY:5, MANGROVE:6, TUNDRA:7, CROP:8, URBAN:9, ROCKY:10, WATER:11 };
const NCLS = 12;
// Path width, verge width (each side), path cost, and the wall the class grows. Starting values (Claude's judgment,
// partly from the outside plan's path table); decided as Option C on 2026-11-25; to tune in testing.
const PROFILE = [
  { name:'grassland', path:6, verge:4, cost:1.0, wall:null },
  { name:'forest',    path:3, verge:1, cost:2.5, wall:TILE.TREE },
  { name:'wetland',   path:3, verge:1, cost:2.0, wall:null },
  { name:'desert',    path:5, verge:3, cost:1.3, wall:null },
  { name:'snow',      path:4, verge:2, cost:1.5, wall:null },
  { name:'shrubland', path:4, verge:2, cost:1.2, wall:null },
  { name:'mangrove',  path:3, verge:1, cost:3.0, wall:TILE.TREE },
  { name:'tundra',    path:5, verge:3, cost:1.2, wall:null },
  { name:'cropland',  path:5, verge:3, cost:1.1, wall:null },
  { name:'built-up',  path:4, verge:1, cost:1.0, wall:null },
  { name:'rocky',     path:3, verge:1, cost:4.0, wall:TILE.ROCK },
  { name:'water',     path:3, verge:1, cost:Infinity, wall:null }
];
const LIMITS = { pathMin:3, pathMax:6, vergeMin:1, vergeMax:4 };
const COST = { roadFactor:0.3, slopeK:3, noiseM:0.5, turn:0.3, riverCrossing:8, surf:2, peak:12, repairWall:6, repairRiver:10 };
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
  for (let i = 0; i < SW*SH; i++){
    const t = inp.terrain[i];
    if (t === FORGE_T.SEA || (inp.lake && inp.lake[i])) subClass[i] = CLS.WATER;
    else if (t === FORGE_T.MTN || t === FORGE_T.PEAK) { subClass[i] = CLS.ROCKY; peak[i] = t === FORGE_T.PEAK ? 1 : 0; }
    else subClass[i] = Math.min(inp.cover ? inp.cover[i] : 0, 9);
  }
  const clampS = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;
  const weights = (gx, gy) => {                    // four sub-cells and their bilinear weights
    const u = (gx + 0.5)/N*inp.sub - 0.5, v = (gy + 0.5)/N*inp.sub - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), tx = u - x0, ty = v - y0, out = [];
    for (const [dx, dy, w] of [[0, 0, (1 - tx)*(1 - ty)], [1, 0, tx*(1 - ty)], [0, 1, (1 - tx)*ty], [1, 1, tx*ty]])
      out.push([clampS(y0 + dy, SH - 1)*SW + clampS(x0 + dx, SW - 1), w]);
    return out;
  };
  return {
    SW, SH, subClass, peak,
    shares(gx, gy){ const s = new Float64Array(NCLS); for (const [i, w] of weights(gx, gy)) s[subClass[i]] += w; return s; },
    elev(gx, gy){ if (!inp.elev) return 0; let e = 0; for (const [i, w] of weights(gx, gy)) e += w*(inp.elev[i] || 0); return e; },
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
  const log = [];

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

  // --- 1–3. Region-level raster (window + margin): base terrain, water, cellular automata ---
  const RX0 = win.x0*N - PAD, RY0 = win.y0*N - PAD, RW = win.w*N + 2*PAD, RH = win.h*N + 2*PAD;
  const tiles = new Uint8Array(RW*RH), cls = new Uint8Array(RW*RH), river = new Uint8Array(RW*RH);
  const ri = (gx, gy) => (gy - RY0)*RW + (gx - RX0);
  const inR = (gx, gy) => gx >= RX0 && gy >= RY0 && gx < RX0 + RW && gy < RY0 + RH;
  const sBase = seeds.layer('base'), sBlob = seeds.layer('blob'), sWater = seeds.layer('water');
  const water = new Uint8Array(RW*RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
    const gx = RX0 + x, gy = RY0 + y, s = sampler.shares(gx, gy), i = y*RW + x;
    const wn = smoothNoise(sWater, gx, gy, 4);
    if (s[CLS.WATER] > 0.5 + 0.3*(wn - 0.5)){ water[i] = 1; cls[i] = CLS.WATER; continue; }
    // dithered pick between land classes, using smooth noise so patches come out as blobs, not salt-and-pepper
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
      // diagonal steps (no orthogonal river cell between): an L-shaped channel so the river never breaks
      for (const dx of [-1, 1]){
        const nx = sx + dx, ny = sy + 1;
        if (!isRiv(nx, ny) || isRiv(nx, sy) || isRiv(sx, ny)) continue;
        linked++;
        const ax = ctr(sx), ay = ctr(sy), bx = ctr(nx), by = ctr(ny);
        for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) mark(x, ay);
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) mark(bx, y);
      }
      if (!linked){                                              // linked only from above diagonally, or isolated
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
  // land tiles from classes
  for (let i = 0; i < RW*RH; i++){
    if (water[i]){ tiles[i] = TILE.WATER; continue; }
    const w = PROFILE[cls[i]].wall; tiles[i] = w === null ? TILE.OPEN : w;
  }
  // cellular automata on land only (walls vs open); water counts as open and is never changed
  for (let it = 0; it < 3; it++){
    const copy = tiles.slice();
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++){
      const i = y*RW + x; if (copy[i] === TILE.WATER) continue;
      let walls = 0, trees = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= RW || ny >= RH){ walls++; continue; }   // margin edge: treat as wall
        const t = copy[ny*RW + nx]; if (isWall(t)){ walls++; if (t === TILE.TREE) trees++; }
      }
      if (isWall(copy[i]) && walls < 4){
        tiles[i] = TILE.OPEN;
        const s = sampler.shares(RX0 + x, RY0 + y); let best = CLS.GRASS, bw = -1;
        for (let c = 0; c < NCLS; c++) if (c !== CLS.WATER && PROFILE[c].wall === null && s[c] > bw){ bw = s[c]; best = c; }
        cls[i] = best;
      } else if (!isWall(copy[i]) && walls >= 5){
        const own = PROFILE[cls[i]].wall;
        tiles[i] = own !== null ? own : (trees*2 >= walls ? TILE.TREE : TILE.ROCK);
        if (own === null) cls[i] = tiles[i] === TILE.TREE ? CLS.FOREST : CLS.ROCKY;
      }
    }
  }

  // --- 4. Edge contracts ---
  const rng = (s) => mulberry32(s);
  const contracts = [];
  const contractOf = new Map();                    // `${sqId}:${side}` → contract; side 0=E 1=W 2=S 3=N
  const sideWidth = (x, y, side) => {              // widths from the seam-band strip on this square's side of the edge
    const acc = new Float64Array(NCLS); let n = 0;
    for (let d = 0; d < BAND; d += 2) for (let t = 0; t < N; t += 2){
      const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
      const s = sampler.shares(x*N + lx, y*N + ly); for (let c = 0; c < NCLS; c++) acc[c] += s[c]; n++;
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
    // port position along the edge: a real road crossing, else the midpoint plus a centre-biased seeded offset
    let c = null, source = 'seeded';
    const edgeX = horiz ? b.x : null, edgeY = horiz ? null : b.y;   // the shared edge line in square coords
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
    const lakeInApproach = pos => {                // lake or sea water in the path span of the approach, either side
      for (const [sq, side] of [[a, sideA], [b, sideB]]) for (let d = 0; d <= BAND; d++) for (let t = pos - lo; t <= pos + hi; t++){
        const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
        const gx = sq.x*N + lx, gy = sq.y*N + ly; if (!inR(gx, gy)) continue;
        const i = ri(gx, gy); if (water[i] && !river[i]) return true;
      }
      return false;
    };
    if (source === 'seeded' && lakeInApproach(clamped)){   // a seeded port slides along the edge to dry land if it can
      for (let off = 1; off <= cMax - cMin; off++){
        const cand = [clamped - off, clamped + off].find(q => q >= cMin && q <= cMax && !lakeInApproach(q));
        if (cand !== undefined){ notes.push(`port moved ${clamped} → ${cand} to keep the approach on dry land`); clamped = cand; break; }
      }
    }
    // water in the approach (either side): a river gets a bridge, so the path narrows to the bridge width (3)
    let lo2 = lo, hi2 = hi, bridge = false, otherWater = false;
    for (const [sq, side] of [[a, sideA], [b, sideB]]) for (let d = 0; d <= BAND; d++) for (let t = clamped - lo; t <= clamped + hi; t++){
      const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t;
      const gx = sq.x*N + lx, gy = sq.y*N + ly; if (!inR(gx, gy)) continue;
      const i = ri(gx, gy); if (water[i]){ if (river[i]) bridge = true; else otherWater = true; }
    }
    if (bridge && p > 3){ p = 3; lo2 = 1; hi2 = 1; notes.push('river in the approach: path narrowed to the 3-wide bridge'); }
    if (otherWater) notes.push('lake or sea water in the approach (crossed by Surf)');
    const k = { id:contracts.length, key, a, b, horiz, pos:clamped, lo:lo2, hi:hi2, path:p, verge:v, source, notes, bridge };
    contracts.push(k);
    contractOf.set(sqId(a.x, a.y) + ':' + sideA, k); contractOf.set(sqId(b.x, b.y) + ':' + sideB, k);
  }

  // --- 5. Per-square paths ---
  const roadTilesFor = (sx, sy) => {              // tiles of this square that a real road passes through
    const set = new Set();
    for (const road of (inp.roads || [])){
      const pts = road.pts;
      for (let k = 0; k < pts.length - 1; k++){
        const p0 = pts[k], p1 = pts[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y)*N*2));
        for (let s = 0; s <= steps; s++){
          const fx = p0.x + (p1.x - p0.x)*s/steps, fy = p0.y + (p1.y - p0.y)*s/steps;
          const lx = Math.floor((fx - sx)*N), ly = Math.floor((fy - sy)*N);
          if (lx >= 0 && ly >= 0 && lx < N && ly < N) set.add(ly*N + lx);
        }
      }
    }
    return set;
  };
  const results = [];
  for (const sq of winSquares){
    const sx = sq.x, sy = sq.y, id = sqId(sx, sy), sLog = [];
    const T = new Uint8Array(N*N), K = new Uint8Array(N*N), protectedMask = new Uint8Array(N*N);
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){ const i = ri(sx*N + lx, sy*N + ly); T[ly*N + lx] = tiles[i]; K[ly*N + lx] = cls[i]; }
    const inBand = (lx, ly) => lx < BAND || ly < BAND || lx >= N - BAND || ly >= N - BAND;
    const ports = [];
    for (let side = 0; side < 4; side++){
      const k = contractOf.get(id + ':' + side);
      if (!k){                                     // unlinked edge: a 2-tile wall line, so nothing suggests a crossing
        for (let d = 0; d < 2; d++) for (let t = 0; t < N; t++){
          const lx = side === 0 ? N - 1 - d : side === 1 ? d : t, ly = side === 2 ? N - 1 - d : side === 3 ? d : t, i = ly*N + lx;
          if (T[i] === TILE.WATER) continue;
          const w = PROFILE[K[i]].wall; T[i] = w !== null ? w : (K[i] === CLS.DESERT || K[i] === CLS.TUNDRA || K[i] === CLS.SNOW ? TILE.ROCK : TILE.TREE);
        }
        continue;
      }
      // straight approach through the band: identical width and position on both sides of the edge
      const along = t => side <= 1 ? { lx:side === 0 ? N - 1 - t.d : t.d, ly:t.a } : { lx:t.a, ly:side === 2 ? N - 1 - t.d : t.d };
      for (let d = 0; d <= BAND; d++) for (let a = k.pos - k.lo - k.verge; a <= k.pos + k.hi + k.verge; a++){
        const { lx, ly } = along({ d, a }), i = ly*N + lx, isPath = a >= k.pos - k.lo && a <= k.pos + k.hi;
        if (T[i] === TILE.WATER){ if (isPath && a >= k.pos - 1 && a <= k.pos + 1 && river[ri(sx*N + lx, sy*N + ly)]) T[i] = TILE.BRIDGE; }
        else T[i] = isPath ? TILE.PATH : TILE.VERGE;
        if (d < BAND) protectedMask[i] = 1;
      }
      const gate = along({ d:BAND, a:k.pos }), edgeTile = along({ d:0, a:k.pos });
      ports.push({ side, contract:k.id, pos:k.pos, path:k.path, verge:k.verge, gate, edgeTile, neighbour:k.a.x === sx && k.a.y === sy ? k.b : k.a });
    }
    for (let i = 0; i < N*N; i++){ const lx = i % N, ly = (i/N) | 0; if (inBand(lx, ly)) protectedMask[i] = 1; }

    // interior least-cost paths
    const sSq = seeds.square(sx, sy), sNoise = hash32(sSq, strHash('noise'));
    const roadTiles = roadTilesFor(sx, sy);
    const mpt = (inp.kmPerSquare || 1)*1000/N;
    const tileCost = (lx, ly) => {
      const i = ly*N + lx, gx = sx*N + lx, gy = sy*N + ly;
      if (T[i] === TILE.WATER) return river[ri(gx, gy)] ? COST.riverCrossing : COST.surf;
      let c = PROFILE[K[i]].cost;
      if (sampler.isPeak(gx, gy)) c = COST.peak;  // a route over a peak becomes a mountain pass (very costly, not blocked)
      if (isWall(T[i])) c += 1;
      const ex = sampler.elev(gx + 1, gy) - sampler.elev(gx - 1, gy), ey = sampler.elev(gx, gy + 1) - sampler.elev(gx, gy - 1);
      const slope = Math.min(1, Math.hypot(ex, ey)/(2*mpt)/0.3);
      c *= (1 + COST.slopeK*slope)*(1 + COST.noiseM*smoothNoise(sNoise, gx, gy, 6));
      if (roadTiles.has(i)) c *= COST.roadFactor;
      return c;
    };
    const lo = BAND, hi = N - 1 - BAND;
    const inInterior = (lx, ly) => lx >= lo && ly >= lo && lx <= hi && ly <= hi;
    const astar = (from, to, costFn, extraOk) => {
      const NS = N*N*5, g = new Float64Array(NS).fill(Infinity), prev = new Int32Array(NS).fill(-1), closed = new Uint8Array(NS);
      const heap = new MinHeap(), s0 = (from.ly*N + from.lx)*5 + 4; g[s0] = 0; heap.push(s0, 0);
      const goal = to.ly*N + to.lx; let end = -1;
      while (heap.size){
        const s = heap.pop(); if (closed[s]) continue; closed[s] = 1;
        const cell = (s/5) | 0, dir = s % 5; if (cell === goal){ end = s; break; }
        const x = cell % N, y = (cell/N) | 0;
        for (let nd = 0; nd < 4; nd++){
          const nx = x + [1, -1, 0, 0][nd], ny = y + [0, 0, 1, -1][nd];
          if (!(inInterior(nx, ny) || (extraOk && extraOk(nx, ny)))) continue;
          let c = costFn(nx, ny); if (!isFinite(c)) continue;
          if (dir !== 4 && dir !== nd) c += COST.turn;
          const ns = (ny*N + nx)*5 + nd, ng = g[s] + c;
          if (ng < g[ns]){ g[ns] = ng; prev[ns] = s; heap.push(ns, ng + Math.abs(nx - to.lx) + Math.abs(ny - to.ly)); }
        }
      }
      if (end < 0) return null;
      const out = []; for (let s = end; s !== -1; s = prev[s]){ const cell = (s/5) | 0; out.push({ lx:cell % N, ly:(cell/N) | 0 }); }
      const pts = out.reverse(); return pts.filter((p, i) => i === 0 || p.lx !== pts[i - 1].lx || p.ly !== pts[i - 1].ly);
    };
    // junction: a real road intersection in the interior if there is one, else the centroid of the gates
    let junction = null, junctionSource = null;
    if (ports.length >= 3 || ports.length === 1){
      const gates = ports.map(p => p.gate);
      const cx = Math.round(gates.reduce((s, g) => s + g.lx, 0)/gates.length), cy = Math.round(gates.reduce((s, g) => s + g.ly, 0)/gates.length);
      junction = ports.length === 1 ? { lx:Math.round(N/2), ly:Math.round(N/2) } : { lx:cx, ly:cy }; junctionSource = ports.length === 1 ? 'dead end (square centre)' : 'centroid of gates';
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
    const legs = [];                               // [{ from port index or null, pts }]
    if (ports.length === 2) legs.push({ ends:[0, 1], pts:astar(ports[0].gate, ports[1].gate, tileCost) });
    else if (junction) ports.forEach((p, k2) => legs.push({ ends:[k2, null], pts:astar(p.gate, junction, tileCost) }));
    const failedLegs = legs.filter(l => !l.pts);
    if (failedLegs.length) sLog.push(`${failedLegs.length} path leg(s) found no route (impassable terrain); repair will handle it`);

    // widths along each leg (Option C), blended from the contract at each gate, then carved
    const carveBox = (cx, cy, p, v) => {
      const a = (p - 1) >> 1, b = p - 1 - a;
      for (let dy = -a - v; dy <= b + v; dy++) for (let dx = -a - v; dx <= b + v; dx++){
        const x = cx + dx, y = cy + dy; if (!inInterior(x, y)) continue;
        const i = y*N + x, inPath = dx >= -a && dx <= b && dy >= -a && dy <= b;
        if (T[i] === TILE.WATER){ if (inPath && Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && river[ri(sx*N + x, sy*N + y)]) T[i] = TILE.BRIDGE; continue; }
        if (T[i] === TILE.BRIDGE) continue;
        if (inPath) T[i] = TILE.PATH; else if (T[i] !== TILE.PATH) T[i] = TILE.VERGE;
      }
    };
    let bridges = 0;
    for (const leg of legs){
      if (!leg.pts) continue;
      const pts = leg.pts, n = pts.length;
      const raw = pts.map(q => widthsFromShares(sampler.shares(sx*N + q.lx, sy*N + q.ly)));
      const sm = raw.map((_, i) => { let p = 0, v = 0, c = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++){ p += raw[j].p; v += raw[j].v; c++; } return { p:p/c, v:v/c }; });
      const startK = ports[leg.ends[0]], endK = leg.ends[1] !== null ? ports[leg.ends[1]] : null;
      pts.forEach((q, i) => {
        let { p, v } = sm[i];
        const blend = (k2, dist) => { if (k2 && dist < 7){ const u = dist/7; p = k2.path*(1 - u) + p*u; v = k2.verge*(1 - u) + v*u; } };
        blend(startK, i); blend(endK, n - 1 - i);
        const w = clampWidth(p, v);
        const wasWater = T[q.ly*N + q.lx] === TILE.WATER;
        carveBox(q.lx, q.ly, w.p, w.v);
        if (wasWater && T[q.ly*N + q.lx] === TILE.BRIDGE) bridges++;
      });
    }

    // --- 6. Reachability (4-direction) and repair ---
    let walk = i => PASSABLE[T[i]] === 1;
    const flood = (start) => {
      const seen = new Uint8Array(N*N), q = [start]; seen[start] = 1;
      while (q.length){ const c = q.pop(), x = c % N, y = (c/N) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]){ const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue; const ni = ny*N + nx; if (!seen[ni] && walk(ni)){ seen[ni] = 1; q.push(ni); } } }
      return seen;
    };
    const required = ports.map(p => ({ name:`port ${'EWSN'[p.side]}`, i:p.edgeTile.ly*N + p.edgeTile.lx, gate:p.gate }));
    if (junction) required.push({ name:'junction', i:junction.ly*N + junction.lx, gate:junction });
    let repairs = 0, fallback = false;
    const repairCost = (lx, ly) => { const i = ly*N + lx;
      if (T[i] === TILE.WATER) return river[ri(sx*N + lx, sy*N + ly)] ? COST.repairRiver : COST.surf;
      return isWall(T[i]) ? COST.repairWall*(sampler.isPeak(sx*N + lx, sy*N + ly) ? 2 : 1) : 1; };
    for (let attempt = 0; attempt < 3 && required.length > 1; attempt++){
      const seen = flood(required[0].i), missing = required.filter(r => !seen[r.i]);
      if (!missing.length) break;
      for (const m of missing){
        let target = null, bd = Infinity;          // nearest reached interior tile
        for (let i = 0; i < N*N; i++){ if (!seen[i]) continue; const x = i % N, y = (i/N) | 0; if (!inInterior(x, y)) continue;
          const d = Math.abs(x - m.gate.lx) + Math.abs(y - m.gate.ly); if (d < bd){ bd = d; target = { lx:x, ly:y }; } }
        if (!target) target = required[0].gate;
        const pts = astar(m.gate, target, repairCost);
        if (pts){ for (const q of pts) carveBox(q.lx, q.ly, 3, 0); repairs++; sLog.push(`repair ${repairs}: carved a 3-wide corridor from ${m.name} (${pts.length} tiles)`); }
      }
    }
    let seen = required.length ? flood(required[0].i) : null;
    let unreachable = seen ? required.filter(r => !seen[r.i]).map(r => r.name) : [];
    if (unreachable.length){                       // guaranteed fallback: straight L-shaped corridors via the centre
      fallback = true; const c = { lx:Math.round(N/2), ly:Math.round(N/2) };
      for (const r of required){ const g = r.gate;
        for (let x = Math.min(g.lx, c.lx); x <= Math.max(g.lx, c.lx); x++) forceTile(x, g.ly);
        for (let y = Math.min(g.ly, c.ly); y <= Math.max(g.ly, c.ly); y++) forceTile(c.lx, y); }
      sLog.push('fallback network used: straight corridors through the square centre');
      seen = flood(required[0].i); unreachable = required.filter(r => !seen[r.i]).map(r => r.name);
    }
    function forceTile(cx, cy){ for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){ const x = cx + dx, y = cy + dy;
      if (!inInterior(x, y)) continue; const i = y*N + x;
      if (T[i] === TILE.WATER){ if (river[ri(sx*N + x, sy*N + y)]) T[i] = TILE.BRIDGE; } else if (T[i] !== TILE.BRIDGE) T[i] = TILE.PATH; } }

    bridges = 0; for (let i = 0; i < N*N; i++) if (T[i] === TILE.BRIDGE) bridges++;   // bridge tiles (band + interior)
    let needsSurf = false;                         // can every required point be reached on foot, or only with Surf?
    if (required.length > 1){ walk = i => WALKABLE[T[i]] === 1; const land = WALKABLE[T[required[0].i]] ? flood(required[0].i) : null;
      needsSurf = !land || required.some(q => !land[q.i]); walk = i => PASSABLE[T[i]] === 1; }
    if (needsSurf) sLog.push('needs Surf: some ports are joined only across water');
    results.push({ x:sx, y:sy, N, tiles:T, cls:K, protectedMask, ports, junction, junctionSource, bridges, repairs, fallback, unreachable, needsSurf,
                   log:sLog, connections:ports.map(p => ({ direction:['right', 'left', 'down', 'up'][p.side], to:p.neighbour, offset:0 })) });
  }

  // --- Region-wide checks ---
  const bySq = new Map(results.map(r => [sqId(r.x, r.y), r]));
  const seamIssues = [], seamInfo = [];
  for (const k of contracts){
    const A = bySq.get(sqId(k.a.x, k.a.y)), B = bySq.get(sqId(k.b.x, k.b.y));
    if (!A || !B) continue;                        // one side outside the window
    const pa = A.ports.find(p => p.contract === k.id), pb = B.ports.find(p => p.contract === k.id);
    if (!pa || !pb || pa.pos !== pb.pos || pa.path !== pb.path || pa.verge !== pb.verge){ seamIssues.push(`contract ${k.key}: the two sides disagree`); continue; }
    let blocked = 0, mismatch = 0;
    for (let t = 0; t < N; t++){
      const ia = k.horiz ? t*N + (N - 1) : (N - 1)*N + t, ib = k.horiz ? t*N : t;
      const wa = PASSABLE[A.tiles[ia]], wb = PASSABLE[B.tiles[ib]];
      const inPath = t >= k.pos - k.lo && t <= k.pos + k.hi;
      if (inPath && !(wa && wb)) blocked++;
      if (wa !== wb) mismatch++;
    }
    if (blocked) seamIssues.push(`contract ${k.key}: ${blocked} path tile(s) blocked at the seam`);
    if (mismatch) seamInfo.push(`contract ${k.key}: ${mismatch} edge tile(s) passable on one side only (a wall meets open ground or water)`);
  }
  // reciprocity and graph connectivity (within the window)
  const reciprocal = [];
  for (const r of results) for (const c of r.connections){
    const o = bySq.get(sqId(c.to.x, c.to.y)); if (!o) continue;
    if (!o.connections.some(oc => oc.to.x === r.x && oc.to.y === r.y)) reciprocal.push(`${r.x},${r.y} → ${c.to.x},${c.to.y} has no return connection`);
  }
  const parent = new Map(results.map(r => [sqId(r.x, r.y), sqId(r.x, r.y)]));
  const find = a => { while (parent.get(a) !== a){ parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const k of contracts){ const ia = sqId(k.a.x, k.a.y), ib = sqId(k.b.x, k.b.y); if (parent.has(ia) && parent.has(ib)) parent.set(find(ia), find(ib)); }
  const components = new Set([...parent.keys()].map(find)).size;

  const report = {
    version, seed:inp.seed || 0, N, band:BAND, squares:results.length, contracts:contracts.length,
    seamFailures:seamIssues, seamNotes:seamInfo, reciprocityFailures:reciprocal, components,
    unreachable:results.filter(r => r.unreachable.length).map(r => `${r.x},${r.y}: ${r.unreachable.join(', ')}`),
    repairs:results.reduce((s, r) => s + r.repairs, 0), fallbacks:results.filter(r => r.fallback).length,
    firstPassReachable:results.filter(r => !r.repairs && !r.fallback).length,
    bridgeTiles:results.reduce((s, r) => s + r.bridges, 0),
    needSurf:results.filter(r => r.needsSurf).map(r => `${r.x},${r.y}`)
  };
  report.ok = !seamIssues.length && !reciprocal.length && !report.unreachable.length;
  return { version, N, band:BAND, window:win, squares:results, contracts, report, log };
}

// ----- Preview colours (RGBA image of the window; inactive squares are dimmed) -----
const COLORS = {
  [TILE.OPEN]:[120, 200, 80], [TILE.PATH]:[222, 196, 140], [TILE.VERGE]:[164, 220, 110], [TILE.TREE]:[40, 112, 56],
  [TILE.ROCK]:[150, 120, 90], [TILE.WATER]:[72, 160, 224], [TILE.BRIDGE]:[176, 120, 64]
};
const OPEN_TINT = { [CLS.DESERT]:[228, 208, 152], [CLS.SNOW]:[232, 240, 248], [CLS.TUNDRA]:[180, 188, 156], [CLS.WETLAND]:[112, 176, 144],
  [CLS.CROP]:[200, 204, 96], [CLS.URBAN]:[176, 172, 180], [CLS.DRY]:[168, 200, 96] };
function toRGBA(res, opts = {}){
  const N = res.N, W = res.window.w*N, H = res.window.h*N, img = new Uint8ClampedArray(W*H*4);
  for (let i = 0; i < W*H; i++){ img[i*4] = 40; img[i*4 + 1] = 44; img[i*4 + 2] = 60; img[i*4 + 3] = 255; }
  for (const s of res.squares){
    const ox = (s.x - res.window.x0)*N, oy = (s.y - res.window.y0)*N;
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++){
      const i = ly*N + lx, t = s.tiles[i];
      let c = COLORS[t]; if (t === TILE.OPEN && OPEN_TINT[s.cls[i]]) c = OPEN_TINT[s.cls[i]];
      let [r, g, b] = c;
      if (opts.showBand && s.protectedMask[i] && t !== TILE.PATH && t !== TILE.VERGE){ r = r*0.85; g = g*0.85; b = b*0.85; }
      const o = ((oy + ly)*W + ox + lx)*4; img[o] = r; img[o + 1] = g; img[o + 2] = b;
    }
  }
  if (opts.showSeams) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    if (x % N && y % N) continue; const o = (y*W + x)*4; img[o] = img[o]*0.6 + 102; img[o + 1] = img[o + 1]*0.6; img[o + 2] = img[o + 2]*0.6;
  }
  return { width:W, height:H, data:img };
}

const api = { VERSION, BAND, TILE, CLS, PROFILE, LIMITS, COST, generate, toRGBA, makeSeeds, hash32, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.OverworldGen = api;
})(typeof self !== 'undefined' ? self : this);
