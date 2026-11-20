"""Build the hosted mobile demo (demo/index.html) from the full version (regionMapForge.html).

The demo runs as a hosted artifact, which can't reach other websites (no map tiles, OpenStreetMap,
Wikipedia, or library CDNs) and blocks prompt() and downloads. So this script:
  - swaps Leaflet for a tiny offline stand-in (the editor only needs its Web-Mercator maths),
  - replaces forging with a fictional-region generator that feeds the *same* town picking, routing,
    route naming, rerolls, locks, themes, animations and undo/redo as the full version,
  - turns prompt() calls into an in-page text dialog,
  - hides what can't work there: map frame, real-map overlay, share links, Wikipedia, import/export.

Every edit is checked, so if the full version changes in a way this script doesn't expect, it stops
with a clear error instead of producing a broken demo.

Usage:  python tools/build_demo.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'regionMapForge.html'), encoding='utf-8').read()
s = src

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f'build_demo: expected {count} of {old[:70]!r}, found {n}')
    s = s.replace(old, new)

# ---------------- page shell ----------------
rep('<title>Region Map Forge — Gen 3 Style, Emerald Grid</title>', '<title>Region Map Forge (Mobile Demo)</title>')
rep('<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">\n', '')
rep('<p>Frame a real place → forge a Gen 3-style Town Map on <span id="gridIntro">Emerald\'s 28×15 grid</span>.</p>',
    '<p>Mobile demo: fictional regions, generated in your browser. For real places, open the '
    '<a href="https://ajdur96.github.io/poke-region-map/" style="color:var(--accent)">full version</a>.</p>')
rep('<div class="label pixel">1 · CHOOSE AN AREA</div>', '<div class="label pixel">1 · NEW REGION</div>')
for old in ['<div class="search">', '<div id="mapWrap">', '<div class="row">Rotate', '<div class="row">km per square']:
    rep(old, old.replace('<div ', '<div style="display:none" ', 1))
rep('<div class="hint" id="scaleInfo" style="margin-top:0"></div>', '<div class="hint" id="scaleInfo" style="display:none"></div>')
rep('    <div class="row">\n      <label><input type="checkbox" id="overlayOn">',
    '    <div class="row" style="display:none">\n      <label><input type="checkbox" id="overlayOn">')
rep('<button class="primary" id="forgeBtn">FORGE REGION ▶</button>', '<button class="primary" id="forgeBtn">NEW REGION ▶</button>')
rep('  .hint{font-size:12px;opacity:.7;margin-top:8px}',
    '  .hint{font-size:12px;opacity:.7;margin-top:8px}\n'
    '  #importBtn,#shareBtn,#shareOut,#pngBtn,#pngRawBtn,#jsonBtn,#emeraldBtn{display:none!important}\n'
    '  .dlg{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}\n'
    '  .dlgBox{width:100%;max-width:360px}')
credit_start = s.index('  <p class="hint" style="text-align:center">Data:')
credit_end = s.index('</p>', credit_start) + 4
s = s[:credit_start] + '  <p class="hint" style="text-align:center">A fictional region made in your browser. Same editor as the full version, minus the real-world data.</p>' + s[credit_end:]
rep('</main>', '''</main>
<div class="dlg" id="dlg"><div class="textbox pixel dlgBox"><div id="dlgLabel"></div>
  <input type="text" id="dlgInput" style="width:100%;margin:10px 0;color:#000;background:#fff;border-color:#586898">
  <div class="actions"><button class="primary" id="dlgOk">OK</button><button id="dlgCancel">CANCEL</button></div></div></div>''')

# ---------------- Leaflet → offline stand-in ----------------
rep('<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>', r'''<script>
// Offline stand-in for Leaflet. The hosted demo can't load libraries or map tiles from other sites,
// and the editor only needs Leaflet's Web-Mercator maths, so this provides just that.
(() => {
  const P = (lat, lng, z) => { const s = 256*2**z, si = Math.sin(lat*Math.PI/180);
    return { x:(lng + 180)/360*s, y:(0.5 - Math.log((1 + si)/(1 - si))/(4*Math.PI))*s }; };
  const U = (x, y, z) => { const s = 256*2**z; return { lat:Math.atan(Math.sinh(Math.PI*(1 - 2*y/s)))*180/Math.PI, lng:x/s*360 - 180 }; };
  const LL = a => Array.isArray(a) ? { lat:a[0], lng:a[1] } : a;
  const map = {
    c:{ lat:40, lng:0 }, z:8,
    setView(c, z){ this.c = LL(c); if (Number.isFinite(z)) this.z = z; return this; },
    setZoom(z){ if (Number.isFinite(z)) this.z = z; return this; },
    getCenter(){ return this.c; }, getZoom(){ return this.z; },
    on(){ return this; }, setMinZoom(){}, setMaxZoom(){}, invalidateSize(){}, fitBounds(){},
    project(ll, z){ ll = LL(ll); return P(ll.lat, ll.lng, z ?? this.z); },
    unproject(p, z){ return Array.isArray(p) ? U(p[0], p[1], z ?? this.z) : U(p.x, p.y, z ?? this.z); },
    containerPointToLatLng(p){ const c = P(this.c.lat, this.c.lng, this.z); return U(c.x + (p.x ?? p[0]), c.y + (p.y ?? p[1]), this.z); },
    latLngToLayerPoint(){ return { x:0, y:0 }; }, getPanes(){ return { overlayPane:document.createElement('div') }; }
  };
  window.L = { map:() => map, tileLayer:() => ({ addTo(){} }), latLng:(a, b) => ({ lat:a, lng:b }), point:(x, y) => ({ x, y }) };
})();
</script>''')

# ---------------- prompt() → in-page dialog (artifacts block prompt) ----------------
rep("  b.onclick = () => { pushUndo(); fn(); renumber(); render(); showInfo(); };",
    "  b.onclick = async () => { pushUndo(); await fn(); renumber(); render(); showInfo(); };")
rep("actionBtn('RENAME', () => { const v = prompt('New name:', t.name);",
    "actionBtn('RENAME', async () => { const v = await askText('New name:', t.name);")
rep("actionBtn('RENAME', () => { const v = prompt('Name this route:', r.name);",
    "actionBtn('RENAME', async () => { const v = await askText('Name this route:', r.name);")
rep("cv.addEventListener('pointerdown', e => {", "cv.addEventListener('pointerdown', async e => {")
rep("      const name = prompt('Name your new town:', 'New Town');", "      const name = await askText('Name your new town:', 'New Town');")
rep("      const name = prompt('Name your new landmark:', 'New Landmark');", "      const name = await askText('Name your new landmark:', 'New Landmark');")
rep("$('titleBar').onclick = () => {", "$('titleBar').onclick = async () => {")
rep("  const v = prompt('Name this region (leave empty for an automatic name):', state.regionName);",
    "  const v = await askText('Name this region (leave empty for an automatic name):', state.regionName);")
rep("$('listBody').addEventListener('click', e => {", "$('listBody').addEventListener('click', async e => {")
rep("    const v = prompt(type === 'town' ? 'Rename this place:' : 'Rename this route:', cur.name);",
    "    const v = await askText(type === 'town' ? 'Rename this place:' : 'Rename this route:', cur.name);")
if re.search(r'(?<![\w.])prompt\(', s):
    sys.exit('build_demo: a prompt() call is left; add a conversion for it')

# ---------------- the fictional-region generator ----------------
DEMO_JS = r'''<script>
// ===== Mobile demo: fictional regions =====
// Generates terrain, rivers, places and named features, then hands them to the same town picking,
// routing, naming, reroll, lock, theme and animation code as the full version.
function askText(label, def){                      // in-page replacement for prompt()
  return new Promise(resolve => {
    $('dlgLabel').textContent = label; $('dlgInput').value = def || ''; $('dlg').style.display = 'flex';
    const done = v => { $('dlg').style.display = 'none'; $('dlgOk').onclick = $('dlgCancel').onclick = null; resolve(v); };
    $('dlgOk').onclick = () => done($('dlgInput').value);
    $('dlgCancel').onclick = () => done(null);
    $('dlgInput').onkeydown = e => { if (e.key === 'Enter') done($('dlgInput').value); };
    setTimeout(() => $('dlgInput').focus(), 50);
  });
}
showWiki = () => {};                               // the hosted demo can't reach Wikipedia

const DEMO_KPS = 5;                                // km per grid square for fictional regions
const SYL_A = ['Ash', 'Briar', 'Cinder', 'Dusk', 'Ember', 'Fern', 'Gale', 'Haven', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Moss',
  'Nimbus', 'Oak', 'Pebble', 'Quill', 'Rook', 'Sage', 'Thistle', 'Umber', 'Vale', 'Willow', 'Yarrow', 'Zephyr', 'Cobalt', 'Coral',
  'Drift', 'Glimmer', 'Hollow', 'Lantern', 'Marrow', 'Opal', 'Saffron', 'Tamber', 'Wren', 'Bracken', 'Cairn', 'Heath', 'Sorrel'];
const SYL_B = ['ton', 'ford', 'brook', 'wick', 'mere', 'vale', 'field', 'haven', 'port', 'crest', 'stead', 'bury', 'ridge', 'moor', 'dale', 'cliff'];
function demoWord(rng, used){
  for (let k = 0; k < 200; k++){
    const w = SYL_A[Math.floor(rng()*SYL_A.length)] + (rng() < .65 ? SYL_B[Math.floor(rng()*SYL_B.length)] : '');
    if (!used.has(w)){ used.add(w); return w; }
  }
  return 'Nameless';
}
const value2 = (rng) => (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, sm = t => t*t*(3 - 2*t);
  const h = (a, b) => hash(a + 1013, b + 2027); const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a)*sm(u) + (c - a)*sm(v) + (a - b - c + d)*sm(u)*sm(v); };

function demoBounds(rng){
  // A pretend location: a mid-northern latitude, at the longitude of your time zone (for the Live theme)
  const lat = 34 + rng()*14, lng = Math.max(-179, Math.min(179, -new Date().getTimezoneOffset()/4));
  const wKm = MW*DEMO_KPS, hKm = MH*DEMO_KPS, dLng = wKm/(111.32*Math.cos(lat*Math.PI/180)), dLat = hKm/110.57;
  const c = { tl:{ lat:lat + dLat/2, lng:lng - dLng/2 }, tr:{ lat:lat + dLat/2, lng:lng + dLng/2 },
              bl:{ lat:lat - dLat/2, lng:lng - dLng/2 }, br:{ lat:lat - dLat/2, lng:lng + dLng/2 } };
  return { n:c.tl.lat, s:c.bl.lat, w:c.tl.lng, e:c.tr.lng, corners:c, center:{ lat, lng }, rot:0, kmPerSquare:DEMO_KPS, wKm, hKm };
}

function demoTerrain(rng, used){
  const noise = value2(rng), fbm = (x, y) => { let s = 0, amp = 1, f = 1, n = 0; for (let o = 0; o < 5; o++){ s += noise(x*f, y*f)*amp; n += amp; amp *= .5; f *= 2; } return s/n; };
  const e = new Float32Array(SW*SH), cx = .4 + rng()*.2, cy = .4 + rng()*.2;
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++){
    const dx = (x/SW - cx)*1.6, dy = (y/SH - cy)*1.9;
    e[y*SW + x] = fbm(x/22, y/22) - Math.sqrt(dx*dx + dy*dy)*.55;
  }
  const sorted = Array.from(e).sort((a, b) => a - b), q = p => sorted[Math.floor(p*(sorted.length - 1))];
  const sea = q(.42), top = q(1);
  const land = Array.from(e).filter(v => v > sea).sort((a, b) => a - b), ql = p => land[Math.floor(p*(land.length - 1))];
  const hillT = ql(.55), mtnT = ql(.84), peakT = ql(.97);
  const terr = new Uint8Array(SW*SH), elev = new Float32Array(SW*SH);
  for (let i = 0; i < SW*SH; i++){
    elev[i] = (e[i] - sea)/(top - sea)*2600;
    terr[i] = e[i] <= sea ? T.SEA : e[i] > peakT ? T.PEAK : e[i] > mtnT ? T.MTN : e[i] > hillT ? T.HILL : T.LAND;
  }
  // Rivers start high and run downhill until they reach water
  const river = new Uint8Array(SW*SH), names = new Map(), highs = [];
  for (let i = 0; i < SW*SH; i++) if (terr[i] >= T.MTN) highs.push(i);
  for (let i = highs.length - 1; i > 0; i--){ const j = Math.floor(rng()*(i + 1)); [highs[i], highs[j]] = [highs[j], highs[i]]; }
  let made = 0;
  for (const src of highs){
    if (made >= 3) break;
    let i = src; const path = [], seen = new Set();
    while (terr[i] !== T.SEA && path.length < 300 && !seen.has(i)){
      seen.add(i); path.push(i);
      const x = i % SW, y = (i/SW) | 0; let best = -1, bv = Infinity;
      for (let d = 0; d < 4; d++){ const nx = x + DX[d], ny = y + DY[d]; if (!inSub(nx, ny)) continue; const j = ny*SW + nx; if (!seen.has(j) && e[j] < bv){ bv = e[j]; best = j; } }
      if (best < 0) break; i = best;
    }
    if (terr[i] !== T.SEA || path.length < 18 || path.some(p => river[p])) continue;
    const name = demoWord(rng, used) + ' River'; made++;
    for (const p of path) if (terr[p] < T.MTN){ river[p] = 1; names.set(Math.floor(((p/SW) | 0)/SUB)*MW + Math.floor((p % SW)/SUB), name); }
  }
  // Land cover from a second "moisture" field: forests where wet, marsh on wet lowlands, desert where dry, snow up high
  const wet = value2(rng), moist = (x, y) => (wet(x/18, y/18)*.7 + wet(x/7 + 9, y/7 + 9)*.3), dryShift = rng()*.12;
  const cover = new Uint8Array(SW*SH);
  for (let i = 0; i < SW*SH; i++){
    if (terr[i] === T.SEA) continue;
    const x = i % SW, y = (i/SW) | 0, m = moist(x, y) - dryShift;
    if (terr[i] >= T.MTN && elev[i] > 1900) cover[i] = C.SNOW;
    else if (terr[i] >= T.MTN) continue;
    else if (m > .62 && elev[i] < 260 && terr[i] === T.LAND) cover[i] = C.WETLAND;
    else if (m > .55) cover[i] = C.FOREST;
    else if (m < .22) cover[i] = C.DESERT;
    else if (m < .3) cover[i] = C.DRY;
  }
  // A made-up climate to match: deserts are hot deserts, snow and peaks are tundra, wet forests are humid subtropical…
  const climate = new Uint8Array(SW*SH);
  for (let i = 0; i < SW*SH; i++) if (terr[i] !== T.SEA)
    climate[i] = cover[i] === C.DESERT ? 7 : cover[i] === C.DRY ? 6 : cover[i] === C.SNOW || terr[i] === T.PEAK ? 31
      : cover[i] === C.WETLAND ? 1 : cover[i] === C.FOREST ? 9 : 10;
  state.terrain = terr; state.cover = cover; state.climate = climate; state.elev = elev; state.river = river; state.riverNames = names;
  derive();
}

// Named seas, lakes, ranges, plains and peaks (for route names and landmarks)
function demoFeatures(rng, used){
  const N = { lake:new Map(), sea:new Map(), range:new Map(), land:new Map(), peaks:[] }, landmarks = [];
  const isLake = (x, y) => state.lake[(y*SUB + 2)*SW + x*SUB + 2] === 1;
  const comps = test => { const seen = new Set(), out = [];
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++){
      const k = y*MW + x; if (seen.has(k) || !test(x, y)) continue;
      const cells = [[x, y]]; seen.add(k);
      for (let h = 0; h < cells.length; h++){ const [cx, cy] = cells[h];
        for (let d = 0; d < 4; d++){ const nx = cx + DX[d], ny = cy + DY[d], nk = ny*MW + nx; if (inSq(nx, ny) && !seen.has(nk) && test(nx, ny)){ seen.add(nk); cells.push([nx, ny]); } } }
      out.push(cells);
    } return out; };
  const centre = cells => cells.reduce((a, [x, y]) => [a[0] + x/cells.length, a[1] + y/cells.length], [0, 0]);
  const seaName = `${demoWord(rng, used)} ${rng() < .5 ? 'Sea' : 'Bay'}`;
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (sqKind(x, y) === 'water' && !isLake(x, y)) N.sea.set(y*MW + x, seaName);
  for (const cells of comps((x, y) => sqKind(x, y) === 'water' && isLake(x, y))){
    const name = 'Lake ' + demoWord(rng, used); cells.forEach(([x, y]) => N.lake.set(y*MW + x, name));
    const [cx, cy] = centre(cells), ll = toLatLng(cx, cy);
    landmarks.push({ name, lat:ll.lat, lon:ll.lng, score:1.5, natural:true, kind:'water' });
  }
  for (const cells of comps((x, y) => sqKind(x, y) === 'mountain' || sqKind(x, y) === 'hill')){
    if (cells.length < 4) continue;
    const base = demoWord(rng, used), range = `${base} Range`;
    cells.forEach(([x, y]) => N.range.set(y*MW + x, range));
    const top = cells.reduce((a, c) => state.sqElev[c[1]*MW + c[0]] > state.sqElev[a[1]*MW + a[0]] ? c : a);
    const ll = toLatLng(top[0], top[1]), ele = state.sqElev[top[1]*MW + top[0]], peak = 'Mt. ' + base;
    N.peaks.push({ name:peak, lat:ll.lat, lon:ll.lng });
    landmarks.push({ name:peak, lat:ll.lat, lon:ll.lng, score:1 + ele/1000, natural:true, kind:'peak' });
  }
  for (const cells of comps((x, y) => sqKind(x, y) === 'land')){
    if (cells.length < 25) continue;
    const plain = { name:`${demoWord(rng, used)} ${rng() < .5 ? 'Plains' : 'Downs'}`, kind:'plain' };
    cells.forEach(([x, y]) => N.land.set(y*MW + x, plain));
  }
  // a few made-up sights on dry land
  const sights = ['Old Lighthouse', 'Starfall Ruins', 'Wind Tower', 'Glass Bridge', 'Ancient Grove', 'Sunken Pier', 'Echo Cave', 'Crystal Spring'];
  for (let k = 0, tries = 0; k < 3 && tries < 300; tries++){
    const x = Math.floor(rng()*MW), y = Math.floor(rng()*MH);
    if (sqKind(x, y) === 'water') continue;
    const ll = toLatLng(x, y); landmarks.push({ name:sights[Math.floor(rng()*sights.length)], lat:ll.lat, lon:ll.lng, score:.9, natural:false, kind:'' }); k++;
  }
  state.names = N;
  return landmarks.filter((l, i, a) => a.findIndex(o => o.name === l.name) === i);
}

// Fictional towns: mostly small, a few big. Bigger ones get "City", mid-sized ones "Town", like the games.
function demoPlaces(rng, used){
  const places = [], taken = new Set();
  for (let tries = 0; places.length < 70 && tries < 5000; tries++){
    const x = Math.floor(rng()*MW), y = Math.floor(rng()*MH), k = sqKind(x, y);
    if (k === 'water' || k === 'mountain' || taken.has(y*MW + x)) continue;
    taken.add(y*MW + x);
    const pop = Math.round(10 ** (2.9 + Math.pow(rng(), 1.6)*2.9));
    const name = demoWord(rng, used) + (pop >= 150000 ? ' City' : pop >= 20000 ? ' Town' : '');
    const ll = toLatLng(x - .5 + rng(), y - .5 + rng());
    places.push({ name, lat:ll.lat, lon:ll.lng, pop, place:pop >= 100000 ? 'city' : pop >= 10000 ? 'town' : 'village', capital:'' });
  }
  return places;
}

// A few named roads linking the biggest places (a spanning tree), so routes can follow and be named after them
const ROAD_NAMES = ['Old Coast Road', "King's Highway", 'Ridgeline Road', 'Lantern Way', 'Sunset Highway', "Miner's Road",
  'Pilgrim Road', 'Harbor Road', 'Valley Highway', 'Market Road', 'Lighthouse Road', 'Meadow Way'];
function demoRoads(rng, places){
  const big = places.slice().sort((a, b) => b.pop - a.pop).slice(0, 7).map(p => ({ ...p, ...toSqF(p.lat, p.lon) }));
  if (big.length < 2) return;
  const names = ROAD_NAMES.slice().sort(() => rng() - .5), ways = [], inTree = [big[0]], rest = big.slice(1);
  while (rest.length){
    let best = null;
    for (const a of inTree) for (const b of rest){ const d = Math.hypot(a.x - b.x, a.y - b.y); if (!best || d < best.d) best = { a, b, d }; }
    rest.splice(rest.indexOf(best.b), 1); inTree.push(best.b);
    const { a, b } = best, mx = (a.x + b.x)/2 + (rng() - .5)*2, my = (a.y + b.y)/2 + (rng() - .5)*2;   // a gentle bend
    const pts = [a, { x:mx, y:my }, b].map(q => { const ll = toLatLng(q.x - .5, q.y - .5); return { lat:ll.lat, lon:ll.lng }; });
    ways.push({ tags:{ highway:ways.length < 2 ? 'motorway' : 'trunk', name:names[ways.length % names.length] }, geometry:pts });
  }
  ingestRoads(ways);
}

function demoForge(){
  if (state.forging) return;
  if (state.terrain) pushUndo();
  clearRegion();
  setGrid($('gridSize').value);
  state.seed = Math.floor(Math.random()*1e6); state.nextId = 1; state.variant = 0;
  const rng = seededRng(state.seed), used = new Set();
  state.gen = makeGen(demoBounds(rng), 10);
  demoTerrain(rng, used);
  const landmarks = demoFeatures(rng, used), places = demoPlaces(rng, used);
  demoRoads(rng, places);
  state.source = { places, landmarks };
  state.towns = pickTowns(places, +$('townCount').value, $('landmarks').checked, landmarks, { variant:0 });
  layRoutes(); renumber(); suggestRegionName();
  const st = townById(state.startId); state.cursor = st ? { x:st.x, y:st.y } : { x:0, y:0 };
  startReveal('terrain'); startReveal('routes');
  refreshTheme(); render(); showInfo();
  setStatus(`Generated ${state.towns.filter(t => t.kind !== 'landmark').length} towns and ${state.routes.length} routes.`);
}
$('forgeBtn').onclick = demoForge;
if (!state.terrain) demoForge();                   // first visit: make a region straight away
</script>'''
rep('</body>', DEMO_JS + '\n</body>')

out = os.path.join(ROOT, 'demo', 'index.html')
open(out, 'w', encoding='utf-8').write(s)
print(f'demo built: {out} ({len(s)/1024:.0f} KB)')
