import type { ClientZone } from "./zonelogic.js";
import { ringAnd, ringMinus, ringRelation } from "./zoneoverlap.js";

/** A position in pixels as the nearest tile corner, in tiles. */
export function snapPoint(px: number, py: number, tileW: number, tileH: number): [number, number] {
  return [Math.round(px / (tileW || 16)), Math.round(py / (tileH || 16))];
}

/** The box around a zone's points. */
export function zoneBox(outline: number[][][]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of outline) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The point of a zone within `radiusTiles` of (x, y), the nearest one; null when none is. */
export function pointNear(zone: ClientZone, x: number, y: number, radiusTiles: number): { ring: number; index: number } | null {
  let best: { ring: number; index: number } | null = null, bestD = radiusTiles * radiusTiles;
  (zone.outline || []).forEach((ring, r) => ring.forEach(([px, py], i) => {
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d <= bestD) { bestD = d; best = { ring: r, index: i }; }
  }));
  return best;
}

function segmentDistance2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
}

/** The edge of a zone within `radiusTiles` of (x, y): `index` is where a new point on it goes in the ring. */
export function edgeNear(zone: ClientZone, x: number, y: number, radiusTiles: number): { ring: number; index: number } | null {
  let best: { ring: number; index: number } | null = null, bestD = radiusTiles * radiusTiles;
  (zone.outline || []).forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const d = segmentDistance2(x, y, ax, ay, bx, by);
      if (d <= bestD) { bestD = d; best = { ring: r, index: i + 1 }; }
    }
  });
  return best;
}

/** A copy of a zone moved by (dx, dy) tiles, held back so every point stays in a map of the given size. */
export function moveZone(zone: ClientZone, dx: number, dy: number, widthTiles: number, heightTiles: number): ClientZone {
  const box = zoneBox(zone.outline || []);
  const mx = Math.max(-box.x, Math.min(widthTiles - (box.x + box.w), dx));
  const my = Math.max(-box.y, Math.min(heightTiles - (box.y + box.h), dy));
  const outline = (zone.outline || []).map((ring) => ring.map(([x, y]) => [x + mx, y + my]));
  return { ...zone, outline, bbox: zoneBox(outline) };
}

/** Moves every zone by (dx, dy) tiles in place: the map grew to the left or up. */
export function shiftZones(zones: Record<string, ClientZone>, dx: number, dy: number): void {
  for (const zone of Object.values(zones)) {
    zone.outline = (zone.outline || []).map((ring) => ring.map(([x, y]) => [x + dx, y + dy]));
    zone.bbox = zoneBox(zone.outline);
  }
}

