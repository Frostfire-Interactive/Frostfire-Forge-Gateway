// The dungeon editor's checks and words that need no page.

export interface MapOption { name: string; widthPx: number; heightPx: number }

/** As the server's dungeoneditor.ts NAME_MAX, used until the server's list says its own (`nameMax`). */
export const DEFAULT_NAME_MAX = 48;

/** The longest name the server takes: the one its list gives, or the default. */
export function nameMaxOf(data: any): number {
  const n = data?.nameMax;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_NAME_MAX;
}

/** What is wrong with the dungeon's map, or null: none picked, or one that is no longer among the maps. */
export function mapProblem(mapName: string, map: MapOption | undefined): string | null {
  if (map) return null;
  if (!String(mapName ?? "").trim()) return "Pick a map.";
  return `The map ${mapName} no longer exists. Pick another map.`;
}

/** A map size the server could not read is 0: no entrance fits in it. */
const unreadable = (limit: number | undefined): boolean => limit !== undefined && !(limit > 0);

/** What is wrong with one entrance coordinate on a map `limit` pixels wide or high (undefined: no map yet), or null. */
export function entranceProblem(value: unknown, limit: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return "The entrance must be whole pixels.";
  if (unreadable(limit)) return "The map's size could not be read, so no entrance fits in it. Pick another map or fix this one.";
  if (value < 0 || (limit !== undefined && value > limit - 1)) return `The entrance must be inside the map (0 to ${(limit ?? 1) - 1}).`;
  return null;
}

/** The hint under an entrance field. */
export function entranceHint(limit: number | undefined, edge: "left" | "top"): string {
  if (limit === undefined) return "Pick a map first.";
  if (unreadable(limit)) return "The map's size could not be read.";
  return `From 0 to ${limit - 1}, from the map's ${edge} edge.`;
}

/**
 * The id of the dungeon a save answer is about: the id the server sends with it, or else the one with its name
 * (the server keeps names unique, ignoring case).
 */
export function savedIdOf(msg: any, dungeons: Array<{ id: number | null; name: string }>): number | null {
  const id = msg?.id;
  if (typeof id === "number" && Number.isInteger(id) && dungeons.some((d) => d.id === id)) return id;
  const name = String(msg?.name ?? "").trim().toLowerCase();
  if (!name) return null;
  return dungeons.find((d) => String(d.name ?? "").trim().toLowerCase() === name)?.id ?? null;
}
