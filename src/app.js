const $ = (s) => document.querySelector(s);
function setLoadingStatus(message) { const status = $('#loading-status'); if (status) status.textContent = message; }
function completeLoading() { $('#loading-screen')?.classList.add('is-complete'); }
function failLoading(error) { console.error(error); const screen = $('#loading-screen'); setLoadingStatus('Unable to open the fabric. Please reload.'); screen?.classList.add('has-error'); }
const canvas = $('#fabric'), gl = canvas.getContext('webgl2', {antialias: false, alpha: false});
if (!gl) throw new Error('WOVEN requires WebGL2.');
const VERTEX_SHADER = `#version 300 es
in vec2 a_position; in vec4 a_color; in float a_size; in float a_softness;
uniform vec2 u_resolution; uniform vec2 u_center; uniform vec2 u_pan; uniform float u_scale; uniform float u_pixel_ratio;
out vec4 v_color; out float v_softness;
void main() { vec2 scene = (a_position - u_center + u_pan) * u_scale + u_center; vec2 clip = vec2(scene.x / u_resolution.x * 2.0 - 1.0, 1.0 - scene.y / u_resolution.y * 2.0); gl_Position = vec4(clip, 0.0, 1.0); gl_PointSize = a_size * u_pixel_ratio; v_color = a_color; v_softness = a_softness; }`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float; in vec4 v_color; in float v_softness; out vec4 out_color;
void main() { float radius = distance(gl_PointCoord, vec2(.5)); if (radius > .5) discard; float feather = 1.0 - smoothstep(.12, .5, radius); out_color = vec4(v_color.rgb, v_color.a * mix(1.0, feather, v_softness)); }`;
function shader(type, source) { const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value); if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value)); return value; }
const program = gl.createProgram(); gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX_SHADER)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
const pointBuffer = gl.createBuffer(), positionLoc = gl.getAttribLocation(program, 'a_position'), colorLoc = gl.getAttribLocation(program, 'a_color'), sizeLoc = gl.getAttribLocation(program, 'a_size'), softnessLoc = gl.getAttribLocation(program, 'a_softness');
const uniforms = Object.fromEntries(['u_resolution', 'u_center', 'u_pan', 'u_scale', 'u_pixel_ratio'].map((name) => [name, gl.getUniformLocation(program, name)]));
const LOD_LABELS = ['Overview', 'Cluster', 'Artist'];
const rgb = (hex) => hex.match(/\w\w/g).slice(0, 3).map((value) => parseInt(value, 16) / 255);
const PALETTES = {
  '1': {name: 'No.1 — Jet black', paper: '#050505', base: '#1f7a8c', bright: '#bfdbf7', accent: '#e1e5f2', outgoing: '#ffffff', incoming: '#bfdbf7'},
  '2': {name: 'No.2 — Wisteria', paper: '#050505', base: '#53687e', bright: '#f5e9e2', accent: '#98a6d4', outgoing: '#f5e9e2', incoming: '#7871aa'},
  '3': {name: 'No.3 — Tangerine', paper: '#050505', base: '#4ce0b3', bright: '#ffaf87', accent: '#ff8e72', outgoing: '#ed6a5e', incoming: '#ffaf87'},
  '4': {name: 'No.4 — Prussian blue', paper: '#050505', base: '#0353a4', bright: '#b9d6f2', accent: '#006daa', outgoing: '#b9d6f2', incoming: '#003559'},
  '5': {name: 'Default — WOVEN', paper: '#000000', base: '#e2d5c5', bright: '#f99848', accent: '#f99848', outgoing: '#f2ee82', incoming: '#f2ee82'},
};
let paletteId = '5', palette = PALETTES[paletteId];
function paletteRgbValues(value) { return Object.fromEntries(['paper', 'base', 'bright', 'accent', 'outgoing', 'incoming'].map((key) => [key, rgb(value[key])])); }
let paletteColors = paletteRgbValues(palette);
const PALETTE_EDITOR_ROLES = {
  background: {keys: ['paper'], source: 'paper'},
  vector: {keys: ['base'], source: 'base'},
  highlight: {keys: ['outgoing', 'incoming'], source: 'outgoing'},
  glow: {keys: ['bright', 'accent'], source: 'bright'},
};
function syncPaletteEditors() {
  Object.entries(PALETTE_EDITOR_ROLES).forEach(([role, {source}]) => {
    const control = $(`#color-${role}`);
    if (!control) return;
    control.value = palette[source];
    control.nextElementSibling.textContent = palette[source].toUpperCase();
  });
}
function setPaletteEditorColor(role, value) {
  const editor = PALETTE_EDITOR_ROLES[role];
  if (!editor || !/^#[0-9a-f]{6}$/i.test(value)) return;
  palette = {...palette}; editor.keys.forEach((key) => { palette[key] = value; });
  paletteId = 'custom'; paletteColors = paletteRgbValues(palette);
  $('#palette').value = paletteId;
  const control = $(`#color-${role}`); if (control) control.nextElementSibling.textContent = value.toUpperCase();
  draw();
}
let data, selected = 'all', yearIndex = 0, lodIndex = 0, cameraZoom = 0, cameraPan = {x: 0, y: 0}, dragState, ignoreNextClick = false, sound = false, glowVolume = .5, highlightVolume = .15, clackVolume = .1, bassoVolume = .3, reverbAmount = .6, audio, audioBus, reverbBus, glowBus, highlightBus, clackBus, bassoBus, glowInstrument = 'synth', weaveClackId, selectedLink;
let artworkCatalog = new Map(), artworkCatalogBySlug = new Map(), tileManifest;
let relationCache = {key: '', raw: [], works: new Map(), artists: new Map()};
let tileCache = new Map(), tiles = new Map(), tileLoads = new Map();
let aggregateWasm;
const compactScaleCache = new WeakMap();
const yearDeltaCache = new Map();
const yearArrivalCache = new Map();
const artistOverlayCache = new Map();
const overlayPulseCellCache = new Map();
const overlayRenderCache = new Map();
const bassoSampleCache = new Map();
let yearAnimation, animationFrame, fullscreenChromeTimer, playerChromeTimer, loopArtworkYear = false, tilePrefetchHandle, tilePrefetchQueue = [];
const LOD_KEYS = ['overview'];
const PORTRAIT_OVERVIEW_KEY = 'overview-portrait';
const WIDE_OVERVIEW_KEY = 'overview-wide';
const ULTRA_OVERVIEW_KEY = 'overview-ultra';
const MAX_TILE_PIXEL_RATIO = 1.5;
// A tile can contain several million occupied cells.  That is useful as a
// source representation, but submitting all of them every animation frame is
// needlessly expensive: neighbouring cells resolve to the same few screen
// pixels.  Keep the source-resolution files, then fold them into a bounded
// draw budget on the client.
const MAX_DRAW_CELLS = matchMedia('(max-width:650px)').matches ? 120000 : 300000;
const TILE_CACHE_LIMIT = 8;
const YEAR_DELTA_CACHE_LIMIT = 4;
const YEAR_ARRIVAL_CELL_LIMIT = matchMedia('(max-width:650px)').matches ? 4500 : 12000;
const MAX_CANVAS_PIXEL_RATIO = 1.5;
// The browser field deliberately omits zero-event Artists from its display
// coordinate system.  The complete Classii ledger remains in DuckDB/Parquet;
// this version names the compact, event-bearing projection used by WebGL.
const DATASET_VERSION = 'artist-first-display-20261014-v1';
const YEAR_DURATION_AT_1X = 1400;
const YEAR_ARRIVAL_DURATION = 340;
const BASSO_X_BANDS = 7;
const ARTIST_OVERLAY_CACHE_LIMIT = 2;
const OVERLAY_RENDER_CACHE_LIMIT = 24;
const INSTRUMENT_CATALOG_URL = '/public/audio/instruments/manifest.json';
const WAVE_CATALOG_URL = '/public/audio/wave/manifest.json';
const DEFAULT_WEAVE_CLACK = '489000__phonosupf__wood-bell.wav';
// The reference field is the normal in-page canvas.  Pulses need to grow with
// the available drawing surface: otherwise fullscreen spreads the columns out
// while leaving a fixed-pixel flare too small to read as light.
const GLOW_REFERENCE_SIZE = {width: 1280, height: 620};
function fabricInset(width, height) { return Math.max(16, Math.min(30, Math.round(Math.min(width, height) * .1))); }
const instrumentCatalog = new Map(), loadedInstrumentPacks = new Map();
const waveCatalog = new Map(), weaveClackBuffers = new Map(), weaveClackPromises = new Map();
const ARTWORK_CATALOG_URL = '/public/data/artworks/catalog.json?v=artist-birth-years-3';
const RUNTIME_INDEX_URL = '/public/data/woven-runtime/index.json';
const RUNTIME_ARTIST_BASE_URL = '/public/data/woven-runtime/artists';

function artworkRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length === 3 && parts[0] === 'artists') {
    const [_, slug, year] = parts;
    if (/^[0-9]+$/.test(year)) return {slug: decodeURIComponent(slug), year: Number(year), source: 'path'};
  }
  if (parts.length === 4 && parts[0] === 'artists') {
    const [_, classiiId, slug, year] = parts;
    if (/^[0-9]+$/.test(year)) return {classiiId: decodeURIComponent(classiiId), slug: decodeURIComponent(slug), year: Number(year), source: 'path'};
  }
  const query = new URLSearchParams(location.search), classiiId = query.get('artist'), year = query.get('year');
  if (classiiId && year && /^[0-9]+$/.test(year)) return {classiiId, slug: query.get('slug') || '', year: Number(year), source: 'query'};
  return undefined;
}
const requestedArtwork = artworkRoute();
function syncMobileArtworkAspect() {
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--mobile-fullscreen-aspect', String(Math.min(1, width / Math.max(1, height))));
  if (requestedArtwork && matchMedia('(max-width:650px)').matches) {
    canvas.parentElement.style.marginInline = 'auto';
    canvas.parentElement.style.setProperty('--mobile-canvas-height', `${Math.round(Math.max(380, Math.min(650, height - 280)))}px`);
  }
  const caption = $('#canvas-caption');
  if (caption && !requestedArtwork && matchMedia('(max-width:650px)').matches) { caption.style.alignItems = 'center'; caption.style.textAlign = 'center'; }
  else if (caption) { caption.style.removeProperty('align-items'); caption.style.removeProperty('text-align'); }
}
syncMobileArtworkAspect();
window.addEventListener('resize', syncMobileArtworkAspect);
window.visualViewport?.addEventListener('resize', syncMobileArtworkAspect);
function artworkUrl(entry, year) {
  const isLocalPreview = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  if (isLocalPreview) return `/?${new URLSearchParams({artist: entry.classiiId, slug: entry.slug, year: String(year)})}`;
  return `/artists/${encodeURIComponent(entry.slug)}/${year}`;
}
function updateArtworkMetadata(entry, displayName, year) {
  const title = `WOVEN — ${displayName} · ${year}`;
  const description = `${displayName} · ${year}, a WOVEN artist relation temporal field from the Classii cultural graph.`;
  const route = `/artists/${encodeURIComponent(entry.slug)}/${year}`;
  const absolute = new URL(route, location.origin).href;
  const image = new URL(`/og/artists/${encodeURIComponent(entry.slug)}/${year}.png`, location.origin).href;
  const set = (selector, content) => { const node = document.querySelector(selector); if (node) node.setAttribute('content', content); };
  document.title = title;
  set('meta[name="description"]', description);
  set('meta[property="og:title"]', title); set('meta[property="og:description"]', description);
  set('meta[property="og:url"]', absolute); set('meta[property="og:image"]', image);
  set('meta[name="twitter:title"]', title); set('meta[name="twitter:description"]', description); set('meta[name="twitter:image"]', image);
  // Individual artworks are resolved client-side, after GTM's initial page view.
  // Send a distinct virtual view once their canonical metadata is available.
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'woven_artwork_view',
    page_title: title,
    page_location: absolute,
    page_path: route,
    artist_name: displayName,
    artwork_year: String(year),
  });
}
function artworkStatistics(artist, temporalIndex) {
  const until = data.years[temporalIndex], works = new Set(); let weight = 0;
  for (const row of artist.series) if (row.year <= until) for (const [work, value] of row.works) { works.add(work); weight += value; }
  const overlay = artistOverlayLinks(artist.id, temporalIndex);
  return {works: works.size, relatedArtists: overlay?.artists.size || 0, weight};
}
async function ensureArtistDetail(artistId) {
  const artist = data._artistsById.get(artistId);
  if (!artist || artist.series) return artist;
  if (!artist.detailAvailable) throw new Error('This Artist is not yet available as a WOVEN artwork.');
  const response = await fetch(`${RUNTIME_ARTIST_BASE_URL}/${encodeURIComponent(artistId)}.json?v=${DATASET_VERSION}`);
  if (!response.ok) throw new Error(`Unable to load Artist detail: HTTP ${response.status}`);
  const detail = await response.json();
  artist.series = (detail.series || []).map(([year, delta, cumulative, activeWorks, works]) => ({year, delta, cumulative, activeWorks, works}));
  for (const row of artist.series) for (const [position] of row.works) data._worksById.set(String(position), {id: String(position), index: position});
  artist.relatedArtistDeltas = detail.relatedArtistDeltas || [];
  artist.incomingWorkDeltas = detail.incomingWorkDeltas || [];
  clearOverlayCaches();
  return artist;
}
function configureArtworkPanel(entry, artist, displayName, year) {
  $('#artwork-title').textContent = `WOVEN — ${displayName} · ${year}`;
  const artistLink = $('#artwork-artist-name'); artistLink.textContent = `Discover ${displayName} on Classii.mu`; artistLink.href = `https://classii.mu/artists/${encodeURIComponent(entry.classiiId)}`;
  const stats = artworkStatistics(artist, yearIndex), format = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});
  $('#artwork-work-vectors').textContent = format.format(stats.works);
  $('#artwork-related-artists').textContent = format.format(stats.relatedArtists);
  $('#artwork-vector-weight').textContent = format.format(stats.weight);
  $('#modal-work-vectors').textContent = format.format(stats.works);
  $('#modal-related-artists').textContent = format.format(stats.relatedArtists);
  $('#modal-vector-weight').textContent = format.format(stats.weight);
  const dialog = $('#share-dialog'), url = new URL(artworkUrl(entry, year), location.origin).href, text = `WOVEN — ${displayName} · ${year}`;
  $('#artwork-share').onclick = () => dialog.showModal();
  $('#artwork-stats-toggle').onclick = () => $('#stats-dialog').showModal();
  $('#share-x').href = `https://x.com/intent/post?${new URLSearchParams({text, url})}`;
  $('#share-threads').href = `https://www.threads.net/intent/post?${new URLSearchParams({text: `${text} ${url}`})}`;
  $('#share-facebook').href = `https://www.facebook.com/sharer/sharer.php?${new URLSearchParams({u: url})}`;
  $('#share-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); $('#share-copy-status').textContent = 'URL copied'; } catch { $('#share-copy-status').textContent = url; } };
}

