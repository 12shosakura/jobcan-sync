import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, Session } from '../src/http.js';
import { extractLoginForm, rangeUrl, monthWindow, DEFAULT_SHIFT_URL } from '../src/jobcan.js';
import { syncWindow } from '../src/sync.js';

test('cookie jar scopes cookies to the right host', () => {
  const jar = new CookieJar();
  jar.store('https://id.jobcan.jp/users/sign_in', '_session=abc; path=/; HttpOnly');
  jar.store('https://ssl.jobcan.jp/jbcoauth/login', 'employee=xyz; path=/');
  jar.store('https://id.jobcan.jp/', 'shared=both; domain=.jobcan.jp; path=/');

  const idCookies = jar.header('https://id.jobcan.jp/users/sign_in');
  assert.ok(idCookies.includes('_session=abc'));
  assert.ok(idCookies.includes('shared=both'));
  assert.ok(!idCookies.includes('employee=xyz'), 'host-only cookie must not leak across hosts');

  const sslCookies = jar.header('https://ssl.jobcan.jp/employee/shift-schedule');
  assert.ok(sslCookies.includes('employee=xyz'));
  assert.ok(sslCookies.includes('shared=both'), 'domain cookie should cover the sibling host');
  assert.ok(!sslCookies.includes('_session=abc'));
});

test('cookie jar honours deletion and expiry', () => {
  const jar = new CookieJar();
  jar.store('https://id.jobcan.jp/', 'a=1; path=/');
  jar.store('https://id.jobcan.jp/', 'a=; path=/');
  assert.equal(jar.header('https://id.jobcan.jp/'), '');

  jar.store('https://id.jobcan.jp/', 'b=2; path=/; Max-Age=-1');
  assert.equal(jar.header('https://id.jobcan.jp/'), '');
});

test('extracts the authenticity_token and the form hidden fields', () => {
  const html = `<form action="/users/sign_in" method="post">
    <input type="hidden" name="authenticity_token" value="TOKEN-123">
    <input type="hidden" name="utf8" value="&#x2713;">
    <input type="text" name="user[email]" value="">
    <input type="password" name="user[password]">
    <input type="text" name="user[client_code]" value="">
    <input type="submit" name="commit" value="ログイン">
  </form>`;
  const form = extractLoginForm(html);
  assert.equal(form.action, '/users/sign_in');
  assert.equal(form.method, 'POST');
  assert.equal(form.fields.authenticity_token, 'TOKEN-123');
  assert.ok('utf8' in form.fields);
  assert.ok(!('commit' in form.fields), 'submit buttons should not be replayed as fields');
});

test('falls back to the csrf-token meta tag', () => {
  const html = `<meta name="csrf-token" content="META-TOKEN"><form><input type="password" name="user[password]"></form>`;
  assert.equal(extractLoginForm(html).fields.authenticity_token, 'META-TOKEN');
});

test('the shift query uses search_type=term with an explicit from/to', () => {
  assert.equal(DEFAULT_SHIFT_URL, 'https://ssl.jobcan.jp/employee/shift-schedule');
  const { start, last } = monthWindow({ monthsBehind: 0, monthsAhead: 2 }, new Date(2026, 7, 21));
  const u = new URL(rangeUrl(DEFAULT_SHIFT_URL, start, last));

  // Without search_type the page ignores the dates and returns its default
  // period -- that was the bug that made every month come back identical.
  assert.equal(u.searchParams.get('search_type'), 'term');
  assert.equal(u.searchParams.get('from[y]'), '2026');
  assert.equal(u.searchParams.get('from[m]'), '8');
  assert.equal(u.searchParams.get('from[d]'), '1');
  assert.equal(u.searchParams.get('to[y]'), '2026');
  assert.equal(u.searchParams.get('to[m]'), '10');
  assert.equal(u.searchParams.get('to[d]'), '31', 'must be the last day of the final month');
});

test('the scraped range covers exactly the window the reconciler deletes in', () => {
  const cfg = { monthsBehind: 1, monthsAhead: 2 };
  const now = new Date(2026, 7, 21);
  const { start, last } = monthWindow(cfg, now);
  const w = syncWindow(cfg, 'Asia/Tokyo', now);

  // Deletion window starts at the first scraped day...
  assert.equal(w.timeMin.slice(0, 10), '2026-07-01');
  assert.equal(`${start.getFullYear()}-07-01`, '2026-07-01');
  // ...and ends the instant after the last scraped day.
  assert.equal(w.timeMax.slice(0, 10), '2026-11-01');
  assert.equal(last.getMonth(), 9, 'last scraped day is in October');
  assert.equal(last.getDate(), 31);
});

test('session follows redirects, collecting cookies and downgrading POST to GET', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), method: opts.method, cookie: opts.headers.Cookie });
    if (String(url).endsWith('/step1')) {
      return new Response('', {
        status: 302,
        headers: { location: 'https://example.test/step2', 'set-cookie': 'hop1=a; path=/' },
      });
    }
    return new Response('<html>done</html>', { status: 200, headers: { 'set-cookie': 'hop2=b; path=/' } });
  };
  try {
    const session = new Session();
    const res = await session.request('https://example.test/step1', { method: 'POST', body: 'x=1' });
    assert.equal(res.html, '<html>done</html>');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[1].method, 'GET', '302 must downgrade the follow-up to GET');
    assert.ok(seen[1].cookie.includes('hop1=a'), 'cookie from the redirect must be replayed');
    assert.ok(session.jar.header('https://example.test/').includes('hop2=b'));
  } finally {
    globalThis.fetch = original;
  }
});
