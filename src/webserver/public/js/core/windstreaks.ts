import { newStreakTraits, rollStreakTraits, streakLife, streakRate, streakSpeed } from "./windgust.ts";

const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const MAX_STREAKS = isMobileDevice ? 5 : 10;
/** Distance in px between the stored points of a path. */
const STEP = 5;
const MAX_POINTS = 192;
/** A frame gap this long (ms) means the weather was not drawn for a while (map change, hidden tab): start clean. */
const STALE_GAP = 250;
/** Seconds a streak under way takes to fade out once the wind has stopped. */
const CALM_FADE = 0.4;
/** The soft glow around each line: how much wider than the line it is, and how opaque next to it. */
const HALO_WIDTH = 2.6, HALO_ALPHA = 0.22;

const ANGLES: Record<string, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

class WindStreak {
  active = false;
  /** The path, in world px. */
  xs = new Float32Array(MAX_POINTS);
  ys = new Float32Array(MAX_POINTS);
  count = 0;
  /** How far along the path the front of the line is, in px. */
  head = 0;
  /** Length of the line, in px. */
  trail = 0;
  /** This streak's own share of the wind's pace. */
  pace = 1;
  halfWidth = 1;
  alpha = 1;
  /** 1 while the wind blows; falls to 0 once it stops. */
  calm = 1;
}

const streaks: WindStreak[] = [];
for (let i = 0; i < MAX_STREAKS; i++) streaks.push(new WindStreak());

const traits = newStreakTraits();
let spawnIn = 0;

/** Lays the streak's path from (ox, oy) along `angle`: `length` px of shallow wave `amp` px high, with one curl when `curl`. */
function layPath(s: WindStreak, ox: number, oy: number, angle: number, length: number, amp: number, curl: boolean): void {
  const wave = (Math.PI * 2) / (180 + Math.random() * 160), phase = Math.random() * Math.PI * 2;
  // The curl is one turn of a looping cycloid: it leaves and rejoins the wave without a corner. `b` is its radius.
  const a = 8 + Math.random() * 5, b = a * (1.9 + Math.random() * 0.5);
  const side = Math.random() < 0.5 ? -1 : 1, at = length * (0.4 + Math.random() * 0.3);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let n = 0, pu = 0, pv = 0, since = STEP;
  for (let t = 0; t <= length && n < MAX_POINTS; t++) {
    let u = t, v = amp * Math.sin(t * wave + phase);
    if (curl) {
      const turn = (t - at) / a;
      if (turn > -Math.PI && turn < Math.PI) { u -= b * Math.sin(turn); v -= side * b * (1 + Math.cos(turn)); }
    }
    if (t > 0) since += Math.hypot(u - pu, v - pv);
    pu = u; pv = v;
    if (since >= STEP) {
      since -= STEP;
      s.xs[n] = ox + u * cos - v * sin;
      s.ys[n] = oy + u * sin + v * cos;
      n++;
    }
  }
  s.count = n;
}

/** Starts a streak whose path passes through a random spot of the view (`offX`, `offY`: world position of the canvas's corner). */
function spawn(s: WindStreak, angle: number, gust: number, offX: number, offY: number, width: number, height: number, margin: number): void {
  rollStreakTraits(traits, gust);
  const lean = angle + traits.lean, length = traits.length;
  const reach = 100;
  const cx = margin - reach + Math.random() * (width - margin * 2 + reach * 2);
  const cy = margin - reach + Math.random() * (height - margin * 2 + reach * 2);
  layPath(s, offX + cx - Math.cos(lean) * length / 2, offY + cy - Math.sin(lean) * length / 2, lean, length, traits.amp, traits.curl);
  s.head = 0;
  s.trail = traits.trail;
  s.pace = traits.pace;
  s.halfWidth = traits.halfWidth;
  s.alpha = traits.alpha;
  s.calm = 1;
  s.active = s.count >= 2;
}

// The line of one streak this frame, in canvas px, and its unit half-width offsets to either side.
const lx = new Float32Array(MAX_POINTS), ly = new Float32Array(MAX_POINTS);
const ox = new Float32Array(MAX_POINTS), oy = new Float32Array(MAX_POINTS);

