# Jobcan → Google Calendar Sync

Signs in to Jobcan over plain HTTP, scrapes your shift page HTML, and mirrors the
shifts into a Google Calendar every 30 minutes. Runs entirely on your own machine.

### The login flow

No headless browser is involved — Jobcan's sign-in is an ordinary Rails form, so a
cookie jar over `fetch` is enough:

1. `GET https://id.jobcan.jp/users/sign_in` — collect cookies and the
   `authenticity_token`.
2. `POST https://id.jobcan.jp/users/sign_in` with `user[email]`,
   `user[password]` and `user[client_code]`, replaying the form's own hidden
   fields.
3. `GET https://ssl.jobcan.jp/jbcoauth/login` — bridges the Common-ID session
   into an employee session on `ssl.jobcan.jp`. Skipping this step makes every
   shift page bounce back to the login form.
4. `GET` the shift page for each month and scrape the table.

**One-way by design.** Nothing is ever written back to Jobcan.

**It cannot touch your existing calendars.** The app requests a single OAuth scope,
[`calendar.app.created`](https://developers.google.com/calendar/api/auth) — *"Make
secondary Google calendars, and see, create, change, and delete events on them."*
That grants access only to calendars this app created itself. Your personal and
work calendars are not readable, let alone writable, and Google enforces that
boundary rather than the app policing itself.

On the first sync the app creates one calendar of its own (default name **Jobcan
Shifts**) and writes only there. Inside that calendar it still only touches events
carrying its private `jobcanSync=1` tag, so anything you add there by hand
survives.

## Setup

```bash
npm install
```

The only runtime dependency is `cheerio` for HTML parsing.

### Google OAuth credentials

**Why you have to create these.** "Sign in with Google" buttons in other apps work
without any setup because *that app's developer* registered an OAuth client and
shipped its client ID inside the app. Google will not let anything touch the
Calendar API without a client registered in some Cloud project, and this app has
no developer-owned client to ship you — so the client has to be yours. Two
consolations: for a Desktop client the "secret" is
[explicitly not treated as confidential](https://developers.google.com/identity/protocols/oauth2)
(it is an identifier, not a credential), and owning the client yourself means no
shared secret, no dependence on anyone else's project, and you can revoke it at
any time from your own console.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project
   and enable the **Google Calendar API**.
2. Configure the OAuth consent screen, user type **External**, and add yourself as
   a user.
3. **Set the publishing status to "In production".** See the warning below — this
   one matters more than it looks.
4. Create an **OAuth client ID** of type **Desktop app**, then **Download JSON**.
   The consent screen will ask only for permission to make secondary calendars and
   manage events on them — not for access to your existing calendars.
5. Paste the whole `client_secret_….json` into the app and press
   **Connect Google Calendar**.

Google will warn that the app is unverified. That is expected: verification is a
review process for apps published to the public, and this one only ever talks to
your own account. Click **Advanced → Go to … (unsafe)** to continue.

> #### ⚠ Do not leave the consent screen in "Testing"
>
> With an **External** consent screen in **Testing** status, Google expires
> refresh tokens after **7 days** — for every scope except basic profile info.
> A background sync would then die silently once a week and need reconnecting by
> hand. Setting the publishing status to **In production** removes that expiry.
> Unverified is fine; *Testing* is not.
>
> If syncing does stop with `invalid_grant`, the app says so in the log and the
> fix is to press **Connect Google Calendar** again — but check the publishing
> status first, or it will just happen again next week.
>
> (Google Workspace accounts can instead use user type **Internal**, which has no
> such expiry and no unverified warning.)

## Running it

```bash
npm start
```

Then open <http://127.0.0.1:5675>, fill in the three sections, and press
**Start Syncing**.

### Run it in the background at login

```bash
npm run install-service
```

This registers a macOS LaunchAgent (`com.jobcan.gcal-sync`) that starts the app at
login and restarts it if it crashes. The UI stays at
<http://127.0.0.1:5675>. Remove it with `npm run uninstall-service`.

```bash
launchctl list | grep jobcan     # check it is loaded
tail -f ~/.jobcan-gcal-sync/sync.log
```

## How the sync works

Each run crawls the current month plus the configured look-ahead, then reconciles
that window:

| Jobcan | Calendar |
| --- | --- |
| new shift | event created |
| shift time or name changed | existing event updated in place |
| shift removed | the event we created is deleted |
| unchanged | left alone (no API write) |

Events are keyed by `date#ordinal`, so a shift that moves by an hour is *updated*
rather than deleted and recreated — your reminders and any calendar-side
notifications stay intact.

Overnight shifts are handled: Jobcan's `22:00～26:00` becomes 22:00 → 02:00 the
next day.

### The empty-scrape guard

If a scrape returns **zero** shifts, the calendar is left untouched and a warning
is logged. A broken parser and a genuinely empty roster look identical from the
outside, and only one of them should be allowed to wipe three months of events.
If your roster really is empty and you want the events removed, tick
*"Allow an empty scrape to delete synced events"*.

## If no shifts are found

Jobcan's markup differs between tenants. Press **Test Jobcan login & scrape** —
it reports what it found per month and saves the raw HTML to
`~/.jobcan-gcal-sync/debug/`.

If the bundled parser can't read your tenant's layout, drop a custom parser at
`~/.jobcan-gcal-sync/parser.mjs`; it is picked up automatically on the next run.

```js
// ~/.jobcan-gcal-sync/parser.mjs
export function parse(html, { year, month }) {
  return {
    shifts: [
      {
        date: '2026-08-03',                        // YYYY-MM-DD
        start: { hhmm: '09:00', dayOffset: 0 },
        end:   { hhmm: '18:00', dayOffset: 0 },    // dayOffset 1 = ends next day
        note:  '早番',                              // or null
      },
    ],
  };
}
```

The bundled parser tries a list-style table first, then a month-grid calendar,
and keeps whichever yields more rows. It reads the month from the page heading
when present, so bare day numbers still resolve correctly.

## Where your credentials live

Everything is under `~/.jobcan-gcal-sync/` (mode `0700`):

| File | Contents |
| --- | --- |
| `config.enc` | AES-256-GCM encrypted config: Jobcan password, Google client secret, refresh token |
| `key` | The encryption key, mode `0600` |
| `sync.log` | Activity log |
| `debug/` | Saved HTML from failed or empty scrapes |

**Be clear about what that encryption does.** It stops your password showing up in
plain text in a backup, a Time Machine snapshot, or an accidental screen share.
It does *not* protect against someone who already has access to your user
account — the key sits next to the file, and it has to, because the daemon must
start unattended. Treat this as "not lying around in plaintext", not as a vault.

The web UI never receives your secrets back: it is only told *whether* each one is
set. The server binds to `127.0.0.1` only and rejects any request whose `Host`
header isn't loopback, which blocks DNS-rebinding attacks from a web page you
happen to have open.

Debug HTML dumps are pages from inside your logged-in Jobcan session. Look before
you share one.

## Two things to know before you rely on it

- **2FA and SSO aren't supported.** The login posts email, password and client
  code to the standard form. If your account requires a second factor or a
  corporate SSO redirect, the login will fail and the test button will say so.
- **Scraping is brittle by nature.** The API is unavailable, so this reads HTML.
  If Jobcan redesigns the shift page, syncing stops and the empty-scrape guard
  keeps your calendar intact until you fix the parser.

## Configuration reference

| Setting | Default | Notes |
| --- | --- | --- |
| Client code | *(blank)* | Posted as `user[client_code]`; leave blank if your sign-in page does not ask for one |
| Shift page URL | `https://ssl.jobcan.jp/employee/shift-schedule` | `year`/`month` params are appended per month |
| Months back / ahead | 0 / 2 | Also defines the reconciliation window |
| Interval | 30 min | Floor of 5 min |
| Event title | `Shift{{#note}} ({{note}}){{/note}}` | `{{note}}` `{{date}}` `{{start}}` `{{end}}` |
| Calendar name | `Jobcan Shifts` | The app creates and owns this calendar; renaming it here renames it in Google |
| Time zone | `Asia/Tokyo` | |

Environment overrides: `JOBCAN_SYNC_PORT`, `JOBCAN_SYNC_DATA_DIR`.

## Tests

```bash
npm test
```

Covers the shift parser, event building, the sync window, the cookie jar, and the
full login-and-scrape flow against a mocked Jobcan.
