// Fishing (engine src/systems/fishing). USER REQUEST 2026-10-20: "Click on water tile to cast to location (use bobber
// (white circle for now as a placeholder)) and black string similar to how it looks in Terraria with actual physics.
// Bobber should go down when fish has taken the bait. Reel system with no skill effort required. Fish should randomly
// pull back but not out of water tiles. When close enough to the player fish should be yanked up and added to
// inventory as an item".
//
// The server says which tiles are fishable (FISHING_TILES: tileset key -> tile ids, set in the map editor's Fishing
// tab). A click on one asks to cast there (FISH_CAST); the server checks, and tells everyone on the map (FISHING):
// "cast" (the bobber flies out and floats at x, y), "bite" (it goes under), "catch" (the fish is yanked out) and "end"
// (the line is taken in: a step, damage, another map). While a fish is on, holding the mouse button (or a finger)
// down reels it in; the fish pulls the other way now and then, but never off the water. Once the bobber reaches the
// shore near the player, the client says so (FISH_LAND) and the server puts the fish in the bags.
//
// The line is a rope of points moved by Verlet integration: gravity pulls it down the screen (the sag of a line seen
// from the side, as Terraria draws it), its two ends are pinned to the rod tip and the bobber, and its length gives
// it slack while the bobber floats and none while it is reeled.
import { sendRequest, cachedPlayerId } from "./socket.js";
import { tilesetKey } from "./tilesounds.js";
import { config } from "../web/global.js";
import { clearWater, pokeWater, stepAndDrawWater, waterActive } from "./fishwater.js";

/** px: the engine's FISH_RANGE. */
export const FISH_RANGE = 256;
/** s: a fish must be on this long before it is landed (a little over the engine's MIN_REEL_MS). */
const MIN_LAND_S = 1.3;
/** px/s: how fast the reel pulls the bobber in, and how hard a fish pulls back (from, to). */
const REEL_SPEED = 60, PULL_MIN = 45, PULL_MAX = 85;
/** px: how much line a fish can pull back out past the closest the reel has brought it. */
const PULL_BACK = 40;
/** s: the time between two pulls of the fish (from, to) and how long one lasts (from, to). */
const PULL_GAP_MIN = 0.3, PULL_GAP_MAX = 1.0, PULL_LEN_MIN = 0.4, PULL_LEN_MAX = 1.0;
/** px: closer than this to the player's feet the fish comes out; and within this, a bobber blocked by the shore does. */
const LAND_DISTANCE = 36, SHORE_DISTANCE = 220;
/** s: reeled against land this long, the fish comes out wherever it is; a land not answered is sent again after this. */
const STUCK_S = 1.5, LAND_RETRY_S = 3;
/** The rope: its segments, the gravity on it (px/s²), how much speed each point keeps, and its passes of constraints. */
const SEGMENTS = 16, GRAVITY = 520, DAMPING = 0.985, PASSES = 8;
/** How much longer than the straight line the rope is: floating, with a fish on, reeled. */
const SLACK_FLOAT = 1.16, SLACK_BITE = 1.05, SLACK_REEL = 1.0;
/** The rod tip above the player's position (px) when no staff frame says where it is, and the yank out of the water (s). */
const TIP_UP = 20, TIP_OUT = 11, YANK_S = 0.55;
/** px/s: how fast the reel draws in a line with no fish on it; s: how long the bobber takes from the water to the rod. */
const REEL_EMPTY_SPEED = 120, RETRIEVE_S = 0.35;
/** s: how long a cast waits for the staff to be in hand before the bobber leaves anyway. */
const POSE_WAIT_S = 0.8;
/**
 * The water (fishwater.ts simulates its waves): how hard a touch of size 1 pushes it down, how flat it is seen (as
 * fishwater.ts SQUASH: a drop's throw is flattened by it), the most drops of splashes in the air at once, the gravity on
 * a drop (px/s²), and how far the bobber goes between two pushes of its wake (px).
 */
const POKE = 9, WATER_TILT = 0.6, DROPS_KEPT = 60, DROP_GRAVITY = 260, WAKE_STEP = 2;
/** A player wading through the water: how far they go between two pushes of their wake (px), how hard each is (as a
 * ripple's size: 1 is a bobber settling), and how long standing in it goes between two rings round their legs (s). */
const WADE_STEP = 4, WADE_SIZE = 0.8, WADE_IDLE_S = 1.3;
/** The player's feet below their position (tilesounds.ts FEET_Y): where the fish is reeled to. */
const FEET_Y = 16;

const GID_MASK = 0x1fffffff;

type Point = { x: number; y: number };
interface RopePoint { x: number; y: number; ox: number; oy: number }
/** A drop of water thrown up by a splash: on the water at (x, y), `z` px above it. */
interface Drop { x: number; y: number; z: number; vx: number; vy: number; vz: number }
interface Line {
  id: string;
  state: "flying" | "floating" | "bite" | "landing" | "catch" | "retrieving";
  /** Where the bobber floats now (on the water). */
  bob: Point;
  /** The flight out: from the rod tip (set on the first frame), how far along (s), and for how long. */
  fly: { from: Point | null; to: Point; t: number; dur: number } | null;
  /** s since the fish bit, and when (in those s) FISH_LAND was last sent. */
  biteAge: number;
  landAt: number;
  /** The reel has begun on the fish that bit: this client sent FISH_REEL (its own line), or the server said so (another's). */
  reeled: boolean;
  /** How deep the bobber is under (0 to 1). */
  sink: number;
  pull: { x: number; y: number; left: number } | null;
  nextPull: number;
  /** px: how far from the player's feet the line lets the bobber go (0 until the fish bites). */
  reach: number;
  stuck: number;
  rope: RopePoint[];
  /** s till the bobber next stirs the water by itself, and where it last pushed its wake. */
  rippleIn: number;
  wakeAt: Point | null;
  /** The fish on its way out of the water: from where, how far along (s), its icon, and the item it is. */
  yank: { from: Point; t: number; icon: HTMLImageElement | null; item: string; quality: unknown } | null;
  /** The line taken in with no fish: the bobber out of the water, from where, and how far along (s). */
  retrieve: { from: Point; t: number } | null;
  /** Where the staff's tip was from the player, the last time a cast frame said: kept once the pose is gone. */
  tipOffset: Point | null;
  /** s the line has been drawn: the bobber's bob. */
  age: number;
}

