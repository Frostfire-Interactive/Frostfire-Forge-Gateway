// A portal stands in a stone arch, and the arch is solid: the client's own walk (core/handoffwalk.ts blockedAt) stops
// at it as the engine's does. The arch (public/img/portal-frame.png, 94 x 114) is drawn centred on the portal's
// rectangle with its foot on the rectangle's bottom edge (core/portalfx.ts); its opening is art columns 26 to 67. On the
// ground it stands on its full width and ARCH_DEPTH deep: a pillar each side of the opening, and across the opening, at
// the back, a wall BACK_DEPTH deep. So the opening can be walked into only from the front, where the portal fires.
// This is an exact copy of the engine's systems/portalarch.ts (with the portals read as portalsOnMap places them); keep
// the two the same.

import { portalsOnMap } from "./portalpeek.js";

/** Half the arch's width, and half its opening's, from its middle. */
export const ARCH_HALF_WIDTH = 47;
export const OPENING_HALF_WIDTH = 21;
/** How far back from its foot the arch stands on the ground: its pillars' base (the art's plinths are 20 rows). */
export const ARCH_DEPTH = 20;
/** How deep the back of the opening is. The opening in front of it (16 px) holds a whole step walking, mounted or as a ghost. */
export const BACK_DEPTH = 4;
/** The player's box as the engine's tile check has it: x ± 12, from y down to y + 20. */
const PLAYER_HALF_WIDTH = 12;
const PLAYER_DEPTH = 20;
/** A longer step is tested at points this far apart, so it cannot pass through the back in one go. */
const SWEEP_PX = 8;

type Point = { x: number; y: number };
/** Where an arch stands: its middle, and its foot (the ground line it stands on). */
export type ArchAt = { x: number; foot: number };
export type ArchPiece = { left: number; right: number; top: number; bottom: number };

/** The arches of the map's portals (window.mapData.dungeonPortals: a list, or one keyed by name), where they are drawn. */
export function archesOnMap(raw: unknown): ArchAt[] {
  return portalsOnMap(raw).map((p) => ({ x: p.x, foot: p.foot }));
}

/** An arch's footprint: its left and right pillars, and the back of its opening. */
export function archPieces(arch: ArchAt): ArchPiece[] {
  const top = arch.foot - ARCH_DEPTH;
  return [
    { left: arch.x - ARCH_HALF_WIDTH, right: arch.x - OPENING_HALF_WIDTH, top, bottom: arch.foot },
    { left: arch.x + OPENING_HALF_WIDTH, right: arch.x + ARCH_HALF_WIDTH, top, bottom: arch.foot },
    { left: arch.x - OPENING_HALF_WIDTH, right: arch.x + OPENING_HALF_WIDTH, top, bottom: top + BACK_DEPTH },
  ];
}

function onPiece(piece: ArchPiece, at: Point): boolean {
  return at.x + PLAYER_HALF_WIDTH > piece.left && at.x - PLAYER_HALF_WIDTH < piece.right
    && at.y + PLAYER_DEPTH > piece.top && at.y < piece.bottom;
}

/**
 * Whether a step from `from` to `to` walks onto an arch. A part the player already stands on (a warp or a moved
 * portal put them there) does not block them, so they can walk off it. With no `from`, any spot on an arch is blocked.
 */
export function archBlocksStep(arches: readonly ArchAt[], from: Point | null, to: Point): boolean {
  if (arches.length === 0) return false;
  const n = from ? Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / SWEEP_PX)) : 1;
  for (const arch of arches) {
    for (const piece of archPieces(arch)) {
      if (from && onPiece(piece, from)) continue;
      for (let i = 1; i <= n; i++) {
        const at = from ? { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n } : to;
        if (onPiece(piece, at)) return true;
      }
    }
  }
  return false;
}
