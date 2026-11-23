import { describe, expect, test } from "bun:test";
import { ARCH_DEPTH, ARCH_HALF_WIDTH, BACK_DEPTH, OPENING_HALF_WIDTH, archBlocksStep, archPieces, archesOnMap } from "../webserver/public/js/core/portalarch";
import { advanceSelf, blockedAt } from "../webserver/public/js/core/handoffwalk";

// The arch a portal stands in is solid (core/portalarch.ts), for the client's own walk as for the engine's.
// These are the engine's cases (src/tests/portal-arch.test.ts there) on the client's copy. A player's box: x ± 12, y to y + 20.
const raw = [{ name: "p", kind: "dungeon", dungeonId: 1, position: { x: 100, y: 100 }, size: { width: 32, height: 32 } }];
// centred on x 116, its foot on y 132
const arches = archesOnMap(raw);

describe("archPieces", () => {
  test("the footprint is the arch's full width at its foot: two pillars and the back of the opening", () => {
    expect([ARCH_HALF_WIDTH, OPENING_HALF_WIDTH, ARCH_DEPTH, BACK_DEPTH]).toEqual([47, 21, 20, 4]);
    expect(arches).toEqual([{ x: 116, foot: 132 }]);
    expect(archPieces(arches[0]!)).toEqual([
      { left: 69, right: 95, top: 112, bottom: 132 },
      { left: 137, right: 163, top: 112, bottom: 132 },
      { left: 95, right: 137, top: 112, bottom: 116 },
    ]);
  });

  test("an arch stands where the portal is drawn (rounded), for a list or one keyed by name", () => {
    expect(archesOnMap({ Gate: { position: { x: 100, y: 100 }, size: { width: 33, height: 48 } } })).toEqual([{ x: 117, foot: 148 }]);
    expect(archesOnMap(null)).toEqual([]);
  });
});