const lines = new Map<string, Line>();
/** Drops of splashes in the air, of every line. */
const drops: Drop[] = [];

/** A line is gone (in, or its fish out): the waves it made stay on the water (fishwater.ts) until they settle. */
function dropLine(line: Line): void {
  lines.delete(line.id);
}
/** tileset key -> the fishable tile ids in it, as the server sent them. */
let fishable = new Map<string, Set<number>>();
let fishableRev = 0;
let gidTable: { tilesets: any[] | null; rev: number; gids: Set<number> } = { tilesets: null, rev: -1, gids: new Set() };
/** The mouse button or a finger is down on the game: the reel turns. */
let reeling = false;
const images = new Map<string, HTMLImageElement>();

function imageOf(url: string | null | undefined): HTMLImageElement | null {
  if (!url) return null;
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img;
}

/** Which tiles are fishable (FISHING_TILES): sent at login and after every save in the map editor. */
export function setFishingTiles(data: any): void {
  const next = new Map<string, Set<number>>();
  const sets = data?.tilesets && typeof data.tilesets === "object" ? data.tilesets : {};
  for (const [key, ids] of Object.entries(sets)) {
    if (Array.isArray(ids) && ids.length) next.set(String(key).toLowerCase(), new Set(ids.map(Number)));
  }
  fishable = next;
  fishableRev++;
}

/** The fishable gids of the map this client is on (rebuilt when the map or the list changes). */
function fishableGids(): Set<number> {
  const tilesets = window.mapData?.tilesets ?? null;
  if (gidTable.tilesets === tilesets && gidTable.rev === fishableRev) return gidTable.gids;
  const gids = new Set<number>();
  for (const ts of tilesets ?? []) {
    for (const id of fishable.get(tilesetKey(ts)) ?? []) gids.add(Number(ts.firstgid) + id);
  }
  gidTable = { tilesets, rev: fishableRev, gids };
  return gids;
}

/**
 * Whether a world point (px) is on a fishable tile: one of the tiles drawn there (every layer but collision and
 * no-pvp) is, as the server reads it. A tile of a chunk not loaded is not.
 */
export function isFishableAt(x: number, y: number): boolean {
  const gids = fishableGids();
  const map = window.mapData;
  if (!gids.size || !map?.loadedChunks) return false;
  const tw = map.tilewidth || 16, th = map.tileheight || 16, size = Number(map.chunkSize) || 0;
  if (!size || x < 0 || y < 0) return false;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th), cx = Math.floor(tx / size), cy = Math.floor(ty / size);
  const chunk: any = map.loadedChunks.get(`${cx}-${cy}`);
  if (!chunk?.layers) return false;
  const lx = tx - cx * size, ly = ty - cy * size, w = Number(chunk.width) || size;
  if (lx >= w || ly >= (Number(chunk.height) || size)) return false;
  for (const layer of chunk.layers) {
    if (!layer?.data || /collision|nopvp/i.test(String(layer.name ?? ""))) continue;
    if (gids.has(layer.data[ly * w + lx] & GID_MASK)) return true;
  }
  return false;
}

/**
 * The shore, to the pixel, for the waves (fishwater.ts). A shore tile is drawn half rock and half water (USER REPORT
 * 2026-10-20: "The water edges contain ground tile", and the waves stopped short of the rocks, at the tile's edge), so
 * whole tiles cannot say where the water ends. A point is water when the topmost pixel drawn there (every layer but
 * collision and no-pvp; a see-through pixel shows the layer under it) is of a fishable tile, or is the colour of one: the
 * water a shore tile shows between its rocks is drawn in the same colours as the water tiles.
 */
export function isWaterPixel(x: number, y: number): boolean {
  const gids = fishableGids();
  const map = window.mapData;
  if (!gids.size || !map?.loadedChunks) return false;
  const tw = map.tilewidth || 16, th = map.tileheight || 16, size = Number(map.chunkSize) || 0;
  if (!size || x < 0 || y < 0) return false;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th), cx = Math.floor(tx / size), cy = Math.floor(ty / size);
  const chunk: any = map.loadedChunks.get(`${cx}-${cy}`);
  if (!chunk?.layers) return false;
  const lx = tx - cx * size, ly = ty - cy * size, w = Number(chunk.width) || size;
  if (lx >= w || ly >= (Number(chunk.height) || size)) return false;
  const colours = waterColours();
  const px = Math.floor(x) - tx * tw, py = Math.floor(y) - ty * th;
  for (const layer of topFirst(chunk)) {
    const raw = Number(layer.data[ly * w + lx]) >>> 0, gid = raw & GID_MASK;
    if (!gid) continue;
    if (gids.has(gid)) return true;
    const rgba = tilePixel(gid, raw, px, py);
    // a see-through pixel, or a picture not read (yet): the layer under it decides
    if (!rgba || rgba[3]! < 128) continue;
    return colours.has(colourKey(rgba[0]!, rgba[1]!, rgba[2]!));
  }
  return false;
}

