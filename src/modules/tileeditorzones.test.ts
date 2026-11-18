import { expect, test } from "bun:test";
import { buildSaveZones, checkZoneEdit, edgeNear, fillHoles, fitZoneEdit, makesCross, moveZone, outlineCrosses, pathCrosses, pointNear, shiftZones, snapPoint, zoneProblems } from "../webserver/public/js/core/tileeditorzones";
import { ringRelation } from "../webserver/public/js/core/zoneoverlap";
import type { ClientZone } from "../webserver/public/js/core/zonelogic";

const square = (): ClientZone => ({
  name: "Town",
  bbox: { x: 10, y: 10, w: 10, h: 10 },
  outline: [[[10, 10], [20, 10], [20, 20], [10, 20]]],
});

test("a click snaps to the nearest tile corner, in tiles", () => {
  expect(snapPoint(23, 9, 16, 16)).toEqual([1, 1]);
  expect(snapPoint(7, 7, 16, 16)).toEqual([0, 0]);
  expect(snapPoint(40, 17, 16, 16)).toEqual([3, 1]);
});

test("a point of a zone is found within the radius, and not outside it", () => {
  expect(pointNear(square(), 20.3, 19.8, 0.5)).toEqual({ ring: 0, index: 2 });
  expect(pointNear(square(), 15, 15, 0.5)).toBeNull();
});

test("an edge gives the place a new point goes in", () => {
  expect(edgeNear(square(), 15, 10.2, 0.5)).toEqual({ ring: 0, index: 1 });
  expect(edgeNear(square(), 15, 15, 0.5)).toBeNull();
});

test("moving a zone keeps every point in the map", () => {
  const moved = moveZone(square(), 50, -50, 40, 40);
  expect(moved.outline[0]).toEqual([[30, 0], [40, 0], [40, 10], [30, 10]]);
  expect(moved.bbox).toEqual({ x: 30, y: 0, w: 10, h: 10 });
  const plain = moveZone(square(), 2, 3, 40, 40);
  expect(plain.outline[0][0]).toEqual([12, 13]);
});

test("growing the map left or up moves every zone with it", () => {
  const zones = { Town: square() };
  shiftZones(zones, 4, 2);
  expect(zones.Town.outline[0][0]).toEqual([14, 12]);
  expect(zones.Town.bbox).toEqual({ x: 14, y: 12, w: 10, h: 10 });
});

test("zones are sent on save only when changed, without their box, keeping other fields", () => {
  const zones = { Town: { ...square(), id: "t1", hub: true } as any };
  expect(buildSaveZones(zones, false)).toBeUndefined();
  expect(buildSaveZones({}, true)).toEqual([]);
  expect(buildSaveZones(null, true)).toEqual([]);
  const saved = buildSaveZones(zones, true)!;
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toBe("Town");
  expect((saved[0] as any).id).toBe("t1");
  expect((saved[0] as any).hub).toBe(true);
  expect("bbox" in saved[0]).toBe(false);
});

test("a zone with fewer than three points is named as a problem", () => {
  const thin = { ...square(), name: "Thin", outline: [[[0, 0], [1, 1]]] };
  expect(zoneProblems({ Town: square(), Thin: thin })).toEqual(["Thin"]);
  expect(zoneProblems({ Town: square() })).toEqual([]);
});

test("a save is refused before sending for what the server refuses: names alike, long fields, too many points", () => {
  const z = (name: string, extra: Partial<ClientZone> = {}): ClientZone => ({ ...square(), name, ...extra });
  expect(zoneProblems({ "Wind Fields": z("Wind Fields"), "wind fields": z("wind fields") })).toEqual(["wind fields"]);
  expect(zoneProblems({ Long: z("Long", { text: "x".repeat(81) }) })).toEqual(["Long"]);
  expect(zoneProblems({ Song: z("Song", { music: "m".repeat(129) }) })).toEqual(["Song"]);
  expect(zoneProblems({ Kind: z("Kind", { kind: "k".repeat(33) }) })).toEqual(["Kind"]);
  expect(zoneProblems({ ["n".repeat(65)]: z("n".repeat(65)) })).toEqual(["n".repeat(65)]);
  const many = Array.from({ length: 513 }, (_, i) => [i, i % 2]);
  expect(zoneProblems({ Many: z("Many", { outline: [many] }) })).toEqual(["Many"]);
  expect(zoneProblems({ Ok: z("Ok", { text: "x".repeat(80), kind: "desert" }) })).toEqual([]);
});

test("an edit from the zone map window is let through when it is sound", () => {
  const zones = { Town: square() };
  expect(checkZoneEdit(zones, "Town", { ...square(), text: "Welcome" }, 100, 100)).toBeNull();
  expect(checkZoneEdit(zones, "Town", { ...square(), name: "town" }, 100, 100)).toBeNull();
  expect(checkZoneEdit(zones, null, { ...square(), name: "Fields" }, 100, 100)).toBeNull();
  expect(checkZoneEdit(zones, "Town", null, 100, 100)).toBeNull();
  // the zone touches the map's far corner: a corner point may sit on the edge
  expect(checkZoneEdit({}, null, { name: "Edge", bbox: { x: 0, y: 0, w: 0, h: 0 }, outline: [[[90, 90], [100, 90], [100, 100]]] }, 100, 100)).toBeNull();
});

