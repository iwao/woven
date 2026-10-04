const $ = (selector) => document.querySelector(selector);
const canvas = $('#fabric');
const ctx = canvas.getContext('2d');
const LOD_LABELS = ['Overview', 'Cluster', 'Work'];
let data, selected = 'all', yearIndex = 0, lodIndex = 1, sound = false, audio, selectedLink;

function visibleArtists() { return selected === 'all' ? data.artists : data.artists.filter((artist) => artist.id === selected); }

function rawWorkLinksUntil() {
  const until = data.years[yearIndex]; const links = new Map();
  for (const artist of visibleArtists()) for (const row of artist.series) {
    if (row.year > until) continue;
    for (const [position, value] of row.works) {
      const key = `${artist.id}:${position}`;
      links.set(key, { artist, position, weight: (links.get(key)?.weight || 0) + value });
    }
  }
  return [...links.values()];
}

function workNodes() { return data._lodModes[lodIndex].nodes; }

function workLinksUntil() {
  const grouped = new Map(); const positions = data._lodModes[lodIndex].positions;
  for (const link of rawWorkLinksUntil()) {
    const nodeIndex = positions.get(link.position); if (nodeIndex === undefined) continue;
    const key = `${link.artist.id}:${nodeIndex}`;
    grouped.set(key, { artist: link.artist, nodeIndex, weight: (grouped.get(key)?.weight || 0) + link.weight });
  }
  return [...grouped.values()];
}

function artistLinksUntil() {
  const until = data.years[yearIndex]; const links = [];
  for (const relation of data.artistRelations) {
    if (relation.firstYear === null || relation.firstYear > until) continue;
    if (selected === 'all' || relation.source === selected) links.push({ ...relation, source: relation.source, target: relation.target });
    if (selected === 'all' || relation.target === selected) links.push({ ...relation, source: relation.target, target: relation.source });
  }
  return links;
}

function prepareLod() {
  const byId = new Map(data.lod.tree.map((node) => [node.id, node]));
  const positionByWork = new Map(data.works.map((work) => [work.id, work.position]));
  const leafIdByWork = new Map(data.lod.tree.filter((node) => node.work).map((node) => [node.work, node.id]));
  const minPosition = new Map();
  const orderNode = (id) => {
    if (minPosition.has(id)) return minPosition.get(id);
    const node = byId.get(id);
    const position = node.work ? positionByWork.get(node.work) : Math.min(...node.children.map(orderNode));
    minPosition.set(id, position); return position;
  };
  const root = byId.get(data.lod.root_node_id);
  const overview = [...root.children].sort((left, right) => orderNode(left) - orderNode(right));
  const cluster = [...overview];
  while (cluster.length < 240) {
    const candidates = cluster.filter((id) => byId.get(id).children.length);
    if (!candidates.length) break;
    const largest = candidates.sort((left, right) => byId.get(right).leaves - byId.get(left).leaves || orderNode(left) - orderNode(right))[0];
    cluster.splice(cluster.indexOf(largest), 1, ...byId.get(largest).children);
  }
  cluster.sort((left, right) => orderNode(left) - orderNode(right));
  const detail = [...data.works].sort((left, right) => left.position - right.position).map((work) => leafIdByWork.get(work.id));
  const nodeSets = [overview, cluster, detail];
  data._lodModes = nodeSets.map((ids) => {
    const nodes = ids.map((id) => byId.get(id)); const positions = new Map();
    const indexById = new Map(ids.map((id, index) => [id, index]));
    const assignLeaves = (id, index) => {
      const node = byId.get(id);
      if (node.work) positions.set(positionByWork.get(node.work), index);
      else node.children.forEach((child) => assignLeaves(child, index));
    };
    ids.forEach(assignLeaves);
    return { nodes, positions, indexById };
  });
  data._workById = new Map(data.works.map((work) => [work.id, work]));
}

function katan(amount) {
  if (!sound) return;
  audio ||= new AudioContext(); const now = audio.currentTime;
  const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(70 + Math.min(180, amount * 8), now);
  gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(.12, now + .006); gain.gain.exponentialRampToValueAtTime(.0001, now + .13);
  oscillator.connect(gain).connect(audio.destination); oscillator.start(now); oscillator.stop(now + .14);
}

function drawCross(x, y, weight, maxWeight, chosen, selectedArtist) {
  const intensity = Math.log1p(weight) / Math.log1p(maxWeight);
  const alpha = selectedArtist ? .33 + intensity * .61 : .035 + intensity * .38;
  const radius = chosen ? 3.3 : Math.min(2.1, .55 + Math.sqrt(weight) * .22);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = chosen ? '#fff0ae' : `rgba(${Math.round(190 + intensity * 51)},${Math.round(135 + intensity * 86)},${Math.round(45 + intensity * 75)},${alpha})`; ctx.fill();
}

