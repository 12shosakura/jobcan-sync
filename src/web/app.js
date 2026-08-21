const $ = (id) => document.getElementById(id);

const api = async (url, options) => {
  const res = await fetch(url, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Split deliberately: the dashboard polls every 10s, and writing to an input the
// user is currently typing in would wipe their keystrokes. Form fields are
// populated once on load (and after an explicit save, where the server value is
// canonical); everything else is safe to repaint on every poll.
let formPopulated = false;

function renderForm(config) {
  const { jobcan, google, sync } = config;

  $('jobcanEmail').value = jobcan.email || '';
  $('jobcanClientCode').value = jobcan.clientCode || '';
  $('shiftUrl').value = jobcan.shiftUrl || '';
  $('monthsBehind').value = jobcan.monthsBehind ?? 0;
  $('monthsAhead').value = jobcan.monthsAhead ?? 2;

  $('googleClientId').value = google.clientId || '';
  $('calendarName').value = google.calendarName || '';
  // jobcanPassword / googleClientSecret are intentionally never written here:
  // the server never sends secrets back, so writing would only ever blank them.

  $('intervalMinutes').value = sync.intervalMinutes;
  $('timezone').value = sync.timezone;
  $('eventTitleTemplate').value = sync.eventTitleTemplate;
  $('reminderMinutes').value = sync.reminderMinutes ?? '';
  $('allowEmptyPurge').checked = Boolean(sync.allowEmptyPurge);

  formPopulated = true;
}

function renderStatus({ config, scheduler, state, logFile, redirectUri }) {
  const { jobcan, google, sync } = config;

  $('passwordHint').textContent = jobcan.hasPassword
    ? 'A password is saved. Leave blank to keep it.'
    : 'No password saved yet.';
  $('secretHint').textContent = google.hasClientSecret
    ? 'A secret is saved. Leave blank to keep it.'
    : 'No secret saved yet.';
  $('googleStatus').textContent = google.connected ? '✓ Connected' : 'Not connected';
  $('googleStatus').classList.toggle('error', !google.connected);
  // Renames are applied by ensureCalendar(), so they land on the next sync.
  $('calendarIdHint').textContent = google.calendarId
    ? `Linked to calendar ${google.calendarId} — renaming applies on the next sync.`
    : 'The calendar is created automatically on the first sync.';

  $('redirectUri').textContent = redirectUri;
  $('logFile').textContent = logFile;

  const on = scheduler.enabled;
  $('statusDot').className = `dot ${state.lastError && !on ? 'err' : on ? 'on' : ''}`;
  $('statusText').textContent = on ? 'Syncing is on' : 'Syncing is off';
  $('statusDetail').textContent = on
    ? `Every ${scheduler.intervalMinutes} min · next run ${fmtTime(scheduler.nextRunAt)}`
    : 'Press Start Syncing to run every ' + sync.intervalMinutes + ' minutes.';
  $('startBtn').classList.toggle('hidden', on);
  $('stopBtn').classList.toggle('hidden', !on);

  const last = state.lastResult;
  const el = $('lastResult');
  el.classList.toggle('error', Boolean(state.lastError));
  if (state.lastError) {
    el.textContent = `Last run failed at ${fmtTime(state.lastError.at)} — ${state.lastError.message}`;
  } else if (last) {
    const st = last.stats || {};
    el.textContent =
      `Last run ${fmtTime(last.finishedAt)} · ${last.shifts} shift(s) · ` +
      `${st.created} created, ${st.updated} updated, ${st.deleted} deleted, ${st.unchanged} unchanged` +
      (last.warning ? ` · ⚠ ${last.warning}` : '');
  } else {
    el.textContent = 'No sync has run yet.';
  }
}

async function refresh({ repopulateForm = false } = {}) {
  try {
    const data = await api('/api/state');
    if (repopulateForm || !formPopulated) renderForm(data.config);
    renderStatus(data);
  } catch (e) {
    $('statusText').textContent = `Cannot reach the sync service — ${e.message}`;
  }
}

async function refreshLogs() {
  try {
    const { lines } = await api('/api/logs?limit=120');
    const box = $('logs');
    const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.textContent = lines
      .map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.message}`)
      .join('\n');
    if (pinned) box.scrollTop = box.scrollHeight;
  } catch {
    /* the service may be restarting; the next poll will catch up */
  }
}

function collectConfig() {
  return {
    jobcan: {
      email: $('jobcanEmail').value,
      clientCode: $('jobcanClientCode').value,
      password: $('jobcanPassword').value, // blank keeps the stored one
      shiftUrl: $('shiftUrl').value,
      monthsBehind: $('monthsBehind').value,
      monthsAhead: $('monthsAhead').value,
    },
    google: {
      clientId: $('googleClientId').value,
      clientSecret: $('googleClientSecret').value,
      credentialsJson: $('googleCredentialsJson').value,
      calendarName: $('calendarName').value,
    },
    sync: {
      intervalMinutes: $('intervalMinutes').value,
      timezone: $('timezone').value,
      eventTitleTemplate: $('eventTitleTemplate').value,
      reminderMinutes: $('reminderMinutes').value === '' ? null : $('reminderMinutes').value,
      allowEmptyPurge: $('allowEmptyPurge').checked,
    },
  };
}

async function save() {
  const hadJson = Boolean($('googleCredentialsJson').value.trim());
  await api('/api/config', { method: 'POST', body: JSON.stringify(collectConfig()) });

  // Deliberately do NOT clear the password or client secret. save() runs from
  // four buttons (Save, Test, Connect, Start), so blanking them made a field the
  // user had just filled in appear to reset itself. They are masked inputs on a
  // loopback-only page, and the value is already stored encrypted on disk.
  // The pasted credentials file is different: it has been parsed into the Client
  // ID / secret fields, so leaving the raw blob would just be clutter.
  if (hadJson) {
    $('googleCredentialsJson').value = '';
    $('jsonHint').textContent = '✓ Credentials read from the pasted file.';
  }
  await refresh({ repopulateForm: true });
}

$('saveBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Saving…', async () => {
    try {
      await save();
      $('saveStatus').textContent = 'Saved.';
      $('saveStatus').classList.remove('error');
    } catch (err) {
      $('saveStatus').textContent = err.message;
      $('saveStatus').classList.add('error');
    }
    setTimeout(() => ($('saveStatus').textContent = ''), 4000);
  }),
);

$('testJobcanBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Testing… (up to a minute)', async () => {
    const box = $('jobcanResult');
    box.classList.remove('hidden');
    box.textContent = 'Saving settings, launching a browser and logging in…';
    try {
      await save();
      const r = await api('/api/jobcan/test', { method: 'POST' });
      box.textContent =
        `Found ${r.count} shift(s).\n\n` +
        r.pages.map((p) => `  ${p.from} → ${p.to}: ${p.count} shift(s) [${p.strategy}]`).join('\n') +
        (r.sample.length
          ? `\n\nSample:\n${r.sample.map((s) => `  ${s.date}  ${s.start.hhmm}–${s.end.hhmm}  ${s.note || ''}`).join('\n')}`
          : '\n\nNo shifts parsed.') +
        (r.debugFiles?.length ? `\n\nSaved page HTML for inspection:\n${r.debugFiles.map((f) => `  ${f}`).join('\n')}` : '');
    } catch (err) {
      box.textContent = `Failed: ${err.message}`;
    }
  }),
);

$('connectGoogleBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Opening Google…', async () => {
    try {
      await save();
      const { url } = await api('/api/google/auth-url');
      window.open(url, '_blank', 'noopener');
      $('googleStatus').textContent = 'Finish the consent screen in the new tab…';
    } catch (err) {
      $('googleStatus').textContent = err.message;
      $('googleStatus').classList.add('error');
    }
  }),
);


$('startBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Starting…', async () => {
    await save();
    await api('/api/sync/start', { method: 'POST' });
    await refresh();
  }),
);

$('stopBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Stopping…', async () => {
    await api('/api/sync/stop', { method: 'POST' });
    await refresh();
  }),
);

$('syncNowBtn').addEventListener('click', (e) =>
  withBusy(e.target, 'Syncing…', async () => {
    try {
      await api('/api/sync/now', { method: 'POST' });
    } catch {
      /* the failure shows up in the status line and log */
    }
    await refresh();
  }),
);

refresh();
refreshLogs();
setInterval(refresh, 10_000);
setInterval(refreshLogs, 5_000);