test("an edit from the zone map window is refused, with why", () => {
  const zones = { Town: square(), Port: { ...square(), name: "Port" } };
  const z = (extra: Partial<ClientZone>): ClientZone => ({ ...square(), ...extra });
  expect(checkZoneEdit(zones, "Gone", z({}), 100, 100)).toBe("That zone is no longer there");
  expect(checkZoneEdit(zones, null, null, 100, 100)).toBe("Nothing to change");
  expect(checkZoneEdit(zones, "Town", z({ name: "  " }), 100, 100)).toBe("A zone needs a name");
  expect(checkZoneEdit(zones, "Town", z({ name: "n".repeat(65) }), 100, 100)).toBe("A zone name is at most 64 characters");
  expect(checkZoneEdit(zones, "Town", z({ name: "PORT" }), 100, 100)).toBe("A zone named PORT already exists");
  expect(checkZoneEdit(zones, null, z({ name: "Town" }), 100, 100)).toBe("A zone named Town already exists");
  expect(checkZoneEdit(zones, "Town", z({ outline: [] }), 100, 100)).toBe("A zone needs an outline");
  expect(checkZoneEdit(zones, "Town", z({ outline: [[[0, 0], [1, 1]]] }), 100, 100)).toBe("A zone needs at least 3 points");
  const many = Array.from({ length: 513 }, (_, i) => [i % 100, i % 2]);
  expect(checkZoneEdit(zones, "Town", z({ outline: [many] }), 100, 100)).toBe("A zone has at most 512 points");
  expect(checkZoneEdit(zones, "Town", z({ outline: [[[0, 0], [10.5, 0], [10, 10]]] }), 100, 100)).toBe("Every point of a zone is on a tile corner inside the map");
  expect(checkZoneEdit(zones, "Town", z({ outline: [[[0, 0], [101, 0], [10, 10]]] }), 100, 100)).toBe("Every point of a zone is on a tile corner inside the map");
  expect(checkZoneEdit(zones, "Town", z({ outline: [[[0, 0], [-1, 0], [10, 10]]] }), 100, 100)).toBe("Every point of a zone is on a tile corner inside the map");
  expect(checkZoneEdit(zones, "Town", z({ text: "x".repeat(81) }), 100, 100)).toBe("A zone's text is at most 80 characters");
  expect(checkZoneEdit(zones, "Town", z({ music: "m".repeat(129) }), 100, 100)).toBe("A zone's music name is at most 128 characters");
  expect(checkZoneEdit(zones, "Town", z({ kind: "k".repeat(33) }), 100, 100)).toBe("A zone's kind is at most 32 characters");
});

test("a border that does not cross itself is sound: a square, a concave shape, a hole inside, a closed ring", () => {
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 10], [0, 10]]])).toBe(false);
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 10], [5, 4], [0, 10]]])).toBe(false);
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [6, 3], [6, 6]]])).toBe(false);
  // a ring written closed (its first point again at its end) is the same ring
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]])).toBe(false);
});

test("a border that crosses or touches itself is found", () => {
  // a bow tie, and a five-pointed star (its middle is left out of the zone)
  expect(outlineCrosses([[[0, 0], [10, 10], [10, 0], [0, 10]]])).toBe(true);
  expect(outlineCrosses([[[50, 0], [80, 90], [5, 35], [95, 35], [20, 90]]])).toBe(true);
  // a point on another edge, a spike that runs back along its own edge, the same point twice in a row
  expect(outlineCrosses([[[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]]])).toBe(true);
  expect(outlineCrosses([[[0, 0], [10, 0], [5, 0]]])).toBe(true);
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 0], [10, 10]]])).toBe(true);
  // a second ring across the first
  expect(outlineCrosses([[[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [15, 5], [15, 8]]])).toBe(true);
});

test("an edit is refused when it makes a border cross itself, and let through on a zone that already did", () => {
  const bowTie = [[[10, 10], [20, 20], [20, 10], [10, 20]]];
  expect(checkZoneEdit({}, null, { ...square(), name: "Knot", outline: bowTie }, 100, 100)).toBe("A zone's border cannot cross itself");
  expect(checkZoneEdit({ Town: square() }, "Town", { ...square(), outline: bowTie }, 100, 100)).toBe("A zone's border cannot cross itself");
  // a zone saved crossing before this check can still be renamed, and its points moved to set it right
  const knot = { ...square(), name: "Knot", outline: bowTie };
  expect(checkZoneEdit({ Knot: knot }, "Knot", { ...knot, name: "Knot 2" }, 100, 100)).toBeNull();
  expect(checkZoneEdit({ Knot: knot }, "Knot", { ...knot, outline: square().outline }, 100, 100)).toBeNull();
});

