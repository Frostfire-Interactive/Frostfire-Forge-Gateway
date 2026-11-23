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

let lights: GlowDraw[] = [];

/** Queues light falling on the scene, as just placed: drawn on the colour-dodge layer, which brightens what the
 *  night darkened and keeps its texture (the lamps' light). The image's colour c gains 1 / (1 - c). */
export function queueLight(m: DOMMatrix, img: CanvasImageSource, x: number, y: number, w: number, h: number, a: number): void {
  if (a > 0.003) lights.push({ img, m, x, y, w, h, a });
}

/** This frame's light queue, emptied for the next frame. */
export function takeLights(): GlowDraw[] {
  const out = lights;
  lights = [];
  return out;
}