function geometry(width, height, nodeCount) {
  const artistLayerTop = 116; const artistLayerBottom = Math.max(178, height * .29); const workTop = artistLayerBottom + 38; const workBottom = height - 30;
  return {
    artistX: (index) => 20 + (width - 40) * (index / Math.max(1, data.artists.length - 1)),
    relatedArtistY: (index) => artistLayerTop + (artistLayerBottom - artistLayerTop) * (index / Math.max(1, data.artists.length - 1)),
    workY: (index) => workTop + (workBottom - workTop) * (index / Math.max(1, nodeCount - 1)),
    artistLayerTop, artistLayerBottom, workTop, workBottom,
  };
}

function draw() {
  const rect = canvas.getBoundingClientRect(); const scale = devicePixelRatio;
  canvas.width = rect.width * scale; canvas.height = rect.height * scale; ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const { width: w, height: h } = rect; const sourceArtistY = 54; const nodes = workNodes(); const layout = geometry(w, h, nodes.length);
  const workLinks = workLinksUntil(); const artistLinks = artistLinksUntil(); const allWeights = [...workLinks, ...artistLinks].map((link) => link.weight);
  const maxWeight = Math.max(1, ...allWeights); const totalWeight = [...workLinks, ...artistLinks].reduce((sum, link) => sum + link.weight, 0);
  const selectedArtist = selected !== 'all'; const artistWeight = new Map(); const artistIndex = new Map(data.artists.map((artist, index) => [artist.id, index]));
  for (const link of workLinks) artistWeight.set(link.artist.id, (artistWeight.get(link.artist.id) || 0) + link.weight);
  const maxArtistWeight = Math.max(1, ...artistWeight.values());

  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#10120f'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = 'rgba(216,169,74,.05)'; ctx.fillRect(0, 25, w, 57); ctx.fillStyle = 'rgba(186,143,61,.045)'; ctx.fillRect(0, 89, w, h - 89);
  ctx.strokeStyle = 'rgba(216,169,74,.25)'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(0, 88); ctx.lineTo(w, 88); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, layout.workTop - 20); ctx.lineTo(w, layout.workTop - 20); ctx.stroke(); ctx.setLineDash([]);
  ctx.lineWidth = .5; ctx.strokeStyle = 'rgba(202,166,91,.09)';
  for (let index = 0; index < data.artists.length; index += 1) { const x = layout.artistX(index); ctx.beginPath(); ctx.moveTo(x, sourceArtistY + 7); ctx.lineTo(x, layout.workBottom); ctx.stroke(); }
  const drawWeft = (count, yForIndex, top, bottom) => { const alpha = Math.min(.08, .12 / Math.max(1, count / Math.max(1, bottom - top))); ctx.strokeStyle = `rgba(202,166,91,${alpha})`; for (let index = 0; index < count; index += 1) { ctx.beginPath(); ctx.moveTo(0, yForIndex(index)); ctx.lineTo(w, yForIndex(index)); ctx.stroke(); } };
  drawWeft(data.artists.length, layout.relatedArtistY, layout.artistLayerTop, layout.artistLayerBottom); drawWeft(nodes.length, layout.workY, layout.workTop, layout.workBottom);
  for (const link of artistLinks) drawCross(layout.artistX(artistIndex.get(link.source)), layout.relatedArtistY(artistIndex.get(link.target)), link.weight, maxWeight, selectedLink?.type === 'artist' && selectedLink.source === link.source && selectedLink.target === link.target, selectedArtist);
  for (const link of workLinks) drawCross(layout.artistX(artistIndex.get(link.artist.id)), layout.workY(link.nodeIndex), link.weight, maxWeight, selectedLink?.type === 'work' && selectedLink.artistId === link.artist.id && selectedLink.nodeIndex === link.nodeIndex, selectedArtist);
  data.artists.forEach((artist, index) => { const intensity = Math.log1p(artistWeight.get(artist.id) || 0) / Math.log1p(maxArtistWeight); ctx.beginPath(); ctx.arc(layout.artistX(index), sourceArtistY, selected === 'all' || selected === artist.id ? 2.2 : 1.2, 0, Math.PI * 2); ctx.fillStyle = selected === 'all' || selected === artist.id ? `rgba(241,206,120,${.28 + intensity * .72})` : 'rgba(168,161,146,.42)'; ctx.fill(); });
  ctx.fillStyle = '#a8a192'; ctx.font = '10px DM Mono'; ctx.fillText('X AXIS — SOURCE ARTISTS', 16, 18); ctx.fillText('Y LAYER 01 — RELATED ARTISTS (WORK-MEDIATED)', 16, layout.artistLayerTop - 9); ctx.fillText(`Y LAYER 02 — ${LOD_LABELS[lodIndex].toUpperCase()} WORK RESOLUTION`, 16, layout.workTop - 9); ctx.fillText(`${(workLinks.length + artistLinks.length).toLocaleString()} active crosses · ${totalWeight.toFixed(0)} weight`, w - 265, 18); ctx.fillText(String(data.artists.length), 3, layout.artistLayerBottom + 4); ctx.fillText(String(nodes.length), 3, layout.workBottom + 4);
}

