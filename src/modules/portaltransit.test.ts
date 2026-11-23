import { describe, expect, test } from "bun:test";
import {
  APPEAR_GRACE_MS, ARRIVAL_GAP, HOLD_MAX_MS, HeldKeys, MAX_WALK_OUT_PX, OPENING_REACH, PORTAL_FLASH_MS, SETTLE_MS, STOP_EASE_PX,
  THROUGH_DEPTH, TransitTracker, cameOutOf, flashLevel, portalRects, portalWentInto, shownAfter, steerWalkInPose, steerWalkOutPose, stopWalkAt,
  stopWalkMs, walkInAt, walkInEnd, walkInto, walkOutAt, walkOutOf, walkOutPose, walkSpeed,
} from "../webserver/public/js/core/portaltransit";

// Players walking on into a portal and out of one, and the portal's trim flashing (core/portaltransit.ts).

const raw = [
  { name: "Gate", kind: "teleport", target: { map: "town", x: 500, y: 600 }, position: { x: 100, y: 100 }, size: { width: 32, height: 48 } },
  { name: "Crypt", dungeonId: 4, position: { x: 400, y: 100 }, size: { width: 32, height: 32 } },
  { name: "Dead", kind: "teleport", target: null, position: { x: 700, y: 100 } },
];
const rects = portalRects(raw, "field");
const gate = rects[0]!, crypt = rects[1]!;
// Gate's arch stands at x 116 with its foot (its plane) at y 148: feet are 16 below a player's y
const FOOT = 148;
// in front of Gate's rectangle, where a player stands after coming out of it (feet 32 in front of the plane)
const gateFront = { x: 116, y: FOOT + ARRIVAL_GAP };
// THROUGH_DEPTH past Gate's plane, in its opening: where a walk in ends and a walk out starts
const DEEP = FOOT - THROUGH_DEPTH - 16;
const SPEED = walkSpeed(false);
// a walk out of Gate to gateFront: from DEEP, 32 + THROUGH_DEPTH px
const OUT_MS = stopWalkMs(32 + THROUGH_DEPTH, SPEED);
// on Gate's plane: where the local player's walk in ends and their walk out starts (the cut to the far side)
const PLANE = FOOT - 16;
const LOCAL_OUT_MS = stopWalkMs(32, SPEED);

describe("portal rectangles", () => {
  test("each portal's rectangle, and whether it leads anywhere", () => {
    expect(gate).toEqual({ name: "Gate", left: 100, top: 100, right: 132, bottom: 148, leads: true });
    expect(crypt.leads).toBe(true);
    // a teleport with no place leads nowhere; a dungeon portal linked to no dungeon leads out only from inside a copy
    expect(rects[2]!.leads).toBe(false);
    expect(portalRects([{ name: "Exit", dungeonId: null, position: { x: 0, y: 0 } }], "crypt~ab12")[0]!.leads).toBe(true);
    expect(portalRects([{ name: "Exit", dungeonId: null, position: { x: 0, y: 0 } }], "field")[0]!.leads).toBe(false);
    // a dungeon's exit portal: the copy is sent by its template's name
    expect(portalRects([{ name: "Gate (return)", dungeonId: null, returnOf: { map: "field", name: "Gate" }, position: { x: 0, y: 0 } }], "crypt")[0]!.leads).toBe(true);
    expect(portalRects({ Keyed: { position: { x: 0, y: 0 }, dungeonId: 1 } }, "m")[0]!.name).toBe("Keyed");
    expect(portalRects(null, "m")).toEqual([]);
  });

  test("a player last seen inside or just in front of a rectangle went in there; not one behind it", () => {
    expect(portalWentInto(rects, { x: 116, y: 140 }, 12)?.name).toBe("Gate");
    expect(portalWentInto(rects, { x: 116, y: 158 }, 12)?.name).toBe("Gate");
    // where players arrive is not by the portal: one who logs out there did not go in
    expect(portalWentInto(rects, gateFront, 12)).toBeNull();
    expect(portalWentInto(rects, { x: 116, y: 92 }, 12)).toBeNull();
    expect(portalWentInto(rects, { x: 716, y: 134 }, 12)).toBeNull();
  });

  test("a player at a portal's arrival spot, or at its middle (leaving a dungeon), came out of it", () => {
    expect(cameOutOf(rects, gateFront, 12)?.name).toBe("Gate");
    expect(cameOutOf(rects, { x: 416, y: 116 }, 12)?.name).toBe("Crypt");
    expect(cameOutOf(rects, { x: 300, y: 300 }, 12)).toBeNull();
    expect(cameOutOf(rects, { x: 716, y: 132 + ARRIVAL_GAP }, 12)).toBeNull();
  });
});

