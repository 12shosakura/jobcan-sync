import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShifts } from '../src/parse-shifts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildDesiredEvents, SCOPES, authUrl } from '../src/google.js';
import { syncWindow } from '../src/sync.js';

const SYNC = { timezone: 'Asia/Tokyo', eventTitleTemplate: 'Shift{{#note}} ({{note}}){{/note}}', reminderMinutes: null };

test('parses a list-style shift table', () => {
  const html = `<h2>2026年8月 シフト</h2><table>
    <tr><th>日付</th><th>曜日</th><th>シフト</th><th>備考</th></tr>
    <tr><td>2026/08/03</td><td>月</td><td>09:00～18:00</td><td>早番</td></tr>
    <tr><td>2026/08/04</td><td>火</td><td>13:00 ～ 22:00</td><td>遅番</td></tr>
    <tr><td>2026/08/05</td><td>水</td><td>公休</td><td></td></tr>
  </table>`;
  const { shifts } = parseShifts(html, { year: 2026, month: 8 });
  assert.equal(shifts.length, 2);
  assert.deepEqual(shifts[0], {
    date: '2026-08-03',
    start: { dayOffset: 0, hhmm: '09:00' },
    end: { dayOffset: 0, hhmm: '18:00' },
    note: '早番',
    source: 'table',
  });
  assert.equal(shifts[1].note, '遅番');
});

test('uses the page header for bare day numbers', () => {
  const html = `<h1>2026年9月</h1><table>
    <tr><td>1(火)</td><td>10:00-19:00</td></tr>
    <tr><td>2(水)</td><td>10:00-19:00</td></tr>
  </table>`;
  const { shifts, context } = parseShifts(html, { year: 2000, month: 1 });
  assert.deepEqual(context, { year: 2026, month: 9 });
  assert.deepEqual(shifts.map((s) => s.date), ['2026-09-01', '2026-09-02']);
});

test('normalises 24h+ overnight notation', () => {
  const html = `<table><tr><td>2026/08/10</td><td>22:00～26:30</td></tr></table>`;
  const { shifts } = parseShifts(html);
  assert.deepEqual(shifts[0].end, { dayOffset: 1, hhmm: '02:30' });
});

test('reads a calendar-grid layout', () => {
  const html = `<h2>2026年8月</h2><table class="calendar"><tr>
    <td><span class="date">7</span><div>0900～1730</div></td>
    <td><span class="date">8</span><div>公休</div></td>
  </tr></table>`;
  const { shifts } = parseShifts(html, { year: 2026, month: 8 });
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].date, '2026-08-07');
  assert.equal(shifts[0].start.hhmm, '09:00');
  assert.equal(shifts[0].end.hhmm, '17:30');
});

test('an unparseable page yields nothing rather than garbage', () => {
  const { shifts } = parseShifts('<p>Please log in to continue.</p>', { year: 2026, month: 8 });
  assert.equal(shifts.length, 0);
});

test('builds tagged events with stable keys and overnight end dates', () => {
  const shifts = [
    { date: '2026-08-03', start: { dayOffset: 0, hhmm: '09:00' }, end: { dayOffset: 0, hhmm: '18:00' }, note: '早番' },
    { date: '2026-08-10', start: { dayOffset: 0, hhmm: '22:00' }, end: { dayOffset: 1, hhmm: '02:30' }, note: null },
  ];
  const events = buildDesiredEvents(shifts, SYNC);

  assert.deepEqual(events.map((e) => e.key), ['2026-08-03#0', '2026-08-10#0']);
  assert.equal(events[0].event.summary, 'Shift (早番)');
  assert.equal(events[1].event.summary, 'Shift');
  assert.equal(events[1].event.start.dateTime, '2026-08-10T22:00:00');
  assert.equal(events[1].event.end.dateTime, '2026-08-11T02:30:00');
  for (const { event } of events) {
    assert.equal(event.extendedProperties.private.jobcanSync, '1');
    assert.equal(event.start.timeZone, 'Asia/Tokyo');
  }
});

test('two shifts on one day get distinct keys', () => {
  const shifts = [
    { date: '2026-08-03', start: { dayOffset: 0, hhmm: '18:00' }, end: { dayOffset: 0, hhmm: '22:00' }, note: null },
    { date: '2026-08-03', start: { dayOffset: 0, hhmm: '09:00' }, end: { dayOffset: 0, hhmm: '12:00' }, note: null },
  ];
  const events = buildDesiredEvents(shifts, SYNC);
  assert.deepEqual(events.map((e) => e.key), ['2026-08-03#0', '2026-08-03#1']);
  // Sorted by start time, so the key stays stable across runs.
  assert.equal(events[0].event.start.dateTime, '2026-08-03T09:00:00');
});

test('a same-time shift produces an identical signature (no needless updates)', () => {
  const shift = [{ date: '2026-08-03', start: { dayOffset: 0, hhmm: '09:00' }, end: { dayOffset: 0, hhmm: '18:00' }, note: 'A' }];
  const a = buildDesiredEvents(shift, SYNC)[0].event.extendedProperties.private.jobcanSig;
  const b = buildDesiredEvents(shift, SYNC)[0].event.extendedProperties.private.jobcanSig;
  assert.equal(a, b);
});

test('sync window covers exactly the crawled months', () => {
  const w = syncWindow({ monthsBehind: 1, monthsAhead: 2 }, 'Asia/Tokyo', new Date(2026, 7, 21));
  assert.equal(w.timeMin, '2026-07-01T00:00:00+09:00');
  assert.equal(w.timeMax, '2026-11-01T00:00:00+09:00');
});

test('requests only the app-created calendar scope', () => {
  assert.deepEqual(SCOPES, ['https://www.googleapis.com/auth/calendar.app.created']);
  const url = authUrl({ clientId: 'id', clientSecret: 'secret' }, 'http://127.0.0.1:5675/oauth2callback');
  const scope = new URL(url).searchParams.get('scope');
  assert.equal(scope, 'https://www.googleapis.com/auth/calendar.app.created');
  // A regression here would silently re-request write access to every calendar.
  assert.ok(!scope.includes('calendar.events'));
  assert.ok(!scope.includes('calendar.readonly'));
});

test('a legacy "primary" calendar id is dropped on load', () => {
  // Runs in a child process on purpose. paths.js reads JOBCAN_SYNC_DATA_DIR into
  // a module-level constant at load time, and ES imports are hoisted above any
  // assignment in this file -- so setting the env var here would NOT redirect
  // the store, and saveConfig() would write to the real ~/.jobcan-gcal-sync.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcan-sync-test-'));
  try {
    const script = `
      const store = await import('${pathToFileURL(path.resolve('src/store.js')).href}');
      store.saveConfig({ ...store.DEFAULT_CONFIG,
        google: { ...store.DEFAULT_CONFIG.google, calendarId: 'primary' } });
      process.stdout.write(JSON.stringify(store.loadConfig().google.calendarId));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, JOBCAN_SYNC_DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(out), '');
    // The isolated directory must be the one that was written to.
    assert.ok(fs.existsSync(path.join(dir, 'config.enc')), 'the child wrote to the temp data dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
