// The local player keeps walking while a node handoff switches connections (cells phase 7, handoff fix 2).
//
// Movement is server-authoritative and direction-based: the client sends one MOVEXY per direction change and draws the
// positions the node sends. During a handoff there is no connection for a few hundred milliseconds, so the character
// would stand still. For that gap the client advances its own player along the direction the player holds, at the
// speed the server steps (6 px per 30 Hz tick, 1.35 times that mounted), stopped by the collision layer of the chunks it
// holds, the way the server's own step is. It never sends this position. When the new node's position arrives, the
// difference is eased out (an error above HANDOFF_SNAP_PX snaps, as the movement smoothing snaps a teleport).
//
// This file has no DOM and no socket, so the engine's tests run it.

import { TELEPORT_PX, getTickMs, positionAt, pushSample } from "./movementsmoothing.ts";

/** px a second at 30 Hz: 6 px a tick, as the engine's MOVEXY handler steps. */
export const WALK_SPEED_PX_S = 180;
export const MOUNT_SPEED_MULTIPLIER = 1.35;
/** A predicted position off by more than this from the new node's is not eased but taken (the smoothing's own teleport size). */
export const HANDOFF_SNAP_PX = TELEPORT_PX;
/** How fast the error eases out: it falls to a third in this long. */
export const EASE_TIME_CONSTANT_MS = 120;
/** The prediction stops this long after the SWITCH: a node that has not answered by then is not worth walking toward. */
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
}

/**
 * Whether the player's box at (x, y) overlaps a collision tile of a chunk the client holds. A chunk not held is not a
 * wall: the prediction goes on and the node's position corrects it.
 */
export function blockedAt(map: WalkMap | null | undefined, x: number, y: number): boolean {
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

/**
 * The position after walking `dtMs` in `direction`: the speed of the engine's step, a diagonal that meets a wall slides
 * along the open axis. Floats: the caller rounds what it shows.
 */
export function walkStep(
  from: { x: number; y: number },
  direction: string,
  dtMs: number,
  mounted: boolean,
  blocked: (x: number, y: number) => boolean,
): { x: number; y: number } {
  const unit = UNITS[direction];
  if (!unit || !(dtMs > 0)) return { x: from.x, y: from.y };
  const distance = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * dtMs) / 1000;
  // The engine steps 6 px on each axis of a diagonal (the same px, not a unit vector).
  const nx = from.x + unit[0] * distance;
  const ny = from.y + unit[1] * distance;
  if (!blocked(nx, ny)) return { x: nx, y: ny };
  if (unit[0] !== 0 && unit[1] !== 0) {
    if (!blocked(nx, from.y)) return { x: nx, y: from.y };
    if (!blocked(from.x, ny)) return { x: from.x, y: ny };
  }
  return { x: from.x, y: from.y };
}

/** The player record fields the walk reads and writes. */
interface WalkPlayer {
  position: { x: number; y: number };
  mounted?: boolean;
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
  const to = walkStep(from, direction, dtMs, player.mounted === true, (x, y) => blockedAt(map, x, y));
  player.handoffWalk = to;
  const x = Math.round(to.x);
  const y = Math.round(to.y);
  const moved = x !== player.position.x || y !== player.position.y;
  player.position.x = x;
  player.position.y = y;
  player.lastDirection = direction;
  return moved;
}

/**
 * The new node's position arrived while the player was drawn at `shown`. Within HANDOFF_SNAP_PX the difference is kept
 * as an offset that falls away (applyEase); beyond it nothing is kept and the caller's position stands. Returns whether
 * an ease was started.
 */
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

/**
 * The timeline time of the local player's predicted step in the handoff gap. Dating it at the last sample + 0.01 would
 * put the newest step far in the past, so the draw (a fixed delay behind the newest step) would run ahead of it and
 * jump; dated at now - lateness (the running lateness of the echoes, movementsmoothing getLateness) it stays the usual
 * delay behind, as the echoes do. Never before the last sample.
 */
export function gapSampleTime(now: number, lastT: number, lateness: number, walkMs = 0): number {
  return Math.max(now - Math.max(0, lateness), lastT + 0.01, lastT + walkMs);
}

