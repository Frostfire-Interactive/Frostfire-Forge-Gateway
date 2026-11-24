const live = new WeakMap<object, unknown>();
const ghost = new WeakMap<object, unknown>();

/** The canvas a layer's frame is drawn from (tinted for a ghost), made once by `make` and kept by the frame itself: a
 *  pose's name changes a moment before its frames do, so kept by name it held the last pose's picture. */
export function frameCanvas<C>(frame: object, ghostTint: boolean, make: () => C): C {
  const store = ghostTint ? ghost : live;
  let canvas = store.get(frame) as C | undefined;
  if (canvas === undefined) {
    canvas = make();
    store.set(frame, canvas);
  }
  return canvas;
}