/** Whether a point is inside a ring or on its border. */
function insideOrOn(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const onLine = (xj - xi) * (py - yi) === (yj - yi) * (px - xi);
    if (onLine && px >= Math.min(xi, xj) && px <= Math.max(xi, xj) && py >= Math.min(yi, yj) && py <= Math.max(yi, yj)) return true;
    if ((yi > py) !== (yj > py) && px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/** Whether every point of a ring, and the middle of every edge, is inside another ring or on its border. */
function ringWithin(ring: number[][], around: number[][]): boolean {
  return ring.every(([x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length];
    return insideOrOn(x, y, around) && insideOrOn((x + nx) / 2, (y + ny) / 2, around);
  });
}

function ringArea(ring: number[][]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(twice) / 2;
}

export function fillHoles(outline: number[][][]): number[][][] {
  const largestFirst = outline.map((_, i) => i).sort((a, b) => ringArea(outline[b]) - ringArea(outline[a]));
  const kept: number[] = [];
  for (const i of largestFirst) if (!kept.some((k) => ringWithin(outline[i], outline[k]))) kept.push(i);
  return outline.filter((_, i) => kept.includes(i));
}

/** What a save sends of the zones: undefined when they did not change, else every zone without its box or holes. */
export function buildSaveZones(zones: Record<string, ClientZone> | null | undefined, dirty: boolean): ClientZone[] | undefined {
  if (!dirty) return undefined;
  return Object.entries(zones || {}).map(([name, zone]) => {
    const { bbox: _box, ...data } = zone as any;
    return { ...data, name, outline: fillHoles(zone.outline || []) } as ClientZone;
  });
}

/** The limits the server checks a zone against (ZONE_LIMITS in the engine's modules/zones.ts). */
export const ZONE_LIMITS = { minPoints: 3, maxPoints: 512, name: 64, text: 80, kind: 32, music: 128 };

const tooLong = (value: unknown, max: number) => typeof value === "string" && value.trim().length > max;

export function zoneProblems(zones: Record<string, ClientZone>): string[] {
  const seen = new Set<string>();
  return Object.entries(zones).filter(([name, zone]) => {
    const key = name.trim().toLowerCase();
    const twice = seen.has(key);
    seen.add(key);
    return twice || !key || name.trim().length > ZONE_LIMITS.name
      || tooLong(zone.text, ZONE_LIMITS.text) || tooLong(zone.music, ZONE_LIMITS.music) || tooLong(zone.kind, ZONE_LIMITS.kind)
      || !zone.outline?.length
      || zone.outline.some((ring) => !Array.isArray(ring) || ring.length < ZONE_LIMITS.minPoints || ring.length > ZONE_LIMITS.maxPoints);
  }).map(([name]) => name);
}

function side(a: number[], b: number[], c: number[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Whether c, on the line through a and b, is between them (the ends included). */
function between(a: number[], b: number[], c: number[]): boolean {
  return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
}

/** Whether the edges a-b and c-d meet anywhere, their ends included. */
function edgesMeet(a: number[], b: number[], c: number[], d: number[]): boolean {
  const s1 = side(c, d, a), s2 = side(c, d, b), s3 = side(a, b, c), s4 = side(a, b, d);
  if (((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) && ((s3 > 0 && s4 < 0) || (s3 < 0 && s4 > 0))) return true;
  return (s1 === 0 && between(c, d, a)) || (s2 === 0 && between(c, d, b)) || (s3 === 0 && between(a, b, c)) || (s4 === 0 && between(a, b, d));
}

function foldsBack(from: number[], at: number[], to: number[]): boolean {
  const same = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];
  if (same(from, at) || same(at, to)) return true;
  return side(from, at, to) === 0 && (from[0] - at[0]) * (to[0] - at[0]) + (from[1] - at[1]) * (to[1] - at[1]) > 0;
}

function edgesCross(rings: number[][][], closed: boolean): boolean {
  const edges: Array<{ ring: number; index: number; a: number[]; b: number[] }> = [];
  rings.forEach((ring, r) => {
    const count = closed ? ring.length : ring.length - 1;
    for (let i = 0; i < count; i++) edges.push({ ring: r, index: i, a: ring[i], b: ring[(i + 1) % ring.length] });
  });
  for (let p = 0; p < edges.length; p++) {
    for (let q = p + 1; q < edges.length; q++) {
      const e = edges[p], f = edges[q];
      if (e.ring === f.ring) {
        // f follows e (e ends where f starts), or e follows f round the end of the ring: they share that point
        if (f.index === e.index + 1) {
          if (foldsBack(e.a, e.b, f.b)) return true;
          continue;
        }
        if (closed && e.index === 0 && f.index === rings[e.ring].length - 1) {
          if (foldsBack(f.a, f.b, e.b)) return true;
          continue;
        }
      }
      if (edgesMeet(e.a, e.b, f.a, f.b)) return true;
    }
  }
  return false;
}

export function outlineCrosses(outline: number[][][]): boolean {
  return edgesCross((outline || []).map((ring) => {
    const first = ring[0], last = ring[ring.length - 1];
    return ring.length > 3 && first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  }), true);
}

/** Whether the points of a zone being drawn cross, as drawn so far: the edge that will close it is not drawn yet. */
export function pathCrosses(points: number[][]): boolean {
  return edgesCross([points], false);
}

export function makesCross(before: number[][][] | null, after: number[][][]): boolean {
  return outlineCrosses(after) && !(before && outlineCrosses(before));
}

export function checkZoneEdit(zones: Record<string, ClientZone>, oldName: string | null, zone: ClientZone | null, mapW: number, mapH: number): string | null {
  if (oldName !== null && !zones[oldName]) return "That zone is no longer there";
  if (!zone) return oldName === null ? "Nothing to change" : null;
  const name = typeof zone.name === "string" ? zone.name.trim() : "";
  if (!name) return "A zone needs a name";
  if (name.length > ZONE_LIMITS.name) return `A zone name is at most ${ZONE_LIMITS.name} characters`;
  const key = name.toLowerCase();
  if (Object.keys(zones).some((other) => other !== oldName && other.trim().toLowerCase() === key)) return `A zone named ${name} already exists`;
  if (!Array.isArray(zone.outline) || !zone.outline.length) return "A zone needs an outline";
  for (const ring of zone.outline) {
    if (!Array.isArray(ring) || ring.length < ZONE_LIMITS.minPoints) return `A zone needs at least ${ZONE_LIMITS.minPoints} points`;
    if (ring.length > ZONE_LIMITS.maxPoints) return `A zone has at most ${ZONE_LIMITS.maxPoints} points`;
    const inside = ring.every((p) => Array.isArray(p) && p.length === 2
      && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[1] >= 0 && p[0] <= mapW && p[1] <= mapH);
    if (!inside) return "Every point of a zone is on a tile corner inside the map";
  }
  // a zone saved crossing before this check is let through, so it can be renamed and its points moved to set it right
  if (makesCross(oldName !== null ? zones[oldName].outline : null, zone.outline)) return "A zone's border cannot cross itself";
  if (tooLong(zone.text, ZONE_LIMITS.text)) return `A zone's text is at most ${ZONE_LIMITS.text} characters`;
  if (tooLong(zone.music, ZONE_LIMITS.music)) return `A zone's music name is at most ${ZONE_LIMITS.music} characters`;
  if (tooLong(zone.kind, ZONE_LIMITS.kind)) return `A zone's kind is at most ${ZONE_LIMITS.kind} characters`;
  return null;
}

export function fitZoneEdit(zones: Record<string, ClientZone>, oldName: string | null, zone: ClientZone): ClientZone | string {
  const others = Object.entries(zones).filter(([name]) => name !== oldName).map(([, other]) => other);
  let outline = zone.outline;
  // A cut can move a point a little past where it was, onto a zone it was clear of: a few passes fit that too
  for (let pass = 0, changed = true; changed && pass < 3; pass++) {
    changed = false;
    for (const other of others) {
      for (const ring2 of other.outline || []) {
        const next: number[][][] = [];
        for (const ring of outline) {
          if (ringRelation(ring, ring2) !== "overlap") { next.push(ring); continue; }
          const half = ringArea(ring) / 2;
          const minus = ringMinus(ring, ring2), and = ringAnd(ring, ring2);
          const outside = minus ? minus.reduce((sum, piece) => sum + ringArea(piece), 0) >= half : !!and && and.reduce((sum, piece) => sum + ringArea(piece), 0) < half;
          const cut = outside ? minus : and;
          if (!cut || cut.some((piece) => piece.length > ZONE_LIMITS.maxPoints)) return `The zone cannot be cut to the edge of ${other.name} in whole tiles`;
          next.push(...cut);
          changed = true;
        }
        outline = next;
      }
    }
  }
  if (!outline.length) return "The zone would be left with nothing once fitted to the other zones";
  return { ...zone, outline, bbox: zoneBox(outline) };
}