test("a zone being drawn crosses only where its drawn edges meet, not along the edge that will close it", () => {
  expect(pathCrosses([[0, 0], [10, 0], [0, 10], [10, 10]])).toBe(false);
  expect(outlineCrosses([[[0, 0], [10, 0], [0, 10], [10, 10]]])).toBe(true);
  expect(pathCrosses([[0, 0], [10, 0], [10, 10], [5, -5]])).toBe(true);
  expect(pathCrosses([[0, 0], [10, 0], [3, 0]])).toBe(true);
  expect(pathCrosses([[0, 0], [10, 0]])).toBe(false);
});

test("an edit makes a border cross when it crosses after and did not before", () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10]]], bowTie = [[[0, 0], [10, 10], [10, 0], [0, 10]]];
  expect(makesCross(null, bowTie)).toBe(true);
  expect(makesCross(square, bowTie)).toBe(true);
  expect(makesCross(bowTie, [[[0, 0], [10, 10], [12, 0], [0, 10]]])).toBe(false);
  expect(makesCross(null, square)).toBe(false);
});

const box = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

test("fillHoles drops a ring that lies inside another ring of the zone, wherever it is listed", () => {
  expect(fillHoles([box(10, 10, 20), box(15, 15, 3)])).toEqual([box(10, 10, 20)]);
  expect(fillHoles([box(15, 15, 3), box(10, 10, 20)])).toEqual([box(10, 10, 20)]);
});

test("fillHoles drops a hole that touches the ring around it, and an island inside a hole", () => {
  expect(fillHoles([box(10, 10, 20), [[10, 10], [15, 10], [10, 15]]])).toEqual([box(10, 10, 20)]);
  expect(fillHoles([box(10, 10, 30), box(15, 15, 20), box(20, 20, 5)])).toEqual([box(10, 10, 30)]);
});

test("fillHoles keeps one of two rings that are the same", () => {
  expect(fillHoles([box(10, 10, 5), box(10, 10, 5)])).toEqual([box(10, 10, 5)]);
});

test("fillHoles keeps rings that lie apart, and a ring in the notch of another", () => {
  const u = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]];
  expect(fillHoles([box(10, 10, 5), box(30, 30, 5)])).toEqual([box(10, 10, 5), box(30, 30, 5)]);
  expect(fillHoles([u, box(12, 15, 5)])).toEqual([u, box(12, 15, 5)]);
});

test("the zones a save sends have no holes", () => {
  const zones = { Town: { ...square(), outline: [box(10, 10, 20), box(15, 15, 3)] } };
  expect(buildSaveZones(zones, true)![0]!.outline).toEqual([box(10, 10, 20)]);
});

const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const area = (outline: number[][][]) => outline.reduce((sum, ring) => {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
  return sum + Math.abs(twice) / 2;
}, 0);
const drawn = (name: string, outline: number[][][]): ClientZone => ({ name, bbox: { x: 0, y: 0, w: 0, h: 0 }, outline });
const fitted = (result: ClientZone | string): ClientZone => {
  if (typeof result === "string") throw new Error(result);
  return result;
};

test("an edit mostly outside another zone is cut back to that zone's edge", () => {
  const fields = fitted(fitZoneEdit({ Town: square() }, null, drawn("Fields", [rect(15, 10, 20, 10)])));
  expect(area(fields.outline)).toBe(150);
  expect(fields.outline.every((ring) => ringRelation(ring, square().outline[0]!) === "apart")).toBe(true);
});

test("an edit mostly inside another zone is cut down to lie inside it", () => {
  const market = fitted(fitZoneEdit({ Town: square() }, null, drawn("Market", [rect(12, 12, 10, 6)])));
  expect(area(market.outline)).toBe(48);
  expect(ringRelation(market.outline[0]!, square().outline[0]!)).toBe("inside");
});

test("an edit inside another zone, around it or apart from it is made as it is", () => {
  const zones = { Town: square() };
  for (const outline of [[box(12, 12, 3)], [box(0, 0, 50)], [box(30, 30, 5)], [box(20, 10, 5)]]) {
    expect(fitted(fitZoneEdit(zones, null, drawn("Other", outline))).outline).toEqual(outline);
  }
});

test("an edit is fitted to the other zones, not to the zone it changes", () => {
  const moved = drawn("Town", [rect(15, 10, 10, 10)]);
  expect(fitted(fitZoneEdit({ Town: square() }, "Town", moved)).outline).toEqual(moved.outline);
});

test("an edit over two zones is cut back to both", () => {
  const zones = { Town: square(), Port: drawn("Port", [rect(30, 10, 10, 10)]) };
  const coast = fitted(fitZoneEdit(zones, null, drawn("Coast", [rect(15, 12, 30, 4)])));
  // 30 by 4, less the 5 by 4 over Town and the 10 by 4 over Port
  expect(area(coast.outline)).toBe(60);
  expect(coast.outline).toHaveLength(2);
});

test("an edit that cannot be cut to the other zone's edge in whole tiles is refused, with why", () => {
  const zones = { Pond: drawn("Pond", [[[2, 5], [4, 3], [8, 6]]]) };
  expect(fitZoneEdit(zones, null, drawn("Wood", [[[3, 5], [10, 2], [6, 8]]]))).toBe("The zone cannot be cut to the edge of Pond in whole tiles");
});
