export interface MoveSample {
  t: number;
  x: number;
  y: number;
  /** The client's own step in a handoff gap (handoffwalk.ts), not the server's: an echo older than it replaces it. */
  predicted?: boolean;
  /** The drawn spot held in place of a kept walk's echo the draw had walked past (handoffwalk.ts): not the player's position. */
  held?: boolean;
  /** performance.now() after which a held sample is not held any more (the renderer takes the player's position again). */
  heldUntil?: number;
  /** The end of releaseHeld's ease back to the position: an echo that comes before the draw reaches it takes its place. */
  eased?: boolean;
}

export function needsPositionSample(last: MoveSample | undefined, position: { x: number; y: number }, now: number): boolean {
  if (!last) return true;
  if (last.x === position.x && last.y === position.y) return false;
  return !(last.held && typeof last.heldUntil === "number" && now < last.heldUntil);
}

/** The tick rate a server that does not say its own (LOGIN_SUCCESS tickRate) runs at. */
const DEFAULT_TICK_RATE = 30;
/** Server movement tick. */
let TICK_MS = 1000 / DEFAULT_TICK_RATE;
/** A jump this far between steps is a teleport or warp: snap, never glide. */
export const TELEPORT_PX = 100;
/** Steps kept per mover: 8 at 30 Hz, about 270 ms of them, so the same time at any tick rate. */
const SAMPLE_SPAN_TICKS_30HZ = 8;
let MAX_SAMPLES = SAMPLE_SPAN_TICKS_30HZ;

/** The tick rates a server can run at (the engine's TICK_RATE range); anything else is taken as not said. */
const MIN_TICK_RATE = 20;
const MAX_TICK_RATE = 120;

export function setServerTickRate(rate?: unknown): void {
  const hz = rate === undefined || rate === null || rate === "" ? NaN : Number(rate);
  const tickRate = Number.isFinite(hz) && hz >= MIN_TICK_RATE && hz <= MAX_TICK_RATE ? hz : DEFAULT_TICK_RATE;
  TICK_MS = 1000 / tickRate;
  MAX_SAMPLES = Math.max(SAMPLE_SPAN_TICKS_30HZ, Math.ceil((SAMPLE_SPAN_TICKS_30HZ * tickRate) / DEFAULT_TICK_RATE));
}
/** The server's movement tick in ms (setServerTickRate). */
export function getTickMs(): number {
  return TICK_MS;
}
/** No step for this long means the mover had stopped. */
const IDLE_GAP_MS = 200;
/** Bounds on how far in the past players are drawn. */
const MIN_DELAY_MS = 45;
const MAX_DELAY_MS = 250;

let clockOffset: number | null = null;
const OFFSET_CREEP_MS = 0.02;
// How late packets arrive beyond the least-delayed one: a max that decays.
let lateness = 0;
const LATENESS_DECAY = 0.995;
let batchSpacing = 0;
let lastBatchAt: number | null = null;
const BATCH_SPACING_WEIGHT = 0.1;

export function sampleTime(serverSendMs: number | null, now: number = performance.now()): number {
  if (serverSendMs === null || !Number.isFinite(serverSendMs)) return now;
  const observed = now - serverSendMs;
  clockOffset = clockOffset === null ? observed : Math.min(observed, clockOffset + OFFSET_CREEP_MS);
  lateness = Math.max(observed - clockOffset, lateness * LATENESS_DECAY);
  return serverSendMs + clockOffset;
}

/** The send-to-timeline offset sampleTime dates with (null: none learned since the last epoch). */
export function getClockOffset(): number | null {
  return clockOffset;
}

/** How late packets arrive beyond the least-delayed one (the running figure sampleTime keeps). */
export function getLateness(): number {
  return lateness;
}

export function noteBatch(t: number): void {
  if (lastBatchAt !== null) {
    const gap = t - lastBatchAt;
    if (gap >= 1 && gap <= IDLE_GAP_MS) {
      batchSpacing = batchSpacing === 0 ? gap : batchSpacing + (gap - batchSpacing) * BATCH_SPACING_WEIGHT;
    }
  }
  if (lastBatchAt === null || t > lastBatchAt) lastBatchAt = t;
}

