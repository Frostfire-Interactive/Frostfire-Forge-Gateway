// Going through a portal, as everyone on screen sees it: the player walks on up into the portal they step into, past
// its plane (the arch's foot, the line it stands on) into the opening, where they are drawn on its picture of the far
// side, and walks down out of the one they arrive at, from as deep in its opening, facing down, into where they stand;
// each of those portals flashes its inner trim as they pass its plane (core/portalfx.ts). The local player's camera
// keeps with them, so the cut between the two walks falls with the player and the arch where they were on screen: their
// walk in ends on the plane and their walk out starts on the far one, as far to the side, and between the two they
// are drawn standing there.
// Worked out from what the client already has: a player last seen in or just in front of a portal's rectangle who
// leaves the view or jumps away went in there; one who appears or lands at a portal's arrival spot came out of it.
// It is all drawing: where the server has a player is never moved.

import { PLAYER_FEET } from "./depthorder.js";
import { MOUNT_SPEED_MULTIPLIER, WALK_SPEED_PX_S } from "./handoffwalk.js";
import { ARCH_DEPTH, BACK_DEPTH, OPENING_HALF_WIDTH } from "./portalarch.js";

/** How long a portal's trim flash lasts, and how quickly it rises to full before falling back. */
export const PORTAL_FLASH_MS = 480;
const FLASH_RISE_MS = 70;
/** Players come out of a portal this far in front of (below) its rectangle, centred on it (engine systems/portalpairs.ts). */
export const ARRIVAL_GAP = 16;
/** How near a portal's rectangle (in it, or in front of it) a player last seen there must be to have gone in. Less than
 *  ARRIVAL_GAP, so someone who just came out and then logs off is not taken for going back in. */
export const TOUCH_REACH = 12;
/** How near an arrival spot a player who appears must be to have come out of that portal. */
export const ARRIVAL_REACH = 12;
/** How far from an arrival spot the local player may be when the next map is shown after going into a portal. */
export const LOCAL_ARRIVAL_REACH = 96;
/** A move this long between frames is a warp, not a step. */
export const JUMP_PX = 64;
/** For this long after a map is first seen, the players on it are just there: the map's own players, not arrivals. */
export const APPEAR_GRACE_MS = 1500;
/** The local player's arrival waits at most this long for the map to be shown. */
export const HOLD_MAX_MS = 6000;
/** A player who appears at most this long after the server said a portal put them there (cameThrough) came out of it. */
export const ARRIVED_MEMORY_MS = 3000;
/** The local player last seen touching a portal at most this long before their next map is on its way went into it,
 *  though they have left the world meanwhile (a node switch drops the world before the next map comes). */
export const TOUCH_MEMORY_MS = 3000;
/** A map shown at most this long before its first frame is seen is taken as shown on that frame. */
const REVEAL_RACE_MS = 1000;
/** How long after the black fade, or the loading screen, starts to lift the local player walks out: once it has mostly gone. */
export const SHOWN_AFTER_FADE_MS = 200, SHOWN_AFTER_LOADING_MS = 500;
/** The walk out of a portal slows to a stand over its last this many px, into where the player stands. */
export const STOP_EASE_PX = 6;
/** An arrival further than this in front of the portal's plane is not walked to: the player is just there. */
export const MAX_WALK_OUT_PX = 64;
/** After the walk out, the player is kept standing facing down this long (so the stand is posed), then let go. */
export const SETTLE_MS = 100;
/** How far either side of the arch's middle a player can stand in its opening (its half width less the player's). */
export const OPENING_REACH = OPENING_HALF_WIDTH - 12;
/** How far past a portal's plane the walk through goes, into the opening up to the arch's back: the walk in ends this
 *  deep, and the walk out of the far portal starts as deep in it. */
export const THROUGH_DEPTH = ARCH_DEPTH - BACK_DEPTH;

/** When, after the screen starts to lift, the map counts as shown. */
export function shownAfter(covered: "fade" | "loading" | null): number {
  return covered === "fade" ? SHOWN_AFTER_FADE_MS : covered === "loading" ? SHOWN_AFTER_LOADING_MS : 0;
}

type Point = { x: number; y: number };
// (times worked out from a distance and a speed land a hair either side of the end)
const EPS_MS = 1e-6;

