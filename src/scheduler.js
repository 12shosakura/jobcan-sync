import { runSync } from './sync.js';
import { loadConfig, updateConfig, saveState } from './store.js';
import * as logger from './logger.js';

let timer = null;
let nextRunAt = null;

function intervalMs() {
  const minutes = Number(loadConfig().sync.intervalMinutes) || 30;
  return Math.max(5, minutes) * 60_000; // a floor keeps us from hammering Jobcan
}

async function tick() {
  try {
    await runSync();
  } catch {
    // runSync already logged and recorded the failure; the schedule continues
    // so a transient outage doesn't silently stop syncing.
  }
  if (timer) nextRunAt = new Date(Date.now() + intervalMs()).toISOString();
}

export function isRunning() {
  return timer !== null;
}

export function status() {
  return { enabled: isRunning(), nextRunAt, intervalMinutes: loadConfig().sync.intervalMinutes };
}

export function start({ persist = true, runNow = true } = {}) {
  if (timer) return status();
  const ms = intervalMs();
  timer = setInterval(tick, ms);
  nextRunAt = new Date(Date.now() + ms).toISOString();
  if (persist) updateConfig({ sync: { enabled: true } });
  logger.info(`Scheduler started — syncing every ${ms / 60_000} minute(s).`);
  if (runNow) tick();
  return status();
}

export function stop({ persist = true } = {}) {
  if (timer) clearInterval(timer);
  timer = null;
  nextRunAt = null;
  if (persist) updateConfig({ sync: { enabled: false } });
  saveState({ running: false });
  logger.info('Scheduler stopped.');
  return status();
}

export function restart() {
  const wasRunning = isRunning();
  stop({ persist: false });
  if (wasRunning) start({ persist: false, runNow: false });
  return status();
}