/** A chunk's tile layers, topmost first (by zIndex, then as listed), but collision and no-pvp: worked out once a chunk. */
const layerOrder = new WeakMap<object, any[]>();
function topFirst(chunk: any): any[] {
  let order = layerOrder.get(chunk);
  if (!order) {
    order = (chunk.layers as any[])
      .map((layer, at) => ({ layer, at }))
      .filter(({ layer }) => layer?.data && !/collision|nopvp/i.test(String(layer.name ?? "")))
      .sort((a, b) => (Number(b.layer.zIndex) || 0) - (Number(a.layer.zIndex) || 0) || b.at - a.at)
      .map(({ layer }) => layer);
    layerOrder.set(chunk, order);
  }
  return order;
}

/** A colour, its lowest bits dropped: the water's colours are matched a little loosely. */
const colourKey = (r: number, g: number, b: number) => ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);

/** The pixels of a tileset picture, read once (null when it cannot be read). */
const tilesetPixels = new WeakMap<object, ImageData | null>();
function pixelsOf(image: any): ImageData | null {
  if (!image || !(image.naturalWidth || image.width)) return null;
  if (tilesetPixels.has(image)) return tilesetPixels.get(image)!;
  let data: ImageData | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    // a picture that may not be read: its tiles count as land
  }
  tilesetPixels.set(image, data);
  return data;
}

/** The tileset a gid is drawn from (the one with the highest firstgid not above it), with its index in the map's list. */
function tilesetFor(gid: number): { ts: any; index: number } | null {
  const tilesets: any[] = window.mapData?.tilesets ?? [];
  let best: { ts: any; index: number } | null = null;
  tilesets.forEach((ts, index) => {
    const first = Number(ts?.firstgid);
    if (first <= gid && (!best || first > Number(best.ts.firstgid))) best = { ts, index };
  });
  return best;
}

/** The pixel (r, g, b, a) at (px, py) of a tile as it is drawn: `raw` is the gid with its flip bits. */
function tilePixel(gid: number, raw: number, px: number, py: number): Uint8ClampedArray | null {
  const found = tilesetFor(gid);
  if (!found) return null;
  const { ts, index } = found;
  const data = pixelsOf(window.mapData?.images?.[index]);
  if (!data) return null;
  const tw = Number(ts.tilewidth) || 16, th = Number(ts.tileheight) || 16;
  const margin = Number(ts.margin) || 0, spacing = Number(ts.spacing) || 0;
  const columns = Number(ts.columns) || Math.max(1, Math.floor((data.width - margin * 2 + spacing) / (tw + spacing)));
  const id = gid - Number(ts.firstgid);
  // Tiled's flips: the diagonal first, then across, then down
  let u = px, v = py;
  if (raw & 0x20000000) [u, v] = [v, u];
  if (raw & 0x80000000) u = tw - 1 - u;
  if (raw & 0x40000000) v = th - 1 - v;
  const sx = margin + (id % columns) * (tw + spacing) + u, sy = margin + Math.floor(id / columns) * (th + spacing) + v;
  if (sx < 0 || sy < 0 || sx >= data.width || sy >= data.height) return null;
  const o = (sy * data.width + sx) * 4;
  return data.data.subarray(o, o + 4);
}

let colourTable: { tilesets: any[] | null; rev: number; colours: Set<number> } = { tilesets: null, rev: -1, colours: new Set() };
/** Every colour the fishable tiles of the map are drawn in: what water looks like here (rebuilt when either changes). */
function waterColours(): Set<number> {
  const map = window.mapData, tilesets = map?.tilesets ?? null;
  if (colourTable.tilesets === tilesets && colourTable.rev === fishableRev && colourTable.colours.size) return colourTable.colours;
  const colours = new Set<number>();
  let unread = false;
  (tilesets ?? []).forEach((ts: any, index: number) => {
    const ids = fishable.get(tilesetKey(ts));
    if (!ids?.size) return;
    const data = pixelsOf(map?.images?.[index]);
    if (!data) {
      unread = true;
      return;
    }
    const tw = Number(ts.tilewidth) || 16, th = Number(ts.tileheight) || 16;
    for (const id of ids) {
      const gid = Number(ts.firstgid) + id;
      for (let v = 0; v < th; v++) {
        for (let u = 0; u < tw; u++) {
          const rgba = tilePixel(gid, gid, u, v);
          if (rgba && rgba[3]! >= 200) colours.add(colourKey(rgba[0]!, rgba[1]!, rgba[2]!));
        }
      }
    }
  });
  // a picture not loaded yet: asked again next time
  colourTable = { tilesets: unread ? null : tilesets, rev: fishableRev, colours };
  return colours;
}

/** Whether this client's own line is out (a click is the reel then, not a cast or a pick). */
function ownLineOut(): boolean {
  return !!cachedPlayerId && lines.has(String(cachedPlayerId));
}

/**
 * A click or a tap on the world (events.ts): taken here when it is the reel, or a cast at a fishable tile (the server
 * says when it is too far, or the player cannot fish now). Returns whether it was taken. While the line is out a press
 * only turns the reel: to cast somewhere else, the line is reeled in first (USER REQUEST 2026-10-20: "you should be
 * able to reel the line in even if a fish isn't on it ... more realistic than left click and it disappears").
 */
export function fishingClick(worldX: number, worldY: number): boolean {
  // (USER REPORT 2026-10-20: "after a full reel, letting go of the left mouse button, it auto casts again") the click
  // that ends a press is the reel's even when the line came in while the button was held: it never casts
  if (ownLineOut() || pressReeled) {
    pressReeled = false;
    return true;
  }
  if (!isFishableAt(worldX, worldY)) return false;
  sendRequest({ type: "FISH_CAST", data: { x: Math.floor(worldX), y: Math.floor(worldY) } });
  return true;
}

/** The press now held down began with the line out: it is the reel's, and its click casts nothing. */
let pressReeled = false;

/** The reel turns while the mouse button or a finger is held down on the game (not on its windows and bars). */
export function installFishingInput(): void {
  document.addEventListener("pointerdown", (e) => {
    pressReeled = false;
    if (e.button !== 0 || (e.target as HTMLElement)?.closest?.(".ui")) return;
    reeling = true;
    pressReeled = ownLineOut();
  });
  const stop = () => { reeling = false; };
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
}

