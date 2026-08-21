import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { Session } from './http.js';
import { parseShifts } from './parse-shifts.js';
import { DATA_DIR, DEBUG_DIR, ensureDataDir } from './paths.js';
import * as logger from './logger.js';

const SIGN_IN_URL = 'https://id.jobcan.jp/users/sign_in';
// Bridges the Common-ID (id.jobcan.jp) session into an employee session on
// ssl.jobcan.jp. Without this hop the shift pages just bounce back to login.
const OAUTH_BRIDGE_URL = 'https://ssl.jobcan.jp/jbcoauth/login';
export const DEFAULT_SHIFT_URL = 'https://ssl.jobcan.jp/employee/shift-schedule';

// Match on the sign-in path or an actual password field -- never on the host.
// A successful login lands on id.jobcan.jp/dashboard, so host matching would
// report every good login as a failure.
const pad2 = (n) => String(n).padStart(2, '0');

const looksLikeLoginPage = (url, html) => {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* already a path */
  }
  return /\/users\/sign_in/.test(pathname) || /name=["']user\[password\]/.test(html);
};

function dumpDebug(name, content) {
  ensureDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DEBUG_DIR, `${stamp}-${name}`);
  try {
    fs.writeFileSync(file, content, { mode: 0o600 });
  } catch (e) {
    logger.warn(`Could not write debug dump: ${e.message}`);
    return null;
  }
  return file;
}

// Escape hatch: if the bundled parser cannot read your tenant's markup, drop a
// module at ~/.jobcan-gcal-sync/parser.mjs exporting
//   export function parse(html, ctx) { return { shifts: [...] } }
async function loadCustomParser() {
  const file = path.join(DATA_DIR, 'parser.mjs');
  if (!fs.existsSync(file)) return null;
  try {
    const mod = await import(`file://${file}?v=${fs.statSync(file).mtimeMs}`);
    if (typeof mod.parse === 'function') return mod.parse;
    logger.warn('parser.mjs found but it does not export parse()');
  } catch (e) {
    logger.error(`Failed to load custom parser.mjs: ${e.message}`);
  }
  return null;
}

/**
 * Pull the sign-in form's own hidden fields (authenticity_token above all) so
 * we post back exactly what Rails expects, rather than guessing field names.
 */
export function extractLoginForm(html) {
  const $ = cheerio.load(html);
  const form = $('form').filter((_, f) => $(f).find('input[type="password"]').length > 0).first();
  const scope = form.length ? form : $.root();

  const fields = {};
  scope.find('input').each((_, input) => {
    const name = $(input).attr('name');
    const type = ($(input).attr('type') || 'text').toLowerCase();
    if (!name || type === 'submit' || type === 'button') return;
    fields[name] = $(input).attr('value') ?? '';
  });

  if (!fields.authenticity_token) {
    const meta = $('meta[name="csrf-token"]').attr('content');
    if (meta) fields.authenticity_token = meta;
  }

  return {
    action: form.attr('action') || '/users/sign_in',
    method: (form.attr('method') || 'POST').toUpperCase(),
    fields,
  };
}

/** Best-effort extraction of the error Jobcan shows on a failed sign-in. */
function loginErrorFrom(html) {
  const $ = cheerio.load(html);
  const text = $('.alert, .error, .flash, [role="alert"]').first().text().replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

/**
 * 1. GET  id.jobcan.jp/users/sign_in   -> cookies + authenticity_token
 * 2. POST id.jobcan.jp/users/sign_in   -> Common-ID session
 * 3. GET  ssl.jobcan.jp/jbcoauth/login -> employee session on ssl.jobcan.jp
 */
async function login(session, { email, password, clientCode }) {
  logger.info('Fetching the Jobcan sign-in page…');
  const signIn = await session.request(SIGN_IN_URL);
  const form = extractLoginForm(signIn.html);
  if (!form.fields.authenticity_token) {
    const file = dumpDebug('signin-no-token.html', signIn.html);
    throw new Error(
      'Could not find an authenticity_token on the Jobcan sign-in page.' +
        (file ? ` Page saved to ${file}` : ''),
    );
  }

  const body = new URLSearchParams({
    ...form.fields,
    'user[email]': email,
    'user[password]': password,
    'user[client_code]': clientCode || '',
  });

  logger.info('Signing in…');
  const posted = await session.request(new URL(form.action, SIGN_IN_URL).toString(), {
    method: form.method,
    body,
    referer: SIGN_IN_URL,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://id.jobcan.jp',
    },
  });

  if (looksLikeLoginPage(posted.url, posted.html)) {
    const detail = loginErrorFrom(posted.html);
    const file = dumpDebug('login-failed.html', posted.html);
    throw new Error(
      `Jobcan rejected the sign-in${detail ? `: ${detail}` : ''}. Check the email, password and ` +
        'client code, and whether the account requires 2FA or SSO.' +
        (file ? ` Page saved to ${file}` : ''),
    );
  }

  logger.info('Bridging the session to ssl.jobcan.jp…');
  const bridged = await session.request(OAUTH_BRIDGE_URL, { referer: SIGN_IN_URL });
  if (looksLikeLoginPage(bridged.url, bridged.html)) {
    const file = dumpDebug('bridge-failed.html', bridged.html);
    throw new Error(
      'Signed in to Jobcan ID, but the employee session handoff failed.' +
        (file ? ` Page saved to ${file}` : ''),
    );
  }
  logger.info('Jobcan login OK.');
}

