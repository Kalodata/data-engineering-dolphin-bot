/** Existing daily-board countries and their operational time zones. */
export const COUNTRY_TZ = {
  id: "Asia/Jakarta", vn: "Asia/Ho_Chi_Minh", th: "Asia/Bangkok",
  my: "Asia/Kuala_Lumpur", ph: "Asia/Manila", sg: "Asia/Singapore", jp: "Asia/Tokyo",
  us: "America/New_York", mx: "America/Mexico_City", br: "America/Sao_Paulo",
  gb: "Europe/London", de: "Europe/Berlin", fr: "Europe/Paris", es: "Europe/Madrid",
  it: "Europe/Rome", at: "Europe/Vienna", be: "Europe/Brussels", cz: "Europe/Prague",
  gr: "Europe/Athens", hu: "Europe/Budapest", ie: "Europe/Dublin", nl: "Europe/Amsterdam",
  pl: "Europe/Warsaw", pt: "Europe/Lisbon",
};

export const DAILY_COUNTRIES = Object.keys(COUNTRY_TZ).sort();
export const EU_COUNTRIES = new Set([
  "at", "be", "cz", "de", "es", "fr", "gb", "gr", "hu", "ie", "it", "nl", "pl", "pt",
]);

export function dateInTimeZone(now, timeZone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function getCountryDataDate(country, now = new Date()) {
  return shiftDate(dateInTimeZone(now, COUNTRY_TZ[country]), -1);
}

/** Resolve a wall-clock timestamp using the offset at the target instant (including DST). */
function localTimeUTC(timeZone, date, hour, minute = 0) {
  const desired = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  let candidate = desired;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((p) => [p.type, p.value]));
    const actual = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    if (actual === desired) return new Date(candidate);
    candidate += desired - actual;
  }
  // Local 02:00 can be skipped by DST. Use the later instant, never alert early.
  return new Date(Math.max(candidate, desired - (Date.parse(formatter.format(new Date(desired)).replace(" ", "T") + "Z") - desired)));
}

export function getScheduledStartUTC(country, dataDate) {
  if (!COUNTRY_TZ[country] || !dataDate) return null;
  return localTimeUTC(COUNTRY_TZ[country], shiftDate(dataDate, 1), 2);
}

export function getStartDeadlineUTC(country, dataDate) {
  if (EU_COUNTRIES.has(country)) {
    return localTimeUTC("Asia/Shanghai", shiftDate(dataDate, 1), 15, 40);
  }
  const scheduled = getScheduledStartUTC(country, dataDate);
  return scheduled ? new Date(scheduled.getTime() + 10 * 60_000) : null;
}

export function getCompletionDeadlineUTC(country, dataDate) {
  if (!COUNTRY_TZ[country] || !dataDate) return null;
  return localTimeUTC(COUNTRY_TZ[country], shiftDate(dataDate, 1), country === "id" ? 15 : 13, 10);
}

export function getPrecheckDeadlineUTC(country, dataDate) {
  if (!COUNTRY_TZ[country] || !dataDate) return null;
  return localTimeUTC(COUNTRY_TZ[country], shiftDate(dataDate, 1), precheckDeadlineHour(country));
}

function precheckDeadlineHour(country) {
  return country === "us" ? 3 : 8;
}

export function getPrecheckDeadlineLabel(country) {
  return `当地时间 ${String(precheckDeadlineHour(country)).padStart(2, "0")}:00`;
}

export function getStartDeadlineLabel(country) {
  return EU_COUNTRIES.has(country) ? "北京时间 15:40" : "当地时间 02:10";
}
