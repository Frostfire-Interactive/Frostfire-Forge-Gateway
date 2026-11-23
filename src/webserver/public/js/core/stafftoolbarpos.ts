/** Where the floating staff panel (stafftoolbar.ts) stands, and whether it is minimized: the parts with no page in them. */

export interface PanelPoint { x: number; y: number }
export interface PanelSize { width: number; height: number }
export interface PanelState { position: PanelPoint | null; minimized: boolean }

/** How far in from the edge of the window the panel stays. */
export const PANEL_MARGIN = 8;

/** One axis: the panel's start kept between the margins. A panel bigger than the room left starts at the margin. */
function clampAxis(start: number, size: number, room: number, margin: number): number {
  const max = room - size - margin;
  if (max < margin) return margin;
  return Math.min(Math.max(start, margin), max);
}

/** The panel's top left corner moved, as little as needed, to keep the whole panel inside the window. */
export function clampPanel(point: PanelPoint, size: PanelSize, view: PanelSize, margin = PANEL_MARGIN): PanelPoint {
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  return {
    x: Math.round(clampAxis(x, size.width, view.width, margin)),
    y: Math.round(clampAxis(y, size.height, view.height, margin)),
  };
}

/** Before it has been moved: against the right edge, in the middle from top to bottom. */
export function defaultPanelPosition(size: PanelSize, view: PanelSize, margin = PANEL_MARGIN): PanelPoint {
  return clampPanel({ x: view.width - size.width - margin, y: (view.height - size.height) / 2 }, size, view, margin);
}

/** What was saved, read back. Anything that is not a saved state is the default: not moved, not minimized. */
export function parsePanelState(raw: string | null | undefined): PanelState {
  let saved: any = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  const point = saved?.position;
  const position = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  return { position, minimized: saved?.minimized === true };
}

export function serializePanelState(state: PanelState): string {
  return JSON.stringify({ position: state.position, minimized: state.minimized });
}
