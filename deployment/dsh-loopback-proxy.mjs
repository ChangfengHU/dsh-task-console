/**
 * Fronts one dsh deployment so its loopback-only surface works over a domain.
 *
 * dsh gates the whole configuration plane twice, and both gates have to move
 * or nothing changes.
 *
 * The server gate refuses `credentials.describe`, `settings.describe` and the
 * rest unless the request's Host is loopback AND any Origin equals that same
 * authority. Rewriting Host alone therefore makes it worse, not better:
 * measured, every browser request started failing because Origin no longer
 * matched, and the app lost its workspace list. The tunnel rewrites Host on a
 * second hostname that carries no Worker route; this Worker rewrites Origin
 * and Referer to match before forwarding there.
 *
 * The client gate is the one nothing on the server can reach. The connection
 * bundle computes `isLoopback` from the browser's own address bar, and the
 * settings mirror runs in "memory" mode when it is false — never asking the
 * Host for its namespaces, which is why the configuration tab renders zero
 * cards even after every 403 is gone. So the bundle is rewritten in flight.
 *
 * This is a reachability decision, not authentication: anyone holding the
 * public URL reaches credentials, settings, and host.openPath. It is also
 * upstream code being edited on the way past, so a rename upstream turns the
 * rewrite into a silent no-op — the verification endpoint below exists so
 * that failure is visible rather than mysterious.
 */
const ORIGIN_HOST = 'dsh-origin-152-32-214-95.vyibc.com'
const LOCAL = 'http://127.0.0.1:3080'

/** The exact expression the connection bundle uses to classify the page. */
const NEEDLE = 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)'
const PATCH = 'isLoopback: true'

// Only immutable public plugin bundles qualify. Never cache HTML, RPC, events,
// unversioned files or requests carrying explicit authorization.
export function assetKey(request) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || request.headers.has('authorization')) return null
  if (!/^\/plugins\/(?:@[\w-]+\/)?[\w.-]+\/client\.js$/.test(url.pathname)) return null
  if (!/^[a-f0-9]{12}$/.test(url.searchParams.get('rev') ?? '')) return null
  if ([...url.searchParams.keys()].some(key => key !== 'rev')) return null
  return new Request(url.toString(), { method: 'GET' })
}

async function versionMatches(text, rev) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 12) === rev
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const key = assetKey(request)
    if (key) {
      const hit = await caches.default.match(key)
      if (hit) {
        const result = new Response(hit.body, hit)
        result.headers.set('x-dsh-asset-cache', 'HIT')
        return result
      }
    }

    // A probe that says whether the rewrite still matches upstream's code.
    // Without it, an upstream rename degrades to "the page is empty again"
    // with nothing to point at.
    if (url.pathname === '/__loopback-proxy-health') {
      const probe = await fetch(`https://${ORIGIN_HOST}/plugins/@deepseek-ai/dsh-client-connection/client.js`)
      const body = await probe.text()
      const found = body.includes(NEEDLE) || body.includes(PATCH)
      return new Response(JSON.stringify({ patchAnchorFound: found, bundleBytes: body.length }), {
        status: found ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })
    }

    const target = new URL(url.pathname + url.search, `https://${ORIGIN_HOST}`)
    const headers = new Headers(request.headers)
    if (headers.has('origin')) headers.set('origin', LOCAL)
    if (headers.has('referer')) headers.set('referer', LOCAL + url.pathname + url.search)
    if (key) {
      // Public bundle content is independent of cookies; never forward them into
      // a cacheable origin request. Fetch a complete body for hash verification.
      headers.delete('cookie'); headers.delete('if-none-match'); headers.delete('if-modified-since'); headers.delete('range')
    }

    // An upgrade must pass through whole; reshaping it turns the handshake
    // into an ordinary request and the event streams never open.
    if ((headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return fetch(new Request(target.toString(), { method: request.method, headers }))
    }

    const response = await fetch(new Request(target.toString(), {
      method: request.method, headers, body: request.body, redirect: 'manual',
    }))

    if (key && response.status === 200 && !response.headers.has('set-cookie')) {
      const text = await response.text()
      const id = decodeURIComponent(url.pathname.slice('/plugins/'.length, -'/client.js'.length))
      const registration = text.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)
      if (registration?.[1] !== id) {
        return new Response('Invalid plugin bundle registration', { status: 502, headers: { 'cache-control': 'no-store', 'x-dsh-asset-cache': 'INVALID' } })
      }
      const patched = url.pathname.includes('/dsh-client-connection/client.js') ? text.replace(NEEDLE, PATCH) : text
      const out = new Headers(response.headers)
      out.delete('content-length'); out.delete('content-encoding'); out.delete('etag')
      const valid = await versionMatches(text, url.searchParams.get('rev'))
      out.set('cache-control', valid ? 'public, max-age=31536000, immutable' : 'no-store')
      out.set('x-dsh-asset-cache', valid ? 'MISS' : 'REV-MISMATCH')
      const result = new Response(patched, { status: 200, headers: out })
      if (valid) ctx.waitUntil(caches.default.put(key, result.clone()))
      return result
    }

    // Only the one bundle is read into memory. Buffering every asset to
    // search for a string that lives in exactly one of them would trade a
    // known problem for a slow proxy.
    if (url.pathname.includes('/dsh-client-connection/client.js')) {
      const text = await response.text()
      const patched = text.replace(NEEDLE, PATCH)
      const out = new Headers(response.headers)
      out.delete('content-length')
      return new Response(patched, { status: response.status, headers: out })
    }

    return response
  },
}
