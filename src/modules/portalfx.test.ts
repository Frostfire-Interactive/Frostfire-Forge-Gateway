import { expect, mock, test } from "bun:test";

// portalfx draws in the browser; these stand in for the modules it reaches the game through.
mock.module("../webserver/public/js/core/socket", () => ({ sendRequest: () => {}, cachedPlayerId: null }));
mock.module("../webserver/public/js/core/map", () => ({ loadTilesets: async () => [] }));
mock.module("../webserver/public/js/core/cache", () => ({ default: { getInstance: () => ({ players: [] }) } }));
mock.module("../webserver/public/js/core/ambience", () => ({ getAmbientLevel: () => [1, 1, 1], getNightFactor: () => 0 }));

const { glowPasses, inLightOf, layOn, mirrorTransform, onPicture, portalPalette, rimGlowFalloff } = await import("../webserver/public/js/core/portalfx");
const { PEEK_HALF_H, PEEK_HALF_W } = await import("../webserver/public/js/core/portalpeek");

const channels = (css: string): number[] => {
  const m = css.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

// The particles and the eye of the vortex, as the palette names them.
const lights = ["sparkHead", "sparkTail", "boltCore", "boltEdge", "wisp", "wispBright", "mote", "moteBright"] as const;

test("the sparks, lightning, wisps and motes take the portal's colour and are not white", () => {
  for (const [code, strong] of [["#ff2020", 0], ["#20c040", 1], ["#6eaaff", 2]] as const) {
    const p = portalPalette(code);
    for (const name of lights) {
      const c = channels(p[name]);
      // the portal's strongest channel stays the strongest, by at least 40% of the lead it has in the portal's colour
      for (let k = 0; k < 3; k++) if (k !== strong) expect(c[strong]! - c[k]!).toBeGreaterThanOrEqual(0.4 * (p.rim[strong] - p.rim[k]));
      expect(Math.min(...c)).toBeLessThan(200);
    }
  }
});

test("the eye of the vortex is the portal's colour lightened, not white", () => {
  const p = portalPalette("#ff2020");
  expect(p.rim).toEqual([255, 32, 32]);
  expect(p.core[0]).toBe(255);
  expect(p.core[1]).toBeGreaterThan(32);
  expect(p.core[1]).toBeLessThan(140);
  expect(p.core[1]).toBe(p.core[2]);
  expect(portalPalette("#2040ff").core).not.toEqual(p.core);
});

test("the rim glow fades smoothly to nothing", () => {
  let last = Infinity;
  for (let d = 1; d <= 5; d++) {
    const k = rimGlowFalloff(d);
    expect(k).toBeLessThan(last);
    last = k;
  }
  // soft at its brightest, and gone just past the reach
  expect(rimGlowFalloff(1)).toBeLessThan(0.75);
  expect(rimGlowFalloff(6)).toBe(0);
  expect(rimGlowFalloff(5)).toBeLessThan(0.05);
});

test("the far side is flipped top to bottom about the far place, left and right kept", () => {
  const [a, b, c, d, e, f] = mirrorTransform(320);
  const at = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
  // the far place, in the middle of the crop, stays put
  expect(at(96, 160)).toEqual([96, 160]);
  // what lies south of it shows above the middle, and what lies north below
  expect(at(10, 200)).toEqual([10, 120]);
  expect(at(150, 100)).toEqual([150, 220]);
  expect(at(0, 0)).toEqual([0, 320]);
});

test("the mirror line is the arch's foot: the far place shows there, at the opening's middle", () => {
  const box = { left: 27, right: 66 };
  expect(onPicture({ x: 100, foot: 200 }, { x: 100, y: 200 }, box, 94, 114)).toEqual({ x: PEEK_HALF_W, y: PEEK_HALF_H });
  // a step north of the foot is a step up the picture, as on the map
  expect(onPicture({ x: 100, foot: 200 }, { x: 103, y: 190 }, box, 94, 114)).toEqual({ x: PEEK_HALF_W + 3, y: PEEK_HALF_H - 10 });
});

test("a trim flash lays the glow on again: once at full for each whole step of its boost, then the rest", () => {
  expect(glowPasses(0)).toEqual([]);
  expect(glowPasses(0.4)).toEqual([0.4]);
  expect(glowPasses(1)).toEqual([1]);
  const passes = glowPasses(1.6);
  expect(passes.length).toBe(2);
  expect(passes[0]).toBe(1);
  expect(passes[1]).toBeCloseTo(0.6, 5);
});

test("a figure's sprite is laid over the far side's picture: opaque pixels cover it, see-through ones blend, past its edge is left off", () => {
  const picture = { data: new Uint8ClampedArray(3 * 2 * 4).fill(100), width: 3, height: 2 };
  // one opaque red pixel, then one half see-through blue one
  const sprite = { data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]), width: 2, height: 1 };
  const rgbAt = (x: number, y: number) => Array.from(picture.data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 3));
  // its blue pixel is past the right edge
  layOn(picture, sprite, 2, 1);
  expect(rgbAt(2, 1)).toEqual([255, 0, 0]);
  expect(rgbAt(0, 0)).toEqual([100, 100, 100]);
  // its red pixel is past the left edge
  layOn(picture, sprite, -1, 0);
  const k = 128 / 255;
  expect(rgbAt(0, 0)).toEqual([Math.round(100 - 100 * k), Math.round(100 - 100 * k), Math.round(100 + 155 * k)]);
  expect(rgbAt(1, 0)).toEqual([100, 100, 100]);
  // wholly off it, nothing
  layOn(picture, sprite, 5, 5);
  layOn(picture, sprite, -4, -4);
  expect(rgbAt(1, 1)).toEqual([100, 100, 100]);
});

test("whoever stands in front of a light, up to 120 past its foot and 40 past its half width to the side, is cut out of it", () => {
  const stone = { x: 100, foot: 200, half: 42, canvases: [], dx: 0, dy: 0 };
  const lights = [stone];
  expect(inLightOf({ feet: 216, x: 110 }, lights)).toEqual([stone]);
  expect(inLightOf({ feet: 200, x: 100 }, lights)).toEqual([stone]);
  expect(inLightOf({ feet: 216 }, lights)).toEqual([stone]);
  expect(inLightOf({ feet: 199, x: 100 }, lights)).toEqual([]);
  expect(inLightOf({ feet: 320, x: 100 }, lights)).toEqual([]);
  expect(inLightOf({ feet: 216, x: 181 }, lights)).toEqual([stone]);
  expect(inLightOf({ feet: 216, x: 182 }, lights)).toEqual([]);
  expect(inLightOf({ feet: 216, x: 18 }, lights)).toEqual([]);
});
