import Cache from "./cache.js";
import { setSoundAt, fadeSoundsExcept } from "./audio.js";

const cache = Cache.getInstance();
/** The middle of a sound NPC's circle, as a share of its radius: heard at full level in both ears. */
const CENTER_SHARE = 0.3;
/** How far from the middle's edge toward the circle's edge (a share of the way) the sound has moved wholly to its side. */
const SPREAD_SHARE = 0.5;
const kept = new Set<string>();

/** How far from a sound NPC it is heard at full level in both ears (px). */
export function soundCenterRadius(radius: number): number {
  return Math.max(0, radius) * CENTER_SHARE;
}

export function updateNpcSounds(x: number, y: number): void {
  kept.clear();
  if (Number.isFinite(x) && Number.isFinite(y)) {
    for (const npc of (cache.npcs ?? []) as any[]) {
      const radius = Number(npc?.sound_radius) || 0;
      if (npc?.sound_npc !== true || !npc.sound || npc.hidden || radius <= 0 || !npc.position) continue;
      const key = `npc:${npc.id}`;
      kept.add(key);
      const dx = npc.position.x - x, dz = npc.position.y - y, d = Math.hypot(dx, dz);
      const center = soundCenterRadius(radius);
      // past the middle: how far out toward the edge (0..1), and how much it is heard from its side (0..1)
      const out = Math.min(1, Math.max(0, (d - center) / (radius - center)));
      const s = Math.min(1, out / SPREAD_SHARE), spread = s * s * (3 - 2 * s);
      // (where it is, level with the listener; right on top of it, in front: the spread is nothing there anyway)
      const at = d > 0 ? { x: dx, y: 0, z: dz } : { x: 0, y: 0, z: -1 };
      setSoundAt(key, String(npc.sound), Math.cos((out * Math.PI) / 2), at, spread);
    }
  }
  fadeSoundsExcept(kept);
}
