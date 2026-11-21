import { config } from "../web/global.js";
import { getCachedImage } from "./images.js";

export interface MapMarker {
  kind: string;
  x: number;
  y: number;
  name?: string | null;
}

const ICONS: Record<string, string> = { inn: "inn", cave: "cave", house: "house", merchant: "/img/ui/ui-gold-currency.png" };

/** Where the picture of a kind of marker is fetched from. */
export function markerIconUrl(kind: string): string {
  const icon = ICONS[kind] ?? kind;
  if (icon.startsWith("/")) return icon;
  const base = (window as any).__assetServerUrl || config.ASSET_SERVER_URL;
  return `${base}/icon?name=${encodeURIComponent(icon)}`;
}

const mapNameOf = (name: unknown) => String(name ?? "").replaceAll(".json", "");
const spot = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

let heldMap = "";
let version = 0;
/** Raised each time the server sends markers: what was worked out from the last ones is out of date. */
export const markersVersion = (): number => version;
const byKind = new Map<string, MapMarker[]>();
const bySpot = new Map<string, MapMarker>();
const NONE: MapMarker[] = [];

/** The server sent what a map marks. A kind this game has no picture for is left out. */
export function setMapMarkers(data: any): void {
  heldMap = mapNameOf(data?.map);
  version++;
  byKind.clear();
  bySpot.clear();
  for (const marker of Array.isArray(data?.markers) ? data.markers : []) {
    const x = Number(marker?.x), y = Number(marker?.y);
    if (!ICONS[marker?.kind] || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const kept: MapMarker = { kind: marker.kind, x, y, name: marker.name ?? null };
    if (!byKind.has(kept.kind)) byKind.set(kept.kind, []);
    byKind.get(kept.kind)!.push(kept);
    bySpot.set(`${kept.kind}:${spot(x, y)}`, kept);
  }
  for (const kind of byKind.keys()) getCachedImage(markerIconUrl(kind));
}

/** Whether the markers held are of `map`: those of a map the player has since left are not drawn. */
const held = (map: unknown) => {
  const name = mapNameOf(map);
  return !name || name === heldMap;
};

/** The markers of one kind on `map`. The list is the one held: it is not to be changed. */
export function markersOfKind(kind: string, map: unknown): MapMarker[] {
  return held(map) ? byKind.get(kind) ?? NONE : NONE;
}

/** The marker of a kind at a spot (map px) of `map`, when there is one. */
export function markerAt(kind: string, x: number, y: number, map: unknown): MapMarker | undefined {
  return held(map) ? bySpot.get(`${kind}:${spot(x, y)}`) : undefined;
}
