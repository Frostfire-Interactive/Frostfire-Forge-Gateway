import { describe, expect, test } from "bun:test";
import { PEEK_RATE_MS, applyPeekFrame, inMirror, mirrorFacing, mirrorPose, peekChanges, peekPose, portalsOnMap, wantedPeeks, type PeekFigure } from "../webserver/public/js/core/portalpeek";

// The portal peek feed on the client (core/portalpeek.ts): which portals are fed, and the figures each shows.

describe("portalsOnMap", () => {
  test("old portals without kind or mirror are dungeon portals that mirror; a list keyed by name keeps the names", () => {
    expect(portalsOnMap([{ name: "A", dungeonId: 2, position: { x: 10, y: 20 }, size: { width: 32, height: 48 } }])).toEqual([
      { name: "A", kind: "dungeon", dungeonId: 2, mirror: true, x: 26, foot: 68 },
    ]);
    expect(portalsOnMap({ B: { kind: "teleport", mirror: false, position: { x: 0, y: 0 } } })).toEqual([
      { name: "B", kind: "teleport", dungeonId: null, mirror: false, x: 16, foot: 32 },
    ]);
    expect(portalsOnMap(null)).toEqual([]);
  });
});

describe("wantedPeeks", () => {
  const portals = portalsOnMap([
    { name: "near", position: { x: 100, y: 100 } },
    { name: "far", position: { x: 1000, y: 100 } },
    { name: "off", mirror: false, position: { x: 110, y: 100 } },
    { name: "mid", position: { x: 200, y: 100 } },
    { name: "next", position: { x: 150, y: 100 } },
  ]);
  test("the mirrored portals within reach, nearest first, two at most", () => {
    expect(wantedPeeks(portals, { x: 116, y: 132 }, 200)).toEqual(["near", "next"]);
    expect(wantedPeeks(portals, null, 200)).toEqual([]);
  });
  test("what to start and stop", () => {
    expect(peekChanges(new Set(["far", "near"]), ["near", "mid"])).toEqual({ on: ["mid"], off: ["far"] });
  });
});

describe("applyPeekFrame", () => {
  test("players are kept by id with their look; the ones gone are dropped; a new look is noted", () => {
    const figures = new Map<string, PeekFigure>();
    const first = applyPeekFrame(figures, { players: [{ i: "a", x: 1, y: 2, d: "left", m: 1 }], looks: [{ i: "a", s: { bodySprite: 1 } }] });
    expect(first).toEqual({ changed: true, newLooks: ["a"] });
    expect(figures.get("a")).toMatchObject({ x: 1, y: 2, d: "left", m: 1, look: { bodySprite: 1 } });
    const again = applyPeekFrame(figures, { players: [{ i: "a", x: 3, y: 2, d: "left", m: 0 }], looks: [] });
    expect(again).toEqual({ changed: true, newLooks: [] });
    expect(figures.get("a")!.look).toEqual({ bodySprite: 1 });
    applyPeekFrame(figures, { players: [], looks: [] });
    expect(figures.size).toBe(0);
  });
  test("bad rows are left out", () => {
    const figures = new Map<string, PeekFigure>();
    applyPeekFrame(figures, { players: [{ i: "a", x: "1" }, null, { i: "b", x: 1, y: 1, d: "up", m: 0 }] as any, looks: [] });
    expect([...figures.keys()]).toEqual(["b"]);
  });
});

test("peekPose walks while moving and stands otherwise; an unknown direction faces down", () => {
  expect(peekPose("left", 1)).toBe("walk_left");
  expect(peekPose("upright", 0)).toBe("idle_upright");
  expect(peekPose("sideways", 0)).toBe("idle_down");
});

describe("the mirror", () => {
  test("mirrorFacing swaps up and down and keeps left and right", () => {
    expect(mirrorFacing("up")).toBe("down");
    expect(mirrorFacing("down")).toBe("up");
    expect(mirrorFacing("upleft")).toBe("downleft");
    expect(mirrorFacing("upright")).toBe("downright");
    expect(mirrorFacing("downleft")).toBe("upleft");
    expect(mirrorFacing("downright")).toBe("upright");
    expect(mirrorFacing("left")).toBe("left");
    expect(mirrorFacing("right")).toBe("right");
  });
  test("a player walking north toward the far portal faces the viewer", () => {
    expect(mirrorPose("up", 1)).toBe("walk_down");
    expect(mirrorPose("downleft", 0)).toBe("idle_upleft");
    expect(mirrorPose("sideways", 0)).toBe("idle_up");
  });
  test("inMirror flips each figure's feet about the far place, keeps x, and orders back to front after the flip", () => {
    const north: PeekFigure = { x: -5, y: -40, d: "up", m: 1, look: null };
    const south: PeekFigure = { x: 7, y: 30, d: "down", m: 0, look: null };
    const shown = inMirror([south, north]);
    expect(shown).toEqual([{ figure: south, x: 7, y: -62 }, { figure: north, x: -5, y: 8 }]);
  });
});

test("the far side is made again 30 times a second, the engine's feed rate", () => {
  expect(1000 / PEEK_RATE_MS).toBeCloseTo(30, 5);
});
