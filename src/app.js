const $ = (s) => document.querySelector(s);
const canvas = $('#fabric'), gl = canvas.getContext('webgl2', {antialias: false, alpha: false});
if (!gl) throw new Error('WOVEN requires WebGL2.');
const VERTEX_SHADER = `#version 300 es
in vec2 a_position; in vec4 a_color; in float a_size;
uniform vec2 u_resolution; uniform vec2 u_center; uniform vec2 u_pan; uniform float u_scale; uniform float u_pixel_ratio;
out vec4 v_color;
void main() { vec2 scene = (a_position - u_center + u_pan) * u_scale + u_center; vec2 clip = vec2(scene.x / u_resolution.x * 2.0 - 1.0, 1.0 - scene.y / u_resolution.y * 2.0); gl_Position = vec4(clip, 0.0, 1.0); gl_PointSize = a_size * u_pixel_ratio; v_color = a_color; }`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float; in vec4 v_color; out vec4 out_color;
void main() { if (distance(gl_PointCoord, vec2(.5)) > .5) discard; out_color = v_color; }`;
function shader(type, source) { const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value); if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value)); return value; }
const program = gl.createProgram(); gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX_SHADER)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
const pointBuffer = gl.createBuffer(), positionLoc = gl.getAttribLocation(program, 'a_position'), colorLoc = gl.getAttribLocation(program, 'a_color'), sizeLoc = gl.getAttribLocation(program, 'a_size');
const uniforms = Object.fromEntries(['u_resolution', 'u_center', 'u_pan', 'u_scale', 'u_pixel_ratio'].map((name) => [name, gl.getUniformLocation(program, name)]));
const LOD_LABELS = ['Overview', 'Cluster', 'Artist'];
let data, selected = 'all', yearIndex = 0, lodIndex = 1, cameraZoom = 1, cameraPan = {x: 0, y: 0}, dragState, ignoreNextClick = false, sound = false, audio, selectedLink;
let relationCache = {key: '', raw: [], works: new Map(), artists: new Map()};
let tileCache = new Map(), tiles = new Map();
const compactScaleCache = new WeakMap();
const yearDeltaCache = new Map();
let yearAnimation, animationFrame;
const LOD_KEYS = ['overview', 'cluster', 'artist'];
const YEAR_DURATION_AT_1X = 1400;
// The reference field is the normal in-page canvas.  Pulses need to grow with
// the available drawing surface: otherwise fullscreen spreads the columns out
// while leaving a fixed-pixel flare too small to read as light.
const GLOW_REFERENCE_SIZE = {width: 1280, height: 620};

function visibleArtists() { return selected === 'all' ? data.artists : data.artists.filter((a) => a.id === selected); }
function cache() { const key = `${yearIndex}:${selected}`; if (relationCache.key !== key) relationCache = {key, raw: null, works: new Map(), artists: new Map()}; return relationCache; }
function rawLinks() { const current = cache(); if (current.raw) return current.raw; const links = new Map(), until = data.years[yearIndex]; for (const artist of visibleArtists()) for (const row of artist.series) { if (row.year > until) continue; for (const [work, value] of row.works) { const key = `${artist.id}:${work}`, old = links.get(key); links.set(key, {artist, work, weight: (old?.weight || 0) + value}); } } return current.raw = [...links.values()]; }
function workLinks(modeIndex = lodIndex) { const current = cache(); if (current.works.has(modeIndex)) return current.works.get(modeIndex); const links = new Map(), positions = data._lodModes[modeIndex].positions; for (const link of rawLinks()) { const source = positions.get(link.artist.id); if (source === undefined) continue; const key = `${source}:${link.work}`, old = links.get(key); links.set(key, {source, target: link.work, weight: (old?.weight || 0) + link.weight}); } const result = [...links.values()]; current.works.set(modeIndex, result); return result; }
function artistLinks(modeIndex = lodIndex) { const current = cache(); if (current.artists.has(modeIndex)) return current.artists.get(modeIndex); const links = new Map(), positions = data._lodModes[modeIndex].positions, until = data.years[yearIndex]; for (const relation of data.artistRelations) { if (relation.firstYear === null || relation.firstYear > until) continue; for (const [from, target] of [[relation.source, relation.target], [relation.target, relation.source]]) { if (selected !== 'all' && from !== selected) continue; const source = positions.get(from); if (source === undefined) continue; const key = `${source}:${target}`, old = links.get(key); links.set(key, {source, target, weight: (old?.weight || 0) + relation.weight, sharedWorks: (old?.sharedWorks || 0) + relation.sharedWorks}); } } const result = [...links.values()]; current.artists.set(modeIndex, result); return result; }
function tileLinks(modeIndex, layer, temporalIndex = yearIndex) {
  const key = `${temporalIndex}:${modeIndex}:${layer}`, cached = tileCache.get(key); if (cached) return cached;
  const tile = tiles.get(`${modeIndex}:${layer}`), until = data.years[temporalIndex];
  const result = tile.cells.map((cell) => ({...cell, weight: cell.deltas.reduce((sum, [year, weight]) => year <= until ? sum + weight : sum, 0)})).filter((cell) => cell.weight > 0);
  tileCache.set(key, result); return result;
}
function yearDeltaColumns(modeIndex, layer, index) {
  const key = `${modeIndex}:${layer}:${index}`, cached = yearDeltaCache.get(key); if (cached) return cached;
  const year = data.years[index], columns = new Map();
  for (const cell of tiles.get(`${modeIndex}:${layer}`).cells) {
    const delta = cell.deltas.find(([cellYear]) => cellYear === year)?.[1];
    if (!delta) continue;
    const column = columns.get(cell.x) || [];
    column.push({...cell, weight: delta}); columns.set(cell.x, column);
  }
  yearDeltaCache.set(key, columns); return columns;
}
function compactScale(links) {
  const cached = compactScaleCache.get(links); if (cached) return cached;
  const weights = links.map((link) => link.weight).sort((left, right) => left - right);
  const value = Math.max(1, weights[Math.floor((weights.length - 1) * .95)] || 1);
  compactScaleCache.set(links, value); return value;
}

function prepareLod() {
  const byId = new Map(data.lod.tree.map((node) => [node.id, node])), byArtist = new Map(data.artists.map((artist, index) => [artist.id, index])), leaves = new Map(data.lod.tree.filter((node) => node.artist).map((node) => [node.artist, node.id])), minimum = new Map();
  const position = (id) => { if (minimum.has(id)) return minimum.get(id); const node = byId.get(id), value = node.artist ? byArtist.get(node.artist) : Math.min(...node.children.map(position)); minimum.set(id, value); return value; };
  const root = byId.get(data.lod.root_node_id), overview = [...root.children].sort((a, b) => position(a) - position(b)), cluster = [...overview];
  while (cluster.length < 240) { const candidates = cluster.filter((id) => byId.get(id).children.length); if (!candidates.length) break; const largest = candidates.sort((a, b) => byId.get(b).leaves - byId.get(a).leaves || position(a) - position(b))[0]; cluster.splice(cluster.indexOf(largest), 1, ...byId.get(largest).children); }
  cluster.sort((a, b) => position(a) - position(b));
  data._lodModes = [overview, cluster, data.artists.map((a) => leaves.get(a.id))].map((ids) => { const positions = new Map(); const assign = (id, index) => { const node = byId.get(id); if (node.artist) positions.set(node.artist, index); else node.children.forEach((child) => assign(child, index)); }; ids.forEach(assign); return {nodes: ids.map((id) => byId.get(id)), positions}; });
  data._artistsById = new Map(data.artists.map((artist) => [artist.id, artist])); data._worksById = new Map(data.works.map((work, index) => [work.id, {...work, index}]));
}
function geometry(width, height, count) { const artistTop = 116, artistBottom = Math.max(178, height * .29), workTop = artistBottom + 38, workBottom = height - 30; return {x: (i) => 20 + (width - 40) * i / Math.max(1, count - 1), artistY: (i) => artistTop + (artistBottom - artistTop) * i / Math.max(1, data.artists.length - 1), workY: (i) => workTop + (workBottom - workTop) * i / Math.max(1, data.works.length - 1), artistTop, artistBottom, workTop, workBottom}; }
function point(points, x, y, weight, max, selected, opacity, compact = false) { const intensity = Math.min(1, Math.log1p(weight) / Math.log1p(max)), size = selected ? 6.6 : compact ? Math.min(3, 1.3 + Math.sqrt(weight) * .12) : Math.min(4.2, 1.1 + Math.sqrt(weight) * .44); if (selected) points.push(x, y, 1, .94, .68, opacity, size); else points.push(x, y, (190 + intensity * 51) / 255, (135 + intensity * 86) / 255, (45 + intensity * 75) / 255, (compact ? .025 + intensity * .42 : .035 + intensity * .55) * opacity, size); }
function lodLayers() {
  // Keep one stable level between transition bands, then cross-fade the
  // adjacent semantic trees while the camera passes a threshold.
  // LOD hand-offs occur only after continuous canvas magnification has begun.
  // This prevents the levels from reading as two static images cross-fading.
  if (cameraZoom < .9) return [{index: 0, opacity: 1}];
  if (cameraZoom < 1.2) { const mix = (cameraZoom - .9) / .3; return [{index: 0, opacity: 1 - mix}, {index: 1, opacity: mix}]; }
  if (cameraZoom < 1.75) return [{index: 1, opacity: 1}];
  if (cameraZoom < 2.05) { const mix = (cameraZoom - 1.75) / .3; return [{index: 1, opacity: 1 - mix}, {index: 2, opacity: mix}]; }
  return [{index: 2, opacity: 1}];
}
function zoomLabel() { const layers = lodLayers(); return layers.length === 1 ? LOD_LABELS[layers[0].index] : `${LOD_LABELS[layers[0].index]} → ${LOD_LABELS[layers[1].index]}`; }
function cameraScale() { return Math.max(1, 2 ** (cameraZoom - 1)); }
function glowScale(width, height) {
  const areaRatio = width * height / (GLOW_REFERENCE_SIZE.width * GLOW_REFERENCE_SIZE.height);
  return Math.max(.78, Math.min(2.7, Math.sqrt(areaRatio)));
}
function constrainPan(width = canvas.clientWidth, height = canvas.clientHeight) {
  const scale = cameraScale();
  // Treat the visible matrix as a bounded world with its top-left at (0, 0).
  // Panning is limited so the viewport never exposes beyond its X/Y extent.
  const bounds = {left: 20, right: width - 20, top: 54, bottom: height - 30};
  const centerX = width / 2, centerY = height / 2, inverseZoom = 1 - 1 / scale;
  const minX = (centerX - bounds.right) * inverseZoom, maxX = (centerX - bounds.left) * inverseZoom;
  const minY = (centerY - bounds.bottom) * inverseZoom, maxY = (centerY - bounds.top) * inverseZoom;
  cameraPan.x = Math.max(minX, Math.min(maxX, cameraPan.x));
  cameraPan.y = Math.max(minY, Math.min(maxY, cameraPan.y));
}
function appendLodLayer(points, modeIndex, opacity, width, height, maxWeight, temporalIndex = yearIndex) {
  const nodes = data._lodModes[modeIndex].nodes, layout = geometry(width, height, nodes.length);
  if (selected === 'all') {
    for (const layer of ['artist', 'work']) {
      const tile = tiles.get(`${modeIndex}:${layer}`), yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
      const cells = tileLinks(modeIndex, layer, temporalIndex), compact = modeIndex === 0, scale = compact ? compactScale(cells) : maxWeight;
      for (const cell of cells) point(points, 20 + (width - 40) * cell.x / Math.max(1, tile.width - 1), yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1), cell.weight, scale, false, opacity, compact);
    }
    nodes.forEach((node, i) => points.push(layout.x(i), 54, .945, .808, .47, .72 * opacity, 4.4));
    return;
  }
  const artists = artistLinks(modeIndex), works = workLinks(modeIndex);
  for (const link of artists) { const target = data._artistsById.get(link.target); if (target) point(points, layout.x(link.source), layout.artistY(target.position), link.weight, maxWeight, selectedLink === `a:${modeIndex}:${link.source}:${link.target}`, opacity); }
  for (const link of works) { const target = data._worksById.get(link.target); if (target) point(points, layout.x(link.source), layout.workY(target.index), link.weight, maxWeight, selectedLink === `w:${modeIndex}:${link.source}:${link.target}`, opacity); }
  nodes.forEach((node, i) => points.push(layout.x(i), 54, .945, .808, .47, .72 * opacity, 4.4));
}
function appendYearPulse(points, width, height) {
  if (!yearAnimation || selected !== 'all') return;
  const elapsed = performance.now() - yearAnimation.startedAt;
  if (elapsed >= yearAnimation.duration) return;
  const responsiveGlow = glowScale(width, height);
  const phase = elapsed / yearAnimation.duration, columnDelay = .68, columnSpan = 1 - columnDelay;
  for (const {index, opacity} of lodLayers()) {
    const layout = geometry(width, height, data._lodModes[index].nodes.length);
    for (const layer of ['artist', 'work']) {
      const tile = tiles.get(`${index}:${layer}`), yTop = layer === 'artist' ? layout.artistTop : layout.workTop, yBottom = layer === 'artist' ? layout.artistBottom : layout.workBottom;
      const first = Math.max(0, Math.ceil((phase - columnSpan) / columnDelay * (tile.width - 1))), last = Math.min(tile.width - 1, Math.floor(phase / columnDelay * (tile.width - 1)));
      const columns = yearDeltaColumns(index, layer, yearAnimation.yearIndex);
      for (let x = first; x <= last; x += 1) {
        const columnPhase = (phase - x / Math.max(1, tile.width - 1) * columnDelay) / columnSpan;
        if (columnPhase < 0 || columnPhase > 1) continue;
        const xPosition = 20 + (width - 40) * x / Math.max(1, tile.width - 1), beamY = yTop + (yBottom - yTop) * columnPhase;
        for (const cell of columns.get(x) || []) {
          const cellY = yTop + (yBottom - yTop) * cell.y / Math.max(1, tile.height - 1), distance = Math.abs(cellY - beamY) / Math.max(1, yBottom - yTop);
          if (distance > .035) continue;
          const flare = (1 - distance / .035) * opacity, size = (4 + Math.min(7, Math.sqrt(cell.weight) * .9)) * responsiveGlow;
          // Pulses are drawn in a separate additive pass: a broad halo keeps
          // new relations legible over an already bright late-year fabric.
          points.push(xPosition, cellY, 1, .48, .08, .16 * flare, size * 3.4);
          points.push(xPosition, cellY, 1, .91, .48, .98 * flare, size);
        }
      }
    }
  }
}
function renderPoints(points, pulses, width, height, viewScale) {
  const pixelRatio = devicePixelRatio, stride = 7 * 4; canvas.width = Math.round(width * pixelRatio); canvas.height = Math.round(height * pixelRatio); gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(.063, .071, .059, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer); gl.enableVertexAttribArray(positionLoc); gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, stride, 0); gl.enableVertexAttribArray(colorLoc); gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 2 * 4); gl.enableVertexAttribArray(sizeLoc); gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, stride, 6 * 4); gl.uniform2f(uniforms.u_resolution, width, height); gl.uniform2f(uniforms.u_center, width / 2, height / 2); gl.uniform2f(uniforms.u_pan, cameraPan.x, cameraPan.y); gl.uniform1f(uniforms.u_scale, viewScale); gl.uniform1f(uniforms.u_pixel_ratio, pixelRatio); gl.enable(gl.BLEND);
  const drawPass = (values, additive) => { if (!values.length) return; gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW); gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); gl.drawArrays(gl.POINTS, 0, values.length / 7); };
  drawPass(points, false); drawPass(pulses, true);
}
function draw() {
  const rect = canvas.getBoundingClientRect();
  const layers = lodLayers(), elapsed = yearAnimation ? performance.now() - yearAnimation.startedAt : 0, dissolve = yearAnimation ? Math.max(0, Math.min(1, (elapsed - yearAnimation.duration) / yearAnimation.dissolveDuration)) : 0;
  const timeStates = yearAnimation && dissolve > 0 ? [{index: yearIndex, opacity: 1 - dissolve}, {index: yearAnimation.yearIndex, opacity: dissolve}] : [{index: yearIndex, opacity: 1}];
  const allLinks = timeStates.flatMap((timeState) => layers.flatMap(({index}) => selected === 'all' ? [...tileLinks(index, 'artist', timeState.index), ...tileLinks(index, 'work', timeState.index)] : [...artistLinks(index), ...workLinks(index)]));
  const max = allLinks.reduce((largest, link) => Math.max(largest, link.weight), 1);
  const points = [], pulses = [], viewScale = cameraScale(); constrainPan(rect.width, rect.height); timeStates.forEach((timeState) => layers.forEach(({index, opacity}) => appendLodLayer(points, index, opacity * timeState.opacity, rect.width, rect.height, max, timeState.index))); appendYearPulse(pulses, rect.width, rect.height); renderPoints(points, pulses, rect.width, rect.height, viewScale);
}
function details(event) {
  if (selected === 'all') return;
  const rect = canvas.getBoundingClientRect(), viewScale = cameraScale();
  const worldX = (event.clientX - rect.left - rect.width / 2 - cameraPan.x) / viewScale + rect.width / 2;
  const worldY = (event.clientY - rect.top - rect.height / 2 - cameraPan.y) / viewScale + rect.height / 2;
  const nodes = data._lodModes[lodIndex].nodes;
  const layout = geometry(rect.width, rect.height, nodes.length);
  const source = Math.max(0, Math.min(nodes.length - 1, Math.round((worldX - 20) / (rect.width - 40) * (nodes.length - 1))));
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
  $('#detail').innerHTML = `<p class="detail-kicker">${LOD_LABELS[lodIndex].toUpperCase()} ARTIST SOURCE</p><h2>${sourceName} → ${target.name}</h2><p>Relation weight through ${data.years[yearIndex]}: ${link.weight.toFixed(2)}.</p>`;
  draw();
}
function beat(value) { if (!sound) return; audio ||= new AudioContext(); const now = audio.currentTime, oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.frequency.setValueAtTime(70 + Math.min(180, value * 8), now); gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(.12, now + .006); gain.gain.exponentialRampToValueAtTime(.0001, now + .13); oscillator.connect(gain).connect(audio.destination); oscillator.start(now); oscillator.stop(now + .14); }
function update() { $('#year-value').textContent = data.years[yearIndex]; beat(visibleArtists().flatMap((a) => a.series).find((row) => row.year === data.years[yearIndex])?.delta || 0); draw(); }
function setDisplayedYear(index) { $('#year').value = index; $('#year-value').textContent = data.years[index]; }
function stopYearAnimation(commit = true) {
  const pending = yearAnimation;
  if (pending && commit) { yearIndex = pending.yearIndex; setDisplayedYear(yearIndex); }
  yearAnimation = undefined; if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = undefined;
  const control = $('#play-years'); control.setAttribute('aria-pressed', 'false'); control.textContent = 'Play years';
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
  yearAnimation = {yearIndex: targetIndex, startedAt: performance.now(), duration: animationDuration(), dissolveDuration: 260};
  setDisplayedYear(targetIndex); beat(visibleArtists().flatMap((artist) => artist.series).find((row) => row.year === data.years[targetIndex])?.delta || 0); draw();
}
function animateYear() {
  draw();
  if (!yearAnimation) return;
  if (performance.now() - yearAnimation.startedAt < yearAnimation.duration + yearAnimation.dissolveDuration) { animationFrame = requestAnimationFrame(animateYear); return; }
  yearIndex = yearAnimation.yearIndex;
  if (yearIndex >= data.years.length - 1) { stopYearAnimation(false); update(); return; }
  selectedLink = undefined; beginYearAnimation(yearIndex + 1); animationFrame = requestAnimationFrame(animateYear);
}
function playYears() {
  if (yearAnimation) { stopYearAnimation(); return; }
  if (selected !== 'all') { selected = 'all'; $('#artist').value = 'all'; }
  if (yearIndex >= data.years.length - 1) yearIndex = -1;
  const targetIndex = Math.min(data.years.length - 1, yearIndex + 1);
  const control = $('#play-years'); control.setAttribute('aria-pressed', 'true'); control.textContent = 'Stop'; beginYearAnimation(targetIndex); animationFrame = requestAnimationFrame(animateYear);
}
function setCameraZoom(next, zoomControl) {
  const bounded = Math.max(-.25, Math.min(2.75, next));
  if (Math.abs(bounded - cameraZoom) < .001) return false;
  cameraZoom = bounded;
  constrainPan();
  lodIndex = cameraZoom < 1.05 ? 0 : cameraZoom < 1.9 ? 1 : 2;
  zoomControl.value = lodIndex;
  $('#zoom-value').textContent = zoomLabel(); selectedLink = undefined; update(); return true;
}
function wheelPixels(event) { return event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1); }
function zoomFromWheel(event, zoomControl) {
  // Wheel, two-finger scroll, and browser pinch (Ctrl+wheel) all produce a
  // continuous camera movement. Pinch gets a slightly higher gain.
  event.preventDefault();
  setCameraZoom(cameraZoom - wheelPixels(event) * (event.ctrlKey ? .006 : .003), zoomControl);
}
function beginDrag(event) { if (cameraScale() <= 1) return; dragState = {x: event.clientX, y: event.clientY, panX: cameraPan.x, panY: cameraPan.y, moved: false}; canvas.setPointerCapture(event.pointerId); canvas.classList.add('is-panning'); }
function moveDrag(event) { if (!dragState) return; cameraPan.x = dragState.panX + event.clientX - dragState.x; cameraPan.y = dragState.panY + event.clientY - dragState.y; dragState.moved ||= Math.abs(event.clientX - dragState.x) + Math.abs(event.clientY - dragState.y) > 3; constrainPan(); draw(); }
function endDrag(event) { if (!dragState) return; const moved = dragState.moved; dragState = undefined; canvas.classList.remove('is-panning'); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); if (moved) { ignoreNextClick = true; selectedLink = undefined; } }
async function toggleFullscreen() {
  if (document.fullscreenElement === canvas) await document.exitFullscreen();
  else await canvas.requestFullscreen({navigationUI: 'hide'});
}
function syncFullscreenControl() {
  const active = document.fullscreenElement === canvas, control = $('#fullscreen');
  control.setAttribute('aria-pressed', String(active)); control.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  draw();
}
async function loadTiles() {
  const base = '/public/data/woven-tiles', manifest = await fetch(`${base}/manifest.json`).then((response) => response.json());
  await Promise.all(LOD_KEYS.flatMap((lod, modeIndex) => ['artist', 'work'].map(async (layer) => {
    const info = manifest.layers[`${lod}/${layer}`], text = await fetch(`${base}/${info.artifact}`).then((response) => response.text());
    tiles.set(`${modeIndex}:${layer}`, {...info, cells: text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))});
  })));
}
async function init() { data = await fetch('/public/data/woven-sample.json').then((response) => response.json()); await loadTiles(); prepareLod(); const select = $('#artist'); data.artists.forEach((artist) => { const option = document.createElement('option'); option.value = artist.id; option.textContent = artist.name; select.append(option); }); const year = $('#year'), zoom = $('#zoom'), speed = $('#animation-speed'); year.min = 0; year.max = data.years.length - 1; year.value = yearIndex = data.years.length - 1; zoom.value = lodIndex; setAnimationSpeed(); $('#zoom-value').textContent = zoomLabel(); $('#scope').textContent = `${data.lod.artist_count} artists · ${data.lod.work_count} works`; $('#metrics').textContent = `${data.snapshotId} · ${data.lod.component_count} semantic regions`; year.addEventListener('input', () => { stopYearAnimation(); yearIndex = Number(year.value); selectedLink = undefined; update(); }); select.addEventListener('change', () => { stopYearAnimation(); selected = select.value; selectedLink = undefined; update(); }); $('#play-years').addEventListener('click', playYears); speed.addEventListener('input', setAnimationSpeed); $('#fullscreen').addEventListener('click', toggleFullscreen); document.addEventListener('fullscreenchange', syncFullscreenControl); zoom.addEventListener('input', () => setCameraZoom(Number(zoom.value), zoom)); $('#sound').addEventListener('click', () => { sound = !sound; $('#sound').setAttribute('aria-pressed', sound); $('#sound').textContent = sound ? 'Sound on' : 'Sound off'; }); canvas.addEventListener('click', (event) => { if (ignoreNextClick) { ignoreNextClick = false; return; } details(event); }); canvas.addEventListener('pointerdown', beginDrag); canvas.addEventListener('pointermove', moveDrag); canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('wheel', (event) => zoomFromWheel(event, zoom), {passive: false}); window.addEventListener('resize', draw); update(); }
init();
