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
  court: string;
  participants: string[];
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
 * Extract each booking card. Runs in the page. Picklr has TWO card shapes:
 *
 * Court reservations (#reservations > .my-booking-item > .ui.card.fluid):
 *   .ui.label.uppercase        ← category ("reservation")
 *   a.big.black.bold.text      ← facility, e.g. "Fremont | The PICKLR"
 *   .text.grey.semi.bold span  ← court, e.g. "»  Court 9"
 *   .text.black.semi.bold      ← date "Thu, Jul 09"
 *   .meta                      ← time "07:00 PM - 08:00 PM"
 *   .UserAvatar[data-tooltip]  ← participants
 *   id="list-res-<id>" / a[href*='/reservations/RES…']  ← stable id
 *
 * Programs / clinics (#clinics .ui.segments):
 *   .ui.label.uppercase        ← category ("Socials")
 *   a.big.black.bold.text      ← program name
 *   .text.grey.semi.bold       ← facility
 *   .text.black.semi.bold      ← date
 *   .text.grey > div           ← time
 *   a[href*='lesson_id=<id>']  ← stable id
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

    // Collect cards from every section: reservation cards (.ui.card) and
    // program/clinic cards (.ui.segments). Dedupe by element.
    var cards = [];
    function collect(sel) {
      var found = document.querySelectorAll(sel);
      for (var i = 0; i < found.length; i++) {
        if (cards.indexOf(found[i]) === -1) cards.push(found[i]);
      }
    }
    collect("#reservations .ui.card");
    collect("#priority_requests .ui.card");
    collect("#priority_requests .ui.segments");
    collect("#clinics .ui.segments");

    var out = [];
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

      // Court/location: reservation cards nest it in .text.grey.semi.bold span;
      // program cards put the facility name directly in .text.grey.semi.bold.
      var court = "";
      var locBlock = card.querySelector(".text.grey.semi.bold");
      var location = clean(locBlock && locBlock.textContent);
      var courtMatch = location.match(/court\\s*#?\\s*\\w+/i);
      if (courtMatch) court = clean(courtMatch[0]);

      // Participants (reservation cards only).
      var participants = [];
      var avatars = card.querySelectorAll(".UserAvatar[data-tooltip]");
      for (var a = 0; a < avatars.length; a++) {
        var name = clean(avatars[a].getAttribute("data-tooltip"));
        if (name && participants.indexOf(name) === -1) participants.push(name);
      }

      // Stable id: reservation cards → RES code or list-res-<n> or numeric
      // reservationId; program cards → lesson_id.
      var sourceId = "";
      if (card.id && /list-res-(\\d+)/.test(card.id)) {
        sourceId = "res-" + card.id.match(/list-res-(\\d+)/)[1];
      }
      if (!sourceId) {
        var links = card.querySelectorAll("a[href]");
        for (var l = 0; l < links.length; l++) {
          var href = links[l].getAttribute("href") || "";
          // Bare lesson number keeps ids stable with events synced earlier.
          var m = href.match(/lesson_id=(\\d+)/);
          if (m) { sourceId = m[1]; break; }
          var rm = href.match(/\\/reservations\\/(RES[A-Z0-9]+)/i);
          if (rm) { sourceId = "res-" + rm[1]; break; }
        }
      }

      out.push({
        title: title,
        dateText: dateMatch[0].trim(),
        timeText: timeMatch[0].trim(),
        location: location,
        court: court,
        participants: participants,
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
      court: r.court || undefined,
      participants: r.participants?.length ? r.participants : undefined,
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
 * keep the specific detail. Examples:
 *   "DUPR Open Play - 4.0+" (Socials)   → "🎾 Open Play: DUPR Open Play - 4.0+"
 *   "Private Lesson w/ Coach"           → "🎾 Lesson: Private Lesson w/ Coach"
 *   facility "Fremont…" + court "Court 9" (reservation) → "🎾 Court Reservation: Court 9"
 */
function buildTitle(r: RawBooking): string {
  const hay = `${r.title} ${r.category}`.toLowerCase();

  // Court reservations: the card title is just the facility name, so use the
  // court label as the meaningful detail instead.
  if (/reservation/.test(r.category.toLowerCase())) {
    return r.court ? `🎾 Court Reservation: ${r.court}` : "🎾 Court Reservation";
  }

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
