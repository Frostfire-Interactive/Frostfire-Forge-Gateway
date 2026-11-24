/** Switches a character's layers to a new pose together: waits for every layer's frames, then, if the change is still
 *  the latest, gives each layer its frames from the same start. `framesFor` gives null for a layer with no such pose.
 *  Frames already built (given as they are, not as a promise) switch at once, so a pose given in the frame it is drawn
 *  is drawn in that frame. */
export async function switchLayers<L extends { frames: F[]; currentFrame: number; lastFrameTime: number }, F>(
  layers: L[],
  framesFor: (layer: L) => F[] | null | Promise<F[] | null>,
  isCurrent: () => boolean,
  now: () => number
): Promise<void> {
  const given = layers.map(framesFor);
  const frames = given.some((f) => f instanceof Promise) ? await Promise.all(given) : (given as Array<F[] | null>);
  if (!isCurrent()) return;
  const start = now();
  layers.forEach((layer, i) => {
    const next = frames[i];
    if (!next) return;
    layer.frames = next;
    layer.currentFrame = 0;
    layer.lastFrameTime = start;
  });
}
