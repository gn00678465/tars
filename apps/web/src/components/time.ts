/** A time from the local end or the relay, in the phone's own time zone. */
export const timeText = (ms: number) => new Date(ms).toLocaleString("zh-TW", { hour12: false });

const DAY_MS = 86_400_000;
const two = (n: number) => String(n).padStart(2, "0");

/**
 * A list entry's time, as the prototype's list: 14:02 today, 昨天, 11-17 before that, with the
 * year once it is another year's. Days are the phone's own.
 */
export function listTime(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // Rounded: a day with a clock change is not 24 hours.
  const days = Math.round((day(n) - day(d)) / DAY_MS);
  if (days === 0) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (days === 1) return "昨天";
  const md = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** An approval's time left, as the prototype's countdown: 剩餘 09:08. */
export function leftText(ms: number): string {
  if (ms <= 0) return "已到期";
  const s = Math.ceil(ms / 1000);
  return `剩餘 ${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** The last 8 characters, as tars serve status and the notification show an id. */
export const shortId = (id: string) => id.slice(-8);

/** Month, day and minute: enough to tell two conversations apart in a card's header. */
export const shortTime = (ms: number) =>
  new Date(ms).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