function newRope(at: Point): RopePoint[] {
  return Array.from({ length: SEGMENTS + 1 }, () => ({ x: at.x, y: at.y, ox: at.x, oy: at.y }));
}

/**
 * The water is touched at the bobber (or at `at`): `size` 1 is the bobber settling, more is a splash, less a drop or a
 * stir. The wave simulation (fishwater.ts) does the rest.
 */
function ripple(line: { bob: Point }, size = 1, opts: { at?: Point } = {}): void {
  const at = opts.at ?? line.bob;
  pokeWater(at.x, at.y, size * POKE, 0.7 + size * 0.9, isWaterPixel);
}

/** A splash: drops thrown up and out from the bobber (or `at`), each ringing the water where it falls back. */
function splash(line: { bob: Point }, count: number, strength = 1, at: Point = line.bob): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2, out = rand(8, 26) * strength;
    drops.push({
      x: at.x, y: at.y, z: 1,
      vx: Math.cos(angle) * out, vy: Math.sin(angle) * out * WATER_TILT, vz: rand(28, 62) * strength,
    });
  }
  if (drops.length > DROPS_KEPT) drops.splice(0, drops.length - DROPS_KEPT);
}

/** A FISHING packet: a line cast, a bite, a catch, or the line taken in. */
export function applyFishing(data: any): void {
  const id = String(data?.id ?? "");
  if (!id) return;
  const line = lines.get(id);
  switch (data?.state) {
    case "cast": {
      const to = { x: Number(data.x), y: Number(data.y) };
      if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;
      lines.set(id, {
        id, state: "flying", bob: { ...to }, fly: { from: null, to, t: 0, dur: 0.4 }, biteAge: 0, landAt: 0, reeled: false,
        sink: 0, pull: null, nextPull: PULL_GAP_MIN, reach: Infinity, stuck: 0, rope: [], rippleIn: 1, wakeAt: null, yank: null,
        retrieve: null, tipOffset: line?.tipOffset ?? null, age: 0,
      });
      break;
    }
    case "bite": {
      if (!line || line.state === "catch" || line.state === "retrieving") return;
      // a bite that comes while the bobber still flies lands it first
      line.fly = null;
      line.state = "bite";
      line.biteAge = 0;
      line.reeled = false;
      line.reach = Infinity;
      line.nextPull = 0.25;
      // pulled under: a splash, and the water rings out from it
      splash(line, 7, 0.8);
      ripple(line, 1.6);
      ripple(line, 0.9);
      break;
    }
    case "reel":
      if (line && line.state === "bite") line.reeled = true;
      break;
    case "escape": {
      // not reeled in time (the engine's BITE_ESCAPE_MS): the fish let go, the bobber comes up, and the line stays out
      if (!line || (line.state !== "bite" && line.state !== "landing")) return;
      line.state = "floating";
      line.biteAge = 0;
      line.reeled = false;
      line.pull = null;
      line.reach = Infinity;
      line.stuck = 0;
      splash(line, 4, 0.6);
      ripple(line, 1.2);
      break;
    }
    case "catch": {
      if (!line) return;
      line.state = "catch";
      line.fly = null;
      line.yank = { from: { ...line.bob }, t: 0, icon: imageOf(data.icon), item: String(data.item ?? ""), quality: data.quality };
      splash(line, 12, 1.2);
      ripple(line, 1.8);
      break;
    }
    case "end":
      // the line is taken in: the bobber comes out of the water to the rod, not gone at once
      if (line) retrieveLine(line);
      break;
  }
}

/** Start taking a line in with no fish on it: the bobber flies from where it is to the rod tip. */
function retrieveLine(line: Line): void {
  if (line.state === "retrieving" || line.state === "catch") return;
  const from = line.fly?.from ? flightPoint(line.fly) : { ...line.bob };
  line.state = "retrieving";
  line.fly = null;
  line.retrieve = { from, t: 0 };
  // lifted out of the water: a few drops, and a ring where it was
  splash(line, 4, 0.6);
  ripple(line, 1.1);
}

/** Where a bobber in flight is now: along its arc from the rod to the water. */
function flightPoint(fly: NonNullable<Line["fly"]>): Point {
  const from = fly.from ?? fly.to;
  const k = Math.min(fly.t / fly.dur, 1);
  const arc = 18 + Math.hypot(fly.to.x - from.x, fly.to.y - from.y) * 0.3;
  return { x: from.x + (fly.to.x - from.x) * k, y: from.y + (fly.to.y - from.y) * k - Math.sin(Math.PI * k) * arc };
}

/** Loading a map takes every line away; the server sends those still out again. */
export function clearFishing(): void {
  lines.clear();
  drops.length = 0;
  clearWater();
  waders.clear();
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * Where the staff's tip is in each frame of the cast poses, px in the 64 x 64 frame, by pose and facing (the diagonals
 * use down and up): measured from the asset server's armor/weapon/wooden staff.png, at the very end of its forked
 * head (USER REPORT 2026-10-20: left and right, the line left "before" the tip, from the inner fork). Facing up the staff
 * is behind the body, so the line leaves above the right shoulder, where the staff stands in the walk.
 */
const STAFF_TIPS: Record<string, Array<[number, number]>> = {
  cast_idle_down: [[24, 38]],
  cast_idle_up: [[42, 15]],
  cast_idle_left: [[15, 19]],
  cast_idle_right: [[48, 19]],
  cast_walk_down: [[25, 21], [24, 38], [25, 21]],
  cast_walk_up: [[42, 15], [42, 15], [42, 15]],
  cast_walk_left: [[22, 17], [15, 19], [22, 17]],
  cast_walk_right: [[41, 17], [48, 19], [41, 17]],
};

