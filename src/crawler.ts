import { chromium } from "playwright-extra";
import type { Browser, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "./config.js";
import { withRetry, sleep } from "./retry.js";
import { makeBookingId } from "./calendar.js";
import type { Booking } from "./types.js";

chromium.use(StealthPlugin());

/** Raw scrape shape emitted from inside page.evaluate (all strings). */
interface RawBooking {
  title: string;
  dateText: string;
  timeText: string;
  location: string;
  category: string;
  /** Stable source id from Picklr (lesson_id / reservation id), if found. */
  sourceId: string;
  raw: string;
}

/**
 * Log into Picklr, find the member's reservations, and return them normalized.
 * Picklr is a Rails/Devise app fronted by Cloudflare, so we drive a stealth
 * Chromium to clear the JS challenge and keep a real session.
 */
export async function crawlBookings(): Promise<Booking[]> {
  const browser = await chromium.launch({ headless: !config.browser.headed });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: config.behavior.timezone,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.timeout);
    page.setDefaultNavigationTimeout(config.browser.navigationTimeout);

    await login(page);
    const raws = await scrapeReservations(page);
    console.log(`[crawler] Scraped ${raws.length} raw reservation row(s)`);

    const bookings = normalize(raws);
    return dedupeAndFilter(bookings);
  } finally {
    await browser.close();
  }
}

async function login(page: Page): Promise<void> {
  console.log("[crawler] Navigating to login...");

  await withRetry(async () => {
    await page.goto(config.picklr.loginUrl, { waitUntil: "domcontentloaded" });
    await clearCloudflareChallenge(page);

    // Devise default: input#user_email / input#user_password. Fall back to
    // name/type/placeholder so we survive minor markup changes.
    const email = firstVisible(page, [
      "input#user_email",
      "input[name='user[email]']",
      "input[type='email']",
      "input[placeholder*='mail' i]",
    ]);
    const password = firstVisible(page, [
      "input#user_password",
      "input[name='user[password]']",
      "input[type='password']",
      "input[placeholder*='assword' i]",
    ]);

    const emailEl = await email();
    if (!emailEl) {
      await dumpDebug(page, "login-no-form");
      throw new Error(
        `Login form not found at ${page.url()} (title: ${await page.title()})`
      );
    }
    await emailEl.fill(config.picklr.email);

    const pwEl = await password();
    if (!pwEl) throw new Error("Password field not found on login page");
    await pwEl.fill(config.picklr.password);

    // Submit: the Devise "Log in" button/input.
    const submit = firstVisible(page, [
      "input[type='submit'][value*='Log' i]",
      "button[type='submit']",
      "input[type='submit']",
    ]);
    const submitEl = await submit();
    if (!submitEl) throw new Error("Submit button not found on login page");

    await submitEl.click();
    // Devise re-renders the page on both success and failure. Wait for the
    // navigation/network to settle, then let the flash animation populate.
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await sleep(1500);
    await clearCloudflareChallenge(page);

    if (page.url().includes("/sign_in")) {
      // Picklr renders the flash into #flash (initially display:none, shown via
      // JS), so read its text content directly rather than gating on visibility.
      const flash = await hiddenText(page, [
        "#flash .noti_container",
        "#flash",
        ".alert",
        "[role='alert']",
      ]);
      await dumpDebug(page, "login-failed");
      throw new Error(
        `Still on sign-in page after submit${flash ? ` — "${flash}"` : ""}. Check credentials.`
      );
    }
  });

  console.log(`[crawler] Logged in — landed on ${page.url()}`);
}

/**
 * Cloudflare's "Just a moment" interstitial runs JS then redirects. Stealth
 * usually clears it automatically; we just wait for the challenge markers to
 * disappear (or a Turnstile checkbox to settle).
 */
async function clearCloudflareChallenge(page: Page): Promise<void> {
  const title = (await page.title().catch(() => "")) || "";
  const isChallenge =
    /just a moment|attention required|checking your browser/i.test(title);
  if (!isChallenge) return;

  console.log("[crawler] Cloudflare challenge detected — waiting it out...");
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const t = (await page.title().catch(() => "")) || "";
    if (!/just a moment|attention required|checking your browser/i.test(t)) {
      console.log("[crawler] Challenge cleared");
      return;
    }
  }
  await dumpDebug(page, "cloudflare-stuck");
  throw new Error("Cloudflare challenge did not clear within timeout");
}

/**
 * Picklr (PlayByPoint) renders the member's bookings server-side at
 * /account/reservations across three sections: court Reservations, Priority
 * Requests, and Programs (clinics/socials). Each booking is a `.ui.segments`
 * card. We scrape all cards, extracting title / category / date / time and a
 * stable source id from the cancel link.
 */
