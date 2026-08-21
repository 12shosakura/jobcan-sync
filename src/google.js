// Google Calendar over plain REST + fetch. The `googleapis` SDK pulls in every
// Google API (tens of thousands of files) which makes a background daemon slow
// to start; we only need OAuth2 and five calendar endpoints.
import * as logger from './logger.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

// The narrowest scope that can do this job: it permits creating secondary
// calendars and managing events *only on calendars this app created*. The
// user's existing calendars are not readable or writable at all, so a bug here
// cannot touch them -- the boundary is enforced by Google, not by our code.
export const SCOPES = ['https://www.googleapis.com/auth/calendar.app.created'];

// Tag every event we create so the reconciler can delete a stale shift without
// ever touching an event the user made themselves.
const TAG_KEY = 'jobcanSync';
const TAG_VALUE = '1';

function requireClient({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) throw new Error('Google client ID and secret are required.');
}

export function authUrl(googleConfig, redirectUri) {
  requireClient(googleConfig);
  const params = new URLSearchParams({
    client_id: googleConfig.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-authorisation
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The most common failure by far: the saved refresh token is dead. Say what
    // to do about it, and name the cause that bites background syncs -- an
    // External consent screen left in "Testing" expires refresh tokens weekly.
    if (data.error === 'invalid_grant') {
      const err = new Error(
        'Google rejected the saved refresh token (invalid_grant). Press "Connect Google Calendar" ' +
          'to reconnect. If this keeps happening every ~7 days, your OAuth consent screen is still ' +
          'in Testing mode — set its publishing status to "In production".',
      );
      err.needsReauth = true;
      throw err;
    }
    throw new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode(googleConfig, redirectUri, code) {
  requireClient(googleConfig);
  const data = await postToken({
    code,
    client_id: googleConfig.clientId,
    client_secret: googleConfig.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!data.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at ' +
        'myaccount.google.com/permissions and connect again.',
    );
  }
  return data.refresh_token;
}

// Access tokens last an hour; a sync every 30 minutes would otherwise re-mint
// one on every run.
const tokenCache = new Map();

async function accessToken(googleConfig) {
  requireClient(googleConfig);
  if (!googleConfig.refreshToken) throw new Error('Google Calendar is not connected yet.');

  const cached = tokenCache.get(googleConfig.refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const data = await postToken({
    client_id: googleConfig.clientId,
    client_secret: googleConfig.clientSecret,
    refresh_token: googleConfig.refreshToken,
    grant_type: 'refresh_token',
  });
  const token = data.access_token;
  tokenCache.set(googleConfig.refreshToken, {
    token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
  return token;
}

async function calApi(googleConfig, method, path, { query, body } = {}) {
  const url = new URL(`${CAL_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(googleConfig)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Calendar API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Return the id of this app's own calendar, creating it if needed.
 * Because of the app.created scope this is the only calendar we can ever write
 * to, so there is no calendar picker and no way to aim at "primary".
 */
export async function ensureCalendar(googleConfig, { name, timezone }) {
  const summary = name || 'Jobcan Shifts';

  if (googleConfig.calendarId) {
    try {
      const existing = await calApi(googleConfig, 'GET', `/calendars/${encodeURIComponent(googleConfig.calendarId)}`);
      // Keep the calendar's title in step if the user renamed it in our UI.
      if (existing.summary !== summary) {
        await calApi(googleConfig, 'PATCH', `/calendars/${encodeURIComponent(googleConfig.calendarId)}`, {
          body: { summary },
        });
        logger.info(`Renamed calendar to "${summary}".`);
      }
      return { calendarId: googleConfig.calendarId, created: false };
    } catch (e) {
      if (![403, 404, 410].includes(e.status)) throw e;
      logger.warn(
        e.status === 403
          ? 'The configured calendar is not one this app owns — creating our own instead.'
          : 'The synced calendar no longer exists — creating a new one.',
      );
    }
  }

  const created = await calApi(googleConfig, 'POST', '/calendars', {
    body: { summary, timeZone: timezone, description: 'Shifts synced from Jobcan. Managed automatically.' },
  });
  logger.info(`Created calendar "${summary}" (${created.id}).`);
  return { calendarId: created.id, created: true };
}

function renderTitle(template, vars) {
  return template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, body) => (vars[key] ? body : ''))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const addDays = (isoDate, days) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

function signature(event) {
  return [
    event.summary,
    event.start.dateTime,
    event.end.dateTime,
    event.start.timeZone,
    JSON.stringify(event.reminders ?? null),
  ].join('|');
}

/**
 * Turn scraped shifts into the exact set of Google events that should exist.
 * The key is stable per (day, ordinal) so an edited shift updates in place
 * rather than churning delete+create.
 */
export function buildDesiredEvents(shifts, syncConfig) {
  const perDay = new Map();
  const events = [];

  for (const shift of [...shifts].sort((a, b) =>
    `${a.date}${a.start.hhmm}`.localeCompare(`${b.date}${b.start.hhmm}`),
  )) {
    const ordinal = perDay.get(shift.date) ?? 0;
    perDay.set(shift.date, ordinal + 1);

    const startDate = addDays(shift.date, shift.start.dayOffset || 0);
    let endDate = addDays(shift.date, shift.end.dayOffset || 0);
    // An end time at or before the start means the shift runs past midnight.
    if (endDate === startDate && shift.end.hhmm <= shift.start.hhmm) endDate = addDays(endDate, 1);

    const key = `${shift.date}#${ordinal}`;
    const summary =
      renderTitle(syncConfig.eventTitleTemplate || 'Shift', {
        note: shift.note || '',
        date: shift.date,
        start: shift.start.hhmm,
        end: shift.end.hhmm,
      }) || 'Shift';

    const event = {
      summary,
      description: 'Synced from Jobcan. Edits here are overwritten on the next sync.',
      start: { dateTime: `${startDate}T${shift.start.hhmm}:00`, timeZone: syncConfig.timezone },
      end: { dateTime: `${endDate}T${shift.end.hhmm}:00`, timeZone: syncConfig.timezone },
      extendedProperties: { private: { [TAG_KEY]: TAG_VALUE, jobcanKey: key } },
    };
    if (Number.isFinite(syncConfig.reminderMinutes)) {
      event.reminders = {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: syncConfig.reminderMinutes }],
      };
    }
    event.extendedProperties.private.jobcanSig = signature(event);
    events.push({ key, event });
  }
  return events;
}

async function listSyncedEvents(googleConfig, calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken;
  do {
    const data = await calApi(googleConfig, 'GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        timeMin,
        timeMax,
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        privateExtendedProperty: `${TAG_KEY}=${TAG_VALUE}`,
        pageToken,
      },
    });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Reconcile the calendar to match `shifts` for the given window.
 * One-way by construction: nothing is ever written back to Jobcan, and only
 * events carrying our tag are modified or deleted.
 */
export async function syncToCalendar(shifts, { google: googleConfig, sync: syncConfig }, window) {
  const calendarId = googleConfig.calendarId || 'primary';
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;

  const desired = buildDesiredEvents(shifts, syncConfig);
  const existing = await listSyncedEvents(googleConfig, calendarId, window.timeMin, window.timeMax);

  const byKey = new Map();
  const orphans = [];
  for (const ev of existing) {
    const key = ev.extendedProperties?.private?.jobcanKey;
    // Duplicates can appear if a sync died mid-write; keep one, delete the rest.
    if (key && !byKey.has(key)) byKey.set(key, ev);
    else orphans.push(ev);
  }

  const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0, errors: 0 };

  for (const { key, event } of desired) {
    const current = byKey.get(key);
    try {
      if (!current) {
        await calApi(googleConfig, 'POST', path, { body: event });
        stats.created++;
      } else if (current.extendedProperties?.private?.jobcanSig === event.extendedProperties.private.jobcanSig) {
        stats.unchanged++;
      } else {
        await calApi(googleConfig, 'PUT', `${path}/${encodeURIComponent(current.id)}`, { body: event });
        stats.updated++;
      }
    } catch (e) {
      stats.errors++;
      logger.error(`Failed to write event ${key}: ${e.message}`);
    }
    byKey.delete(key);
  }

  // Anything left carried our tag but no longer matches a Jobcan shift.
  for (const stale of [...byKey.values(), ...orphans]) {
    try {
      await calApi(googleConfig, 'DELETE', `${path}/${encodeURIComponent(stale.id)}`);
      stats.deleted++;
    } catch (e) {
      if (e.status === 410 || e.status === 404) continue; // already gone
      stats.errors++;
      logger.error(`Failed to delete event ${stale.id}: ${e.message}`);
    }
  }

  return stats;
}
