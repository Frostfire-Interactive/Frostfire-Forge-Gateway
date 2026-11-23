// The game's UI (the page's own elements over the world: frames, bars, chat, windows, menus, tooltips) drawn at one
// size for the size of the game window, so it takes the same share of a small window as of a large one. The stylesheet
// zooms the UI's roots by --ui-scale (game.css); it is set here from the window's size.

/** The window size the UI is written for: at it, the UI is drawn at the sizes in the stylesheet. */
export const UI_REFERENCE_WIDTH = 1920;
export const UI_REFERENCE_HEIGHT = 1080;
/** The smallest and largest the UI is drawn: below the one it can no longer be read, above the other it is big enough. */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2;

/**
 * The UI's scale for a window `width` x `height` (CSS pixels): the side short of the reference decides, so the UI fits
 * either way. A touch screen keeps 1: its layouts are written for its own sizes.
 */
export function uiScaleFor(width: number, height: number, touch: boolean): number {
  if (touch || !(width > 0) || !(height > 0)) return 1;
  const scale = Math.min(width / UI_REFERENCE_WIDTH, height / UI_REFERENCE_HEIGHT);
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale));
}

/** A length on the screen (as from a mouse event or getBoundingClientRect) as it is written inside an element drawn at `zoom`. */
export function toZoomedPx(screenPx: number, zoom: number): number {
  return zoom > 0 ? screenPx / zoom : screenPx;
}

/** How much an element is drawn zoomed, all its own and its parents' zooms together (1 where the browser cannot say). */
export function zoomOf(element: Element | null | undefined): number {
  const zoom = Number((element as any)?.currentCSSZoom);
  return zoom > 0 ? zoom : 1;
}

function applyUiScale(): void {
  const touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  document.documentElement.style.setProperty("--ui-scale", String(uiScaleFor(window.innerWidth, window.innerHeight, touch)));
}

// Set before anything else lays the UI out on a resize (imported first by web/core.ts), so they measure the new size.
if (typeof window !== "undefined" && typeof document !== "undefined" && document.documentElement) {
  applyUiScale();
  window.addEventListener("resize", applyUiScale);
}
