import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import { config } from "./config.js";
import type { SyncAction, SyncResultItem, SyncSummary } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "../emails/notification.html");

const ACTION_STYLE: Record<
  Exclude<SyncAction, "unchanged">,
  { label: string; bg: string; fg: string }
> = {
  added: { label: "Added", bg: "#dcfce7", fg: "#166534" },
  updated: { label: "Updated", bg: "#dbeafe", fg: "#1e40af" },
  removed: { label: "Removed", bg: "#fee2e2", fg: "#991b1b" },
};

export async function sendNotification(summary: SyncSummary): Promise<void> {
  const changed = summary.items.filter((i) => i.action !== "unchanged");
  const errors = summary.items.filter((i) => i.error);

  if (
    !summary.crawlFailed &&
    changed.length === 0 &&
    errors.length === 0 &&
    !config.notification.onNoChanges
  ) {
    console.log("[notify] No changes and NOTIFY_ON_NO_CHANGES=false — skipping email");
    return;
  }

  const resend = new Resend(config.resend.apiKey);
  const subject = buildSubject(summary, changed.length, errors.length);
  const html = renderTemplate(summary);

  const { error } = await resend.emails.send({
    from: `Picklr Sync <${config.notification.fromEmail}>`,
    to: config.notification.email,
    subject,
    html,
  });

  if (error) {
    console.error("[notify] Failed to send email:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }
  console.log(`[notify] Email sent to ${config.notification.email}`);
}

function buildSubject(
  summary: SyncSummary,
  changedCount: number,
  errorCount: number
): string {
  const prefix = summary.dryRun ? "[dry-run] " : "";
  if (summary.crawlFailed) return `${prefix}Picklr Sync: crawl failed`;
  const counts = countByAction(summary.items);
  if (changedCount === 0 && errorCount > 0)
    return `${prefix}Picklr Sync: sync failed`;
  if (changedCount === 0) return `${prefix}Picklr Sync: no changes`;
  const parts = (["added", "updated", "removed"] as const)
    .filter((a) => counts[a] > 0)
    .map((a) => `${counts[a]} ${a}`);
  const errPart = errorCount > 0 ? ` (${errorCount} error${errorCount > 1 ? "s" : ""})` : "";
  return `${prefix}Picklr Sync: ${parts.join(", ")}${errPart}`;
}

function countByAction(items: SyncResultItem[]): Record<SyncAction, number> {
  const c: Record<SyncAction, number> = {
    added: 0, updated: 0, removed: 0, unchanged: 0,
  };
  for (const i of items) c[i.action]++;
  return c;
}

function fmtRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: config.behavior.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const start = new Date(startIso).toLocaleString("en-US", opts);
  const end = new Date(endIso).toLocaleString("en-US", {
    timeZone: config.behavior.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${start} – ${end}`;
}

function renderTemplate(summary: SyncSummary): string {
  let template = readFileSync(TEMPLATE_PATH, "utf-8");

  const runTime = new Date().toLocaleString("en-US", {
    timeZone: config.behavior.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const counts = countByAction(summary.items);
  const changed = summary.items.filter((i) => i.action !== "unchanged");
  const errored = summary.items.filter((i) => i.error);
  const syncFailed = !summary.crawlFailed && changed.length === 0 && errored.length > 0;

  let banner: string;
  if (summary.crawlFailed) {
    banner = redBanner("Crawl failed — calendar not synced");
  } else if (syncFailed) {
    banner = redBanner("Calendar sync failed — bookings found but not written");
  } else if (summary.dryRun) {
    banner = grayBanner(
      `Dry run — ${changed.length} change(s) planned, nothing written`
    );
  } else if (changed.length === 0) {
    banner = grayBanner("No changes — calendar already up to date");
  } else {
    const bits = (["added", "updated", "removed"] as const)
      .filter((a) => counts[a] > 0)
      .map((a) => `${counts[a]} ${a}`)
      .join(" · ");
    banner = greenBanner(`Synced: ${bits}`);
  }

  const topError = summary.crawlFailed || syncFailed ? summary.crawlError : undefined;
  const crawlErrorSection = topError
    ? `<p style="margin:0 0 20px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:13px;color:#991b1b;">${escapeHtml(
        topError
      )}</p>`
    : "";

  const actionsSection = renderActionGroups(changed);

  const unchanged = summary.items.filter((i) => i.action === "unchanged");
  // When the sync failed, the "unchanged" list is really "bookings we found but
  // couldn't write" — show them so the email is still useful.
  const foundSection =
    syncFailed && unchanged.length > 0
      ? `<p style="margin:0 0 8px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Bookings found (${unchanged.length})</p>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;">` +
        unchanged
          .map(
            (i) =>
              `<tr><td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;">
                <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#18181b;">${escapeHtml(
                  i.booking.title
                )}</p>
                <p style="margin:0;font-size:13px;color:#52525b;">${escapeHtml(
                  fmtRange(i.booking.start, i.booking.end)
                )}</p></td></tr>`
          )
          .join("") +
        `</table>`
      : "";

  const unchangedSection =
    !syncFailed && unchanged.length > 0
      ? `<p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;text-align:center;">${unchanged.length} booking(s) already in sync</p>`
      : foundSection;

  const emptySection =
    !summary.crawlFailed && changed.length === 0 && unchanged.length === 0
      ? `<p style="margin:0;font-size:14px;color:#71717a;text-align:center;padding:16px 0;">No upcoming Picklr reservations found.</p>`
      : "";

  return template
    .replace("{{run_time}}", escapeHtml(runTime))
    .replace("{{status_banner}}", banner)
    .replace("{{crawl_error}}", crawlErrorSection)
    .replace("{{actions}}", actionsSection)
    .replace("{{unchanged}}", unchangedSection)
    .replace("{{empty}}", emptySection);
}

function renderActionGroups(items: SyncResultItem[]): string {
  const order: Exclude<SyncAction, "unchanged">[] = ["added", "updated", "removed"];
  let html = "";

  for (const action of order) {
    const group = items.filter((i) => i.action === action);
    if (group.length === 0) continue;
    const style = ACTION_STYLE[action];

    const rows = group
      .map((item) => {
        const b = item.booking;
        const err = item.error
          ? `<p style="margin:4px 0 0;font-size:12px;color:#dc2626;">Error: ${escapeHtml(
              item.error
            )}</p>`
          : "";
        return `<tr>
            <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;">
              <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#18181b;">${escapeHtml(
                b.title
              )}</p>
              <p style="margin:0;font-size:13px;color:#52525b;">${escapeHtml(
                fmtRange(b.start, b.end)
              )}${b.location ? ` · ${escapeHtml(b.location)}` : ""}</p>
              ${err}
            </td>
            <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;text-align:right;vertical-align:middle;">
              <span style="display:inline-block;padding:3px 10px;background:${style.bg};color:${style.fg};border-radius:12px;font-size:12px;font-weight:600;">${style.label}</span>
            </td>
          </tr>`;
      })
      .join("");

    html += `
      <p style="margin:0 0 8px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${style.label} (${group.length})</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;">
        ${rows}
      </table>`;
  }

  return html;
}

function greenBanner(text: string): string {
  return banner("#16a34a", text);
}
function redBanner(text: string): string {
  return banner("#dc2626", text);
}
function grayBanner(text: string): string {
  return banner("#52525b", text);
}
function banner(bg: string, text: string): string {
  return `<tr><td style="background:${bg};padding:14px 32px;text-align:center;">
    <p style="margin:0;font-size:15px;font-weight:600;color:#ffffff;">${escapeHtml(
      text
    )}</p>
  </td></tr>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
