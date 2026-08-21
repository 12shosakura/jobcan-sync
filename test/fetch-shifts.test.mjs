// Must be set before importing anything that reads paths.js at module load.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
process.env.JOBCAN_SYNC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcan-fetch-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';
// Dynamic: a static import would be hoisted above the env var above, and the
// module reads the data directory at load time.
const { fetchShifts } = await import('../src/jobcan.js');

const SIGN_IN_HTML = `<html><body><form action="/users/sign_in" method="post">
  <input type="hidden" name="authenticity_token" value="CSRF-TOKEN-42">
  <input type="text" name="user[email]"><input type="password" name="user[password]">
  <input type="text" name="user[client_code]"></form></body></html>`;

const SHIFT_HTML = `<html><body><h2 class="mb-3">確定シフト</h2>
<table class="table jbc-table jbc-table-hover jbc-table-bordered">
  <tr><th>日付</th><th>シフト名</th><th>出社予定</th><th>退社予定</th><th>シフト休憩時間</th>
      <th>所定</th><th>残業申請</th><th>休暇申請</th><th>他スタッフの確定シフト</th><th>管理者より</th></tr>
  <tr><td>08/03(月)</td><td></td><td>11:00</td><td>18:00</td><td>01:00</td><td>06:00</td><td>-</td><td>-</td><td>表示</td><td></td></tr>
  <tr><td>08/04(火)</td><td></td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>表示</td><td></td></tr>
  <tr><td>08/05(水)</td><td>夜勤</td><td>22:00</td><td>29:00</td><td>-</td><td>07:00</td><td>-</td><td>-</td><td>表示</td><td></td></tr>
</table></body></html>`;

function mockJobcan() {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body?.toString(), headers: opts.headers });

    // 1. sign-in page: hand out a Common-ID cookie and the CSRF token
    if (u === 'https://id.jobcan.jp/users/sign_in' && (opts.method || 'GET') === 'GET') {
      return new Response(SIGN_IN_HTML, { status: 200, headers: { 'set-cookie': '_jobcan_id=pre; path=/' } });
    }
    // 2. credentials post -> redirect away from the login form
    if (u === 'https://id.jobcan.jp/users/sign_in' && opts.method === 'POST') {
      return new Response('', {
        status: 302,
        headers: { location: 'https://id.jobcan.jp/dashboard', 'set-cookie': '_jobcan_id=authed; path=/' },
      });
    }
    if (u === 'https://id.jobcan.jp/dashboard') return new Response('<html>dashboard</html>', { status: 200 });

    // 3. the bridge into an ssl.jobcan.jp employee session
    if (u === 'https://ssl.jobcan.jp/jbcoauth/login') {
      return new Response('', {
        status: 302,
        headers: { location: 'https://ssl.jobcan.jp/employee', 'set-cookie': 'sid=employee-session; path=/' },
      });
    }
    if (u === 'https://ssl.jobcan.jp/employee') return new Response('<html>employee top</html>', { status: 200 });

    // 4. the shift pages
    if (u.startsWith('https://ssl.jobcan.jp/employee/shift-schedule')) {
      return new Response(SHIFT_HTML, { status: 200 });
    }
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${u}`);
  };
  return calls;
}

test('logs in, bridges the session, and scrapes the shift pages', async (t) => {
  const original = globalThis.fetch;
  const calls = mockJobcan();
  t.after(() => {
    globalThis.fetch = original;
    fs.rmSync(process.env.JOBCAN_SYNC_DATA_DIR, { recursive: true, force: true });
  });

  const { shifts, pages } = await fetchShifts(
    { email: 'me@example.com', password: 'secret', clientCode: 'CLIENT99', monthsBehind: 0, monthsAhead: 0 },
    { now: new Date(2026, 7, 21) }, // pinned so the fixture dates stay in range
  );

  // The four steps happened, in order.
  assert.equal(calls[0].url, 'https://id.jobcan.jp/users/sign_in');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.ok(calls.some((c) => c.url === 'https://ssl.jobcan.jp/jbcoauth/login'));
  assert.ok(calls.some((c) => c.url.startsWith('https://ssl.jobcan.jp/employee/shift-schedule')));

  // The POST carried the CSRF token and all three credential fields.
  const posted = new URLSearchParams(calls[1].body);
  assert.equal(posted.get('authenticity_token'), 'CSRF-TOKEN-42');
  assert.equal(posted.get('user[email]'), 'me@example.com');
  assert.equal(posted.get('user[password]'), 'secret');
  assert.equal(posted.get('user[client_code]'), 'CLIENT99');

  // The session cookie earned at the bridge is presented to the shift page.
  const shiftCall = calls.find((c) => c.url.startsWith('https://ssl.jobcan.jp/employee/shift-schedule'));
  assert.ok(shiftCall.headers.Cookie.includes('sid=employee-session'));
  // ...and the id.jobcan.jp cookie is not leaked to the other host.
  assert.ok(!shiftCall.headers.Cookie.includes('_jobcan_id'));

  // One request for the whole range, not one per month.
  assert.equal(pages.length, 1);
  const shiftCalls = calls.filter((c) => c.url.includes('/employee/shift-schedule'));
  assert.equal(shiftCalls.length, 1);
  assert.ok(shiftCalls[0].url.includes('search_type=term'), 'bare year/month is ignored by Jobcan');

  assert.equal(shifts.length, 2, 'the all-dashes day off must be skipped');
  assert.deepEqual(shifts[0], {
    date: '2026-08-03',
    start: { dayOffset: 0, hhmm: '11:00' },
    end: { dayOffset: 0, hhmm: '18:00' },
    note: null,
    source: 'column-table',
  });
  assert.equal(shifts[1].note, '夜勤');
  assert.deepEqual(shifts[1].end, { dayOffset: 1, hhmm: '05:00' }, '29:00 becomes 05:00 next day');
});

test('a rejected sign-in reports the reason instead of scraping', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      return new Response(
        `<html><div class="alert">メールアドレスまたはパスワードが違います</div>
         <form><input type="password" name="user[password]"></form></html>`,
        { status: 200 },
      );
    }
    return new Response(SIGN_IN_HTML, { status: 200 });
  };

  await assert.rejects(
    fetchShifts({ email: 'me@example.com', password: 'wrong', clientCode: '', monthsAhead: 0 }),
    (e) => e.message.includes('rejected the sign-in') && e.message.includes('パスワードが違います'),
  );
});
