// Lays the game out for the frame of a recording: the world is drawn for a screen of that size and shape, whatever the
// window's, so a file larger than the window is not an enlarged picture of it, and one of another shape shows more of
// the world and not less. The browser shrinks what is drawn to fit the window, so the view can still be watched.
//
// The world reads the window's size and density in a great many places, and one that was missed would put things out
// of line. So while there is a frame the window itself gives the frame's: nothing needs telling, and nothing is left
// out. The interface is not in a recording and is left as it was: it hears of the frame from no "resize" event, only
// the world's canvases from "viewframe", and everything is put right by a real "resize" when the frame is left.
//
// Nothing else is imported here: renderer.ts, worldzoom.ts and map.ts all read this, and so must not start in a cycle.

const NAMES = ["innerWidth", "innerHeight", "devicePixelRatio"] as const;

interface Frame {
  /** The size of the screen the world is laid out for, in CSS pixels. */
  w: number;
  h: number;
  /** Pixels of the file to a CSS pixel. */
  density: number;
}

let frame: Frame | null = null;
let held: { name: string; was: PropertyDescriptor | undefined }[] = [];

/**
 * The window's view always fits inside the frame. A file at least that large keeps art pixels a whole number of its
 * own: 2 on a window of half its size, and 1 on a window of 3/4, which then sees more of the world. USER REPORT
 * 2026-10-15, worldzoom.ts: "some zoom levels cause the tiles to no longer look pixel perfect". A file smaller than the
 * window is the window's view, drawn at the window's size and shrunk when the frame is composed.
 */
function fit(width: number, height: number): Frame {
  const ratio = Math.min(width / window.innerWidth, height / window.innerHeight);
  if (ratio < 1) return { w: Math.ceil(width / ratio), h: Math.ceil(height / ratio), density: 1 };
  const density = Math.floor(ratio);
  return { w: width / density, h: height / density, density };
}

export function enterFrame(width: number, height: number): void {
  leaveFrame();
  const entered = fit(width, height);
  frame = entered;
  const answers = { innerWidth: entered.w, innerHeight: entered.h, devicePixelRatio: entered.density };
  held = NAMES.map((name) => ({ name, was: Object.getOwnPropertyDescriptor(window, name) }));
  for (const name of NAMES) Object.defineProperty(window, name, { configurable: true, get: () => answers[name] });
  const view = window.visualViewport;
  if (view) {
    Object.defineProperty(view, "width", { configurable: true, get: () => entered.w });
    Object.defineProperty(view, "height", { configurable: true, get: () => entered.h });
  }
  document.body.classList.add("cutscene-framed");
  window.dispatchEvent(new Event("viewframe"));
}

export function leaveFrame(): void {
  if (!frame) return;
  frame = null;
  for (const { name, was } of held) {
    if (was) Object.defineProperty(window, name, was);
    else delete (window as any)[name];
  }
  held = [];
  const view = window.visualViewport as any;
  if (view) {
    delete view.width;
    delete view.height;
  }
  document.body.classList.remove("cutscene-framed");
  window.dispatchEvent(new Event("resize"));
}

/** The size the frame lays the world out for, null when there is none. */
export const frameSize = (): { w: number; h: number } | null => frame;