/** The first step of the gap walks at most this long, unless the walk at the switch is held: the time since the last echo, which is one tick or so old. */
const MAX_FIRST_STEP_MS = 60;
/** ... but never cut below this: the last echo of a 60 Hz node is up to a tick (17 ms) old, more than 2 frames at 144 Hz. */
const MIN_FIRST_STEP_MS = 25;

/**
 * How long this frame's gap step walks. The first step starts at the last echo's position, which the player left up to a
 * tick before the switch, not at the frame before: walking one frame from it put the first predicted sample 1.4 px ahead of
 * (or 0.8 px behind) where the walk is, drawn at 2.6 (or 0.56) times the walk. So the first step walks the time since the
 * echo (its sample time, and now less the lateness: the time gapSampleTime dates the step at); the next ones a frame each.
 * `walkedOn`: the walk the player had at the switch is still held (walkAtSwitch). The old node stops stepping as it drains,
 * a tick or more before the switch, and the new node makes all of that time up (its catch-up counts from the old node's
 * last step): the step walks all of it, up to the most it makes up (HANDOFF_CATCH_UP_MAX_MS). Cut to two frames it fell
 * 1.5-2 px short, drawn at 0.75 times the walk for 3 frames; cut to one frame after a drain of 60 ms or more, 9 px short.
 */
export function gapStepMs(frameMs: number, started: boolean, now: number, newest: { t: number; predicted?: boolean } | undefined, lateness: number, walkedOn = false): number {
  if (started || !newest || newest.predicted) return frameMs;
  const since = now - Math.max(0, lateness) - newest.t;
  if (!(since > 0 && since <= (walkedOn ? HANDOFF_CATCH_UP_MAX_MS : MAX_FIRST_STEP_MS))) return frameMs;
  // Else at most two frames (or MIN_FIRST_STEP_MS): a key let go and pressed again within 60 ms of the echo has not walked all that time.
  return walkedOn ? since : Math.min(since, Math.max(2 * frameMs, MIN_FIRST_STEP_MS));
}

/**
 * The walking time of a predicted step, from the newest sample to the player's position: the longer axis (a diagonal
 * steps the same px on both) over the walking speed. gapSampleTime dates the step no earlier than that after the
 * sample: the first step of the gap is a whole frame of walk from the last echo, which came part of a frame before the
 * switch, and dated at the frame's time it would be drawn at 2.6 times the walk.
 */
export function stepWalkMs(from: { x: number; y: number }, x: number, y: number, mounted: boolean): number {
  return Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) / ((WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000);
}

/**
 * The most the client's walked position may differ from the new node's point at HANDOFF_DONE to keep the walk as it is.
 * About 44 ms of walk: the server stood through the gap. A lead up to this is kept: the first echo is dated at the shift
 * the render headroom allows (keptWalkCover removes the samples it cannot cover), a longer one takes the node's point.
 */
export const HANDOFF_KEEP_PX = 8;

/**
 * The most the walked head may be ahead of the node's point for planHandoffDone to keep a walk on a 60 Hz or faster node
 * (HANDOFF_KEEP_PX on a slower one). A longer gap reseeded: the draw stood at the point with the ease running back (a step back
 * of about 0.1 px), then played the first echoes raw (1.3-1.4x for the burst of 4-6 ms). Kept, the drawn spot (the head less the
 * playback delay's walk, about 8 px) is at most 5 px from the point, inside the hold's bound HANDOFF_KEEP_PX, which stays the
 * threshold of a warp (a hold ends, releaseHeld snaps, the ease join lets go). 13 px is 72 ms straight, 51 ms diagonal. The
 * largest bound whose stand (frames under 0.6 x), largest step and back-steps are in no swept case worse than reseeding:
 * 14 px stands longer than the reseed at 70-85 ms. Without back-steps up to 20 px (111 ms at 144 Hz needs an anchor, hasAnchor).
 */
