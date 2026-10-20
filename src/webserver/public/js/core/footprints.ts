// Footprints (engine src/systems/footprints.ts). USER REQUEST 2026-10-20: "a section in the editor to be able to add
// footsteps on certain tiles": visible footprints, with their colour and darkness, how long they stay, and their style.
//
// The map editor's Footprints tab gives tiles of a tileset prints: a style (boot prints, bare feet, holes in deep
// snow), a colour, a darkness and a fade time. The server sends every player the whole list (TILE_FOOTPRINTS) at login
// and after every save. Each player walking across such a tile leaves a print on each step, left foot and right foot
// in turn, turned the way they walk; it stays as it was for most of its time, then fades away. A ghost leaves none, nor
// does a rider (the mount's feet are not a person's). The prints are drawn on the ground, under the characters.
import { cachedPlayerId } from "./socket.js";
import { ownStep, tilesetKey } from "./tilesounds.js";
import { Stepper } from "./steps.js";
import { drawPrint, type PrintStyle } from "./footprintdraw.js";

/** How a tile's prints look: their style, colour ("#rrggbb"), darkness (0 to 1) and fade time (s). */
export interface Footprint { style: PrintStyle; color: string; opacity: number; fade: number }
/** tileset key -> tile id (as text) -> its prints */
export type TileFootprintList = Record<string, Record<string, Footprint>>;

/**
 * A print is laid on each step, as the footstep sounds are played (steps.ts: USER FEEDBACK 2026-10-20, "footprints are
 * being applied too often ... it should be synced with the sound"): the player this client controls on the very steps
 * their sound is heard (tilesounds.ts), everyone else by the same rule. px: each foot's distance from the line walked.
 */
const FOOT_APART = 4;
/** The player's feet below their position (tilesounds.ts FEET_Y), where the prints are laid. */
const FEET_Y = 16;
/** The most prints kept at once: the oldest go first. */
const PRINTS_MAX = 900;
/** How much of its time a print stays as dark as it was laid, before it begins to fade. */
const HOLD = 0.6;
const GID_MASK = 0x1fffffff;

let list: TileFootprintList = {};
let listRev = 0;
const listeners = new Set<(list: TileFootprintList) => void>();

/** The list as this client has it. */
export function getTileFootprints(): TileFootprintList {
  return list;
}

/** Take the list the server sent (TILE_FOOTPRINTS); prints laid from now on look as it says. */
export function setTileFootprints(data: unknown): void {
  list = data && typeof data === "object" ? (data as TileFootprintList) : {};
  listRev++;
  for (const listen of listeners) listen(list);
}

/** Be told each time the list changes (the map editor redraws its Footprints tab). Returns how to stop. */
export function onTileFootprints(listen: (list: TileFootprintList) => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

let table: { tilesets: any[] | null; rev: number; gids: Map<number, Footprint> } = { tilesets: null, rev: -1, gids: new Map() };
/** gid -> prints, for the map this client is on (rebuilt when the map or the list changes). */
function printTable(): Map<number, Footprint> {
  const tilesets = window.mapData?.tilesets ?? null;
  if (table.tilesets === tilesets && table.rev === listRev) return table.gids;
  const gids = new Map<number, Footprint>();
  for (const ts of tilesets ?? []) {
    for (const [id, print] of Object.entries(list[tilesetKey(ts)] ?? {})) gids.set(Number(ts.firstgid) + Number(id), print);
  }
  table = { tilesets, rev: listRev, gids };
  return gids;
}

/** The prints of the ground at a world point: of the tiles drawn there (but collision and no-pvp), the topmost with prints. */
function printAt(x: number, y: number): Footprint | null {
  const gids = printTable(), map = window.mapData;
  if (!gids.size || !map?.loadedChunks) return null;
  const tw = map.tilewidth || 16, th = map.tileheight || 16, size = Number(map.chunkSize) || 0;
  if (!size || x < 0 || y < 0) return null;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th), cx = Math.floor(tx / size), cy = Math.floor(ty / size);
  const chunk: any = map.loadedChunks.get(`${cx}-${cy}`);
  if (!chunk?.layers) return null;
  const lx = tx - cx * size, ly = ty - cy * size, w = Number(chunk.width) || size;
  if (lx >= w || ly >= (Number(chunk.height) || size)) return null;
  let best: Footprint | null = null, bestZ = -Infinity;
  for (const layer of chunk.layers) {
    if (!layer?.data || /collision|nopvp/i.test(String(layer.name ?? ""))) continue;
    const print = gids.get(layer.data[ly * w + lx] & GID_MASK), z = Number(layer.zIndex) || 0;
    if (print && z >= bestZ) { best = print; bestZ = z; }
  }
  return best;
}