describe("archBlocksStep", () => {
  test("walking up into the opening from the front is not blocked, as far as the back of the opening", () => {
    for (const [from, to] of [[138, 132], [132, 126], [126, 120], [120, 116]] as const) {
      expect(archBlocksStep(arches, { x: 116, y: from }, { x: 116, y: to })).toBe(false);
    }
    expect(archBlocksStep(arches, { x: 116, y: 116 }, { x: 116, y: 110 })).toBe(true);
    expect(archBlocksStep(arches, { x: 122, y: 134 }, { x: 116, y: 128 })).toBe(false);
  });

  test("from above, a player stops at the back of the arch, outside the portal's rectangle", () => {
    expect(archBlocksStep(arches, { x: 116, y: 86 }, { x: 116, y: 92 })).toBe(false);
    expect(archBlocksStep(arches, { x: 116, y: 92 }, { x: 116, y: 98 })).toBe(true);
    expect(archBlocksStep(arches, { x: 80, y: 86 }, { x: 80, y: 92 })).toBe(false);
    expect(archBlocksStep(arches, { x: 80, y: 92 }, { x: 80, y: 98 })).toBe(true);
  });

  test("from the sides, a player stops at the pillars; across the front they walk on", () => {
    expect(archBlocksStep(arches, { x: 52, y: 120 }, { x: 58, y: 120 })).toBe(true);
    expect(archBlocksStep(arches, { x: 51, y: 120 }, { x: 57, y: 120 })).toBe(false);
    expect(archBlocksStep(arches, { x: 181, y: 120 }, { x: 175, y: 120 })).toBe(false);
    expect(archBlocksStep(arches, { x: 181, y: 120 }, { x: 174, y: 120 })).toBe(true);
    for (let x = 40; x < 200; x += 6) expect(archBlocksStep(arches, { x, y: 132 }, { x: x + 6, y: 132 })).toBe(false);
  });

  test("off the opening's middle, walking up runs into a pillar", () => {
    expect(archBlocksStep(arches, { x: 130, y: 138 }, { x: 130, y: 132 })).toBe(false);
    expect(archBlocksStep(arches, { x: 130, y: 132 }, { x: 130, y: 126 })).toBe(true);
    expect(archBlocksStep(arches, { x: 125, y: 132 }, { x: 125, y: 126 })).toBe(false);
    expect(archBlocksStep(arches, { x: 102, y: 132 }, { x: 102, y: 126 })).toBe(true);
  });

  test("inside the opening a player cannot walk out through a pillar", () => {
    // the opening leaves 9 px each way of its middle (x 107 to 125)
    expect(archBlocksStep(arches, { x: 116, y: 120 }, { x: 107, y: 120 })).toBe(false);
    expect(archBlocksStep(arches, { x: 110, y: 120 }, { x: 104, y: 120 })).toBe(true);
    expect(archBlocksStep(arches, { x: 122, y: 120 }, { x: 128, y: 120 })).toBe(true);
    expect(archBlocksStep(arches, { x: 116, y: 120 }, { x: 116, y: 126 })).toBe(false);
  });

  test("a step longer than the back is deep cannot pass through it", () => {
    expect(archBlocksStep(arches, { x: 116, y: 88 }, { x: 116, y: 118 })).toBe(true);
    expect(archBlocksStep(arches, { x: 116, y: 146 }, { x: 116, y: 116 })).toBe(false);
  });

  test("a player already on the arch (put there) can walk off it, but not onto another part", () => {
    expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 74, y: 120 })).toBe(false);
    expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 86, y: 120 })).toBe(false);
    expect(archBlocksStep(arches, { x: 80, y: 120 }, { x: 80, y: 126 })).toBe(false);
    expect(archBlocksStep(arches, { x: 116, y: 105 }, { x: 116, y: 99 })).toBe(false);
    expect(archBlocksStep(arches, { x: 116, y: 105 }, { x: 116, y: 111 })).toBe(false);
    expect(archBlocksStep(arches, { x: 96, y: 105 }, { x: 102, y: 111 })).toBe(false);
    expect(archBlocksStep(arches, { x: 140, y: 113 }, { x: 140, y: 107 })).toBe(false);
    expect(archBlocksStep(arches, { x: 92, y: 120 }, { x: 116, y: 105 })).toBe(true);
  });

  test("with no step known, a spot on the arch is blocked", () => {
    expect(archBlocksStep(arches, null, { x: 116, y: 110 })).toBe(true);
    expect(archBlocksStep(arches, null, { x: 116, y: 120 })).toBe(false);
    expect(archBlocksStep([], null, { x: 116, y: 110 })).toBe(false);
  });
});

describe("the client's own walk", () => {
  // No tiles held: only the arch is in the way.
  const map = { tilewidth: 32, tileheight: 32, chunkSize: 32, loadedChunks: new Map(), dungeonPortals: raw };

  test("blockedAt tests the arches of window.mapData's portals, from where the step starts", () => {
    expect(blockedAt(map, 116, 110)).toBe(true);
    expect(blockedAt(map, 116, 110, { x: 116, y: 105 })).toBe(false);
    expect(blockedAt(map, 116, 120, { x: 116, y: 126 })).toBe(false);
    expect(blockedAt({ ...map, dungeonPortals: null }, 116, 110)).toBe(false);
  });

  test("walking down onto an arch from above stops at its back; walking up through the opening reaches the portal", () => {
    const above: any = { position: { x: 116, y: 60 } };
    for (let i = 0; i < 60; i++) advanceSelf(above, "down", 1000 / 60, map);
    expect(above.position.y).toBeLessThanOrEqual(92);
    expect(above.position.y).toBeGreaterThan(86);
    const front: any = { position: { x: 116, y: 170 } };
    for (let i = 0; i < 60; i++) advanceSelf(front, "up", 1000 / 60, map);
    expect(front.position.y).toBeLessThan(132);
    expect(front.position.y).toBeGreaterThanOrEqual(116);
    const side: any = { position: { x: 30, y: 120 } };
    for (let i = 0; i < 60; i++) advanceSelf(side, "right", 1000 / 60, map);
    expect(side.position.x).toBeLessThanOrEqual(57);
  });
});