export const HANDOFF_KEEP_WALK_PX = 13;
/** The widest tick that gets HANDOFF_KEEP_WALK_PX: a 60 Hz node's. A slower node's first echo comes up to 50 ms late and its steps are 6-9 px: a longer stand and a 1.4-2.2 x step than the reseed in the sweep. */
export const HANDOFF_KEEP_WALK_MAX_TICK_MS = 20;
function keepPx(): number {
  return getTickMs() <= HANDOFF_KEEP_WALK_MAX_TICK_MS ? HANDOFF_KEEP_WALK_PX : HANDOFF_KEEP_PX;
}

/**
 * The most the new node's point may be ahead of the walked head, in walking time, to keep the walk. The first echo, one
 * step further, is then dated where the walk reaches it (keptWalkShift), within KEPT_SHIFT_MAX_MS. A longer lead (a step
 * of a slow tick, 20-30 Hz, sent before the switch and never received) would be a catch-up jump on the kept samples: the
 * node's point is taken and eased instead.
 */
export const HANDOFF_KEEP_LEAD_MS = 20;

/**
 * Whether the sample list still holds a sample that is not predicted: the anchor the kept walk's dating measures from
 * (walkReach). A gap longer than MAX_SAMPLES frames (16: 111 ms at 144 Hz) pushes every echo out of the list; with no anchor the
 * first echo cannot be placed on the walk and goes in as it comes, a step back to the node's point.
 */
export function hasAnchor(samples: ReadonlyArray<{ predicted?: boolean }> | undefined | null): boolean {
  return !!samples && samples.some((s) => !s.predicted);
}

/**
 * What HANDOFF_DONE does with the local player's position: "keep" when the client walked the player through the gap, the
 * player still moves, and the walked position (`player.position`, the head of the samples: the gap walk's or the last
 * echo's) is within HANDOFF_KEEP_WALK_PX of the new node's point (the samples go on, the next echoes continue them: nothing
 * is rewritten, no ease). The drawn position is not used: it trails the head by the playback delay (about 8 px while
 * walking), so it would flip the choice from crossing to crossing. Else "reseed": the position and samples start at the
 * node's point, an ease follows when the client predicted and the error is within HANDOFF_SNAP_PX (startEase), a larger
 * one snaps.
 */