describe("walking through", () => {
  test("a walk into a portal goes on from where the player is drawn, at walking pace, through its plane into the opening", () => {
    expect(THROUGH_DEPTH).toBe(16);
    const w = walkInto(gate, { x: 116, y: 140 }, 1000, SPEED);
    expect(w.portal).toBe("Gate");
    expect(w.foot).toBe(FOOT);
    expect(w.to).toEqual({ x: 116, y: DEEP });
    expect(w.ms).toBeCloseTo(24 / SPEED, 5);
    // the feet (16 below y) pass the plane a third of the way: 8 of the 24 px
    expect(w.plane).toBeCloseTo(8 / SPEED, 5);
    expect(walkInAt(w, 1000)).toEqual({ x: 116, y: 140 });
    expect(walkInAt(w, 1000 + w.ms / 2)!.y).toBeCloseTo(128, 5);
    expect(walkInAt(w, 1000 + w.ms)).toBeNull();
    expect(walkInEnd(w)).toEqual({ x: 116, y: DEEP });
    // mounted, faster
    expect(walkInto(gate, { x: 116, y: 140 }, 0, walkSpeed(true)).ms).toBeLessThan(w.ms);
    // off to one side, they walk into the opening, not into its stone
    expect(walkInto(gate, { x: 140, y: 150 }, 0, SPEED).to.x).toBe(116 + OPENING_REACH);
    // at the plane, they walk on in, past it at once
    const atPlane = walkInto(gate, { x: 116, y: FOOT - 16 }, 0, SPEED);
    expect(atPlane.ms).toBeCloseTo(THROUGH_DEPTH / SPEED, 5);
    expect(atPlane.plane).toBe(0);
    // already that deep (against the opening's back): gone at once, where they are
    const deep = walkInto(gate, { x: 116, y: DEEP }, 0, SPEED);
    expect(deep.ms).toBe(0);
    expect(walkInEnd(deep)).toEqual({ x: 116, y: DEEP });
  });

  test("a walk out goes at walking pace, then slows evenly to a stand at its end", () => {
    const MS = stopWalkMs(32, SPEED);
    expect(stopWalkAt(32, SPEED, 0)).toBe(0);
    expect(stopWalkAt(32, SPEED, 50)).toBeCloseTo(SPEED * 50, 5);
    expect(stopWalkAt(32, SPEED, MS)).toBeCloseTo(32, 5);
    expect(stopWalkAt(32, SPEED, MS * 3)).toBeCloseTo(32, 5);
    expect(MS).toBeCloseTo((32 - STOP_EASE_PX) / SPEED + (2 * STOP_EASE_PX) / SPEED, 5);
    let last = 0;
    for (let t = 0; t <= MS; t += 5) {
      const s = stopWalkAt(32, SPEED, t);
      expect(s).toBeGreaterThanOrEqual(last);
      expect(s).toBeLessThanOrEqual(32 + 1e-9);
      last = s;
    }
    // shorter than the slowing: all of it slows
    expect(stopWalkAt(3, SPEED, stopWalkMs(3, SPEED))).toBeCloseTo(3, 5);
    expect(stopWalkMs(0, SPEED)).toBe(0);
  });

  test("a walk out starts as deep in the portal's opening as a walk in ends, and walks down into where the player stands, facing down", () => {
    const w = walkOutOf(gate, gateFront, 1000, SPEED)!;
    expect(w.portal).toBe("Gate");
    expect(w.dist).toBe(32 + THROUGH_DEPTH);
    expect(walkOutAt(w, gateFront, 1000)).toEqual({ x: 116, y: DEEP });
    // there before it starts
    expect(walkOutAt(w, gateFront, 900)).toEqual({ x: 116, y: DEEP });
    // in the opening (feet behind the plane) for its first THROUGH_DEPTH px, at walking pace
    const early = walkOutAt(w, gateFront, 1000 + 40);
    expect(early.y).toBeCloseTo(DEEP + 40 * SPEED, 5);
    expect(early.y + 16).toBeLessThan(FOOT);
    const later = walkOutAt(w, gateFront, 1000 + (THROUGH_DEPTH + 8) / SPEED);
    expect(later.y + 16).toBeGreaterThan(FOOT);
    expect(later.y).toBeLessThan(gateFront.y);
    expect(walkOutAt(w, gateFront, 1000 + OUT_MS)).toEqual(gateFront);
    expect(walkOutPose(w, 1000)).toBe("walk_down");
    expect(walkOutPose(w, 1000 + OUT_MS)).toBe("idle_down");
    // it is drawn from where the player stands: one who moves on meanwhile is drawn along with it
    expect(walkOutAt(w, { x: 130, y: 170 }, 1000 + OUT_MS)).toEqual({ x: 130, y: 170 });
  });

  test("a walk in can end on the plane, and a walk out start on it, as far to the side of the arch's middle as asked", () => {
    const w = walkInto(gate, { x: 110, y: 150 }, 0, SPEED, 0);
    expect(walkInEnd(w)).toEqual({ x: 110, y: PLANE });
    expect(w.plane).toBeCloseTo(w.ms, 5);
    const o = walkOutOf(gate, gateFront, 1000, SPEED, 0, -6)!;
    expect(walkOutAt(o, gateFront, 1000)).toEqual({ x: 110, y: PLANE });
    expect(o.dist).toBeCloseTo(Math.hypot(6, 32), 5);
    expect(walkOutAt(o, gateFront, 1000 + o.ms)).toEqual(gateFront);
  });

  test("no walk out to a spot behind the plane (a dungeon's exit puts players in the portal's middle), or far off", () => {
    expect(walkOutOf(crypt, { x: 416, y: 116 }, 0, SPEED)).toBeNull();
    expect(walkOutOf(gate, { x: 116, y: 124 }, 0, SPEED)).toBeNull();
    expect(walkOutOf(gate, { x: 116, y: FOOT + MAX_WALK_OUT_PX }, 0, SPEED)).toBeNull();
    expect(walkOutOf(gate, { x: 200, y: gateFront.y }, 0, SPEED)).toBeNull();
  });

  test("a flash rises quickly, then falls back to nothing by PORTAL_FLASH_MS; none before it starts", () => {
    expect(flashLevel(undefined, 0)).toBe(0);
    expect(flashLevel(0, 0)).toBe(0);
    const peak = Math.max(...Array.from({ length: 20 }, (_, i) => flashLevel(0, (i * PORTAL_FLASH_MS) / 20)));
    expect(peak).toBeGreaterThan(0.9);
    expect(flashLevel(0, PORTAL_FLASH_MS * 0.6)).toBeLessThan(0.5);
    expect(flashLevel(0, PORTAL_FLASH_MS)).toBe(0);
    expect(flashLevel(0, -5)).toBe(0);
  });
});

