// The maps this browser visited last, newest first: what the mailbox editor lists before anything is searched
// (USER REQUEST 2026-10-17: "only show recently visited maps unless the developer searches for a specific map").
// Kept in localStorage, so the list outlives a reload; without it (a private window) there is only this visit's.

const KEY = "frostfire.visitedMaps";
/** How many names are kept: more than the editor lists, as a name the server no longer has is left out there. */
const KEPT = 20;

let held: string[] | null = null;

const mapName = (map: unknown) => String(map ?? "").replace(".json", "").trim();

function read(): string[] {
  if (held) return held;
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
    held = Array.isArray(stored) ? stored.map(mapName).filter(Boolean).slice(0, KEPT) : [];
  } catch {
    held = [];
  }
  return held;
}

/** A map was arrived on: it goes to the front. */
export function rememberVisit(map: unknown): void {
  const name = mapName(map);
  if (!name) return;
  held = [name, ...read().filter((other) => other.toLowerCase() !== name.toLowerCase())].slice(0, KEPT);
  try {
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // kept for this visit only
  }
}

/** The maps visited last, newest first. */
export function recentVisits(): string[] {
  return [...read()];
}
