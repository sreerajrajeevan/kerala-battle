/**
 * Competition time helpers.
 *
 * All competition-day and weekly boundaries use Asia/Kolkata (UTC+5:30, no
 * daylight saving time), never the server machine's local timezone. The
 * fixed +5:30 offset is applied arithmetically, so results are identical on
 * any host.
 */

import type { CompetitionWeekInfo } from '@kerala-battle/shared';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompetitionDayInfo {
  /** Stable ID: the IST calendar date, e.g. "2026-10-03". */
  id: string;
  /** Midnight IST at the start of the day, ISO 8601 with +05:30 offset. */
  startsAt: string;
  /** 23:59:59.999 IST at the end of the day. */
  endsAt: string;
}

interface IstCalendar {
  year: number;
  month: number;
  day: number;
  /** ISO weekday: Monday = 1 .. Sunday = 7. */
  weekdayMon1: number;
}

/** Read a Unix timestamp as an Asia/Kolkata wall-clock calendar date. */
function istCalendar(nowMs: number): IstCalendar {
  const shifted = new Date(nowMs + IST_OFFSET_MS);
  const sunday0 = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekdayMon1: sunday0 === 0 ? 7 : sunday0,
  };
}

/** Whole days since 1970-01-01 (UTC) for an IST calendar date. */
function daysFromCivil(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const date = new Date(days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * ISO weekday (Mon = 1 .. Sun = 7) for a days-since-epoch value.
 * 1970-01-01 was a Thursday, which anchors the arithmetic.
 */
function weekdayMon1(days: number): number {
  const normalized = ((days % 7) + 7) % 7; // 0..6, where 0 == Thursday (1970-01-01)
  return ((normalized + 3) % 7) + 1;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Formats an IST wall-clock instant, e.g. "2026-10-05T00:00:00.000+05:30". */
function formatIst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): string {
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}` +
    `T${pad(hour)}:${pad(minute)}:${pad(second)}.${String(ms).padStart(3, '0')}+05:30`
  );
}

/**
 * The competition day containing `nowMs`: one IST calendar date,
 * midnight to midnight Asia/Kolkata.
 */
export function getCompetitionDay(nowMs: number): CompetitionDayInfo {
  const cal = istCalendar(nowMs);
  return {
    id: `${pad(cal.year, 4)}-${pad(cal.month)}-${pad(cal.day)}`,
    startsAt: formatIst(cal.year, cal.month, cal.day, 0, 0, 0, 0),
    endsAt: formatIst(cal.year, cal.month, cal.day, 23, 59, 59, 999),
  };
}

/**
 * The competition week containing `nowMs`: Monday 00:00:00 IST through
 * Sunday 23:59:59.999 IST, identified with an ISO-8601 week ID.
 */
export function getCompetitionWeek(nowMs: number): CompetitionWeekInfo {
  const cal = istCalendar(nowMs);
  const todayDays = daysFromCivil(cal.year, cal.month, cal.day);
  const mondayDays = todayDays - (cal.weekdayMon1 - 1);
  // ISO week-numbering year: the Gregorian year containing this week's Thursday.
  const thursday = civilFromDays(mondayDays + 3);
  const weekYear = thursday.year;
  // ISO week 1 is the week containing January 4th.
  const jan4Days = daysFromCivil(weekYear, 1, 4);
  const week1Monday = jan4Days - (weekdayMon1(jan4Days) - 1);
  const week = Math.floor((mondayDays - week1Monday) / 7) + 1;

  const monday = civilFromDays(mondayDays);
  const sunday = civilFromDays(mondayDays + 6);
  return {
    id: `${pad(weekYear, 4)}-W${pad(week)}`,
    startsAt: formatIst(monday.year, monday.month, monday.day, 0, 0, 0, 0),
    endsAt: formatIst(sunday.year, sunday.month, sunday.day, 23, 59, 59, 999),
  };
}
/**
 * Boundaries for a competition week ID like "2026-W40", without needing a
 * timestamp inside the week. Used by finalization and dev tooling so tests
 * never have to alter the system clock. Throws on malformed IDs. Round-trips
 * with getCompetitionWeek: getCompetitionWeekById(getCompetitionWeek(t).id)
 * yields the same boundaries.
 */
export function getCompetitionWeekById(weekId: string): CompetitionWeekInfo {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(weekId);
  const weekYear = match ? Number.parseInt(match[1] as string, 10) : NaN;
  const week = match ? Number.parseInt(match[2] as string, 10) : NaN;
  if (!Number.isInteger(weekYear) || !Number.isInteger(week) || week < 1 || week > 53) {
    throw new Error(`[competition] malformed week id: ${weekId}`);
  }
  // ISO week 1 is the week containing January 4th.
  const jan4Days = daysFromCivil(weekYear, 1, 4);
  const week1Monday = jan4Days - (weekdayMon1(jan4Days) - 1);
  const mondayDays = week1Monday + (week - 1) * 7;
  // Guard week 53 in years that only have 52: the week's Thursday must fall
  // in the requested week-numbering year.
  const thursday = civilFromDays(mondayDays + 3);
  if (thursday.year !== weekYear) {
    throw new Error(`[competition] week id out of range: ${weekId}`);
  }
  const monday = civilFromDays(mondayDays);
  const sunday = civilFromDays(mondayDays + 6);
  return {
    id: `${pad(weekYear, 4)}-W${pad(week)}`,
    startsAt: formatIst(monday.year, monday.month, monday.day, 0, 0, 0, 0),
    endsAt: formatIst(sunday.year, sunday.month, sunday.day, 23, 59, 59, 999),
  };
}
