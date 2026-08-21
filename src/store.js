import fs from 'node:fs';
import crypto from 'node:crypto';
import { CONFIG_FILE, KEY_FILE, STATE_FILE, ensureDataDir } from './paths.js';

// AES-256-GCM at rest with a 0600 key file. This stops casual disclosure
// (backups, Spotlight, an accidental screen share) but it is NOT protection
// against someone who already has your user account -- they can read the key.
function loadKey() {
  ensureDataDir();
  try {
    const key = fs.readFileSync(KEY_FILE);
    if (key.length === 32) return key;
  } catch {
    /* generate below */
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const DEFAULT_CONFIG = {
  jobcan: {
    email: '',
    password: '',
    // Posted as user[client_code] on the id.jobcan.jp sign-in form.
    clientCode: '',
    shiftUrl: 'https://ssl.jobcan.jp/employee/shift-schedule',
    monthsAhead: 2,
    monthsBehind: 0,
  },
  google: {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    // Filled in by the app when it creates its own calendar. Never user-chosen:
    // the app.created scope means this is the only calendar we can write to.
    calendarId: '',
    calendarName: 'Jobcan Shifts',
  },
  sync: {
    intervalMinutes: 30,
    enabled: false,
    eventTitleTemplate: 'Shift{{#note}} ({{note}}){{/note}}',
    reminderMinutes: null, // null = use calendar default
    timezone: 'Asia/Tokyo',
  },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  ensureDataDir();
  let config;
  try {
    config = deepMerge(DEFAULT_CONFIG, JSON.parse(decrypt(fs.readFileSync(CONFIG_FILE))));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  // Migration: builds before the app.created scope targeted the user's primary
  // calendar. That id is unusable now, and keeping it would only cause a 403.
  if (config.google.calendarId === 'primary') config.google.calendarId = '';
  return config;
}

export function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, encrypt(JSON.stringify(config, null, 2)), { mode: 0o600 });
  return config;
}

export function updateConfig(patch) {
  return saveConfig(deepMerge(loadConfig(), patch));
}

// Never let a secret reach the browser. The UI only needs to know whether a
// field is populated.
export function redactConfig(config) {
  return {
    jobcan: {
      email: config.jobcan.email,
      clientCode: config.jobcan.clientCode,
      shiftUrl: config.jobcan.shiftUrl,
      monthsAhead: config.jobcan.monthsAhead,
      monthsBehind: config.jobcan.monthsBehind,
      hasPassword: Boolean(config.jobcan.password),
    },
    google: {
      clientId: config.google.clientId,
      calendarId: config.google.calendarId,
      calendarName: config.google.calendarName,
      hasClientSecret: Boolean(config.google.clientSecret),
      connected: Boolean(config.google.refreshToken),
    },
    sync: config.sync,
  };
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRunAt: null, lastResult: null, lastError: null, running: false };
  }
}

export function saveState(patch) {
  ensureDataDir();
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
