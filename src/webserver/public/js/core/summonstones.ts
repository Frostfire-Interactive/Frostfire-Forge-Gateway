// Summoning stones in the world: drawn standing at their foot with their runes in the stone's glow colour (the runes
// are the near-white pixels of public/img/summoning_stone.png, stoneglow.ts), clicked or tapped to touch them. The
// server answers the range ("Move closer to the summoning stone.") and everything after the touch.

import { stonesOnMap, stoneAt, type MapStone } from "./stonelist.ts";
import { ART_FOOT_ROW, STONE_H, STONE_W, stoneGlowPixels } from "./stoneglow.ts";
import { queueGlow } from "./glowqueue.ts";
import { getNightFactor } from "./ambience.ts";
import { addNightLit } from "./portalfx.ts";
import { sendRequest } from "./socket.ts";
import { summonTargetOf, summonTouch } from "./summonreplies.ts";
import { getPartyTarget } from "./partytarget.ts";
import Cache from "./cache.ts";
import { isSelfActionLocked } from "./death.ts";

/** How long after a failed load of the picture before it is tried again. */
const RETRY_MS = 5_000;
/** The halo: the runes blurred this much around them, on a canvas this much bigger each side. */
const HALO_BLUR_PX = 3;
const HALO_PAD = 10;
/** How strong the halo is on the stone by day; at night it is drawn again above the dark at full strength. */
const HALO_DAY_ALPHA = 0.8;
/** The shadow the stone casts: its outline laid flat on the ground behind it, this much of its height tall, leaning this
 *  far right per pixel of height, softened this much, and this dark. */
const SHADOW_SQUASH = 0.3;
const SHADOW_LEAN = 0.5;
const SHADOW_BLUR_PX = 1.5;
const SHADOW_PAD = 4;
const SHADOW_ALPHA = 0.35;

export { stonesOnMap, stoneAt, type MapStone };

/** A click or tap on a stone touches it, with the party member targeted. Returns whether a stone was there. */
export function touchStoneAt(worldX: number, worldY: number, slop = 0): boolean {
  const name = stoneAt(worldX, worldY, slop);
  if (name === null) return false;
  if (!isSelfActionLocked()) sendRequest(summonTouch(name, summonTargetOf(getPartyTarget(), Cache.getInstance().players)));
  return true;
}

type Pair = { art: HTMLCanvasElement; glow: HTMLCanvasElement; halo: HTMLCanvasElement };
let source: ImageData | null = null;
/** The cast shadow, made once from the art's outline, and where the stone's foot is on it. */
let shadow: { canvas: HTMLCanvasElement; footX: number; footY: number } | null = null;
let sourceState: "idle" | "loading" | "ready" = "idle";
const pairs = new Map<string, Pair>();
/** Each stone's night glow this frame, on the game canvas: its own canvas, so whoever stands in front is cut out of it. */
const nightGlows = new Map<string, HTMLCanvasElement>();

/** At night the halo is drawn again over the dark (glowqueue.ts), from a canvas of its own laid on the game canvas, which
 *  anyone drawn in front of the stone after it is cut out of (portalfx.ts drawStanding). */
function queueNightGlow(ctx: CanvasRenderingContext2D, name: string, footX: number, footY: number, halo: HTMLCanvasElement, hx: number, hy: number): void {
  if (getNightFactor() < 0.01) return;
  const m = ctx.getTransform();
  const a = m.transformPoint(new DOMPoint(hx, hy)), b = m.transformPoint(new DOMPoint(hx + halo.width, hy + halo.height));
  const dx = Math.floor(Math.min(a.x, b.x)), dy = Math.floor(Math.min(a.y, b.y));
  const dw = Math.max(1, Math.ceil(Math.max(a.x, b.x)) - dx), dh = Math.max(1, Math.ceil(Math.max(a.y, b.y)) - dy);
  let canvas = nightGlows.get(name);
  if (!canvas) { canvas = document.createElement("canvas"); nightGlows.set(name, canvas); }
  if (canvas.width !== dw || canvas.height !== dh) { canvas.width = dw; canvas.height = dh; }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, dw, dh);
  g.setTransform(new DOMMatrix().translate(-dx, -dy).multiply(m));
  g.drawImage(halo, hx, hy);
  queueGlow(new DOMMatrix(), canvas, dx, dy, dw, dh, 1);
  addNightLit({ x: footX, foot: footY, half: STONE_W / 2 + HALO_PAD, canvases: [canvas], dx, dy });
}

