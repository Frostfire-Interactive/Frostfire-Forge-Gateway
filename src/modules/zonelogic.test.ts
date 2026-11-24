import { expect, test } from "bun:test";
import { bannerStep, fadePoints, musicAt, musicLevel, zoneArea, zoneAt, zoneLabelPoint, zonesList, zonesOfKind, zoneMusicAction, ZONE_MUSIC_FADE, type BannerState, type ClientZone } from "../webserver/public/js/core/zonelogic";

const square = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
const zone = (name: string, x: number, size: number, extra: Partial<ClientZone> = {}): ClientZone => ({
  name, bbox: { x, y: x, w: size, h: size }, outline: [square(x, x, size)], ...extra,
});
const forest = zone("Forest", 0, 100, { music: "forest theme" });
const town = zone("Town", 40, 20, { text: "Welcome to Town" });
const state = (): BannerState => ({ current: null });

test("the area of a zone is that of all its pieces", () => {
  expect(zoneArea(forest)).toBe(10000);
  expect(zoneArea({ ...forest, outline: [square(0, 0, 100), square(200, 0, 20)] })).toBe(10400);
});

test("the smallest zone a point is in wins", () => {
  expect(zoneAt([forest, town], 50, 50)?.name).toBe("Town");
  expect(zoneAt([town, forest], 50, 50)?.name).toBe("Town");
  expect(zoneAt([forest, town], 10, 10)?.name).toBe("Forest");
});

test("a point in a zone's hole is not in that zone", () => {
  const ring = { ...forest, outline: [square(0, 0, 100), square(40, 40, 20)] };
  expect(zoneAt([ring], 50, 50)).toBeNull();
  expect(zoneAt([ring], 10, 10)?.name).toBe("Forest");
});

test("a point outside every zone, or no zones, gives no zone", () => {
  expect(zoneAt([forest, town], 150, 150)).toBeNull();
  expect(zoneAt(null, 1, 1)).toBeNull();
  expect(zoneAt(undefined, 1, 1)).toBeNull();
});

test("the music is that of the smallest zone with music, so a town without its own keeps the forest's", () => {
  expect(musicAt([forest, town], 50, 50)).toBe("forest theme");
  expect(musicAt([forest, { ...town, music: "town theme" }], 50, 50)).toBe("town theme");
  expect(musicAt([town], 50, 50)).toBeNull();
  expect(musicAt([forest], 150, 150)).toBeNull();
});

test("the banner shows on every entry to a zone, with no wait to show it again", () => {
  const s = state();
  expect(bannerStep(s, town, 0)).toBe("Welcome to Town");
  expect(bannerStep(s, town, 250)).toBeNull();
  expect(bannerStep(s, forest, 1000)).toBe("Forest");
  expect(bannerStep(s, town, 1250)).toBe("Welcome to Town");
  expect(bannerStep(s, forest, 1500)).toBe("Forest");
});

test("leaving every zone shows nothing, and a fresh map shows its zone even when it is the same", () => {
  const s = state();
  expect(bannerStep(s, town, 0)).toBe("Welcome to Town");
  expect(bannerStep(s, null, 500)).toBeNull();
  expect(s.current).toBeNull();
  expect(bannerStep(s, town, 600, { fresh: true })).toBe("Welcome to Town");
  expect(bannerStep(s, town, 700, { fresh: true })).toBe("Welcome to Town");
});

test("the zone music level follows the music slider, and is silent when muted or in a cutscene", () => {
  expect(musicLevel(50, false, false)).toBe(0.25);
  expect(musicLevel(100, false, false)).toBe(1);
  expect(musicLevel(0, false, false)).toBe(0);
  expect(musicLevel(50, true, false)).toBe(0);
  expect(musicLevel(50, false, true)).toBe(0);
});

