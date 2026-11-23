import { TELEPORT_PX, getTickMs, positionAt, pushSample } from "./movementsmoothing.ts";
import { archBlocksStep, archesOnMap } from "./portalarch.ts";
import { stoneBlocksStep, stonesAt } from "./stoneblock.ts";
import { stonesOnMap } from "./stonelist.ts";

/** px a second at 30 Hz: 6 px a tick, as the engine's MOVEXY handler steps. */
export const WALK_SPEED_PX_S = 180;
export const MOUNT_SPEED_MULTIPLIER = 1.35;
/** A predicted position off by more than this from the new node's is not eased but taken (the smoothing's own teleport size). */
export const HANDOFF_SNAP_PX = TELEPORT_PX;
/** How fast the error eases out: it falls to a third in this long. */
export const EASE_TIME_CONSTANT_MS = 120;
/** The prediction stops this long after it started (HANDOFF_BEGIN or the SWITCH): a node that has not answered by then is not worth walking toward. */
export const MAX_PREDICT_MS = 3000;
/** The player's box, as the engine's movement handler tests it. */
const PLAYER_WIDTH = 24;
const PLAYER_HEIGHT = 40;
const MARGIN = 0.1;

const UNITS: Readonly<Record<string, readonly [number, number]>> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
};

/** The direction the movement keys name, lower case, or "" for none (the order the renderer sends them in). */
export function heldDirection(keys: { has(code: string): boolean }): string {
  if (keys.has("KeyW") && keys.has("KeyA")) return "upleft";
  if (keys.has("KeyW") && keys.has("KeyD")) return "upright";
  if (keys.has("KeyS") && keys.has("KeyA")) return "downleft";
  if (keys.has("KeyS") && keys.has("KeyD")) return "downright";
  if (keys.has("KeyW")) return "up";
  if (keys.has("KeyS")) return "down";
  if (keys.has("KeyA")) return "left";
  if (keys.has("KeyD")) return "right";
  return "";
}

/** The direction to walk in the handoff gap: the movement keys, else the gamepad/touch stick (upper case in input.ts), lower case. */
export function gapDirection(keys: { has(code: string): boolean }, stick: string): string {
  return heldDirection(keys) || (stick ? stick.toLowerCase() : "");
}

/** The part of the map data the collision test reads: what the client holds as window.mapData. */
export interface WalkMap {
  tilewidth: number;
  tileheight: number;
  chunkSize: number;
  loadedChunks: ReadonlyMap<string, { width: number; layers: ReadonlyArray<{ name?: string; data?: ArrayLike<number> }> }>;
  /** The map's portals: the arches they stand in are solid (core/portalarch.ts). */
  dungeonPortals?: unknown;
  /** The map's summoning stones: they are solid too (core/stoneblock.ts). */
  summoningStones?: unknown;
}

/** Whether the player's box at (x, y) is on a wall tile, or a step there (from `from`, when known) walks onto a portal's arch. */
export function blockedAt(map: WalkMap | null | undefined, x: number, y: number, from?: { x: number; y: number }): boolean {
  if (map?.dungeonPortals && archBlocksStep(archesOnMap(map.dungeonPortals), from ?? null, { x, y })) return true;
  if (map?.summoningStones && stoneBlocksStep(stonesAt(stonesOnMap(map.summoningStones).map((st) => ({ position: { x: st.x, y: st.y } }))), from ?? null, { x, y })) return true;
  if (!map || !(map.tilewidth > 0) || !(map.tileheight > 0) || !(map.chunkSize > 0)) return false;
  const left = Math.floor((x - PLAYER_WIDTH / 2 + MARGIN) / map.tilewidth);
  const right = Math.floor((x + PLAYER_WIDTH / 2 - MARGIN) / map.tilewidth);
  const top = Math.floor((y + MARGIN) / map.tileheight);
  const bottom = Math.floor((y + PLAYER_HEIGHT / 2 - MARGIN) / map.tileheight);
  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (tx < 0 || ty < 0) continue;
      const cx = Math.floor(tx / map.chunkSize);
      const cy = Math.floor(ty / map.chunkSize);
      const chunk = map.loadedChunks.get(`${cx}-${cy}`);
      if (!chunk) continue;
      const layer = chunk.layers.find((l) => l?.name && String(l.name).toLowerCase().includes("collision"));
      const value = layer?.data?.[(ty - cy * map.chunkSize) * chunk.width + (tx - cx * map.chunkSize)];
      if (value !== undefined && value !== 0) return true;
    }
  }
  return false;
}

export function walkStep(
  from: { x: number; y: number },
  direction: string,
  dtMs: number,
  mounted: boolean,
  blocked: (x: number, y: number, from: { x: number; y: number }) => boolean,
): { x: number; y: number } {
  const unit = UNITS[direction];
  if (!unit || !(dtMs > 0)) return { x: from.x, y: from.y };
  const distance = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * dtMs) / 1000;
  // The engine steps 6 px on each axis of a diagonal (the same px, not a unit vector).
  const nx = from.x + unit[0] * distance;
  const ny = from.y + unit[1] * distance;
  if (!blocked(nx, ny, from)) return { x: nx, y: ny };
  if (unit[0] !== 0 && unit[1] !== 0) {
    if (!blocked(nx, from.y, from)) return { x: nx, y: from.y };
    if (!blocked(from.x, ny, from)) return { x: from.x, y: ny };
  }
  return { x: from.x, y: from.y };
}