export function interpolationDelay(): number {
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.max(TICK_MS, batchSpacing) + lateness + 8));
}

let currentDelay = MIN_DELAY_MS;
let lastClockAt: number | null = null;
let lastRenderAt: number | null = null;
const MAX_DELAY_SLEW = 0.1;

/** The moment to draw movers at, for a frame at `now`. Call once per frame. */
export function renderTime(now: number = performance.now()): number {
  const elapsed = lastClockAt === null ? 0 : Math.max(0, Math.min(100, now - lastClockAt));
  lastClockAt = now;
  const target = interpolationDelay();
  const step = elapsed * MAX_DELAY_SLEW;
  currentDelay += Math.max(-step, Math.min(step, target - currentDelay));
  lastRenderAt = now - currentDelay;
  return lastRenderAt;
}

/** The moment the last frame drew movers at (renderTime), or null before the first frame. */
export function lastRenderTime(): number | null {
  return lastRenderAt;
}

export function renderHeadroom(): number {
  return currentDelay - TICK_MS;
}

/** How far back a seed sample is dated: older than any echo that follows, so none is dropped as out of order. */
export const SEED_AGE_MS = 1000;

/** A sample list that starts at a known point (a handoff's arrival) without making the first steps after it late. */
export function seedSamples(x: number, y: number, now: number): MoveSample[] {
  return [{ t: now - SEED_AGE_MS, x, y }];
}

export function pushSample(samples: MoveSample[], x: number, y: number, t: number): boolean {
  const last = samples[samples.length - 1];
  if (last) {
    if (t < last.t) return false;
    if (Math.hypot(x - last.x, y - last.y) > TELEPORT_PX) {
      samples.length = 0;
    } else {
      if (t === last.t) t += 0.01;
      if (t - last.t > IDLE_GAP_MS && (x !== last.x || y !== last.y)) {
        samples.push({ t: t - TICK_MS, x: last.x, y: last.y });
      }
    }
  }
  samples.push({ t, x, y });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return true;
}

export function pushPredicted(samples: MoveSample[], x: number, y: number, t: number): boolean {
  let anchor: MoveSample | null = null;
  for (let i = samples.length - 1; i >= 0 && !anchor; i--) if (!samples[i].predicted) anchor = samples[i];
  if (!pushSample(samples, x, y, t)) return false;
  const last = samples[samples.length - 1];
  if (last) last.predicted = true;
  // Trimmed out (a snap starts the list over with the one sample, and keeps none).
  if (anchor && samples.length > 1 && !samples.includes(anchor)) {
    samples.unshift(anchor);
    if (samples.length > MAX_SAMPLES) samples.splice(1, samples.length - MAX_SAMPLES);
  }
  return true;
}

export function pushEcho(samples: MoveSample[], x: number, y: number, t: number): boolean {
  while (samples.length > 0 && samples[samples.length - 1].predicted && samples[samples.length - 1].t > t) samples.pop();
  return pushSample(samples, x, y, t);
}

export function positionAt(samples: MoveSample[], renderTime: number): { x: number; y: number } | null {
  const n = samples.length;
  if (n === 0) return null;
  if (renderTime <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[n - 1];
  if (renderTime >= last.t) return { x: last.x, y: last.y };
  for (let i = n - 1; i > 0; i--) {
    const a = samples[i - 1];
    if (a.t <= renderTime) {
      const b = samples[i];
      const f = (renderTime - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return { x: last.x, y: last.y };
}

export function resetClockEpoch(): void {
  clockOffset = null;
  lateness = 0;
  lastBatchAt = null;
}

/** Test hook: forget the learned clock. */
export function resetMovementClock(): void {
  clockOffset = null;
  lateness = 0;
  batchSpacing = 0;
  lastBatchAt = null;
  currentDelay = MIN_DELAY_MS;
  lastClockAt = null;
  lastRenderAt = null;
}