/**
 * The single source of truth for "which dates are we responsible for".
 * sync.js deletes tagged events inside this window, so the scrape has to cover
 * exactly the same span or a gap would look like "shift removed".
 */
export function monthWindow({ monthsBehind = 0, monthsAhead = 2 }, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() - Math.abs(monthsBehind), 1);
  const endExclusive = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 1);
  // Day 0 of the following month is the last day of the final month.
  const last = new Date(endExclusive.getFullYear(), endExclusive.getMonth(), 0);
  return { start, endExclusive, last };
}

/**
 * Build the shift-schedule query.
 *
 * The page ignores bare ?year=&month= — without search_type it silently returns
 * its default period, which is why every month came back byte-identical. The
 * form offers search_type=month (a whole shift month, which for this tenant runs
 * 16th→15th and therefore overlaps its neighbours) or search_type=term with an
 * explicit from/to. We use term: one request, no overlap, and an exact match for
 * the window the reconciler is allowed to delete in.
 */
export function rangeUrl(baseUrl, start, end) {
  const url = new URL(baseUrl);
  url.searchParams.set('search_type', 'term');
  url.searchParams.set('from[y]', String(start.getFullYear()));
  url.searchParams.set('from[m]', String(start.getMonth() + 1));
  url.searchParams.set('from[d]', String(start.getDate()));
  url.searchParams.set('to[y]', String(end.getFullYear()));
  url.searchParams.set('to[m]', String(end.getMonth() + 1));
  url.searchParams.set('to[d]', String(end.getDate()));
  return url.toString();
}

/**
 * Log in, crawl every configured month, and return the parsed shifts.
 * @returns {Promise<{shifts: Array, pages: Array, debugFiles: Array<string>}>}
 */
export async function fetchShifts(jobcanConfig, { debug = false, now = new Date() } = {}) {
  const { email, password, clientCode } = jobcanConfig;
  const shiftUrl = jobcanConfig.shiftUrl || DEFAULT_SHIFT_URL;
  if (!email || !password) throw new Error('Jobcan email and password are required.');

  const customParser = await loadCustomParser();
  const debugFiles = [];
  const session = new Session();

  await login(session, { email, password, clientCode });

  const { start, last } = monthWindow(jobcanConfig, now);
  const url = rangeUrl(shiftUrl, start, last);
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  logger.info(`Fetching shifts for ${iso(start)} → ${iso(last)}…`);
  const { html, url: landed } = await session.request(url, { referer: shiftUrl });

  if (looksLikeLoginPage(landed, html)) {
    const file = dumpDebug('shift-page-logged-out.html', html);
    if (file) debugFiles.push(file);
    throw new Error(
      'The shift page redirected back to the login form — the session was not accepted.' +
        (file ? ` Page saved to ${file}` : ''),
    );
  }

  const ctx = { year: start.getFullYear(), month: start.getMonth() + 1 };
  const result = customParser
    ? { ...(await customParser(html, ctx)), strategy: 'custom' }
    : parseShifts(html, ctx);
  const shifts = (result.shifts ?? []).filter((s) => s.date >= iso(start) && s.date <= iso(last));

  // Zero shifts is a legitimate answer, but it is also what a broken parser
  // looks like -- keep the HTML either way so selectors can be fixed for real.
  if (debug || shifts.length === 0) {
    const file = dumpDebug(`shift-${iso(start)}_${iso(last)}.html`, html);
    if (file) debugFiles.push(file);
  }

  logger.info(`${shifts.length} shift(s) parsed [${result.strategy}]`);
  const pages = [{ from: iso(start), to: iso(last), url, count: shifts.length, strategy: result.strategy }];

  return { shifts, pages, debugFiles };
}
