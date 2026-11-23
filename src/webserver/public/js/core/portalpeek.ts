// The portal peek feed: the live players on a portal's far side (DUNGEON_PORTAL_PEEK_DATA), as the portal shows them.
// The same limits as the server's (systems/dungeons/peek.ts in the engine).

/** Portals fed at once, the feed's rate, and the box round the far place it covers (map pixels each way). */
export const PEEK_CAP = 2, PEEK_RATE_MS = 1000 / 30, PEEK_HALF_W = 96, PEEK_HALF_H = 160;
/** The feet sit this far below a player's position. */
const FEET = 16;

export interface PlacedPortal { name: string; kind: "dungeon" | "teleport"; dungeonId: number | null; mirror: boolean; x: number; foot: number }

/** The map's portals, centred on their rectangles with their foot on its bottom edge. Old ones are dungeon portals that mirror. */
export function portalsOnMap(raw: unknown): PlacedPortal[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, any>).map(([key, p]) => {
    const w = Number(p?.size?.width) || 32, h = Number(p?.size?.height) || 32;
    const id = Number(p?.dungeonId);
    return {
      name: String(p?.name ?? key),
      kind: p?.kind === "teleport" ? "teleport" : "dungeon",
      dungeonId: p?.dungeonId != null && Number.isInteger(id) && id > 0 ? id : null,
      mirror: !(p?.mirror === false || p?.mirror === "false"),
      x: Math.round((Number(p?.position?.x) || 0) + w / 2),
      foot: Math.round((Number(p?.position?.y) || 0) + h),
    };
  });
}

/** The mirrored portals the player (at their position) stands within reach of, nearest first, at most PEEK_CAP. */
export function wantedPeeks(portals: PlacedPortal[], at: { x: number; y: number } | null, reach: number): string[] {
  if (!at) return [];
  return portals
    .filter((p) => p.mirror)
    .map((p) => ({ name: p.name, d: Math.hypot(at.x - p.x, at.y + FEET - p.foot) }))
    .filter((p) => p.d <= reach)
    .sort((a, b) => a.d - b.d)
    .slice(0, PEEK_CAP)
    .map((p) => p.name);
}

export function peekChanges(current: Iterable<string>, wanted: string[]): { on: string[]; off: string[] } {
  const now = new Set(current);
  return { on: wanted.filter((n) => !now.has(n)), off: [...now].filter((n) => !wanted.includes(n)) };
}

/** One player on the far side: where, relative to the far place, facing and moving; and what they look like (SPAWN_PLAYER's sprites). */
export interface PeekFigure { x: number; y: number; d: string; m: 0 | 1; look: any | null; anim?: any; pose?: string }

/** A frame of the feed into the portal's figures: players gone are dropped, and those with a new look are named. */
export function applyPeekFrame(figures: Map<string, PeekFigure>, frame: { players?: unknown; looks?: unknown }): { changed: boolean; newLooks: string[] } {
  const rows = (Array.isArray(frame?.players) ? frame.players : []).filter((r: any) =>
    typeof r?.i === "string" && Number.isFinite(r?.x) && Number.isFinite(r?.y)) as Array<{ i: string; x: number; y: number; d?: unknown; m?: unknown }>;
  const seen = new Set(rows.map((r) => r.i));
  let changed = false;
  for (const id of [...figures.keys()]) if (!seen.has(id)) { figures.delete(id); changed = true; }
  for (const r of rows) {
    const f = figures.get(r.i);
    const d = typeof r.d === "string" ? r.d : "down", m = r.m ? 1 : 0;
    if (!f) { figures.set(r.i, { x: r.x, y: r.y, d, m, look: null }); changed = true; continue; }
    if (f.x !== r.x || f.y !== r.y || f.d !== d || f.m !== m) changed = true;
    f.x = r.x; f.y = r.y; f.d = d; f.m = m;
  }
  const newLooks: string[] = [];
  for (const l of (Array.isArray(frame?.looks) ? frame.looks : []) as any[]) {
    const f = typeof l?.i === "string" ? figures.get(l.i) : undefined;
    if (!f) continue;
    f.look = l.s ?? null;
    f.anim = undefined;
    newLooks.push(l.i);
    changed = true;
  }
  return { changed, newLooks };
}

const DIRECTIONS = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"];

/** The animation a figure plays: walking while it moves, standing otherwise. */
export function peekPose(d: string, m: number): string {
  return `${m ? "walk" : "idle"}_${DIRECTIONS.includes(d) ? d : "down"}`;
}

/* The portal shows the far side as a mirror does: flipped front to back about the far place, left and right kept. */

/** A facing seen in the mirror: up and down swap, left and right stay. */
export function mirrorFacing(d: string): string {
  if (d.startsWith("up")) return "down" + d.slice(2);
  if (d.startsWith("down")) return "up" + d.slice(4);
  return d;
}

/** The animation a figure plays in the mirror. */
export function mirrorPose(d: string, m: number): string {
  return peekPose(mirrorFacing(DIRECTIONS.includes(d) ? d : "down"), m);
}

/** Where the figures stand in the mirror (their feet flipped about the far place, like the ground), back to front. */
export function inMirror(figures: Iterable<PeekFigure>): Array<{ figure: PeekFigure; x: number; y: number }> {
  return [...figures].map((figure) => ({ figure, x: figure.x, y: -figure.y - 2 * FEET })).sort((a, b) => a.y - b.y);
}