async function scrapeReservations(page: Page): Promise<RawBooking[]> {
  await page.goto(config.picklr.reservationsUrl, {
    waitUntil: "domcontentloaded",
  });
  await clearCloudflareChallenge(page);
  await sleep(1500);

  if (page.url().includes("/sign_in")) {
    await dumpDebug(page, "reservations-gated");
    throw new Error("Redirected to sign-in when opening reservations page");
  }

  const rows = await extractRows(page);
  if (rows.length === 0) {
    // Not necessarily an error — the member may simply have no upcoming
    // bookings. Dump for inspection but return empty so the sync can prune.
    console.log("[crawler] No reservation cards found on /account/reservations");
    await dumpDebug(page, "no-reservations");
  }
  return rows;
}

/**
 * Extract each booking card. Runs in the page. Picklr markup (Semantic UI):
 *   .ui.segments                      ← one card
 *     .ui.label.uppercase             ← category ("Socials", "Court", …)
 *     a.big.black.bold.text           ← title
 *     .text.grey.semi.bold            ← facility/location
 *     .text.black.semi.bold           ← date "Mon, Jul 06"
 *     .text.grey > div                ← time "05:00 PM - 07:00 PM"
 *     a[href*='cancel'] / [href*='lesson_id'] / [href*='reservation']
 *                                     ← stable source id
 */
async function extractRows(page: Page): Promise<RawBooking[]> {
  // NOTE: the body is passed as a source string and reconstructed with
  // `new Function` inside the page. This sidesteps esbuild/tsx injecting a
  // `__name` helper into transpiled closures (which is undefined in the browser
  // and throws "__name is not defined"). Keep this self-contained — no closure
  // over outer TypeScript scope, plain ES5-ish syntax only.
  const extractFn = `() => {
    var TIME_RE = /\\d{1,2}:\\d{2}\\s*[AP]M\\s*-\\s*\\d{1,2}:\\d{2}\\s*[AP]M/i;
    var DATE_RE = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2}/i;
    function clean(s) { return (s || "").replace(/\\s+/g, " ").trim(); }

    var out = [];
    var ids = ["#reservations", "#priority_requests", "#clinics"];
    var roots = [];
    for (var i = 0; i < ids.length; i++) {
      var r = document.querySelector(ids[i]);
      if (r) roots.push(r);
    }
    if (roots.length === 0) roots.push(document.body);

    var cards = [];
    for (var j = 0; j < roots.length; j++) {
      var found = roots[j].querySelectorAll(".ui.segments");
      for (var k = 0; k < found.length; k++) {
        if (cards.indexOf(found[k]) === -1) cards.push(found[k]);
      }
    }

    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      var text = clean(card.textContent);
      var timeMatch = text.match(TIME_RE);
      var dateMatch = text.match(DATE_RE);
      if (!timeMatch || !dateMatch) continue;

      var titleEl = card.querySelector("a.big.black.bold.text")
        || card.querySelector(".big.black.bold.text")
        || card.querySelector("a[href*='/programs/']");
      var title = clean(titleEl && titleEl.textContent) || "Picklr Reservation";

      var labelEl = card.querySelector(".ui.label");
      var category = clean(labelEl && labelEl.textContent);

      var locEl = card.querySelector(".text.grey.semi.bold");
      var location = clean(locEl && locEl.textContent);

      var sourceId = "";
      var links = card.querySelectorAll("a[href]");
      for (var l = 0; l < links.length; l++) {
        var href = links[l].getAttribute("href") || "";
        var m = href.match(/lesson_id=(\\d+)/)
          || href.match(/reservations?\\/(\\d+)/)
          || href.match(/clinics\\/(\\d+)/);
        if (m) { sourceId = m[1]; break; }
      }

      out.push({
        title: title,
        dateText: dateMatch[0].trim(),
        timeText: timeMatch[0].trim(),
        location: location,
        category: category,
        sourceId: sourceId,
        raw: text.slice(0, 300)
      });
    }
    return out;
  }`;

  return page.evaluate<RawBooking[], string>((fnSrc) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("return (" + fnSrc + ")()");
    return fn() as RawBooking[];
  }, extractFn);
}

// ── Normalization ────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function normalize(raws: RawBooking[]): Booking[] {
  const out: Booking[] = [];
  const now = new Date();

  for (const r of raws) {
    const date = parseDate(r.dateText, now.getFullYear());
    const times = parseTimeRange(r.timeText);
    if (!date || !times) {
      console.log(
        `[crawler] Skipping unparseable row: "${r.title}" (${r.dateText} ${r.timeText})`
      );
      continue;
    }

    // If the parsed date is >2 months in the past, it likely belongs to next
    // year (e.g. scraping "Jan 5" in December).
    let year = date.year;
    const candidate = new Date(year, date.month, date.day);
    if (candidate.getTime() < now.getTime() - 60 * 86_400_000) {
      year += 1;
    }

    const start = composeIso(year, date.month, date.day, times.startH, times.startM);
    let end = composeIso(year, date.month, date.day, times.endH, times.endM);
    // Handle ranges crossing midnight (rare, but be safe).
    if (new Date(end) <= new Date(start)) {
      end = composeIso(year, date.month, date.day + 1, times.endH, times.endM);
    }

    const title = buildTitle(r);

    const booking: Booking = {
      id: "",
      title,
      start,
      end,
      location: r.location || undefined,
      raw: r.raw,
    };
    // Prefer Picklr's own id (stable across time/title edits); fall back to a
    // hash of start+title when the card had no id-bearing link.
    booking.id = r.sourceId
      ? `pk-${r.sourceId}`
      : makeBookingId(booking);
    out.push(booking);
  }

  return out;
}

