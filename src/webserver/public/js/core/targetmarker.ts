// The marker over whatever the player has targeted: a player, a creature, or a corpse.
// USER REQUEST 2026-10-18: "redesign the targeted red circle, it looks really bad and out of place",
// then picked the arrow over the head from three mock-ups. A glossy pixel arrow, in the style of the
// quest markers and UI frames (a body colour, a light edge, a dark brown outline), bobbing just over
// the top of the target's sprite. Drawn in world pixels, over the top tile layers (renderer.ts).
import { getVisibleLayersSorted } from "./layeredAnimation.js";

/** One arrow's colours: its body, the light edge across its top left, and its outline. */
export interface ArrowPalette {
  body: string;
  light: string;
  dark: string;
}

/** Arrow colours: a creature's by how it treats the player (as its nameplate is), a player's in the UI's gold. */
export const TARGET_ARROWS: Record<"hostile" | "neutral" | "friendly" | "tapped" | "player", ArrowPalette> = {
  hostile: { body: "#d8432c", light: "#ff9a7a", dark: "#3d1208" },
  neutral: { body: "#f0a020", light: "#ffd27a", dark: "#4a2a10" },
  friendly: { body: "#5fae3c", light: "#b7f08a", dark: "#1d3a10" },
  /** A creature someone outside the player's group has tagged, and a corpse. */
  tapped: { body: "#9a9a9a", light: "#dcdcdc", dark: "#2a2a2a" },
  player: { body: "#f0a020", light: "#ffd27a", dark: "#4a2a10" },
};

/**
 * The arrow's rows, top to bottom, as [from, to] columns about its middle: only its head, pointing
 * down, with no stem over it. Its tip is the last row.
 */
const ROWS: Array<[number, number]> = [[-6, 6], [-5, 5], [-4, 4], [-3, 3], [-2, 2], [-1, 1], [0, 0]];
/** The light pixels, as [column, row]: along the top left of the head. */
const SHINE: Array<[number, number]> = [[-5, 0], [-4, 0], [-3, 0], [-2, 0], [-4, 1], [-3, 1], [-3, 2]];
/** How far it bobs up from its rest (px), and how long one bob takes (ms). */
const BOB = 3;
const BOB_MS = 900;
/** Room left between the tip, at rest, and the top of the sprite (px). */
export const ARROW_GAP = 8;

/**
 * The arrow with its tip at (x, tipY), in world pixels; it bobs up from there, never down into the
 * head. Keeps the canvas's own alpha (a creature fading in fades its arrow with it) and leaves its
 * state as it found it.
 */
export function drawTargetArrow(ctx: CanvasRenderingContext2D, x: number, tipY: number, palette: ArrowPalette, now: number = performance.now()): void {
  const bob = Math.round(((1 - Math.cos((now / BOB_MS) * Math.PI * 2)) / 2) * BOB);
  const ax = Math.round(x);
  const top = Math.round(tipY) - (ROWS.length - 1) - bob;
  ctx.save();
  ctx.fillStyle = palette.dark;
  ROWS.forEach(([from, to], i) => ctx.fillRect(ax + from - 1, top + i - 1, to - from + 3, 3));
  ctx.fillStyle = palette.body;
  ROWS.forEach(([from, to], i) => ctx.fillRect(ax + from, top + i, to - from + 1, 1));
  ctx.fillStyle = palette.light;
  for (const [col, row] of SHINE) ctx.fillRect(ax + col, top + row, 1, 1);
  ctx.restore();
}

// The first row of each image with anything drawn in it, read once per image.
const opaqueRows = new WeakMap<CanvasImageSource, number>();

function firstOpaqueRow(img: HTMLImageElement | HTMLCanvasElement): number {
  const held = opaqueRows.get(img);
  if (held !== undefined) return held;
  let row = 0;
  try {
    const w = img.width, h = img.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    row = h;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        row = Math.floor((i >> 2) / w);
        break;
      }
    }
    if (row === h) row = 0;
  } catch {
    // An image that cannot be read: its frame's top edge stands in for the art's.
    row = 0;
  }
  opaqueRows.set(img, row);
  return row;
}

/**
 * The world y of the top of what is drawn of a sprite: of its layered animation's current frames, or
 * of its single image, drawn centred on (x, centreY) at `scale` as players and creatures are. Null
 * when nothing of it is loaded.
 */
export function spriteArtTop(anim: any | null, staticImage: HTMLImageElement | null, centreY: number, scale = 1): number | null {
  let top: number | null = null;
  if (anim) {
    for (const layer of getVisibleLayersSorted(anim)) {
      if (!layer.frames.length) continue;
      const frame = layer.frames[layer.currentFrame];
      const img = frame?.imageElement;
      if (!img?.complete || !img.naturalWidth) continue;
      const frameTop = centreY - (frame.height * scale) / 2 + (frame.offset?.y || 0) * scale;
      const y = frameTop + (firstOpaqueRow(img) / (img.height || frame.height)) * frame.height * scale;
      top = top === null ? y : Math.min(top, y);
    }
    return top;
  }
  if (staticImage?.complete && staticImage.naturalWidth > 0) {
    const h = staticImage.height * scale;
    return centreY - h / 2 + firstOpaqueRow(staticImage) * scale;
  }
  return null;
}
