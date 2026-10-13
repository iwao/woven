const DATA_PREFIX = '/public/data/';
const isBrotliData = (key) => key === 'woven-sample.json' || key.endsWith('.bin');
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

function rewriteArtworkHead(response, entry, year, origin) {
  const artist = entry.displayName || entry.name;
  const title = `WOVEN — ${artist} · ${year}`;
  const description = `${artist} · ${year}, a WOVEN artist relation temporal field from the Classii cultural graph.`;
  const canonical = `${origin}/artists/${encodeURIComponent(entry.slug)}/${year}`;
  // One lossless, data-derived card per Artist is intentionally reused across
  // year variants, keeping social-preview assets bounded to the public set.
  const image = `${origin}/public/og/artists/${encodeURIComponent(entry.classiiId)}.png`;
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

export default {
  async fetch(request, env) {
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
    return entry ? rewriteArtworkHead(shell, entry, artwork.year, url.origin) : shell;
  },
};
