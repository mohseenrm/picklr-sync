# picklr-sync

Crawls your [Picklr](https://fremont.thepicklr.com) reservations each morning, syncs them to Google Calendar (adds new, updates changed, removes cancelled), and emails you a status summary via [Resend](https://resend.com).

Runs locally or on a daily GitHub Actions cron. Built with Playwright (stealth Chromium clears Picklr's Cloudflare challenge).

## How it works

1. Logs into Picklr via headless Chromium (Devise login, stealth plugin clears the Cloudflare "Just a moment" challenge).
2. Scrapes your upcoming reservations from the member dashboard.
3. Diffs them against the calendar events it previously created (matched by a stable `picklrId` tag) and reconciles: **add** new bookings, **update** changed ones, **remove** cancelled ones.
4. Emails you what changed (or nothing, unless `NOTIFY_ON_NO_CHANGES=true`).

## Quick start (local)

```bash
cd picklr-sync
pnpm install
pnpm exec playwright install chromium

cp .env.example .env
# fill in PICKLR_* and RESEND/NOTIFICATION vars

# 1) Mint a Google refresh token (one time)
#    First: create an OAuth 2.0 Client (Desktop app) in Google Cloud Console
#    and enable the Google Calendar API. Put CLIENT_ID/SECRET in .env, then:
pnpm auth:google
#    → follow the URL, approve, paste GOOGLE_REFRESH_TOKEN into .env

# 2) Dry run — crawl + compute the diff, write NOTHING, print the plan
pnpm sync:dry

# 3) Watch the browser drive the login (debug selectors)
pnpm sync:headed

# 4) For real
pnpm sync
```

### Recommended first run

Use headed + dry-run together so you can watch the login and see the computed plan without touching your calendar:

```bash
HEADED=true DRY_RUN=true pnpm sync
```

If login or scraping fails, the crawler writes `debug-*.png` and `debug-*.html` snapshots of the page it got stuck on — open them to tune selectors in [`src/crawler.ts`](src/crawler.ts).

## Configuration

All via environment variables — see [`.env.example`](.env.example).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PICKLR_EMAIL` / `PICKLR_PASSWORD` | Yes | — | Picklr login |
| `PICKLR_BASE_URL` | No | `https://fremont.thepicklr.com` | Change subdomain for other locations |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Yes | — | OAuth Desktop-app client |
| `GOOGLE_REFRESH_TOKEN` | Yes | — | From `pnpm auth:google` |
| `GOOGLE_CALENDAR_ID` | No | `primary` | Or a dedicated calendar ID |
| `RESEND_API_KEY` | Yes | — | Resend API key |
| `FROM_EMAIL` | No | `onboarding@resend.dev` | Verified sender (or Resend's test sender) |
| `NOTIFICATION_EMAIL` | Yes | — | Where the status email goes |
| `TIMEZONE` | No | `America/Los_Angeles` | IANA tz for rendering + event times |
| `DAYS_AHEAD` | No | `30` | Only sync bookings within N days (`0` = no limit) |
| `DRY_RUN` | No | `false` | Compute the plan, write nothing |
| `HEADED` | No | `false` | Show the browser |
| `NOTIFY_ON_NO_CHANGES` | No | `false` | Email even when nothing changed |

## Tuning the scraper

Picklr's reservation markup varies by location/theme, so [`src/crawler.ts`](src/crawler.ts) uses a resilient strategy: it probes several likely booking URLs and extracts any row containing both a date and a time range, guessing the title/location. If your dashboard uses different markup, run `pnpm sync:dry` (or headed), inspect the `debug-*.html` dump, and tighten the selectors in `extractRows()`.

Idempotency is by design: every calendar event carries `extendedProperties.private.picklrId` (Picklr's own lesson/reservation id, e.g. `pk-4004219`, falling back to a hash of start+title). Each run lists the events it previously created, then **adds** new bookings, **updates** changed ones (time/title/location/reminders), and **removes** cancelled ones. Re-running is safe and converges — it only ever touches events it created and never reads or modifies your other calendar entries.

Every synced event also: adds you as an accepted guest, sets popup reminders at **26 h / 30 m / 15 m / 10 m** (the 26 h one gives lead time to cancel), and sets the location to your venue address plus any court detail.

## GitHub Actions (daily cron)

The workflow in [`.github/workflows/sync.yml`](.github/workflows/sync.yml) runs each morning (~6:15 AM Pacific) and on manual dispatch.

1. Push to GitHub.
2. **Settings → Secrets and variables → Actions → Secrets** (New repository secret):

   | Secret | Value |
   |---|---|
   | `PICKLR_EMAIL` | your Picklr login email |
   | `PICKLR_PASSWORD` | your Picklr password |
   | `GOOGLE_CLIENT_ID` | OAuth client id |
   | `GOOGLE_CLIENT_SECRET` | OAuth client secret |
   | `GOOGLE_REFRESH_TOKEN` | from `pnpm auth:google` |
   | `GOOGLE_CALENDAR_ID` | e.g. `…@group.calendar.google.com` |
   | `RESEND_API_KEY` | Resend API key |
   | `NOTIFICATION_EMAIL` | where status emails go |

3. **Variables** tab (optional — defaults apply if omitted): `PICKLR_BASE_URL`, `PICKLR_VENUE_ADDRESS`, `FROM_EMAIL`, `TIMEZONE`, `DAYS_AHEAD`, `NOTIFY_ON_NO_CHANGES`.
4. Test first: **Actions → Sync Picklr to Calendar → Run workflow**, tick **dry run**. Then run once for real.
5. The cron then runs daily automatically.

> **DST note:** GitHub cron is UTC and doesn't observe daylight saving, so the workflow schedules both `15 13` and `15 14` UTC to stay near 6:15 AM Pacific year-round. Both fire (an hour apart); the "off-season" one just produces a 0-change no-op run — harmless because the sync is idempotent. Set `NOTIFY_ON_NO_CHANGES` to `false` (or leave unset) so those no-op runs stay quiet.

On failure the workflow uploads the `debug-*` page snapshots as an artifact for inspection.

### Cost

| Service | Free tier | Typical usage |
|---|---|---|
| GitHub Actions | 2,000 min/mo | ~30 min/mo |
| Resend | 3,000 emails/mo | ~30/mo |
| Google Calendar API | free | tiny |

## Project structure

```
picklr-sync/
├── src/
│   ├── main.ts               # Orchestrator: crawl → sync → notify
│   ├── config.ts             # Env-driven config
│   ├── crawler.ts            # Playwright login + scrape reservations
│   ├── calendar.ts           # Google Calendar reconcile (add/update/remove)
│   ├── notify.ts             # Resend email + template rendering
│   ├── retry.ts              # Exponential backoff
│   ├── types.ts              # Shared Booking / SyncSummary types
│   └── scripts/
│       └── google-auth.ts    # One-time OAuth refresh-token helper
├── emails/notification.html  # Email template
└── .github/workflows/sync.yml
```

## License

ISC
