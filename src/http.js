// Jobcan's login is a plain Rails form flow, so a cookie jar over fetch is
// enough -- no headless browser required. Node's fetch has no cookie support
// and follows redirects opaquely, which would lose Set-Cookie headers on the
// hops that matter, so both are handled here.

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFrom(url, response) {
    const raw =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) this.store(url, line);
  }

  store(url, line) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();

    let domain = new URL(url).hostname;
    let path = '/';
    let expires = null;
    for (const attr of attrs) {
      const [k, ...rest] = attr.split('=');
      const key = k.trim().toLowerCase();
      const v = rest.join('=').trim();
      if (key === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
      else if (key === 'path' && v) path = v;
      else if (key === 'max-age' && v) expires = Date.now() + Number(v) * 1000;
      else if (key === 'expires' && v && expires === null) expires = Date.parse(v);
    }

    const key = `${domain}|${path}|${name}`;
    // An empty value or a past expiry is the server deleting the cookie.
    if (!value || (expires !== null && Number.isFinite(expires) && expires <= Date.now())) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { name, value, domain, path, expires });
  }

  header(url) {
    const { hostname, pathname } = new URL(url);
    const out = [];
    for (const c of this.cookies.values()) {
      if (c.expires !== null && Number.isFinite(c.expires) && c.expires <= Date.now()) continue;
      // Host-only match, or a domain cookie covering this subdomain.
      if (hostname !== c.domain && !hostname.endsWith(`.${c.domain}`)) continue;
      if (!pathname.startsWith(c.path)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }

  get size() {
    return this.cookies.size;
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/**
 * A fetch that keeps cookies and follows redirects one hop at a time, so every
 * Set-Cookie along the chain is captured — including the ones issued during the
 * id.jobcan.jp → ssl.jobcan.jp handoff.
 */
export class Session {
  constructor({ jar = new CookieJar(), maxRedirects = 10, timeoutMs = 30_000 } = {}) {
    this.jar = jar;
    this.maxRedirects = maxRedirects;
    this.timeoutMs = timeoutMs;
  }

  async request(url, { method = 'GET', body, headers = {}, referer } = {}) {
    let current = url;
    let currentMethod = method;
    let currentBody = body;

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const cookie = this.jar.header(current);
      const res = await fetch(current, {
        method: currentMethod,
        body: currentBody,
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ja,en;q=0.8',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      this.jar.storeFrom(current, res);

      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) {
        return { response: res, url: current, html: await res.text() };
      }

      referer = current;
      current = new URL(location, current).toString();
      // 303, and 301/302 in practice, downgrade to GET and drop the body.
      if (currentMethod === 'POST' && res.status !== 307 && res.status !== 308) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
    }
    throw new Error(`Too many redirects while requesting ${url}`);
  }
}

export { CookieJar };
