import fs from 'node:fs';
import { LOG_FILE, ensureDataDir } from './paths.js';

const MAX_MEMORY_LINES = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const recent = [];

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(LOG_FILE);
    if (size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* no log file yet */
  }
}

export function log(level, message, extra) {
  ensureDataDir();
  const line = {
    ts: new Date().toISOString(),
    level,
    message: String(message),
    ...(extra ? { extra } : {}),
  };
  recent.push(line);
  if (recent.length > MAX_MEMORY_LINES) recent.shift();

  rotateIfNeeded();
  const text = `${line.ts} [${level.toUpperCase()}] ${line.message}${
    extra ? ` ${JSON.stringify(extra)}` : ''
  }\n`;
  try {
    fs.appendFileSync(LOG_FILE, text, { mode: 0o600 });
  } catch {
    /* never let logging break a sync */
  }
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(text);
}

export const info = (m, e) => log('info', m, e);
export const warn = (m, e) => log('warn', m, e);
export const error = (m, e) => log('error', m, e);

export function recentLogs(limit = 200) {
  return recent.slice(-limit);
}