/** A portal's trigger rectangle (map pixels, right and bottom exclusive), and whether stepping in takes anyone anywhere. */
export interface PortalRect { name: string; left: number; top: number; right: number; bottom: number; leads: boolean }

/** The map's portals (window.mapData.dungeonPortals: a list, or one keyed by name), on the map of this name. As the
 *  engine has it: a teleport with no place, or a dungeon portal linked to no dungeon outside a dungeon copy, leads nowhere.
 *  A dungeon's exit portal (a return portal, returnOf) stands only in its copies; the client is sent the template's name. */
export function portalRects(raw: unknown, mapName: string): PortalRect[] {
  if (!raw || typeof raw !== "object") return [];
  const inCopy = String(mapName ?? "").includes("~");
  return Object.entries(raw as Record<string, any>).map(([key, p]) => {
    const w = Number(p?.size?.width) || 32, h = Number(p?.size?.height) || 32;
    const left = Number(p?.position?.x) || 0, top = Number(p?.position?.y) || 0;
    const teleport = p?.kind === "teleport";
    const leads = teleport ? p?.target !== null : (p?.dungeonId != null && Number(p.dungeonId) > 0) || !!p?.returnOf || inCopy;
    return { name: String(p?.name ?? key), left, top, right: left + w, bottom: top + h, leads };
  });
}

/** The middle of a portal's arch (as core/portalpeek.ts portalsOnMap places it); its foot is the rectangle's bottom. */
const archX = (r: PortalRect): number => Math.round(r.left + (r.right - r.left) / 2);
const gap = (r: PortalRect, p: Point): number =>
  Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));

/** The portal a player last seen here went into: the nearest one whose rectangle they were in, or in front of within
 *  reach (not behind it: the arch's back is solid). */
