// World zoom: Ctrl + mouse wheel (and Ctrl + plus, minus, 0) zooms the game world in, never the page's UI. USER REQUEST
// 2026-10-15: "implement (control + Scroll) to zoom in the game but previously had issues where positions and the map
// didn't line up".
//
// Everything that draws the world, and everything that turns a place on the screen into a place in the world, goes
// through this one module, so the two cannot disagree:
//   - the game canvas's base transform (applyWorldTransform, once a frame): device pixels x the touch screens' own
//     0.85 x the player's zoom, about the middle of the screen. The WebGL map, the sprites, the ghost and upper
//     canvases and the light map all read that transform, so they follow it with no change of their own.
//   - the camera's offset (worldOffset) and the centring of a map narrower than the view (mapCenterOffsetX).
//   - worldToScreen and screenToWorld, for clicks, hovers, badges drawn in screen pixels and HTML laid over the world.
//
// Only zooming in: the server sends what is round the player for a screen at zoom 1, and the chunks loaded, the
// culling and the light map are all worked out for that view. A closer view is inside all of them.

/** The closest the world comes: three times its normal size, or the nearest pixel-perfect level under that. */
const MAX_ZOOM = 3;
/** Wheel movement (pixels) that makes one step: a mouse notch is 50 to 120, a touchpad pinch sends many small ones. */
const WHEEL_STEP = 50;
/** Seconds the view takes to settle most of the way on a new level. */
const EASE = 0.09;
const STORE_KEY = "worldZoom";

const isTouch = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** The tile editor has its own camera and hit tests, worked out for no zoom of the player's: it shows the world unzoomed. */
const editing = () => !!(window as any).tileEditor?.isActive;

/** Device pixels to a CSS pixel on the game canvas: capped at 2 on touch screens (events.ts resizeGameCanvas). */
export function canvasDpr(): number {
  const raw = window.devicePixelRatio || 1;
  return isTouch() ? Math.min(raw, 2) : raw;
}

/**
 * The zoom levels a step moves between, for this screen. USER REPORT 2026-10-15: "some zoom levels cause the tiles to
 * no longer look pixel perfect". A level is pixel perfect when one pixel of the art is a whole number of the screen's
 * own pixels: at 1.25 on a plain screen an art pixel is 1.25 screen pixels, drawn some one and some two wide. So past
 * the normal size (1, as it always was) the levels are the ones that make an art pixel 2, 3, 4... screen pixels: 2 and
 * 3 on a plain screen, 1.5, 2, 2.5 and 3 on a 200% one, 1.6 and 2.4 on a 125% one.
 */
function levels(): number[] {
  const perArtPixel = canvasDpr() * (isTouch() ? 0.85 : 1);
  const out = [1];
  for (let n = Math.floor(perArtPixel + 1e-6) + 1; n / perArtPixel <= MAX_ZOOM + 1e-6; n++) out.push(n / perArtPixel);
  return out;
}

/** The level nearest a zoom. */
function nearestLevel(z: number): number {
  return levels().reduce((best, l) => (Math.abs(l - z) < Math.abs(best - z) ? l : best), 1);
}

function readStored(): number {
  try {
    const z = Number(localStorage.getItem(STORE_KEY));
    return Number.isFinite(z) && z > 0 ? nearestLevel(z) : 1;
  } catch {
    return 1;
  }
}

/** The level asked for, and the one shown now, which eases towards it. */
let target = readStored();
let shown = target;
let lastStep = 0;
let wheelRest = 0;
/** The screen density the levels were last worked out for: another screen (a window moved) has levels of its own. */
let levelsFor = canvasDpr();

/** The player's zoom as shown now (1 in the tile editor). */
export function userZoom(): number {
  return editing() ? 1 : shown;
}

/** The whole zoom of the world on the screen: the touch screens' 0.85, times the player's. */
export function worldZoom(): number {
  return (isTouch() ? 0.85 : 1) * userZoom();
}

/** The width and height of the screen in CSS pixels, as the game canvas is laid out. */
function screenSize(): { w: number; h: number } {
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  const dpr = canvasDpr();
  return {
    w: (canvas?.width ? canvas.width / dpr : 0) || window.innerWidth,
    h: (canvas?.height ? canvas.height / dpr : 0) || window.innerHeight,
  };
}

/**
 * How much of the world the camera keeps in view, in world pixels, for its clamp at the map's edges and the centring
 * of a small map: the screen over the player's zoom. (The touch screens' 0.85 is left out, as it always was.)
 */
export function viewWidth(): number {
  return window.innerWidth / userZoom();
}
export function viewHeight(): number {
  return window.innerHeight / userZoom();
}

/** A map narrower than the view is drawn centred sideways: how far it is moved, in world pixels. */
export function mapCenterOffsetX(): number {
  const md = (window as any).mapData;
  const mapWidth = md ? Number(md.width) * Number(md.tilewidth) : 0;
  const view = viewWidth();
  return mapWidth > 0 && mapWidth < view ? (view - mapWidth) / 2 : 0;
}

