import { expect, test } from "bun:test";
import { planSelfSpawn, sameSprites, POST_HANDOFF_SPAWN_MS } from "../webserver/public/js/core/selfspawn";
import { pushSample, seedSamples, positionAt, TELEPORT_PX } from "../webserver/public/js/core/movementsmoothing";
import { nextPlaceOffset, skipSameWeather, weatherKey, inHandoffWindow, HANDOFF_WINDOW_MS } from "../webserver/public/js/core/handoffkeep";

// The server sends each sprite as an object, decoded fresh from every packet.
const sheetsOf = (over: Record<string, any> = {}) => JSON.parse(JSON.stringify({
  bodySprite: { name: "body.png", templateUrl: "/t/body", imageUrl: "/i/body" },
  headSprite: { name: "head.png", templateUrl: "/t/head", imageUrl: "/i/head" },
  mountSprite: null,
  ...over,
}));
const base = () => ({
  doneAt: 1000, now: 1400, doneMap: "main.json", spawnMap: "main.json",
  position: { x: 12430, y: 500 }, spawnPoint: { x: 12370, y: 500 },
  oldSprites: sheetsOf(), newSprites: sheetsOf(), currentPose: "walk_right", lastDirection: "right", moveHeld: true,
});

test("right after a handoff the same sheets (fresh objects) are kept and the position is not snapped", () => {
  expect(sameSprites(sheetsOf(), sheetsOf())).toBe(true);
  expect(planSelfSpawn(base())).toEqual({ snap: false, rebuild: false, keepPose: null });
});

test("a sheet whose name differs is a change; the pose that was on is kept: walk while held, else the old pose", () => {
  const changed = { ...base(), newSprites: sheetsOf({ armorChestSprite: { name: "c.png" } }) };
  expect(sameSprites(changed.oldSprites, changed.newSprites)).toBe(false);
  expect(sameSprites(sheetsOf(), sheetsOf({ bodySprite: { name: "other.png" } }))).toBe(false);
  expect(planSelfSpawn(changed)).toEqual({ snap: false, rebuild: true, keepPose: "walk_right" });
  // Held and not held give different answers: a mutation that ignores moveHeld is caught here.
  expect(planSelfSpawn({ ...changed, currentPose: "idle_right", moveHeld: true }).keepPose).toBe("walk_right");
  expect(planSelfSpawn({ ...changed, currentPose: "idle_right", moveHeld: false }).keepPose).toBe("idle_right");
  expect(planSelfSpawn({ ...changed, currentPose: "idle_up", moveHeld: false }).keepPose).toBe("idle_up");
});

test("outside the window (or with no handoff pending) a spawn is a real one: snap and rebuild", () => {
  const real = { snap: true, rebuild: true, keepPose: null };
  expect(planSelfSpawn({ ...base(), doneAt: null })).toEqual(real);
  expect(planSelfSpawn({ ...base(), now: 1000 + POST_HANDOFF_SPAWN_MS + 1 })).toEqual(real);
  expect(POST_HANDOFF_SPAWN_MS).toBeLessThanOrEqual(2000);
  expect(planSelfSpawn({ ...base(), now: 900 })).toEqual(real);
  expect(sameSprites(null, sheetsOf())).toBe(false);
});

test("a spawn on another map, or farther than a teleport, snaps as before (a warp or respawn right after a crossing)", () => {
  const real = { snap: true, rebuild: true, keepPose: null };
  expect(planSelfSpawn({ ...base(), spawnMap: "cave.json" })).toEqual(real);
  expect(planSelfSpawn({ ...base(), spawnPoint: { x: 12430 - TELEPORT_PX, y: 500 } })).toEqual(real);
  expect(planSelfSpawn({ ...base(), spawnPoint: { x: 12430 - TELEPORT_PX + 1, y: 500 } }).snap).toBe(false);
  // "main" and "main.json" are the same map.
  expect(planSelfSpawn({ ...base(), spawnMap: "main", doneMap: "Main.json" }).snap).toBe(false);
});