test("zones kept by name (as the map editor keeps them) are read the same as a list", () => {
  expect(zonesList([forest, town]).map((z) => z.name)).toEqual(["Forest", "Town"]);
  expect(zonesList({ Forest: forest, Town: { ...town, name: "Old" } }).map((z) => z.name)).toEqual(["Forest", "Town"]);
  expect(zonesList(null)).toEqual([]);
  expect(zonesList(undefined)).toEqual([]);
  expect(zoneAt(zonesList({ Town: town }), 50, 50)?.name).toBe("Town");
});

test("new zones give the desert and snow areas the storms are drawn in", () => {
  const sand = { ...forest, name: "Dunes", kind: "desert" };
  const ice = { ...town, name: "Peaks", kind: "snow" };
  expect(zonesOfKind([sand, ice, forest], "desert")).toEqual([{ name: "Dunes", bbox: sand.bbox, outline: sand.outline }]);
  expect(zonesOfKind([sand, ice], "snow").map((z) => z.name)).toEqual(["Peaks"]);
  expect(zonesOfKind(null, "snow")).toEqual([]);
});

test("music wanted again while it fades out is brought back, not started twice", () => {
  expect(zoneMusicAction("forest", null, [])).toBe("start");
  expect(zoneMusicAction("forest", "forest", [])).toBe("keep");
  expect(zoneMusicAction("forest", "town", ["forest"])).toBe("revive");
  expect(zoneMusicAction("forest", null, ["forest"])).toBe("revive");
  expect(zoneMusicAction("forest", "town", ["cave", "forest"])).toBe("revive");
  expect(zoneMusicAction("forest", "town", ["cave"])).toBe("start");
  expect(zoneMusicAction(null, "forest", [])).toBe("stop");
  expect(zoneMusicAction(null, null, ["forest"])).toBe("keep");
});

test("a fade in starts from silence slowly and ends at the level", () => {
  const points = fadePoints(0, 1, 5, 4);
  expect(points.map(([t]) => t)).toEqual([1.25, 2.5, 3.75, 5]);
  expect(points.map(([, v]) => v)).toEqual([0.0625, 0.25, 0.5625, 1]);
});

test("a fade out goes all the way to silence", () => {
  const points = fadePoints(0.8, 0, 5, 4);
  expect(points.map(([t]) => t)).toEqual([1.25, 2.5, 3.75, 5]);
  const values = points.map(([, v]) => v);
  expect(values[0]).toBeCloseTo(0.45);
  expect(values[1]).toBeCloseTo(0.2);
  expect(values[2]).toBeCloseTo(0.05);
  expect(values[3]).toBe(0);
});

test("zone music fades are slow", () => {
  expect(ZONE_MUSIC_FADE).toBeGreaterThanOrEqual(4);
});

test("a zone's name goes deep inside it, not in a notch or a hole", () => {
  const box = (outline: number[][][]) => {
    const xs = outline.flat().map((p) => p[0]), ys = outline.flat().map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const zone = (name: string, outline: number[][][]): ClientZone => ({ name, outline, bbox: box(outline) });
  const square = zone("Square", [[[0, 0], [10, 0], [10, 10], [0, 10]]]);
  const middle = zoneLabelPoint(square);
  expect(Math.abs(middle.x - 5)).toBeLessThan(0.6);
  expect(Math.abs(middle.y - 5)).toBeLessThan(0.6);
  // a U: the middle of its box is in the notch
  const u = zone("U", [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]]]);
  const inU = zoneLabelPoint(u);
  expect(zoneAt([u], inU.x, inU.y)?.name).toBe("U");
  // a ring with a hole: the middle of its box is in the hole
  const ring = zone("Ring", [[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [20, 10], [20, 20], [10, 20]]]);
  const inRing = zoneLabelPoint(ring);
  expect(zoneAt([ring], inRing.x, inRing.y)?.name).toBe("Ring");
  // no outline: the middle of its box
  expect(zoneLabelPoint({ name: "None", outline: [], bbox: { x: 4, y: 6, w: 2, h: 2 } })).toEqual({ x: 5, y: 7 });
});