export function planHandoffDone(
  predicting: boolean,
  moving: boolean,
  player: { position: { x: number; y: number }; lastDirection?: string; mounted?: boolean } | null | undefined,
  server: { x: number; y: number },
  anchored = true,
): "keep" | "reseed" {
  const head = player?.position;
  if (!predicting || !moving || !anchored || !head || !Number.isFinite(head.x) || !Number.isFinite(head.y)) return "reseed";
  if (Math.hypot(head.x - server.x, head.y - server.y) > keepPx()) return "reseed";
  const unit = UNITS[player?.lastDirection ?? ""];
  const walk = (WALK_SPEED_PX_S * (player?.mounted === true ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
  // No direction: ahead or behind is not known, so the distance is taken as the lead (one axis's walking time).
  if (!unit) return Math.hypot(server.x - head.x, server.y - head.y) / walk > HANDOFF_KEEP_LEAD_MS ? "reseed" : "keep";
  // How long the walk takes to reach the node's point when that point is ahead of the head (on a diagonal both axes
  // step the same px, so progress along it is twice one axis's).
  const lead = (server.x - head.x) * unit[0] + (server.y - head.y) * unit[1];
  const speed = walk * (Math.abs(unit[0]) + Math.abs(unit[1]));
  return lead / speed > HANDOFF_KEEP_LEAD_MS ? "reseed" : "keep";
}

/** The longest catch-up a HANDOFF_DONE point is moved on by (the engine's MAX_RESUME_CATCH_UP_MS). */
export const HANDOFF_CATCH_UP_MAX_MS = 500;

/**
 * The point planHandoffDone weighs the walked position against: the new node's point moved on along `walk` by `catchUpMs`
 * of walking (HANDOFF_DONE's, at most HANDOFF_CATCH_UP_MAX_MS). The node stood the player from the old node's last step to
 * its own first one while the client walked on, and takes the missed steps at once with its first: its first echo is that
 * far past the point. Weighed against the point itself, a gap longer than HANDOFF_KEEP_WALK_PX of walk would reseed although
 * the echo lands on the walk. No walk or no catch-up (an engine that does not make it up): the point as it is.
 */
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
/**
 * A kept walk's segments play between this and 1/this times the walking speed (0.9 to 1.11): the 10% the shift and the
 * delay slew already allow. Faster would be a burst of the node's first steps (not on its tick cadence); slower a dip.
 */
export const KEPT_PACE_MIN = 1 - KEPT_SHIFT_SLEW;
/** An echo later than the slowest pace by more than this plus one server tick is not dated earlier to keep it (a stall, or a slowed player). */
export const KEPT_PACE_LATE_MS = 15;
/** The most a catch-up after a stall of the link plays at, in walking speeds: past the lead cap, never faster than this. */
export const KEPT_CATCHUP_SPEED = 1.5;
/** The most a catch-up is dated after the arrival of its echo: about 330 ms of stall at KEPT_CATCHUP_SPEED. Past it, as before. */
export const KEPT_CATCHUP_LEAD_MAX_MS = 200;
/**
 * How far a shift may go past the render headroom (renderHeadroom: the delay less one tick). Past the headroom the draw
 * reaches the newest echo before the next one comes and stands for the difference: up to this long is less than the
 * stand the shift removes. A longer shift is not used by keptWalkShift; keptWalkCover clamps it to this bound and removes
 * the predicted samples after the echo's point, which a clamped date alone would leave ahead of it.
 */
export const KEPT_HEADROOM_SLACK_MS = 4;
/**
 * The most a kept walk's first echo is dated later, when the node's point was ahead of the walked head: a lead of up to
 * HANDOFF_KEEP_LEAD_MS plus one step of a 30 Hz node, and never more than this after an echo's arrival. It falls away at
 * KEPT_SHIFT_SLEW of the send time that passes (the draw plays 10% fast).
 */
export const KEPT_LEAD_SHIFT_MAX_MS = 60;

type WalkSample = { t: number; x: number; y: number; predicted?: boolean; held?: boolean; heldUntil?: number; eased?: boolean };

/**
 * The longest a held spot is kept (KeptWalkDating): the spot is at most HANDOFF_KEEP_PX (8 px, 44 ms of walk) ahead of the
 * node's point, so the server's walk reaches it within 44 ms, and the echo that shows it can come one tick later (50 ms at
 * 20 Hz): 95 ms, 100 with the margin. Past it the hold ends whatever the echoes did.
 */
export const HOLD_MAX_MS = 100;

/**
 * A held spot timed out (heldUntil passed with no echo past it: the key was let go or the player turned) and the real
 * position, up to HANDOFF_KEEP_PX behind the spot the draw stands at, is taken. Not as an instant step back: the draw
 * stays at the spot until `at` (the draw's time) and goes back to the position at the walking speed (at most 44 ms for
 * 8 px), so no frame moves faster than the walk. Further than HANDOFF_KEEP_PX it is pushed as it was (a warp snaps). The
 * spots are let go; the end of the ease is marked, KeptWalkDating takes an echo that comes before the draw reaches it.
 */
export function releaseHeld(samples: WalkSample[], x: number, y: number, at: number, mounted: boolean): void {
  const last = samples[samples.length - 1];
  if (!last) return;
  clearHeld(samples);
  const walk = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
  // Further than a hold's own bound (HANDOFF_KEEP_PX) is not the overshoot of a stop: a warp or a jump. It goes in as the
  // plain path does (a teleport-sized one clears the list and snaps); an eased date far in the future would refuse the echoes.
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

/**
 * Where the predicted walk (the run of predicted samples at the tail, extrapolated at the walking speed past its newest
 * sample) reaches the point (x, y), measured along the walk's direction: `at` is that time. Null when the point cannot be
 * placed on the walk: no direction, no predicted run to continue, or a point not past the sample before the run.
 */
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

/**
 * The new node's first echo after a kept walk (planHandoffDone "keep"). The server stood the player from the SWITCH
 * until the new node resumed the walk, the client walked on: the echoes trail the predicted samples by that time. Dated
 * as they come, the draw reaches the newest predicted sample and stands until the echoes pass it (two frames at 144 Hz).
 * Returns how much earlier to date this echo (and, falling away, the next ones) so it lands where the predicted walk,
 * extrapolated at the walking speed past its newest sample, reaches the echo's point. Negative (dated later) when the
 * echo is ahead of that walk (the node's point was ahead of the head), up to KEPT_LEAD_SHIFT_MAX_MS. 0 (dated as it
 * comes) when the echo is not past the walk's start, when there is no predicted run to continue, when the draw is
 * already past that time (dating it there would step back), or when the shift is over KEPT_SHIFT_MAX_MS or over
 * `headroom` (renderHeadroom) plus KEPT_HEADROOM_SLACK_MS: the draw would run past the echo before the next one came
 * (a slow server tick).
 */
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
  // Ahead of the walk (the node's point was past the client's head, planHandoffDone): dated later, where the walk
  // reaches it, so the draw does not jump to it. Not bound by the headroom: a later date only adds to it.
  if (shift < 0) return -shift <= KEPT_LEAD_SHIFT_MAX_MS ? shift : 0;
  if (!(shift > 0) || shift > Math.min(KEPT_SHIFT_MAX_MS, headroom + KEPT_HEADROOM_SLACK_MS)) return 0;
  if (renderAt !== null && reach.at < renderAt) return 0;
  return shift;
}

/**
 * The first echo of a kept walk when the node's point is behind the walked head by more than keptWalkShift can cover (the
 * walk was ahead of the server by more than the render headroom): the echo is inside the predicted run, so the samples
 * after its point are ahead of it. Dated as it comes, or by the shift it can have, they stay and the draw runs on to them,
 * then back to the echo. The same when the shift is within the bound but the draw is already past the point
 * (keptWalkShift gives 0 there: dating it at the point would step back). They are removed, the echo is dated at the largest shift the headroom allows (it lands later than
 * the walk reached its point, the draw is slow for that long, never back), and a sample at the drawn spot holds the
 * position the draw has now where the slower chord starts. When the draw is past the point, `out.hold` is that spot:
 * KeptWalkDating puts it in place of the echoes behind it (a pause, never a step back). Returns that shift; 0, with nothing changed, when the echo is
 * not inside the run, or the shift is covered already (within the bound, the draw not past the point).
 */
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

/**
 * The dating of the local player's echoes after a kept walk: armed at HANDOFF_DONE, the first echo sets the shift
 * (keptWalkShift), the next ones are dated by what is left of it, which falls away at KEPT_SHIFT_SLEW. Then the echoes
 * are dated as they come again: the server's timeline wins within KEPT_SHIFT_MAX_MS / KEPT_SHIFT_SLEW. While it falls
 * away, a drop of the clock offset (a later echo less delayed than the first one the new node's clock was learned
 * from) is taken into what is left instead of dating that echo earlier at once: the first echo's own lateness would
 * otherwise be in the shift and come out as one fast frame. An echo later than SETTLE_MS after the arming is not the
 * walk's continuation: it is dated as it comes. Within that same window no echo is dated closer to the one before than
 * the walking time between them (less KEPT_SHIFT_SLEW), and a hold that ends with the echo ahead of the spot (a stall)
 * leaves the spot at the draw's time. Unarmed, every time is returned as it is.
 */
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

  /**
   * The point to put in the sample list for the echo just dated: the echo's own, or while the draw is past it (the first
   * echoes of a kept walk the draw had already walked over) the drawn spot, so the draw waits there for the server's walk
   * and never steps back. The player's position and serverPosition stay the echo's.
   */
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
      // The offset fell by `drop` since the last echo: this echo is dated that much earlier than the last one's clock.
      // An earlier dating never goes past zero (an echo is not dated after its arrival for it); a later one only falls.
      // A later dating falls by the send times that pass, not the arrivals: a stalled stream (echoes sent a tick apart,
      // arriving 250 ms apart) would otherwise take more off than the tick and date the echo before the last one.
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
      // The hold ends at once, whatever the echo is replaced by, on a stop (not further along than the one before), a turn,
      // a jump away from the spot, or after HOLD_MAX_MS: the spots are let go and the echo goes in as it is (the draw
      // snaps back from the spot to it: the overshoot, usually 1-3 px, 8 px at most, not an ease). A jump away or a timeout
      // with the echo ahead of the spot (the link stalled, the echoes came late) is the walk's catch-up, not a snap back:
      // it goes on below, the draw leaves the spot at the walking speed.
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
      // The first echo past the spot: the draw waits at the spot until the walk, at its speed, would reach the echo by its
      // time, then walks (a longer chord would be slower than the walk, and a catch-up step if the echo were late).
      const walk = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * (Math.abs(u[0]) + Math.abs(u[1]))) / 1000;
      // Never before the draw's time: the spot is the drawn position, and a sample of it dated behind the draw would put the
      // draw part way along the chord at once (a hold that outlasted a stall of the link).
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
    // Every segment is paced between 0.9 and 1.11 times the walk (KEPT_PACE_MIN), by the distance between the echoes, not by
    // their send times: the new node's first steps are not on its tick cadence (two echoes 5 ms apart for 3 px would be drawn
    // in 5 ms, two 23 ms apart in 23), and the lateness this adds falls away like the shift does.
    if (this.active && this.prev) {
      const unit = UNITS[direction ?? ""];
      const progress = unit ? (x - this.prev.x) * unit[0] + (y - this.prev.y) * unit[1] : 0;
      if (unit && progress > 0 && Math.hypot(x - this.prev.x, y - this.prev.y) < HANDOFF_SNAP_PX) {
        const speed = (WALK_SPEED_PX_S * (mounted ? MOUNT_SPEED_MULTIPLIER : 1) * (Math.abs(unit[0]) + Math.abs(unit[1]))) / 1000;
        const walkMs = progress / speed;
        const dating = dated;
        // The chord leaves the last echo's point at the draw's time when the draw stands there already (the link stalled,
        // or the echo is late): dated behind the draw, part of it would be drawn at once.
        let from = this.prev.dated;
        const renderAt = clock.renderAt;
        if (renderAt !== null && renderAt > from) {
          from = renderAt;
          const tail = samples[samples.length - 1];
          if (tail && tail.x === this.prev.x && tail.y === this.prev.y && tail.t < renderAt) samples.push({ t: renderAt, x: tail.x, y: tail.y, predicted: true });
        }
        // Not slower than the walk less the slew either: a late echo is dated earlier than it came, as far as the draw has
        // ahead of the data (the first shift's bound), unless it is so late that the player is slowed, not the node.
        const early = t - Math.max(0, Math.min(KEPT_SHIFT_MAX_MS, clock.headroom + KEPT_HEADROOM_SLACK_MS));
        const slowest = from + walkMs / KEPT_PACE_MIN;
        // A step late by up to a tick is the node's first ticks (one sat out after the catch-up step, a late one), not a stall.
        if (dated > slowest && dated - slowest <= KEPT_PACE_LATE_MS + getTickMs()) dated = Math.min(dated, Math.max(slowest, early));
        dated = Math.max(dated, from + walkMs * KEPT_PACE_MIN);
        // Past KEPT_LEAD_SHIFT_MAX_MS after the arrival no more is dated, except what a catch-up after a stall needs to play
        // no faster than KEPT_CATCHUP_SPEED, up to KEPT_CATCHUP_LEAD_MAX_MS.
        const cap = now + KEPT_LEAD_SHIFT_MAX_MS;
        if (dated > cap) dated = Math.min(Math.max(cap, from + walkMs / KEPT_CATCHUP_SPEED), now + KEPT_CATCHUP_LEAD_MAX_MS);
        if (dated !== dating) this.adjust = dated - t;
      }
    }
    // The first echo after releaseHeld's ease (while it runs, or after it when the echoes of a stall come late and dated before
    // its end): it takes the place of the end of the ease (dated before it, pushEcho would drop it and with it the server's point).
    // The draw goes on from where it is to the echo, no faster than the walk.
    const tail = samples[samples.length - 1];
    if (tail?.eased && clock.renderAt !== null) {
      const at = clock.renderAt;
      const here = positionAt(samples, at)!;
      // Only an echo that continues the walk: within a hold's own bound of the draw and no later than a catch-up reaches (a stalled
      // first echo). A warp or a long wait is dated as it comes (a far one snaps); the mark is let go.
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

/**
 * The fallback of a kept walk: if no echo follows (the key was let go at once) the player would stay at the predicted
 * spot. After SETTLE_MS the node's point is taken, and the difference is eased out, not jumped. Cancelled by anything
 * that makes it stale: a new switch or gap, a closed socket, a real echo.
 */
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

/**
 * What HANDOFF_DONE does with the pace: the position to arm it from (where the player is drawn) when the client walked the player
 * and the player still moves, kept or reseeded; else null. A standing crossing is never armed.
 */
export function planPaceArm(predicting: boolean, moving: boolean, shown: { x: number; y: number } | null | undefined): { x: number; y: number } | null {
  return predicting && moving && shown ? { x: shown.x, y: shown.y } : null;
}

/**
 * The drawn position of the local player for the first second after a handoff in which the client walked it (planPaceArm), kept or
 * reseeded. The node's timeline is behind the walk by the time the handoff took (it stood the player meanwhile), so the draw, which
 * was walked ahead of it, stands until the echoes catch up (a kept walk, 2-4 frames) or steps back to the node's point and then
 * plays the first echoes in a burst (a reseed). The pace plays the draw at the walking speed along the held direction, never slower
 * than HANDOFF_PACE_MIN nor faster than HANDOFF_PACE_MAX: while the node's draw is behind it, the draw goes on at HANDOFF_PACE_MIN, up
 * to HANDOFF_PACE_LEAD_PX ahead of it and not into a wall (the collision test of the gap walk), until the node's draw passes.
 * Creeping and catching up change the pace by at most HANDOFF_PACE_RAMP_PER_MS; following the node's draw it is the node's own
 * (0.6 to 1.11). Never backward while the key is held. A key let go, release() or the window over takes the node's position: the
 * draw waits while the node's draw is still coming to it (and HANDOFF_PACE_WAIT_MS after it stood), then goes back at the walking
 * pace per axis, forward at HANDOFF_PACE_MAX. The node's draw standing HANDOFF_PACE_STALL_MS with the draw ahead of it (a held
 * player) ends the creep the same way. A position beyond HANDOFF_SNAP_PX or a frame over 100 ms is taken at once. Only the position
 * drawn is changed, not the samples. Unarmed it returns the position it is given.
 */
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
      // `ahead`: the walk's progress (px on each axis) to where the node's draw is; negative when the draw is past it. The sideways
      // part follows the node's as it is.
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
      // The pace that reaches the node's draw this frame; the draw goes on at that exactly (invisible) while it is within the
      // bounds. Outside them the draw creeps (or catches up) and the pace changes by the ramp, until the node's draw can be followed again.
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
      // Never faster than HANDOFF_PACE_MAX walking steps whatever the direction: a turn (the node's draw still goes the old way for a
      // moment) is the sideways part plus the creep along the new key.
      const longest = HANDOFF_PACE_MAX * speed * dt * Math.sqrt(norm);
      const length = Math.hypot(stepX, stepY);
      if (length > longest) {
        stepX *= longest / length;
        stepY *= longest / length;
      }
      out.x += stepX;
      out.y += stepY;
    } else {
      // The node's draw, axis by axis as the engine steps (6 px on each axis of a diagonal): back at the walking pace, forward in the
      // direction last walked at HANDOFF_PACE_MAX, so a lag the player walks on with is caught up.
      const step = speed * dt;
      const heading = this.heading;
      // The node's draw behind the draw: the draw stays on that axis for HANDOFF_PACE_WAIT_MS from the key let go, while the node's draw is
      // coming to it (its last steps may pass the draw), and after it stood, instead of going back and forth.
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
