import { expect, test } from "bun:test";
import { StopAfterMapLoad } from "../webserver/public/js/core/mapstop";

// After a warp into a new map the walk stops, unless a movement key or the stick is held when the player may move again.

test("a warp with nothing held stops the walk once the player may move", () => {
  const s = new StopAfterMapLoad();
  s.mapLoaded();
  // the map is still loading: nothing yet
  expect(s.due(false, false, false)).toBe(false);
  expect(s.due(true, false, false)).toBe(true);
  // once only
  expect(s.due(true, false, false)).toBe(false);
});

test("a key or the stick held walks on, and a key let go later still stops it", () => {
  const s = new StopAfterMapLoad();
  s.mapLoaded();
  expect(s.due(true, true, false)).toBe(false);
  expect(s.due(true, false, false)).toBe(true);
  s.mapLoaded();
  expect(s.due(true, false, true)).toBe(false);
  expect(s.due(true, false, false)).toBe(true);
});

test("a walk sent on the new map is stopped as any walk is, not here", () => {
  const s = new StopAfterMapLoad();
  s.mapLoaded();
  expect(s.due(true, true, false)).toBe(false);
  s.walked();
  expect(s.due(true, false, false)).toBe(false);
});

test("no map loaded, nothing to stop", () => {
  expect(new StopAfterMapLoad().due(true, false, false)).toBe(false);
});
