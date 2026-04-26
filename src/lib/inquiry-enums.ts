// Bidirectional maps between C# enum integer values (what the JSON wire
// format uses, since System.Text.Json serializes enums as ints) and the
// snake_case strings stored in PG enum types.
//
// CRITICAL: integer values mirror the C# enum member values. Do NOT order
// these by DB sort order — the two often differ (e.g. AuditStatus.Rejected=5
// in C# but is at sort position 4 in the PG enum). Source of truth is
// FunderMaps.Core.Types.* in the C# repo.

type Bimap = { toString: Map<number, string>; toInt: Map<string, number> };

function bimap(entries: [number, string][]): Bimap {
  const toString = new Map(entries);
  const toInt = new Map(entries.map(([i, s]) => [s, i]));
  return { toString, toInt };
}

const ENUMS = {
  inquiry_type: bimap([
    [0, "additional_research"],
    [1, "monitoring"],
    [2, "note"],
    [3, "quickscan"],
    [4, "unknown"],
    [5, "demolition_research"],
    [6, "second_opinion"],
    [7, "archive_research"],
    [8, "architectural_research"],
    [9, "foundation_advice"],
    [10, "inspectionpit"],
    [11, "foundation_research"],
    [12, "ground_water_level_research"],
    [13, "soil_investigation"],
    [14, "facade_scan"],
  ]),
  audit_status: bimap([
    [0, "todo"],
    [1, "pending"],
    [2, "done"],
    [3, "discarded"],
    [4, "pending_review"],
    [5, "rejected"],
  ]),
  access_policy: bimap([
    [0, "public"],
    [1, "private"],
  ]),
  substructure: bimap([
    [0, "cellar"],
    [1, "basement"],
    [2, "crawlspace"],
    [3, "none"],
  ]),
  foundation_type: bimap([
    [0, "wood"],
    [1, "wood_amsterdam"],
    [2, "wood_rotterdam"],
    [3, "concrete"],
    [4, "no_pile"],
    [5, "no_pile_masonry"],
    [6, "no_pile_strips"],
    [7, "no_pile_bearing_floor"],
    [8, "no_pile_concrete_floor"],
    [9, "no_pile_slit"],
    [10, "wood_charger"],
    [11, "weighted_pile"],
    [12, "combined"],
    [13, "steel_pile"],
    [14, "other"],
    [15, "wood_rotterdam_amsterdam"],
    [16, "wood_rotterdam_arch"],
    [17, "wood_amsterdam_arch"],
  ]),
  enforcement_term: bimap([
    [0, "term05"],
    [1, "term510"],
    [2, "term1020"],
    [3, "term5"],
    [4, "term10"],
    [5, "term15"],
    [6, "term20"],
    [7, "term25"],
    [8, "term30"],
    [9, "term40"],
  ]),
  foundation_damage_cause: bimap([
    [0, "drainage"],
    [1, "construction_flaw"],
    [2, "drystand"],
    [3, "overcharge"],
    [4, "overcharge_negative_cling"],
    [5, "negative_cling"],
    [6, "bio_infection"],
    // 7 intentionally absent (matches C# — gap in numbering)
    [8, "fungus_infection"],
    [9, "bio_fungus_infection"],
    [10, "foundation_flaw"],
    [11, "construction_heave"],
    [12, "subsidence"],
    [13, "vegetation"],
    [14, "gas"],
    [15, "vibrations"],
    [16, "partial_foundation_recovery"],
    [17, "japanese_knotweed"],
    [18, "groundwater_level_reduction"],
  ]),
  foundation_damage_characteristics: bimap([
    [0, "jamming_door_window"],
    [1, "crack"],
    [2, "skewed"],
    [3, "crawlspace_flooding"],
    [4, "threshold_above_subsurface"],
    [5, "threshold_below_subsurface"],
    [6, "crooked_floor_wall"],
  ]),
  construction_pile: bimap([
    [0, "punched"],
    [1, "broken"],
    [2, "pinched"],
    [3, "pressed"],
    [4, "perished"],
    [5, "decay"],
    [6, "root_growth"],
  ]),
  wood_type: bimap([
    [0, "pine"],
    [1, "spruce"],
  ]),
  wood_encroachment: bimap([
    [0, "fungus_infection"],
    [1, "bio_fungus_infection"],
    [2, "bio_infection"],
  ]),
  foundation_quality: bimap([
    [0, "bad"],
    [1, "mediocre"],
    [2, "tolerable"],
    [3, "good"],
    [4, "mediocre_good"],
    [5, "mediocre_bad"],
  ]),
  wood_quality: bimap([
    [0, "area1"],
    [1, "area2"],
    [2, "area3"],
    [3, "area4"],
  ]),
  quality: bimap([
    [0, "nil"],
    [1, "small"],
    [2, "mediocre"],
    [3, "large"],
  ]),
  crack_type: bimap([
    [0, "none"],
    [1, "nil"],
    [2, "small"],
    [3, "mediocre"],
    [4, "big"],
  ]),
  rotation_type: bimap([
    [0, "nil"],
    [1, "small"],
    [2, "mediocre"],
    [3, "big"],
    [4, "very_big"],
  ]),
  facade_scan_risk: bimap([
    [0, "a"],
    [1, "b"],
    [2, "c"],
    [3, "d"],
    [4, "e"],
  ]),
} as const;

export type EnumName = keyof typeof ENUMS;

// JSON wire (int) → DB string. Used when accepting input from ClientApp.
export function intToEnum(name: EnumName, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = ENUMS[name].toString.get(value);
  if (s === undefined) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return s;
}

// DB string → JSON wire (int). Used when serializing rows for ClientApp.
export function enumToInt(name: EnumName, value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const i = ENUMS[name].toInt.get(value);
  if (i === undefined) {
    throw new Error(`Unknown ${name} string in DB: ${value}`);
  }
  return i;
}

// Array variants for the few text[] columns (damage_characteristics).
export function intsToEnums(name: EnumName, values: number[] | null | undefined): string[] | null {
  if (!values) return null;
  return values.map((v) => {
    const s = ENUMS[name].toString.get(v);
    if (s === undefined) throw new Error(`Invalid ${name} value: ${v}`);
    return s;
  });
}

export function enumsToInts(name: EnumName, values: string[] | null | undefined): number[] | null {
  if (!values) return null;
  return values.map((v) => {
    const i = ENUMS[name].toInt.get(v);
    if (i === undefined) throw new Error(`Unknown ${name} string in DB: ${v}`);
    return i;
  });
}