type P = { id: string; x: number; y: number; dx: number; dy: number; ref: string };
const at = (id: string, x: number, y: number): P => ({ id, x, y, dx: x, dy: y, ref: id });

/** A tracker already on the map "field" for a while, with these players seen. */
function settled(players: P[], local = "me"): { t: TransitTracker<string>; now: number } {
  const t = new TransitTracker<string>();
  t.observe({ map: "field", now: 0, localId: local, portals: rects, players });
  const now = APPEAR_GRACE_MS + 100;
  t.observe({ map: "field", now, localId: local, portals: rects, players });
  return { t, now };
}
const frame = (t: TransitTracker<string>, now: number, players: P[], map = "field", local = "me") =>
  t.observe({ map, now, localId: local, portals: rects, players });

describe("TransitTracker", () => {
  test("another player who steps into a portal and leaves the view walks on in from where they were drawn, gone at its plane", () => {
    const me = at("me", 300, 300);
    // drawn a little behind where the server has them, as others are
    const bob = { ...at("bob", 116, 150), dy: 160 };
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me, { ...bob, y: 144, dy: 156 }]);
    frame(t, now + 32, [me]);
    const walk = t.walkersAt(now + 32);
    expect(walk).toMatchObject([{ id: "bob", ref: "bob", x: 116, y: 156, portal: "Gate", foot: FOOT, walk: { portal: "Gate" } }]);
    expect(t.walkersAt(now + 32 + 40)[0]!.y).toBeCloseTo(156 - 40 * SPEED, 5);
    // the portal flashes as their feet pass its plane; they walk on into the opening, and then nothing of them is left
    const crossing = now + 32 + (156 + 16 - FOOT) / SPEED;
    expect(t.flashOf("Gate", crossing - 1)).toBe(0);
    expect(t.flashOf("Gate", crossing + 70)).toBeCloseTo(1, 5);
    expect(t.walkersAt(crossing + 1)[0]!.y + 16).toBeLessThan(FOOT);
    const end = now + 32 + (156 - DEEP) / SPEED;
    expect(t.walkersAt(end)).toEqual([]);
    frame(t, end + 1, [me]);
    expect(t.walkersAt(end + 1)).toEqual([]);
  });

  test("a player who leaves the view anywhere else is gone at once", () => {
    const me = at("me", 300, 300), bob = at("bob", 600, 600);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me]);
    expect(t.walkersAt(now + 16)).toEqual([]);
    expect(t.flashOf("Gate", now + 100)).toBe(0);
  });

  test("a player who appears at a portal's arrival spot walks out of it from deep in its opening, facing down; the portal flashes", () => {
    const me = at("me", 300, 300);
    const { t, now } = settled([me]);
    // (the server says a portal put them there)
    t.cameThrough("bob", now + 10);
    frame(t, now + 16, [me, at("bob", gateFront.x, gateFront.y)]);
    expect(t.drawnAt("bob", now + 16, gateFront)).toEqual({ x: 116, y: DEEP });
    const mid = t.drawnAt("bob", now + 16 + 60, gateFront)!;
    expect(mid.y).toBeGreaterThan(DEEP);
    expect(mid.y).toBeLessThan(gateFront.y);
    expect(walkOutPose(t.walkOutOf("bob")!, now + 16 + 60)).toBe("walk_down");
    expect(t.flashOf("Gate", now + 16 + 70)).toBeCloseTo(1, 5);
    expect(t.drawnAt("bob", now + 16 + OUT_MS, gateFront)).toEqual(gateFront);
    // stood facing down for a moment, then let go
    expect(walkOutPose(t.walkOutOf("bob")!, now + 16 + OUT_MS)).toBe("idle_down");
    frame(t, now + 16 + OUT_MS + SETTLE_MS, [me, at("bob", gateFront.x, gateFront.y)]);
    expect(t.walkOutOf("bob")).toBeUndefined();
    expect(t.drawnAt("bob", now + 16 + OUT_MS + SETTLE_MS, gateFront)).toEqual(gateFront);
  });

  test("one who appears at an arrival spot not having come through the portal (logged in, or reconnected there) is just there", () => {
    const me = at("me", 300, 300);
    const { t, now } = settled([me]);
    frame(t, now + 16, [me, at("bob", gateFront.x, gateFront.y)]);
    expect(t.walkOutOf("bob")).toBeUndefined();
    expect(t.drawnAt("bob", now + 16, gateFront)).toEqual(gateFront);
    expect(t.flashOf("Gate", now + 16 + 70)).toBe(0);
    // a portal trip told of long before is not this appearance
    const u = settled([me]);
    u.t.cameThrough("bob", u.now);
    frame(u.t, u.now + 5000, [me, at("bob", gateFront.x, gateFront.y)]);
    expect(u.t.walkOutOf("bob")).toBeUndefined();
  });

  test("the players already on a map when it loads are just there, even at an arrival spot", () => {
    const t = new TransitTracker<string>();
    frame(t, 0, [at("me", 300, 300)]);
    frame(t, 100, [at("me", 300, 300), at("bob", gateFront.x, gateFront.y)]);
    expect(t.walkOutOf("bob")).toBeUndefined();
    expect(t.drawnAt("bob", 100, gateFront)).toEqual(gateFront);
  });

  test("a jump from a portal (a teleport on the same map) walks on into the old one, then out of the new", () => {
    const me = at("me", 300, 300), bob = at("bob", 116, 150);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me, at("bob", 116, 144)]);
    // the teleport puts them in front of Crypt (its foot is 132)
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 32, [me, at("bob", crypt.x, crypt.y)]);
    // first on into Gate, from where they were drawn; not yet drawn at Crypt
    const IN = (144 - DEEP) / SPEED;
    expect(t.walkersAt(now + 32)).toMatchObject([{ id: "bob", ref: "bob", x: 116, y: 144, portal: "Gate", foot: FOOT, walk: { portal: "Gate", at: now + 32 } }]);
    expect(t.drawnAt("bob", now + 32, crypt)).toBeNull();
    expect(t.drawnAt("bob", now + 32 + IN - 1, crypt)).toBeNull();
    // then out of Crypt, from as deep in it
    expect(t.walkersAt(now + 32 + IN)).toEqual([]);
    expect(t.drawnAt("bob", now + 32 + IN, crypt)).toEqual({ x: 416, y: 132 - THROUGH_DEPTH - 16 });
    expect(t.drawnAt("bob", now + 32 + IN + OUT_MS, crypt)).toEqual(crypt);
    expect(t.flashOf("Gate", now + 32 + (144 + 16 - FOOT) / SPEED + 70)).toBeCloseTo(1, 5);
    expect(t.flashOf("Crypt", now + 32 + IN - 1)).toBe(0);
    expect(t.flashOf("Crypt", now + 32 + IN + 70)).toBeCloseTo(1, 5);
    // only the local player's trips count for the keys
    expect(t.warps).toBe(0);
  });

  test("a long move that is not from a portal or onto an arrival spot is not a portal trip", () => {
    const me = at("me", 300, 300), bob = at("bob", 600, 600);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me, at("bob", 900, 900)]);
    expect(t.walkersAt(now + 16)).toEqual([]);
    expect(t.drawnAt("bob", now + 16, { x: 900, y: 900 })).toEqual({ x: 900, y: 900 });
  });

  test("one who steps into a portal that does not take them (refused, or a choice open) is just drawn where they are", () => {
    const me = at("me", 300, 300), bob = at("bob", 116, 150);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me, at("bob", 116, 140)]);
    frame(t, now + 2000, [me, at("bob", 116, 140)]);
    expect(t.walkersAt(now + 2000)).toEqual([]);
    expect(t.drawnAt("bob", now + 2000, { x: 116, y: 140 })).toEqual({ x: 116, y: 140 });
  });

  test("leaving the view from a portal that leads nowhere does nothing", () => {
    const me = at("me", 300, 300), bob = at("bob", 716, 134);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me]);
    expect(t.walkersAt(now + 16)).toEqual([]);
    expect(t.flashOf("Dead", now + 100)).toBe(0);
  });

  test("the local player who goes in walks on in to the plane, stands there while the next map loads, then walks out when it is shown", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    t.mapLoading(now + 20);
    expect(t.warps).toBe(1);
    expect(t.drawnAt("me", now + 20, { x: 116, y: 142 })).toBeNull();
    expect(t.walkersAt(now + 20)).toMatchObject([{ id: "me", ref: "me", x: 116, y: 142, portal: "Gate", foot: FOOT, walk: { portal: "Gate" } }]);
    // the walk in has this long to go (LOAD_MAP waits for it), and the camera keeps with it, then stays where it ended
    const IN = (142 - PLANE) / SPEED;
    expect(t.walkInLeft(now + 20)).toBeCloseTo(IN, 5);
    expect(t.walkInLeft(now + 20 + IN + 1)).toBe(0);
    expect(t.cameraAt(now + 20, { x: 116, y: 142 })).toEqual({ x: 116, y: 142 });
    expect(t.cameraAt(now + 20 + IN / 2, { x: 116, y: 142 }).y).toBeCloseTo((142 + PLANE) / 2, 5);
    expect(t.cameraAt(now + 20 + IN + 1, { x: 116, y: 142 })).toEqual({ x: 116, y: PLANE });
    // drawn by the walk in until it ends, then standing where it ended, never gone
    expect(t.waitingAt(now + 20 + IN / 2)).toBeNull();
    expect(t.waitingAt(now + 20 + IN + 1)).toMatchObject({ ref: "me", x: 116, y: PLANE });
    // a second LOAD_MAP for the same trip is the same trip
    t.mapLoading(now + 30);
    expect(t.warps).toBe(1);
    // the next map: the server puts them in front of the far portal (here Gate on "town"), not shown yet
    const there = at("me", gateFront.x, gateFront.y);
    frame(t, now + 400, [at("me", 116, 142)], "town");
    frame(t, now + 500, [there], "town");
    expect(t.drawnAt("me", now + 500, gateFront)).toBeNull();
    // the camera is where the walk out will start: as deep in the far portal as the walk in ended in the near one
    expect(t.cameraAt(now + 500, gateFront)).toEqual({ x: 116, y: PLANE });
    // and drawn standing there, on the far plane, until the map is shown
    expect(t.waitingAt(now + 500)).toMatchObject({ ref: "me", x: 116, y: PLANE });
    t.reveal(now + 700);
    frame(t, now + 716, [there], "town");
    expect(t.drawnAt("me", now + 699, gateFront)).toBeNull();
    expect(t.cameraAt(now + 699, gateFront)).toEqual({ x: 116, y: PLANE });
    expect(t.drawnAt("me", now + 700, gateFront)).toEqual({ x: 116, y: PLANE });
    expect(t.waitingAt(now + 700)).toBeNull();
    expect(t.cameraAt(now + 760, gateFront)).toEqual(t.drawnAt("me", now + 760, gateFront)!);
    const out = t.drawnAt("me", now + 760, gateFront)!;
    expect(out.y).toBeLessThan(gateFront.y);
    expect(walkOutPose(t.walkOutOf("me")!, now + 760)).toBe("walk_down");
    expect(t.flashOf("Gate", now + 770)).toBeCloseTo(1, 5);
    expect(t.drawnAt("me", now + 700 + LOCAL_OUT_MS, gateFront)).toEqual(gateFront);
  });

  test("a map shown before its first frame is seen still walks the arrival out at once", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    t.mapLoading(now + 20);
    t.reveal(now + 300);
    frame(t, now + 316, [at("me", gateFront.x, gateFront.y)], "town");
    expect(t.walkOutOf("me")?.at).toBe(now + 316);
  });

  test("logging in, or reconnecting, at a portal's arrival spot: the player is just there, as anywhere else", () => {
    const t = new TransitTracker<string>();
    frame(t, 0, [at("me", gateFront.x, gateFront.y)]);
    t.reveal(50);
    expect(t.walkOutOf("me")).toBeUndefined();
    expect(t.drawnAt("me", 60, gateFront)).toEqual(gateFront);
    expect(t.cameraAt(60, gateFront)).toEqual(gateFront);
    const u = new TransitTracker<string>();
    frame(u, 0, [at("me", 300, 300)]);
    u.reveal(50);
    expect(u.walkOutOf("me")).toBeUndefined();
    expect(u.drawnAt("me", 60, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
    // reconnected on the same map, standing there all along
    const { t: r, now } = settled([at("me", gateFront.x, gateFront.y)]);
    r.reveal(now + 10);
    frame(r, now + 20, [at("me", gateFront.x, gateFront.y)]);
    expect(r.walkOutOf("me")).toBeUndefined();
  });

  test("the local player who goes into a portal and drops out of the world before the next map comes (a node switch) still walks out of the far one", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    frame(t, now + 32, []);
    t.mapLoading(now + 40);
    expect(t.walkInLeft(now + 40)).toBeGreaterThan(0);
    frame(t, now + 400, [at("me", gateFront.x, gateFront.y)], "town");
    t.reveal(now + 500);
    expect(t.walkOutOf("me")?.at).toBe(now + 500);
  });

  test("a held arrival is shown anyway after HOLD_MAX_MS", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    t.mapLoading(now + 20);
    frame(t, now + 100, [at("me", gateFront.x, gateFront.y)], "town");
    frame(t, now + 100 + HOLD_MAX_MS + 1, [at("me", gateFront.x, gateFront.y)], "town");
    expect(t.walkOutOf("me")).toBeDefined();
  });

  test("a next map that is the same map (or one that never comes) still shows the local player again", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    t.mapLoading(now + 20);
    t.reveal(now + 400);
    frame(t, now + 416, [at("me", gateFront.x, gateFront.y)]);
    expect(t.drawnAt("me", now + 416, gateFront)).toBeNull();
    frame(t, now + 1500, [at("me", gateFront.x, gateFront.y)]);
    expect(t.walkOutOf("me")?.at).toBe(now + 1500);
    expect(t.drawnAt("me", now + 1500 + LOCAL_OUT_MS, gateFront)).toEqual(gateFront);
    const u = settled([at("me", 116, 150)]);
    frame(u.t, u.now + 16, [at("me", 116, 142)]);
    u.t.mapLoading(u.now + 20);
    frame(u.t, u.now + 20 + HOLD_MAX_MS + 1, [at("me", 300, 300)]);
    expect(u.t.drawnAt("me", u.now + 20 + HOLD_MAX_MS + 1, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
  });

  test("leaving a dungeon puts the player in the portal's middle: shown there at once, the portal flashing", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    t.mapLoading(now + 20);
    const middle = { x: 416, y: 116 };
    frame(t, now + 100, [at("me", middle.x, middle.y)], "town");
    t.reveal(now + 200);
    expect(t.walkOutOf("me")).toBeUndefined();
    expect(t.drawnAt("me", now + 200, middle)).toEqual(middle);
    expect(t.flashOf("Crypt", now + 270)).toBeCloseTo(1, 5);
  });

  test("the local player's teleport on the same map walks on in, waits in the portal for the ground where they land, then walks out of the far one", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 32, [at("me", crypt.x, crypt.y)]);
    expect(t.warps).toBe(1);
    const IN = (142 - PLANE) / SPEED;
    // where they land, for the ground round it to be loaded
    expect(t.landingSpot()).toEqual(crypt);
    expect(t.drawnAt("me", now + 32, crypt)).toBeNull();
    // the camera keeps with the walk in, then stays where it ended while that ground loads
    expect(t.cameraAt(now + 32, crypt)).toEqual({ x: 116, y: 142 });
    frame(t, now + 32 + IN + 200, [at("me", crypt.x, crypt.y)]);
    expect(t.drawnAt("me", now + 32 + IN + 200, crypt)).toBeNull();
    expect(t.cameraAt(now + 32 + IN + 200, crypt)).toEqual({ x: 116, y: PLANE });
    expect(t.waitingAt(now + 32 + IN + 200)).toMatchObject({ ref: "me", x: 116, y: PLANE });
    // the ground is there: they walk out of Crypt from as deep in it, the arch round them where Gate's was on screen
    const shown = now + 32 + IN + 300;
    t.landed(shown);
    expect(t.landingSpot()).toBeNull();
    expect(t.waitingAt(shown)).toBeNull();
    const firstOut = t.cameraAt(shown, crypt);
    expect(firstOut).toEqual({ x: 416, y: 132 - 16 });
    expect(PLANE - FOOT).toBeCloseTo(firstOut.y - 132, 2);
    expect(t.drawnAt("me", shown, crypt)).toEqual(firstOut);
    expect(t.flashOf("Crypt", shown + 70)).toBeCloseTo(1, 5);
    expect(t.drawnAt("me", shown + LOCAL_OUT_MS, crypt)).toEqual(crypt);
    expect(t.cameraAt(shown + LOCAL_OUT_MS, crypt)).toEqual(crypt);
  });

  test("ground already there on a teleport on the same map: the walk out starts as the walk in ends", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 32, [at("me", crypt.x, crypt.y)]);
    t.landed(now + 40);
    const IN = (142 - PLANE) / SPEED;
    expect(t.walkOutOf("me")?.at).toBeCloseTo(now + 32 + IN, 5);
    expect(t.drawnAt("me", now + 32 + IN - 1, crypt)).toBeNull();
  });

  test("the local player who walks in off the arch's middle walks out of the far one as far off it, the arch not shifting", () => {
    const { t, now } = settled([at("me", 112, 150)]);
    frame(t, now + 16, [at("me", 112, 142)]);
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 32, [at("me", crypt.x, crypt.y)]);
    const IN = (142 - PLANE) / SPEED;
    const last = t.cameraAt(now + 32 + IN + 1, crypt);
    expect(last).toEqual({ x: 112, y: PLANE });
    t.landed(now + 32 + IN + 100);
    const first = t.cameraAt(now + 32 + IN + 100, crypt);
    expect(first).toEqual({ x: 412, y: 132 - 16 });
    // the player stands as far from each arch's middle (116, then 416) on screen
    expect(first.x - 416).toBe(last.x - 116);
    expect(t.drawnAt("me", now + 32 + IN + 100 + 1000, crypt)).toEqual(crypt);
  });

  test("one figure of a player through a whole trip: the far side's picture does not show again one a trip draws", () => {
    // the figures of `id` drawn now: where they stand or walk out, on a walk in, waiting between, and on a portal's
    // picture of the far side, where the server already has them once the trip starts
    const copies = (t: TransitTracker<string>, id: string, now: number, drawn: { x: number; y: number }): number =>
      (t.drawnAt(id, now, drawn) ? 1 : 0) +
      t.walkersAt(now).filter((w) => w.id === id).length +
      (id === "me" && t.waitingAt(now) ? 1 : 0) +
      (t.travellers().has(id) ? 0 : 1);
    // the local player's teleport on the same map: walk in, wait for the far ground, walk out, stand
    const { t, now } = settled([at("me", 116, 150)]);
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 16, [at("me", 116, 142)]);
    frame(t, now + 32, [at("me", crypt.x, crypt.y)]);
    const IN = (142 - PLANE) / SPEED;
    for (const ms of [0, IN / 2, IN + 1, IN + 200]) expect(copies(t, "me", now + 32 + ms, crypt)).toBe(1);
    const shown = now + 32 + IN + 300;
    t.landed(shown);
    for (const ms of [0, LOCAL_OUT_MS / 2, LOCAL_OUT_MS]) {
      frame(t, shown + ms, [at("me", crypt.x, crypt.y)]);
      expect(copies(t, "me", shown + ms, crypt)).toBe(1);
    }
    // once the walk out is over they are drawn once where they stand, and seen through the other portal as anyone there
    const after = shown + LOCAL_OUT_MS + SETTLE_MS + 1;
    frame(t, after, [at("me", crypt.x, crypt.y)]);
    expect(t.drawnAt("me", after, crypt)).toEqual(crypt);
    expect(t.walkersAt(after)).toEqual([]);
    expect(t.waitingAt(after)).toBeNull();
    expect(t.travellers().has("me")).toBe(false);
    // to another map: walk in, wait while it loads, walk out once it is shown
    const u = settled([at("me", 116, 150)]);
    frame(u.t, u.now + 16, [at("me", 116, 142)]);
    u.t.mapLoading(u.now + 20);
    for (const ms of [0, IN / 2, IN + 1]) expect(copies(u.t, "me", u.now + 20 + ms, gateFront)).toBe(1);
    frame(u.t, u.now + 500, [at("me", gateFront.x, gateFront.y)], "town");
    expect(copies(u.t, "me", u.now + 500, gateFront)).toBe(1);
    u.t.reveal(u.now + 700);
    for (const ms of [0, LOCAL_OUT_MS / 2, LOCAL_OUT_MS]) expect(copies(u.t, "me", u.now + 700 + ms, gateFront)).toBe(1);
    // another player seen going through on the same map: walking in, then walking out
    const v = settled([at("me", 300, 300), at("bob", 116, 152)]);
    frame(v.t, v.now + 16, [at("me", 300, 300), at("bob", 116, 144)]);
    frame(v.t, v.now + 32, [at("me", 300, 300), at("bob", crypt.x, crypt.y)]);
    const BOB_IN = (144 - DEEP) / SPEED;
    for (const ms of [0, BOB_IN / 2, BOB_IN, BOB_IN + OUT_MS / 2]) {
      frame(v.t, v.now + 32 + ms, [at("me", 300, 300), at("bob", crypt.x, crypt.y)]);
      expect(copies(v.t, "bob", v.now + 32 + ms, crypt)).toBe(1);
    }
  });

  test("ground that never comes on a teleport on the same map: the player walks out anyway after HOLD_MAX_MS", () => {
    const { t, now } = settled([at("me", 116, 150)]);
    frame(t, now + 16, [at("me", 116, 142)]);
    const crypt = { x: 416, y: 132 + ARRIVAL_GAP };
    frame(t, now + 32, [at("me", crypt.x, crypt.y)]);
    frame(t, now + 32 + HOLD_MAX_MS + 1, [at("me", crypt.x, crypt.y)]);
    expect(t.landingSpot()).toBeNull();
    expect(t.walkOutOf("me")?.at).toBe(now + 32 + HOLD_MAX_MS + 1);
  });

  test("the camera looks at others' walks not at all: only the local player's", () => {
    const me = at("me", 300, 300);
    const { t, now } = settled([me]);
    frame(t, now + 16, [me, at("bob", gateFront.x, gateFront.y)]);
    expect(t.cameraAt(now + 30, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
  });

  test("a new map drops the last one's walks and flashes", () => {
    const me = at("me", 300, 300), bob = at("bob", 116, 150);
    const { t, now } = settled([me, bob]);
    frame(t, now + 16, [me, at("bob", 116, 140)]);
    frame(t, now + 20, [me]);
    expect(t.walkersAt(now + 20)).toHaveLength(1);
    frame(t, now + 24, [me], "town");
    expect(t.walkersAt(now + 24)).toEqual([]);
    expect(t.flashOf("Gate", now + 100)).toBe(0);
  });
});

