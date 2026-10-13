const DATA_PREFIX = '/public/data/';
const isBrotliData = (key) => key === 'woven-sample.json' || key.endsWith('.bin');
const OGP_RENDER_VERSION = '4';
let artworkCatalogue;

function contentType(path) {
  if (path.endsWith('.bin')) return 'application/octet-stream';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function getArtworkCatalogue(env, origin) {
  if (!artworkCatalogue) {
    artworkCatalogue = env.ASSETS.fetch(`${origin}/public/data/artworks/catalog.json`)
      .then((response) => response.ok ? response.json() : {artists: []})
      .catch(() => ({artists: []}));
  }
  return artworkCatalogue;
}

function artworkRequest(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'artists' || !/^\d{1,4}$/.test(parts[2])) return;
  return {slug: decodeURIComponent(parts[1]), year: Number(parts[2])};
}

function ogpImageRequest(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'og' || parts[1] !== 'artists' || !/^\d{1,4}\.png$/.test(parts[3])) return;
  return {slug: decodeURIComponent(parts[2]), year: Number(parts[3].slice(0, -4))};
}

function isSiteOgpRequest(pathname) {
  return pathname === '/og/woven.png';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

function rewriteArtworkHead(response, entry, year, origin, snapshotId) {
  const artist = entry.displayName || entry.name;
  const title = `WOVEN — ${artist} · ${year}`;
  const description = `${artist} · ${year}, a WOVEN artist relation temporal field from the Classii cultural graph.`;
  const canonical = `${origin}/artists/${encodeURIComponent(entry.slug)}/${year}`;
  // One lossless, data-derived card per Artist is intentionally reused across
  // year variants, keeping social-preview assets bounded to the public set.
  const image = `${origin}/og/artists/${encodeURIComponent(entry.slug)}/${year}.png?v=${encodeURIComponent(snapshotId || '1')}&r=${OGP_RENDER_VERSION}`;
  const injected = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
  ].join('');
  const rewriter = new HTMLRewriter()
    .on('title', {element(element) { element.setInnerContent(title); }})
    .on('meta[name="description"]', {element(element) { element.setAttribute('content', description); }})
    .on('meta[property="og:title"]', {element(element) { element.setAttribute('content', title); }})
    .on('meta[property="og:description"]', {element(element) { element.setAttribute('content', description); }})
    .on('meta[property="og:url"]', {element(element) { element.setAttribute('content', canonical); }})
    .on('meta[property="og:image"]', {element(element) { element.setAttribute('content', image); }})
    .on('meta[name="twitter:title"]', {element(element) { element.setAttribute('content', title); }})
    .on('meta[name="twitter:description"]', {element(element) { element.setAttribute('content', description); }})
    .on('meta[name="twitter:image"]', {element(element) { element.setAttribute('content', image); }})
    .on('head', {element(element) { element.append(injected, {html: true}); }});
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=86400');
  return new Response(rewriter.transform(response).body, {status: response.status, statusText: response.statusText, headers});
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const label = new TextEncoder().encode(type), chunk = new Uint8Array(12 + data.length), view = new DataView(chunk.buffer);
  view.setUint32(0, data.length); chunk.set(label, 4); chunk.set(data, 8); view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function blendPixel(pixels, width, height, x, y, color, opacity) {
  if (x < 0 || x >= width || y < 0 || y >= height || opacity <= 0) return;
  const offset = (y * width + x) * 4, inverse = 1 - opacity;
  pixels[offset] = Math.round(pixels[offset] * inverse + color[0] * opacity);
  pixels[offset + 1] = Math.round(pixels[offset + 1] * inverse + color[1] * opacity);
  pixels[offset + 2] = Math.round(pixels[offset + 2] * inverse + color[2] * opacity);
}

function drawCircle(pixels, width, height, centerX, centerY, radius, color, opacity) {
  const startX = Math.max(0, Math.floor(centerX - radius)), endX = Math.min(width - 1, Math.ceil(centerX + radius));
  const startY = Math.max(0, Math.floor(centerY - radius)), endY = Math.min(height - 1, Math.ceil(centerY + radius)), squared = radius * radius;
  for (let y = startY; y <= endY; y += 1) for (let x = startX; x <= endX; x += 1) {
    const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
    if (distance <= squared) blendPixel(pixels, width, height, x, y, color, opacity * (1 - distance / squared) ** .45);
  }
}

async function pngFromPixels(width, height, pixels) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  const chunks = [PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())];
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0), output = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function siteOgpPng() {
  const width = 1200, height = 630, pixels = new Uint8Array(width * height * 4), vector = [226, 213, 197], glow = [249, 152, 72], highlight = [242, 238, 130];
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  for (let column = 0; column < 220; column += 1) {
    const x = 46 + column * 5, top = 96 + (column * 17 % 64), lower = 355 + (column * 29 % 55), strength = .12 + (column * 13 % 34) / 100;
    for (let y = top; y < 270 + (column * 11 % 100); y += 2) blendPixel(pixels, width, height, x, y, vector, strength);
    for (let y = lower; y < 585 - (column * 7 % 80); y += 2) blendPixel(pixels, width, height, x, y, vector, strength * .7);
  }
  for (const [x, y, radius] of [[282, 152, 14], [282, 416, 16], [690, 214, 10], [910, 454, 8]]) {
    drawCircle(pixels, width, height, x, y, radius + 14, glow, .14);
    drawCircle(pixels, width, height, x, y, radius, highlight, .6);
  }
  return pngFromPixels(width, height, pixels);
}

