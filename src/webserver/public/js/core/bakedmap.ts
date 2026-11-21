let image: HTMLImageElement | null = null;
let imageMap = "";
let state: "idle" | "loading" | "ready" | "missing" = "idle";
let scale = 1;

function currentMap(): string {
  return String(window.mapData?.name ?? "").replace(/\.json$/i, "");
}

function scaleOf(img: HTMLImageElement): number {
  const tiles = Number(window.mapData?.width) || 0;
  const ratio = img.naturalWidth > 0 ? tiles / img.naturalWidth : 1, whole = Math.round(ratio);
  return whole >= 2 && Math.abs(ratio - whole) < 0.01 ? whole : 1;
}

export const DETAIL_TILES = 1024;
const DETAIL_KEEP = 24;
const detail = new Map<string, { img: HTMLImageElement; ready: boolean }>();
export function mapDetailPiece(rx: number, ry: number): HTMLImageElement | null {
  const name = currentMap(), key = `${name}:${rx},${ry}`;
  let piece = detail.get(key);
  if (!piece) {
    for (const k of detail.keys()) if (!k.startsWith(`${name}:`)) detail.delete(k);
    const img = new Image();
    piece = { img, ready: false };
    const made = piece;
    img.crossOrigin = "anonymous";
    img.onload = () => { made.ready = true; };
    img.src = `${(window as any).__assetServerUrl || ""}/worldmap?name=${encodeURIComponent(name)}&rx=${rx}&ry=${ry}`;
    detail.set(key, piece);
    if (detail.size > DETAIL_KEEP) { const oldest = detail.keys().next().value; if (oldest !== undefined) detail.delete(oldest); }
  }
  return piece.ready ? piece.img : null;
}

/** The baked image of the current map, null while it loads or when the server has none (`state` says which). */
export function bakedMap(): { image: HTMLImageElement | null; state: typeof state; map: string; scale: number } {
  const name = currentMap();
  if (name && name !== imageMap) {
    imageMap = name; image = null; state = "loading"; scale = 1;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { if (imageMap === name) { image = img; scale = scaleOf(img); state = "ready"; } };
    img.onerror = () => { if (imageMap === name) state = "missing"; };
    img.src = `${(window as any).__assetServerUrl || ""}/worldmap?name=${encodeURIComponent(name)}`;
  }
  return { image: imageMap === name ? image : null, state: name ? state : "idle", map: name, scale: imageMap === name ? scale : 1 };
}
