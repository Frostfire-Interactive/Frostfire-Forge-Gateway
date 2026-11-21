export type GlowDraw = { img: CanvasImageSource; m: DOMMatrix; x: number; y: number; w: number; h: number; a: number };

let queue: GlowDraw[] = [];

/** Queues one glowing sprite as just drawn: m is the drawing context's transform (getTransform(), once per batch). */
export function queueGlow(m: DOMMatrix, img: CanvasImageSource, x: number, y: number, w: number, h: number, a: number): void {
  if (a > 0.003) queue.push({ img, m, x, y, w, h, a });
}

/** This frame's queue, emptied for the next frame. */
export function takeGlows(): GlowDraw[] {
  const out = queue;
  queue = [];
  return out;
}
