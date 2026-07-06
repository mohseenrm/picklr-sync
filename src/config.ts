function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function bool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

/**
 * Google's calendar settings URL exposes the calendar id base64-encoded, and
 * it's easy to paste that form by mistake. A real id is either "primary" or
 * contains "@". If the value has no "@" but base64-decodes to something that
 * does, use the decoded id.
 */
function normalizeCalendarId(value: string): string {
  const v = value.trim();
  if (v === "primary" || v.includes("@")) return v;
  try {
    const decoded = Buffer.from(v, "base64").toString("utf-8");
    if (decoded.includes("@")) return decoded.trim();
  } catch {
    /* not base64 — fall through */
  }
  return v;
}

export const config = {
  picklr: {
    email: env("PICKLR_EMAIL"),
    password: env("PICKLR_PASSWORD"),
    baseUrl: optEnv("PICKLR_BASE_URL", "https://fremont.thepicklr.com").replace(/\/$/, ""),
    get loginUrl() {
      return `${this.baseUrl}/users/sign_in`;
    },
    // Picklr (PlayByPoint) renders the member's bookings server-side here.
    get reservationsUrl() {
      return `${this.baseUrl}/account/reservations`;
    },
    // Physical venue address, used as the calendar event location base.
    venueAddress: optEnv(
      "PICKLR_VENUE_ADDRESS",
      "124 N 35th St, Seattle, WA 98103"
    ),
  },

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    calendarId: normalizeCalendarId(optEnv("GOOGLE_CALENDAR_ID", "primary")),
  },

  resend: {
    apiKey: env("RESEND_API_KEY"),
  },

  notification: {
    fromEmail: optEnv("FROM_EMAIL", "onboarding@resend.dev"),
    email: env("NOTIFICATION_EMAIL"),
    onNoChanges: bool("NOTIFY_ON_NO_CHANGES", false),
  },

  behavior: {
    timezone: optEnv("TIMEZONE", "America/Los_Angeles"),
    daysAhead: parseInt(optEnv("DAYS_AHEAD", "30"), 10),
    dryRun: bool("DRY_RUN", false),
  },

  browser: {
    headed: bool("HEADED", false),
    timeout: 30_000,
    navigationTimeout: 60_000,
  },

  retry: {
    maxAttempts: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
  },
} as const;

/**
 * Config used at module load throws if required Picklr/Resend/Google vars are
 * missing. `auth:google` needs only the OAuth client vars, so it builds its own
 * minimal client and never imports this module.
 */
