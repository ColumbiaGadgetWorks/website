// Regression tests for the iCalendar reader in ics.js.
// Run from the repository root with:  node src/ics.test.mjs
// No dependencies and no test runner, so it works on a bare checkout.
import { parseICS, expand } from './ics.js';

const TZ = 'America/Chicago';
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

function local(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function ics(body) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
}
function run(body, from, to) {
  return expand(parseICS(ics(body), TZ), new Date(from), new Date(to), TZ);
}

// 1. Weekly Thursday 6pm across the end of US daylight saving (Nov 1, 2026).
//    Every occurrence must stay at 18:00 local, which is the whole point of TZID.
const weekly = run([
  'BEGIN:VEVENT', 'UID:ohn', 'SUMMARY:Open Hack Night',
  `DTSTART;TZID=${TZ}:20261015T180000`, `DTEND;TZID=${TZ}:20261015T200000`,
  'RRULE:FREQ=WEEKLY;BYDAY=TH', 'END:VEVENT',
], '2026-10-01', '2026-12-01');
const hours = [...new Set(weekly.map(o => local(o.start).split(' ').pop().slice(0, 2)))];
check('weekly Thursday keeps 18:00 local across the DST change', hours.length === 1 && hours[0] === '18',
  `got hours ${JSON.stringify(hours)}`);
check('weekly Thursday lands only on Thursdays',
  weekly.every(o => local(o.start).startsWith('Thu')), JSON.stringify(weekly.slice(0, 3).map(o => local(o.start))));
const beforeDst = weekly.find(o => o.day === '2026-10-29');
const afterDst = weekly.find(o => o.day === '2026-11-05');
check('UTC instant actually shifts by an hour across DST',
  beforeDst && afterDst && (new Date(afterDst.start) - new Date(beforeDst.start)) === (7 * 24 + 1) * 3600e3,
  beforeDst && afterDst ? `${beforeDst.start} -> ${afterDst.start}` : 'missing occurrence');

// 2. First Thursday of each month.
const firstThu = run([
  'BEGIN:VEVENT', 'UID:grant', 'SUMMARY:Grant class',
  `DTSTART;TZID=${TZ}:20261105T180000`, `DTEND;TZID=${TZ}:20261105T200000`,
  'RRULE:FREQ=MONTHLY;BYDAY=1TH', 'END:VEVENT',
], '2026-11-01', '2027-03-01');
check('BYDAY=1TH gives the first Thursday of each month',
  JSON.stringify(firstThu.map(o => o.day)) === JSON.stringify(['2026-11-05', '2026-12-03', '2027-01-07', '2027-02-04']),
  JSON.stringify(firstThu.map(o => o.day)));

// 3. Last Thursday, every third month.
const quarterly = run([
  'BEGIN:VEVENT', 'UID:board', 'SUMMARY:Board meeting',
  `DTSTART;TZID=${TZ}:20261029T200000`, `DTEND;TZID=${TZ}:20261029T210000`,
  'RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=-1TH', 'END:VEVENT',
], '2026-10-01', '2027-08-01');
check('BYDAY=-1TH with INTERVAL=3 gives the last Thursday quarterly',
  JSON.stringify(quarterly.map(o => o.day)) === JSON.stringify(['2026-10-29', '2027-01-28', '2027-04-29', '2027-07-29']),
  JSON.stringify(quarterly.map(o => o.day)));

// 4. All-day event.
const allDay = run([
  'BEGIN:VEVENT', 'UID:ad', 'SUMMARY:Art in the Park',
  'DTSTART;VALUE=DATE:20270605', 'DTEND;VALUE=DATE:20270607', 'END:VEVENT',
], '2027-06-01', '2027-07-01');
check('all-day event parses and is flagged', allDay.length === 1 && allDay[0].allDay === true && allDay[0].day === '2027-06-05',
  JSON.stringify(allDay));

// 5. EXDATE removes a single instance.
const withEx = run([
  'BEGIN:VEVENT', 'UID:ohn2', 'SUMMARY:Open Hack Night',
  `DTSTART;TZID=${TZ}:20261105T180000`, `DTEND;TZID=${TZ}:20261105T200000`,
  'RRULE:FREQ=WEEKLY;BYDAY=TH', `EXDATE;TZID=${TZ}:20261126T180000`, 'END:VEVENT',
], '2026-11-01', '2026-12-05');
check('EXDATE skips the cancelled week (Thanksgiving)',
  withEx.every(o => o.day !== '2026-11-26') && withEx.some(o => o.day === '2026-11-19'),
  JSON.stringify(withEx.map(o => o.day)));

