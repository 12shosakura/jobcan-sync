import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, html } from './server.js';
import { loadConfig, updateConfig, redactConfig, loadState } from './store.js';
import { authUrl, exchangeCode } from './google.js';
import { fetchShifts } from './jobcan.js';
import { runSync } from './sync.js';
import * as scheduler from './scheduler.js';
import * as logger from './logger.js';
import { DATA_DIR, LOG_FILE, ensureDataDir } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.JOBCAN_SYNC_PORT) || 5675;
const HOST = '127.0.0.1';
const REDIRECT_URI = `http://${HOST}:${PORT}/oauth2callback`;

// Google Cloud Console hands you a client_secret_*.json download. Parsing it
// beats making the user hand-copy two long opaque strings into two boxes.
function credentialsFromJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('That does not look like JSON. Paste the whole client_secret_….json file.');
  }
  const block = parsed.installed || parsed.web || parsed;
  const clientId = block.client_id;
  const clientSecret = block.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('No client_id / client_secret found. Paste the whole client_secret_….json file.');
  }
  return { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() };
}

function configPatchFrom(body) {
  const patch = { jobcan: {}, google: {}, sync: {} };

  for (const k of ['email', 'clientCode', 'shiftUrl']) {
    if (typeof body.jobcan?.[k] === 'string') patch.jobcan[k] = body.jobcan[k].trim();
  }
  for (const k of ['monthsAhead', 'monthsBehind']) {
    if (body.jobcan?.[k] !== undefined) patch.jobcan[k] = Math.max(0, Number(body.jobcan[k]) || 0);
  }
  // Blank password means "keep the stored one" — the UI never receives it back.
  if (body.jobcan?.password) patch.jobcan.password = body.jobcan.password;

  if (typeof body.google?.clientId === 'string') patch.google.clientId = body.google.clientId.trim();
  // calendarId is app-managed and deliberately not settable from the UI.
  if (typeof body.google?.calendarName === 'string' && body.google.calendarName.trim()) {
    patch.google.calendarName = body.google.calendarName.trim();
  }
  if (body.google?.clientSecret) patch.google.clientSecret = body.google.clientSecret.trim();
  // A pasted credentials file wins over the individual fields.
  if (body.google?.credentialsJson?.trim()) {
    Object.assign(patch.google, credentialsFromJson(body.google.credentialsJson));
  }

  if (body.sync?.intervalMinutes !== undefined) {
    patch.sync.intervalMinutes = Math.max(5, Number(body.sync.intervalMinutes) || 30);
  }
  for (const k of ['eventTitleTemplate', 'timezone']) {
    if (typeof body.sync?.[k] === 'string' && body.sync[k].trim()) patch.sync[k] = body.sync[k].trim();
  }
  if (body.sync?.reminderMinutes === null || body.sync?.reminderMinutes === '') {
    patch.sync.reminderMinutes = null;
  } else if (body.sync?.reminderMinutes !== undefined) {
    patch.sync.reminderMinutes = Math.max(0, Number(body.sync.reminderMinutes) || 0);
  }
  if (body.sync?.allowEmptyPurge !== undefined) {
    patch.sync.allowEmptyPurge = Boolean(body.sync.allowEmptyPurge);
  }
  return patch;
}

const routes = {
  'GET /api/state': ({ json }) =>
    json(200, {
      config: redactConfig(loadConfig()),
      scheduler: scheduler.status(),
      state: loadState(),
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      redirectUri: REDIRECT_URI,
    }),

  'POST /api/config': ({ body, json }) => {
    const saved = updateConfig(configPatchFrom(body || {}));
    scheduler.restart(); // pick up a changed interval without losing the on/off state
    json(200, { config: redactConfig(saved) });
  },

  'GET /api/google/auth-url': ({ json }) => json(200, { url: authUrl(loadConfig().google, REDIRECT_URI) }),

  'GET /oauth2callback': async ({ url, send }) => {
    const page = (title, body) => send(200, html(title, body), { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.searchParams.get('error')) {
      return page('Authorisation cancelled', url.searchParams.get('error'));
    }
    try {
      const refreshToken = await exchangeCode(
        loadConfig().google,
        REDIRECT_URI,
        url.searchParams.get('code'),
      );
      updateConfig({ google: { refreshToken } });
      logger.info('Google Calendar connected.');
      page('Google Calendar connected', 'You can close this tab and return to the app.');
    } catch (e) {
      logger.error(`OAuth exchange failed: ${e.message}`);
      page('Could not connect', e.message);
    }
  },

  'POST /api/jobcan/test': async ({ json }) => {
    const { shifts, pages, debugFiles } = await fetchShifts(loadConfig().jobcan, { debug: true });
    json(200, { ok: true, count: shifts.length, pages, debugFiles, sample: shifts.slice(0, 10) });
  },

  'POST /api/sync/now': async ({ json }) => json(200, await runSync()),
  'POST /api/sync/start': ({ json }) => json(200, scheduler.start()),
  'POST /api/sync/stop': ({ json }) => json(200, scheduler.stop()),

  'GET /api/logs': ({ url, json }) =>
    json(200, { lines: logger.recentLogs(Number(url.searchParams.get('limit')) || 200) }),
};

ensureDataDir();
const server = createServer({ staticDir: path.join(__dirname, 'web'), routes });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use — is the app already running?`);
    process.exit(1);
  }
  logger.error(`Server error: ${e.message}`);
});

server.listen(PORT, HOST, () => {
  logger.info(`Jobcan → Google Calendar sync UI on http://${HOST}:${PORT}`);
  logger.info(`Data directory: ${DATA_DIR}`);
  // Survive restarts: if the user had syncing on, turn it back on.
  if (loadConfig().sync.enabled) {
    logger.info('Sync was enabled before shutdown — resuming schedule.');
    scheduler.start({ persist: false });
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info(`Received ${sig} — shutting down.`);
    scheduler.stop({ persist: false });
    server.close();
    process.exit(0);
  });
}
