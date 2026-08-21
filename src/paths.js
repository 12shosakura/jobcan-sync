import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Everything lives outside the source tree so `git clean` / reinstalls never
// wipe the user's credentials.
export const DATA_DIR =
  process.env.JOBCAN_SYNC_DATA_DIR || path.join(os.homedir(), '.jobcan-gcal-sync');

export const CONFIG_FILE = path.join(DATA_DIR, 'config.enc');
export const KEY_FILE = path.join(DATA_DIR, 'key');
export const LOG_FILE = path.join(DATA_DIR, 'sync.log');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const DEBUG_DIR = path.join(DATA_DIR, 'debug');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DEBUG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {
    /* best effort */
  }
  return DATA_DIR;
}
