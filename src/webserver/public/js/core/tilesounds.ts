import { playEffect, loadEffect } from "./audio.js";
import { config } from "../web/global.js";
import { Stepper } from "./steps.js";

const GID_MASK = 0x1fffffff;
/** the tile property that names a tile's footstep sound */
export const FOOTSTEP_PROPERTY = "footstep_sound";
const STEP_VOLUME = 0.6, VOLUME_SPREAD = 0.2;
const PITCH_DOWN = 3, PITCH_UP = 1, PITCH_APART = 1;
/** the feet: where the player's shadow is drawn, below the sprite's middle (player.ts) */
const FEET_Y = 16;

export type TileSoundList = Record<string, Record<string, string>>;
let overrides: TileSoundList = {};
let overridesRev = 0, overridesAsked = false;
const listeners = new Set<(list: TileSoundList) => void>();

/** A tileset's key in the list: its picture's file name without the extension, in lower case ("environment"). */
export function tilesetKey(ts: any): string {
  const image = String(ts?.image ?? "").split(/[\\/]/).pop() ?? "";
  return (image.replace(/\.[^.]+$/, "") || String(ts?.name ?? "")).trim().toLowerCase();
}

/** The list as this client has it. */
export function getTileSounds(): TileSoundList {
  return overrides;
}

/** Take the list the game server or the asset server sent; the sounds change from the next step on. */
export function setTileSounds(list: unknown) {
  overrides = list && typeof list === "object" ? list as TileSoundList : {};
  overridesRev++;
  for (const listen of listeners) listen(overrides);
}

/** Be told each time the list changes (the map editor redraws its Sounds tab). Returns how to stop. */
export function onTileSounds(listen: (list: TileSoundList) => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

/** Ask the asset server for the list, once (a failed ask leaves the maps' own sounds, and is tried at the next step). */
export function loadTileSounds() {
  if (overridesAsked) return;
  const base = (window as any).__assetServerUrl || config.ASSET_SERVER_URL;
  if (!base) return;
  overridesAsked = true;
  fetch(`${base}/tile-sounds`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body) => { if (overridesRev === 0) setTileSounds(body?.tilesets); })
    .catch(() => { overridesAsked = false; });
}

let tableFor: { tilesets: any[] | null; rev: number; table: Map<number, string> } = { tilesets: null, rev: -1, table: new Map() };
/** gid -> footstep sound, from the tile properties of the map's tilesets and the editor's list over them (rebuilt when either changes) */
function soundTable(): Map<number, string> {
  loadTileSounds();
  const tilesets = window.mapData?.tilesets ?? null;
  if (tableFor.tilesets === tilesets && tableFor.rev === overridesRev) return tableFor.table;
  const table = new Map<number, string>();
  for (const ts of tilesets ?? []) {
    for (const t of ts?.tiles ?? []) {
      const p = (t.properties ?? []).find((q: any) => String(q.name).toLowerCase() === FOOTSTEP_PROPERTY);
      if (p && typeof p.value === "string" && p.value.trim()) table.set(Number(ts.firstgid) + Number(t.id), p.value.trim());
    }
    for (const [id, sound] of Object.entries(overrides[tilesetKey(ts)] ?? {})) {
      const gid = Number(ts.firstgid) + Number(id);
      if (sound) table.set(gid, sound);
      else table.delete(gid);
    }
  }
  tableFor = { tilesets, rev: overridesRev, table };
  for (const name of new Set(table.values())) void loadEffect(name); // ready before the first step, when sound is allowed
  return table;
}

export function footstepSoundAt(x: number, y: number): string | null {
  const map = window.mapData, table = soundTable();
  if (!map?.loadedChunks || !table.size) return null;
  const tw = map.tilewidth || 16, th = map.tileheight || 16, size = Number(map.chunkSize) || 0;
  if (!size) return null;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th), cx = Math.floor(tx / size), cy = Math.floor(ty / size);
  const chunk: any = map.loadedChunks.get(`${cx}-${cy}`);
  if (!chunk?.layers) return null;
  const lx = tx - cx * size, ly = ty - cy * size, w = Number(chunk.width) || size;
  if (lx < 0 || ly < 0 || lx >= w || ly >= (Number(chunk.height) || size)) return null;
  let best: string | null = null, bestZ = -Infinity;
  for (const layer of chunk.layers) {
    if (!layer?.data || /collision|nopvp/i.test(String(layer.name ?? ""))) continue;
    const sound = table.get(layer.data[ly * w + lx] & GID_MASK), z = Number(layer.zIndex) || 0;
    if (sound && z >= bestZ) { best = sound; bestZ = z; }
  }
  return best;
}

let lastPitch = 0;
/** The steps of the player this client controls. */
const ownSteps = new Stepper();
/** How many steps they have taken, and where the last was (their position, px): the footprints lay theirs on them. */
let ownStepCount = 0;
let ownStepAt: { x: number; y: number } | null = null;

/** How many steps the player this client controls has taken (footprints.ts lays a print on each), and where the last was. */
export function ownStep(): { count: number; at: { x: number; y: number } | null } {
  return { count: ownStepCount, at: ownStepAt };
}

/** The next step's playback rate: a random pitch out of the range left when PITCH_APART round the last one is taken out. */
function stepRate(): number {
  const lo = -PITCH_DOWN, hi = PITCH_UP;
  const gapLo = Math.max(lo, lastPitch - PITCH_APART), gapHi = Math.min(hi, lastPitch + PITCH_APART);
  const below = gapLo - lo, r = Math.random() * (below + hi - gapHi);
  const pitch = r < below ? lo + r : gapHi + (r - below);
  lastPitch = pitch;
  return 2 ** (pitch / 12);
}

/** Call once a frame with the player this client controls: plays the footsteps of the walk (`now`: the frame's time, ms). */
export function updateTileSounds(player: any, now: number = performance.now()) {
  const pos = player?.position;
  // A player an admin is dragging is carried, not walking (canmove is false from DRAG_PLAYER_START to DRAG_PLAYER_STOP)
  if (!pos || player.isDead || player.isGhost || player.canmove === false) { ownSteps.reset(); return; }
  const map = String(window.mapData?.name ?? "");
  if (!ownSteps.step(pos.x, pos.y, map, now)) return;
  ownStepCount++;
  ownStepAt = { x: pos.x, y: pos.y };
  const sound = footstepSoundAt(pos.x, pos.y + FEET_Y);
  if (sound) playEffect(sound, { volume: STEP_VOLUME * (1 - VOLUME_SPREAD * Math.random()), rate: stepRate() });
}