test("the first echoes after HANDOFF_DONE are accepted after a frame sample, and walk on from the seed", () => {
  const now = 50_000;
  const samples = seedSamples(100, 100, now);
  // the renderer pushes a frame sample at last.t + 0.01 only when the position moved; an echo a few ms older than now
  expect(pushSample(samples, 100, 100, now - 5)).toBe(true);
  expect(pushSample(samples, 106, 100, now + 28)).toBe(true);
  expect(positionAt(samples, now + 28)).toEqual({ x: 106, y: 100 });
  // the old way: an emptied list takes the frame sample at `now`, and an echo mapped a few ms older is dropped
  const old: any[] = [];
  pushSample(old, 100, 100, now);
  expect(pushSample(old, 106, 100, now - 5)).toBe(false);
});

test("socket.ts makes the guard one-shot and clears it on a switch and on LOAD_MAP", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).replace(/\r/g, "");
  expect(src).toContain("if (data.id === cachedPlayerId) lastHandoffDoneAt = null;");
  expect(src).toContain("lastHandoffDoneAt = null;\n      lastHandoffDoneStamp = null;\n      void switchNode(data);");
  expect(src).toContain("lastHandoffDoneAt = null;\n        lastHandoffDoneStamp = null;\n        clearSwitches();");
  expect(src).toContain("spawnMap: data.location?.map ?? null,");
});

test("a node taking over keeps the clock's place offset when it sends none; a given offset wins; outside a handoff it is dropped", () => {
  const held = 3600 * 1000;
  expect(nextPlaceOffset(held, undefined, true)).toBe(held);
  expect(nextPlaceOffset(held, 7200, true)).toBe(7200 * 1000);
  expect(nextPlaceOffset(held, undefined, false)).toBeNull();
  expect(nextPlaceOffset(held, 0, false)).toBe(0);
  expect(nextPlaceOffset(null, undefined, true)).toBeNull();
});

test("the same weather repeated right after a handoff is skipped; a different one, or the same later, is applied", () => {
  const rain = { weather: "rainy", weatherData: { wind_speed: 4, precipitation: 60 } };
  const applied = weatherKey(rain);
  expect(skipSameWeather(applied, JSON.parse(JSON.stringify(rain)), true)).toBe(true);
  expect(skipSameWeather(applied, { ...rain, weatherData: { wind_speed: 5, precipitation: 60 } }, true)).toBe(false);
  expect(skipSameWeather(applied, { weather: "clear", weatherData: null }, true)).toBe(false);
  expect(skipSameWeather(applied, rain, false)).toBe(false);
  expect(skipSameWeather(null, rain, true)).toBe(false);
});

test("the handoff window: under way, or within 3 s of DONE; not later, not without a DONE", () => {
  expect(HANDOFF_WINDOW_MS).toBe(3000);
  expect(inHandoffWindow(true, null, 5000)).toBe(true);
  expect(inHandoffWindow(false, 1000, 1000 + 2999)).toBe(true);
  expect(inHandoffWindow(false, 1000, 1000 + 3000)).toBe(false);
  expect(inHandoffWindow(false, 1000, 1000 + 3_000_000)).toBe(false);
  expect(inHandoffWindow(false, null, 5000)).toBe(false);
});

test("socket.ts: the clock and weather take the window; a switch and LOAD_MAP end it; a self spawn through createPlayer consumes the guard", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("updateTime(data, envelope?.utcOffset, inHandoffWindow());");
  expect(src).toContain("return inWindow(handoffResume, lastHandoffDoneStamp, performance.now());");
  expect(src).toContain("lastHandoffDoneStamp = null;\n      void switchNode(data);");
  expect(src).toContain("lastHandoffDoneStamp = null;\n        clearSwitches();");
  expect(src).toContain("if (data.id === cachedPlayerId) lastHandoffDoneAt = null;\n        await createPlayer(data);");
});
