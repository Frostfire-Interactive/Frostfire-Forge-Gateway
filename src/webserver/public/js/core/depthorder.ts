export type Depth = {
  /** World y of the line the character touches the ground at. */
  feet: number;
  /** The viewer's own character: on top of anyone standing on the very same line. */
  own?: boolean;
  /** Something set in the world (a summoning stone): behind anyone standing on the very same line. */
  prop?: boolean;
};

/** x: the middle of the character, when known. draw paints it on the given context, the scene when none is given. */
export type Standing = Depth & { x?: number; draw: (into?: CanvasRenderingContext2D) => void };

export const PLAYER_FEET = 16;

const BODY = { halfWidth: 12, up: 18, down: 21 };

const order = (a: Depth, b: Depth) =>
  Math.round(a.feet) - Math.round(b.feet) || Number(!!b.prop) - Number(!!a.prop) || Number(!!a.own) - Number(!!b.own);

export function backToFront<T extends Depth>(standing: T[]): T[] {
  return standing.sort(order);
}

/** The one backToFront would put last: on top where they overlap. */
export function frontmost<T extends Depth>(standing: T[]): T | undefined {
  let top: T | undefined;
  for (const s of standing) if (!top || order(top, s) <= 0) top = s;
  return top;
}

export function clicked<T extends Depth & { x: number; y: number }>(inReach: T[], x: number, y: number): T | undefined {
  const onBody = inReach.filter((c) => Math.abs(x - c.x) <= BODY.halfWidth && y >= c.y - BODY.up && y <= c.y + BODY.down);
  if (onBody.length > 0) return frontmost(onBody);
  let nearest: T | undefined;
  let nearestSq = Infinity;
  for (const c of inReach) {
    const distSq = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (distSq < nearestSq) {
      nearest = c;
      nearestSq = distSq;
    }
  }
  return nearest;
}
