import { frameSize } from "./cutsceneframe.js";

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

/** The zoom a cutscene's camera holds the view at (cutscene.ts), null when it has none. */
let cinematic: number | null = null;
export function setCinematicZoom(zoom: number | null): void {
  cinematic = zoom;
}

/** The player's zoom as shown now (1 in the tile editor), or a cutscene's. */
export function userZoom(): number {
  if (cinematic !== null) return cinematic;
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

/** A world position put on a whole screen pixel, so the world does not shimmer as the camera moves. Not while the
 *  player's zoom eases: a map's edge the camera keeps in place (above the hotbar) would flick between two rows of
 *  pixels each frame. */
export function snapWorld(v: number): number {
  if (cinematic === null && !editing() && shown !== target) return v;
  const z = userZoom();
  return Math.round(v * z) / z;
}

export function worldOffset(camX: number, camY: number): { x: number; y: number } {
  return {
    x: snapWorld(window.innerWidth / 2 - camX + mapCenterOffsetX()),
    y: snapWorld(window.innerHeight / 2 - camY),
  };
}

/** Eases the shown zoom towards the one asked for, once a frame: done before the camera is placed (renderer.ts), so the
 *  camera is placed for the zoom the frame is drawn at. Again at the same time it changes nothing. */
export function stepWorldZoom(now = performance.now()): void {
  // (a recording's frame has a density of its own, which is no new screen: the player's zoom is theirs to come back to)
  if (!frameSize() && canvasDpr() !== levelsFor) {
    levelsFor = canvasDpr();
    target = nearestLevel(target);
  }
  if (shown !== target) {
    const dt = lastStep ? Math.min(0.1, Math.max(0, now - lastStep) / 1000) : 0;
    shown += (target - shown) * (1 - Math.exp(-dt / EASE));
    if (Math.abs(target - shown) < 0.002) shown = target;
  }
  lastStep = now;
}

export function applyWorldTransform(ctx: CanvasRenderingContext2D, now = performance.now()): void {
  stepWorldZoom(now);
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
