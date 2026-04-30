export const DEFAULT_TIME_ZONE = process.env.APP_TIME_ZONE || "Europe/Rome";

export function nowIso() {
  return new Date().toISOString();
}

export function clipDateKey(input, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(input);
  return formatParts(date, timeZone, ["year", "month", "day"]).join("-");
}

export function clipHourKey(input, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(input);
  const [year, month, day, hour] = formatParts(date, timeZone, ["year", "month", "day", "hour"]);
  return `${year}-${month}-${day}T${hour}`;
}

export function localTimeLabel(input, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(input);
  const [year, month, day, hour, minute] = formatParts(date, timeZone, [
    "year",
    "month",
    "day",
    "hour",
    "minute"
  ]);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function startOfNextHourIso(input) {
  const date = new Date(input);
  return new Date(date.getTime() + 60 * 60 * 1000).toISOString();
}

function formatParts(date, timeZone, wantedTypes) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .filter((part) => wantedTypes.includes(part.type))
    .map((part) => part.value);
  return parts;
}