// 6. A single instance moved to another time, via RECURRENCE-ID.
const moved = run([
  'BEGIN:VEVENT', 'UID:ohn3', 'SUMMARY:Open Hack Night',
  `DTSTART;TZID=${TZ}:20261105T180000`, `DTEND;TZID=${TZ}:20261105T200000`,
  'RRULE:FREQ=WEEKLY;BYDAY=TH', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ohn3', 'SUMMARY:Open Hack Night (early)',
  `RECURRENCE-ID;TZID=${TZ}:20261112T180000`,
  `DTSTART;TZID=${TZ}:20261112T170000`, `DTEND;TZID=${TZ}:20261112T190000`, 'END:VEVENT',
], '2026-11-01', '2026-12-01');
const movedOne = moved.find(o => o.day === '2026-11-12');
check('RECURRENCE-ID override replaces that instance',
  movedOne && movedOne.title === 'Open Hack Night (early)' && local(movedOne.start).endsWith('17:00'),
  movedOne ? `${movedOne.title} at ${local(movedOne.start)}` : 'missing');
check('override does not duplicate the instance',
  moved.filter(o => o.day === '2026-11-12').length === 1);

// 7. A cancelled single instance disappears.
const cancelled = run([
  'BEGIN:VEVENT', 'UID:ohn4', 'SUMMARY:Open Hack Night',
  `DTSTART;TZID=${TZ}:20261105T180000`, `DTEND;TZID=${TZ}:20261105T200000`,
  'RRULE:FREQ=WEEKLY;BYDAY=TH', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ohn4', 'STATUS:CANCELLED',
  `RECURRENCE-ID;TZID=${TZ}:20261119T180000`,
  `DTSTART;TZID=${TZ}:20261119T180000`, 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('a cancelled instance is dropped', cancelled.every(o => o.day !== '2026-11-19'),
  JSON.stringify(cancelled.map(o => o.day)));

// 8. COUNT and UNTIL both stop the series.
const counted = run([
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Three only',
  `DTSTART;TZID=${TZ}:20261105T180000`, 'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=3', 'END:VEVENT',
], '2026-11-01', '2027-06-01');
check('COUNT=3 yields exactly three', counted.length === 3, JSON.stringify(counted.map(o => o.day)));
const untilled = run([
  'BEGIN:VEVENT', 'UID:u', 'SUMMARY:Until',
  `DTSTART;TZID=${TZ}:20261105T180000`, 'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261120T235959Z', 'END:VEVENT',
], '2026-11-01', '2027-06-01');
check('UNTIL stops the series', JSON.stringify(untilled.map(o => o.day)) === JSON.stringify(['2026-11-05', '2026-11-12', '2026-11-19']),
  JSON.stringify(untilled.map(o => o.day)));

// 9. Events outside the window are not returned.
const windowed = run([
  'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Weekly',
  `DTSTART;TZID=${TZ}:20260101T180000`, 'RRULE:FREQ=WEEKLY;BYDAY=TH', 'END:VEVENT',
], '2026-11-01', '2026-11-30');
check('only occurrences inside the window come back',
  windowed.length === 4 && windowed[0].day === '2026-11-05', JSON.stringify(windowed.map(o => o.day)));

// 10. Folded lines and escaped characters.
const folded = run([
  'BEGIN:VEVENT', 'UID:f', 'SUMMARY:Soldering class\\, bring nothing',
  'DESCRIPTION:Line one\\nLine two and a very long description that the exporter ',
  ' folded onto a second line',
  `DTSTART;TZID=${TZ}:20261112T180000`, 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('escaped comma is unescaped', folded[0] && folded[0].title === 'Soldering class, bring nothing', folded[0] && folded[0].title);
check('folded line is rejoined and newline unescaped',
  folded[0] && folded[0].description.includes('Line one\nLine two') && folded[0].description.endsWith('second line'),
  folded[0] && JSON.stringify(folded[0].description));

// 11. A UTC (Z) timestamp is respected.
const utc = run([
  'BEGIN:VEVENT', 'UID:z', 'SUMMARY:UTC event', 'DTSTART:20261112T180000Z', 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('Z timestamps are treated as UTC, shown as 12:00 Chicago',
  utc[0] && local(utc[0].start).endsWith('12:00'), utc[0] && local(utc[0].start));

// 12. Results are sorted.
const sorted = run([
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Later', `DTSTART;TZID=${TZ}:20261120T180000`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Earlier', `DTSTART;TZID=${TZ}:20261105T180000`, 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('occurrences come back in date order', sorted.map(o => o.title).join(',') === 'Earlier,Later');

// 13. Nested VALARM properties must not be mistaken for the event's own.
// Google exports a default reminder as a VALARM carrying
// DESCRIPTION:This is an event reminder, and calendars touched by Apple add a
// VALARM with its own UID. Both used to overwrite the event's fields, which
// also broke RECURRENCE-ID matching, because overrides are keyed on UID.
const alarmed = parseICS([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:real-event@google.com',
  'SUMMARY:Open Hack Night',
  'DESCRIPTION:Work on projects and socialize.',
  'DTSTART;TZID=' + TZ + ':20261105T180000',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'UID:ALARM-UID-0001',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n'), TZ);
check('VALARM does not steal the event UID',
  alarmed[0] && alarmed[0].uid === 'real-event@google.com', alarmed[0] && alarmed[0].uid);
check('VALARM does not overwrite the event description',
  alarmed[0] && alarmed[0].description === 'Work on projects and socialize.',
  alarmed[0] && alarmed[0].description);

// 14. A master rule and its override still pair up when both carry alarms.
const paired = run([
  'BEGIN:VEVENT', 'UID:shared@google.com', 'SUMMARY:Show and Tell',
  `DTSTART;TZID=${TZ}:20261105T190000`, 'RRULE:FREQ=MONTHLY;WKST=MO;BYDAY=1TH',
  'BEGIN:VALARM', 'ACTION:NONE', 'UID:ALARM-A', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:shared@google.com', 'SUMMARY:Show and Tell (moved)',
  `DTSTART;TZID=${TZ}:20261105T173000`, `RECURRENCE-ID;TZID=${TZ}:20261105T190000`,
  'BEGIN:VALARM', 'ACTION:NONE', 'UID:ALARM-B', 'END:VALARM', 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('the override replaces its instance rather than duplicating it',
  paired.length === 1 && paired[0].title === 'Show and Tell (moved)',
  paired.map(o => o.title).join(' | '));

// 15. Private fields are never emitted, whatever the feed carries.
const shaped = run([
  'BEGIN:VEVENT', 'UID:x@google.com', 'SUMMARY:Meeting',
  'ORGANIZER;CN=someone@example.com:mailto:someone@example.com',
  'ATTENDEE;CN=guest@example.com:mailto:guest@example.com',
  `DTSTART;TZID=${TZ}:20261105T180000`, 'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('no organizer, attendee or uid reaches the browser',
  shaped[0] && !('organizer' in shaped[0]) && !('attendee' in shaped[0]) && !('uid' in shaped[0]),
  shaped[0] && Object.keys(shaped[0]).join(','));
check('no guest address survives anywhere in the payload',
  JSON.stringify(shaped).indexOf('example.com') === -1);

// 16. Repeated EXDATE lines accumulate instead of replacing one another.
// Google writes one EXDATE line per cancelled occurrence, not a comma list.
const multiEx = run([
  'BEGIN:VEVENT', 'UID:m@google.com', 'SUMMARY:Weekly',
  `DTSTART;TZID=${TZ}:20261105T180000`, 'RRULE:FREQ=WEEKLY;BYDAY=TH',
  `EXDATE;TZID=${TZ}:20261112T180000`,
  `EXDATE;TZID=${TZ}:20261119T180000`,
  `EXDATE;TZID=${TZ}:20261126T180000`,
  'END:VEVENT',
], '2026-11-01', '2026-12-01');
check('all three separate EXDATE lines are honoured',
  multiEx.length === 1 && multiEx[0].day === '2026-11-05',
  multiEx.map(o => o.day).join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