/** Whether the engine steps the player at the mounted speed: mounted, or a ghost. */
export function atMountSpeed(player: { mounted?: boolean; isGhost?: boolean } | null | undefined): boolean {
  return player?.mounted === true || player?.isGhost === true;
}

/** The player record fields the walk reads and writes. */
interface WalkPlayer {
  position: { x: number; y: number };
  mounted?: boolean;
  isGhost?: boolean;
  lastDirection?: string;
  /** The float position the prediction carries between frames (position is the rounded one). */
  handoffWalk?: { x: number; y: number };
  /** The error to the new node's position that is still being eased out. */
  handoffEase?: { x: number; y: number; at: number };
}

/** One frame of the prediction: moves the player along `direction`. Returns whether it moved. */
export function advanceSelf(player: WalkPlayer, direction: string, dtMs: number, map: WalkMap | null | undefined): boolean {
  if (!direction) return false;
  // The carried float is used while the position is still where it put it: a position set from outside (a snap) starts over.
  const carried = player.handoffWalk;
  const from = carried && Math.abs(carried.x - player.position.x) <= 1 && Math.abs(carried.y - player.position.y) <= 1
    ? carried
    : { x: player.position.x, y: player.position.y };
  const to = walkStep(from, direction, dtMs, atMountSpeed(player), (x, y, at) => blockedAt(map, x, y, at));
  player.handoffWalk = to;
  const x = Math.round(to.x);
  const y = Math.round(to.y);
  const moved = x !== player.position.x || y !== player.position.y;
  player.position.x = x;
  player.position.y = y;
  player.lastDirection = direction;
  return moved;
}

export function startEase(player: WalkPlayer, shown: { x: number; y: number }, server: { x: number; y: number }, now: number): boolean {
  player.handoffWalk = undefined;
  const dx = shown.x - server.x;
  const dy = shown.y - server.y;
  if (Math.hypot(dx, dy) > HANDOFF_SNAP_PX || (dx === 0 && dy === 0)) {
    player.handoffEase = undefined;
    return false;
  }
  player.handoffEase = { x: dx, y: dy, at: now };
  return true;
}

/** The position to draw: the smoothed server position plus what is left of the error. Call once a frame. */
export function applyEase(player: WalkPlayer, drawn: { x: number; y: number }, now: number): { x: number; y: number } {
  const ease = player.handoffEase;
  if (!ease) return drawn;
  const elapsed = Math.max(0, now - ease.at);
  ease.at = now;
  const keep = Math.exp(-elapsed / EASE_TIME_CONSTANT_MS);
  ease.x *= keep;
  ease.y *= keep;
  if (Math.abs(ease.x) < 0.5 && Math.abs(ease.y) < 0.5) {
    player.handoffEase = undefined;
    return drawn;
  }
  return { x: drawn.x + ease.x, y: drawn.y + ease.y };
}

export function gapSampleTime(now: number, lastT: number, lateness: number, walkMs = 0): number {
  return Math.max(now - Math.max(0, lateness), lastT + 0.01, lastT + walkMs);
}

/** The first step of the gap walks at most this long, unless the walk at the switch is held: the time since the last echo, which is one tick or so old. */
const MAX_FIRST_STEP_MS = 60;
/** ... but never cut below this: the last echo of a 60 Hz node is up to a tick (17 ms) old, more than 2 frames at 144 Hz. */
const MIN_FIRST_STEP_MS = 25;

export function gapStepMs(frameMs: number, started: boolean, now: number, newest: { t: number; predicted?: boolean } | undefined, lateness: number, walkedOn = false): number {
  if (started || !newest || newest.predicted) return frameMs;
  const since = now - Math.max(0, lateness) - newest.t;
  if (!(since > 0 && since <= (walkedOn ? HANDOFF_CATCH_UP_MAX_MS : MAX_FIRST_STEP_MS))) return frameMs;
  // Else at most two frames (or MIN_FIRST_STEP_MS): a key let go and pressed again within 60 ms of the echo has not walked all that time.
  return walkedOn ? since : Math.min(since, Math.max(2 * frameMs, MIN_FIRST_STEP_MS));
}

/** The most stretches a gap report holds (the engine's MAX_GAP_SEGMENTS): a gap with more is not reported. */
export const MAX_GAP_SEGMENTS = 16;
/** The most HANDOFF_GAP reports after AUTH's one gap sends (the engine's MAX_GAP_UPDATES). */
export const MAX_GAP_UPDATES = 32;
export const GAP_DONE_WAIT_MS = 1000;

/** A stretch of the gap walk: the direction walked ("" where the player stood), for `ms`. */
export interface GapSegment {
  walk: string;
  ms: number;
}

/** The report sent with AUTH to the new node: the stretches that ended, in order, and the direction held now ("" for none). */
export interface GapReport {
  segments: GapSegment[];
  held: string;
}

export class GapLog {
  private segments: GapSegment[] = [];
  private at: number | null = null;
  private held = "";
  private full = false;