function tileDemand() {
  const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
  const pixelRatio = Math.min(MAX_TILE_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
  const layout = geometry(width, height, data?._artistsById?.size || 1);
  return {
    width: Math.ceil(width * pixelRatio),
    artistHeight: Math.ceil((layout.artistBottom - layout.artistTop) * pixelRatio),
    workHeight: Math.ceil((layout.workBottom - layout.workTop) * pixelRatio),
    portrait: height / width > 1.2,
  };
}
function profileFits(key, demand) {
  const artist = tileManifest?.layers?.[`${key}/artist`], work = tileManifest?.layers?.[`${key}/work`];
  return Boolean(artist && work && artist.width >= demand.width && artist.height >= demand.artistHeight && work.height >= demand.workHeight);
}
function preferredTileKey() {
  if (!tileManifest) return LOD_KEYS[0];
  const demand = tileDemand();
  // Portrait is intentionally considered first: it reserves rows for the
  // tall Work field rather than selecting a landscape-oriented matrix only
  // because its X size happens to be sufficient.
  if (demand.portrait && profileFits(PORTRAIT_OVERVIEW_KEY, demand)) return PORTRAIT_OVERVIEW_KEY;
  for (const key of [LOD_KEYS[0], WIDE_OVERVIEW_KEY, ULTRA_OVERVIEW_KEY]) if (profileFits(key, demand)) return key;
  return tileManifest.layers[`${ULTRA_OVERVIEW_KEY}/artist`] ? ULTRA_OVERVIEW_KEY : LOD_KEYS[0];
}
function tileKey() {
  const preferred = preferredTileKey();
  return tiles.has(`${preferred}:artist`) ? preferred : LOD_KEYS[0];
}
function tileFor(modeIndex, layer) { return tiles.get(`${tileKey(modeIndex)}:${layer}`) || tiles.get(`overview:${layer}`); }
function tileDeltaWeight(tile, cellIndex, until) {
  const start = tile.deltaStart[cellIndex], end = start + tile.deltaCount[cellIndex]; let total = 0;
  for (let offset = start; offset < end; offset += 1) if (tile.deltaYears[offset] <= until) total += tile.deltaWeights[offset];
  return total;
}
function tileYearDelta(tile, cellIndex, year) {
  const start = tile.deltaStart[cellIndex], end = start + tile.deltaCount[cellIndex];
  for (let offset = start; offset < end; offset += 1) if (tile.deltaYears[offset] === year) return tile.deltaWeights[offset];
  return 0;
}

function visibleArtists() { return data.artists; }
function rememberBounded(map, key, value, limit) { if (map.has(key)) map.delete(key); map.set(key, value); while (map.size > limit) map.delete(map.keys().next().value); return value; }
function clearOverlayCaches() { artistOverlayCache.clear(); overlayPulseCellCache.clear(); overlayRenderCache.clear(); }
function cache() { const key = `${yearIndex}`; if (relationCache.key !== key) relationCache = {key, raw: null, works: new Map(), artists: new Map()}; return relationCache; }
function alignedOffset(value, alignment = 8) { return Math.ceil(value / alignment) * alignment; }
function growWasmMemory(bytes) {
  const memory = aggregateWasm.memory, current = memory.buffer.byteLength;
  if (current < bytes) memory.grow(Math.ceil((bytes - current) / 65536));
  return memory.buffer;
}
function wasmTileLinks(tile, until, factor) {
  if (!aggregateWasm) return undefined;
  const base = Number(aggregateWasm.__heap_base?.value || aggregateWasm.__heap_base || 0);
  const bucketWidth = Math.ceil(tile.width / factor), bucketHeight = Math.ceil(tile.height / factor), bucketCount = bucketWidth * bucketHeight;
  let offset = alignedOffset(base);
  const claim = (bytes, alignment = 4) => { offset = alignedOffset(offset, alignment); const start = offset; offset += bytes; return start; };
  const xOffset = claim(tile.cellX.byteLength, 2), yOffset = claim(tile.cellY.byteLength, 2), startOffset = claim(tile.deltaStart.byteLength), countOffset = claim(tile.deltaCount.byteLength, 2), yearsOffset = claim(tile.deltaYears.byteLength, 2), weightsOffset = claim(tile.deltaWeights.byteLength), bucketsOffset = claim(bucketCount * 4), outputOffset = claim(bucketCount * 12);
  const buffer = growWasmMemory(offset);
  new Uint16Array(buffer, xOffset, tile.cellX.length).set(tile.cellX); new Uint16Array(buffer, yOffset, tile.cellY.length).set(tile.cellY);
  new Uint32Array(buffer, startOffset, tile.deltaStart.length).set(tile.deltaStart); new Uint16Array(buffer, countOffset, tile.deltaCount.length).set(tile.deltaCount);
  new Uint16Array(buffer, yearsOffset, tile.deltaYears.length).set(tile.deltaYears); new Float32Array(buffer, weightsOffset, tile.deltaWeights.length).set(tile.deltaWeights);
  const count = aggregateWasm.aggregate(xOffset, yOffset, startOffset, countOffset, yearsOffset, weightsOffset, tile.cellCount, until, factor, tile.width, tile.height, bucketsOffset, bucketWidth, bucketHeight, outputOffset);
  const values = new Float32Array(buffer, outputOffset, count * 3), result = new Array(count);
  for (let index = 0, offset = 0; index < count; index += 1, offset += 3) result[index] = {x: values[offset], y: values[offset + 1], weight: values[offset + 2]};
  return result;
}
function rawLinks() { const current = cache(); if (current.raw) return current.raw; const links = new Map(), until = data.years[yearIndex]; for (const artist of visibleArtists()) for (const row of artist.series) { if (row.year > until) continue; for (const [work, value] of row.works) { const key = `${artist.id}:${work}`, old = links.get(key); links.set(key, {artist, work, weight: (old?.weight || 0) + value}); } } return current.raw = [...links.values()]; }
function workLinks(modeIndex = lodIndex) { const current = cache(); if (current.works.has(modeIndex)) return current.works.get(modeIndex); const links = new Map(), positions = data._lodModes[modeIndex].positions; for (const link of rawLinks()) { const source = positions.get(link.artist.id); if (source === undefined) continue; const key = `${source}:${link.work}`, old = links.get(key); links.set(key, {source, target: link.work, weight: (old?.weight || 0) + link.weight}); } const result = [...links.values()]; current.works.set(modeIndex, result); return result; }
function artistLinks(modeIndex = lodIndex) { const current = cache(); if (current.artists.has(modeIndex)) return current.artists.get(modeIndex); const links = new Map(), positions = data._lodModes[modeIndex].positions, until = data.years[yearIndex]; for (const relation of data.artistRelations) { if (relation.firstYear === null || relation.firstYear > until) continue; for (const [from, target] of [[relation.source, relation.target], [relation.target, relation.source]]) { const source = positions.get(from); if (source === undefined) continue; const key = `${source}:${target}`, old = links.get(key); links.set(key, {source, target, weight: (old?.weight || 0) + relation.weight, sharedWorks: (old?.sharedWorks || 0) + relation.sharedWorks}); } } const result = [...links.values()]; current.artists.set(modeIndex, result); return result; }
function tileLinks(modeIndex, layer, temporalIndex = yearIndex) {
  const key = `${temporalIndex}:${tileKey(modeIndex)}:${layer}`, cached = tileCache.get(key); if (cached) return cached;
  const tile = tileFor(modeIndex, layer), until = data.years[temporalIndex];
  // Coalesce at source-grid level rather than sampling. This preserves the
  // accumulated relation weight and avoids sparse, flickering patterns.
  const factor = Math.max(1, Math.ceil(Math.sqrt(tile.width * tile.height / MAX_DRAW_CELLS)));
  const wasmResult = wasmTileLinks(tile, until, factor);
  if (wasmResult) return rememberBounded(tileCache, key, wasmResult, TILE_CACHE_LIMIT);
  const buckets = factor > 1 ? new Map() : undefined, result = [];
  for (let index = 0; index < tile.cellCount; index += 1) {
    const weight = tileDeltaWeight(tile, index, until);
    if (weight <= 0) continue;
    if (!buckets) { result.push({x: tile.cellX[index], y: tile.cellY[index], weight}); continue; }
    const x = Math.floor(tile.cellX[index] / factor), y = Math.floor(tile.cellY[index] / factor), bucketKey = `${x}:${y}`, previous = buckets.get(bucketKey);
    if (previous) previous.weight += weight;
    else buckets.set(bucketKey, {x: Math.min(tile.width - 1, x * factor + Math.floor(factor / 2)), y: Math.min(tile.height - 1, y * factor + Math.floor(factor / 2)), weight});
  }
  const compact = buckets ? [...buckets.values()] : result;
  return rememberBounded(tileCache, key, compact, TILE_CACHE_LIMIT);
}
function discardTimelineTiles(beforeYear) {
  for (const key of tileCache.keys()) {
    const cachedYear = Number(key.slice(0, key.indexOf(':')));
    if (Number.isFinite(cachedYear) && cachedYear < beforeYear) tileCache.delete(key);
  }
}
function cancelTilePrefetch() {
  if (tilePrefetchHandle) {
    if ('cancelIdleCallback' in window) cancelIdleCallback(tilePrefetchHandle); else clearTimeout(tilePrefetchHandle);
  }
  tilePrefetchHandle = undefined; tilePrefetchQueue = [];
}
function scheduleTilePrefetch(targetIndex) {
  if (requestedArtwork || !yearAnimation) return;
  // The visible transition consumes `yearIndex` and `targetIndex`; warm two
  // further years while that transition is on screen. Each unit is a single
  // layer, which keeps a slow device responsive between computations.
  const horizon = [targetIndex + 1, targetIndex + 2].filter((index) => index < data.years.length);
  tilePrefetchQueue = horizon.flatMap((index) => ['artist', 'work'].map((layer) => ({index, layer})));
  discardTimelineTiles(Math.max(0, yearIndex));
  const run = (deadline) => {
    tilePrefetchHandle = undefined;
    if (!yearAnimation || !tilePrefetchQueue.length) return;
    const item = tilePrefetchQueue.shift();
    tileLinks(0, item.layer, item.index);
    // Schedule rather than loop: Wasm aggregation stays off the critical
    // draw call, and the browser can yield to interaction or the next frame.
    if (tilePrefetchQueue.length) {
      tilePrefetchHandle = 'requestIdleCallback' in window
        ? requestIdleCallback(run, {timeout: 180})
        : setTimeout(() => run({timeRemaining: () => 0}), 16);
    }
  };
  tilePrefetchHandle = 'requestIdleCallback' in window
    ? requestIdleCallback(run, {timeout: 120})
    : setTimeout(() => run({timeRemaining: () => 0}), 16);
}
function yearDeltaColumns(modeIndex, layer, index) {
  const key = `${tileKey(modeIndex)}:${layer}:${index}`, cached = yearDeltaCache.get(key); if (cached) return cached;
  const year = data.years[index], columns = new Map();
  const tile = tileFor(modeIndex, layer);
  for (let cellIndex = 0; cellIndex < tile.cellCount; cellIndex += 1) {
    const delta = tileYearDelta(tile, cellIndex, year);
    if (!delta) continue;
    const x = tile.cellX[cellIndex], column = columns.get(x) || [];
    column.push({x, y: tile.cellY[cellIndex], weight: delta}); columns.set(x, column);
  }
  return rememberBounded(yearDeltaCache, key, columns, YEAR_DELTA_CACHE_LIMIT);
}
function yearArrivalCells(modeIndex, layer, index) {
  const key = `${tileKey(modeIndex)}:${layer}:${index}`, cached = yearArrivalCache.get(key); if (cached) return cached;
  const tile = tileFor(modeIndex, layer), factor = Math.max(1, Math.ceil(Math.sqrt(tile.width * tile.height / YEAR_ARRIVAL_CELL_LIMIT))), buckets = new Map();
  for (const cells of yearDeltaColumns(modeIndex, layer, index).values()) for (const cell of cells) {
    const x = Math.floor(cell.x / factor), y = Math.floor(cell.y / factor), bucketKey = `${x}:${y}`, old = buckets.get(bucketKey);
    if (old) old.weight += cell.weight;
    else buckets.set(bucketKey, {x: Math.min(tile.width - 1, x * factor + Math.floor(factor / 2)), y: Math.min(tile.height - 1, y * factor + Math.floor(factor / 2)), weight: cell.weight});
  }
  return rememberBounded(yearArrivalCache, key, [...buckets.values()], YEAR_DELTA_CACHE_LIMIT);
}
function bassoSamples(temporalIndex) {
  const key = `${temporalIndex}`, cached = bassoSampleCache.get(key); if (cached) return cached;
  // The detail grid keeps the left-to-right phrasing stable across visual LOD.
  const totals = Array.from({length: BASSO_X_BANDS}, () => ({weight: 0, cells: 0}));
  for (const layer of ['artist', 'work']) {
    const tile = tileFor(2, layer), columns = yearDeltaColumns(2, layer, temporalIndex);
    for (const [x, cells] of columns) {
      const band = Math.min(BASSO_X_BANDS - 1, Math.floor(x / Math.max(1, tile.width) * BASSO_X_BANDS));
      for (const cell of cells) { totals[band].weight += cell.weight; totals[band].cells += 1; }
    }
  }
  const maxWeight = Math.max(1, ...totals.map((sample) => sample.weight));
  const result = totals.map((sample, band) => ({...sample, band, intensity: Math.log1p(sample.weight) / Math.log1p(maxWeight)}));
  bassoSampleCache.set(key, result); return result;
}
function compactScale(links) {
  const cached = compactScaleCache.get(links); if (cached) return cached;
  const weights = links.map((link) => link.weight).sort((left, right) => left - right);
  const value = Math.max(1, weights[Math.floor((weights.length - 1) * .95)] || 1);
  compactScaleCache.set(links, value); return value;
}

function prepareLod() {
  // Runtime delivery no longer sends a multi-megabyte semantic tree. The
  // display is permanently Overview, so Artist positions in the small index
  // are the only mapping the renderer needs.
  data._artistsById = new Map(data.artists.map((artist) => [artist.id, artist]));
  data.works = {length: data.workCount};
  data._worksById = new Map();
  data._lodModes = [{nodes: [], positions: new Map(data.artists.map((artist) => [artist.id, artist.position]))}];
  return;
  const byId = new Map(data.lod.tree.map((node) => [node.id, node])), byArtist = new Map(data.artists.map((artist, index) => [artist.id, index])), leaves = new Map(data.lod.tree.filter((node) => node.artist).map((node) => [node.artist, node.id])), minimum = new Map();
  // The production semantic tree can be thousands of levels deep.  Compute
  // leftmost-leaf positions with an explicit post-order traversal rather than
  // recursive child maps, which overflow the browser call stack.
  const rootId = data.lod.root_node_id, traversal = [[rootId, false]];
  while (traversal.length) {
    const [id, visited] = traversal.pop(), node = byId.get(id);
    if (visited) minimum.set(id, node.artist ? byArtist.get(node.artist) : Math.min(...node.children.map((child) => minimum.get(child))));
    else { traversal.push([id, true]); if (!node.artist) for (const child of node.children) traversal.push([child, false]); }
  }
  const position = (id) => minimum.get(id);
  const root = byId.get(data.lod.root_node_id), overview = [...root.children].sort((a, b) => position(a) - position(b)), cluster = [...overview];
  while (cluster.length < 240) { const candidates = cluster.filter((id) => byId.get(id).children.length); if (!candidates.length) break; const largest = candidates.sort((a, b) => byId.get(b).leaves - byId.get(a).leaves || position(a) - position(b))[0]; cluster.splice(cluster.indexOf(largest), 1, ...byId.get(largest).children); }
  cluster.sort((a, b) => position(a) - position(b));
  data._lodModes = [overview, cluster, data.artists.map((a) => leaves.get(a.id))].map((ids) => { const positions = new Map(); ids.forEach((id, index) => { const descendants = [id]; while (descendants.length) { const node = byId.get(descendants.pop()); if (node.artist) positions.set(node.artist, index); else descendants.push(...node.children); } }); return {nodes: ids.map((id) => byId.get(id)), positions}; });
  data._artistsById = new Map(data.artists.map((artist) => [artist.id, artist])); data._worksById = new Map(data.works.map((work, index) => [work.id, {...work, index}]));
}
function geometry(width, height, count) { const inset = fabricInset(width, height), artistTop = inset, artistBottom = Math.max(178, height * .29), workTop = artistBottom, workBottom = height - inset; return {inset, x: (i) => inset + (width - inset * 2) * i / Math.max(1, count - 1), artistY: (i) => artistTop + (artistBottom - artistTop) * i / Math.max(1, data.artists.length - 1), workY: (i) => workTop + (workBottom - workTop) * i / Math.max(1, data.workCount - 1), artistTop, artistBottom, workTop, workBottom}; }
function point(points, x, y, weight, max, selected, opacity, modeIndex = 2) {
  const intensity = Math.min(1, Math.log1p(weight) / Math.log1p(max)), overview = modeIndex === 0, cluster = modeIndex === 1;
  const size = selected ? 6.6 : overview ? Math.min(4.2, 2 + Math.sqrt(weight) * .16) : cluster ? Math.min(4.8, 1.7 + Math.sqrt(weight) * .38) : Math.min(4.2, 1.1 + Math.sqrt(weight) * .44);
  const alpha = overview ? .075 + intensity * .5 : cluster ? .055 + intensity * .6 : .035 + intensity * .55;
  const color = selected ? paletteColors.bright : paletteColors.base, highlight = paletteColors.bright;
  points.push(x, y, color[0] + (highlight[0] - color[0]) * intensity, color[1] + (highlight[1] - color[1]) * intensity, color[2] + (highlight[2] - color[2]) * intensity, (selected ? 1 : alpha) * opacity, size, 0);
}
function lodLayers() { return [{index: 0, opacity: 1}]; }
function zoomLabel() { return 'Overview'; }
function cameraScale() { return 1; }
function glowScale(width, height) {
  const areaRatio = width * height / (GLOW_REFERENCE_SIZE.width * GLOW_REFERENCE_SIZE.height);
  return Math.max(.78, Math.min(2.7, Math.sqrt(areaRatio)));
}
function constrainPan(width = canvas.clientWidth, height = canvas.clientHeight) {
  const scale = cameraScale();
  // Treat the visible matrix as a bounded world with its top-left at (0, 0).
  // Panning is limited so the viewport never exposes beyond its X/Y extent.
  const inset = fabricInset(width, height), bounds = {left: inset, right: width - inset, top: inset, bottom: height - inset};
  const centerX = width / 2, centerY = height / 2, inverseZoom = 1 - 1 / scale;
  const minX = (centerX - bounds.right) * inverseZoom, maxX = (centerX - bounds.left) * inverseZoom;
  const minY = (centerY - bounds.bottom) * inverseZoom, maxY = (centerY - bounds.top) * inverseZoom;
  cameraPan.x = Math.max(minX, Math.min(maxX, cameraPan.x));
  cameraPan.y = Math.max(minY, Math.min(maxY, cameraPan.y));
}
function appendLodLayer(points, modeIndex, opacity, width, height, maxWeight, temporalIndex = yearIndex) {
  const nodes = data._lodModes[modeIndex].nodes, layout = geometry(width, height, nodes.length);
  for (const layer of ['artist', 'work']) {
    const tile = tileFor(modeIndex, layer), yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
    const cells = tileLinks(modeIndex, layer, temporalIndex), compact = modeIndex === 0, scale = compact ? compactScale(cells) : maxWeight;
    for (const cell of cells) point(points, layout.inset + (width - layout.inset * 2) * cell.x / Math.max(1, tile.width - 1), yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1), cell.weight, scale, false, opacity, modeIndex);
  }
}
function overlayPoint(points, x, y, weight, maxWeight, opacity, modeIndex) {
  const intensity = Math.min(1, Math.log1p(weight) / Math.log1p(maxWeight));
  const boost = modeIndex === 0 ? 1.62 : modeIndex === 1 ? 1.27 : 1, size = (3.2 + Math.sqrt(weight) * .28) * boost * .84;
  points.push(x, y, ...paletteColors.outgoing, (.10 + intensity * .07) * opacity, size * 1.5, .94);
  points.push(x, y, ...paletteColors.outgoing, (.58 + intensity * .30) * opacity, size, .22);
}
function reverseOverlayPoint(points, x, y, weight, maxWeight, opacity, modeIndex) {
  const intensity = Math.min(1, Math.log1p(weight) / Math.log1p(maxWeight));
  const boost = modeIndex === 0 ? 1.35 : modeIndex === 1 ? 1.16 : 1, size = (3.1 + Math.sqrt(weight) * .28) * boost * .84;
  points.push(x, y, ...paletteColors.incoming, (.09 + intensity * .07) * opacity, size * 1.5, .94);
  points.push(x, y, ...paletteColors.incoming, (.56 + intensity * .32) * opacity, size, .22);
}
function artistOverlayLinks(artistId, temporalIndex) {
  const key = `${artistId}:${temporalIndex}`, cached = artistOverlayCache.get(key); if (cached) return rememberBounded(artistOverlayCache, key, cached, ARTIST_OVERLAY_CACHE_LIMIT);
  const artist = data._artistsById.get(artistId), until = data.years[temporalIndex], works = new Map(), artists = new Map(), reverseArtists = new Map(), reverseWorks = new Map();
  if (!artist?.series) return undefined;
  if (artist.relatedArtistDeltas) {
    for (const row of artist.series) if (row.year <= until) for (const [work, weight] of row.works) works.set(work, (works.get(work) || 0) + weight);
    for (const [year, position, weight] of artist.relatedArtistDeltas) if (year <= until) artists.set(position, (artists.get(position) || 0) + weight);
    for (const [year, source, target, weight] of artist.incomingWorkDeltas) if (year <= until) reverseWorks.set(`${source}:${target}`, {source, target, weight: (reverseWorks.get(`${source}:${target}`)?.weight || 0) + weight});
    return rememberBounded(artistOverlayCache, key, {artist, works, artists, reverseArtists: artists, reverseWorks: [...reverseWorks.values()]}, ARTIST_OVERLAY_CACHE_LIMIT);
  }
  for (const row of artist.series) if (row.year <= until) for (const [work, weight] of row.works) works.set(work, (works.get(work) || 0) + weight);
  // Every overlay weight uses only the deltas accumulated through `until`.
  // Artist × Artist is the same work-mediated min-weight measure used to
  // build the relation graph, rather than a full-dataset pair total.
  for (const candidate of data.artists) {
    if (candidate.id === artistId || !candidate.series) continue;
    const candidateWorks = new Map();
    for (const row of candidate.series) if (row.year <= until) for (const [work, weight] of row.works) candidateWorks.set(work, (candidateWorks.get(work) || 0) + weight);
    let sharedWeight = 0;
    for (const [work, weight] of candidateWorks) {
      const selectedWeight = works.get(work);
      if (!selectedWeight) continue;
      sharedWeight += Math.min(selectedWeight, weight);
      const workKey = `${candidate.id}:${work}`, old = reverseWorks.get(workKey);
      reverseWorks.set(workKey, {source: candidate.id, target: work, weight: (old?.weight || 0) + weight});
    }
    if (sharedWeight) { artists.set(candidate.id, sharedWeight); reverseArtists.set(candidate.id, sharedWeight); }
  }
  const result = {artist, works, artists, reverseArtists, reverseWorks: [...reverseWorks.values()]}; return rememberBounded(artistOverlayCache, key, result, ARTIST_OVERLAY_CACHE_LIMIT);
}
function matrixPixel(index, count, resolution) { return Math.min(resolution - 1, Math.floor(index * resolution / Math.max(1, count))); }
function lodMatrixPixel(index, count, resolution, detailResolution) {
  const detailPixel = matrixPixel(index, count, detailResolution);
  return resolution === detailResolution ? detailPixel : matrixPixel(detailPixel, detailResolution, resolution);
}
function detailResolution(layer) {
  const detail = tileManifest?.detail_resolution;
  if (layer === 'artist') return Number(detail?.artist_y) || 1024;
  return Number(detail?.work_y) || 4096;
}
function foldOverlayLinks(modeIndex, layer, links) {
  const tile = tileFor(modeIndex, layer), targetCount = layer === 'artist' ? data.artists.length : data.works.length, cells = new Map();
  for (const link of links) {
    const source = typeof link.source === 'number' ? {position: link.source} : data._artistsById.get(link.source), target = typeof link.target === 'number' ? {position: link.target, index: link.target} : layer === 'artist' ? data._artistsById.get(link.target) : data._worksById.get(link.target);
    if (!source || !target) continue;
    const x = lodMatrixPixel(source.position, data.artists.length, tile.width, Number(tileManifest?.detail_resolution?.x) || 1024), y = lodMatrixPixel(layer === 'artist' ? target.position : target.index, targetCount, tile.height, detailResolution(layer)), key = `${x}:${y}`, old = cells.get(key);
    cells.set(key, {x, y, weight: (old?.weight || 0) + link.weight});
  }
  return {tile, cells: [...cells.values()]};
}
function overlayRenderCells(artistId, modeIndex, temporalIndex) {
  const key = `${artistId}:${temporalIndex}:${modeIndex}`, cached = overlayRenderCache.get(key); if (cached) return rememberBounded(overlayRenderCache, key, cached, OVERLAY_RENDER_CACHE_LIMIT);
  const overlay = artistOverlayLinks(artistId, temporalIndex); if (!overlay) return undefined;
  const outgoingArtists = [...overlay.artists].map(([target, weight]) => ({source: artistId, target, weight}));
  const outgoingWorks = [...overlay.works].map(([target, weight]) => ({source: artistId, target, weight}));
  const incomingArtists = [...overlay.reverseArtists].map(([source, weight]) => ({source, target: artistId, weight}));
  return rememberBounded(overlayRenderCache, key, {
    overlay,
    artistIncoming: foldOverlayLinks(modeIndex, 'artist', incomingArtists),
    workIncoming: foldOverlayLinks(modeIndex, 'work', overlay.reverseWorks),
    artistOutgoing: foldOverlayLinks(modeIndex, 'artist', outgoingArtists),
    workOutgoing: foldOverlayLinks(modeIndex, 'work', outgoingWorks),
  }, OVERLAY_RENDER_CACHE_LIMIT);
}
function overlayPulseCells(modeIndex, layer, temporalIndex) {
  if (selected === 'all') return undefined;
  const key = `${selected}:${temporalIndex}:${modeIndex}:${layer}`, cached = overlayPulseCellCache.get(key); if (cached) return cached;
  const rendered = overlayRenderCells(selected, modeIndex, temporalIndex); if (!rendered) return undefined;
  const suffix = layer === 'artist' ? 'artist' : 'work';
  const cells = new Set([...rendered[`${suffix}Incoming`].cells, ...rendered[`${suffix}Outgoing`].cells].map((cell) => `${cell.x}:${cell.y}`));
  return rememberBounded(overlayPulseCellCache, key, cells, OVERLAY_RENDER_CACHE_LIMIT);
}
function appendArtistOverlay(points, modeIndex, opacity, width, height, maxWeight, temporalIndex = yearIndex) {
  if (selected === 'all') return;
  const rendered = overlayRenderCells(selected, modeIndex, temporalIndex), selectedArtist = data._artistsById.get(selected);
  if (!rendered || !selectedArtist) return;
  const {overlay} = rendered, layout = geometry(width, height, data._lodModes[modeIndex].nodes.length);
  const drawCells = (layer, folded, reverse) => {
    const {tile, cells} = folded, yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
    for (const cell of cells) {
      const x = layout.inset + (width - layout.inset * 2) * cell.x / Math.max(1, tile.width - 1), y = yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1);
      if (reverse) reverseOverlayPoint(points, x, y, cell.weight, maxWeight, opacity, modeIndex); else overlayPoint(points, x, y, cell.weight, maxWeight, opacity, modeIndex);
    }
  };
  drawCells('artist', rendered.artistIncoming, true); drawCells('work', rendered.workIncoming, true); drawCells('artist', rendered.artistOutgoing, false); drawCells('work', rendered.workOutgoing, false);
}
function appendYearArrival(pulses, width, height) {
  if (!yearAnimation) return;
  const elapsed = performance.now() - yearAnimation.startedAt;
  if (elapsed < 0 || elapsed >= YEAR_ARRIVAL_DURATION) return;
  // Before the scan begins, let the newly added field acknowledge the change
  // together. This is deliberately quiet: it reads as the fabric taking a
  // breath, then hands focus back to the left-to-right weaving motion.
  const phase = elapsed / YEAR_ARRIVAL_DURATION, flare = Math.min(1, elapsed / 42) * Math.pow(1 - phase, 1.55), responsiveGlow = glowScale(width, height);
  for (const {index, opacity} of lodLayers()) {
    const layout = geometry(width, height, data._lodModes[index].nodes.length);
    for (const layer of ['artist', 'work']) {
      const tile = tileFor(index, layer), yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
      for (const cell of yearArrivalCells(index, layer, yearAnimation.yearIndex)) {
        const intensity = Math.min(1, Math.log1p(cell.weight) / 2.8), x = layout.inset + (width - layout.inset * 2) * cell.x / Math.max(1, tile.width - 1), y = yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1), size = (2.5 + Math.min(4.6, Math.sqrt(cell.weight) * .5)) * responsiveGlow;
        pulses.push(x, y, ...paletteColors.accent, (.045 + intensity * .07) * flare * opacity, size * 2.6, .94);
        pulses.push(x, y, ...paletteColors.bright, (.07 + intensity * .13) * flare * opacity, size, .52);
      }
    }
  }
}
function appendYearPulse(points, pulseCandidates, width, height) {
  if (!yearAnimation) return;
  const elapsed = performance.now() - yearAnimation.startedAt;
  if (elapsed >= yearAnimation.duration) return;
  const responsiveGlow = glowScale(width, height);
  const phase = elapsed / yearAnimation.duration, columnDelay = .68, columnSpan = 1 - columnDelay;
  for (const {index, opacity} of lodLayers()) {
    const layout = geometry(width, height, data._lodModes[index].nodes.length);
    for (const layer of ['artist', 'work']) {
      const tile = tileFor(index, layer), yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
      const first = Math.max(0, Math.ceil((phase - columnSpan) / columnDelay * (tile.width - 1))), last = Math.min(tile.width - 1, Math.floor(phase / columnDelay * (tile.width - 1)));
      const columns = yearDeltaColumns(index, layer, yearAnimation.yearIndex);
      const highlightedCells = overlayPulseCells(index, layer, yearAnimation.yearIndex);
      for (let x = first; x <= last; x += 1) {
        const columnPhase = (phase - x / Math.max(1, tile.width - 1) * columnDelay) / columnSpan;
        if (columnPhase < 0 || columnPhase > 1) continue;
        const xPosition = layout.inset + (width - layout.inset * 2) * x / Math.max(1, tile.width - 1), beamY = yTop + (yBottom - yTop) * columnPhase;
        for (const cell of columns.get(x) || []) {
          const cellY = yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1), distance = Math.abs(cellY - beamY) / Math.max(1, yBottom - yTop);
          if (distance > .035) continue;
          const flare = (1 - distance / .035) * opacity, size = (4 + Math.min(7, Math.sqrt(cell.weight) * .9)) * responsiveGlow;
          // Pulses are drawn in a separate additive pass: a broad halo keeps
          // new relations legible over an already bright late-year fabric.
          points.push(xPosition, cellY, ...paletteColors.accent, .08 * flare, size * 1.8, .92);
          points.push(xPosition, cellY, ...paletteColors.bright, .78 * flare, size, .12);
          // Keep the audible point tied to its rendered location.  The X axis
          // becomes stereo position; lower points feel closer than upper ones.
          pulseCandidates.push({key: `${index}:${layer}:${x}:${cell.y}`, weight: cell.weight, highlighted: highlightedCells?.has(`${x}:${cell.y}`), spatial: {pan: Math.max(-.92, Math.min(.92, xPosition / Math.max(1, width) * 2 - 1)), depth: Math.max(0, Math.min(1, 1 - cellY / Math.max(1, height)))}});
        }
      }
    }
  }
}
function renderPoints(points, pulses, width, height, viewScale) {
  const pixelRatio = Math.min(MAX_CANVAS_PIXEL_RATIO, devicePixelRatio || 1), stride = 8 * 4, background = paletteColors.paper, pixelWidth = Math.round(width * pixelRatio), pixelHeight = Math.round(height * pixelRatio);
  // Assigning width/height reallocates the WebGL drawing buffer. During the
  // timeline that used to happen on every frame; resize only when necessary.
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(...background, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer); gl.enableVertexAttribArray(positionLoc); gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, stride, 0); gl.enableVertexAttribArray(colorLoc); gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 2 * 4); gl.enableVertexAttribArray(sizeLoc); gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, stride, 6 * 4); gl.enableVertexAttribArray(softnessLoc); gl.vertexAttribPointer(softnessLoc, 1, gl.FLOAT, false, stride, 7 * 4); gl.uniform2f(uniforms.u_resolution, width, height); gl.uniform2f(uniforms.u_center, width / 2, height / 2); gl.uniform2f(uniforms.u_pan, cameraPan.x, cameraPan.y); gl.uniform1f(uniforms.u_scale, viewScale); gl.uniform1f(uniforms.u_pixel_ratio, pixelRatio); gl.enable(gl.BLEND);
  const drawPass = (values, additive) => { if (!values.length) return; gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW); gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); gl.drawArrays(gl.POINTS, 0, values.length / 8); };
  drawPass(points, false); drawPass(pulses, true);
}
function draw() {
  const rect = canvas.getBoundingClientRect();
  const layers = lodLayers(), elapsed = yearAnimation ? performance.now() - yearAnimation.startedAt : 0, dissolve = yearAnimation ? Math.max(0, Math.min(1, (elapsed - yearAnimation.duration) / yearAnimation.dissolveDuration)) : 0;
  const timeStates = yearAnimation && dissolve > 0 ? [{index: yearIndex, opacity: 1 - dissolve}, {index: yearAnimation.yearIndex, opacity: dissolve}] : [{index: yearIndex, opacity: 1}];
  const allLinks = timeStates.flatMap((timeState) => layers.flatMap(({index}) => [...tileLinks(index, 'artist', timeState.index), ...tileLinks(index, 'work', timeState.index)]));
  const max = allLinks.reduce((largest, link) => Math.max(largest, link.weight), 1);
  const points = [], pulses = [], pulseCandidates = [], viewScale = cameraScale(); constrainPan(rect.width, rect.height); timeStates.forEach((timeState) => layers.forEach(({index, opacity}) => { const layerOpacity = opacity * timeState.opacity; appendLodLayer(points, index, layerOpacity, rect.width, rect.height, max, timeState.index); appendArtistOverlay(points, index, layerOpacity, rect.width, rect.height, max, timeState.index); })); appendYearArrival(pulses, rect.width, rect.height); appendYearPulse(pulses, pulseCandidates, rect.width, rect.height); renderPoints(points, pulses, rect.width, rect.height, viewScale); playPulseCandidates(pulseCandidates); playBassoContinuo();
}
function details(event) {
  if (!data.works) return;
  if (selected === 'all') return;
  const detail = $('#detail'); if (!detail) return;
  const rect = canvas.getBoundingClientRect(), viewScale = cameraScale();
  const worldX = (event.clientX - rect.left - rect.width / 2 - cameraPan.x) / viewScale + rect.width / 2;
  const worldY = (event.clientY - rect.top - rect.height / 2 - cameraPan.y) / viewScale + rect.height / 2;
  const nodes = data._lodModes[lodIndex].nodes;
  const layout = geometry(rect.width, rect.height, nodes.length);
  const source = Math.max(0, Math.min(nodes.length - 1, Math.round((worldX - layout.inset) / (rect.width - layout.inset * 2) * (nodes.length - 1))));
  const y = worldY; let link, target;
  if (y >= layout.artistTop && y <= layout.artistBottom) {
    const index = Math.max(0, Math.min(data.artists.length - 1, Math.round((y - layout.artistTop) / (layout.artistBottom - layout.artistTop) * (data.artists.length - 1))));
    target = data.artists[index]; link = artistLinks().find((item) => item.source === source && item.target === target.id); if (link) selectedLink = `a:${lodIndex}:${source}:${target.id}`;
  } else if (y >= layout.workTop && y <= layout.workBottom) {
    const index = Math.max(0, Math.min(data.works.length - 1, Math.round((y - layout.workTop) / (layout.workBottom - layout.workTop) * (data.works.length - 1))));
    target = data.works[index]; link = workLinks().find((item) => item.source === source && item.target === target.id); if (link) selectedLink = `w:${lodIndex}:${source}:${target.id}`;
  }
  if (!link) return;
  const node = nodes[source], sourceName = node.artist ? data._artistsById.get(node.artist).name : `${node.leaves} Artists`;
  detail.innerHTML = `<p class="detail-kicker">${LOD_LABELS[lodIndex].toUpperCase()} ARTIST SOURCE</p><h2>${sourceName} → ${target.name}</h2><p>Relation weight through ${data.years[yearIndex]}: ${link.weight.toFixed(2)}.</p>`;
  draw();
}
function soundContext() {
  if (!sound) return;
  audio ||= new AudioContext();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
function soundOutput(context) {
  if (audioBus) return audioBus;
  const master = context.createGain(), dry = context.createGain(), reverb = context.createConvolver(), tone = context.createBiquadFilter(), wet = context.createGain();
  // Keep the shared space short and dark: it binds the points together without
  // blurring the attack that makes each new vector feel discrete.
  const seconds = .72, length = Math.floor(context.sampleRate * seconds), impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const samples = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.7;
  }
  reverb.buffer = impulse; master.gain.value = .82; dry.gain.value = .92; wet.gain.value = reverbAmount;
  tone.type = 'lowpass'; tone.frequency.value = 3100;
  master.connect(dry).connect(context.destination); master.connect(reverb).connect(tone).connect(wet).connect(context.destination); reverbBus = wet;
  return audioBus = master;
}
function soundChannel(context, channel) {
  soundOutput(context);
  const existing = channel === 'glow' ? glowBus : channel === 'highlight' ? highlightBus : channel === 'clack' ? clackBus : bassoBus;
  if (existing) return existing;
  const bus = context.createGain(); bus.gain.value = channel === 'glow' ? glowVolume : channel === 'highlight' ? highlightVolume : channel === 'clack' ? clackVolume : bassoVolume; bus.connect(audioBus);
  if (channel === 'glow') glowBus = bus; else if (channel === 'highlight') highlightBus = bus; else if (channel === 'clack') clackBus = bus; else bassoBus = bus;
  return bus;
}
function spatialDestination(context, channel, spatial) {
  const position = spatial || {}, depth = Math.max(0, Math.min(1, Number.isFinite(position.depth) ? position.depth : .62)), pan = Math.max(-.92, Math.min(.92, Number.isFinite(position.pan) ? position.pan : 0));
  // A point towards the bottom is treated as nearer: it stays brighter and
  // more direct.  Higher points recede gently into the shared dark reverb.
  const distance = context.createGain(), filter = context.createBiquadFilter(), panner = context.createStereoPanner?.() || context.createPanner?.();
  distance.gain.value = .72 + depth * .28;
  filter.type = 'lowpass'; filter.frequency.value = 1700 + depth * 7600; filter.Q.value = .28;
  distance.connect(filter);
  if (panner) {
    if ('pan' in panner) panner.pan.value = pan;
    else { panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.rolloffFactor = 0; panner.setPosition(pan, 0, 1); }
    filter.connect(panner).connect(soundChannel(context, channel));
  }
  else filter.connect(soundChannel(context, channel));
  return distance;
}
function setChannelVolume(channel, value) {
  const output = channel === 'glow' ? '#glow-volume-value' : channel === 'highlight' ? '#highlight-volume-value' : channel === 'clack' ? '#clack-volume-value' : '#basso-volume-value', bus = channel === 'glow' ? glowBus : channel === 'highlight' ? highlightBus : channel === 'clack' ? clackBus : bassoBus;
  if (channel === 'glow') glowVolume = value; else if (channel === 'highlight') highlightVolume = value; else if (channel === 'clack') clackVolume = value; else bassoVolume = value;
  $(output).textContent = `${Math.round(value * 100)}%`;
  if (bus && audio) bus.gain.setTargetAtTime(value, audio.currentTime, .025);
}
function setReverbAmount(value) {
  reverbAmount = value;
  $('#reverb-amount-value').textContent = `${Math.round(value * 100)}%`;
  if (reverbBus && audio) reverbBus.gain.setTargetAtTime(value, audio.currentTime, .035);
}
async function loadWaveCatalog(control) {
  const catalog = await fetch(WAVE_CATALOG_URL).then((response) => response.json());
  for (const wave of catalog.sounds || []) {
    waveCatalog.set(wave.id, wave);
    const option = document.createElement('option'); option.value = wave.id; option.textContent = wave.name; control.append(option);
  }
  if (waveCatalog.has(DEFAULT_WEAVE_CLACK)) control.value = DEFAULT_WEAVE_CLACK;
}
function loadWeaveClack(context, id = weaveClackId) {
  if (weaveClackBuffers.has(id)) return Promise.resolve(weaveClackBuffers.get(id));
  if (weaveClackPromises.has(id)) return weaveClackPromises.get(id);
  const wave = waveCatalog.get(id);
  if (!wave) return Promise.reject(new Error(`Unknown weave clack: ${id}`));
  const promise = fetch(wave.file).then((response) => response.arrayBuffer()).then((buffer) => context.decodeAudioData(buffer)).then((buffer) => { weaveClackBuffers.set(id, buffer); weaveClackPromises.delete(id); return buffer; }).catch((error) => { weaveClackPromises.delete(id); throw error; });
  weaveClackPromises.set(id, promise); return promise;
}
async function loadInstrumentCatalog(control) {
  const catalog = await fetch(INSTRUMENT_CATALOG_URL).then((response) => response.json());
  for (const instrument of catalog.instruments || []) {
    instrumentCatalog.set(instrument.id, instrument);
    if ([...control.options].some((option) => option.value === instrument.id)) continue;
    const option = document.createElement('option'); option.value = instrument.id; option.textContent = instrument.name; control.append(option);
  }
}
function loadInstrumentPack(id, context) {
  if (loadedInstrumentPacks.has(id)) return loadedInstrumentPacks.get(id);
  const instrument = instrumentCatalog.get(id);
  if (!instrument) return Promise.reject(new Error(`Unknown instrument: ${id}`));
  const manifestUrl = new URL(instrument.manifest, window.location.href);
  const promise = fetch(manifestUrl).then((response) => response.json()).then(async (manifest) => ({
    ...manifest,
    samples: await Promise.all(manifest.samples.map(async (sample) => ({
      ...sample,
      buffer: await context.decodeAudioData(await fetch(new URL(sample.file, manifestUrl)).then((response) => response.arrayBuffer())),
    }))),
  })).then((pack) => { loadedInstrumentPacks.set(id, pack); return pack; }).catch((error) => { loadedInstrumentPacks.delete(id); throw error; });
  loadedInstrumentPacks.set(id, promise); return promise;
}
function envelope(gain, at, peak, attack, release) {
  gain.gain.setValueAtTime(.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(.0001, at + attack + release);
}
function syntheticWeaveClack(context) {
  const now = context.currentTime;
  // A low wooden body followed by a quiet high mechanical tick.
  for (const [offset, frequency, peak, release] of [[0, 142, .042, .07], [.035, 238, .018, .035]]) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(frequency, now + offset);
    envelope(gain, now + offset, peak, .003, release);
    oscillator.connect(gain).connect(soundChannel(context, 'clack')); oscillator.start(now + offset); oscillator.stop(now + offset + release + .02);
  }
}
function weaveClack() {
  const context = soundContext(); if (!context) return;
  const buffer = weaveClackBuffers.get(weaveClackId);
  if (!buffer) { loadWeaveClack(context).catch((error) => console.warn('Unable to load weave clack', error)); syntheticWeaveClack(context); return; }
  const source = context.createBufferSource(), gain = context.createGain(), now = context.currentTime;
  // Preserve the recorded attack and tail; its own decay makes a more natural
  // shuttle sound than a programmatic envelope or an arbitrary trim.
  source.buffer = buffer; gain.gain.setValueAtTime(.19, now);
  source.connect(gain).connect(soundChannel(context, 'clack')); source.start(now);
}
function vectorPitch(weight) {
  const amount = Math.min(1, Math.log1p(weight) / Math.log1p(28));
  const intervals = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  return {amount, frequency: 196 * 2 ** (intervals[Math.round(amount * (intervals.length - 1))] / 12)};
}
function synthTone(weight, spatial) {
  const context = soundContext(); if (!context) return;
  // Logarithmic weighting keeps an exceptional relation from jumping too far
  // above the rest, then quantises the result into a warm pentatonic scale.
  const {amount, frequency} = vectorPitch(weight);
  const now = context.currentTime, oscillator = context.createOscillator(), gain = context.createGain(), filter = context.createBiquadFilter();
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, now);
  filter.type = 'lowpass'; filter.frequency.setValueAtTime(1800 + amount * 2200, now); filter.Q.value = 1.8;
  envelope(gain, now, .012 + amount * .018, .008, .13 + amount * .09);
  oscillator.connect(filter).connect(gain).connect(spatialDestination(context, 'glow', spatial)); oscillator.start(now); oscillator.stop(now + .28);
}
function pianoTone(weight, spatial) {
  const context = soundContext(); if (!context) return;
  const {amount, frequency} = vectorPitch(weight), now = context.currentTime;
  // A compact piano-like additive voice: tuned partials with independent,
  // quick decays make the discrete pitch more tactile than the pure synth.
  for (const [ratio, level, decay] of [[1, 1, .52], [2, .32, .31], [3, .14, .2], [4.01, .07, .13]]) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency * ratio, now); oscillator.detune.value = ratio === 1 ? 0 : (ratio - 1) * 1.6;
    envelope(gain, now, (.009 + amount * .02) * level, .002, decay + amount * .12);
    oscillator.connect(gain).connect(spatialDestination(context, 'glow', spatial)); oscillator.start(now); oscillator.stop(now + decay + amount * .12 + .03);
  }
}
function sampleTone(id, weight, spatial) {
  const context = soundContext(); if (!context) return;
  const pack = loadedInstrumentPacks.get(id);
  if (!pack || !pack.samples) { loadInstrumentPack(id, context).catch((error) => console.warn('Unable to load glow instrument', error)); synthTone(weight, spatial); return; }
  const {amount, frequency} = vectorPitch(weight), requestedNote = 69 + 12 * Math.log2(frequency / 440);
  const sample = pack.samples.reduce((nearest, candidate) => Math.abs(candidate.note - requestedNote) < Math.abs(nearest.note - requestedNote) ? candidate : nearest);
  const source = context.createBufferSource(), gain = context.createGain(), now = context.currentTime;
  source.buffer = sample.buffer; source.playbackRate.value = 2 ** ((requestedNote - sample.note) / 12);
  envelope(gain, now, .09 + amount * .08, .003, .48 + amount * .24);
  source.connect(gain).connect(spatialDestination(context, 'glow', spatial)); source.start(now); source.stop(now + 1.1);
}
function vectorTone(weight, spatial) {
  if (glowInstrument === 'synth') synthTone(weight, spatial);
  else if (glowInstrument === 'piano-synth') pianoTone(weight, spatial);
  else sampleTone(glowInstrument, weight, spatial);
}
function highlightTone(weight, spatial) {
  const context = soundContext(); if (!context) return;
  const {amount, frequency} = vectorPitch(weight), now = context.currentTime, root = Math.max(880, Math.min(2640, frequency * 4));
  // High, inharmonic partials make the overlay read as a small glint above
  // the regular vector voice, while the shared reverb places both together.
  for (const [ratio, level, decay] of [[1, .010, .34], [2.01, .006, .22], [2.76, .004, .29], [4.07, .0025, .16]]) {
    const oscillator = context.createOscillator(), gain = context.createGain(), filter = context.createBiquadFilter();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(root * ratio, now); filter.type = 'highpass'; filter.frequency.value = 720;
    envelope(gain, now, level + amount * level * .75, .003, decay + amount * .12);
    oscillator.connect(filter).connect(gain).connect(spatialDestination(context, 'highlight', spatial)); oscillator.start(now); oscillator.stop(now + decay + amount * .12 + .03);
  }
}
function bassoTone(sample, duration) {
  const context = soundContext(); if (!context || !sample.weight) return;
  const now = context.currentTime, amount = sample.intensity;
  // A small palette reads as continuo rather than a second melody. The X band
  // supplies slow harmonic motion; density opens the low-pass filter.
  const degrees = [0, 3, 5, 7, 10, 7, 5], root = 49 * 2 ** (degrees[sample.band % degrees.length] / 12);
  for (const [ratio, level] of [[1, 1], [2, .23], [3, .09]]) {
    const oscillator = context.createOscillator(), gain = context.createGain(), filter = context.createBiquadFilter();
    oscillator.type = ratio === 1 ? 'triangle' : 'sine'; oscillator.frequency.setValueAtTime(root * ratio, now);
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(240 + amount * 620, now); filter.Q.value = .8;
    envelope(gain, now, (.018 + amount * .026) * level, .055, duration);
    oscillator.connect(filter).connect(gain).connect(soundChannel(context, 'basso')); oscillator.start(now); oscillator.stop(now + duration + .12);
  }
}
function playBassoContinuo() {
  if (!yearAnimation || !sound) return;
  const elapsed = performance.now() - yearAnimation.startedAt;
  if (elapsed < 0 || elapsed >= yearAnimation.duration) return;
  const sweepPhase = Math.min(1, elapsed / yearAnimation.duration / .68);
  const band = Math.min(BASSO_X_BANDS - 1, Math.floor(sweepPhase * BASSO_X_BANDS));
  if (yearAnimation.soundedBasso.has(band)) return;
  yearAnimation.soundedBasso.add(band);
  const sample = bassoSamples(yearAnimation.yearIndex)[band];
  // Keep it sustained at the default tempo, then let slower playback stretch
  // the woven phrase naturally.
  const duration = Math.max(.58, Math.min(3.4, yearAnimation.duration / 1000 * .68 / BASSO_X_BANDS * 1.9));
  bassoTone(sample, duration);
}
function playPulseCandidates(candidates) {
  if (!yearAnimation || !candidates.length) return;
  const fresh = candidates.filter((candidate) => !yearAnimation.soundedPulses.has(candidate.key));
  fresh.forEach((candidate) => yearAnimation.soundedPulses.add(candidate.key));
  if (!fresh.length || !sound) return;
  const now = performance.now();
  if (now - yearAnimation.lastToneAt < 86) return;
  yearAnimation.lastToneAt = now;
  const strongest = fresh.reduce((largest, candidate) => candidate.weight > largest.weight ? candidate : largest);
  vectorTone(strongest.weight, strongest.spatial);
  const highlights = fresh.filter((candidate) => candidate.highlighted);
  if (highlights.length) { const brightest = highlights.reduce((largest, candidate) => candidate.weight > largest.weight ? candidate : largest); highlightTone(brightest.weight, brightest.spatial); }
}
function setCanvasYear(year, animate = true) {
  const digits = String(year).padStart(4, '0').slice(-4), display = $('#canvas-year'), caption = $('#canvas-caption'), artist = selected === 'all' ? undefined : data?._artistsById.get(selected);
  const catalogEntry = artist && artworkCatalog.get(artist.id), optionName = artist && [...$('#featured-artist').options].find((option) => option.value === artist.id)?.textContent.replace(/\s·\s\d{4}$/, ''), publicArtistName = catalogEntry?.displayName || optionName || artist?.name;
  const label = artist ? `${publicArtistName} · ${year}` : String(year), captionLabel = `WOVEN — ${label}`;
  display.setAttribute('aria-label', captionLabel); $('#canvas-year-artist').textContent = publicArtistName || '';
  caption.replaceChildren();
  const title = document.createElement('span'); title.className = 'canvas-caption-title'; title.textContent = captionLabel; caption.append(title);
  if (!requestedArtwork && catalogEntry) {
    const link = document.createElement('a');
    link.className = 'canvas-caption-link'; link.href = artworkUrl(catalogEntry, year);
    link.textContent = 'Open this artwork';
    caption.append(link);
  }
  [...display.querySelectorAll('.canvas-year-digit')].forEach((digit, index) => {
    const next = digits[index], value = digit.firstElementChild;
    if (value.textContent === next) return;
    digit.dataset.previous = value.textContent; value.textContent = next;
    if (!animate) return;
    digit.classList.remove('is-rolling'); void digit.offsetWidth; digit.classList.add('is-rolling');
  });
}
function setCanvasYearVisibility(visible) {
  const display = $('#canvas-year'), caption = $('#canvas-caption'), control = $('#canvas-year-toggle');
  display.hidden = !visible;
  display.classList.toggle('is-hidden', !visible);
  display.setAttribute('aria-hidden', String(!visible));
  caption.hidden = !visible;
  caption.setAttribute('aria-hidden', String(!visible));
  control.setAttribute('aria-pressed', String(visible));
  control.textContent = visible ? 'Year display: On' : 'Year display: Off';
}
function toggleCanvasYearVisibility() { setCanvasYearVisibility($('#canvas-year').hidden); }
function setPlaybackControl(playing) {
  const control = $('#play-years'), label = playing ? 'Stop' : 'Play years';
  control.setAttribute('aria-pressed', String(playing)); control.setAttribute('aria-label', label); control.title = label;
}
function setSoundControl(enabled) {
  const control = $('#sound'), label = enabled ? 'Sound on' : 'Sound off';
  if (!control.querySelector('svg')) control.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h4l5 4v-13l-5 4z"/><path class="sound-wave" d="M16 9c1 .8 1.5 1.8 1.5 3S17 14.2 16 15M18.6 6.6C20.2 8.1 21 10 21 12s-.8 3.9-2.4 5.4"/></svg>';
  control.setAttribute('aria-pressed', String(enabled)); control.setAttribute('aria-label', label); control.title = label;
}
function update() { $('#year-value').textContent = data.years[yearIndex]; setCanvasYear(data.years[yearIndex]); draw(); }
function setDisplayedYear(index) { $('#year').value = index; $('#year-value').textContent = data.years[index]; setCanvasYear(data.years[index]); }
function stopYearAnimation(commit = true) {
  const pending = yearAnimation;
  if (pending && commit) { yearIndex = pending.yearIndex; setDisplayedYear(yearIndex); }
  yearAnimation = undefined; cancelTilePrefetch(); if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = undefined;
  setPlaybackControl(false);
  if (pending && commit) draw();
}
function animationDuration() { return YEAR_DURATION_AT_1X / Number($('#animation-speed').value); }
function setAnimationSpeed() {
  const control = $('#animation-speed'), nextDuration = animationDuration(); $('#animation-speed-value').textContent = `${Number(control.value).toFixed(2)}×`;
  if (!yearAnimation) return;
  const phase = Math.min(1, (performance.now() - yearAnimation.startedAt) / yearAnimation.duration);
  yearAnimation.duration = nextDuration; yearAnimation.startedAt = performance.now() - phase * nextDuration;
}
function beginYearAnimation(targetIndex) {
  yearAnimation = {yearIndex: targetIndex, startedAt: performance.now(), duration: animationDuration(), dissolveDuration: 260, soundedPulses: new Set(), soundedBasso: new Set(), lastToneAt: -Infinity};
  setDisplayedYear(targetIndex); weaveClack(); draw(); scheduleTilePrefetch(targetIndex);
}
function animateYear() {
  draw();
  if (!yearAnimation) return;
  if (performance.now() - yearAnimation.startedAt < yearAnimation.duration + yearAnimation.dissolveDuration) { animationFrame = requestAnimationFrame(animateYear); return; }
  yearIndex = yearAnimation.yearIndex;
  discardTimelineTiles(Math.max(0, yearIndex));
  if (requestedArtwork) {
    if (loopArtworkYear) { beginYearAnimation(yearIndex); animationFrame = requestAnimationFrame(animateYear); return; }
    stopYearAnimation(false); update(); return;
  }
  if (yearIndex >= data.years.length - 1) { stopYearAnimation(false); update(); return; }
  selectedLink = undefined; beginYearAnimation(yearIndex + 1); animationFrame = requestAnimationFrame(animateYear);
}
function playYears() {
  if (yearAnimation) { stopYearAnimation(); return; }
  if (requestedArtwork) { setPlaybackControl(true); beginYearAnimation(yearIndex); animationFrame = requestAnimationFrame(animateYear); return; }
  if (yearIndex >= data.years.length - 1) yearIndex = -1;
  const targetIndex = Math.min(data.years.length - 1, yearIndex + 1);
  setPlaybackControl(true); beginYearAnimation(targetIndex); animationFrame = requestAnimationFrame(animateYear);
}
function playbackShortcut(event) {
  if (event.code !== 'Space' || event.repeat) return;
  const target = event.target;
  // Space retains its usual control behaviour while a form element is active.
  if (target instanceof Element && target.closest('input, select, textarea, button, [contenteditable="true"]')) return;
  event.preventDefault(); playYears();
}
function setCameraZoom() { return false; }
function zoomFromWheel() {}
function beginDrag(event) { if (cameraScale() <= 1) return; dragState = {x: event.clientX, y: event.clientY, panX: cameraPan.x, panY: cameraPan.y, moved: false}; canvas.setPointerCapture(event.pointerId); canvas.classList.add('is-panning'); }
function moveDrag(event) { if (!dragState) return; cameraPan.x = dragState.panX + event.clientX - dragState.x; cameraPan.y = dragState.panY + event.clientY - dragState.y; dragState.moved ||= Math.abs(event.clientX - dragState.x) + Math.abs(event.clientY - dragState.y) > 3; constrainPan(); draw(); }
function endDrag(event) { if (!dragState) return; const moved = dragState.moved; dragState = undefined; canvas.classList.remove('is-panning'); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); if (moved) { ignoreNextClick = true; selectedLink = undefined; } }
async function toggleFullscreen() {
  if (document.fullscreenElement === canvas.parentElement) await document.exitFullscreen();
  else { await loadTileSet(ULTRA_OVERVIEW_KEY); await canvas.parentElement.requestFullscreen({navigationUI: 'hide'}); }
}
function loadPreferredTiles() {
  if (!tileManifest) return;
  loadTileSet(preferredTileKey()).then(draw).catch((error) => console.warn('Unable to load the preferred WOVEN tile set', error));
}
function syncFullscreenControl() {
  const active = document.fullscreenElement === canvas.parentElement;
  setFullscreenControl(active); setFullscreenChromeVisible(false);
  loadPreferredTiles();
}
function setFullscreenChromeVisible(visible) {
  const wrap = canvas.parentElement;
  if (fullscreenChromeTimer) { clearTimeout(fullscreenChromeTimer); fullscreenChromeTimer = undefined; }
  wrap.classList.toggle('is-chrome-visible', visible);
  if (visible && document.fullscreenElement === wrap) fullscreenChromeTimer = setTimeout(() => setFullscreenChromeVisible(false), 1800);
}
function revealFullscreenChrome(event) {
  const wrap = canvas.parentElement;
  if (document.fullscreenElement !== wrap) return;
  const bounds = wrap.getBoundingClientRect();
  if (event.clientY >= bounds.bottom - 132) setFullscreenChromeVisible(true);
  else setFullscreenChromeVisible(false);
}
function setFullscreenControl(active) {
  const control = $('#fullscreen'), label = active ? 'Exit fullscreen' : 'Enter fullscreen';
  control.setAttribute('aria-pressed', String(active)); control.setAttribute('aria-label', label); control.title = label;
}
function toggleControlDrawer() {
  const drawer = $('#control-drawer'), control = $('#drawer-toggle'), open = !drawer.classList.contains('is-open');
  drawer.classList.toggle('is-open', open); control.setAttribute('aria-expanded', String(open));
}
function touchSurface() { return matchMedia('(hover: none), (pointer: coarse)').matches; }
function setTouchPlayerVisibility(visible) {
  const player = $('.canvas-player'), wrap = canvas.parentElement;
  if (!player || !touchSurface() || document.fullscreenElement === wrap) return;
  wrap.classList.toggle('is-player-visible', visible);
  player.style.opacity = visible ? '1' : '0';
  player.style.pointerEvents = visible ? 'auto' : 'none';
  player.style.transform = visible ? 'translate(-50%,0)' : 'translate(-50%,12px)';
}
function revealTouchPlayer() {
  const wrap = canvas.parentElement;
  if (!touchSurface() || document.fullscreenElement === wrap) return;
  if (playerChromeTimer) clearTimeout(playerChromeTimer);
  setTouchPlayerVisibility(true);
  playerChromeTimer = setTimeout(() => {
    setTouchPlayerVisibility(false);
    playerChromeTimer = undefined;
  }, 2400);
}
function setPalette(id) {
  if (id === 'custom') return;
  paletteId = id; palette = {...(PALETTES[id] || PALETTES['5'])};
  paletteColors = paletteRgbValues(palette);
  syncPaletteEditors();
  draw();
}
async function loadTiles() {
  setLoadingStatus('Loading woven tiles');
  const base = '/public/data/woven-tiles', manifest = await fetch(`${base}/manifest.json?v=${DATASET_VERSION}`).then((response) => response.json()); tileManifest = manifest;
  // The module is intentionally small and has no DOM/WebGL access. It only
  // folds temporal deltas into render cells; WebGL remains the renderer.
  try {
    const response = await fetch('/src/wasm/woven-aggregate.wasm');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    aggregateWasm = module.instance.exports;
  } catch (error) { console.warn('WOVEN Wasm aggregation is unavailable; using the compatible JS path.', error); }
  await loadTileSet(preferredTileKey());
}
async function loadTileSet(lod) {
  if (tiles.has(`${lod}:artist`) && tiles.has(`${lod}:work`)) return;
  if (tileLoads.has(lod)) return tileLoads.get(lod);
  const base = '/public/data/woven-tiles';
  const task = Promise.all(['artist', 'work'].map(async (layer) => {
    const info = tileManifest.layers[`${lod}/${layer}`];
    if (!info) throw new Error(`Missing WOVEN tile layer: ${lod}/${layer}`);
    const buffer = await fetch(`${base}/${info.artifact}?v=${DATASET_VERSION}`).then((response) => response.arrayBuffer());
    const header = new DataView(buffer, 0, 32), magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== 'WVTL' || header.getUint16(4, true) !== 1) throw new Error(`Unsupported WOVEN tile: ${info.artifact}`);
    const width = header.getUint32(8, true), height = header.getUint32(12, true), cellCount = header.getUint32(16, true), deltaCount = header.getUint32(20, true), cellsOffset = header.getUint32(24, true), deltasOffset = header.getUint32(28, true);
    const cellBytes = 12, deltaBytes = 8;
    if (deltasOffset + deltaCount * deltaBytes > buffer.byteLength) throw new Error(`Corrupt WOVEN tile: ${info.artifact}`);
    const cellX = new Uint16Array(cellCount), cellY = new Uint16Array(cellCount), deltaStart = new Uint32Array(cellCount), deltaCountByCell = new Uint16Array(cellCount), view = new DataView(buffer);
    for (let index = 0; index < cellCount; index += 1) { const offset = cellsOffset + index * cellBytes; cellX[index] = view.getUint16(offset, true); cellY[index] = view.getUint16(offset + 2, true); deltaStart[index] = view.getUint32(offset + 4, true); deltaCountByCell[index] = view.getUint16(offset + 8, true); }
    const deltaYears = new Uint16Array(deltaCount), deltaWeights = new Float32Array(deltaCount);
    for (let index = 0; index < deltaCount; index += 1) { const offset = deltasOffset + index * deltaBytes; deltaYears[index] = view.getUint16(offset, true); deltaWeights[index] = view.getFloat32(offset + 4, true); }
    tiles.set(`${lod}:${layer}`, {...info, width, height, cellCount, cellX, cellY, deltaStart, deltaCount: deltaCountByCell, deltaYears, deltaWeights});
  }));
  tileLoads.set(lod, task);
  try { await task; } finally { tileLoads.delete(lod); }
}
async function configureArtworkRoute() {
  if (!requestedArtwork) return;
  const response = await fetch(ARTWORK_CATALOG_URL);
  if (!response.ok) throw new Error('Unable to load the WOVEN artwork catalogue.');
  const catalogue = await response.json(); artworkCatalog = new Map(catalogue.artists.map((artist) => [artist.classiiId, artist])); artworkCatalogBySlug = new Map(catalogue.artists.map((artist) => [artist.slug, artist]));
  const entry = requestedArtwork.classiiId ? artworkCatalog.get(requestedArtwork.classiiId) : artworkCatalogBySlug.get(requestedArtwork.slug);
  if (!entry) throw new Error('This Artist is not in the public WOVEN artwork collection.');
  const artist = data._artistsById.get(entry.classiiId);
  if (!artist) throw new Error('The requested Artist is unavailable in this dataset.');
  await ensureArtistDetail(artist.id);
  const nearestYear = data.years.reduce((best, candidate) => Math.abs(candidate - requestedArtwork.year) < Math.abs(best - requestedArtwork.year) ? candidate : best, data.years[0]);
  selected = artist.id; $('#artist').value = artist.id; yearIndex = data.years.indexOf(nearestYear); $('#year').value = yearIndex;
  clearOverlayCaches(); document.body.classList.add('artwork-route'); setupArtworkPlayback();
  const displayName = entry.displayName || artist.name;
  updateArtworkMetadata(entry, displayName, nearestYear);
  configureArtworkPanel(entry, artist, displayName, nearestYear);
  $('#artwork-plate').hidden = false;
  const pageTitle = $('#global-page-title');
  pageTitle.hidden = true;
  if (requestedArtwork.source === 'path') {
    const canonical = artworkUrl(entry, nearestYear);
    if (location.pathname !== canonical) history.replaceState({}, '', canonical);
  } else {
    const canonical = `/?artist=${encodeURIComponent(entry.classiiId)}&slug=${encodeURIComponent(entry.slug)}&year=${nearestYear}`;
    if (`${location.pathname}${location.search}` !== canonical) history.replaceState({}, '', canonical);
  }
  update();
}
function setupArtworkPlayback() {
  if ($('#loop-year')) return;
  const control = document.createElement('button');
  control.className = 'player-icon'; control.id = 'loop-year'; control.type = 'button';
  control.setAttribute('aria-pressed', 'false'); control.setAttribute('aria-label', 'Loop this year'); control.title = 'Loop this year';
  control.innerHTML = '<span class="loop-icon" aria-hidden="true"></span>';
  control.addEventListener('click', () => {
    loopArtworkYear = !loopArtworkYear;
    control.setAttribute('aria-pressed', String(loopArtworkYear));
    control.setAttribute('aria-label', loopArtworkYear ? 'Stop looping this year' : 'Loop this year');
    control.title = loopArtworkYear ? 'Stop looping this year' : 'Loop this year';
  });
  $('#play-years').after(control);
}
async function setupFeaturedArtistSelector() {
  const control = $('#featured-artist'), select = $('#artist');
  try {
    const response = await fetch(ARTWORK_CATALOG_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalogue = await response.json(); artworkCatalog = new Map(catalogue.artists.map((artist) => [artist.classiiId, artist]));
    control.replaceChildren(new Option('Artists · 100 limited', 'all'), ...catalogue.artists.map((artist) => new Option(`${artist.displayName || artist.name} · ${artist.birthYear}`, artist.classiiId)));
    control.value = artworkCatalog.has(selected) ? selected : 'all';
  } catch (error) {
    console.warn('Unable to load featured Artists', error); return;
  }
  control.addEventListener('change', () => { select.value = control.value; select.dispatchEvent(new Event('change')); });
  select.addEventListener('change', () => { control.value = [...control.options].some((option) => option.value === select.value) ? select.value : 'all'; });
}
async function init() { setLoadingStatus('Loading relationship library'); const response = await fetch(`/public/data/woven-sample.json?v=${DATASET_VERSION}`); if (!response.ok) throw new Error(`Unable to load the WOVEN library: HTTP ${response.status}`); data = await response.json(); await loadTiles(); setLoadingStatus('Arranging the cultural fabric'); prepareLod(); const select = $('#artist'); data.artists.forEach((artist) => { const option = document.createElement('option'); option.value = artist.id; option.textContent = artist.name; select.append(option); }); const year = $('#year'), zoom = $('#zoom'), speed = $('#animation-speed'), instrument = $('#glow-instrument'), glowControl = $('#glow-volume'), reverbControl = $('#reverb-amount'), clack = $('#weave-clack'), clackControl = $('#clack-volume'), paletteControl = $('#palette'); setLoadingStatus('Preparing sound and controls'); await Promise.all([loadInstrumentCatalog(instrument), loadWaveCatalog(clack)]); year.min = 0; year.max = data.years.length - 1; year.value = yearIndex = data.years.length - 1; zoom.value = lodIndex; glowInstrument = instrument.value; weaveClackId = clack.value; setChannelVolume('glow', Number(glowControl.value)); setReverbAmount(Number(reverbControl.value)); setChannelVolume('clack', Number(clackControl.value)); setAnimationSpeed(); setCanvasYearVisibility(true); $('#zoom-value').textContent = zoomLabel(); year.addEventListener('input', () => { stopYearAnimation(); yearIndex = Number(year.value); selectedLink = undefined; update(); }); select.addEventListener('change', () => { stopYearAnimation(); selected = select.value; clearOverlayCaches(); selectedLink = undefined; update(); }); paletteControl.addEventListener('change', () => setPalette(paletteControl.value)); $('#play-years').addEventListener('click', playYears); speed.addEventListener('input', setAnimationSpeed); $('#canvas-year-toggle').addEventListener('click', toggleCanvasYearVisibility); glowControl.addEventListener('input', () => setChannelVolume('glow', Number(glowControl.value))); reverbControl.addEventListener('input', () => setChannelVolume('glow', Number(reverbControl.value))); clackControl.addEventListener('input', () => setChannelVolume('clack', Number(clackControl.value))); instrument.addEventListener('change', () => { glowInstrument = instrument.value; const context = soundContext(); if (context && instrumentCatalog.has(glowInstrument)) loadInstrumentPack(glowInstrument, context).catch((error) => console.warn('Unable to load glow instrument', error)); }); clack.addEventListener('change', () => { weaveClackId = clack.value; const context = soundContext(); if (context) loadWeaveClack(context).catch((error) => console.warn('Unable to load weave clack', error)); }); $('#fullscreen').addEventListener('click', toggleFullscreen); $('#drawer-toggle').addEventListener('click', toggleControlDrawer); document.addEventListener('fullscreenchange', syncFullscreenControl); document.addEventListener('keydown', playbackShortcut); zoom.addEventListener('input', () => setCameraZoom(Number(zoom.value), zoom)); $('#sound').addEventListener('click', () => { sound = !sound; $('#sound').setAttribute('aria-pressed', sound); $('#sound').textContent = sound ? 'Sound on' : 'Sound off'; const context = soundContext(); if (context) loadWeaveClack(context).catch((error) => console.warn('Unable to load weave clack', error)); }); canvas.addEventListener('click', (event) => { if (ignoreNextClick) { ignoreNextClick = false; return; } details(event); }); canvas.addEventListener('pointerdown', beginDrag); canvas.addEventListener('pointermove', moveDrag); canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('wheel', (event) => zoomFromWheel(event, zoom), {passive: false}); window.addEventListener('resize', draw); setPalette(paletteControl.value); }
canvas.parentElement.addEventListener('pointermove', revealFullscreenChrome);
window.addEventListener('resize', loadPreferredTiles);
// The canvas can change size without a viewport resize (for example when a
// mobile browser changes its chrome). Choose against this element, not merely
// the browser window.
new ResizeObserver(loadPreferredTiles).observe(canvas);
canvas.parentElement.addEventListener('pointerdown', revealTouchPlayer);
canvas.parentElement.addEventListener('focusin', () => { if (document.fullscreenElement === canvas.parentElement) setFullscreenChromeVisible(true); });
function setupArtistSearch() {
  const input = $('#artist-search'), results = $('#artist-results'), select = $('#artist'), normalise = (value) => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const choose = (artist) => { input.value = artist.name; select.value = artist.id; select.dispatchEvent(new Event('change')); results.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const clear = () => { select.value = 'all'; select.dispatchEvent(new Event('change')); };
  const render = () => {
    const query = normalise(input.value.trim());
    if (!query) { results.hidden = true; input.setAttribute('aria-expanded', 'false'); clear(); return; }
    const matches = data.artists.filter((artist) => artist.detailAvailable && normalise(artist.name).includes(query)).slice(0, 12);
    results.replaceChildren(...matches.map((artist) => { const button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.textContent = artist.name; button.addEventListener('click', () => choose(artist)); return button; }));
    results.hidden = !matches.length; input.setAttribute('aria-expanded', String(matches.length > 0));
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { results.hidden = true; input.setAttribute('aria-expanded', 'false'); } if (event.key === 'Enter') { const exact = data.artists.find((artist) => normalise(artist.name) === normalise(input.value)); if (exact) { event.preventDefault(); choose(exact); } } });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));
}
async function initRuntime() {
  const response = await fetch(`${RUNTIME_INDEX_URL}?v=${DATASET_VERSION}`);
  if (!response.ok) throw new Error(`Unable to load the WOVEN index: HTTP ${response.status}`);
  const index = await response.json();
  // Reuse the established control/audio setup. During that setup, substitute
  // the old monolithic request with the compact runtime index exactly once.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => String(input).includes('/public/data/woven-sample.json')
    ? Promise.resolve(new Response(JSON.stringify(index), {headers: {'Content-Type': 'application/json'}}))
    : nativeFetch(input, options);
  try { await init(); } finally { window.fetch = nativeFetch; }
}
initRuntime().then(async () => {
  await configureArtworkRoute();
  Object.keys(PALETTE_EDITOR_ROLES).forEach((role) => {
    $(`#color-${role}`).addEventListener('input', (event) => setPaletteEditorColor(role, event.target.value));
  });
  await setupFeaturedArtistSelector();
  setCanvasYear(data.years[yearIndex], false);
  // Keep the reverb handler independent of the glow channel.  This listener
  // also normalises the glow gain after the compact setup handler above.
  $('#reverb-amount').addEventListener('input', () => {
    setChannelVolume('glow', Number($('#glow-volume').value));
    setReverbAmount(Number($('#reverb-amount').value));
  });
  setSoundControl(sound);
  // The compact setup listener initialises the audio graph. Restore the SVG
  // icon afterwards because its legacy text label is intentionally retained
  // for non-visual controls elsewhere in the app.
  $('#sound').addEventListener('click', () => queueMicrotask(() => setSoundControl(sound)));
  setupArtistSearch();
  $('#artist').addEventListener('change', async () => {
    if (selected === 'all') return;
    await ensureArtistDetail(selected);
    update();
  });
  setTouchPlayerVisibility(false);
  setLoadingStatus('Ready');
  completeLoading();
  document.documentElement.dataset.wovenReady = 'true';
  for (const [channel, id] of [['basso', '#basso-volume'], ['highlight', '#highlight-volume']]) {
    const control = $(id); setChannelVolume(channel, Number(control.value));
    control.addEventListener('input', () => setChannelVolume(channel, Number(control.value)));
  }
}).catch(failLoading);
