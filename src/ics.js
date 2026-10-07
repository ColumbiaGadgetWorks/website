// Minimal iCalendar (RFC 5545) reader, enough for a Google Calendar feed.
//
// Google exports recurring events as a single VEVENT with an RRULE, so a reader
// that ignores RRULE would miss Open Hack Night entirely. This handles the parts
// a real calendar uses: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY
// (including positional forms like 1TH and -1SA), BYMONTHDAY, BYMONTH, COUNT,
// UNTIL, EXDATE, and single-instance overrides via RECURRENCE-ID.
//
// Times are kept as real instants. A DTSTART carrying a TZID is resolved through
// Intl, so daylight saving is handled by the platform rather than guessed at.

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 2000; // guard against a malformed RRULE looping forever

// ---------------------------------------------------------------- line parsing

// Long properties are split across lines and continued with a leading space or tab.
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function parseLine(line) {
  const colon = splitOutsideQuotes(line);
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// A colon inside a quoted parameter value does not end the property name.
function splitOutsideQuotes(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) return i;
  }
  return -1;
}

function unescapeText(v) {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// ------------------------------------------------------------- time handling

// Offset, in milliseconds, of a named zone at a given instant.
function zoneOffset(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// Wall-clock time in a named zone to a real instant. Two passes settle the
// offset correctly either side of a daylight saving change.
function zonedToInstant(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = naive;
  for (let i = 0; i < 2; i++) ms = naive - zoneOffset(new Date(ms), tz);
  return new Date(ms);
}

// DTSTART comes in three flavours: a date (all day), a UTC instant ending in Z,
// or a local time that is meaningless without its TZID.
function parseDateValue(value, params, defaultTz) {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), allDay: true, tz: 'UTC' };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, z] = m;
  if (z) return { date: new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S)), allDay: false, tz: 'UTC' };
  const tz = params.TZID || defaultTz;
  return { date: zonedToInstant(+Y, +Mo, +D, +H, +Mi, +S, tz), allDay: false, tz };
}

// Calendar arithmetic has to happen in the event's own zone, or a weekly event
// shifts by an hour when the clocks change.
function wallParts(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +(p.hour % 24), mi: +p.minute, s: +p.second };
}

function dayOfWeek(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ------------------------------------------------------------------ RRULE

function parseRRule(value) {
  const rule = {};
  for (const pair of value.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).toUpperCase();
    const v = pair.slice(eq + 1);
    if (k === 'FREQ') rule.freq = v.toUpperCase();
    else if (k === 'INTERVAL') rule.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'COUNT') rule.count = parseInt(v, 10);
    else if (k === 'UNTIL') rule.until = v;
    else if (k === 'BYDAY') rule.byDay = v.toUpperCase().split(',').map(parseByDay).filter(Boolean);
    else if (k === 'BYMONTHDAY') rule.byMonthDay = v.split(',').map(n => parseInt(n, 10));
    else if (k === 'BYMONTH') rule.byMonth = v.split(',').map(n => parseInt(n, 10));
    else if (k === 'WKST') rule.wkst = v.toUpperCase();
  }
  rule.interval = rule.interval || 1;
  return rule;
}

// "TH" means every Thursday; "1TH" the first of the month; "-1TH" the last.
function parseByDay(token) {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token.trim());
  if (!m || WEEKDAYS.indexOf(m[2]) === -1) return null;
  return { nth: m[1] ? parseInt(m[1], 10) : 0, day: WEEKDAYS.indexOf(m[2]) };
}

function nthWeekdayOfMonth(y, mo, weekday, nth) {
  const total = daysInMonth(y, mo);
  const days = [];
  for (let d = 1; d <= total; d++) if (dayOfWeek(y, mo, d) === weekday) days.push(d);
  if (nth > 0) return days[nth - 1] || null;
  if (nth < 0) return days[days.length + nth] || null;
  return null;
}

