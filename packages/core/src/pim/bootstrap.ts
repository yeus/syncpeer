import { joinPimPath, sidecarManifestPath, sidecarOpPath } from "./paths.js";

export interface PimBootstrapWrite {
  readonly path: string;
  readonly contents: string;
  readonly modifiedMs: number;
}

const manifest = (
  domain: "contacts" | "calendar",
  canonical: "one_entry_per_file_vcf" | "one_entry_per_file_ics",
  initializedAtMs: number,
): string =>
  JSON.stringify(
    {
      schemaVersion: 1,
      domain,
      collectionId: "default",
      canonical,
      silentMerge: true,
      initializedAtMs,
    },
    null,
    2,
  );

export const createPimBootstrapPlan = (
  root: string,
  modifiedMs: number,
): readonly PimBootstrapWrite[] => {
  const epoch = new Date(modifiedMs).toISOString().slice(0, 7);
  const op = JSON.stringify({ kind: "bootstrap", createdAtMs: modifiedMs });
  const path = (value: string) => joinPimPath(root, value);
  return [
    {
      path: path(sidecarManifestPath("contacts", "default")),
      contents: manifest("contacts", "one_entry_per_file_vcf", modifiedMs),
      modifiedMs,
    },
    {
      path: path(sidecarManifestPath("calendar", "default")),
      contents: manifest("calendar", "one_entry_per_file_ics", modifiedMs),
      modifiedMs,
    },
    {
      path: path(
        sidecarOpPath({
          domain: "contacts",
          collectionId: "default",
          epoch,
          opId: `bootstrap-${modifiedMs}`,
        }),
      ),
      contents: op,
      modifiedMs,
    },
    {
      path: path(
        sidecarOpPath({
          domain: "calendar",
          collectionId: "default",
          epoch,
          opId: `bootstrap-${modifiedMs}`,
        }),
      ),
      contents: op,
      modifiedMs,
    },
    {
      path: path(
        "syncpeer/pim/contacts/collections/default/entries/bootstrap-contact.vcf",
      ),
      contents:
        "BEGIN:VCARD\nVERSION:3.0\nUID:bootstrap-contact\nFN:Syncpeer Contact Bootstrap\nEND:VCARD\n",
      modifiedMs,
    },
    {
      path: path(
        "syncpeer/pim/calendar/collections/default/entries/bootstrap-event.ics",
      ),
      contents:
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Syncpeer//PIM//EN\nBEGIN:VEVENT\nUID:bootstrap-event\nDTSTAMP:20260101T000000Z\nDTSTART:20260101T090000Z\nDTEND:20260101T093000Z\nSUMMARY:Syncpeer Calendar Bootstrap\nEND:VEVENT\nEND:VCALENDAR\n",
      modifiedMs,
    },
  ];
};
