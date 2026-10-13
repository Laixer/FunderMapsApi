/**
 * The meldingen of a pand, as rows next to its incident reports.
 *
 * The incident map layer draws the meldingen since Worker 20260918_004 (the
 * incident table stopped being written in March 2026), so a pand can be marked
 * on that layer while its panel, which reads the incident table, has nothing
 * to say. These rows are what the panel can say.
 *
 * Don's rule for that layer (2026-09-18) holds here as well: the pand and the
 * topic, and nothing else. No melder, no reference, no note, no date, no
 * status, and not the number of the melding either: the id only tells the
 * rows of one pand apart.
 */
export interface MeldingRow {
  kind: "melding";
  id: string;
  building_id: string;
  topic: string;
}

/** `topics`: one per melding, newest first, the label where the form gave one. */
export function meldingRows(buildingId: string, topics: (string | null | undefined)[]): MeldingRow[] {
  return topics
    .map((topic) => topic?.trim())
    .filter((topic): topic is string => !!topic)
    .map((topic, i) => ({ kind: "melding" as const, id: `melding-${i + 1}-${buildingId}`, building_id: buildingId, topic }));
}