function loadSource(): void {
  if (sourceState !== "idle" || typeof Image === "undefined") return;
  sourceState = "loading";
  const img = new Image();
  // A failed load goes back to idle after a pause, so a later frame tries again (not every frame).
  const retryLater = () => { setTimeout(() => { if (sourceState === "loading") sourceState = "idle"; }, RETRY_MS); };
  img.onerror = retryLater;
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = STONE_W;
      c.height = STONE_H;
      const cx = c.getContext("2d", { willReadFrequently: true });
      if (!cx) { retryLater(); return; }
      cx.drawImage(img, 0, 0);
      source = cx.getImageData(0, 0, STONE_W, STONE_H);
      sourceState = "ready";
    } catch { retryLater(); }
  };
  img.src = "/img/summoning_stone.png";
}

function makeShadow(): void {
  if (shadow || !source) return;
  const outline = document.createElement("canvas");
  outline.width = STONE_W;
  outline.height = STONE_H;
  const ox = outline.getContext("2d")!;
  ox.putImageData(source, 0, 0);
  ox.globalCompositeOperation = "source-in";
  ox.fillStyle = "#000";
  ox.fillRect(0, 0, STONE_W, STONE_H);
  // laid on the ground: each row up the stone goes SHADOW_SQUASH up and SHADOW_LEAN right of the foot
  const footX = SHADOW_PAD + STONE_W / 2, footY = SHADOW_PAD + Math.ceil(ART_FOOT_ROW * SHADOW_SQUASH);
  const canvas = document.createElement("canvas");
  canvas.width = SHADOW_PAD * 2 + STONE_W + Math.ceil(ART_FOOT_ROW * SHADOW_LEAN);
  canvas.height = footY + SHADOW_PAD;
  const cx = canvas.getContext("2d")!;
  cx.filter = `blur(${SHADOW_BLUR_PX}px)`;
  cx.setTransform(1, 0, -SHADOW_LEAN, SHADOW_SQUASH, footX, footY);
  cx.drawImage(outline, -STONE_W / 2, -ART_FOOT_ROW);
  shadow = { canvas, footX, footY };
}

function pairFor(color: string): Pair | null {
  const have = pairs.get(color);
  if (have) return have;
  if (!source) { loadSource(); return null; }
  const { art, glow } = stoneGlowPixels(source.data, color);
  const make = (pixels: Uint8ClampedArray) => {
    const c = document.createElement("canvas");
    c.width = STONE_W;
    c.height = STONE_H;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), STONE_W, STONE_H), 0, 0);
    return c;
  };
  const glowCanvas = make(glow);
  // the halo: the rune pixels blurred into a soft light around them, twice over so it reads at the blur's edges
  const halo = document.createElement("canvas");
  halo.width = STONE_W + HALO_PAD * 2;
  halo.height = STONE_H + HALO_PAD * 2;
  const hx = halo.getContext("2d")!;
  hx.filter = `blur(${HALO_BLUR_PX}px)`;
  hx.drawImage(glowCanvas, HALO_PAD, HALO_PAD);
  hx.drawImage(glowCanvas, HALO_PAD, HALO_PAD);
  hx.filter = "none";
  hx.drawImage(glowCanvas, HALO_PAD, HALO_PAD);
  const made = { art: make(art), glow: glowCanvas, halo };
  pairs.set(color, made);
  return made;
}

/** The shadows the map's stones cast: on the ground, so drawn before anyone standing, who are all drawn over them. */
export function drawStoneShadows(ctx: CanvasRenderingContext2D): void {
  if (!source) return;
  makeShadow();
  if (!shadow) return;
  ctx.save();
  ctx.globalAlpha = SHADOW_ALPHA;
  for (const s of stonesOnMap((window as any).mapData?.summoningStones)) ctx.drawImage(shadow.canvas, s.x - shadow.footX, s.y - shadow.footY);
  ctx.restore();
}

/** The map's stones, each to be drawn among the characters at its foot: the art, then its runes' glow, steady. */
export function standingStones(): Array<{ feet: number; draw: (ctx: CanvasRenderingContext2D) => void }> {
  const out: Array<{ feet: number; draw: (ctx: CanvasRenderingContext2D) => void }> = [];
  for (const s of stonesOnMap((window as any).mapData?.summoningStones)) {
    out.push({
      feet: s.y,
      draw: (ctx) => {
        const pair = pairFor(s.glowColor);
        if (!pair) return;
        const x = s.x - STONE_W / 2;
        const y = s.y - ART_FOOT_ROW;
        ctx.save();
        ctx.drawImage(pair.art, x, y);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = HALO_DAY_ALPHA;
        ctx.drawImage(pair.halo, x - HALO_PAD, y - HALO_PAD);
        ctx.restore();
        queueNightGlow(ctx, s.name, s.x, s.y, pair.halo, x - HALO_PAD, y - HALO_PAD);
      },
    });
  }
  return out;
}
