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

export default {
  async fetch(request) {
    const url = new URL(request.url)

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

    // An upgrade must pass through whole; reshaping it turns the handshake
    // into an ordinary request and the event streams never open.
    if ((headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return fetch(new Request(target.toString(), { method: request.method, headers }))
    }

    const response = await fetch(new Request(target.toString(), {
      method: request.method, headers, body: request.body, redirect: 'manual',
    }))

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