  reset(): void {
    this.segments = [];
    this.at = null;
    this.held = "";
    this.full = false;
  }

  /** A frame was noted since the reset: the gap walk's first step is behind. */
  get started(): boolean {
    return this.at !== null;
  }

  frame(direction: string, walkMs: number, now: number, from: number | null): void {
    const walked = direction ? Math.max(0, walkMs) : 0;
    const start = this.at ?? (from !== null && Number.isFinite(from) ? Math.max(from, now - HANDOFF_CATCH_UP_MAX_MS) : now - walked);
    const span = Math.max(walked, now - start);
    this.add("", span - walked);
    this.add(direction, walked);
    this.at = start + span;
    this.held = direction;
  }

  report(): GapReport | null {
    if (this.at === null || this.full) return null;
    const ended = this.segments[this.segments.length - 1]?.walk === this.held ? this.segments.slice(0, -1) : this.segments;
    const segments: GapSegment[] = [];
    let total = 0;
    for (const s of ended) {
      const ms = Math.round(total + s.ms) - Math.round(total);
      total += s.ms;
      if (ms > 0) segments.push({ walk: s.walk, ms });
    }
    return { segments, held: this.held };
  }

  stepLeft(tickMs: number): { walk: string; ms: number } | null {
    const last = this.segments[this.segments.length - 1];
    if (!this.held || last?.walk !== this.held || !(tickMs > 0)) return null;
    const ms = Math.ceil(last.ms / tickMs - 1e-6) * tickMs - last.ms;
    return ms > 1e-3 ? { walk: this.held, ms } : null;
  }

  /** The walk going on walked `ms` more (stepLeft), at once: the next frame counts from its end. */
  finish(ms: number): void {
    const last = this.segments[this.segments.length - 1];
    if (this.at === null || !this.held || last?.walk !== this.held || !(ms > 0)) return;
    last.ms += ms;
    this.at += ms;
  }

  private add(walk: string, ms: number): void {
    if (!(ms >= 0.5)) return;
    const last = this.segments[this.segments.length - 1];
    if (last?.walk === walk) last.ms += ms;
    else if (this.segments.length < MAX_GAP_SEGMENTS) this.segments.push({ walk, ms });
    else this.full = true;
  }
}

export function stepWalkMs(from: { x: number; y: number }, x: number, y: number, mounted: boolean): number {
  return Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) / ((WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000);
}

