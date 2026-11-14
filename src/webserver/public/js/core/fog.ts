/**
 * USER REQUEST 2026-11-13 ("I would like to add a new weather type: fog", then "Just haze"): fog, drawn on the weather
 * canvas when the weather is "fog", everywhere on the map. It is a mood, not a wall: a pale haze over the scene, the
 * map and the players still plain to see through it, and no bank of it closing in around the player.
 *
 * - an even, pale grey veil over everything;
 * - soft cloud in two layers (one on a phone), the same round puffs as the blizzard's billows (zonestorm.ts), drifting
 *   slowly along the wind at two paces, so they pass one another and change shape as they go. In still air they still
 *   creep, so the fog is never frozen.
 *
 * How thick it is comes from the weather's humidity: none at 50 or less, full at 100 (the seeded fog is 95). It rises
 * and falls over FADE_SECONDS when the weather changes. It makes no sound.
 */
import { makeCloudTexture } from "./zonestorm.ts";

const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const FADE_SECONDS = 2.5;
/** A frame gap this long (ms) means the weather was not drawn for a while (a house, a map change): start afresh. */
const STALE_GAP = 250;
/** Humidity (0 to 100) at which fog begins, and at which it is full. */
const THIN_AT = 50, FULL_AT = 100;
/** The veil: "r, g, b" and how strong at full thickness. */
const HAZE = "200, 206, 212", HAZE_MAX = 0.24;
/** The cloud layers' strength against their own `alpha`. */
const CLOUD_ALPHA = 0.75;
/** How fast it drifts, px a second: a little in still air, more with each mph of wind. */
const DRIFT_STILL = 8, DRIFT_PER_MPH = 3;
/** How much longer a cloud is along the wind than across it. */
const STRETCH = 1.35;

export interface FogFrame {
  /** Whether the weather is fog. */
  wanted: boolean;
  deltaMs: number;
  /** The weather's humidity, 0 to 100: how thick it is. */
  humidity: unknown;
  /** The weather's wind speed (mph), without gusts. */
  baseWind: number;
  windDirection: string | null;
  /** The weather canvas's top left in the world, px, and its size. */
  cameraX: number;
  cameraY: number;
  width: number;
  height: number;
}

/** How thick fog of this humidity is, 0 to 1. */
export function fogThickness(humidity: unknown): number {
  if (humidity === null || humidity === undefined || humidity === "") return 0;
  const value = Number(humidity);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - THIN_AT) / (FULL_AT - THIN_AT)));
}

/** Where the wind blows the fog to on the screen: right, left, up or down (to the right in still air). */
function driftOf(direction: string | null): [number, number] {
  switch (String(direction ?? "").trim().toLowerCase()) {
    case "left": return [-1, 0];
    case "up": return [0, -1];
    case "down": return [0, 1];
    default: return [1, 0];
  }
}

// The layers: each its own picture (`size` px, made when first drawn), drawn `scale` times as large and stretched
// along the wind; `speed` its share of the drift; `x`, `y` how far it has drifted, kept within one repeat, each layer
// starting somewhere of its own.
const layers = (isMobileDevice
  ? [{ size: 160, scale: 4, parallax: 0.9, alpha: 0.45, speed: 0.6 }]
  : [
    { size: 256, scale: 4.5, parallax: 0.7, alpha: 0.4, speed: 0.35 },
    { size: 384, scale: 2.4, parallax: 1, alpha: 0.28, speed: 0.6 },
  ]).map((layer) => ({ ...layer, cloud: null as HTMLCanvasElement | null, x: Math.random() * 1e4, y: Math.random() * 1e4 }));

// paler where thicker
const cloudColour = (t: number): [number, number, number] => [196 + t * 34, 202 + t * 32, 208 + t * 30];

/** How far the fog has come in (`presence`, 0 to 1) and how thick it is where it has (`thickness`, 0 to 1). */
export interface FogState {
  presence: number;
  thickness: number;
}

/**
 * Moves the fog on by `seconds` and says how much of it shows, 0 to 1. It comes in and goes over FADE_SECONDS. While
 * it is wanted its thickness follows the humidity, gliding to a new one at the same pace; once it is not, it keeps the
 * thickness it had and only fades: the weather after it (a blizzard, a clear day) has a humidity of its own, which is
 * not the fog's.
 */
export function fogStep(state: FogState, wanted: boolean, humidity: unknown, seconds: number): number {
  const step = Math.max(0, seconds) / FADE_SECONDS;
  if (wanted) {
    const goal = fogThickness(humidity);
    // (rolling in from nothing it is as thick as its humidity at once: the coming in is the fade)
    if (state.presence <= 0) state.thickness = goal;
    else state.thickness = goal > state.thickness ? Math.min(goal, state.thickness + step) : Math.max(goal, state.thickness - step);
    state.presence = Math.min(1, state.presence + step);
  } else {
    state.presence = Math.max(0, state.presence - step);
  }
  const p = state.presence;
  return p * p * (3 - 2 * p) * state.thickness;
}

const state: FogState = { presence: 0, thickness: 0 };
let lastDraw = 0;

const wrap = (v: number, period: number) => ((v % period) + period) % period;

/** Draws the fog for this frame. Returns how much of it shows, 0 to 1. */
export function drawFog(ctx: CanvasRenderingContext2D, f: FogFrame): number {
  const now = performance.now();
  // Coming back to it (a map change, a hidden tab): from where things are, not where they were.
  if (now - lastDraw > STALE_GAP) state.presence = 0;
  lastDraw = now;
  const seconds = Math.min(0.1, Math.max(0, f.deltaMs / 1000));

  const thick = fogStep(state, f.wanted, f.humidity, seconds);
  if (thick <= 0) return 0;
  const { width, height } = f;

  ctx.save();
  ctx.fillStyle = `rgba(${HAZE}, ${(HAZE_MAX * thick).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);

  const [dx, dy] = driftOf(f.windDirection);
  const pace = DRIFT_STILL + DRIFT_PER_MPH * Math.max(0, Number(f.baseWind) || 0);
  for (const layer of layers) {
    if (!layer.cloud) layer.cloud = makeCloudTexture(layer.size, cloudColour);
    const pattern = ctx.createPattern(layer.cloud, "repeat");
    if (!pattern) continue;
    // (stretched along the wind: across the screen for a wind left or right, down it for one up or down)
    const along = dy === 0;
    const scaleX = layer.scale * (along ? STRETCH : 1), scaleY = layer.scale * (along ? 1 : STRETCH);
    const periodX = layer.size * scaleX, periodY = layer.size * scaleY;
    layer.x = wrap(layer.x + dx * pace * layer.speed * seconds, periodX);
    layer.y = wrap(layer.y + dy * pace * layer.speed * seconds, periodY);
    const ox = wrap(layer.x - f.cameraX * layer.parallax, periodX);
    const oy = wrap(layer.y - f.cameraY * layer.parallax, periodY);
    pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(scaleX, scaleY));
    ctx.globalAlpha = Math.min(1, layer.alpha * CLOUD_ALPHA * thick);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
  return thick;
}
