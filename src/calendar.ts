import { google, calendar_v3 } from "googleapis";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { Booking, SyncResultItem } from "./types.js";

/** Marker written to every event we own, so we never touch the user's others. */
const PICKLR_TAG = "picklr-sync";

/**
 * Stable id for a booking: hash of start instant + normalized title. If Picklr
 * moves a booking to a new time it becomes a new id (old one gets removed,
 * new one added) — which is the correct calendar outcome.
 */
export function makeBookingId(b: Pick<Booking, "start" | "title">): string {
  const key = `${new Date(b.start).toISOString()}|${b.title.trim().toLowerCase()}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function calendarClient(): calendar_v3.Calendar {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret
  );
  oauth2.setCredentials({ refresh_token: config.google.refreshToken });
  return google.calendar({ version: "v3", auth: oauth2 });
}

interface ExistingEvent {
  eventId: string;
  picklrId: string;
  start?: string;
  end?: string;
  summary?: string;
  location?: string;
  description?: string;
  /** Sorted popup-reminder minutes, for change detection. */
  reminderMinutes: number[];
}

/** All future events we previously created, keyed by picklrId. */
async function listSyncedEvents(
  cal: calendar_v3.Calendar
): Promise<Map<string, ExistingEvent>> {
  const map = new Map<string, ExistingEvent>();
  let pageToken: string | undefined;

  do {
    const res = await cal.events.list({
      calendarId: config.google.calendarId,
      privateExtendedProperty: [`app=${PICKLR_TAG}`],
      timeMin: new Date(Date.now() - 3_600_000).toISOString(),
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });

    for (const ev of res.data.items ?? []) {
      const picklrId = ev.extendedProperties?.private?.picklrId;
      if (!ev.id || !picklrId) continue;
      const reminderMinutes = (ev.reminders?.overrides ?? [])
        .filter((o) => o.method === "popup" && typeof o.minutes === "number")
        .map((o) => o.minutes as number)
        .sort((a, z) => a - z);
      map.set(picklrId, {
        eventId: ev.id,
        picklrId,
        start: ev.start?.dateTime ?? ev.start?.date ?? undefined,
        end: ev.end?.dateTime ?? ev.end?.date ?? undefined,
        summary: ev.summary ?? undefined,
        location: ev.location ?? undefined,
        description: ev.description ?? undefined,
        reminderMinutes,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return map;
}

function toEventBody(b: Booking): calendar_v3.Schema$Event {
  // Location = physical venue address, plus any court detail the crawler
  // captured (e.g. "Court 9").
  const detail = courtDetail(b);
  const location = detail
    ? `${config.picklr.venueAddress} — ${detail}`
    : config.picklr.venueAddress;

  return {
    summary: b.title,
    location,
    description: buildDescription(b),
    start: { dateTime: b.start, timeZone: config.behavior.timezone },
    end: { dateTime: b.end, timeZone: config.behavior.timezone },
    // Add yourself as a guest so the event shows an accepted attendee and can
    // ride your notification settings too.
    attendees: [{ email: config.notification.email, responseStatus: "accepted" }],
    reminders: {
      useDefault: false,
      overrides: [
        // 26h out: enough lead time to cancel a booking if plans change.
        { method: "popup", minutes: 26 * 60 },
        { method: "popup", minutes: 30 },
        { method: "popup", minutes: 15 },
        { method: "popup", minutes: 10 },
      ],
    },
    extendedProperties: {
      private: { app: PICKLR_TAG, picklrId: b.id },
    },
  };
}

/** Court detail to append to the address, if we scraped any. */
function courtDetail(b: Booking): string {
  if (b.court) return b.court.trim();
  const court = b.raw?.match(/court\s*#?\s*\w+/i)?.[0];
  return court ? court.replace(/\s+/g, " ").trim() : "";
}

/** Event description: court + participants. Kept clean (no raw button noise). */
function buildDescription(b: Booking): string {
  const lines: string[] = [];
  if (b.court) lines.push(`Court: ${b.court}`);
  if (b.participants?.length) {
    lines.push(`Players: ${b.participants.join(", ")}`);
  }
  if (lines.length) lines.push("");
  lines.push("Synced from Picklr by picklr-sync.");
  return lines.join("\n");
}

/** True if the existing calendar event already matches the booking. */
function isUnchanged(existing: ExistingEvent, b: Booking): boolean {
  const body = toEventBody(b);
  const sameStart =
    existing.start != null &&
    new Date(existing.start).getTime() === new Date(b.start).getTime();
  const sameEnd =
    existing.end != null &&
    new Date(existing.end).getTime() === new Date(b.end).getTime();
  const sameTitle = (existing.summary ?? "") === body.summary;
  const sameLoc = (existing.location ?? "") === (body.location ?? "");
  const sameDesc = (existing.description ?? "") === (body.description ?? "");

  const wantReminders = (body.reminders?.overrides ?? [])
    .filter((o) => o.method === "popup" && typeof o.minutes === "number")
    .map((o) => o.minutes as number)
    .sort((a, z) => a - z);
  const sameReminders =
    existing.reminderMinutes.length === wantReminders.length &&
    existing.reminderMinutes.every((m, i) => m === wantReminders[i]);

  return (
    sameStart && sameEnd && sameTitle && sameLoc && sameDesc && sameReminders
  );
}

/**
 * Reconcile the calendar to exactly match `bookings`:
 *   - booking with no matching event  → add
 *   - booking whose event differs      → update
 *   - synced event with no booking     → remove
 * In dry-run mode we compute the same plan but perform no API writes.
 */
export async function syncCalendar(
  bookings: Booking[]
): Promise<SyncResultItem[]> {
  const cal = calendarClient();
  const existing = await listSyncedEvents(cal);
  console.log(
    `[calendar] ${bookings.length} booking(s) from Picklr, ${existing.size} previously-synced event(s)`
  );

  const results: SyncResultItem[] = [];
  const seen = new Set<string>();
  const dry = config.behavior.dryRun;

  for (const b of bookings) {
    seen.add(b.id);
    const match = existing.get(b.id);

    try {
      if (!match) {
        if (!dry) {
          await cal.events.insert({
            calendarId: config.google.calendarId,
            sendUpdates: "none", // don't email yourself an invite
            requestBody: toEventBody(b),
          });
        }
        results.push({ action: "added", booking: b });
      } else if (!isUnchanged(match, b)) {
        if (!dry) {
          await cal.events.update({
            calendarId: config.google.calendarId,
            eventId: match.eventId,
            sendUpdates: "none",
            requestBody: toEventBody(b),
          });
        }
        results.push({ action: "updated", booking: b });
      } else {
        results.push({ action: "unchanged", booking: b });
      }
    } catch (err) {
      results.push({
        action: match ? "updated" : "added",
        booking: b,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Anything synced before but no longer in Picklr → the reservation was
  // cancelled. Remove it from the calendar.
  for (const [picklrId, ev] of existing) {
    if (seen.has(picklrId)) continue;
    const booking: Booking = {
      id: picklrId,
      title: ev.summary ?? "Picklr Reservation",
      start: ev.start ?? new Date().toISOString(),
      end: ev.end ?? new Date().toISOString(),
      location: ev.location,
    };
    try {
      if (!dry) {
        await cal.events.delete({
          calendarId: config.google.calendarId,
          eventId: ev.eventId,
          sendUpdates: "none",
        });
      }
      results.push({ action: "removed", booking });
    } catch (err) {
      results.push({
        action: "removed",
        booking,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
