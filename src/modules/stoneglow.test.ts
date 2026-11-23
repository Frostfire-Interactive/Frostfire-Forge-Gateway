import { describe, expect, test } from "bun:test";
import { hexToRgb, isNearWhite, isPale, stoneGlowPixels } from "../webserver/public/js/core/stoneglow";

const px = () => new Uint8ClampedArray([255, 255, 255, 255, 138, 125, 120, 255, 0, 0, 0, 0]);
const RUNE = [255, 241, 229, 255], PALE = [171, 146, 123, 255], STONE = [138, 125, 120, 255];
const row = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

describe("stone glow", () => {
  test("a rune pixel is fully opaque with its channels adding up to 600 or more", () => {
    expect(isNearWhite(255, 241, 229, 255)).toBe(true);
    expect(isNearWhite(235, 203, 173, 255)).toBe(true);
    expect(isNearWhite(200, 200, 200, 255)).toBe(true);
    expect(isNearWhite(200, 200, 199, 255)).toBe(false);
    expect(isNearWhite(171, 146, 123, 255)).toBe(false);
    expect(isNearWhite(255, 255, 255, 0)).toBe(false);
  });

  test("a pale pixel is fully opaque with its channels adding up to 420 to 599", () => {
    expect(isPale(171, 146, 123, 255)).toBe(true);
    expect(isPale(140, 140, 140, 255)).toBe(true);
    expect(isPale(140, 140, 139, 255)).toBe(false);
    expect(isPale(138, 125, 120, 255)).toBe(false);
    expect(isPale(235, 203, 173, 255)).toBe(false);
  });

  test("rune pixels take the glow colour; others stay as they are", () => {
    const { art, glow } = stoneGlowPixels(px(), "#66ccff", 3);
    expect(Array.from(art)).toEqual([102, 204, 255, 255, 138, 125, 120, 255, 0, 0, 0, 0]);
    expect(Array.from(glow)).toEqual([102, 204, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("a pale pixel touching a rune, or joined to one through pale pixels, is traced darkened as much", () => {
    // 440 of the brightest rune shade's 725
    const { art, glow } = stoneGlowPixels(row(RUNE, PALE, PALE, STONE), "#66ccff", 4);
    expect(Array.from(art.slice(4, 12))).toEqual([62, 124, 155, 255, 62, 124, 155, 255]);
    expect(Array.from(glow.slice(4, 12))).toEqual([102, 204, 255, 155, 102, 204, 255, 155]);
    // touching corner to corner counts: the rune is at (0, 0), the pale pixel at (1, 1)
    const corner = stoneGlowPixels(row(RUNE, STONE, STONE, PALE), "#66ccff", 2);
    expect(Array.from(corner.art.slice(12, 16))).toEqual([62, 124, 155, 255]);
  });

  test("a pale pixel apart from every rune stays as it is", () => {
    const { art, glow } = stoneGlowPixels(row(RUNE, STONE, PALE, PALE), "#66ccff", 4);
    expect(Array.from(art.slice(8))).toEqual([...PALE, ...PALE]);
    expect(Array.from(glow.slice(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("rows do not wrap: a pale pixel at the start of a row does not touch a rune at the end of the row above", () => {
    // 3 wide: the rune ends the first row, the pale pixel starts the second, right after it in memory
    const { glow } = stoneGlowPixels(row(STONE, STONE, RUNE, PALE, STONE, STONE), "#66ccff", 3);
    expect(Array.from(glow.slice(12, 16))).toEqual([0, 0, 0, 0]);
  });

  test("a bad colour glows #66ccff", () => {
    expect(Array.from(stoneGlowPixels(px(), "blue", 3).glow.slice(0, 3))).toEqual([102, 204, 255]);
    expect(hexToRgb("#66CCFF")).toEqual([102, 204, 255]);
    expect(hexToRgb("66ccff")).toBeNull();
  });

  test("the input is not changed", () => {
    const src = row(RUNE, PALE, STONE);
    stoneGlowPixels(src, "#ff0000", 3);
    expect(Array.from(src)).toEqual([...RUNE, ...PALE, ...STONE]);
  });
});
