export interface View {
  x: number;
  y: number;
  scale: number;
}

/** The closest the view goes: a tile is this many screen pixels a side. */
export const MAX_SCALE = 48;

/** The scale at which the whole map fits on the canvas. */
export function fitScale(viewW: number, viewH: number, mapW: number, mapH: number): number {
  if (mapW <= 0 || mapH <= 0 || viewW <= 0 || viewH <= 0) return 1;
  return Math.min(viewW / mapW, viewH / mapH);
}

/** The tile under a point of the canvas. */
export function toTile(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: view.x + sx / view.scale, y: view.y + sy / view.scale };
}

/** Where a tile position is on the canvas. */
export function toScreen(view: View, tx: number, ty: number): { x: number; y: number } {
  return { x: (tx - view.x) * view.scale, y: (ty - view.y) * view.scale };
}

/** One axis: a map narrower than the canvas is centred, a wider one keeps its edges at or past the canvas's. */
function clampAxis(start: number, visible: number, size: number): number {
  if (visible >= size) return (size - visible) / 2;
  return Math.max(0, Math.min(size - visible, start));
}

/** The view kept inside its zoom limits and over the map. */
export function clampView(view: View, viewW: number, viewH: number, mapW: number, mapH: number): View {
  const least = fitScale(viewW, viewH, mapW, mapH);
  const most = Math.max(MAX_SCALE, least);
  const scale = Math.max(least, Math.min(most, view.scale));
  return {
    x: clampAxis(view.x, viewW / scale, mapW),
    y: clampAxis(view.y, viewH / scale, mapH),
    scale,
  };
}

/** The view zoomed by `factor`, the tile under the canvas point (sx, sy) staying under it. */
export function zoomAt(view: View, factor: number, sx: number, sy: number, viewW: number, viewH: number, mapW: number, mapH: number): View {
  const least = fitScale(viewW, viewH, mapW, mapH);
  const scale = Math.max(least, Math.min(Math.max(MAX_SCALE, least), view.scale * factor));
  const at = toTile(view, sx, sy);
  return clampView({ x: at.x - sx / scale, y: at.y - sy / scale, scale }, viewW, viewH, mapW, mapH);
}

export function detailPieces(view: View, viewW: number, viewH: number, mapW: number, mapH: number, bakeScale: number, pieceTiles: number): Array<[number, number]> {
  if (bakeScale <= 1 || bakeScale * view.scale < 2) return [];
  const lastX = Math.ceil(mapW / pieceTiles) - 1, lastY = Math.ceil(mapH / pieceTiles) - 1;
  const x0 = Math.max(0, Math.floor(view.x / pieceTiles));
  const y0 = Math.max(0, Math.floor(view.y / pieceTiles));
  const x1 = Math.min(lastX, Math.ceil((view.x + viewW / view.scale) / pieceTiles) - 1);
  const y1 = Math.min(lastY, Math.ceil((view.y + viewH / view.scale) / pieceTiles) - 1);
  const pieces: Array<[number, number]> = [];
  for (let ry = y0; ry <= y1; ry++) for (let rx = x0; rx <= x1; rx++) pieces.push([rx, ry]);
  return pieces;
}
