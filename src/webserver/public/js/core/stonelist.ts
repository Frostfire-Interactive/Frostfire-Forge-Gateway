// The summoning stones of the map the client holds (window.mapData.summoningStones), read the same wherever they are used.
// No DOM here, so the client's walk test (handoffwalk.ts) and the tests can use it.

/** The picture's hit box (64 wide): its opaque rows 7 to 92, so 86 above the foot. */
const HIT_HALF_WIDTH = 32;
const HIT_HEIGHT = 86;
const DEFAULT_GLOW = "#66ccff";

export type MapStone = { name: string; x: number; y: number; glowColor: string };

/** The map's stones (window.mapData.summoningStones: a list, or one keyed by name), where their feet are. */
export function stonesOnMap(raw: unknown): MapStone[] {
  if (!raw || typeof raw !== "object") return [];
  const entries: Array<[string, any]> = Array.isArray(raw) ? raw.map((s: any) => [String(s?.name ?? ""), s]) : Object.entries(raw as Record<string, any>);
  const out: MapStone[] = [];
  for (const [key, s] of entries) {
    const x = Number(s?.position?.x);
    const y = Number(s?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const color = typeof s?.glowColor === "string" && /^#[0-9a-f]{6}$/i.test(s.glowColor) ? s.glowColor.toLowerCase() : DEFAULT_GLOW;
    out.push({ name: Array.isArray(raw) ? String(s?.name ?? key) : key, x, y, glowColor: color });
  }
  return out;
}

/** The name of the stone drawn under a point of the world, if any: x - 32 to x + 32, y - 86 to y, plus `slop` all round. */
export function stoneAt(worldX: number, worldY: number, slop = 0): string | null {
  const stones = stonesOnMap((globalThis as any).window?.mapData?.summoningStones);
  for (let i = stones.length - 1; i >= 0; i--) {
    const s = stones[i]!;
    if (worldX >= s.x - HIT_HALF_WIDTH - slop && worldX <= s.x + HIT_HALF_WIDTH + slop && worldY >= s.y - HIT_HEIGHT - slop && worldY <= s.y + slop) return s.name;
  }
  return null;
}

/** A player a click can pick: not dead, and not a ghost about to be moved. As SELECTPLAYER picks them (events.ts). */
export const pickablePlayer = (player: any): boolean => !player?.isDead && !(player?.isGhost && player?.ghostTeleportPending);

/**
 * Whether a player under the pointer takes the click before the summoning stone there: another pickable player does. The
 * clicker's own character never does: the toucher stands within 150 px of the stone, so their own sprite often covers it.
 */
export const shadowsStone = (player: any, ownId: unknown): boolean => player?.id !== ownId && pickablePlayer(player);