export function beginPoint(newest: { x: number; y: number; t: number; predicted?: boolean } | undefined, at: any, mounted: boolean): { x: number; y: number; t: number } | null {
  const x = Math.round(Number(at?.x));
  const y = Math.round(Number(at?.y));
  if (!newest || newest.predicted || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if ((x === newest.x && y === newest.y) || Math.hypot(x - newest.x, y - newest.y) > TELEPORT_PX) return null;
  return { x, y, t: newest.t + stepWalkMs(newest, x, y, mounted) };
}

export const HANDOFF_KEEP_PX = 8;

export const HANDOFF_KEEP_WALK_PX = 13;
/** The widest tick that gets HANDOFF_KEEP_WALK_PX: a 60 Hz node's. A slower node's first echo comes up to 50 ms late and its steps are 6-9 px: a longer stand and a 1.4-2.2 x step than the reseed in the sweep. */
export const HANDOFF_KEEP_WALK_MAX_TICK_MS = 20;
function keepPx(): number {
  return getTickMs() <= HANDOFF_KEEP_WALK_MAX_TICK_MS ? HANDOFF_KEEP_WALK_PX : HANDOFF_KEEP_PX;
}

export const HANDOFF_KEEP_LEAD_MS = 20;

export function hasAnchor(samples: ReadonlyArray<{ predicted?: boolean }> | undefined | null): boolean {
  return !!samples && samples.some((s) => !s.predicted);
}

export function planHandoffDone(
  predicting: boolean,
  moving: boolean,
  player: { position: { x: number; y: number }; lastDirection?: string; mounted?: boolean; isGhost?: boolean } | null | undefined,
  server: { x: number; y: number },
  anchored = true,
): "keep" | "reseed" {
  const head = player?.position;
  if (!predicting || !moving || !anchored || !head || !Number.isFinite(head.x) || !Number.isFinite(head.y)) return "reseed";
  if (Math.hypot(head.x - server.x, head.y - server.y) > keepPx()) return "reseed";
  const unit = UNITS[player?.lastDirection ?? ""];
  const walk = (WALK_SPEED_PX_S * (atMountSpeed(player) ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
  // No direction: ahead or behind is not known, so the distance is taken as the lead (one axis's walking time).
  if (!unit) return Math.hypot(server.x - head.x, server.y - head.y) / walk > HANDOFF_KEEP_LEAD_MS ? "reseed" : "keep";
  const lead = (server.x - head.x) * unit[0] + (server.y - head.y) * unit[1];
  const speed = walk * (Math.abs(unit[0]) + Math.abs(unit[1]));
  return lead / speed > HANDOFF_KEEP_LEAD_MS ? "reseed" : "keep";
}

/** The longest catch-up a HANDOFF_DONE point is moved on by (the engine's MAX_RESUME_CATCH_UP_MS). */
export const HANDOFF_CATCH_UP_MAX_MS = 500;

export function madeUpPoint(
  server: { x: number; y: number },
  walk: string | null | undefined,
  catchUpMs: unknown,
  mounted: boolean,
): { x: number; y: number } {
  const unit = UNITS[walk ?? ""];
  const ms = Math.min(HANDOFF_CATCH_UP_MAX_MS, Number(catchUpMs));
  if (!unit || !(ms > 0)) return server;
  // A diagonal steps the same px on both axes as a straight walk on one.
  const px = ((WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000) * ms;
  return { x: server.x + unit[0] * px, y: server.y + unit[1] * px };
}

/** The most a kept walk's echoes are dated earlier (keptWalkShift): a longer stand on the server is still shown as one. */
export const KEPT_SHIFT_MAX_MS = 40;
/** The shift falls away at this part of the time that passes: the draw plays 10% slow meanwhile, as the delay slews. */
export const KEPT_SHIFT_SLEW = 0.1;
export const KEPT_PACE_MIN = 1 - KEPT_SHIFT_SLEW;
/** An echo later than the slowest pace by more than this plus one server tick is not dated earlier to keep it (a stall, or a slowed player). */
export const KEPT_PACE_LATE_MS = 15;
/** The most a catch-up after a stall of the link plays at, in walking speeds: past the lead cap, never faster than this. */
export const KEPT_CATCHUP_SPEED = 1.5;
/** The most a catch-up is dated after the arrival of its echo: about 330 ms of stall at KEPT_CATCHUP_SPEED. Past it, as before. */
export const KEPT_CATCHUP_LEAD_MAX_MS = 200;
export const KEPT_HEADROOM_SLACK_MS = 4;
export const KEPT_LEAD_SHIFT_MAX_MS = 60;

type WalkSample = { t: number; x: number; y: number; predicted?: boolean; held?: boolean; heldUntil?: number; eased?: boolean };

export const HOLD_MAX_MS = 100;

export function releaseHeld(samples: WalkSample[], x: number, y: number, at: number, mounted: boolean): void {
  const last = samples[samples.length - 1];
  if (!last) return;
  clearHeld(samples);
  const walk = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
  if (Math.hypot(x - last.x, y - last.y) > HANDOFF_KEEP_PX) {
    pushSample(samples, x, y, last.t + 0.01);
    return;
  }
  const distance = Math.max(Math.abs(x - last.x), Math.abs(y - last.y));
  let from = last.t;
  if (at > last.t && pushSample(samples, last.x, last.y, at)) from = at;
  if (pushSample(samples, x, y, from + Math.max(0.01, distance / walk))) samples[samples.length - 1].eased = true;
}

/** Lets go of every held spot in the list (the hold ended, was cancelled, or the list is being used for something else). */
export function clearHeld(samples: WalkSample[] | undefined | null): void {
  if (!samples) return;
  for (const s of samples) {
    if (s.held) {
      s.held = false;
      delete s.heldUntil;
    }
  }
}

function walkReach(samples: ReadonlyArray<WalkSample>, x: number, y: number, direction: string | undefined, mounted: boolean) {
  const unit = UNITS[direction ?? ""];
  if (!unit) return null;
  let first = samples.length;
  while (first > 0 && samples[first - 1].predicted) first--;
  if (first === samples.length || first === 0) return null;
  // Progress along the walk: on a diagonal both axes step the same px, so it moves twice the speed of one axis.
  const along = (p: { x: number; y: number }) => p.x * unit[0] + p.y * unit[1];
  const target = along({ x, y });
  if (target <= along(samples[first - 1])) return null;
  const last = samples[samples.length - 1];
  const speed = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * (Math.abs(unit[0]) + Math.abs(unit[1]))) / 1000;
  let at: number | null = null;
  for (let k = first; k < samples.length; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    if (target <= along(b)) {
      at = a.t + ((b.t - a.t) * (target - along(a))) / (along(b) - along(a));
      break;
    }
  }
  if (at === null) at = last.t + (target - along(last)) / speed;
  return { at, first, target, along, last };
}

export function keptWalkShift(
  samples: ReadonlyArray<WalkSample>,
  x: number,
  y: number,
  t: number,
  renderAt: number | null,
  headroom: number,
  direction: string | undefined,
  mounted: boolean,
): number {
  const reach = walkReach(samples, x, y, direction, mounted);
  if (!reach) return 0;
  const shift = t - reach.at;
  if (shift < 0) return -shift <= KEPT_LEAD_SHIFT_MAX_MS ? shift : 0;
  if (!(shift > 0) || shift > Math.min(KEPT_SHIFT_MAX_MS, headroom + KEPT_HEADROOM_SLACK_MS)) return 0;
  if (renderAt !== null && reach.at < renderAt) return 0;
  return shift;
}

export function keptWalkCover(
  samples: WalkSample[],
  x: number,
  y: number,
  t: number,
  renderAt: number | null,
  headroom: number,
  direction: string | undefined,
  mounted: boolean,
  out?: { hold: { x: number; y: number; t: number } | null },
): number {
  const reach = walkReach(samples, x, y, direction, mounted);
  if (!reach) return 0;
  const { at, first, target, along, last } = reach;
  const bound = Math.max(0, Math.min(KEPT_SHIFT_MAX_MS, headroom + KEPT_HEADROOM_SLACK_MS));
  const past = renderAt !== null && at < renderAt;
  if (!(t - at > bound || past) || !(target < along(last))) return 0;
  const dated = renderAt !== null ? Math.max(t - bound, renderAt + 0.01) : t - bound;
  const held = renderAt !== null ? positionAt(samples, renderAt) : null;
  while (samples.length > first && along(samples[samples.length - 1]) > target) samples.pop();
  if (held && renderAt !== null && samples[samples.length - 1].t < renderAt) {
    samples.push({ t: renderAt, x: held.x, y: held.y, predicted: true });
  }
  if (out && past && held && renderAt !== null && along(held) > target) out.hold = { x: held.x, y: held.y, t: renderAt };
  return t - dated;
}

/** What KeptWalkDating reads of the movement clock (movementsmoothing.ts) when an echo comes. */
export interface EchoClock {
  /** lastRenderTime(): where the last frame drew. */
  renderAt: number | null;
  /** renderHeadroom(): the delay in use less one tick. */
  headroom: number;
  /** getClockOffset(): the send-to-timeline offset sampleTime dated the echo with. */
  offset: number | null;
}

export class KeptWalkDating {
  private armed = false;
  private armedAt = 0;
  /** Added to the time sampleTime gives: negative is earlier. 0 when nothing is left. */
  private adjust = 0;
  private offset: number | null = null;
  private at = 0;
  /** sampleTime's time of the last echo dated with a shift. */
  private lastT = 0;
  /** The last time returned while a shift was in use: the next one is later (null when none is in use). */
  private lastDated: number | null = null;
  /** The drawn spot the draw was past the first echo's point at (keptWalkCover): echoes behind it are held there. */
  private hold: { x: number; y: number; t: number; unit: readonly [number, number]; direction: string; since: number; prev: number } | null = null;
  private clamped: { x: number; y: number; held: boolean; until: number } | null = null;
  /** True from a kept DONE until SETTLE_MS after it, or a cancel: the window the walking-time floor applies in. */
  private active = false;
  /** The last echo of the window: its point and the time it was dated at (the floor is measured from it). */
  private prev: { x: number; y: number; dated: number } | null = null;

  arm(now: number): void {
    this.armed = true;
    this.active = true;
    this.armedAt = now;
    this.adjust = 0;
    this.lastDated = null;
    this.hold = null;
    this.clamped = null;
    this.prev = null;
  }

  cancel(): void {
    this.armed = false;
    this.active = false;
    this.adjust = 0;
    this.lastDated = null;
    this.hold = null;
    this.clamped = null;
    this.prev = null;
  }

  point(x: number, y: number): { x: number; y: number; held: boolean; until: number } {
    return this.clamped ?? { x, y, held: false, until: 0 };
  }

  /** The time to date the local player's echo at, for `t` from sampleTime, arriving at `now`. */
  date(
    samples: WalkSample[],
    x: number,
    y: number,
    t: number,
    now: number,
    clock: EchoClock,
    direction: string | undefined,
    mounted: boolean,
  ): number {
    // The renderer let go of the held spot (releaseHeld, its time was up): the hold is over, this echo is dated as any other.
    if (this.hold && !samples.some((sample) => sample.held)) this.hold = null;
    if (this.armed) {
      this.armed = false;
      const fresh = now - this.armedAt >= 0 && now - this.armedAt <= SETTLE_MS;
      const shift = fresh ? keptWalkShift(samples, x, y, t, clock.renderAt, clock.headroom, direction, mounted) : 0;
      // A point behind the walked head by more than the shift can cover: the samples ahead of it are removed.
      const out: { hold: { x: number; y: number; t: number } | null } = { hold: null };
      this.adjust = -(fresh && shift === 0 ? keptWalkCover(samples, x, y, t, clock.renderAt, clock.headroom, direction, mounted, out) : shift);
      const unit = UNITS[direction ?? ""];
      this.hold = out.hold && unit ? { ...out.hold, unit, direction: direction ?? "", since: now, prev: -Infinity } : null;
    } else if (this.adjust !== 0) {
      const drop = this.offset !== null && clock.offset !== null ? Math.max(0, this.offset - clock.offset) : 0;
      this.adjust = this.adjust < 0
        ? Math.min(0, Math.min(0, this.adjust + drop) + Math.max(0, now - this.at) * KEPT_SHIFT_SLEW)
        : Math.max(0, this.adjust + drop - Math.max(0, t - this.lastT) * KEPT_SHIFT_SLEW);
    }
    // Never more than KEPT_LEAD_SHIFT_MAX_MS after the arrival (an offset drop added to a later dating could pass it).
    this.adjust = Math.min(this.adjust, now + KEPT_LEAD_SHIFT_MAX_MS - t);
    let dated = t + this.adjust;
    this.clamped = null;
    if (this.hold) {
      const u = this.hold.unit;
      const along = x * u[0] + y * u[1];
      const ahead = (x - this.hold.x) * u[0] + (y - this.hold.y) * u[1] > 0 && Math.hypot(x - this.hold.x, y - this.hold.y) < HANDOFF_SNAP_PX;
      const expired = Math.hypot(x - this.hold.x, y - this.hold.y) > HANDOFF_KEEP_PX || now - this.hold.since > HOLD_MAX_MS;
      if (along <= this.hold.prev || (direction ?? "") !== this.hold.direction || (expired && !ahead)) {
        clearHeld(samples);
        this.hold = null;
      }
    }
    if (this.hold) {
      const u = this.hold.unit;
      if (x * u[0] + y * u[1] < this.hold.x * u[0] + this.hold.y * u[1]) {
        this.hold.prev = x * u[0] + y * u[1];
        // Behind the spot the draw holds: the spot, dated just after the last one, so the next echo's chord leaves it.
        this.hold.t += 0.01;
        this.clamped = { x: this.hold.x, y: this.hold.y, held: true, until: this.hold.since + HOLD_MAX_MS };
        this.lastDated = this.hold.t;
        this.prev = null;
        this.offset = clock.offset;
        this.at = now;
        this.lastT = t;
        return this.hold.t;
      }
      const walk = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * (Math.abs(u[0]) + Math.abs(u[1]))) / 1000;
      const start = Math.max(this.lastDated ?? this.hold.t, dated - ((x - this.hold.x) * u[0] + (y - this.hold.y) * u[1]) / walk, clock.renderAt ?? -Infinity);
      if (start > this.hold.t + 0.01 && start < dated) samples.push({ t: start, x: this.hold.x, y: this.hold.y, predicted: true });
      // The chord from the spot is held to the walking time below, from where it leaves.
      if (this.active) this.prev = { x: this.hold.x, y: this.hold.y, dated: Math.min(start, dated - 0.01) };
      clearHeld(samples);
      this.hold = null;
    }
    // The window of the pacing below: SETTLE_MS after the arming.
    if (this.active && now - this.armedAt > SETTLE_MS) {
      this.active = false;
      this.prev = null;
    }
    if (this.active && this.prev) {
      const unit = UNITS[direction ?? ""];
      const progress = unit ? (x - this.prev.x) * unit[0] + (y - this.prev.y) * unit[1] : 0;
      if (unit && progress > 0 && Math.hypot(x - this.prev.x, y - this.prev.y) < HANDOFF_SNAP_PX) {
        const speed = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * (Math.abs(unit[0]) + Math.abs(unit[1]))) / 1000;
        const walkMs = progress / speed;
        const dating = dated;
        let from = this.prev.dated;
        const renderAt = clock.renderAt;
        if (renderAt !== null && renderAt > from) {
          from = renderAt;
          const tail = samples[samples.length - 1];
          if (tail && tail.x === this.prev.x && tail.y === this.prev.y && tail.t < renderAt) samples.push({ t: renderAt, x: tail.x, y: tail.y, predicted: true });
        }
        const early = t - Math.max(0, Math.min(KEPT_SHIFT_MAX_MS, clock.headroom + KEPT_HEADROOM_SLACK_MS));
        const slowest = from + walkMs / KEPT_PACE_MIN;
        // A step late by up to a tick is the node's first ticks (one sat out after the catch-up step, a late one), not a stall.
        if (dated > slowest && dated - slowest <= KEPT_PACE_LATE_MS + getTickMs()) dated = Math.min(dated, Math.max(slowest, early));
        dated = Math.max(dated, from + walkMs * KEPT_PACE_MIN);
        const cap = now + KEPT_LEAD_SHIFT_MAX_MS;
        if (dated > cap) dated = Math.min(Math.max(cap, from + walkMs / KEPT_CATCHUP_SPEED), now + KEPT_CATCHUP_LEAD_MAX_MS);
        if (dated !== dating) this.adjust = dated - t;
      }
    }
    const tail = samples[samples.length - 1];
    if (tail?.eased && clock.renderAt !== null) {
      const at = clock.renderAt;
      const here = positionAt(samples, at)!;
      if (Math.hypot(x - here.x, y - here.y) > HANDOFF_KEEP_PX || at - tail.t > KEPT_CATCHUP_LEAD_MAX_MS) tail.eased = false;
    }
    if (tail?.eased && clock.renderAt !== null) {
      const at = clock.renderAt;
      const here = positionAt(samples, at)!;
      samples.pop();
      const newest = samples[samples.length - 1];
      if (newest && at > newest.t) samples.push({ t: at, x: here.x, y: here.y, predicted: true });
      const walkMs = Math.max(Math.abs(x - here.x), Math.abs(y - here.y)) / ((WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000);
      if (dated < at + walkMs) {
        dated = at + walkMs;
        this.adjust = dated - t;
      }
    }
    // Strictly after the last dated echo: pushEcho drops an older one, and with it the server's point.
    if (this.lastDated !== null && dated <= this.lastDated) {
      dated = this.lastDated + 0.01;
      this.adjust = dated - t;
    }
    this.lastDated = this.adjust !== 0 ? dated : null;
    if (this.active) this.prev = { x, y, dated };
    this.offset = clock.offset;
    this.at = now;
    this.lastT = t;
    return dated;
  }
}

/** After a kept walk with no echo for this long, the node's point is taken (eased). */
export const SETTLE_MS = 500;

interface SettlePlayer extends WalkPlayer {
  serverPosition: { x: number; y: number };
  renderPosition?: { x: number; y: number };
}

export class HandoffSettle {
  private timer: unknown = null;
  constructor(
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly clear: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    private readonly clock: () => number = () => performance.now(),
  ) {}

  get pending(): boolean {
    return this.timer !== null;
  }

  arm(player: SettlePlayer, x: number, y: number): void {
    this.cancel();
    const handle = this.schedule(() => {
      if (this.timer !== handle) return;
      this.timer = null;
      if (player.serverPosition.x !== x || player.serverPosition.y !== y) return;
      if (player.position.x === x && player.position.y === y) return;
      const shown = player.renderPosition ? { x: player.renderPosition.x, y: player.renderPosition.y } : { x: player.position.x, y: player.position.y };
      player.position.x = x;
      player.position.y = y;
      startEase(player, shown, { x, y }, this.clock());
    }, SETTLE_MS);
    this.timer = handle;
  }

  cancel(): void {
    if (this.timer === null) return;
    this.clear(this.timer);
    this.timer = null;
  }
}

/** The slowest the draw plays, in walking speeds, in the first HANDOFF_PACE_WINDOW_MS of a walking handoff: slower than a stand, above the 0.6 the eye still reads as walking. */
export const HANDOFF_PACE_MIN = 0.65;
/** The draw follows the node's as it is while the node's pace is at least this (the 0.6 below which the targets count a stand); below it, it creeps at HANDOFF_PACE_MIN. */
export const HANDOFF_PACE_FOLLOW_MIN = 0.6;
/** The fastest it plays (catching up with the node after a burst of echoes or a stand): under the 1.25 the targets allow. */
export const HANDOFF_PACE_MAX = 1.11;
/** While the draw creeps or catches up its pace changes by at most this per ms (0.21 a frame at 144 Hz; 0.35, the whole way from 1.0 to the creep, at 72 Hz). Following the node's draw it is the node's own. */
export const HANDOFF_PACE_RAMP_PER_MS = 0.03;
/** How far ahead of the node's draw the creep may take the draw: 16 px is a 90 ms gap. A longer lead stands. */
export const HANDOFF_PACE_LEAD_PX = 16;
/** How long after HANDOFF_DONE the pace is governed while the player walks; then the draw is the node's again, caught up to at HANDOFF_PACE_MAX if it is not. */
export const HANDOFF_PACE_WINDOW_MS = 1000;
/** The node's draw standing this long with the draw ahead of it (a held player, a wall) ends the creep: the draw goes back to it. */
export const HANDOFF_PACE_STALL_MS = 250;
/** A key let go (or a release): the draw waits this long, and while the node's draw is still on its way to it, before going back (the node has not heard of the key yet, its last steps may pass the draw). */
export const HANDOFF_PACE_WAIT_MS = 100;
/** A frame longer than this (a hidden pane) is not governed: the draw takes the node's. */
const PACE_MAX_FRAME_MS = 100;

export function planPaceArm(predicting: boolean, moving: boolean, shown: { x: number; y: number } | null | undefined): { x: number; y: number } | null {
  return predicting && moving && shown ? { x: shown.x, y: shown.y } : null;
}

export function planStopPace(predicting: boolean, moving: boolean, shown: { x: number; y: number } | null | undefined): { x: number; y: number } | null {
  return predicting && !moving && shown ? { x: shown.x, y: shown.y } : null;
}

export class HandoffPace {
  private out: { x: number; y: number } | null = null;
  private heading: readonly [number, number] | null = null;
  private previous: { x: number; y: number } | null = null;
  private pace = 1;
  private last = 0;
  private armedAt = 0;
  private stalled = 0;
  /** When the pace stopped governing the draw (a key let go, release(), the window over); -1 while it governs. */
  private leftAt = -1;
  /** A turn: the direction walked before it and when the key changed (the node has not heard of it yet). */
  private turnedFrom: readonly [number, number] | null = null;
  private turnedAt = 0;
  private on = false;
  /** The pace still governs the draw (the key is held, no release(), inside the window); else it takes the node's draw. */
  private governed = false;
  /** The draw is creeping (the node's draw is behind it) or catching up, not following the node's. */
  private adjusting = false;

  /** `from`: where the local player is drawn now (the draw goes on from there). */
  arm(now: number, from: { x: number; y: number }): void {
    this.on = true;
    this.governed = true;
    this.adjusting = false;
    this.armedAt = now;
    this.pace = 1;
    this.stalled = 0;
    this.leftAt = -1;
    this.turnedFrom = null;
    this.heading = null;
    this.previous = null;
    this.out = { x: from.x, y: from.y };
  }

  /** The handoff is superseded (a new switch, a closed socket, a map load): the draw goes back to the node's position. */
  release(): void {
    this.governed = false;
  }

  get active(): boolean {
    return this.on;
  }

  /** step() with the inputs the renderer has: the movement keys and the stick (gapDirection). */
  stepFor(target: { x: number; y: number }, now: number, keys: { has(code: string): boolean }, stick: string, mounted: boolean, blocked?: (x: number, y: number) => boolean): { x: number; y: number } {
    return this.step(target, now, gapDirection(keys, stick), mounted, blocked);
  }

  /** The position to draw for `target` (the smoothed node position plus any ease) in the frame at `now`. Call every frame: it notes the frame time. */
  step(target: { x: number; y: number }, now: number, direction: string, mounted: boolean, blocked?: (x: number, y: number) => boolean): { x: number; y: number } {
    const out = this.out;
    const dt = now - this.last;
    this.last = now;
    if (!this.on || !out) return target;
    const dx = target.x - out.x;
    const dy = target.y - out.y;
    if (!(dt > 0) || dt > PACE_MAX_FRAME_MS || Math.hypot(dx, dy) > HANDOFF_SNAP_PX) {
      this.on = false;
      this.out = null;
      return target;
    }
    const speed = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
    const moved = this.previous ? { x: target.x - this.previous.x, y: target.y - this.previous.y } : { x: 0, y: 0 };
    this.stalled = this.previous && Math.hypot(moved.x, moved.y) < 0.02 ? this.stalled + dt : 0;
    this.previous = { x: target.x, y: target.y };
    const unit = this.governed && now - this.armedAt <= HANDOFF_PACE_WINDOW_MS ? UNITS[direction] : undefined;
    if (unit) {
      if (this.heading && (this.heading[0] !== unit[0] || this.heading[1] !== unit[1])) {
        this.turnedFrom = this.heading;
        this.turnedAt = now;
      }
      this.heading = unit;
      this.leftAt = -1;
      const norm = unit[0] * unit[0] + unit[1] * unit[1];
      const ahead = (dx * unit[0] + dy * unit[1]) / norm;
      if (ahead < 0 && this.stalled > HANDOFF_PACE_STALL_MS) this.governed = false;
      const side = { x: dx - ahead * unit[0], y: dy - ahead * unit[1] };
      // Just turned: the node still walks the old way for a moment (and may stop in it); the draw does not go back on that axis for HANDOFF_PACE_WAIT_MS.
      const before = this.turnedFrom;
      if (before && now - this.turnedAt < HANDOFF_PACE_WAIT_MS) {
        if (before[0] !== 0 && unit[0] === 0 && Math.sign(side.x) === -before[0]) side.x = 0;
        if (before[1] !== 0 && unit[1] === 0 && Math.sign(side.y) === -before[1]) side.y = 0;
      }
      const want = ahead / (speed * dt);
      const ramp = HANDOFF_PACE_RAMP_PER_MS * dt;
      if (!this.adjusting && want >= HANDOFF_PACE_FOLLOW_MIN) {
        this.pace = Math.min(HANDOFF_PACE_MAX, want);
      } else {
        this.adjusting = true;
        this.pace = Math.max(Math.max(HANDOFF_PACE_MIN, this.pace - ramp), Math.min(HANDOFF_PACE_MAX, this.pace + ramp, want));
        if (this.pace >= want && want >= HANDOFF_PACE_MIN) this.adjusting = false;
      }
      let along = this.pace * speed * dt;
      // Past the node's draw the creep stops at the lead, and at a wall (the gap walk's collision test: the walls the client holds).
      if (ahead < 0 || along > ahead) {
        along = Math.min(along, Math.max(0, ahead + HANDOFF_PACE_LEAD_PX));
        if (along > Math.max(0, ahead) && blocked?.(out.x + side.x + unit[0] * along, out.y + side.y + unit[1] * along)) along = Math.max(0, ahead);
        this.pace = along / (speed * dt);
      }
      let stepX = side.x + unit[0] * along;
      let stepY = side.y + unit[1] * along;
      const longest = HANDOFF_PACE_MAX * speed * dt * Math.sqrt(norm);
      const length = Math.hypot(stepX, stepY);
      if (length > longest) {
        stepX *= longest / length;
        stepY *= longest / length;
      }
      out.x += stepX;
      out.y += stepY;
    } else {
      const step = speed * dt;
      const heading = this.heading;
      if (this.leftAt < 0) this.leftAt = now;
      const coming = heading !== null && moved.x * heading[0] + moved.y * heading[1] > 0.02;
      const waiting = heading !== null && (coming || now - this.leftAt < HANDOFF_PACE_WAIT_MS || (this.stalled > 0 && this.stalled < HANDOFF_PACE_WAIT_MS));
      const stayX = waiting && heading !== null && heading[0] !== 0 && Math.sign(dx) === -heading[0];
      const stayY = waiting && heading !== null && heading[1] !== 0 && Math.sign(dy) === -heading[1];
      const limitX = stayX ? 0 : heading && heading[0] !== 0 && Math.sign(dx) === heading[0] ? HANDOFF_PACE_MAX * step : step;
      const limitY = stayY ? 0 : heading && heading[1] !== 0 && Math.sign(dy) === heading[1] ? HANDOFF_PACE_MAX * step : step;
      out.x += Math.max(-limitX, Math.min(limitX, dx));
      out.y += Math.max(-limitY, Math.min(limitY, dy));
      this.pace = 1;
      if (Math.abs(dx) <= limitX && Math.abs(dy) <= limitY) {
        this.on = false;
        this.out = null;
      }
    }
    return this.out ? { x: out.x, y: out.y } : { x: target.x, y: target.y };
  }
}
