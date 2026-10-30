// Smooth display of server-authoritative movement.
//
// The server steps every mover a fixed distance every tick (tickRate a second), but the
// steps reach the client unevenly: datagrams bunch up and gap, badly so on
// phones and Wi-Fi. Chasing each step as it lands makes a sprite (and the
// camera that follows it) lurch. Instead every step is kept with the time the
// server sent it, and players are drawn slightly in the past, interpolating
// between the two steps around that moment. The server's own send clock sets
// the pace, so network jitter no longer shows up as speed changes.

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

/**
 * Whether the renderer puts the player's position into the sample list as the next step: it differs from the newest
 * sample. Not while the newest is a held spot (handoffwalk.ts KeptWalkDating) inside its window: the position is the
 * echo's, behind the spot, and would be a step back. After the window it is (the spot is let go, however the walk ended).
 */
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

/**
 * The server's movement tick rate, from LOGIN_SUCCESS. A server that does not
 * send one (or sends one outside 20-120) runs at 30 Hz.
 */
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

// Client time = server send time + offset. The offset is the smallest one seen
// (the least-delayed packet); it creeps up slowly so a server clock step or
// drift is found again instead of being stuck on an old minimum.
let clockOffset: number | null = null;
const OFFSET_CREEP_MS = 0.02;
// How late packets arrive beyond the least-delayed one: a max that decays.
let lateness = 0;
const LATENESS_DECAY = 0.995;
// How far apart the batches of other players' steps arrive (an average, on the
// server's send clock). They come once a flush, which is once a tick only while
// the server is not backed off; backed off they are 50-150 ms apart, and a delay
// of one tick would run out of steps between them.
let batchSpacing = 0;
let lastBatchAt: number | null = null;
const BATCH_SPACING_WEIGHT = 0.1;

/**
 * Timeline time for a step the server sent at `serverSendMs` (Date.now() on the
 * server), arriving now. Without a send time (a packet that carries none) the
 * arrival time is used.
 */
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

/**
 * Note a batch of other players' steps at timeline time `t` (sampleTime), once
 * per batch. Keeps batchSpacing; a gap longer than IDLE_GAP_MS is a pause (no
 * one moving), not the spacing.
 */
export function noteBatch(t: number): void {
  if (lastBatchAt !== null) {
    const gap = t - lastBatchAt;
    if (gap >= 1 && gap <= IDLE_GAP_MS) {
      batchSpacing = batchSpacing === 0 ? gap : batchSpacing + (gap - batchSpacing) * BATCH_SPACING_WEIGHT;
    }
  }
  if (lastBatchAt === null || t > lastBatchAt) lastBatchAt = t;
}

/**
 * How far in the past to draw: one step apart (a server tick, or the batch
 * spacing if longer, so the next step has always arrived) plus the current
 * arrival jitter.
 */
export function interpolationDelay(): number {
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.max(TICK_MS, batchSpacing) + lateness + 8));
}

// The delay in use eases toward interpolationDelay(): jumping straight to a
// longer delay would throw the render clock backwards and freeze or reverse
// everyone for a moment. Easing plays movement at most 10% slow or fast.
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

/**
 * How much earlier than its arrival a step may be dated without the draw running past it before the next step comes:
 * the delay in use less one server tick.
 */
export function renderHeadroom(): number {
  return currentDelay - TICK_MS;
}

/** How far back a seed sample is dated: older than any echo that follows, so none is dropped as out of order. */
export const SEED_AGE_MS = 1000;

/** A sample list that starts at a known point (a handoff's arrival) without making the first steps after it late. */
export function seedSamples(x: number, y: number, now: number): MoveSample[] {
  return [{ t: now - SEED_AGE_MS, x, y }];
}

/**
 * Record a server position for a mover. Returns false for a step older than one
 * already recorded (datagrams can arrive out of order): it is dropped, and the
 * caller should not apply it either.
 */
export function pushSample(samples: MoveSample[], x: number, y: number, t: number): boolean {
  const last = samples[samples.length - 1];
  if (last) {
    if (t < last.t) return false;
    if (Math.hypot(x - last.x, y - last.y) > TELEPORT_PX) {
      samples.length = 0;
    } else {
      if (t === last.t) t += 0.01;
      // Starting to move after standing still: the step began one tick ago
      // from where the mover stood, not back when it last moved. A shorter gap
      // is lost or late packets while moving, and is interpolated straight over.
      if (t - last.t > IDLE_GAP_MS && (x !== last.x || y !== last.y)) {
        samples.push({ t: t - TICK_MS, x: last.x, y: last.y });
      }
    }
  }
  samples.push({ t, x, y });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return true;
}

/**
 * Record the client's own predicted step (the handoff gap). It is dated like an echo, so it can be newer than the first
 * echo of the new node; pushEcho then replaces it.
 */
export function pushPredicted(samples: MoveSample[], x: number, y: number, t: number): boolean {
  // The newest server sample is the anchor a kept walk is measured from (handoffwalk.ts hasAnchor, walkReach). A gap walk
  // from HANDOFF_BEGIN runs longer than the list holds: the oldest predicted sample goes instead of it.
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

/**
 * Record a server step for the local player. A server step is never dropped for being older than predicted steps: the
 * predicted samples newer than it are removed first. Older than a server sample it is dropped, as pushSample does.
 */
export function pushEcho(samples: MoveSample[], x: number, y: number, t: number): boolean {
  while (samples.length > 0 && samples[samples.length - 1].predicted && samples[samples.length - 1].t > t) samples.pop();
  return pushSample(samples, x, y, t);
}

/**
 * Position to draw at `renderTime`. Holds at the newest step rather than
 * guessing past it, so a stop never overshoots and snaps back.
 */
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

/**
 * The connection moved to another node, whose clock reads differently (a cluster's nodes are not clock-synced): forget
 * the offset and the lateness learned from the old node, so they are learned afresh from the new one. Without this a
 * node whose send times lag the smallest offset seen reads as `skew` ms of lateness, which decays by 0.5% an echo
 * and pushes the draw delay to its cap; the offset creeps up only 0.02 ms an echo. The samples already held keep their
 * times (both nodes' echoes are dated at their arrival), and the delay in use is left to ease down by itself.
 */
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
