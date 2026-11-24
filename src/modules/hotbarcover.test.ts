import { expect, test } from "bun:test";
import { hotbarCover } from "../webserver/public/js/core/hotbarcover";

// The hotbar covers the bottom of the screen on every device, so the camera keeps a map's bottom edge (and its exits)
// above it: not only on touch screens.

test("the screen under the hotbar's top is covered", () => {
  expect(hotbarCover({ top: 890, height: 110 }, 1000)).toBe(110);
});

test("a hidden hotbar covers nothing", () => {
  expect(hotbarCover({ top: 0, height: 0 }, 1000)).toBe(0);
  expect(hotbarCover(undefined, 1000)).toBe(0);
  expect(hotbarCover({ top: 1200, height: 110 }, 1000)).toBe(0);
});

test("never more than half the screen, whatever is measured", () => {
  expect(hotbarCover({ top: 100, height: 900 }, 1000)).toBe(500);
});
