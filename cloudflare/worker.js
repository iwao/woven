const DATA_PREFIX = '/public/data/';
const SAMPLE_KEY = 'woven-sample.json';
const SAMPLE_PARTS_KEY = 'woven-sample/parts.json';

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
      if (key === SAMPLE_KEY) {
        const index = await env.WOVEN_DATA.get(SAMPLE_PARTS_KEY);
        if (index) {
          const {parts = []} = await index.json();
          const objects = await Promise.all(parts.map((part) => env.WOVEN_DATA.get(part)));
          if (objects.every(Boolean)) {
            const stream = new ReadableStream({
              async start(controller) {
                try {
                  for (const object of objects) {
                    const reader = object.body.getReader();
                    while (true) {
                      const {done, value} = await reader.read();
                      if (done) break;
                      controller.enqueue(value);
                    }
                  }
                  controller.close();
                } catch (error) {
                  controller.error(error);
                }
              },
            });
            return new Response(stream, {
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
              },
            });
          }
        }
      }
      const object = await env.WOVEN_DATA.get(key);
      if (object) {
        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || contentType(key),
            'ETag': object.httpEtag,
            // Snapshot-addressed files are immutable; query strings are kept by
            // the client as an extra dataset-version guard.
            'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
          },
        });
      }
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || url.pathname.includes('.')) return asset;
    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  },
};
