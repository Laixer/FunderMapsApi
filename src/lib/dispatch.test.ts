import { describe, expect, test } from "bun:test";
import {
  amsterdamDay,
  amsterdamWeekday,
  dailyTarget,
  normalizeCapacity,
  planDispatch,
  validateCapacityBody,
  workingDaysSince,
  type Candidate,
  type Holding,
  type Person,
} from "./dispatch.ts";

// The week the clocks went back (Sunday 2026-10-25, 03:00 CEST → 02:00 CET).
const MON = new Date("2026-10-26T09:00:00Z");
const WED = new Date("2026-10-28T09:00:00Z");
const SUN = new Date("2026-11-01T09:00:00Z");
const WEEKDAYS = [1, 2, 3, 4, 5];

const person = (userId: string, hoursPerWeek: number, extra: Partial<Person> = {}): Person => ({
  userId, hoursPerWeek, workingDays: WEEKDAYS, preferredKinds: [], active: true, ...extra,
});
const fresh = (dossierId: number, bucket: Candidate["bucket"], kind: string | null = null, day = 1): Candidate => ({
  dossierId, bucket, kind, receivedAt: new Date(`2026-10-${String(day).padStart(2, "0")}T08:00:00Z`),
});
const holding = (dossierId: number, userId: string, lastTouchedAt: Date, bucket: Holding["bucket"] = "research"): Holding => ({
  dossierId, userId, bucket, lastTouchedAt, kind: null, receivedAt: new Date("2026-09-01T08:00:00Z"),
});

