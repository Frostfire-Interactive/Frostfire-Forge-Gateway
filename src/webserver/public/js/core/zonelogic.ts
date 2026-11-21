export interface ClientZone {
  name: string;
  text?: string;
  music?: string;
  kind?: string;
  bbox: { x: number; y: number; w: number; h: number };
  outline: number[][][];
}

/** A map's zones as a list: the map editor keeps them by name (the key is the name), the map sends a list. */
export function zonesList(zones: ClientZone[] | Record<string, ClientZone> | null | undefined): ClientZone[] {
  if (!zones) return [];
  if (Array.isArray(zones)) return zones;
  return Object.entries(zones).map(([name, zone]) => ({ ...zone, name }));
}

/** The zones of one kind as the storms read them (`deserts`, `snowfields`): name, box and outline. */
export function zonesOfKind(zones: ClientZone[] | null | undefined, kind: string): Array<Pick<ClientZone, "name" | "bbox" | "outline">> {
  return (zones || []).filter((zone) => zone.kind === kind).map(({ name, bbox, outline }) => ({ name, bbox, outline }));
}

export function zoneMusicAction(wanted: string | null, playing: string | null, fading: readonly string[]): "keep" | "start" | "revive" | "stop" {
  if (wanted === playing) return "keep";
  if (wanted === null) return playing === null ? "keep" : "stop";
  return fading.includes(wanted) ? "revive" : "start";
}

/** How long zone music takes to fade in from silence, and to fade out to silence, in seconds. */
export const ZONE_MUSIC_FADE = 5;

export function fadePoints(from: number, to: number, seconds: number, steps = 16): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const level = to >= from ? from + (to - from) * p * p : to + (from - to) * (1 - p) * (1 - p);
    points.push([seconds * p, level]);
  }
  return points;
}

/** A zone's text is not shown again when the player goes back in within this long of leaving it. */
export const BANNER_RESHOW_MS = 10000;

function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum) / 2;
}

export function zoneArea(zone: ClientZone): number {
  return (zone.outline || []).reduce((total, ring) => total + ringArea(ring), 0);
}

function inside(zone: ClientZone, x: number, y: number): boolean {
  const b = zone.bbox;
  if (!b || x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) return false;
  let hit = false;
  for (const ring of zone.outline || []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

function containing(zones: ClientZone[] | null | undefined, x: number, y: number, keep: (zone: ClientZone) => boolean): ClientZone | null {
  let best: ClientZone | null = null, bestArea = Infinity;
  for (const zone of zones || []) {
    if (!keep(zone) || !inside(zone, x, y)) continue;
    const area = zoneArea(zone);
    // the smallest zone wins; of two the same size, the later one
    if (area <= bestArea) { best = zone; bestArea = area; }
  }
  return best;
}

function edgeDistance(zone: ClientZone, x: number, y: number): number {
  let best = Infinity;
  for (const ring of zone.outline || []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
      const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
}

export function zoneLabelPoint(zone: ClientZone, grid = 20): { x: number; y: number } {
  const b = zone.bbox;
  let best = { x: b.x + b.w / 2, y: b.y + b.h / 2 }, bestDistance = -1;
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
    const x = b.x + ((i + 0.5) * b.w) / grid, y = b.y + ((j + 0.5) * b.h) / grid;
    if (!inside(zone, x, y)) continue;
    const distance = edgeDistance(zone, x, y);
    if (distance > bestDistance) { best = { x, y }; bestDistance = distance; }
  }
  return best;
}

/** The zone a point is in: the smallest of those it is in, or null. */
export function zoneAt(zones: ClientZone[] | null | undefined, x: number, y: number): ClientZone | null {
  return containing(zones, x, y, () => true);
}

/** The music at a point: that of the smallest zone with music the point is in, or null. */
export function musicAt(zones: ClientZone[] | null | undefined, x: number, y: number): string | null {
  return containing(zones, x, y, (zone) => !!zone.music)?.music ?? null;
}

export interface BannerState {
  current: string | null;
  leftAt: Map<string, number>;
}

export function bannerStep(state: BannerState, zone: ClientZone | null, nowMs: number, opts?: { fresh?: boolean }): string | null {
  const name = zone?.name ?? null;
  if (name === state.current && !opts?.fresh) return null;
  if (state.current !== null && name !== state.current) state.leftAt.set(state.current, nowMs);
  state.current = name;
  if (!zone) return null;
  const left = state.leftAt.get(zone.name);
  if (!opts?.fresh && left !== undefined && nowMs - left < BANNER_RESHOW_MS) return null;
  return zone.text || zone.name;
}

/** The gain of zone music: the music slider (0 to 100) squared, as the ear hears it; silent when muted or in a cutscene. */
export function musicLevel(slider: number, muted: boolean, cutscene: boolean): number {
  if (muted || cutscene) return 0;
  const s = Math.max(0, Math.min(100, Number(slider) || 0)) / 100;
  return s * s;
}
