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
