// What a scene draws over the world at a moment of it: screen effects, letterbox bars, text and its own fades. Drawn
// into whatever it is given, at that size: the #cutscene-layer canvas for the screen, and the recorder's frame for a
// video (cutscenecapture.ts), so a recording's bars and text are sharp and sit at its own edges at any shape of frame.

import { barsAt, blackAt, envelope, typedText, type CutsceneDoc, type Plan, type TextClip } from "./cutscenedoc.js";
import { NUMBER_FONT, TEXT_FONT } from "./fonts.js";

/** Sizes below are for a 1920 by 1080 frame and scale with it. */
const scaleFor = (w: number, h: number) => Math.min(w / 1920, h / 1080);

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function shaded(ctx: CanvasRenderingContext2D, blur: number, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = blur / 4;
  draw();
  ctx.restore();
}

function drawTitle(ctx: CanvasRenderingContext2D, clip: TextClip, w: number, h: number, s: number, t: number): void {
  const size = 84 * s * clip.size, subSize = size * 0.42;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${size}px ${NUMBER_FONT}`;
  const lines = wrap(ctx, typedText(clip, t), w * 0.8);
  const height = lines.length * size * 1.15 + (clip.sub ? subSize * 1.8 : 0);
  let y = h / 2 - height / 2 + size / 2;
  shaded(ctx, 18 * s, () => {
    ctx.fillStyle = clip.color;
    for (const line of lines) {
      ctx.fillText(line, w / 2, y);
      y += size * 1.15;
    }
    if (clip.sub) {
      ctx.font = `${subSize}px ${TEXT_FONT}`;
      ctx.fillText(clip.sub, w / 2, y - size * 0.25 + subSize);
    }
  });
}

function drawSubtitle(ctx: CanvasRenderingContext2D, clip: TextClip, w: number, h: number, s: number, t: number, bottom: number): void {
  const size = 34 * s * clip.size;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${size}px ${TEXT_FONT}`;
  const lines = wrap(ctx, typedText(clip, t), w * 0.7);
  let y = h - bottom - 34 * s - (lines.length - 1) * size * 1.25;
  shaded(ctx, 10 * s, () => {
    ctx.fillStyle = clip.color;
    for (const line of lines) {
      ctx.fillText(line, w / 2, y);
      y += size * 1.25;
    }
  });
}

function drawCaption(ctx: CanvasRenderingContext2D, clip: TextClip, w: number, h: number, s: number, t: number): void {
  const size = 28 * s * clip.size;
  ctx.textAlign = clip.x < 0.34 ? "left" : clip.x > 0.66 ? "right" : "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${size}px ${TEXT_FONT}`;
  const lines = wrap(ctx, typedText(clip, t), w * 0.5);
  let y = clip.y * h;
  shaded(ctx, 8 * s, () => {
    ctx.fillStyle = clip.color;
    for (const line of lines) {
      ctx.fillText(line, clip.x * w, y);
      y += size * 1.25;
    }
  });
}

function drawDialogue(ctx: CanvasRenderingContext2D, clip: TextClip, w: number, h: number, s: number, t: number, bottom: number): void {
  const size = 30 * s * clip.size, pad = 26 * s, boxW = Math.min(w * 0.76, 1280 * s);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${size}px ${TEXT_FONT}`;
  // Measured on the whole text, so the box keeps its size while the typewriter runs.
  const lineCount = wrap(ctx, clip.text, boxW - pad * 2).length;
  const lines = wrap(ctx, typedText(clip, t), boxW - pad * 2);
  const nameH = clip.speaker ? size * 1.4 : 0;
  const boxH = pad * 2 + nameH + lineCount * size * 1.3;
  const x = (w - boxW) / 2, y = h - bottom - boxH - 24 * s;
  ctx.fillStyle = "rgba(8, 10, 18, 0.78)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 12 * s);
  ctx.fill();
  let line = y + pad + size * 0.9;
  if (clip.speaker) {
    ctx.fillStyle = "gold";
    ctx.fillText(clip.speaker, x + pad, line);
    line += nameH;
  }
  ctx.fillStyle = clip.color;
  for (const text of lines) {
    ctx.fillText(text, x + pad, line);
    line += size * 1.3;
  }
}

/**
 * Draws the scene's overlay at time t into `ctx`, which is `w` by `h` with no transform. `noFades` leaves out the black
 * of the scene's own fades.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, doc: CutsceneDoc, plan: Plan, t: number, w: number, h: number, noFades = false): void {
  const s = scaleFor(w, h);
  ctx.save();

  for (const clip of plan.screens) {
    const amount = clip.amount * envelope(t, clip.t, clip.d, clip.in, clip.out);
    if (amount <= 0) continue;
    ctx.globalAlpha = amount;
    if (clip.effect === "vignette") {
      const shade = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.56);
      shade.addColorStop(0, `${clip.color}00`);
      shade.addColorStop(1, clip.color);
      ctx.fillStyle = shade;
    } else ctx.fillStyle = clip.color;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalAlpha = 1;

  const bar = doc.settings.letterboxSize * h * barsAt(doc, t);
  if (bar > 0) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
  }

  for (const clip of plan.texts) {
    const amount = envelope(t, clip.t, clip.d, clip.in, clip.out);
    if (amount <= 0) continue;
    ctx.globalAlpha = amount;
    if (clip.style === "title") drawTitle(ctx, clip, w, h, s, t);
    else if (clip.style === "subtitle") drawSubtitle(ctx, clip, w, h, s, t, bar);
    else if (clip.style === "caption") drawCaption(ctx, clip, w, h, s, t);
    else drawDialogue(ctx, clip, w, h, s, t, bar);
  }
  ctx.globalAlpha = 1;

  const black = noFades ? 0 : blackAt(doc, t);
  if (black > 0) {
    ctx.globalAlpha = black;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}
