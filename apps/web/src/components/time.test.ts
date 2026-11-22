import { expect, test } from "vite-plus/test";
import { listTime } from "./time.ts";

// Built from local parts: the days are the phone's own, whatever zone the test runs in.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

test("a list entry's time: the minute today, 昨天, the date, and the year once it changes", () => {
  const now = at(2026, 11, 22, 9, 30);
  expect(listTime(at(2026, 11, 22, 0, 5), now)).toBe("00:05");
  expect(listTime(at(2026, 11, 21, 23, 59), now)).toBe("昨天");
  expect(listTime(at(2026, 11, 20, 14, 2), now)).toBe("11-20");
  expect(listTime(at(2025, 12, 31, 8), now)).toBe("2025-12-31");
  // A local end's clock a little ahead: still today's minute.
  expect(listTime(at(2026, 11, 22, 9, 31), now)).toBe("09:31");
  // A later day, from a clock far off: its date, not a minute that reads as today.
  expect(listTime(at(2027, 1, 15, 16), now)).toBe("2027-01-15");
  // Just after midnight, the evening before is 昨天.
  expect(listTime(at(2026, 11, 21, 22), at(2026, 11, 22, 0, 1))).toBe("昨天");
});
