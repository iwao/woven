const DATA_PREFIX = '/public/data/';
const isBrotliData = (key) => key === 'woven-sample.json' || key.endsWith('.bin');

function contentType(path) {
  if (path.endsWith('.bin')) return 'application/octet-stream';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
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
    return env.ASSETS.fetch(new Request(new URL('/', url), {method: 'GET', headers: request.headers}));
  },
};