export function portalWentInto(rects: readonly PortalRect[], p: Point, reach: number): PortalRect | null {
  let best: PortalRect | null = null, bestD = Infinity;
  for (const r of rects) {
    if (!r.leads || p.y < r.top) continue;
    const d = gap(r, p);
    if (d <= reach && d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/** Where players come out of a portal: in front of it, and (leaving a dungeon) its middle. */
export function arrivalSpots(r: PortalRect): [Point, Point] {
  const w = r.right - r.left, h = r.bottom - r.top;
  return [
    { x: r.left + Math.floor(w / 2), y: r.bottom + ARRIVAL_GAP },
    { x: Math.round(r.left + w / 2), y: Math.round(r.top + h / 2) },
  ];
}

/** The portal a player standing here came out of: the one with an arrival spot nearest them, within reach. */
export function cameOutOf(rects: readonly PortalRect[], p: Point, reach: number): PortalRect | null {
  let best: PortalRect | null = null, bestD = Infinity;
  for (const r of rects) {
    // (a portal that leads nowhere has no far side either: no one comes out of it)
    if (!r.leads) continue;
    for (const s of arrivalSpots(r)) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d <= reach && d < bestD) { best = r; bestD = d; }
    }
  }
  return best;
}

/** How fast a player walks, in px a millisecond: mounted (or a ghost) at the mount's pace. */
export function walkSpeed(fast: boolean): number {
  return (WALK_SPEED_PX_S * (fast ? MOUNT_SPEED_MULTIPLIER : 1)) / 1000;
}

/** A walk on into a portal (named `portal`, its plane at `foot`): from where the player was drawn to `depth` past its
 *  plane (THROUGH_DEPTH; the local player's ends on it), at walking pace, in `ms`; their feet pass the plane `plane` ms in. */
export interface WalkIn { portal: string; foot: number; from: Point; to: Point; at: number; ms: number; plane: number }

/** The walk into `r` from `from` (drawn), starting at `at`: straight through the plane, into the opening's middle part. */
export function walkInto(r: PortalRect, from: Point, at: number, speed: number, depth = THROUGH_DEPTH): WalkIn {
  const mid = archX(r);
  const to = { x: Math.min(mid + OPENING_REACH, Math.max(mid - OPENING_REACH, from.x)), y: r.bottom - depth - PLAYER_FEET };
  const d = from.y <= to.y ? 0 : Math.hypot(to.x - from.x, to.y - from.y);
  const ms = speed > 0 ? d / speed : 0;
  const plane = ms > 0 ? ms * Math.min(1, Math.max(0, (from.y + PLAYER_FEET - r.bottom) / (from.y - to.y))) : 0;
  return { portal: r.name, foot: r.bottom, from, to, at, ms, plane };
}

/** Where a walk into a portal ends: where the player is last drawn. */
export const walkInEnd = (w: WalkIn): Point => (w.ms > 0 ? w.to : w.from);

/** Where a walk into a portal draws the player now; null once it is over: they are gone. */
export function walkInAt(w: WalkIn, now: number): Point | null {
  const t = now - w.at;
  if (t >= w.ms - EPS_MS) return null;
  const k = Math.max(0, t) / w.ms;
  return { x: w.from.x + (w.to.x - w.from.x) * k, y: w.from.y + (w.to.y - w.from.y) * k };
}

/** How long a walk of `dist` px at `speed` that slows to a stand over its last STOP_EASE_PX takes. */
export function stopWalkMs(dist: number, speed: number): number {
  if (dist <= 0 || speed <= 0) return 0;
  const ease = Math.min(STOP_EASE_PX, dist);
  return (dist - ease) / speed + (2 * ease) / speed;
}

/** How far along such a walk the player is `t` ms in: at walking pace, then slowing evenly to a stand at `dist`. */
export function stopWalkAt(dist: number, speed: number, t: number): number {
  if (dist <= 0 || speed <= 0 || t <= 0) return 0;
  const ease = Math.min(STOP_EASE_PX, dist);
  const even = (dist - ease) / speed, slow = (2 * ease) / speed;
  if (t <= even) return speed * t;
  const u = Math.min(slow, t - even);
  return dist - ease + speed * u - (speed * u * u) / (2 * slow);
}

/** A walk out of a portal (named `portal`): drawn `off` from where the player stands at its start (`depth` past the
 *  portal's plane, in its opening), closing to nothing as they walk the `dist` px down into it. `foot` is the plane. */
export interface WalkOut { portal: string; at: number; foot: number; off: Point; dist: number; speed: number; ms: number }

/** The walk out of `r` to `target` (where the player stands), starting at `at` from `depth` past its plane, `side` px
 *  from the arch's middle (null: straight above `target`); null when the player does not stand in front of its opening
 *  near enough to walk there (leaving a dungeon puts them in the portal's middle, behind its plane). */
export function walkOutOf(r: PortalRect, target: Point, at: number, speed: number, depth = THROUGH_DEPTH, side: number | null = null): WalkOut | null {
  const out = target.y + PLAYER_FEET - r.bottom;
  if (out <= 0 || out > MAX_WALK_OUT_PX || Math.abs(target.x - archX(r)) > OPENING_HALF_WIDTH) return null;
  const off = { x: side === null ? 0 : archX(r) + side - target.x, y: -(out + depth) };
  const dist = Math.hypot(off.x, off.y);
  return { portal: r.name, at, foot: r.bottom, off, dist, speed, ms: stopWalkMs(dist, speed) };
}

/** Where a walk out draws the player, who stands at `actual`: at its start until it starts, in the opening until their
 *  feet pass the plane. */
export function walkOutAt(w: WalkOut, actual: Point, now: number): Point {
  const left = 1 - stopWalkAt(w.dist, w.speed, now - w.at) / w.dist;
  return { x: actual.x + w.off.x * left, y: actual.y + w.off.y * left };
}

/** The pose a walk out shows: walking down, then standing facing down. */
export function walkOutPose(w: WalkOut, now: number): "walk_down" | "idle_down" {
  return now - w.at < w.ms - EPS_MS ? "walk_down" : "idle_down";
}

/** How bright a portal's trim flash that started at `at` is now (0 to 1); none yet before `at`. */
export function flashLevel(at: number | undefined, now: number): number {
  if (at === undefined) return 0;
  const t = now - at;
  if (t < 0 || t >= PORTAL_FLASH_MS) return 0;
  if (t < FLASH_RISE_MS) return t / FLASH_RISE_MS;
  return (1 - (t - FLASH_RISE_MS) / (PORTAL_FLASH_MS - FLASH_RISE_MS)) ** 2;
}

/** A player as one frame sees them: where they are (x, y) and where they are drawn (dx, dy); ref is what draws them;
 *  fast when they walk at the mount's pace. */
export interface SeenPlayer<T> { id: string; x: number; y: number; dx: number; dy: number; ref: T; fast?: boolean }

/** Who is walking into or out of a portal and which portals are flashing, from the players seen frame by frame. */
export class TransitTracker<T> {
  private map: string | null = null;
  private mapSince = 0;
  private seen = new Map<string, SeenPlayer<T>>();
  // walks on into a portal, each drawn at its own place (its player may be gone, or drawn elsewhere after a jump)
  private walksIn: Array<{ id: string; ref: T; walk: WalkIn }> = [];
  private walksOut = new Map<string, WalkOut>();
  private flashes = new Map<string, number>();
  private portals: readonly PortalRect[] = [];
  private localId: string | null = null;
  // the local player went into a portal and their next map is on its way: not drawn where they stand; their walk in
  // ended at `spot` (drawn standing there by `ref` once it is over), `side` px from the arch's middle
  private gone: { at: number; spot: Point; ref: T; side: number } | null = null;
  // gone into a portal that put them elsewhere on this map: they wait in it until the ground round where they land is
  // there to be seen (landed), walking out no sooner than `after` (when their walk in ends)
  private landing: { after: number } | null = null;
  // on the next map, the local player waits for it to be shown (reveal) to walk out, `side` px from the arch's middle
  private held: { since: number; side: number | null } | null = null;
  private lastReveal = -Infinity;
  // when the server said a portal put each of these players where they are (cameThrough)
  private arrivals = new Map<string, number>();
  // the local player as last seen touching a portal, and when
  private touched: { at: number; prev: SeenPlayer<T> } | null = null;
  /** Counts the local player's trips through a portal (the keys held through one are let go first: HeldKeys). */
  warps = 0;

  private flash(r: PortalRect | null, at: number): void { if (r) this.flashes.set(r.name, at); }

  // `prev` (last seen there) walks on into `r`, from where they were drawn; the portal flashes as they pass its plane.
  // The local player's walk ends on the plane: the cut to the far side falls there.
  private goIn(prev: SeenPlayer<T>, r: PortalRect, now: number): WalkIn {
    const walk = walkInto(r, { x: prev.dx, y: prev.dy }, now, walkSpeed(!!prev.fast), prev.id === this.localId ? 0 : THROUGH_DEPTH);
    if (walk.ms > 0) this.walksIn.push({ id: prev.id, ref: prev.ref, walk });
    this.flash(r, now + walk.plane);
    return walk;
  }

  // `p` came out of `r`: they walk out of it from its plane down to where they stand, when that is in front of it.
  // The local player's walk starts on the plane, `side` px from the arch's middle as their walk in ended.
  private comeOut(p: SeenPlayer<T>, r: PortalRect, now: number, side: number | null = null): void {
    const local = p.id === this.localId;
    const walk = walkOutOf(r, p, now, walkSpeed(!!p.fast), local ? 0 : THROUGH_DEPTH, local ? side : null);
    if (walk) this.walksOut.set(p.id, walk);
    else this.walksOut.delete(p.id);
    this.flash(r, now);
  }

  /** One frame: the map, the time, the local player's id, the map's portals and every player in the client's world. */
  observe(input: { map: string; now: number; localId: string | null; portals: readonly PortalRect[]; players: readonly SeenPlayer<T>[] }): void {
    const { map, now, localId, portals, players } = input;
    this.portals = portals;
    this.localId = localId;
    if (map !== this.map) {
      const went = this.gone;
      this.map = map;
      this.mapSince = now;
      this.seen.clear();
      this.walksIn = [];
      this.walksOut.clear();
      this.flashes.clear();
      this.gone = null;
      this.landing = null;
      this.held = null;
      this.touched = null;
      for (const p of players) this.seen.set(p.id, p);
      // Only one who went into a portal walks out of one: one who logs in (or reconnects) there is just there.
      if (localId && went) {
        this.held = { since: now, side: went.side };
        if (this.lastReveal >= went.at) this.reveal(Math.max(now, this.lastReveal));
      }
      return;
    }
    if (this.held && now - this.held.since > HOLD_MAX_MS) this.reveal(now);
    const wasGone = this.gone !== null;
    // Gone into a portal, and the map shown again a while since (or never) with no other map seen: the next map was
    // this one. The local player is shown again here, walking out of a portal when at one.
    const back = this.gone && (now - this.gone.at > HOLD_MAX_MS || (this.lastReveal >= this.gone.at && now - this.lastReveal > REVEAL_RACE_MS));
    if (back) {
      this.held = { since: now, side: this.gone!.side };
      this.gone = null;
      this.landing = null;
      this.reveal(now);
    }

    // Just after a map change, those who appear, leave or jump are the map's players being sent, and the last map's
    // being dropped from where they stood there: none of it is a portal trip.
    const settled = now - this.mapSince > APPEAR_GRACE_MS;
    const present = new Set<string>();
    for (const p of players) {
      present.add(p.id);
      const prev = this.seen.get(p.id);
      this.seen.set(p.id, p);
      if (p.id === localId && portalWentInto(portals, p, TOUCH_REACH)) this.touched = { at: now, prev: p };
      if (!prev) {
        if (p.id === localId || !settled) continue;
        // (only one a portal put here: one who logs in or reconnects at its arrival spot is just there)
        const told = this.arrivals.get(p.id);
        this.arrivals.delete(p.id);
        if (told === undefined || now - told > ARRIVED_MEMORY_MS) continue;
        const from = cameOutOf(portals, p, ARRIVAL_REACH);
        if (from) this.comeOut(p, from, now);
        continue;
      }
      if (!settled || Math.hypot(p.x - prev.x, p.y - prev.y) <= JUMP_PX) continue;
      // A warp on the map: onto an arrival spot they walk out. From a portal they walk on into it first, and walk out
      // of the far one once that is over (not drawn there until then).
      const into = portalWentInto(portals, prev, TOUCH_REACH);
      const from = cameOutOf(portals, p, p.id === localId && into ? LOCAL_ARRIVAL_REACH : ARRIVAL_REACH);
      const walkIn = into ? this.goIn(prev, into, now) : null;
      // The local player's: far off, the ground where they land is still to be loaded. They wait in the portal they
      // went into (gone) until it is there (landed), and then walk out. (Gone already, the next map is on its way.)
      if (walkIn && p.id === localId && !wasGone) {
        this.walksOut.delete(p.id);
        const end = walkInEnd(walkIn);
        this.gone = { at: now, spot: end, ref: p.ref, side: end.x - archX(into!) };
        this.landing = { after: now + walkIn.ms };
        this.warps++;
        continue;
      }
      if (from) this.comeOut(p, from, now + (walkIn?.ms ?? 0));
      else this.walksOut.delete(p.id);
      if (into && p.id === localId) this.warps++;
    }
    for (const [id, prev] of this.seen) {
      if (present.has(id)) continue;
      this.seen.delete(id);
      this.walksOut.delete(id);
      if (!settled || id === localId) continue;
      const into = portalWentInto(portals, prev, TOUCH_REACH);
      if (into) this.goIn(prev, into, now);
    }
    this.walksIn = this.walksIn.filter((w) => walkInAt(w.walk, now) !== null);
    for (const [id, w] of this.walksOut) if (now - w.at >= w.ms + SETTLE_MS - EPS_MS) this.walksOut.delete(id);
  }

  /** The local player's next map is on its way: one by a portal walks on into it, and is not drawn where they stand. */
  mapLoading(now: number): void {
    const id = this.localId;
    const touched = this.touched && now - this.touched.at <= TOUCH_MEMORY_MS ? this.touched.prev : undefined;
    const me = id ? this.seen.get(id) ?? touched : undefined;
    const into = me ? portalWentInto(this.portals, me, TOUCH_REACH) : null;
    if (!me || !into || this.gone) return;
    this.walksOut.delete(me.id);
    const end = walkInEnd(this.goIn(me, into, now));
    this.gone = { at: now, spot: end, ref: me.ref, side: end.x - archX(into) };
    this.warps++;
  }

  /** Where the local player lands, waiting in the portal they went into on this map for the ground there to be loaded;
   *  null when they are not. */
  landingSpot(): Point | null {
    const me = this.landing && this.gone && this.localId ? this.seen.get(this.localId) : undefined;
    return me ? { x: me.x, y: me.y } : null;
  }

  /** The ground where the local player lands is there to be seen (from `now`): they walk out of the far portal once
   *  their walk in is over. */
  landed(now: number): void {
    const l = this.landing;
    if (!l || !this.gone) return;
    this.landing = null;
    this.held = { since: now, side: this.gone.side };
    this.gone = null;
    this.reveal(Math.max(now, l.after));
  }

  /** How long the local player's walk on into a portal has still to go. */
  walkInLeft(now: number): number {
    let left = 0;
    for (const w of this.walksIn) if (w.id === this.localId) left = Math.max(left, w.walk.at + w.walk.ms - now);
    return left;
  }

  /** Where the camera looks for the local player, drawn at `drawn` now: along their walk through a portal, so the
   *  player and the arch stay put on screen from the last of the walk in to the first of the walk out. */
  cameraAt(now: number, drawn: Point): Point {
    const id = this.localId;
    if (!id) return drawn;
    const out = this.walksOut.get(id);
    if (out && now >= out.at) return walkOutAt(out, drawn, now);
    for (let i = this.walksIn.length - 1; i >= 0; i--) {
      const w = this.walksIn[i]!;
      if (w.id === id && now - w.walk.at < w.walk.ms) return walkInAt(w.walk, now) ?? walkInEnd(w.walk);
    }
    if (out) return walkOutAt(out, drawn, out.at);
    if (this.gone) return this.gone.spot;
    if (this.held) {
      const me = this.seen.get(id);
      const from = me ? cameOutOf(this.portals, me, LOCAL_ARRIVAL_REACH) : null;
      const walk = from ? walkOutOf(from, drawn, now, 1, 0, this.held.side) : null;
      if (walk) return walkOutAt(walk, drawn, now);
    }
    return drawn;
  }

  /** The map is shown (the screen lifts, from `now`): the local player who came out of a portal walks out of it. */
  reveal(now: number): void {
    this.lastReveal = now;
    const id = this.localId;
    if (!id || this.gone || !this.held) return;
    const me = this.seen.get(id);
    const from = me ? cameOutOf(this.portals, me, LOCAL_ARRIVAL_REACH) : null;
    const side = this.held.side;
    this.held = null;
    if (me && from) this.comeOut(me, from, now, side);
  }

  /** The players a trip through a portal draws now (walking in, waiting between, walking out): a portal's picture of
   *  the far side, where the server already has them, does not show them again. */
  travellers(): Set<string> {
    const ids = new Set<string>();
    for (const w of this.walksIn) ids.add(w.id);
    for (const id of this.walksOut.keys()) ids.add(id);
    if (this.localId && (this.gone || this.held)) ids.add(this.localId);
    return ids;
  }

  /** Where the local player stands between their walk in and their walk out, drawn standing (steerWaitPose, keyed by
   *  `key`): where the walk in ended while the far ground loads, then where the walk out starts until the map is shown;
   *  null when they are not waiting, or are drawn on a walk. */
  waitingAt(now: number): { ref: T; x: number; y: number; key: object } | null {
    const id = this.localId;
    if (!id) return null;
    if (this.gone) {
      if (this.walksIn.some((w) => w.id === id && walkInAt(w.walk, now) !== null)) return null;
      return { ref: this.gone.ref, x: this.gone.spot.x, y: this.gone.spot.y, key: this.gone };
    }
    const me = this.held ? this.seen.get(id) : undefined;
    if (!me || !this.held) return null;
    const at = this.cameraAt(now, { x: me.dx, y: me.dy });
    return { ref: me.ref, x: at.x, y: at.y, key: this.held };
  }

  /** The server says a portal has just put this player where they are: one who appears there walks out of it. */
  cameThrough(id: string, now: number): void {
    this.arrivals.set(id, now);
    for (const [k, at] of this.arrivals) if (now - at > ARRIVED_MEMORY_MS) this.arrivals.delete(k);
  }

  /** Where to draw a player who is drawn at `drawn` now: there, or on their walk out of a portal; null when not at all
   *  (gone into a portal, waiting to be shown on the next map, or their walk out not started yet). */
  drawnAt(id: string, now: number, drawn: Point): Point | null {
    if (id === this.localId && (this.gone || this.held)) return null;
    const w = this.walksOut.get(id);
    if (!w) return drawn;
    return now < w.at ? null : walkOutAt(w, drawn, now);
  }

  /** The walk out of a portal the player is on, if any (its pose: walkOutPose). */
  walkOutOf(id: string): WalkOut | undefined {
    return this.walksOut.get(id);
  }

  /** Those walking on into a portal, where each is drawn now, and the portal (its name, and its plane at `foot`); `walk`
   *  is the walk (its pose: steerWalkInPose). */
  walkersAt(now: number): Array<{ id: string; ref: T; x: number; y: number; portal: string; foot: number; walk: WalkIn }> {
    const out: Array<{ id: string; ref: T; x: number; y: number; portal: string; foot: number; walk: WalkIn }> = [];
    for (const w of this.walksIn) {
      const at = walkInAt(w.walk, now);
      if (at) out.push({ id: w.id, ref: w.ref, x: at.x, y: at.y, portal: w.walk.portal, foot: w.walk.foot, walk: w.walk });
    }
    return out;
  }

  /** How bright the named portal's trim flash is now (0 to 1). */
  flashOf(name: string, now: number): number {
    return flashLevel(this.flashes.get(name), now);
  }
}

/** The keys (and the stick) held through a portal: they do not walk on the far side until let go, so the player
 *  stands there facing down, not walking straight back up into the portal they came out of. */
export class HeldKeys {
  private keys = new Set<string>();
  private stick = false;

  /** A trip through a portal: the keys held now, and whether the stick is held, are let go first. */
  hold(keys: Iterable<unknown>, stickHeld: boolean): void {
    this.keys = new Set(Array.from(keys, String));
    this.stick = stickHeld;
  }

  /** The keys pressed now that walk: those not held through a portal since. A held key let go walks again. */
  free(pressed: Iterable<unknown>): Set<string> {
    const now = new Set(Array.from(pressed, String));
    for (const k of this.keys) if (!now.has(k)) this.keys.delete(k);
    return this.keys.size ? new Set([...now].filter((k) => !this.keys.has(k))) : now;
  }

  /** Whether the stick, held or not now, walks: not while it is still held from before a trip through a portal. */
  stickFree(held: boolean): boolean {
    if (!held) this.stick = false;
    return !this.stick;
  }
}

/* The game's one tracker and key hold, and posing a player on a walk out. */

export const transit = new TransitTracker<any>();
export const heldThroughWarp = new HeldKeys();

const steered = new WeakMap<object, { anim: any; set: string | null; yielded: boolean }>();
// Poses a player on a walk (keyed by the walk) facing `facing`. A pose someone else gives them meanwhile wins, and the
// walk no longer poses them; an animation built anew is posed again.
function steerPose(p: any, walk: object, pose: string, facing: string, change: (anim: any, name: string) => unknown): void {
  const anim = p?.layeredAnimation;
  if (!anim) return;
  let s = steered.get(walk);
  if (!s) steered.set(walk, (s = { anim, set: null, yielded: false }));
  if (s.yielded) return;
  if (s.anim === anim && s.set !== null && anim.currentAnimationName !== s.set) { s.yielded = true; return; }
  s.anim = anim;
  s.set = pose;
  p.lastDirection = facing;
  if (anim.currentAnimationName !== pose) {
    p.animation = null;
    void change(anim, pose);
  }
}

/**
 * Poses a player on their walk out of a portal: walking down, then standing facing down. A pose someone else gives
 * them meanwhile (the server's, as they walk off) wins, and the walk no longer poses them. An animation built anew
 * (a self spawn's) is posed again.
 */
export function steerWalkOutPose(p: any, walk: WalkOut, now: number, change: (anim: any, name: string) => unknown): void {
  steerPose(p, walk, walkOutPose(walk, now), "down", change);
}

/**
 * Poses a player on their walk on into a portal: walking up into it, whatever they were left showing as they went
 * (gone from the world, or stopped by the server first, they are posed by nothing else). A pose someone else gives
 * them meanwhile wins, as on a walk out.
 */
export function steerWalkInPose(p: any, walk: WalkIn, change: (anim: any, name: string) => unknown): void {
  steerPose(p, walk, "walk_up", "up", change);
}

/** Poses the local player waiting between their walk in and their walk out (TransitTracker.waitingAt): standing
 *  facing up, as their walk in left them. A pose someone else gives them meanwhile wins, as on a walk. */
export function steerWaitPose(p: any, key: object, change: (anim: any, name: string) => unknown): void {
  steerPose(p, key, "idle_up", "up", change);
}
