import { expect, test } from "bun:test";
import { badgeBox, badgeLabel, pillPerimeter } from "../webserver/public/js/core/keybadge";

// The key badges over NPCs, loot, corpses, mailboxes, gathering nodes and chests: they show the key the action is bound
// to (Hotkeys), and grow with the world zoom.

test("a badge shows the key its action is bound to", () => {
  expect(badgeLabel("interact")).toBe("E");
  expect(badgeLabel("openChest")).toBe("F");
});

test("one letter sits in a circle", () => {
  const box = badgeBox(10, 1, 7);
  expect(box.halfHeight).toBe(10);
  expect(box.halfWidth).toBe(10);
});

test("a longer key name widens the badge into a pill, the height kept", () => {
  const box = badgeBox(10, 1, 40);
  expect(box.halfHeight).toBe(10);
  expect(box.halfWidth).toBeGreaterThan(20);
});

test("the badge grows with the scale (screen density times world zoom)", () => {
  const normal = badgeBox(10, 1, 7);
  const zoomed = badgeBox(10, 3, 21);
  expect(zoomed.halfHeight).toBe(normal.halfHeight * 3);
  expect(zoomed.halfWidth).toBe(normal.halfWidth * 3);
});

test("a pill's outline is a circle's when it is no wider than tall", () => {
  expect(pillPerimeter(10, 10)).toBeCloseTo(2 * Math.PI * 10);
  expect(pillPerimeter(30, 10)).toBeCloseTo(2 * Math.PI * 10 + 4 * 20);
});
