'use strict';

// Read a local .ics file: no OAuth, no network, no dependencies. Pure.
//
// What it handles: folded lines, escaped text, all-day events, UTC times,
// TZID times (converted with the platform's built-in Intl timezone data),
// floating times, cancelled events, moved single occurrences (RECURRENCE-ID),
// and the common repeat rules: DAILY, WEEKLY (BYDAY, INTERVAL), MONTHLY (same
// day of month) and YEARLY, each with COUNT, UNTIL and EXDATE.
//
// What it does not: rules it cannot expand safely (e.g. "second Tuesday of
// the month", BYSETPOS, hourly). Those events are returned once, at their
// first date, and flagged `unsupportedRule` so the UI can say so instead of
// silently dropping the repeats.

const MS_PER_DAY = 86400000;
const MAX_ITER_DAYS = 3660; // look back at most ten years when expanding a series
const MAX_EVENTS = 5000;

// ---- text ---------------------------------------------------------------------

function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

// "NAME;P=1;Q=x:VALUE" -> { name, params, value }
function parseLine(line) {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) { colon = i; break; }
  }
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

// ---- dates --------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoDay = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
const fromDayNum = (n) => { const dt = new Date(n * MS_PER_DAY); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };
const weekday = (n) => (((n % 7) + 7 + 3) % 7); // 0 = Monday (1970-01-01 was a Thursday)

function validParts(y, m, d, hh = 0, mm = 0, ss = 0) {
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && hh < 24 && mm < 60 && ss < 61;
}

// "20261104", "20261104T093000", "20261104T093000Z" -> parts or null
function parseDateValue(value, params = {}) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (m[4] === undefined) return validParts(y, mo, d) ? { allDay: true, y, m: mo, d } : null;
  const hh = +m[4], mi = +m[5], ss = m[6] ? +m[6] : 0;
  if (!validParts(y, mo, d, hh, mi, ss)) return null;
  const zone = m[7] ? 'utc' : params.TZID ? 'tzid' : 'floating';
  return { allDay: false, y, m: mo, d, hh, mm: mi, ss, zone, tzid: params.TZID || null };
}

// Offset (ms) of a named zone at a given UTC instant, via Intl. null if unknown zone.
function zoneOffsetMs(utcMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(utcMs));
    const g = (t) => +parts.find((p) => p.type === t).value;
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return null;
  }
}

// Wall-clock time in a named zone -> UTC ms (null when the zone is unknown).
function zonedToUtcMs({ y, m, d, hh, mm, ss }, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const off1 = zoneOffsetMs(guess, tz);
  if (off1 === null) return null;
  let utc = guess - off1;
  const off2 = zoneOffsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2; // landed across a DST change
  return utc;
}