/**
 * Build a calendar title. We classify the booking as Open Play / Lesson /
 * Reservation from its name + category, prefix a 🎾 tag for scannability, and
 * keep the specific program name. Examples:
 *   "DUPR Open Play - 4.0+" (Socials)   → "🎾 Open Play: DUPR Open Play - 4.0+"
 *   "Private Lesson w/ Coach"           → "🎾 Lesson: Private Lesson w/ Coach"
 *   "Court 3"                           → "🎾 Reservation: Court 3"
 */
function buildTitle(r: RawBooking): string {
  const hay = `${r.title} ${r.category}`.toLowerCase();
  let kind: string;
  if (/open play/.test(hay)) kind = "Open Play";
  else if (/lesson|clinic|coach|private|instruct/.test(hay)) kind = "Lesson";
  else kind = "Reservation";

  const name = r.title.trim() || kind;
  // Avoid "Open Play: ... Open Play" style stutter.
  const base = new RegExp(`^${kind}$`, "i").test(name)
    ? kind
    : `${kind}: ${name}`;
  return `🎾 ${base}`;
}

function parseDate(
  text: string,
  fallbackYear: number
): { year: number; month: number; day: number } | null {
  const m = text.match(
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  return {
    month,
    day: parseInt(m[2], 10),
    year: m[3] ? parseInt(m[3], 10) : fallbackYear,
  };
}

function parseTimeRange(
  text: string
): { startH: number; startM: number; endH: number; endM: number } | null {
  const parts = text.split(/[-–]|to/i);
  if (parts.length < 2) return null;
  const start = parseTime(parts[0]);
  const end = parseTime(parts[parts.length - 1]);
  if (!start || !end) return null;
  return { startH: start.h, startM: start.m, endH: end.h, endM: end.m };
}

function parseTime(text: string): { h: number; m: number } | null {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const pm = m[3].toLowerCase() === "p";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return { h, m: min };
}

/**
 * Build an ISO string with the configured timezone's offset baked in, so the
 * calendar shows the wall-clock time the user expects regardless of where the
 * job runs (CI often runs in UTC).
 */
function composeIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): string {
  const wall = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  const offset = tzOffset(config.behavior.timezone, new Date(`${wall}Z`));
  return `${wall}${offset}`;
}

/** Returns e.g. "-08:00" for the given tz at the given instant. */
function tzOffset(timeZone: string, at: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = dtf.formatToParts(at).find((p) => p.type === "timeZoneName");
  const name = part?.value ?? "GMT+00:00";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  if (!m) return "+00:00";
  return `${m[1]}:${m[2] ?? "00"}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dedupeAndFilter(bookings: Booking[]): Booking[] {
  const byId = new Map<string, Booking>();
  for (const b of bookings) byId.set(b.id, b);
  let list = [...byId.values()];

  const now = Date.now();
  const horizon =
    config.behavior.daysAhead > 0
      ? now + config.behavior.daysAhead * 86_400_000
      : Infinity;

  list = list.filter((b) => {
    const t = new Date(b.start).getTime();
    return t >= now - 3_600_000 && t <= horizon; // keep from ~now to horizon
  });

  list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return list;
}

// ── Debug helpers ────────────────────────────────────────────────────────

function firstVisible(page: Page, selectors: string[]) {
  return async () => {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        return loc;
      }
    }
    return null;
  };
}

/** Reads textContent even for elements hidden via CSS (e.g. #flash). */
async function hiddenText(page: Page, selectors: string[]): Promise<string> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const t = await loc.textContent().catch(() => "");
    if (t?.trim()) return t.replace(/\s+/g, " ").trim();
  }
  return "";
}

async function dumpDebug(page: Page, label: string): Promise<void> {
  const stamp = label.replace(/[^a-z0-9-]/gi, "-");
  await page.screenshot({ path: `debug-${stamp}.png`, fullPage: true }).catch(() => {});
  try {
    const html = await page.content();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`debug-${stamp}.html`, html, "utf-8");
    console.log(`[crawler] Wrote debug-${stamp}.png / .html`);
  } catch {
    /* best effort */
  }
}

export type { Browser };