function detailFromPoint(event) {
  const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; const nodes = workNodes(); const layout = geometry(rect.width, rect.height, nodes.length);
  const artistIndex = Math.round((x - 20) / (rect.width - 40) * (data.artists.length - 1)); const source = data.artists[Math.max(0, Math.min(data.artists.length - 1, artistIndex))];
  if (y >= layout.artistLayerTop && y <= layout.artistLayerBottom) {
    const targetIndex = Math.round((y - layout.artistLayerTop) / (layout.artistLayerBottom - layout.artistLayerTop) * (data.artists.length - 1)); const target = data.artists[Math.max(0, Math.min(data.artists.length - 1, targetIndex))]; const link = artistLinksUntil().find((entry) => entry.source === source.id && entry.target === target.id); if (!link) return;
    selectedLink = { type: 'artist', source: source.id, target: target.id }; $('#detail').innerHTML = `<p class="detail-kicker">WORK-MEDIATED ARTIST CO-OCCURRENCE</p><h2>${source.name} ↔ ${target.name}</h2><p>Shared Works: ${link.sharedWorks}. Relation weight through ${data.years[yearIndex]}: ${link.weight.toFixed(2)}.</p>`;
  } else if (y >= layout.workTop && y <= layout.workBottom) {
    const nodeIndex = Math.round((y - layout.workTop) / (layout.workBottom - layout.workTop) * (nodes.length - 1)); const node = nodes[Math.max(0, Math.min(nodes.length - 1, nodeIndex))]; const link = workLinksUntil().find((entry) => entry.artist.id === source.id && entry.nodeIndex === nodeIndex); if (!link) return;
    selectedLink = { type: 'work', artistId: source.id, nodeIndex }; const names = node.dominantWorks.map((id) => data._workById.get(id)?.name || id).slice(0, 3).join(' · '); const heading = node.work ? data._workById.get(node.work)?.name : `${node.leaves} Works`; $('#detail').innerHTML = `<p class="detail-kicker">${LOD_LABELS[lodIndex].toUpperCase()} WORK RESOLUTION</p><h2>${source.name} → ${heading}</h2><p>Relation weight through ${data.years[yearIndex]}: ${link.weight.toFixed(2)}. ${node.work ? '' : `Representative Works: ${names}.`}</p>`;
  } else return;
  draw();
}

function update() { const year = data.years[yearIndex]; $('#year-value').value = year; $('#year-value').textContent = year; const current = visibleArtists().flatMap((artist) => artist.series).find((row) => row.year === year); katan(current?.delta || 0); draw(); }

async function init() {
  data = await fetch('/public/data/woven-sample.json').then((response) => response.json()); prepareLod();
  const select = $('#artist'); for (const artist of data.artists) { const option = document.createElement('option'); option.value = artist.id; option.textContent = artist.name; select.append(option); }
  const slider = $('#year'); slider.min = 0; slider.max = data.years.length - 1; slider.value = yearIndex = data.years.length - 1;
  const zoom = $('#zoom'); zoom.value = lodIndex; $('#zoom-value').textContent = LOD_LABELS[lodIndex];
  $('#scope').textContent = `${data.lod.artist_count} artists · ${data.lod.work_count} works`; $('#metrics').textContent = `${data.snapshotId} · ${data.lod.component_count} semantic regions`;
  slider.addEventListener('input', () => { yearIndex = Number(slider.value); selectedLink = undefined; update(); }); select.addEventListener('change', () => { selected = select.value; selectedLink = undefined; update(); });
  zoom.addEventListener('input', () => { lodIndex = Number(zoom.value); $('#zoom-value').textContent = LOD_LABELS[lodIndex]; selectedLink = undefined; update(); });
  $('#sound').addEventListener('click', () => { sound = !sound; $('#sound').setAttribute('aria-pressed', sound); $('#sound').textContent = sound ? 'Sound on' : 'Sound off'; if (sound) katan(1); });
  canvas.addEventListener('click', detailFromPoint); canvas.addEventListener('wheel', (event) => { event.preventDefault(); const next = Math.max(0, Math.min(2, lodIndex + (event.deltaY > 0 ? -1 : 1))); if (next !== lodIndex) { lodIndex = next; zoom.value = next; $('#zoom-value').textContent = LOD_LABELS[next]; selectedLink = undefined; update(); } }, { passive: false }); window.addEventListener('resize', draw); update();
}

init();
