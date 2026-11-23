// The glow of a summoning stone: the runes of its picture (public/img/summoning_stone.png, 64 x 96) are its two brightest
// shades (255,241,229 and 235,203,173), with the strokes of its pale shade (171,146,123) that touch them or join them
// through other pale pixels; the pale shade elsewhere (the top face, highlights) is stone. Rune pixels are recoloured to
// the stone's glow colour, darkened as much as each is darker than the brightest rune shade, and drawn again on top as
// the glow. No DOM here.

/** A rune pixel's three channels add up to this or more; the pale shade adds up to 440. */
export const RUNE_MIN_SUM = 600;
/** A pale pixel's channels add up to this or more (and less than RUNE_MIN_SUM); the art's next shade down (138,125,120) is stone. */
export const PALE_MIN_SUM = 420;
/** The brightest rune shade's channels added up (255 + 241 + 229): it, and anything brighter, takes the glow colour as is. */
const BRIGHTEST_SUM = 725;
export const STONE_W = 64;
export const STONE_H = 96;
/** The art's foot row: the stone stands on it, so its picture is drawn at (x - 32, y - 93). Rows 93 to 95 are empty. */
export const ART_FOOT_ROW = 93;
const DEFAULT_GLOW = "#66ccff";

/** Whether a pixel is a rune pixel: fully opaque, with its channels adding up to RUNE_MIN_SUM or more. */
export function isNearWhite(r: number, g: number, b: number, a: number): boolean {
  return a === 255 && r + g + b >= RUNE_MIN_SUM;
}

/** Whether a pixel is pale: fully opaque, with its channels adding up to PALE_MIN_SUM or more, but not a rune pixel. */
export function isPale(r: number, g: number, b: number, a: number): boolean {
  const sum = r + g + b;
  return a === 255 && sum >= PALE_MIN_SUM && sum < RUNE_MIN_SUM;
}

/** "#rrggbb" as its three channels, or null when it is not one. */
export function hexToRgb(hex: string): [number, number, number] | null {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Which pixels are traced: every rune pixel, and every pale pixel joined to one, side or corner, through pale pixels. */
function tracedPixels(src: Uint8ClampedArray, width: number): Uint8Array {
  const count = Math.floor(src.length / 4), height = Math.ceil(count / width);
  const traced = new Uint8Array(count);
  const pale = (p: number) => isPale(src[p * 4]!, src[p * 4 + 1]!, src[p * 4 + 2]!, src[p * 4 + 3]!);
  const queue: number[] = [];
  for (let p = 0; p < count; p++) {
    if (isNearWhite(src[p * 4]!, src[p * 4 + 1]!, src[p * 4 + 2]!, src[p * 4 + 3]!)) { traced[p] = 1; queue.push(p); }
  }
  while (queue.length) {
    const p = queue.pop()!, x = p % width, y = (p - x) / width;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, q = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || q >= count || traced[q] || !pale(q)) continue;
      traced[q] = 1;
      queue.push(q);
    }
  }
  return traced;
}

/**
 * The picture's RGBA pixels (`width` wide) split in two: `art` is a copy with the rune pixels set to the glow colour,
 * darkened by how much darker each is than the brightest rune shade, and `glow` is clear everywhere but those pixels,
 * which are the glow colour, as much fainter. A bad `hex` glows #66ccff.
 */
export function stoneGlowPixels(src: Uint8ClampedArray, hex: string, width: number = STONE_W): { art: Uint8ClampedArray; glow: Uint8ClampedArray } {
  const [r, g, b] = hexToRgb(hex) ?? hexToRgb(DEFAULT_GLOW)!;
  const art = new Uint8ClampedArray(src);
  const glow = new Uint8ClampedArray(src.length);
  const traced = tracedPixels(src, width);
  for (let p = 0; p < traced.length; p++) {
    if (!traced[p]) continue;
    const i = p * 4;
    const shade = Math.min(1, (src[i]! + src[i + 1]! + src[i + 2]!) / BRIGHTEST_SUM);
    art[i] = Math.round(r * shade); art[i + 1] = Math.round(g * shade); art[i + 2] = Math.round(b * shade);
    glow[i] = r; glow[i + 1] = g; glow[i + 2] = b; glow[i + 3] = Math.round(255 * shade);
  }
  return { art, glow };
}
