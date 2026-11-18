import { expect, test } from "bun:test";
import { clampView, detailPieces, fitScale, MAX_SCALE, toScreen, toTile, zoomAt } from "../webserver/public/js/core/zonemapview";

test("the whole map fits: the scale of the tighter side", () => {
  expect(fitScale(1000, 800, 10240, 10240)).toBeCloseTo(800 / 10240);
  expect(fitScale(1000, 800, 100, 50)).toBeCloseTo(10);
});

test("a screen point and its tile go back and forth", () => {
  const view = { x: 100, y: 200, scale: 4 };
  expect(toTile(view, 40, 80)).toEqual({ x: 110, y: 220 });
  expect(toScreen(view, 110, 220)).toEqual({ x: 40, y: 80 });
});

test("zooming keeps the tile under the cursor where it is", () => {
  const start = { x: 1000, y: 1000, scale: 1 };
  const before = toTile(start, 300, 200);
  const view = zoomAt(start, 4, 300, 200, 1000, 800, 10240, 10240);
  expect(view.scale).toBeCloseTo(4);
  const after = toTile(view, 300, 200);
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
});

test("zoom stops at single tiles and at the whole map", () => {
  const inView = zoomAt({ x: 0, y: 0, scale: 40 }, 10, 0, 0, 1000, 800, 10240, 10240);
  expect(inView.scale).toBe(MAX_SCALE);
  const outView = zoomAt({ x: 0, y: 0, scale: 1 }, 0.0001, 0, 0, 1000, 800, 10240, 10240);
  expect(outView.scale).toBeCloseTo(800 / 10240);
});

test("a side the map does not fill is centred", () => {
  // 100 x 50 tiles at 10 px a tile: 1000 x 500 on a 1000 x 800 canvas, 150 px above and below
  const view = clampView({ x: 30, y: 30, scale: 10 }, 1000, 800, 100, 50);
  expect(view.x).toBeCloseTo(0);
  expect(view.y).toBeCloseTo(-15);
});

test("the map's edges stay at or past the canvas edges", () => {
  const left = clampView({ x: -50, y: -50, scale: 2 }, 1000, 800, 10240, 10240);
  expect(left.x).toBe(0);
  expect(left.y).toBe(0);
  const right = clampView({ x: 10000, y: 10000, scale: 2 }, 1000, 800, 10240, 10240);
  expect(right.x).toBe(10240 - 500);
  expect(right.y).toBe(10240 - 400);
});

test("no detail pieces for a map baked a pixel per tile, or while a baked pixel is small", () => {
  expect(detailPieces({ x: 0, y: 0, scale: 10 }, 1000, 800, 300, 300, 1, 1024)).toEqual([]);
  // the 10240 world baked at 4 tiles a pixel, seen whole: a baked pixel is far under 2 screen px
  expect(detailPieces({ x: 0, y: 0, scale: 800 / 10240 }, 1000, 800, 10240, 10240, 4, 1024)).toEqual([]);
});

test("zoomed in on a world baked smaller, the pieces the view touches", () => {
  // 1 px a tile: a baked pixel is 4 screen px; the view is tiles 1000..2000 x 1000..1800
  const pieces = detailPieces({ x: 1000, y: 1000, scale: 1 }, 1000, 800, 10240, 10240, 4, 1024);
  expect(pieces).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  // inside one piece only
  expect(detailPieces({ x: 2100, y: 3100, scale: 10 }, 1000, 800, 10240, 10240, 4, 1024)).toEqual([[2, 3]]);
});
