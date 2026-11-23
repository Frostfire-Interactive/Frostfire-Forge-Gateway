import { afterEach, describe, expect, test } from "bun:test";
import { shadowsStone, stoneAt, stonesOnMap } from "../webserver/public/js/core/stonelist";
import { blockedAt, type WalkMap } from "../webserver/public/js/core/handoffwalk";

const g = globalThis as any;
afterEach(() => { delete g.window; });
const stone = { name: "Gate", position: { x: 100, y: 200 }, glowColor: "#FF0000", layer: "Ground" };

describe("stonesOnMap", () => {
  test("a list, or one keyed by name; colours lower-cased, bad ones the default; bad positions dropped", () => {
    expect(stonesOnMap([stone])).toEqual([{ name: "Gate", x: 100, y: 200, glowColor: "#ff0000" }]);
    expect(stonesOnMap({ K: { ...stone, name: "ignored" } })).toEqual([{ name: "K", x: 100, y: 200, glowColor: "#ff0000" }]);
    expect(stonesOnMap([{ ...stone, glowColor: "red" }])[0]!.glowColor).toBe("#66ccff");
    expect(stonesOnMap([{ ...stone, position: { x: "a", y: 1 } }])).toEqual([]);
    expect(stonesOnMap(null)).toEqual([]);
  });
});

describe("stoneAt", () => {
  test("the hit box is x-32..x+32, y-86..y, widened by the slop", () => {
    g.window = { mapData: { summoningStones: [stone] } };
    expect(stoneAt(100, 150)).toBe("Gate");
    expect(stoneAt(68, 114)).toBe("Gate");
    expect(stoneAt(132, 200)).toBe("Gate");
    expect(stoneAt(67, 150)).toBeNull();
    expect(stoneAt(133, 150)).toBeNull();
    expect(stoneAt(100, 113)).toBeNull();
    expect(stoneAt(100, 201)).toBeNull();
    expect(stoneAt(100, 90, 24)).toBe("Gate");
    expect(stoneAt(100, 89, 24)).toBeNull();
  });
  test("no map or no stones is no hit", () => {
    expect(stoneAt(100, 150)).toBeNull();
    g.window = { mapData: {} };
    expect(stoneAt(100, 150)).toBeNull();
  });
});

describe("a player over a stone", () => {
  const me = { id: "me" };
  test("the clicker's own character never takes the stone's click; another live player does", () => {
    // the toucher stands within 150 px of the stone, so their own sprite often covers its picture
    expect(shadowsStone(me, "me")).toBe(false);
    expect(shadowsStone({ id: "other" }, "me")).toBe(true);
  });
  test("a dead player or a ghost about to be moved is not picked, so the stone gets the click", () => {
    expect(shadowsStone({ id: "other", isDead: true }, "me")).toBe(false);
    expect(shadowsStone({ id: "other", isGhost: true, ghostTeleportPending: true }, "me")).toBe(false);
    expect(shadowsStone({ id: "other", isGhost: true }, "me")).toBe(true);
  });
  test("both stone guards in events.ts pick with it", async () => {
    const events = await Bun.file(new URL("../webserver/public/js/core/events.ts", import.meta.url)).text();
    const guard = "!playerAt(worldX, worldY, (player) => shadowsStone(player, cachedPlayerId))";
    expect(events.split(guard).length - 1).toBe(2);
    expect(events).not.toContain("!playerAt(worldX, worldY) &&");
  });
});

describe("blockedAt with a stone", () => {
  const map: WalkMap = { tilewidth: 16, tileheight: 16, chunkSize: 16, loadedChunks: new Map(), summoningStones: [stone] };
  test("a step into the footprint is refused; one beside it is allowed", () => {
    expect(blockedAt(map, 100, 180, { x: 100, y: 195 })).toBe(true);
    expect(blockedAt(map, 141, 165, { x: 141, y: 175 })).toBe(false);
    expect(blockedAt({ ...map, summoningStones: null }, 100, 180, { x: 100, y: 195 })).toBe(false);
  });
});

describe("touching a stone keeps the target", () => {
  test("the desktop stone check comes before the click clears the target", async () => {
    const events = await Bun.file(new URL("../webserver/public/js/core/events.ts", import.meta.url)).text();
    const click = events.slice(events.indexOf("if (cache.groundTargetingSpell)"));
    expect(click.indexOf("touchStoneAt(worldX, worldY, slop)")).toBeGreaterThan(-1);
    expect(click.indexOf("touchStoneAt(worldX, worldY, slop)")).toBeLessThan(click.indexOf("// Clear previous target"));
  });
  test("no Summon popup is left", async () => {
    const socket = await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text();
    const invites = await Bun.file(new URL("../webserver/public/js/core/invites.ts", import.meta.url)).text();
    expect(socket).not.toContain("SUMMON_STONE_CHOICE");
    expect(invites).not.toContain("summon-pick-popup");
  });
});

describe("the stones' shadows", () => {
  test("lie on the ground: drawn before anyone standing, not with the stone among them", async () => {
    const renderer = await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text();
    const shadows = renderer.indexOf("drawStoneShadows(scene)");
    expect(shadows).toBeGreaterThan(-1);
    expect(shadows).toBeLessThan(renderer.indexOf("backToFront(standing)"));
    const stones = await Bun.file(new URL("../webserver/public/js/core/summonstones.ts", import.meta.url)).text();
    const draw = stones.slice(stones.indexOf("export function standingStones"));
    expect(draw).not.toContain("shadow.canvas");
  });
});
