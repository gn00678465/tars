/** A time from the local end or the relay, in the phone's own time zone. */
export const timeText = (ms: number) => new Date(ms).toLocaleString("zh-TW", { hour12: false });

export function leftText(ms: number): string {
  if (ms <= 0) return "已到期";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `剩 ${m} 分 ${s % 60} 秒` : `剩 ${s} 秒`;
}

/** The last 8 characters, as tars serve status and the notification show an id. */
export const shortId = (id: string) => id.slice(-8);
