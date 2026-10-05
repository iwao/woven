const $ = (s) => document.querySelector(s);
const canvas = $('#fabric'), ctx = canvas.getContext('2d');
const LOD_LABELS = ['Overview', 'Cluster', 'Artist'];
let data, selected = 'all', yearIndex = 0, lodIndex = 1, cameraZoom = 1, cameraPan = {x: 0, y: 0}, dragState, ignoreNextClick = false, sound = false, audio, selectedLink;

function visibleArtists() { return selected === 'all' ? data.artists : data.artists.filter((a) => a.id === selected); }
function rawLinks() { const links = new Map(), until = data.years[yearIndex]; for (const artist of visibleArtists()) for (const row of artist.series) { if (row.year > until) continue; for (const [work, value] of row.works) { const key = `${artist.id}:${work}`, old = links.get(key); links.set(key, {artist, work, weight: (old?.weight || 0) + value}); } } return [...links.values()]; }
function workLinks(modeIndex = lodIndex) { const links = new Map(), positions = data._lodModes[modeIndex].positions; for (const link of rawLinks()) { const source = positions.get(link.artist.id); if (source === undefined) continue; const key = `${source}:${link.work}`, old = links.get(key); links.set(key, {source, target: link.work, weight: (old?.weight || 0) + link.weight}); } return [...links.values()]; }
function artistLinks(modeIndex = lodIndex) { const links = new Map(), positions = data._lodModes[modeIndex].positions, until = data.years[yearIndex]; for (const relation of data.artistRelations) { if (relation.firstYear === null || relation.firstYear > until) continue; for (const [from, target] of [[relation.source, relation.target], [relation.target, relation.source]]) { if (selected !== 'all' && from !== selected) continue; const source = positions.get(from); if (source === undefined) continue; const key = `${source}:${target}`, old = links.get(key); links.set(key, {source, target, weight: (old?.weight || 0) + relation.weight, sharedWorks: (old?.sharedWorks || 0) + relation.sharedWorks}); } } return [...links.values()]; }

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
function cross(x, y, weight, max, selected) { const intensity = Math.log1p(weight) / Math.log1p(max); ctx.beginPath(); ctx.arc(x, y, selected ? 3.3 : Math.min(2.1, .55 + Math.sqrt(weight) * .22), 0, Math.PI * 2); ctx.fillStyle = selected ? '#fff0ae' : `rgba(${Math.round(190 + intensity * 51)},${Math.round(135 + intensity * 86)},${Math.round(45 + intensity * 75)},${.035 + intensity * .55})`; ctx.fill(); }
function lodLayers() {
  // Keep one stable level between transition bands, then cross-fade the
  // adjacent semantic trees while the camera passes a threshold.
  if (cameraZoom < .55) return [{index: 0, opacity: 1}];
  if (cameraZoom < .8) { const mix = (cameraZoom - .55) / .25; return [{index: 0, opacity: 1 - mix}, {index: 1, opacity: mix}]; }
  if (cameraZoom < 1.3) return [{index: 1, opacity: 1}];
  if (cameraZoom < 1.55) { const mix = (cameraZoom - 1.3) / .25; return [{index: 1, opacity: 1 - mix}, {index: 2, opacity: mix}]; }
  return [{index: 2, opacity: 1}];
}
function zoomLabel() { const layers = lodLayers(); return layers.length === 1 ? LOD_LABELS[layers[0].index] : `${LOD_LABELS[layers[0].index]} → ${LOD_LABELS[layers[1].index]}`; }
function cameraScale() { return Math.max(1, 2 ** (cameraZoom - 1)); }
function constrainPan(width = canvas.clientWidth, height = canvas.clientHeight) {
  const scale = cameraScale();
  const maxX = Math.max(0, (scale - 1) * width / 2), maxY = Math.max(0, (scale - 1) * height / 2);
  cameraPan.x = Math.max(-maxX, Math.min(maxX, cameraPan.x));
  cameraPan.y = Math.max(-maxY, Math.min(maxY, cameraPan.y));
}
function drawLodLayer(modeIndex, opacity, width, height, maxWeight) {
  const nodes = data._lodModes[modeIndex].nodes, layout = geometry(width, height, nodes.length), artists = artistLinks(modeIndex), works = workLinks(modeIndex);
  ctx.globalAlpha = opacity; ctx.strokeStyle = 'rgba(202,166,91,.09)';
  for (let i = 0; i < nodes.length; i++) { ctx.beginPath(); ctx.moveTo(layout.x(i), 61); ctx.lineTo(layout.x(i), layout.workBottom); ctx.stroke(); }
  for (const link of artists) { const target = data._artistsById.get(link.target); if (target) cross(layout.x(link.source), layout.artistY(target.position), link.weight, maxWeight, selectedLink === `a:${modeIndex}:${link.source}:${link.target}`); }
  for (const link of works) { const target = data._worksById.get(link.target); if (target) cross(layout.x(link.source), layout.workY(target.index), link.weight, maxWeight, selectedLink === `w:${modeIndex}:${link.source}:${link.target}`); }
  nodes.forEach((node, i) => { ctx.beginPath(); ctx.arc(layout.x(i), 54, 2.2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(241,206,120,.72)'; ctx.fill(); });
  return layout;
}
function draw() {
  const rect = canvas.getBoundingClientRect(), scale = devicePixelRatio; canvas.width = rect.width * scale; canvas.height = rect.height * scale; ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const layers = lodLayers(), allLinks = layers.flatMap(({index}) => [...artistLinks(index), ...workLinks(index)]), max = Math.max(1, ...allLinks.map((link) => link.weight));
  const referenceLayout = geometry(rect.width, rect.height, data._lodModes[lodIndex].nodes.length), viewScale = cameraScale();
  ctx.fillStyle = '#10120f'; ctx.fillRect(0, 0, rect.width, rect.height); ctx.fillStyle = 'rgba(216,169,74,.05)'; ctx.fillRect(0, 25, rect.width, 57); ctx.strokeStyle = 'rgba(216,169,74,.25)'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(0, 88); ctx.lineTo(rect.width, 88); ctx.moveTo(0, referenceLayout.workTop - 20); ctx.lineTo(rect.width, referenceLayout.workTop - 20); ctx.stroke(); ctx.setLineDash([]);
  constrainPan(rect.width, rect.height); ctx.save(); ctx.translate(rect.width / 2 + cameraPan.x, rect.height / 2 + cameraPan.y); ctx.scale(viewScale, viewScale); ctx.translate(-rect.width / 2, -rect.height / 2); layers.forEach(({index, opacity}) => drawLodLayer(index, opacity, rect.width, rect.height, max)); ctx.restore(); ctx.globalAlpha = 1;
  ctx.fillStyle = '#a8a192'; ctx.font = '10px DM Mono'; ctx.fillText(`X AXIS — ${zoomLabel().toUpperCase()} ARTIST RESOLUTION`, 16, 18); ctx.fillText('Y LAYER 01 — RELATED ARTISTS (INDIVIDUAL ENTITIES)', 16, referenceLayout.artistTop - 9); ctx.fillText('Y LAYER 02 — WORKS (INDIVIDUAL ENTITIES)', 16, referenceLayout.workTop - 9); ctx.fillText(`${allLinks.length.toLocaleString()} active crosses · ${viewScale.toFixed(2)}×`, rect.width - 210, 18);
}
function details(event) {
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
function setCameraZoom(next, zoomControl) {
  const bounded = Math.max(-.25, Math.min(2.25, next));
  if (Math.abs(bounded - cameraZoom) < .001) return false;
  cameraZoom = bounded;
  constrainPan();
  lodIndex = cameraZoom < .675 ? 0 : cameraZoom < 1.425 ? 1 : 2;
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
async function init() { data = await fetch('/public/data/woven-sample.json').then((response) => response.json()); prepareLod(); const select = $('#artist'); data.artists.forEach((artist) => { const option = document.createElement('option'); option.value = artist.id; option.textContent = artist.name; select.append(option); }); const year = $('#year'), zoom = $('#zoom'); year.min = 0; year.max = data.years.length - 1; year.value = yearIndex = data.years.length - 1; zoom.value = lodIndex; $('#zoom-value').textContent = zoomLabel(); $('#scope').textContent = `${data.lod.artist_count} artists · ${data.lod.work_count} works`; $('#metrics').textContent = `${data.snapshotId} · ${data.lod.component_count} semantic regions`; year.addEventListener('input', () => { yearIndex = Number(year.value); selectedLink = undefined; update(); }); select.addEventListener('change', () => { selected = select.value; selectedLink = undefined; update(); }); zoom.addEventListener('input', () => setCameraZoom(Number(zoom.value), zoom)); $('#sound').addEventListener('click', () => { sound = !sound; $('#sound').setAttribute('aria-pressed', sound); $('#sound').textContent = sound ? 'Sound on' : 'Sound off'; }); canvas.addEventListener('click', (event) => { if (ignoreNextClick) { ignoreNextClick = false; return; } details(event); }); canvas.addEventListener('pointerdown', beginDrag); canvas.addEventListener('pointermove', moveDrag); canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('wheel', (event) => zoomFromWheel(event, zoom), {passive: false}); window.addEventListener('resize', draw); update(); }
init();