/**
 * The tip of the staff in the frame of a player drawn now, placed as player.ts draws the frame; null while they are
 * not in a cast pose with its frames loaded (the pose comes in its own packet, and its sprite sheets load after it).
 */
function staffTip(p: any): Point | null {
  const at = p.renderPosition ?? p.position;
  const anim = p.layeredAnimation;
  const pose = String(anim?.currentAnimationName ?? "").replace(/_(down|up)(left|right)$/, "_$1");
  const tips = STAFF_TIPS[pose];
  const layer = anim?.layers?.armor_weapon ?? anim?.layers?.body;
  if (!tips || !layer?.frames?.length) return null;
  const i = (Number(layer.currentFrame) || 0) % layer.frames.length;
  const frame = layer.frames[i];
  const [tx, ty] = tips[Math.min(i, tips.length - 1)]!;
  return {
    x: Math.round(at.x - (frame?.width ?? 64) / 2 + (frame?.offset?.x ?? 0)) + tx,
    y: Math.round(at.y - (frame?.height ?? 64) / 2 + (frame?.offset?.y ?? 0)) + ty,
  };
}

/**
 * The rod tip of a player: the tip of the staff in the frame drawn now, placed as player.ts draws the frame. Once the
 * pose is gone (the line taken in, the fish caught: the server puts the staff away) the tip stays where it last was
 * from the player, never on their head. A line that never had a cast frame falls back to above the player, a little
 * toward where it goes.
 */
function rodTip(p: any, toward: Point, line: Line): Point {
  const at = p.renderPosition ?? p.position;
  const tip = staffTip(p);
  if (tip) {
    line.tipOffset = { x: tip.x - at.x, y: tip.y - at.y };
    return tip;
  }
  if (line.tipOffset) return { x: at.x + line.tipOffset.x, y: at.y + line.tipOffset.y };
  const dx = toward.x - at.x, dy = toward.y - at.y, d = Math.hypot(dx, dy) || 1;
  return { x: at.x + (dx / d) * TIP_OUT, y: at.y - TIP_UP + (dy / d) * (TIP_OUT * 0.5) };
}

/**
 * Move the bobber by (dx, dy), on water only and no further from the feet than the line reaches: straight if it can,
 * else along one axis. Returns whether it moved.
 */
function slide(line: Line, dx: number, dy: number, feet: Point): boolean {
  const { x, y } = line.bob;
  for (const [nx, ny] of [[x + dx, y + dy], [x + dx, y], [x, y + dy]] as const) {
    if ((nx !== x || ny !== y) && isFishableAt(nx, ny) && Math.hypot(nx - feet.x, ny - feet.y) <= line.reach) {
      line.bob = { x: nx, y: ny };
      return true;
    }
  }
  return false;
}

/** A fish on the line: the reel pulls the bobber toward the feet, the fish pulls it away now and then, on water only. */
function stepFish(line: Line, p: any, dt: number, own: boolean): void {
  const feet = { x: p.position.x, y: p.position.y + FEET_Y };
  const dx = feet.x - line.bob.x, dy = feet.y - line.bob.y, d = Math.hypot(dx, dy) || 1;
  // the line out: the fish wins back at most PULL_BACK of what the reel has taken in
  line.reach = Math.min(line.reach || d + PULL_BACK, d + PULL_BACK);
  // others' clients cannot know when the button is held: their lines are drawn reeled once the reel began ("reel")
  const turning = line.state === "bite" && (own ? reeling : line.reeled);

  line.nextPull -= dt;
  if (!line.pull && line.nextPull <= 0) {
    // away from the player, give or take 65°
    const away = Math.atan2(-dy, -dx) + rand(-1.15, 1.15), speed = rand(PULL_MIN, PULL_MAX);
    line.pull = { x: Math.cos(away) * speed, y: Math.sin(away) * speed, left: rand(PULL_LEN_MIN, PULL_LEN_MAX) };
    ripple(line, 0.8);
  }
  let vx = 0, vy = 0;
  if (line.pull) {
    vx += line.pull.x;
    vy += line.pull.y;
    line.pull.left -= dt;
    if (line.pull.left <= 0) {
      line.pull = null;
      line.nextPull = rand(PULL_GAP_MIN, PULL_GAP_MAX);
    }
  }
  let blocked = false;
  if (turning) {
    const reelX = (dx / d) * REEL_SPEED * dt, reelY = (dy / d) * REEL_SPEED * dt;
    // the shore between the bobber and the feet: the reel cannot draw it on over the land
    blocked = !isFishableAt(line.bob.x + reelX * 2, line.bob.y + reelY * 2);
    vx += (dx / d) * REEL_SPEED;
    vy += (dy / d) * REEL_SPEED;
  }
  const moved = slide(line, vx * dt, vy * dt, feet);
  line.stuck = turning && (!moved || blocked) ? line.stuck + dt : 0;

  if (!own) return;
  // landed, and no answer yet: asked again now and then (the server takes it once, and answers a refusal with "end")
  if (line.state === "landing") {
    if (line.biteAge - line.landAt > LAND_RETRY_S) {
      line.landAt = line.biteAge;
      sendRequest({ type: "FISH_LAND", data: null });
    }
    return;
  }
  if (line.state !== "bite" || line.biteAge < MIN_LAND_S) return;
  const near = Math.hypot(feet.x - line.bob.x, feet.y - line.bob.y);
  if (near < LAND_DISTANCE || (turning && blocked && near < SHORE_DISTANCE) || line.stuck > STUCK_S) {
    line.state = "landing";
    line.landAt = line.biteAge;
    sendRequest({ type: "FISH_LAND", data: null });
  }
}

/**
 * A line with no fish on it, while this client reels: the bobber is drawn across the water toward the feet, and once
 * it reaches them or the shore, the line comes out of the water (FISH_CANCEL tells the server, and so everyone else).
 */
