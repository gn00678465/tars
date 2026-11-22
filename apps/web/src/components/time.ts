/** A time from the local end or the relay, in the phone's own time zone. */
export const timeText = (ms: number) => new Date(ms).toLocaleString("zh-TW", { hour12: false });

/** An approval's time left, as the prototype's countdown: 剩餘 09:08. */
export function leftText(ms: number): string {
  if (ms <= 0) return "已到期";
  const s = Math.ceil(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
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
