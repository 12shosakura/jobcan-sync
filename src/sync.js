import { fetchShifts, monthWindow } from './jobcan.js';
import { syncToCalendar, ensureCalendar } from './google.js';
import { loadConfig, saveState, updateConfig } from './store.js';
import * as logger from './logger.js';

// Google wants RFC3339 with a real offset, and the offset for a named zone
// depends on the date (DST), so ask Intl rather than hardcoding +09:00.
function offsetFor(dateStr, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${dateStr}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name || '');
  return m ? m[1] : '+00:00';
}

export function syncWindow(jobcanConfig, timeZone, now = new Date()) {
  // Same helper the scraper uses, so the range we delete in can never drift
  // from the range we actually fetched.
  const { start, endExclusive: end } = monthWindow(jobcanConfig, now);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    timeMin: `${fmt(start)}T00:00:00${offsetFor(fmt(start), timeZone)}`,
    timeMax: `${fmt(end)}T00:00:00${offsetFor(fmt(end), timeZone)}`,
  };
}

let inFlight = false;

/** Run one full Jobcan -> Google Calendar pass. Never runs concurrently. */
export async function runSync({ debug = false } = {}) {
  if (inFlight) {
    logger.warn('Sync already in progress — skipping this trigger.');
    return { skipped: true };
  }
  inFlight = true;
  const startedAt = new Date().toISOString();
  saveState({ running: true });

  try {
    const config = loadConfig();
    if (!config.google.refreshToken) throw new Error('Google Calendar is not connected yet.');

    logger.info('Sync started.');
    const { shifts, pages, debugFiles } = await fetchShifts(config.jobcan, { debug });
    logger.info(`Scraped ${shifts.length} shift(s) for ${pages[0]?.from} → ${pages[0]?.to}.`);

    // A parser that silently stops matching looks exactly like "you have no
    // shifts", and acting on that would wipe the calendar. Refuse by default.
    if (shifts.length === 0 && !config.sync.allowEmptyPurge) {
      const result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        shifts: 0,
        pages,
        debugFiles,
        stats: { created: 0, updated: 0, deleted: 0, unchanged: 0, errors: 0 },
        warning:
          'No shifts were found, so the calendar was left untouched. If this is wrong, the shift ' +
          'URL or the HTML layout probably changed — check the saved debug HTML.',
      };
      logger.warn(result.warning);
      saveState({ running: false, lastRunAt: result.finishedAt, lastResult: result, lastError: null });
      return result;
    }

    // Resolve our own calendar first; remember its id so later runs reuse it.
    const { calendarId, created } = await ensureCalendar(config.google, {
      name: config.google.calendarName,
      timezone: config.sync.timezone,
    });
    if (created || calendarId !== config.google.calendarId) {
      updateConfig({ google: { calendarId } });
      config.google.calendarId = calendarId;
    }

    const window = syncWindow(config.jobcan, config.sync.timezone);
    const stats = await syncToCalendar(shifts, config, window);
    logger.info(
      `Sync finished: ${stats.created} created, ${stats.updated} updated, ` +
        `${stats.deleted} deleted, ${stats.unchanged} unchanged, ${stats.errors} error(s).`,
    );

    const result = {
      startedAt,
      finishedAt: new Date().toISOString(),
      shifts: shifts.length,
      pages,
      debugFiles,
      stats,
      window,
    };
    saveState({ running: false, lastRunAt: result.finishedAt, lastResult: result, lastError: null });
    return result;
  } catch (e) {
    logger.error(`Sync failed: ${e.message}`);
    saveState({
      running: false,
      lastRunAt: new Date().toISOString(),
      lastError: { message: e.message, at: new Date().toISOString() },
    });
    throw e;
  } finally {
    inFlight = false;
  }
}
