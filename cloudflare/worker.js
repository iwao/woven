const DATA_PREFIX = '/public/data/';
const isBrotliData = (key) => key.startsWith('woven-runtime/') || key.endsWith('.bin');
const OGP_RENDER_VERSION = '5';
let artworkCatalogue;

// The only inline script is the audited GTM bootstrap snippet in index.html
// and about/index.html.  Keeping it hash-pinned prevents injected inline
// scripts while preserving the intentionally installed container.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'sha256-/uUWyaFvLb2LiUAoDjiKeh8uLBT5j7TE33+9LzYjJ04=' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://www.googletagmanager.com https://www.google-analytics.com",
  "media-src 'self' blob:",
  "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://region1.google-analytics.com",
  "frame-src https://www.googletagmanager.com",
  "worker-src 'self' blob:",
  'upgrade-insecure-requests',
].join('; ');

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    // Preserve manually Brotli-compressed R2 bodies as-is.
    encodeBody: headers.has('Content-Encoding') ? 'manual' : 'automatic',
  });
}

function decodePathComponent(value) {
  try { return decodeURIComponent(value); }
  catch { return undefined; }
}

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
  const slug = decodePathComponent(parts[1]);
  if (!slug) return;
  return {slug, year: Number(parts[2])};
}

function ogpImageRequest(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'og' || parts[1] !== 'artists' || !/^\d{1,4}\.png$/.test(parts[3])) return;
  const slug = decodePathComponent(parts[2]);
  if (!slug) return;
  return {slug, year: Number(parts[3].slice(0, -4))};
}

function isSiteOgpRequest(pathname) {
  return pathname === '/og/woven.png';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

function artworkOgpUrl(entry, year, origin, snapshotId) {
  return `${origin}/og/artists/${encodeURIComponent(entry.slug)}/${year}.png?v=${encodeURIComponent(snapshotId || '1')}&r=${OGP_RENDER_VERSION}`;
}

function artworkYearIsAvailable(entry, year) {
  return Number.isInteger(year) && year >= entry.firstYear && year <= entry.lastYear;
}

function ogpCacheRequest(entry, year, origin, snapshotId) {
  // Never include visitor-controlled query parameters in the cache key.  The
  // snapshot and renderer revision are the only inputs that may invalidate a
  // generated image.
  return new Request(artworkOgpUrl(entry, year, origin, snapshotId));
}

function rewriteArtworkHead(response, entry, year, origin, image) {
  const artist = entry.displayName || entry.name;
  const title = `WOVEN — ${artist} · ${year}`;
  const description = `${artist} · ${year}, a WOVEN artist relation temporal field from the Classii cultural graph.`;
  const canonical = `${origin}/artists/${encodeURIComponent(entry.slug)}/${year}`;
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
  // The OGP image may become available just after the first request. Do not
  // pin the fallback HTML at the edge, so a later crawler retry sees it.
  headers.set('Cache-Control', 'no-store');
  return secureResponse(new Response(rewriter.transform(response).body, {status: response.status, statusText: response.statusText, headers}));
}

async function dynamicOgpImage(request, env, ctx, imageRequest, origin) {
  const cached = await caches.default.match(request);
  if (cached) return secureResponse(cached);
  if (!env.BROWSER) return secureResponse(new Response('Artwork preview unavailable', {status: 503}));
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
  if (!screenshot.ok) return secureResponse(screenshot);
  const response = new Response(screenshot.body, {status: screenshot.status, headers: {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable'}});
  ctx.waitUntil(caches.default.put(request, response.clone()));
  return secureResponse(response);
}

async function dynamicSiteOgpImage(request, env, ctx) {
  const cached = await caches.default.match(request);
  if (cached) return secureResponse(cached);
  const image = await env.WOVEN_DATA.get('og/woven-r3.png');
  if (!image) return secureResponse(new Response('Site preview unavailable', {status: 503}));
  const response = new Response(image.body, {headers: {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable'}});
  ctx.waitUntil(caches.default.put(request, response.clone()));
  return secureResponse(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isGetOrHead = request.method === 'GET' || request.method === 'HEAD';
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
        return secureResponse(response);
      }
    }
    const imageRequest = ogpImageRequest(url.pathname);
    // Social scrapers commonly issue HEAD before GET. Render/cache using an
    // equivalent GET request, then return the same image headers without a
    // body for HEAD so either probe is a successful image response.
    if (isGetOrHead && imageRequest) {
      const catalogue = await getArtworkCatalogue(env, url.origin);
      const entry = catalogue.artists?.find((candidate) => candidate.slug === imageRequest.slug);
      // Rendering is a paid Browser operation.  Only issue it for a published
      // artist and a year represented by that artist's artwork range.
      if (!entry || !artworkYearIsAvailable(entry, imageRequest.year)) return secureResponse(new Response('Artwork preview not found', {status: 404}));
      const imageFetch = ogpCacheRequest(entry, imageRequest.year, url.origin, catalogue.snapshotId);
      const response = await dynamicOgpImage(imageFetch, env, ctx, {slug: entry.slug, year: imageRequest.year}, url.origin);
      return request.method === 'HEAD' ? secureResponse(new Response(null, {status: response.status, headers: response.headers})) : response;
    }
    if (isGetOrHead && isSiteOgpRequest(url.pathname)) {
      const imageFetch = request.method === 'GET' ? request : new Request(request.url, {headers: request.headers});
      const response = await dynamicSiteOgpImage(imageFetch, env, ctx);
      return request.method === 'HEAD' ? secureResponse(new Response(null, {status: response.status, headers: response.headers})) : response;
    }
    const asset = await env.ASSETS.fetch(request);
    // Static Assets redirects unknown extensionless paths to `/`. Treat that
    // redirect exactly like a miss so artist routes receive the SPA shell.
    if ((asset.status >= 200 && asset.status < 300) || url.pathname.includes('.')) return secureResponse(asset);
    // Static Assets canonicalises /index.html to /. Fetch that canonical shell
    // internally while retaining the visitor's /artists/... URL in the browser.
    const shell = await env.ASSETS.fetch(new Request(new URL('/', url), {method: 'GET', headers: request.headers}));
    const artwork = artworkRequest(url.pathname);
    if (!artwork || !shell.ok) return secureResponse(shell);
    const catalogue = await getArtworkCatalogue(env, url.origin);
    const entry = catalogue.artists?.find((candidate) => candidate.slug === artwork.slug);
    if (!entry || !artworkYearIsAvailable(entry, artwork.year)) return secureResponse(shell);
    const image = artworkOgpUrl(entry, artwork.year, url.origin, catalogue.snapshotId);
    const imageFetch = ogpCacheRequest(entry, artwork.year, url.origin, catalogue.snapshotId);
    const cachedImage = await caches.default.match(imageFetch);
    // Return a reliable card immediately on a first view, while the exact
    // canvas preview is rendered in the background for the next request.
    if (!cachedImage && !url.searchParams.has('ogp')) {
      ctx.waitUntil(dynamicOgpImage(imageFetch, env, ctx, {slug: entry.slug, year: artwork.year}, url.origin));
    }
    const fallback = `${url.origin}/og/woven.png?r=3`;
    return rewriteArtworkHead(shell, entry, artwork.year, url.origin, cachedImage ? image : fallback);
  },
};