/** A world position put on a whole screen pixel, so the world does not shimmer as the camera moves. */
export function snapWorld(v: number): number {
  const z = userZoom();
  return Math.round(v * z) / z;
}

/**
 * The translation from world to the canvas's base transform for a camera on (camX, camY): every draw of the world
 * translates by it (renderer.ts).
 */
export function worldOffset(camX: number, camY: number): { x: number; y: number } {
  return {
    x: snapWorld(window.innerWidth / 2 - camX + mapCenterOffsetX()),
    y: snapWorld(window.innerHeight / 2 - camY),
  };
}

/**
 * Sets the game canvas's base transform for this frame, and moves the shown zoom towards the one asked for. Called
 * once at the start of every frame, before anything is drawn (renderer.ts), and when the canvas is resized.
 *
 * screen = middle + zoom x (world + offset - middle): the zoom is about the middle of the screen, where the camera is.
 */
export function applyWorldTransform(ctx: CanvasRenderingContext2D, now = performance.now()): void {
  if (canvasDpr() !== levelsFor) {
    levelsFor = canvasDpr();
    target = nearestLevel(target);
  }
  if (shown !== target) {
    const dt = lastStep ? Math.min(0.1, (now - lastStep) / 1000) : 0;
    shown += (target - shown) * (1 - Math.exp(-dt / EASE));
    if (Math.abs(target - shown) < 0.002) shown = target;
  }
  lastStep = now;
  const dpr = canvasDpr();
  const z = worldZoom();
  const { w, h } = screenSize();
  ctx.setTransform(dpr * z, 0, 0, dpr * z, (dpr * w * (1 - z)) / 2, (dpr * h * (1 - z)) / 2);
}

/** A world position on the screen, in CSS pixels from the game canvas's top left (the window's: it fills it). */
export function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
  const camX = Number((window as any).cameraX) || 0, camY = Number((window as any).cameraY) || 0;
  const { w, h } = screenSize();
  const z = worldZoom();
  const o = worldOffset(camX, camY);
  return { x: w / 2 + z * (worldX + o.x - w / 2), y: h / 2 + z * (worldY + o.y - h / 2) };
}

/**
 * Takes the player's zoom back out of a drawing context about the world point (x, y), for marks that keep one size on
 * the screen: what is drawn next round (x, y), in world px, comes out as it does at zoom 1, while (x, y) itself stays
 * where the zoom puts it. USER REQUEST 2026-10-20: damage and healing numbers and the buff and debuff icons "should NOT
 * get massive when zooming in". Call between save() and restore().
 */
export function unzoomAbout(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const k = 1 / userZoom();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(-x, -y);
}

/** The world position under a point of the screen, in CSS pixels from the game canvas's top left. */
export function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
  const camX = Number((window as any).cameraX) || 0, camY = Number((window as any).cameraY) || 0;
  const { w, h } = screenSize();
  const z = worldZoom();
  const o = worldOffset(camX, camY);
  return { x: (screenX - w / 2) / z + w / 2 - o.x, y: (screenY - h / 2) / z + h / 2 - o.y };
}

/** The world position under a mouse or touch event's point. */
export function eventToWorld(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  const rect = canvas?.getBoundingClientRect();
  return screenToWorld(event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0));
}

function setZoom(z: number): void {
  const next = nearestLevel(z);
  if (next === target) return;
  target = next;
  try { localStorage.setItem(STORE_KEY, String(next)); } catch { /* only for this visit */ }
}

/** One level in (+1) or out (-1) from the one asked for. */
function step(direction: 1 | -1): void {
  const all = levels();
  const at = all.findIndex((l) => Math.abs(l - target) < 0.001);
  const i = at >= 0 ? at : all.findIndex((l) => l > target) - (direction > 0 ? 1 : 0);
  setZoom(all[Math.min(all.length - 1, Math.max(0, i + direction))]!);
}

/** Ctrl + wheel and Ctrl + plus, minus and 0 on the game page. The browser's own page zoom stays off for them. */
export function installWorldZoom(): void {
  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    // the page itself never zooms
    event.preventDefault();
    if (editing()) return;
    // a mouse notch is one step, whatever size the browser gives it; a touchpad pinch sends many small movements,
    // gathered up until they make one
    const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
    if (Math.abs(delta) >= WHEEL_STEP) {
      wheelRest = 0;
      step(delta < 0 ? 1 : -1);
      return;
    }
    wheelRest += delta;
    if (Math.abs(wheelRest) >= WHEEL_STEP) {
      step(wheelRest < 0 ? 1 : -1);
      wheelRest = 0;
    }
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const k = event.key;
    if (k !== "+" && k !== "=" && k !== "-" && k !== "_" && k !== "0") return;
    event.preventDefault();
    if (editing()) return;
    if (k === "0") setZoom(1);
    else step(k === "-" || k === "_" ? -1 : 1);
  });
}