describe("Amsterdam calendar", () => {
  test("weekday and day follow Amsterdam, not UTC, across the DST change", () => {
    expect(amsterdamWeekday(MON)).toBe(1);
    expect(amsterdamWeekday(new Date("2026-10-25T23:30:00Z"))).toBe(1); // Monday 00:30 CET
    expect(amsterdamWeekday(new Date("2026-10-25T22:30:00Z"))).toBe(7); // Sunday 23:30 CET
    expect(amsterdamDay(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
    expect(amsterdamDay(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01"); // 00:30 CEST
  });

  test("working days since: the person's own days after the touch, up to today", () => {
    expect(workingDaysSince(WED, WED, WEEKDAYS)).toBe(0);
    expect(workingDaysSince(new Date("2026-10-23T15:00:00Z"), MON, WEEKDAYS)).toBe(1); // Friday → Monday
    expect(workingDaysSince(new Date("2026-10-19T09:00:00Z"), MON, WEEKDAYS)).toBe(5); // a week
    expect(workingDaysSince(new Date("2026-10-20T09:00:00Z"), new Date("2026-10-27T09:00:00Z"), [1, 2])).toBe(2);
    expect(workingDaysSince(WED, MON, WEEKDAYS)).toBe(0); // a touch in the future is not idle time
  });

  test("a day's target: hours a day at one dossier an hour, at least one", () => {
    expect(dailyTarget(32, [1, 2, 3, 4])).toBe(8);
    expect(dailyTarget(36, WEEKDAYS)).toBe(7);
    expect(dailyTarget(2, WEEKDAYS)).toBe(1);
    expect(dailyTarget(0, WEEKDAYS)).toBe(0);
    expect(dailyTarget(40, WEEKDAYS, 0.5)).toBe(4);
  });
});

describe("planDispatch — new meldingen", () => {
  test("go to the person working today with the most room", () => {
    const plan = planDispatch({
      now: WED, mode: "new",
      people: [person("a", 40), person("d", 40)],
      holdings: [holding(1, "a", WED), holding(2, "a", WED)],
      candidates: [fresh(10, "new")],
    });
    expect(plan.assign).toEqual([{ dossierId: 10, userId: "d", bucket: "new", preferred: false }]);
  });

  test("a preference wins among the people with room", () => {
    const plan = planDispatch({
      now: WED, mode: "new",
      people: [person("a", 8, { preferredKinds: ["quickscan"] }), person("d", 40)],
      holdings: [],
      candidates: [fresh(10, "new", "quickscan"), fresh(11, "new", "quickscan", 2)],
    });
    // a has room for 2 (8 h / 5 days → 2): both quickscans go there, d has more room but no preference.
    expect(plan.assign.map((x) => [x.dossierId, x.userId, x.preferred])).toEqual([[10, "a", true], [11, "a", true]]);
  });

  test("with nobody having room they still go out, to the least loaded: a melder waits", () => {
    const plan = planDispatch({
      now: WED, mode: "new",
      people: [person("a", 5), person("b", 5)],
      holdings: [holding(1, "a", WED), holding(2, "a", WED), holding(3, "b", WED)],
      candidates: [fresh(10, "new")],
    });
    expect(plan.assign.map((x) => x.userId)).toEqual(["b"]);
  });

  test("only to people who work today and are active; nobody = unplaced", () => {
    const people = [person("mon-tue", 16, { workingDays: [1, 2] }), person("away", 40, { active: false })];
    const plan = planDispatch({ now: WED, mode: "new", people, holdings: [], candidates: [fresh(10, "new")] });
    expect(plan.assign).toEqual([]);
    expect(plan.unplaced.new).toBe(1);
    expect(planDispatch({ now: SUN, mode: "new", people: [person("a", 40)], holdings: [], candidates: [fresh(10, "new")] }).unplaced.new).toBe(1);
  });

  test("oldest first, spread by room", () => {
    const plan = planDispatch({
      now: WED, mode: "new",
      people: [person("a", 10), person("b", 10)],
      holdings: [],
      candidates: [fresh(12, "new", null, 3), fresh(10, "new", null, 1), fresh(11, "new", null, 2)],
    });
    expect(plan.assign.map((x) => [x.dossierId, x.userId])).toEqual([[10, "a"], [11, "b"], [12, "a"]]);
  });

  test("mode drip leaves new meldingen alone", () => {
    const plan = planDispatch({ now: WED, mode: "drip", people: [person("a", 40)], holdings: [], candidates: [fresh(10, "new")] });
    expect(plan.assign).toEqual([]);
    expect(plan.unplaced.new).toBe(1);
  });
});

describe("planDispatch — research drip", () => {
  const pool = Array.from({ length: 30 }, (_, i) => fresh(100 + i, "research", i % 3 === 0 ? "archive_research" : null, 1 + (i % 28)));

  test("tops each working person up to a day's worth, never the whole backlog", () => {
    const plan = planDispatch({
      now: WED, mode: "drip",
      people: [person("a", 40), person("b", 20)],
      holdings: [holding(1, "a", WED), holding(2, "a", WED), holding(3, "a", WED)],
      candidates: pool,
    });
    const got = (u: string) => plan.assign.filter((x) => x.userId === u).length;
    expect(got("a")).toBe(5); // target 8, holds 3
    expect(got("b")).toBe(4); // target 4
    expect(plan.unplaced.research).toBe(30 - 9);
    expect(new Set(plan.assign.map((x) => x.dossierId)).size).toBe(plan.assign.length); // nobody shares a dossier
  });

  test("preferred kinds first, then the oldest", () => {
    const plan = planDispatch({
      now: WED, mode: "drip",
      people: [person("a", 15, { preferredKinds: ["archive_research"] })],
      holdings: [],
      candidates: pool,
    });
    expect(plan.assign.every((x) => x.preferred)).toBe(true);
    expect(plan.assign).toHaveLength(3);
  });

  test("mode new does not drip", () => {
    expect(planDispatch({ now: WED, mode: "new", people: [person("a", 40)], holdings: [], candidates: pool }).assign).toEqual([]);
  });
});

describe("planDispatch — stale assignments", () => {
  const LONG_AGO = new Date("2026-10-19T09:00:00Z"); // 7 working days before WED

  test("go back to the pool and to someone else in the same run", () => {
    const plan = planDispatch({
      now: WED, mode: "all",
      people: [person("a", 40), person("b", 40)],
      holdings: [holding(1, "a", LONG_AGO, "new"), holding(2, "a", WED)],
      candidates: [],
    });
    expect(plan.release).toEqual([{ dossierId: 1, userId: "a", idleWorkingDays: 7 }]);
    expect(plan.assign).toContainEqual({ dossierId: 1, userId: "b", bucket: "new", preferred: false });
  });

  test("never back to the person it was taken from", () => {
    const plan = planDispatch({ now: WED, mode: "all", people: [person("a", 40)], holdings: [holding(1, "a", LONG_AGO)], candidates: [] });
    expect(plan.release).toHaveLength(1);
    expect(plan.assign).toEqual([]);
  });

  test("counted in the holder's own working days; manual hand-overs outside the table untouched", () => {
    const plan = planDispatch({
      now: WED, mode: "new",
      people: [person("part-time", 8, { workingDays: [1] })],
      holdings: [holding(1, "part-time", LONG_AGO), holding(2, "colleague-without-capacity", LONG_AGO)],
      candidates: [],
    });
    expect(plan.release).toEqual([]); // one Monday since: 1 of its working days
  });

  test("an inactive person's stale work is released too, and they get nothing", () => {
    const plan = planDispatch({
      now: WED, mode: "all",
      people: [person("away", 40, { active: false }), person("b", 40)],
      holdings: [holding(1, "away", LONG_AGO, "research")],
      candidates: [fresh(10, "new")],
    });
    expect(plan.release.map((r) => r.dossierId)).toEqual([1]);
    expect(plan.assign.every((x) => x.userId === "b")).toBe(true);
    expect(plan.people.find((p) => p.userId === "away")).toEqual({ userId: "away", target: 8, held: 0, working: false });
  });
});

describe("validateCapacityBody", () => {
  const KINDS = new Set(["quickscan", "archive_research"]);
  const ok = { hoursPerWeek: 32, workingDays: [1, 2, 3, 4], preferredKinds: ["quickscan"], active: true };

  test("a full body passes", () => {
    expect(validateCapacityBody(ok, KINDS)).toEqual([]);
    expect(validateCapacityBody({ ...ok, hoursPerWeek: 7.5, preferredKinds: [] }, KINDS)).toEqual([]);
  });
  test("every problem at once", () => {
    const errors = validateCapacityBody({ hoursPerWeek: 61, workingDays: [0, 8], preferredKinds: ["nope"], active: "yes" }, KINDS);
    expect(errors).toHaveLength(4);
    expect(validateCapacityBody({ ...ok, hoursPerWeek: 7.25 }, KINDS)).toEqual(["hoursPerWeek has at most one decimal"]);
    expect(validateCapacityBody({ ...ok, workingDays: [] }, KINDS)).toHaveLength(1);
    expect(validateCapacityBody(null, KINDS)).toEqual(["body must be an object"]);
  });
  test("normalized: sets deduplicated and sorted", () => {
    expect(normalizeCapacity({ ...ok, workingDays: [4, 1, 1], preferredKinds: ["quickscan", "archive_research", "quickscan"] }))
      .toEqual({ hoursPerWeek: 32, workingDays: [1, 4], preferredKinds: ["archive_research", "quickscan"], active: true });
  });
});