describe("when the map counts as shown", () => {
  test("after the black fade or the loading screen has mostly lifted; at once when nothing covers it", () => {
    expect(shownAfter("fade")).toBeGreaterThan(0);
    expect(shownAfter("loading")).toBeGreaterThan(shownAfter("fade"));
    expect(shownAfter(null)).toBe(0);
  });
});

describe("keys held through a portal", () => {
  test("do not walk until let go; other keys walk; a key let go and pressed again walks", () => {
    const h = new HeldKeys();
    expect(h.free(["KeyW"])).toEqual(new Set(["KeyW"]));
    h.hold(["KeyW", "KeyA"], false);
    expect(h.free(["KeyW", "KeyA"])).toEqual(new Set());
    expect(h.free(["KeyW", "KeyA", "KeyD"])).toEqual(new Set(["KeyD"]));
    expect(h.free(["KeyW"])).toEqual(new Set());
    expect(h.free([])).toEqual(new Set());
    expect(h.free(["KeyW"])).toEqual(new Set(["KeyW"]));
  });

  test("the stick held through one does not walk until it is let go", () => {
    const h = new HeldKeys();
    expect(h.stickFree(true)).toBe(true);
    h.hold([], true);
    expect(h.stickFree(true)).toBe(false);
    expect(h.stickFree(false)).toBe(true);
    expect(h.stickFree(true)).toBe(true);
  });
});

