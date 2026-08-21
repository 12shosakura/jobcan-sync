import * as cheerio from 'cheerio';

// Jobcan renders shift pages differently per tenant (list table, calendar grid,
// or a "shift pattern" table), so we try several shapes and keep whatever
// yields the most rows.

const DASH = '[~～\\-−—–]|to|→';
const RE_TIME_RANGE = new RegExp(
  `(\\d{1,2})\\s*[:：]\\s*(\\d{2})\\s*(?:${DASH})\\s*(\\d{1,2})\\s*[:：]\\s*(\\d{2})`,
);
const RE_TIME_RANGE_COMPACT = new RegExp(`(?<!\\d)(\\d{2})(\\d{2})\\s*(?:${DASH})\\s*(\\d{2})(\\d{2})(?!\\d)`);
const RE_FULL_DATE = /(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/;
const RE_MONTH_DAY = /(?<!\d)(\d{1,2})\s*[/\-月]\s*(\d{1,2})\s*日?(?!\d)/;
const RE_BARE_DAY = /^\s*(\d{1,2})\s*日?\s*(?:[（(][月火水木金土日]\)?[）)]?)?\s*$/;
const RE_MONTH_HEADER = /(\d{4})\s*年\s*(\d{1,2})\s*月|(\d{4})[-/](\d{1,2})(?![-/\d])/;

// Rows that explicitly mean "not working". Without this a day off with a
// blank time cell can still match a stray time elsewhere in the row.
const RE_DAY_OFF = /公休|有給|有休|欠勤|休日|全休|^\s*休\s*$|振替休/;

const pad = (n) => String(n).padStart(2, '0');

function normalizeTime(h, m) {
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || mins > 59) return null;
  // Jobcan uses 24:00-29:59 for overnight shifts.
  return { dayOffset: Math.floor(hours / 24), hhmm: `${pad(hours % 24)}:${pad(mins)}` };
}

function matchTimeRange(text) {
  const m = RE_TIME_RANGE.exec(text) || RE_TIME_RANGE_COMPACT.exec(text);
  if (!m) return null;
  const start = normalizeTime(m[1], m[2]);
  const end = normalizeTime(m[3], m[4]);
  if (!start || !end) return null;
  return { start, end, matched: m[0] };
}

function matchDate(text, ctx) {
  const full = RE_FULL_DATE.exec(text);
  if (full) return { date: `${full[1]}-${pad(full[2])}-${pad(full[3])}`, matched: full[0] };

  const bare = RE_BARE_DAY.exec(text);
  if (bare && ctx.year && ctx.month) {
    return { date: `${ctx.year}-${pad(ctx.month)}-${pad(bare[1])}`, matched: bare[0] };
  }

  const md = RE_MONTH_DAY.exec(text);
  if (md && ctx.year) {
    const month = Number(md[1]);
    // A page for December can list early-January rows; roll the year forward.
    const year = ctx.month && month < ctx.month - 6 ? ctx.year + 1 : ctx.year;
    return { date: `${year}-${pad(month)}-${pad(md[2])}`, matched: md[0] };
  }
  return null;
}

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// cheerio .text() concatenates adjacent elements, so a calendar cell built from
// <span>7</span><div>0900-1730</div> collapses to "70900-1730" and stops
// matching. Insert a separator at every element boundary instead.
function textOf($, el) {
  const parts = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') parts.push(child.data);
      else if (child.type === 'tag') {
        walk(child);
        parts.push(' ');
      }
    }
  };
  walk(el);
  return clean(parts.join(' '));
}

function noteFrom(cells, consumed) {
  return (
    cells
      .map(clean)
      .filter((c) => c && !consumed.some((x) => x && c.includes(clean(x))))
      .filter((c) => !/^[（(]?[月火水木金土日][）)]?$/.test(c))
      .filter((c) => c.length <= 40)
      .join(' ')
      .trim() || null
  );
}

// The page header ("2026年8月") is more trustworthy than the URL when the site
// clamps or redirects the requested month.
function contextFromHtml($, fallback) {
  const header = clean($('h1, h2, h3, .title, .page-title, caption').first().text());
  const m = RE_MONTH_HEADER.exec(header);
  if (m) {
    return { year: Number(m[1] || m[3]), month: Number(m[2] || m[4]) };
  }
  return fallback;
}

// Jobcan's real shift table puts the start and end in *separate* columns
// (日付 | シフト名 | 出社予定 | 退社予定 | …), so there is no "09:00～18:00"
// range to match. Read the header row and address cells by column instead.
const HEADER_PATTERNS = {
  date: /日付|年月日|^日$/,
  start: /出社予定|出勤予定|出社|出勤|開始|始業/,
  end: /退社予定|退勤予定|退社|退勤|終了|終業/,
  note: /シフト名|シフト|勤務区分|備考/,
};

