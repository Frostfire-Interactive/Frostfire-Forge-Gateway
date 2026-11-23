import { describe, expect, test } from "bun:test";
import { clampPanel, defaultPanelPosition, parsePanelState, serializePanelState } from "../webserver/public/js/core/stafftoolbarpos.ts";

const view = { width: 1000, height: 800 };
const size = { width: 60, height: 400 };

describe("clampPanel", () => {
  test("a panel inside the window stays where it is", () => {
    expect(clampPanel({ x: 300, y: 200 }, size, view)).toEqual({ x: 300, y: 200 });
  });

  test("a panel past an edge is moved back inside, the margin in", () => {
    expect(clampPanel({ x: -50, y: -20 }, size, view, 8)).toEqual({ x: 8, y: 8 });
    expect(clampPanel({ x: 990, y: 790 }, size, view, 8)).toEqual({ x: 1000 - 60 - 8, y: 800 - 400 - 8 });
  });

  test("a window smaller than before brings a saved position back in", () => {
    expect(clampPanel({ x: 1800, y: 900 }, size, { width: 640, height: 480 }, 8)).toEqual({ x: 640 - 60 - 8, y: 480 - 400 - 8 });
  });

  test("a panel taller than the window starts at the top margin", () => {
    expect(clampPanel({ x: 100, y: 300 }, { width: 60, height: 900 }, view, 8)).toEqual({ x: 100, y: 8 });
  });

  test("a position that is not a number is the corner", () => {
    expect(clampPanel({ x: NaN, y: Infinity }, size, view, 8)).toEqual({ x: 8, y: 8 });
  });
});

describe("defaultPanelPosition", () => {
  test("against the right edge, in the middle from top to bottom", () => {
    expect(defaultPanelPosition(size, view, 8)).toEqual({ x: 1000 - 60 - 8, y: 200 });
  });
});

describe("parsePanelState", () => {
  test("nothing saved, or something broken, is not moved and not minimized", () => {
    for (const raw of [null, undefined, "", "not json", "null", "42", '{"position":{"x":"a","y":1}}']) {
      expect(parsePanelState(raw)).toEqual({ position: null, minimized: false });
    }
  });

  test("reads back what was saved", () => {
    const state = { position: { x: 120, y: 340 }, minimized: true };
    expect(parsePanelState(serializePanelState(state))).toEqual(state);
  });

  test("minimized only when it says true", () => {
    expect(parsePanelState('{"minimized":"yes"}').minimized).toBe(false);
  });
});
