import { clusterNodesDebugCheckbox, clusterNodesText } from "./ui.js";

// The "Cluster Nodes" overlay of the F2 debug menu (any logged-in player, cluster mode): which node owns which block of the map.
// The engine answers a CLUSTER_DEBUG request with the block grid (engine src/cluster/nodedebug.ts); this module asks for
// it while the box is ticked, keeps the last answer, and draws it on the debug layer. It only reads: nothing here
// sends anything but the request.

const REFRESH_MS = 2000;

interface ClusterDebugData {
  cluster: boolean;
  allowed?: boolean;
  self?: string;
  map?: string;
  blockPx?: number;
  blocksX?: number;
  blocksY?: number;
  epoch?: number;
  nodes?: string[];
  cells?: number[];
  moving?: number[];
  here?: { bx: number; by: number; owner: number } | null;
}

let request: (() => void) | null = null;
let answer: ClusterDebugData | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let movingSet = new Set<number>();
/** Set while the connection is being moved to another node or is down: nothing is asked, nothing old is drawn. */
let paused = false;
/** Set while the grid of the old node is kept on screen during a switch (pauseClusterRefresh(true)): the status line says so. */
let switching = false;
let hatch: CanvasPattern | null = null;

/** The function that sends the CLUSTER_DEBUG request (the socket gives it, so this file does not import the socket). */
export function setClusterDebugRequester(send: () => void): void {
  request = send;
}

/** Asks for a fresh answer now, when the box is ticked (after a handoff or switch completed). */
export function requestClusterRefresh(): void {
  // The connection is back on a node (HANDOFF_DONE, LOAD_MAP): the poll runs again.
  paused = false;
  switching = false;
  if (!clusterNodesDebugCheckbox?.checked) return;
  request?.();
}

/**
 * A switch to another node or a disconnect began: the poll waits and the old node's answer is forgotten, so the overlay
 * does not show a node the player has left. requestClusterRefresh (after HANDOFF_DONE or LOAD_MAP) starts it again.
 * With `keepGrid` (a handoff: the player stays on the map) the last grid stays drawn, with a "switching" status, until
 * the next answer replaces it; otherwise (a disconnect, a stopped switch) it is cleared.
 */
export function pauseClusterRefresh(keepGrid = false): void {
  paused = true;
  switching = keepGrid;
  if (!keepGrid) {
    answer = null;
    movingSet = new Set();
  }
  showStatus();
}

/** The short label of a node id: ids are short names, a long one keeps its tail. */
export function shortNodeId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

/** A colour per node id that stays the same across answers: the id's hash picks the hue. */
function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return (hash * 137) % 360;
}

function showStatus(): void {
  if (!clusterNodesText) return;
  if (!clusterNodesDebugCheckbox.checked) {
    clusterNodesText.innerText = "";
    return;
  }
  if (switching && answer) {
    clusterNodesText.innerText = "Cluster: switching node";
    return;
  }
  if (!answer) {
    clusterNodesText.innerText = "Cluster: waiting for the server";
    return;
  }
  if (!answer.cluster) {
    clusterNodesText.innerText = "Cluster: off";
    return;
  }
  if (answer.allowed === false) {
    clusterNodesText.innerText = "Cluster: not available";
    return;
  }
  const nodes = answer.nodes ?? [];
  let text = `Cluster: connected to ${answer.self ?? "?"}`;
  const here = answer.here;
  if (here) {
    const owner = here.owner >= 0 ? nodes[here.owner] : null;
    const blocksX = answer.blocksX ?? 1;
    const moving = movingSet.has(here.by * blocksX + here.bx);
    text += ` | block ${here.bx},${here.by}: ${owner ?? "no owner"}${moving ? " (moving)" : ""}`;
  }
  clusterNodesText.innerText = text;
}

/** Applies the engine's CLUSTER_DEBUG_DATA packet. */
export function applyClusterDebug(data: ClusterDebugData | null): void {
  if (!data || typeof data !== "object") return;
  answer = data;
  switching = false;
  movingSet = new Set(Array.isArray(data.moving) ? data.moving : []);
  showStatus();
}

function start(): void {
  if (timer !== null) return;
  answer = null;
  showStatus();
  if (!paused) request?.();
  timer = setInterval(() => { if (!paused) request?.(); }, REFRESH_MS);
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  answer = null;
  showStatus();
}

if (clusterNodesDebugCheckbox) {
  clusterNodesDebugCheckbox.addEventListener("change", () => {
    if (clusterNodesDebugCheckbox.checked) start();
    else stop();
  });
}

/** Diagonal stripes for the blocks no node owns. */
function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  const tile = document.createElement("canvas");
  tile.width = 16;
  tile.height = 16;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.strokeStyle = "rgba(255, 255, 255, 0.35)";
  t.lineWidth = 2;
  t.beginPath();
  t.moveTo(-2, 18);
  t.lineTo(18, -2);
  t.moveTo(-2, 2);
  t.lineTo(2, -2);
  t.moveTo(14, 18);
  t.lineTo(18, 14);
  t.stroke();
  hatch = ctx.createPattern(tile, "repeat");
  return hatch;
}

/**
 * Draws the block grid on the debug layer (world coordinates, already translated and zoomed). `view` is the part of
 * the world on the screen, `zoom` the world zoom, `mapName` the map the player is on; an answer for another map is not drawn.
 */
