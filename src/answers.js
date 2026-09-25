// How the Worker answers when it answers itself (the API, not the page).
// worker.js and golive-routes.js both answer through here, so every answer
// carries the same headers.
//
// Kept apart from worker.js so it can be tested under plain Node.

// Nothing the desk answers is cached, indexed or sniffed, no referrer leaves
// with a link, and browsers keep to HTTPS for this host.
const HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS },
  });
}

// A 302 to one of the desk's own pages. The Location is relative, so it can
// only ever lead back to this host; callers build it from fixed parts.
export function redirect(path) {
  return new Response(null, { status: 302, headers: { location: path, ...HEADERS } });
}