const RE_SINGLE_TIME = /^(\d{1,2})\s*[:：]\s*(\d{2})$/;

function singleTime(text) {
  const m = RE_SINGLE_TIME.exec(clean(text));
  return m ? normalizeTime(m[1], m[2]) : null;
}

function headerIndex(cells) {
  const idx = {};
  cells.forEach((cell, i) => {
    for (const [key, re] of Object.entries(HEADER_PATTERNS)) {
      // First match wins so 出社予定 does not later get overwritten by 出社.
      if (idx[key] === undefined && re.test(cell)) idx[key] = i;
    }
  });
  return idx;
}

function parseColumnTables($, ctx) {
  const shifts = [];
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    if (rows.length < 2) return;

    const headerCells = $(rows[0]).find('th, td').toArray().map((c) => textOf($, c));
    const idx = headerIndex(headerCells);
    if (idx.date === undefined || idx.start === undefined || idx.end === undefined) return;

    for (const row of rows.slice(1)) {
      const cells = $(row).find('td, th').toArray().map((c) => textOf($, c));
      if (cells.length <= Math.max(idx.date, idx.start, idx.end)) continue;

      const start = singleTime(cells[idx.start]);
      const end = singleTime(cells[idx.end]);
      // Days off render as "-" in the time columns; skip them without guessing.
      if (!start || !end) continue;

      const date = matchDate(cells[idx.date], ctx);
      if (!date) continue;

      const note = idx.note !== undefined ? clean(cells[idx.note]) : '';
      shifts.push({
        date: date.date,
        start,
        end,
        note: note && note !== '-' ? note : null,
        source: 'column-table',
      });
    }
  });
  return shifts;
}

function parseTables($, ctx) {
  const shifts = [];
  $('tr').each((_, tr) => {
    const cells = $(tr)
      .find('td, th')
      .toArray()
      .map((td) => textOf($, td));
    if (cells.length < 2) return;

    const rowText = cells.join(' | ');
    if (RE_DAY_OFF.test(rowText)) return;

    const date = matchDate(cells[0], ctx) || matchDate(cells[1] ?? '', ctx) || matchDate(rowText, ctx);
    if (!date) return;

    const timeCell = cells.find((c) => matchTimeRange(c));
    const range = matchTimeRange(timeCell ?? '') || matchTimeRange(rowText);
    if (!range) return;

    shifts.push({
      date: date.date,
      start: range.start,
      end: range.end,
      note: noteFrom(cells, [date.matched, range.matched]),
      source: 'table',
    });
  });
  return shifts;
}

// Month-grid calendars: each day is a cell holding a day number plus a time
// range, so there is no row-level date to key off.
function parseCalendarCells($, ctx) {
  const shifts = [];
  $('td, .day, .calendar-day, li').each((_, el) => {
    const $el = $(el);
    if ($el.find('td, .day, .calendar-day').length) return; // container, not a leaf
    const text = textOf($, el);
    if (!text || RE_DAY_OFF.test(text)) return;

    const range = matchTimeRange(text);
    if (!range) return;

    const dayNode = clean($el.find('.date, .day-number, .day_num, b, strong').first().text());
    const date =
      matchDate(dayNode, ctx) ||
      matchDate(clean($el.attr('data-date') || ''), ctx) ||
      matchDate(text.replace(range.matched, ' '), ctx);
    if (!date) return;

    shifts.push({
      date: date.date,
      start: range.start,
      end: range.end,
      note: noteFrom([text], [date.matched, range.matched]),
      source: 'calendar',
    });
  });
  return shifts;
}

function dedupe(shifts) {
  const seen = new Map();
  for (const s of shifts) {
    const key = `${s.date}|${s.start.hhmm}|${s.end.hhmm}`;
    // Prefer the variant that captured a note.
    if (!seen.has(key) || (!seen.get(key).note && s.note)) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) =>
    `${a.date}${a.start.hhmm}`.localeCompare(`${b.date}${b.start.hhmm}`),
  );
}

/**
 * @param {string} html raw shift page HTML
 * @param {{year?: number, month?: number}} fallbackCtx month the page was requested for
 * @returns {{shifts: Array, strategy: string, context: object}}
 */
export function parseShifts(html, fallbackCtx = {}) {
  const $ = cheerio.load(html);
  const ctx = contextFromHtml($, fallbackCtx);

  const candidates = [
    { strategy: 'column-table', shifts: parseColumnTables($, ctx) },
    { strategy: 'table', shifts: parseTables($, ctx) },
    { strategy: 'calendar', shifts: parseCalendarCells($, ctx) },
  ];
  const best = candidates.sort((a, b) => b.shifts.length - a.shifts.length)[0];

  return { shifts: dedupe(best.shifts), strategy: best.strategy, context: ctx };
}