function stepEmptyReel(line: Line, p: any, dt: number): void {
  const feet = { x: p.position.x, y: p.position.y + FEET_Y };
  const dx = feet.x - line.bob.x, dy = feet.y - line.bob.y, d = Math.hypot(dx, dy) || 1;
  const sx = (dx / d) * REEL_EMPTY_SPEED * dt, sy = (dy / d) * REEL_EMPTY_SPEED * dt;
  const ashore = d < LAND_DISTANCE || !isFishableAt(line.bob.x + sx * 2, line.bob.y + sy * 2);
  if (ashore || !slide(line, sx, sy, feet)) {
    sendRequest({ type: "FISH_CANCEL", data: null });
    retrieveLine(line);
    return;
  }
}

/** One step of the rope: Verlet with gravity, then the segments held to their length, ends pinned. */
function stepRope(line: Line, tip: Point, end: Point, slack: number, dt: number): void {
  if (line.rope.length !== SEGMENTS + 1) line.rope = newRope(tip);
  const rope = line.rope;
  const g = GRAVITY * dt * dt;
  for (let i = 1; i < SEGMENTS; i++) {
    const q = rope[i]!;
    const vx = (q.x - q.ox) * DAMPING, vy = (q.y - q.oy) * DAMPING;
    q.ox = q.x;
    q.oy = q.y;
    q.x += vx;
    q.y += vy + g;
  }
  const length = Math.max(Math.hypot(end.x - tip.x, end.y - tip.y) * slack, 1) / SEGMENTS;
  for (let pass = 0; pass < PASSES; pass++) {
    rope[0]!.x = tip.x; rope[0]!.y = tip.y;
    rope[SEGMENTS]!.x = end.x; rope[SEGMENTS]!.y = end.y;
    for (let i = 0; i < SEGMENTS; i++) {
      const a = rope[i]!, b = rope[i + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.0001;
      const push = (d - length) / d;
      const aPinned = i === 0, bPinned = i + 1 === SEGMENTS;
      if (aPinned && bPinned) continue;
      const share = aPinned || bPinned ? 1 : 0.5;
      if (!aPinned) { a.x += dx * push * share; a.y += dy * push * share; }
      if (!bPinned) { b.x -= dx * push * share; b.y -= dy * push * share; }
    }
  }
  rope[0]!.x = tip.x; rope[0]!.y = tip.y;
  rope[SEGMENTS]!.x = end.x; rope[SEGMENTS]!.y = end.y;
}

function drawRope(ctx: CanvasRenderingContext2D, rope: RopePoint[]): void {
  if (rope.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(rope[0]!.x, rope[0]!.y);
  for (let i = 1; i < rope.length - 1; i++) {
    const a = rope[i]!, b = rope[i + 1]!;
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  const last = rope[rope.length - 1]!;
  ctx.lineTo(last.x, last.y);
  ctx.strokeStyle = "rgba(8, 8, 10, 0.9)";
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

/** The drops of splashes: up, out, and back down under gravity, each ringing the water where it falls. */
function drawDrops(ctx: CanvasRenderingContext2D, dt: number): void {
  for (const d of drops) {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vz -= DROP_GRAVITY * dt;
    d.z += d.vz * dt;
    if (d.z <= 0) ripple({ bob: d }, rand(0.12, 0.22));
  }
  for (let n = drops.length - 1; n >= 0; n--) if (drops[n]!.z <= 0) drops.splice(n, 1);
  for (const d of drops) {
    // its shadow on the water, then the drop itself
    ctx.fillStyle = "rgba(4, 14, 26, 0.18)";
    ctx.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
    ctx.fillStyle = "rgba(240, 248, 255, 0.9)";
    ctx.fillRect(Math.round(d.x), Math.round(d.y - d.z), 1, 1);
  }
}

/** Where each player last stirred the water with their feet, and how long they have stood there (null: not in it). */
const waders = new Map<string, { at: Point; still: number } | null>();

/**
 * Players walking through fishable water stir it as a bobber does (USER REQUEST 2026-10-20: "Walking through fishable
 * water should provide the same ripple effect off of the player"; then "Doesn't seem very noticeable": the pushes were
 * a third of a bobber's): a push at the feet, about as hard as a bobber settling, each WADE_STEP px they go, so a wake
 * of rings trails them; a splash where they step in from the shore; and, standing in it, the water rings round their
 * legs now and then. A ghost is not in the water.
 */
function wade(players: any[], dt: number): void {
  const seen = new Set<string>();
  for (const p of players) {
    const at = p?.renderPosition ?? p?.position;
    if (!at || p.isGhost) continue;
    const id = String(p.id);
    seen.add(id);
    const feet = { x: at.x, y: at.y + FEET_Y };
    const last = waders.get(id);
    if (!isWaterPixel(feet.x, feet.y)) {
      waders.set(id, null);
      continue;
    }
    if (last === undefined) {
      // first seen standing in the water (came into view, the map loaded): no splash, only from here on
      waders.set(id, { at: feet, still: 0 });
    } else if (last === null) {
      // stepped in from the shore
      splash({ bob: feet }, 6, 0.6);
      ripple({ bob: feet }, 1.1);
      waders.set(id, { at: feet, still: 0 });
    } else if (Math.hypot(feet.x - last.at.x, feet.y - last.at.y) >= WADE_STEP) {
      ripple({ bob: feet }, WADE_SIZE);
      waders.set(id, { at: feet, still: 0 });
    } else {
      last.still += dt;
      if (last.still >= WADE_IDLE_S) {
        last.still = 0;
        ripple({ bob: feet }, WADE_SIZE * 0.6);
      }
    }
  }
  for (const id of waders.keys()) if (!seen.has(id)) waders.delete(id);
}

/** The bobber's wake: a gentle push each time it has moved WAKE_STEP px across the water; the waves make the wake. */
function wake(line: Line): void {
  if (!line.wakeAt) {
    line.wakeAt = { ...line.bob };
    return;
  }
  if (Math.hypot(line.bob.x - line.wakeAt.x, line.bob.y - line.wakeAt.y) < WAKE_STEP) return;
  line.wakeAt = { ...line.bob };
  ripple(line, 0.15);
}

/**
 * The bobber, drawn pixel by pixel as the tiles are (USER FEEDBACK 2026-10-20: the shaded one "looks too realistic", and
 * the blue tint under the water "doesn't match the tileset"): a red cap with a glint, a white belly, a dark outline and
 * a stem, where the line is tied. Rows from the top: s stem, o outline, h glint, R red, d dark red, W white, g grey.
 */
const BOBBER_PIXELS = [
  "...s...",
  "...s...",
  "..ooo..",
  ".ohRRo.",
  "ohRRRdo",
  "oRRRRdo",
  "oWWWWgo",
  ".oWWgo.",
  "..ooo..",
];
const BOBBER_COLOURS: Record<string, string> = {
  s: "#4a2f1b", o: "#1c1210", h: "#ff9c8f", R: "#d8282e", d: "#9c1820", W: "#f3efe4", g: "#bcb6a8",
};
/** The rows above the water while the bobber floats (the belly's last rows are under), and the rows a bite pulls under. */
const FLOAT_ROWS = 7, BITE_DEPTH = 3;

/** The top left pixel of the bobber whose water point is (x, y): it floats on that point, `sink` pulls it down. */
function bobberOrigin(x: number, y: number, sink: number, afloat: boolean): Point {
  const left = Math.round(x) - 3;
  if (!afloat) return { x: left, y: Math.round(y) - 5 };
  return { x: left, y: Math.round(y) - FLOAT_ROWS + Math.round(sink * BITE_DEPTH) };
}

/**
 * The bobber's two pictures, from the asset server's icons (USER REQUEST 2026-10-21: "replace the existing bobber with
 * those two states"): afloat, and pulled under by a fish. Each is ICON px square with the bobber in its middle: its top
 * at ICON_TOP (where the line is tied) and its bottom at ICON_BOTTOM. Until they have loaded, the bobber is drawn by
 * hand (drawBobberPixels).
 */
const ICON = 32, ICON_TOP = 11, ICON_BOTTOM = 21;
function bobberIcon(under: boolean): HTMLImageElement | null {
  const base = (window as any).__assetServerUrl || config.ASSET_SERVER_URL;
  if (!base) return null;
  const img = imageOf(`${base}/icon?name=${under ? "fishing_bobber_under" : "fishing_bobber"}`);
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/** The top left of a bobber icon whose water point is (x, y): on the water its bottom sits on that point, in the air its middle. */
function iconOrigin(x: number, y: number, afloat: boolean): Point {
  return { x: Math.round(x) - ICON / 2, y: afloat ? Math.round(y) + 1 - (ICON_BOTTOM + 1) : Math.round(y) - ICON / 2 };
}

/** The top of the bobber, where the line is tied. */
function stemTop(x: number, y: number, sink: number, afloat: boolean): Point {
  if (bobberIcon(afloat && sink > 0.5)) {
    const o = iconOrigin(x, y, afloat);
    return { x: o.x + ICON / 2, y: o.y + ICON_TOP };
  }
  const o = bobberOrigin(x, y, sink, afloat);
  return { x: o.x + 3.5, y: o.y };
}

/** The bobber at (x, y), its water point: afloat, or under once a fish has taken the bait (`sink` past half). */
function drawBobber(ctx: CanvasRenderingContext2D, x: number, y: number, sink: number, afloat: boolean): void {
  const icon = bobberIcon(afloat && sink > 0.5);
  if (!icon) return drawBobberPixels(ctx, x, y, sink, afloat);
  const o = iconOrigin(x, y, afloat);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(icon, o.x, o.y, ICON, ICON);
  ctx.restore();
}

/**
 * The bobber drawn by hand, while its pictures load: on the water only what is above the waterline is drawn, with a
 * light line where it breaks the surface; a bite pulls it down until only the stem and the top of its cap show. In the
 * air (`afloat` false: cast out, or taken in) all of it shows.
 */
function drawBobberPixels(ctx: CanvasRenderingContext2D, x: number, y: number, sink: number, afloat: boolean): void {
  const o = bobberOrigin(x, y, sink, afloat), waterline = Math.round(y);
  BOBBER_PIXELS.forEach((row, i) => {
    if (afloat && o.y + i >= waterline) return;
    for (let j = 0; j < row.length; j++) {
      const colour = BOBBER_COLOURS[row[j]!];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(o.x + j, o.y + i, 1, 1);
    }
  });
  if (!afloat) return;
  // the surface round it: as wide as the bobber where it meets the water, a little narrower once it is under
  const half = sink > 0.5 ? 2 : 4;
  ctx.fillStyle = "rgba(235, 245, 255, 0.55)";
  ctx.fillRect(Math.round(x) - half, waterline, half * 2 + 1, 1);
}

/**
 * Steps and draws every line, in world space (renderer.ts, under the characters). `players`: the players on the map,
 * with their position and their smoothed renderPosition.
 */
export function renderFishing(ctx: CanvasRenderingContext2D, dt: number, players: any[]): void {
  dt = Math.min(Math.max(dt, 0), 1 / 20);
  wade(players, dt);
  if (!lines.size && !drops.length && !waterActive()) return;
  // the water first, under the bobbers, the lines and the waders; a field with a bobber on it is kept however calm
  stepAndDrawWater(ctx, dt, (field) => [...lines.values()].some((l) => field.holds(l.bob.x, l.bob.y)));
  for (const line of [...lines.values()]) {
    const p = players.find((pl: any) => String(pl.id) === line.id);
    // the player left (despawned, another map): the line goes with them
    if (!p?.position) {
      lines.delete(line.id);
      continue;
    }
    const own = String(line.id) === String(cachedPlayerId);
    line.age += dt;

    if (line.state === "flying" && line.fly) {
      const fly = line.fly;
      if (!fly.from) {
        // (USER REPORT 2026-10-20, "Fishing line is still misaligned on cast") the cast packet comes before the staff
        // is in the player's hands: the bobber leaves once it is, from its tip, and nothing is drawn till then
        if (!staffTip(p) && line.age < POSE_WAIT_S) continue;
        const tipNow = rodTip(p, fly.to, line);
        fly.from = tipNow;
        fly.dur = 0.3 + Math.hypot(fly.to.x - tipNow.x, fly.to.y - tipNow.y) / 700;
        line.rope = newRope(tipNow);
      }
      fly.t += dt;
      if (fly.t >= fly.dur) {
        line.fly = null;
        line.state = "floating";
        // the bobber lands: a splash, and rings out from it
        splash(line, 8, 0.9);
        ripple(line, 1.4);
      }
    }
    if (line.state === "bite" || line.state === "landing") line.biteAge += dt;
    // the first turn of the reel on a fish that bit: the server stops the clock it gets away by (BITE_ESCAPE_MS)
    if (own && reeling && line.state === "bite" && !line.reeled) {
      line.reeled = true;
      sendRequest({ type: "FISH_REEL", data: null });
    }
    if (line.state === "bite" || line.state === "landing") stepFish(line, p, dt, own);
    // no fish on: the reel draws the empty line in
    if (own && reeling && line.state === "floating") stepEmptyReel(line, p, dt);
    // a bobber drawn across the water leaves a wake
    if (line.state === "floating" || line.state === "bite" || line.state === "landing") wake(line);

    const hooked = line.state === "bite" || line.state === "landing";
    line.sink += ((hooked ? 1 : 0) - line.sink) * Math.min(1, dt * 14);
    line.rippleIn -= dt;
    if ((line.state === "floating" || hooked) && line.rippleIn <= 0) {
      ripple(line, hooked ? 0.6 : 0.5);
      line.rippleIn = hooked ? rand(0.35, 0.6) : rand(1.1, 1.8);
    }

    // Where the end of the line is: the bobber in flight, on the water (bobbing a pixel, jumping while a fish tugs),
    // the bobber on its way back to the rod, or the fish on its way out of the water.
    const afloat = line.state === "floating" || hooked;
    let end: Point = line.fly ? flightPoint(line.fly) : {
      x: line.bob.x + (hooked ? Math.round(rand(-0.6, 0.6)) : 0),
      y: line.bob.y + (hooked ? 0 : Math.round(Math.sin(line.age * 3) * 0.6)),
    };
    let fish: Point | null = null;
    let done = false;
    if (line.state === "retrieving" && line.retrieve) {
      const back = line.retrieve;
      back.t += dt;
      const k = Math.min(back.t / RETRIEVE_S, 1);
      const tipNow = rodTip(p, back.from, line);
      // lifted out of the water first, then drawn up to the rod
      end = { x: back.from.x + (tipNow.x - back.from.x) * k, y: back.from.y + (tipNow.y + 6 - back.from.y) * k - Math.sin(Math.PI * k) * 10 };
      done = k >= 1;
    }
    if (line.state === "catch" && line.yank) {
      const yank = line.yank;
      yank.t += dt;
      const k = Math.min(yank.t / YANK_S, 1);
      // up out of the water and over to hang from the staff's tip: never into the player (USER REPORT 2026-10-20: "when
      // finished reeling in, the fishing line goes inside the players head")
      const tipNow = rodTip(p, yank.from, line);
      const hang = { x: tipNow.x, y: tipNow.y + 9 };
      fish = { x: yank.from.x + (hang.x - yank.from.x) * k, y: yank.from.y + (hang.y - yank.from.y) * k - Math.sin(Math.PI * k) * 40 };
      end = fish;
      if (k >= 1) {
        done = true;
        // in hand: said as a loot pickup is, the name in its quality's colour (USER REQUEST 2026-10-20)
        if (own && yank.item) void import("./creatureloot.js").then(({ showItemReceived }) => showItemReceived("You caught: ", yank.item, 1, yank.quality));
      }
    }
    if (done) {
      dropLine(line);
      continue;
    }

    const sink = afloat ? line.sink : 0;
    const taut = !!line.fly || line.state === "catch" || line.state === "retrieving" || (own ? reeling : hooked && line.reeled);
    // the line is tied to the top of the bobber's stem, or to the fish
    const tied = fish ?? stemTop(end.x, end.y, sink, afloat);
    const tip = rodTip(p, tied, line);
    const slack = taut ? SLACK_REEL : hooked ? SLACK_BITE : SLACK_FLOAT;
    stepRope(line, tip, tied, slack, dt);

    // the bobber (or the fish) first, then the line over it: the line is tied on top of it
    if (fish) {
      const icon = line.yank?.icon;
      // it swings as it comes out, and hangs still once in hand
      const swing = Math.sin(Math.min(line.yank!.t / YANK_S, 1) * Math.PI) * 0.9;
      ctx.save();
      ctx.translate(Math.round(fish.x), Math.round(fish.y));
      ctx.rotate(swing);
      if (icon && icon.complete && icon.naturalWidth > 0) ctx.drawImage(icon, -8, -8, 16, 16);
      else {
        ctx.fillStyle = "#9fb4c8";
        ctx.fillRect(-5, -2, 10, 4);
      }
      ctx.restore();
    } else {
      drawBobber(ctx, end.x, end.y, sink, afloat);
    }
    drawRope(ctx, line.rope);
  }
  // the drops of splashes, over the bobbers
  drawDrops(ctx, dt);
}