/** Fills the ribbon around the line `widthScale` times its offsets wide. */
function fillRibbon(ctx: CanvasRenderingContext2D, n: number, widthScale: number): void {
  ctx.beginPath();
  ctx.moveTo(lx[0] + ox[0] * widthScale, ly[0] + oy[0] * widthScale);
  for (let j = 1; j < n; j++) ctx.lineTo(lx[j] + ox[j] * widthScale, ly[j] + oy[j] * widthScale);
  for (let j = n - 1; j >= 0; j--) ctx.lineTo(lx[j] - ox[j] * widthScale, ly[j] - oy[j] * widthScale);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws the streak's line as a ribbon that thins to a point at both ends, the tail the longer of the two,
 * inside a faint wider glow so its edges are soft. `alpha` is its opacity this frame.
 */
function draw(ctx: CanvasRenderingContext2D, s: WindStreak, alpha: number, offX: number, offY: number): void {
  const end = (s.count - 1) * STEP;
  const from = Math.max(0, s.head - s.trail), to = Math.min(end, s.head), span = to - from;
  if (span < STEP) return;
  const n = Math.min(MAX_POINTS, Math.ceil(span / STEP) + 1);
  for (let j = 0; j < n; j++) {
    const f = (from + span * j / (n - 1)) / STEP, i = Math.min(s.count - 2, Math.floor(f)), k = f - i;
    lx[j] = s.xs[i] + (s.xs[i + 1] - s.xs[i]) * k - offX;
    ly[j] = s.ys[i] + (s.ys[i + 1] - s.ys[i]) * k - offY;
  }
  for (let j = 0; j < n; j++) {
    const p = j / (n - 1), q = Math.min(1, p / 0.5, (1 - p) / 0.18), half = s.halfWidth * q * (2 - q);
    const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
    const dx = lx[j1] - lx[j0], dy = ly[j1] - ly[j0], len = Math.hypot(dx, dy) || 1;
    ox[j] = -dy / len * half;
    oy[j] = dx / len * half;
  }
  ctx.globalAlpha = alpha * HALO_ALPHA;
  fillRibbon(ctx, n, HALO_WIDTH);
  ctx.globalAlpha = alpha;
  fillRibbon(ctx, n, 1);
}

/**
 * Draws the wind streaks for this frame. `windSpeed` is the wind's base speed in mph (without its gust) and
 * `gust` how hard it gusts now (0 to 1, from `windGust`): streaks come more often, run faster and show brighter in a gust.
 */
export function windStreaks(
  ctx: CanvasRenderingContext2D, deltaMs: number, windSpeed: number, gust: number, windDirection: string | null,
  offX: number, offY: number, width: number, height: number, margin: number
): void {
  if (deltaMs > STALE_GAP) {
    for (const s of streaks) s.active = false;
    spawnIn = 0;
    return;
  }
  const dt = deltaMs / 1000;
  const angle = windDirection ? ANGLES[String(windDirection).trim().toLowerCase()] : undefined;
  const blowing = angle !== undefined && windSpeed > 0;

  if (blowing) {
    spawnIn -= dt;
    if (spawnIn <= 0) {
      const free = streaks.find(s => !s.active);
      if (free) spawn(free, angle, gust, offX, offY, width, height, margin);
      // Uneven gaps between streaks, so they never arrive on a beat.
      spawnIn = (0.4 + Math.random() * 1.2) / Math.max(0.05, streakRate(windSpeed, gust));
    }
  }

  const speed = streakSpeed(windSpeed, gust);
  ctx.fillStyle = "#ffffff";
  for (const s of streaks) {
    if (!s.active) continue;
    if (!blowing && (s.calm -= dt / CALM_FADE) <= 0) { s.active = false; continue; }
    s.head += speed * s.pace * dt;
    const life = s.head / ((s.count - 1) * STEP + s.trail);
    if (life >= 1) { s.active = false; continue; }
    draw(ctx, s, s.alpha * s.calm * streakLife(life), offX, offY);
  }
  ctx.globalAlpha = 1;
}