export function drawClusterNodes(
  dbg: CanvasRenderingContext2D,
  view: { left: number; top: number; right: number; bottom: number },
  zoom: number,
  mapName: string,
  mapWidthPx: number,
  mapHeightPx: number,
): void {
  if (!clusterNodesDebugCheckbox?.checked) return;
  const data = answer;
  if (!data || !data.cluster || data.allowed === false) return;
  const size = Number(data.blockPx);
  const blocksX = Number(data.blocksX);
  const blocksY = Number(data.blocksY);
  const cells = data.cells;
  const nodes = data.nodes ?? [];
  if (!(size > 0) || !(blocksX > 0) || !(blocksY > 0) || !Array.isArray(cells)) return;
  if (String(data.map ?? "").replace(/\.json$/, "") !== String(mapName ?? "").replace(/\.json$/, "")) return;

  const scale = zoom > 0 ? zoom : 1;
  const line = 1 / scale;
  const ownerAt = (bx: number, by: number): number => (bx < 0 || by < 0 || bx >= blocksX || by >= blocksY ? -2 : (cells[by * blocksX + bx] ?? -1));
  const clipW = mapWidthPx > 0 ? mapWidthPx : blocksX * size;
  const clipH = mapHeightPx > 0 ? mapHeightPx : blocksY * size;

  const firstX = Math.max(0, Math.floor(view.left / size));
  const lastX = Math.min(blocksX - 1, Math.floor(view.right / size));
  const firstY = Math.max(0, Math.floor(view.top / size));
  const lastY = Math.min(blocksY - 1, Math.floor(view.bottom / size));

  dbg.save();
  for (let by = firstY; by <= lastY; by++) {
    for (let bx = firstX; bx <= lastX; bx++) {
      const x = bx * size;
      const y = by * size;
      const w = Math.min(size, clipW - x);
      const h = Math.min(size, clipH - y);
      if (w <= 0 || h <= 0) continue;
      const owner = ownerAt(bx, by);
      const id = owner >= 0 ? nodes[owner] : undefined;
      const moving = movingSet.has(by * blocksX + bx);

      if (id) {
        dbg.fillStyle = `hsla(${hueOf(id)}, 75%, 50%, 0.22)`;
        dbg.fillRect(x, y, w, h);
      } else {
        dbg.fillStyle = "rgba(60, 60, 60, 0.35)";
        dbg.fillRect(x, y, w, h);
        const pattern = hatchPattern(dbg);
        if (pattern) {
          dbg.fillStyle = pattern;
          dbg.fillRect(x, y, w, h);
        }
      }
      if (moving) {
        dbg.fillStyle = "rgba(255, 160, 0, 0.25)";
        dbg.fillRect(x, y, w, h);
      }

      // The block's right and bottom edges: a solid border where the neighbour has another owner, dotted where the same.
      const edges: Array<[number, number, number, number, number]> = [
        [x + w, y, x + w, y + h, ownerAt(bx + 1, by)],
        [x, y + h, x + w, y + h, ownerAt(bx, by + 1)],
      ];
      for (const [x1, y1, x2, y2, other] of edges) {
        if (other === -2) continue;
        dbg.beginPath();
        dbg.moveTo(x1, y1);
        dbg.lineTo(x2, y2);
        if (other !== owner) {
          dbg.setLineDash([]);
          dbg.strokeStyle = "rgba(0, 0, 0, 0.9)";
          dbg.lineWidth = 7 * line;
          dbg.stroke();
          dbg.strokeStyle = "rgba(255, 255, 255, 0.95)";
          dbg.lineWidth = 3 * line;
          dbg.stroke();
        } else {
          dbg.setLineDash([4 * line, 6 * line]);
          dbg.strokeStyle = "rgba(255, 255, 255, 0.5)";
          dbg.lineWidth = 1 * line;
          dbg.stroke();
        }
      }
      dbg.setLineDash([]);

      // The label sits in the middle of the part of the block on the screen, so it is readable at any zoom.
      const left = Math.max(x, view.left);
      const right = Math.min(x + w, view.right);
      const top = Math.max(y, view.top);
      const bottom = Math.min(y + h, view.bottom);
      if (right <= left || bottom <= top) continue;
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const name = moving ? `moving${id ? ` (${shortNodeId(id)})` : ""}` : id ? shortNodeId(id) : "no owner";
      dbg.textAlign = "center";
      dbg.textBaseline = "middle";
      dbg.lineJoin = "round";
      dbg.font = `bold ${18 / scale}px monospace`;
      dbg.lineWidth = 4 / scale;
      dbg.strokeStyle = "rgba(0, 0, 0, 0.85)";
      dbg.strokeText(name, cx, cy);
      dbg.fillStyle = id ? `hsl(${hueOf(id)}, 90%, 80%)` : "rgb(230, 230, 230)";
      dbg.fillText(name, cx, cy);
      dbg.font = `${12 / scale}px monospace`;
      dbg.lineWidth = 3 / scale;
      const sub = `block ${bx},${by}`;
      dbg.strokeText(sub, cx, cy + 20 / scale);
      dbg.fillStyle = "rgb(235, 235, 235)";
      dbg.fillText(sub, cx, cy + 20 / scale);
    }
  }
  dbg.restore();
}
