export interface VcardRecord {
  displayName: string;
  phones: string[];
  emails: string[];
}

export interface IcsEventRecord {
  title: string;
  startMs: number;
  endMs: number;
}

const fieldValue = (lines: string[], prefix: string): string =>
  lines
    .find((line) => line.toUpperCase().startsWith(prefix))
    ?.split(":")
    .slice(1)
    .join(":")
    .trim() ?? "";

export const parseVcard = (text: string): VcardRecord => {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const values = (prefix: string) =>
    lines
      .filter((line) => line.toUpperCase().startsWith(prefix))
      .map((line) => line.split(":").slice(1).join(":").trim())
      .filter(Boolean);
  return {
    displayName: fieldValue(lines, "FN:"),
    phones: [...new Set(values("TEL"))],
    emails: [...new Set(values("EMAIL"))],
  };
};

export const splitVcards = (text: string): string[] =>
  text.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gim)?.map((item) => item.trim()) ?? [];

export const toVcard = (args: {
  uid: string;
  displayName: string;
  phones: string[];
  emails: string[];
}): string =>
  [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${args.uid}`,
    `FN:${args.displayName || "Unnamed Contact"}`,
    ...args.phones.map((phone) => `TEL;TYPE=CELL:${phone}`),
    ...args.emails.map((email) => `EMAIL;TYPE=OTHER:${email}`),
    "END:VCARD",
    "",
  ].join("\n");

const parseIcsUtcToMs = (value: string): number => {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
};

const toIcsUtc = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
};

export const parseIcsEvent = (text: string): IcsEventRecord => {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return {
    title: fieldValue(lines, "SUMMARY:"),
    startMs: parseIcsUtcToMs(fieldValue(lines, "DTSTART:")),
    endMs: parseIcsUtcToMs(fieldValue(lines, "DTEND:")),
  };
};

export const splitIcsEvents = (text: string): string[] =>
  text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gim)?.map((item) => item.trim()) ?? [];

export const toIcsEvent = (args: {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  stampMs: number;
}): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Syncpeer//PIM//EN",
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `DTSTAMP:${toIcsUtc(args.stampMs)}`,
    `DTSTART:${toIcsUtc(args.startMs)}`,
    `DTEND:${toIcsUtc(args.endMs)}`,
    `SUMMARY:${args.title || "Untitled Event"}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\n");
