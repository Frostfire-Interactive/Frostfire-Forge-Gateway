import { describe, expect, test } from "bun:test";
import { UI_REFERENCE_HEIGHT, UI_REFERENCE_WIDTH, UI_SCALE_MAX, UI_SCALE_MIN, toZoomedPx, uiScaleFor } from "../webserver/public/js/core/uiscale.ts";

describe("UI scale from the size of the game window", () => {
  test("the reference window draws the UI at its written size", () => {
    expect(UI_REFERENCE_WIDTH).toBe(1920);
    expect(UI_REFERENCE_HEIGHT).toBe(1080);
    expect(uiScaleFor(1920, 1080, false)).toBe(1);
  });

  test("a smaller or larger window of the same shape scales the UI with it", () => {
    expect(uiScaleFor(1600, 900, false)).toBeCloseTo(1600 / 1920, 6);
    expect(uiScaleFor(2560, 1440, false)).toBeCloseTo(4 / 3, 6);
  });

  test("the side that is short of the reference decides, so the UI always fits", () => {
    // wide and short: the height
    expect(uiScaleFor(1920, 918, false)).toBeCloseTo(0.85, 6);
    // narrow and tall: the width
    expect(uiScaleFor(1728, 1080, false)).toBeCloseTo(0.9, 6);
  });

  test("a small window keeps the UI at 0.8 at least, so it can still be read", () => {
    expect(UI_SCALE_MIN).toBe(0.8);
    expect(uiScaleFor(1280, 720, false)).toBe(0.8);
  });

  test("it stays within its bounds", () => {
    expect(uiScaleFor(320, 200, false)).toBe(UI_SCALE_MIN);
    expect(uiScaleFor(7680, 4320, false)).toBe(UI_SCALE_MAX);
  });

  test("a touch screen keeps its own layouts at their size", () => {
    for (const [w, h] of [[844, 390], [1180, 820], [2560, 1440]]) expect(uiScaleFor(w, h, true)).toBe(1);
  });

  test("an unknown window size leaves the UI as written", () => {
    expect(uiScaleFor(0, 0, false)).toBe(1);
    expect(uiScaleFor(Number.NaN, 900, false)).toBe(1);
  });

  test("a screen position becomes the length to write inside a zoomed element", () => {
    expect(toZoomedPx(300, 0.75)).toBe(400);
    expect(toZoomedPx(300, 1)).toBe(300);
    // (no zoom known: as given)
    expect(toZoomedPx(300, 0)).toBe(300);
    expect(toZoomedPx(300, Number.NaN)).toBe(300);
  });
});