describe("posing a walk out", () => {
  const anim = (name: string) => ({ currentAnimationName: name });
  const change = (a: any, name: string) => { a.currentAnimationName = name; };

  test("walking down, then standing facing down", () => {
    const w = walkOutOf(gate, gateFront, 0, SPEED)!;
    const p: any = { layeredAnimation: anim("idle_up"), lastDirection: "up" };
    steerWalkOutPose(p, w, 0, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_down");
    expect(p.lastDirection).toBe("down");
    steerWalkOutPose(p, w, OUT_MS, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_down");
  });

  test("a pose from elsewhere meanwhile wins; an animation built anew is posed again", () => {
    const w = walkOutOf(gate, gateFront, 0, SPEED)!;
    const p: any = { layeredAnimation: anim("idle_up") };
    steerWalkOutPose(p, w, 0, change);
    p.layeredAnimation = anim("idle_down");
    steerWalkOutPose(p, w, 10, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_down");
    p.layeredAnimation.currentAnimationName = "walk_left";
    steerWalkOutPose(p, w, 20, change);
    steerWalkOutPose(p, w, OUT_MS, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_left");
  });
});

describe("posing a walk in", () => {
  const anim = (name: string) => ({ currentAnimationName: name });
  const change = (a: any, name: string) => { a.currentAnimationName = name; };

  test("walking up into the portal, facing it, as a walk out walks down out of one", () => {
    const w = walkInto(gate, gateFront, 0, SPEED);
    // (one the server stopped just before they went, standing facing up)
    const p: any = { layeredAnimation: anim("idle_up"), lastDirection: "down" };
    steerWalkInPose(p, w, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_up");
    expect(p.lastDirection).toBe("up");
    steerWalkInPose(p, w, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_up");
  });

  test("a pose from elsewhere meanwhile wins; an animation built anew is posed again", () => {
    const w = walkInto(gate, gateFront, 0, SPEED);
    const p: any = { layeredAnimation: anim("idle_down") };
    steerWalkInPose(p, w, change);
    p.layeredAnimation = anim("idle_down");
    steerWalkInPose(p, w, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_up");
    p.layeredAnimation.currentAnimationName = "walk_left";
    steerWalkInPose(p, w, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_left");
  });
});
