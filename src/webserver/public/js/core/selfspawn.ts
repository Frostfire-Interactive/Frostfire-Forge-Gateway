import { TELEPORT_PX } from "./movementsmoothing.ts";

/** Backstop only: the deferred spawn follows HANDOFF_DONE within the same tick plus one database wait. */
export const POST_HANDOFF_SPAWN_MS = 2000;

const SPRITE_KEYS = [
  "mountSprite", "bodySprite", "headSprite", "armorHelmetSprite", "armorShoulderguardsSprite", "armorNeckSprite",
  "armorHandsSprite", "armorChestSprite", "armorFeetSprite", "armorLegsSprite", "armorWeaponSprite",
] as const;

/** One sprite entry as a comparable name: the server sends objects ({name, templateUrl, imageUrl}), decoded fresh every packet. */
function spriteName(entry: any): string | null {
  if (entry === null || entry === undefined || entry === "") return null;
  if (typeof entry === "string") return entry;
  return String(entry.name ?? entry.templateUrl ?? JSON.stringify(entry));
}

/** Whether two sprite records name the same sheets (a missing record counts as none; a missing entry as no layer). */
export function sameSprites(a: any, b: any): boolean {
  if (!a || !b) return false;
  return SPRITE_KEYS.every((k) => spriteName(a[k]) === spriteName(b[k]));
}

function bareMap(map: unknown): string | null {
  return typeof map === "string" && map ? map.replace(/\.json$/i, "").toLowerCase() : null;
}

export interface SelfSpawnPlan {
  /** Write data.location into the local player's position fields. */
  snap: boolean;
  /** Rebuild the layered animation from the packet's sprite data. */
  rebuild: boolean;
  /** The animation to put back after a rebuild (null: take the packet's). */
  keepPose: string | null;
}

interface Point { x: number; y: number }

export function planSelfSpawn(args: {
  doneAt: number | null;
  now: number;
  doneMap?: string | null;
  spawnMap?: string | null;
  position?: Point | null;
  spawnPoint?: Point | null;
  oldSprites: any;
  newSprites: any;
  currentPose: string | null | undefined;
  lastDirection: string | null | undefined;
  moveHeld: boolean;
}): SelfSpawnPlan {
  const real: SelfSpawnPlan = { snap: true, rebuild: true, keepPose: null };
  const { doneAt, now } = args;
  if (doneAt === null || !(now - doneAt >= 0 && now - doneAt <= POST_HANDOFF_SPAWN_MS)) return real;
  // Another map: a warp or a respawn, not the handoff's own spawn.
  const doneMap = bareMap(args.doneMap);
  const spawnMap = bareMap(args.spawnMap);
  if (doneMap && spawnMap && doneMap !== spawnMap) return real;
  // Far from where the player is: a teleport.
  const from = args.position;
  const to = args.spawnPoint;
  if (from && to && Number.isFinite(from.x + from.y + to.x + to.y) && Math.hypot(to.x - from.x, to.y - from.y) >= TELEPORT_PX) return real;
  if (sameSprites(args.oldSprites, args.newSprites)) return { snap: false, rebuild: false, keepPose: null };
  const dir = args.lastDirection || "down";
  const keepPose = args.moveHeld ? `walk_${dir}` : args.currentPose || null;
  return { snap: false, rebuild: true, keepPose };
}
