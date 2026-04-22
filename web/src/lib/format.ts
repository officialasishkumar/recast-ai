/**
 * Time, date, and duration formatters shared across the app.
 * Output strings are safe for `.num-tab` tabular display.
 */

/** Format a millisecond count as "mm:ss" (or "h:mm:ss" above one hour). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Convenience alias that accepts seconds. */
export function formatDuration(seconds: number): string {
  return formatMs(seconds * 1000);
}

/** Relative timestamp like "just now", "3 m ago", "4 h ago", or "Apr 18". */
export function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diff = now - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Absolute date like "Apr 18, 2026 · 09:14". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const d = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const t = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${d} · ${t}`;
}
