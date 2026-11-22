// The prototype's times (ui_parity decision 13): 「今天 13:15」, 「昨天 21:40」, 「11-17」.

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Which day `day` (YYYY-MM-DD, local) is from `now`: today, yesterday, or its month and day. */
function dayWord(day: string, now: number): string {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (day === ymd(today)) return "今天";
  if (day === ymd(yesterday)) return "昨天";
  return day.slice(5);
}

/** An instant from the local end, in the phone's time zone. */
export function momentText(ms: number, now: number): string {
  const d = new Date(ms);
  const word = dayWord(ymd(d), now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return word === "今天" || word === "昨天" ? `${word} ${hm}` : word;
}

/** A page's date (YYYY-MM-DD, as its frontmatter writes it); "" stays "". */
export const dateText = (day: string, now: number) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayWord(day, now) : day;