async function dynamicOgpImage(request, env, ctx, imageRequest, origin) {
  const cached = await caches.default.match(request);
  if (cached) return cached;
  if (!env.BROWSER) return new Response('Artwork preview unavailable', {status: 503});
  const page = new URL(`/artists/${encodeURIComponent(imageRequest.slug)}/${imageRequest.year}`, origin);
  page.searchParams.set('ogp', '1');
  const screenshot = await env.BROWSER.quickAction('screenshot', {
    url: page.href,
    viewport: {width: 1200, height: 630, deviceScaleFactor: 1},
    waitForSelector: {selector: 'html[data-woven-ready="true"]', timeout: 60000},
    gotoOptions: {waitUntil: 'networkidle2', timeout: 60000},
    addStyleTag: [{content: `
      html,body,main { width:1200px!important; height:630px!important; min-height:0!important; margin:0!important; padding:0!important; overflow:hidden!important; background:#000!important; }
      .loading-screen,.global-header,.control-drawer,.canvas-player,.canvas-year,.canvas-caption,.artwork-plate,footer { display:none!important; }
      .fabric-stage,.fabric-wrap { width:1200px!important; height:630px!important; margin:0!important; padding:0!important; }
      #fabric { display:block!important; width:1200px!important; height:630px!important; margin:0!important; }
    `}],
    selector: '#fabric',
  });
  if (!screenshot.ok) return screenshot;
  const response = new Response(screenshot.body, {status: screenshot.status, headers: {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable'}});
  ctx.waitUntil(caches.default.put(request, response.clone()));
  return response;
}

async function dynamicSiteOgpImage(request, ctx) {
  const cached = await caches.default.match(request);
  if (cached) return cached;
  const response = new Response(await siteOgpPng(), {headers: {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable'}});
  ctx.waitUntil(caches.default.put(request, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith(DATA_PREFIX) && !url.pathname.startsWith('/public/data/artworks/')) {
      const key = url.pathname.slice(DATA_PREFIX.length);
      const object = await env.WOVEN_DATA.get(key);
      if (object) {
        const headers = {
          'Content-Type': object.httpMetadata?.contentType || contentType(key),
          'ETag': object.httpEtag,
          'Vary': 'Accept-Encoding',
          // Snapshot-addressed files are immutable; query strings are kept by
          // the client as an extra dataset-version guard.
          'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
        };
        // R2's binding does not currently surface stored content-encoding in
        // httpMetadata. The runtime ledger is deliberately stored as Brotli.
        const isCompressed = isBrotliData(key);
        if (isCompressed) headers['Content-Encoding'] = 'br';
        else if (object.httpMetadata?.contentEncoding) headers['Content-Encoding'] = object.httpMetadata.contentEncoding;
        const response = new Response(object.body, {
          headers,
          // Do not let Cloudflare re-compress a body that was compressed at
          // build time. Without this, a Brotli payload is encoded twice.
          encodeBody: isCompressed ? 'manual' : 'automatic',
        });
        return response;
      }
    }
    const imageRequest = ogpImageRequest(url.pathname);
    if (request.method === 'GET' && imageRequest) return dynamicOgpImage(request, env, ctx, imageRequest, url.origin);
    if (request.method === 'GET' && isSiteOgpRequest(url.pathname)) return dynamicSiteOgpImage(request, ctx);
    const asset = await env.ASSETS.fetch(request);
    // Static Assets redirects unknown extensionless paths to `/`. Treat that
    // redirect exactly like a miss so artist routes receive the SPA shell.
    if ((asset.status >= 200 && asset.status < 300) || url.pathname.includes('.')) return asset;
    // Static Assets canonicalises /index.html to /. Fetch that canonical shell
    // internally while retaining the visitor's /artists/... URL in the browser.
    const shell = await env.ASSETS.fetch(new Request(new URL('/', url), {method: 'GET', headers: request.headers}));
    const artwork = artworkRequest(url.pathname);
    if (!artwork || !shell.ok) return shell;
    const catalogue = await getArtworkCatalogue(env, url.origin);
    const entry = catalogue.artists?.find((candidate) => candidate.slug === artwork.slug);
    return entry ? rewriteArtworkHead(shell, entry, artwork.year, url.origin, catalogue.snapshotId) : shell;
  },
};
