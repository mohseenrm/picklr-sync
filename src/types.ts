/**
 * A single Picklr reservation, normalized from whatever the site renders.
 * `id` is a stable identifier we derive from the booking so calendar events
 * can be matched idempotently across runs (see calendar.ts).
 */
export interface Booking {
  /** Stable id derived from start time + title (see makeBookingId). */
  id: string;
  /** Human title, e.g. "Open Play - Intermediate" or "Court 3 Reservation". */
  title: string;
  /** ISO 8601 start datetime (with offset). */
  start: string;
  /** ISO 8601 end datetime (with offset). */
  end: string;
  /** Optional location / court label. */
  location?: string;
  /** Court label if present, e.g. "Court 9". */
  court?: string;
  /** Participant names on the reservation. */
  participants?: string[];
  /** Raw text we scraped, kept for the email + debugging. */
  raw?: string;
}

export type SyncAction = "added" | "updated" | "removed" | "unchanged";

export interface SyncResultItem {
  action: SyncAction;
  booking: Booking;
  /** Populated on failure. */
  error?: string;
}

export interface SyncSummary {
  items: SyncResultItem[];
  /** True if the crawl itself failed before any diff could run. */
  crawlFailed: boolean;
  crawlError?: string;
  dryRun: boolean;
}