function defaultLocalParts(ms) {
  const dt = new Date(ms);
  return { date: isoDay(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}` };
}

// ---- parsing events -------------------------------------------------------------

function parseRrule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return rule;
}

const DAY_CODES = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Returns { events, skipped } where each event is plain JSON, safe to store.
function parseIcs(text) {
  const lines = unfold(text);
  const raw = [];
  let cur = null;
  let depth = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') { cur = { ex: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN') { depth += 1; continue; } // VALARM and friends
    if (p.name === 'END') {
      if (p.value.toUpperCase() === 'VEVENT') { raw.push(cur); cur = null; } else if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (p.name === 'UID') cur.uid = p.value;
    else if (p.name === 'SUMMARY') cur.title = unescapeText(p.value).trim();
    else if (p.name === 'LOCATION') cur.location = unescapeText(p.value).trim();
    else if (p.name === 'STATUS') cur.status = p.value.toUpperCase();
    else if (p.name === 'DTSTART') cur.dtstart = parseDateValue(p.value, p.params);
    else if (p.name === 'DTEND') cur.dtend = parseDateValue(p.value, p.params);
    else if (p.name === 'RRULE') cur.rrule = parseRrule(p.value);
    else if (p.name === 'RECURRENCE-ID') cur.recurrenceId = parseDateValue(p.value, p.params);
    else if (p.name === 'EXDATE') {
      for (const v of p.value.split(',')) { const d = parseDateValue(v, p.params); if (d) cur.ex.push(d); }
    }
  }

  const events = [];
  let skipped = 0;
  for (const e of raw) {
    if (e.status === 'CANCELLED' || !e.dtstart) { skipped += 1; continue; }
    if (events.length >= MAX_EVENTS) { skipped += 1; continue; }
    const ev = {
      uid: e.uid || null,
      title: e.title || '(no title)',
      location: e.location || null,
      start: e.dtstart,
      end: e.dtend || null,
      rrule: e.rrule || null,
      exdates: e.ex,
      recurrenceId: e.recurrenceId || null,
    };
    events.push(ev);
  }

  // A moved or edited single occurrence replaces that date of its series.
  for (const moved of events.filter((e) => e.recurrenceId && e.uid)) {
    const base = events.find((e) => e.uid === moved.uid && !e.recurrenceId && e.rrule);
    if (base) base.exdates.push(moved.recurrenceId);
  }
  return { events, skipped };
}

// ---- expanding into dated occurrences ---------------------------------------------

function matchesRule(rule, start, n, wkst) {
  const sNum = dayNum(start.y, start.m, start.d);
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const cur = fromDayNum(n);
  switch (rule.FREQ) {
    case 'DAILY': return (n - sNum) % interval === 0;
    case 'WEEKLY': {
      const weeks = Math.floor((n - (sNum - ((weekday(sNum) - wkst + 7) % 7))) / 7);
      const days = rule.BYDAY ? rule.BYDAY.split(',').map((c) => DAY_CODES[c.slice(-2)]) : [weekday(sNum)];
      return weeks % interval === 0 && days.includes(weekday(n));
    }
    case 'MONTHLY': {
      const months = (cur.y - start.y) * 12 + (cur.m - start.m);
      const dom = rule.BYMONTHDAY ? parseInt(rule.BYMONTHDAY, 10) : start.d;
      return months >= 0 && months % interval === 0 && cur.d === dom;
    }
    case 'YEARLY': return (cur.y - start.y) % interval === 0 && cur.m === start.m && cur.d === start.d;
    default: return false;
  }
}

function ruleSupported(rule) {
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)) return false;
  if (rule.BYSETPOS || rule.BYWEEKNO || rule.BYYEARDAY || rule.BYHOUR || rule.BYMINUTE) return false;
  if (rule.FREQ !== 'WEEKLY' && rule.BYDAY) return false; // ordinals like 2TU
  if (rule.FREQ === 'WEEKLY' && rule.BYDAY && !rule.BYDAY.split(',').every((c) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(c))) return false;
  if (rule.FREQ === 'YEARLY' && (rule.BYMONTH || rule.BYMONTHDAY)) return false;
  return true;
}

// Dates (as day numbers) on which `ev` starts, within [fromN, toN].
function occurrenceDays(ev, fromN, toN) {
  const s = ev.start;
  const sNum = dayNum(s.y, s.m, s.d);
  if (!ev.rrule) return { days: sNum >= fromN && sNum <= toN ? [sNum] : [], unsupported: false };
  if (!ruleSupported(ev.rrule)) return { days: sNum >= fromN && sNum <= toN ? [sNum] : [], unsupported: true };

  const rule = ev.rrule;
  const wkst = DAY_CODES[rule.WKST] ?? 0;
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  const until = rule.UNTIL ? parseDateValue(rule.UNTIL) : null;
  const untilN = until ? dayNum(until.y, until.m, until.d) : Infinity;
  const ex = new Set(ev.exdates.map((d) => dayNum(d.y, d.m, d.d)));

  const out = [];
  let seen = 0;
  const stop = Math.min(toN, untilN, sNum + MAX_ITER_DAYS);
  for (let n = sNum; n <= stop; n++) {
    if (!matchesRule(rule, s, n, wkst)) continue;
    seen += 1;
    if (seen > count) break;
    if (n >= fromN && !ex.has(n)) out.push(n);
  }
  return { days: out, unsupported: false };
}

// Convert one occurrence start (wall clock parts) to a local {date, time}.
function toLocal(ev, parts, localParts) {
  if (ev.start.allDay) return { date: isoDay(parts.y, parts.m, parts.d), time: null, ms: null };
  const zone = ev.start.zone;
  if (zone === 'floating') return { date: isoDay(parts.y, parts.m, parts.d), time: `${pad(parts.hh)}:${pad(parts.mm)}`, ms: null };
  let ms;
  if (zone === 'utc') ms = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
  else {
    ms = zonedToUtcMs(parts, ev.start.tzid);
    if (ms === null) return { date: isoDay(parts.y, parts.m, parts.d), time: `${pad(parts.hh)}:${pad(parts.mm)}`, ms: null, zoneAssumed: true };
  }
  const lp = localParts(ms);
  return { date: lp.date, time: lp.time, ms };
}

function durationMs(ev) {
  if (ev.start.allDay || !ev.end || ev.end.allDay || ev.end.zone !== ev.start.zone) return 0;
  const a = Date.UTC(ev.start.y, ev.start.m - 1, ev.start.d, ev.start.hh, ev.start.mm, ev.start.ss);
  const b = Date.UTC(ev.end.y, ev.end.m - 1, ev.end.d, ev.end.hh, ev.end.mm, ev.end.ss);
  return b > a ? b - a : 0;
}

// events: from parseIcs. Window is [fromIso, toIso] in the user's local days.
// opts.localParts(ms) -> { date, time } lets tests fix the viewer's timezone.
// -> { occurrences, unsupportedCount }
function expandEvents(events, fromIso, toIso, { localParts = defaultLocalParts } = {}) {
  const f = parseDateValue(fromIso.replace(/-/g, ''));
  const t = parseDateValue(toIso.replace(/-/g, ''));
  if (!f || !t) return { occurrences: [], unsupportedCount: 0 };
  // Widen by a day each side: a UTC time can land on the neighbouring local day.
  const fromN = dayNum(f.y, f.m, f.d) - 1;
  const toN = dayNum(t.y, t.m, t.d) + 1;
  const out = [];
  let unsupportedCount = 0;

  for (const ev of events) {
    const { days, unsupported } = occurrenceDays(ev, fromN, toN);
    if (unsupported) unsupportedCount += 1;
    const dur = durationMs(ev);
    let spanDays = 1;
    if (ev.start.allDay && ev.end && ev.end.allDay) {
      spanDays = Math.min(14, Math.max(1, dayNum(ev.end.y, ev.end.m, ev.end.d) - dayNum(ev.start.y, ev.start.m, ev.start.d)));
    }
    for (const n of days) {
      for (let k = 0; k < spanDays; k++) {
        const p = fromDayNum(n + k);
        const parts = ev.start.allDay ? p : { ...p, hh: ev.start.hh, mm: ev.start.mm, ss: ev.start.ss };
        const local = toLocal(ev, parts, localParts);
        if (local.date < fromIso || local.date > toIso) continue;
        const occ = { uid: ev.uid, title: ev.title, location: ev.location, date: local.date, time: local.time, endTime: null, allDay: ev.start.allDay };
        if (dur > 0 && local.time) {
          if (local.ms !== null && local.ms !== undefined) occ.endTime = localParts(local.ms + dur).time;
          else {
            // Floating time: plain clock arithmetic on the wall-clock time.
            const [h, m] = local.time.split(':').map(Number);
            const total = (h * 60 + m + Math.round(dur / 60000)) % 1440;
            occ.endTime = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
          }
        }
        if (local.zoneAssumed) occ.zoneAssumed = true;
        out.push(occ);
      }
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
  return { occurrences: out, unsupportedCount };
}

module.exports = { parseIcs, expandEvents, zonedToUtcMs, parseDateValue };