interface Print { x: number; y: number; angle: number; side: number; style: PrintStyle; color: string; opacity: number; fade: number; born: number }
/** A walker: their steps, the side of the next foot, and where their last step was (to turn its print the way they went). */
interface Walker { steps: Stepper; side: number; at: { x: number; y: number } | null; seen: number }

const prints: Print[] = [];
const walkers = new Map<string, Walker>();

/** Loading a map takes the prints away. */
export function clearFootprints(): void {
  prints.length = 0;
  walkers.clear();
}

/** Lay the prints of every player who takes a step on ground that takes them. */
function walk(players: any[], now: number): void {
  const seen = new Set<string>();
  const map = String(window.mapData?.name ?? "");
  for (const p of players) {
    const pos = p?.position;
    if (!pos) continue;
    const id = String(p.id);
    seen.add(id);
    let w = walkers.get(id);
    if (!w) walkers.set(id, (w = { steps: new Stepper(), side: 1, at: null, seen: ownStep().count }));
    let stepped: { x: number; y: number } | null = null;
    if (id === String(cachedPlayerId)) {
      // the player this client controls: on the steps their footstep sound plays
      const own = ownStep();
      if (own.count !== w.seen && own.at) stepped = own.at;
      w.seen = own.count;
    } else if (p.isDead || p.isGhost || p.canmove === false) {
      w.steps.reset();
    } else if (w.steps.step(pos.x, pos.y, map, now * 1000)) {
      stepped = { x: pos.x, y: pos.y };
    }
    if (!stepped) continue;
    const from = w.at;
    w.at = stepped;
    w.side = -w.side;
    // a ghost leaves none, nor does a rider (the mount's feet are not a person's)
    if (p.isGhost || p.mounted) continue;
    const feet = { x: stepped.x, y: stepped.y + FEET_Y };
    const look = printAt(feet.x, feet.y);
    if (!look) continue;
    // turned the way they went since their last step (or the way they face, on the first)
    const dir = String(p.lastDirection ?? p.location?.position?.direction ?? "down").toLowerCase();
    const faced = Math.atan2(dir.includes("down") ? 1 : dir.includes("up") ? -1 : 0, dir.includes("right") ? 1 : dir.includes("left") ? -1 : 0);
    const angle = from && Math.hypot(stepped.x - from.x, stepped.y - from.y) > 0.5 ? Math.atan2(stepped.y - from.y, stepped.x - from.x) : faced;
    // each foot a little to its own side of the line walked
    const ox = -Math.sin(angle) * FOOT_APART * w.side, oy = Math.cos(angle) * FOOT_APART * w.side;
    prints.push({ x: feet.x + ox, y: feet.y + oy, angle, side: w.side, style: look.style, color: look.color, opacity: look.opacity, fade: look.fade, born: now });
    if (prints.length > PRINTS_MAX) prints.splice(0, prints.length - PRINTS_MAX);
  }
  for (const id of walkers.keys()) if (!seen.has(id)) walkers.delete(id);
}

/**
 * Lay new prints and draw them all, in world space (renderer.ts, on the ground under the characters). `players`: the
 * players on the map, with their position and their smoothed renderPosition.
 */
export function renderFootprints(ctx: CanvasRenderingContext2D, players: any[]): void {
  const now = performance.now() / 1000;
  walk(players, now);
  if (!prints.length) return;
  let keep = 0;
  for (const print of prints) {
    const k = (now - print.born) / print.fade;
    if (k >= 1) continue;
    prints[keep++] = print;
    // as laid for most of its time, then fading out
    const alpha = print.opacity * (k < HOLD ? 1 : 1 - (k - HOLD) / (1 - HOLD));
    if (alpha > 0.01) drawPrint(ctx, print, alpha);
  }
  prints.length = keep;
}
