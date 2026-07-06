import "dotenv/config";
import { config } from "./config.js";
import { crawlBookings } from "./crawler.js";
import { syncCalendar } from "./calendar.js";
import { sendNotification } from "./notify.js";
import { withRetry } from "./retry.js";
import type { Booking, SyncSummary } from "./types.js";

async function main(): Promise<void> {
  const mode = config.behavior.dryRun ? " (DRY RUN)" : "";
  console.log(`[picklr-sync] Starting sync${mode}...`);
  console.log(`[picklr-sync] Picklr: ${config.picklr.baseUrl}`);
  console.log(
    `[picklr-sync] Calendar: ${config.google.calendarId} | TZ: ${config.behavior.timezone} | Horizon: ${
      config.behavior.daysAhead || "∞"
    }d`
  );

  let summary: SyncSummary;

  let bookings: Booking[];
  try {
    bookings = await withRetry(() => crawlBookings(), {
      onRetry: (err, attempt) =>
        console.error(`[picklr-sync] Crawl attempt ${attempt} failed:`, err),
    });
    logBookings(bookings);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[picklr-sync] Crawl failed after retries:", msg);
    summary = {
      items: [],
      crawlFailed: true,
      crawlError: msg,
      dryRun: config.behavior.dryRun,
    };
    await notify(summary);
    process.exitCode = 1;
    return;
  }

  try {
    const items = await syncCalendar(bookings);
    summary = { items, crawlFailed: false, dryRun: config.behavior.dryRun };

    const changed = items.filter((i) => i.action !== "unchanged");
    console.log(
      `[picklr-sync] ${changed.length} change(s): ` +
        (["added", "updated", "removed"] as const)
          .map((a) => `${items.filter((i) => i.action === a).length} ${a}`)
          .join(", ")
    );
    for (const i of changed) {
      const tag = i.error ? `FAILED (${i.error})` : i.action;
      console.log(`  • [${tag}] ${i.booking.title} — ${i.booking.start}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[picklr-sync] Calendar sync failed:", msg);
    // Crawl succeeded but the calendar step blew up (e.g. API disabled / auth).
    // Surface it as a sync error so the email still lists the bookings we found.
    summary = {
      items: bookings.map((b) => ({ action: "unchanged", booking: b, error: msg })),
      crawlFailed: false,
      crawlError: msg,
      dryRun: config.behavior.dryRun,
    };
  }

  await notify(summary);

  const hadErrors =
    summary.crawlFailed || summary.items.some((i) => i.error);
  if (hadErrors) process.exitCode = 1;
}

async function notify(summary: SyncSummary): Promise<void> {
  try {
    await sendNotification(summary);
  } catch (emailError) {
    console.error("[picklr-sync] Failed to send notification email:", emailError);
  }
}

function logBookings(bookings: Booking[]): void {
  console.log(`[picklr-sync] ${bookings.length} upcoming booking(s):`);
  for (const b of bookings) {
    console.log(`  • ${b.title} — ${b.start} → ${b.end}${b.location ? ` @ ${b.location}` : ""}`);
  }
}

main();