// Generates the start instants of a recurring event that fall inside the window.
function expandRRule(rule, start, windowStart, windowEnd, exdates) {
  const tz = start.tz === 'UTC' && start.allDay ? 'UTC' : start.tz;
  const first = wallParts(start.date, tz);
  const untilParsed = rule.until ? parseDateValue(rule.until, {}, tz) : null;
  const until = untilParsed ? untilParsed.date : null;
  const out = [];
  let emitted = 0;

  const emit = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return true;
    if (rule.byMonth && rule.byMonth.indexOf(mo) === -1) return true;
    const instant = start.allDay
      ? new Date(Date.UTC(y, mo - 1, d))
      : zonedToInstant(y, mo, d, first.h, first.mi, first.s, tz);
    if (instant.getTime() < start.date.getTime()) return true;
    if (until && instant.getTime() > until.getTime()) return false;
    if (rule.count && emitted >= rule.count) return false;
    emitted++;
    if (instant.getTime() > windowEnd.getTime()) return rule.count ? true : false;
    if (instant.getTime() >= windowStart.getTime() && !exdates.has(instant.getTime())) out.push(instant);
    return true;
  };

  let guard = 0;
  if (rule.freq === 'DAILY') {
    let { y, mo, d } = first;
    while (guard++ < MAX_OCCURRENCES) {
      if (!emit(y, mo, d)) break;
      const next = new Date(Date.UTC(y, mo - 1, d + rule.interval));
      y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
      if (Date.UTC(y, mo - 1, d) > windowEnd.getTime() + 864e5 && !rule.count) break;
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay && rule.byDay.length ? rule.byDay.map(b => b.day) : [dayOfWeek(first.y, first.mo, first.d)];
    // Start from the Sunday of the first week, then step whole weeks.
    const firstDow = dayOfWeek(first.y, first.mo, first.d);
    let weekStart = new Date(Date.UTC(first.y, first.mo - 1, first.d - firstDow));
    while (guard++ < MAX_OCCURRENCES) {
      let keepGoing = true;
      for (const dow of days.slice().sort((a, b) => a - b)) {
        const day = new Date(weekStart.getTime() + dow * 864e5);
        if (!emit(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) { keepGoing = false; break; }
      }
      if (!keepGoing) break;
      weekStart = new Date(weekStart.getTime() + rule.interval * 7 * 864e5);
      if (weekStart.getTime() > windowEnd.getTime() + 864e5 && !rule.count) break;
    }
  } else if (rule.freq === 'MONTHLY') {
    let y = first.y, mo = first.mo;
    while (guard++ < MAX_OCCURRENCES) {
      let days = [];
      if (rule.byDay && rule.byDay.length) {
        for (const b of rule.byDay) {
          if (b.nth) { const d = nthWeekdayOfMonth(y, mo, b.day, b.nth); if (d) days.push(d); }
          else for (let d = 1; d <= daysInMonth(y, mo); d++) if (dayOfWeek(y, mo, d) === b.day) days.push(d);
        }
      } else if (rule.byMonthDay) {
        days = rule.byMonthDay.map(n => (n > 0 ? n : daysInMonth(y, mo) + 1 + n));
      } else {
        days = [first.d];
      }
      let keepGoing = true;
      for (const d of days.sort((a, b) => a - b)) if (!emit(y, mo, d)) { keepGoing = false; break; }
      if (!keepGoing) break;
      mo += rule.interval;
      while (mo > 12) { mo -= 12; y++; }
      if (Date.UTC(y, mo - 1, 1) > windowEnd.getTime() + 864e5 && !rule.count) break;
    }
  } else if (rule.freq === 'YEARLY') {
    let y = first.y;
    while (guard++ < MAX_OCCURRENCES) {
      const months = rule.byMonth || [first.mo];
      let keepGoing = true;
      for (const mo of months) {
        let days = [];
        if (rule.byDay && rule.byDay.length) {
          for (const b of rule.byDay) {
            if (b.nth) { const d = nthWeekdayOfMonth(y, mo, b.day, b.nth); if (d) days.push(d); }
            else for (let d = 1; d <= daysInMonth(y, mo); d++) if (dayOfWeek(y, mo, d) === b.day) days.push(d);
          }
        } else days = rule.byMonthDay || [first.d];
        for (const d of days.sort((a, b) => a - b)) if (!emit(y, mo, d)) { keepGoing = false; break; }
        if (!keepGoing) break;
      }
      if (!keepGoing) break;
      y += rule.interval;
      if (Date.UTC(y, 0, 1) > windowEnd.getTime() + 864e5 && !rule.count) break;
    }
  } else {
    // No usable rule: the event happens once.
    if (start.date >= windowStart && start.date <= windowEnd) out.push(start.date);
  }
  return out;
}

// ------------------------------------------------------------------ public API

export function parseICS(text, defaultTz = 'UTC') {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'URL': cur.url = p.value; break;
      case 'STATUS': cur.status = p.value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(p.value, p.params, defaultTz); break;
      case 'DTEND': cur.end = parseDateValue(p.value, p.params, defaultTz); break;
      case 'RRULE': cur.rrule = parseRRule(p.value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(p.value, p.params, defaultTz); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const d = parseDateValue(v, p.params, defaultTz);
          if (d) cur.exdates.push(d.date.getTime());
        }
        break;
      default: break;
    }
  }
  return events.filter(e => e.start);
}

// Flattens recurring events into individual dated occurrences inside a window.
export function expand(events, windowStart, windowEnd, defaultTz = 'UTC') {
  // Overrides and cancellations are keyed by UID plus the instant they replace.
  const overrides = new Map();
  for (const e of events) {
    if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId.date.getTime()}`, e);
  }

  const out = [];
  for (const e of events) {
    if (e.recurrenceId) continue; // handled as an override below
    if (e.status === 'CANCELLED') continue;

    const durationMs = e.end
      ? e.end.date.getTime() - e.start.date.getTime()
      : (e.start.allDay ? 864e5 : 60 * 60 * 1000);
    const exdates = new Set(e.exdates);

    const starts = e.rrule
      ? expandRRule(e.rrule, e.start, windowStart, windowEnd, exdates)
      : (e.start.date >= windowStart && e.start.date <= windowEnd ? [e.start.date] : []);

    for (const s of starts) {
      const override = overrides.get(`${e.uid}|${s.getTime()}`);
      if (override) {
        if (override.status === 'CANCELLED') continue;
        const oStart = override.start.date;
        if (oStart < windowStart || oStart > windowEnd) continue;
        out.push(toOccurrence(override, oStart, override.end ? override.end.date.getTime() - oStart.getTime() : durationMs, defaultTz));
        continue;
      }
      out.push(toOccurrence(e, s, durationMs, defaultTz));
    }
  }
  // start is an ISO string by this point; subtracting strings yields NaN and sorts nothing.
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

function toOccurrence(e, start, durationMs, tz) {
  const allDay = !!e.start.allDay;
  const end = new Date(start.getTime() + durationMs);
  const parts = wallParts(start, allDay ? 'UTC' : tz);
  return {
    uid: e.uid || '',
    title: e.summary || 'Untitled event',
    description: e.description || '',
    location: e.location || '',
    url: e.url || '',
    allDay,
    start: start.toISOString(),
    end: end.toISOString(),
    // Local calendar day, so the grid can place it without re-deriving the zone.
    day: `${parts.y}-${String(parts.mo).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`,
  };
}

export const _internals = { zonedToInstant, wallParts, nthWeekdayOfMonth, parseRRule, expandRRule };
