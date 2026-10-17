// Gathering nodes in the world (engine src/systems/gathering). USER REQUEST 2026-10-17: "Add a gathering system".
// The server sends the nodes near the player (GATHER_NODE_SPAWN, GATHER_NODE_DESPAWN); LOAD_MAP clears them and the
// server sends them again. Each node is its item's icon, standing among the characters. A click or a tap on one, or E
// beside one, asks the server to gather it (GATHER): the server checks, casts for 1 s, and answers with a notice or
// the bags. While the gathering editor shows a preview, its circle and the spots nodes would take are drawn too.
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { canvasDpr, worldToScreen } from "./worldzoom.js";
import { nearMailbox } from "./mail.js";

// `size`: how big the node is drawn, px: its picture's longest side, set per area in the gathering editor.
export interface GatherNode { id: number; x: number; y: number; item: string; icon: string | null; size: number }
export interface GatherPreview { map: string; x: number; y: number; radius: number; icon: string | null; size: number; spots: Array<{ x: number; y: number }> }

/** px: the engine's GATHER_RANGE. */
export const GATHER_RANGE = 100;
/** Drawn size of a node, px, when the server sends none (the engine's DEFAULT_SIZE). */
const DEFAULT_SIZE = 32;
/** A node's position is its anchor, half a footprint above the tile's centre (engine creatures/navgrid FOOT_H / 2). */
const TO_CENTRE = 8;

const nodes = new Map<number, GatherNode>();
const images = new Map<string, HTMLImageElement>();
let preview: GatherPreview | null = null;
/** The node the E badge is over, as last drawn (renderGatherHint): the only one whose name shows. */
let hintedId: number | null = null;

const mapName = () => String((window as any).mapData?.name ?? "").replace(".json", "").toLowerCase();

function imageOf(url: string | null): HTMLImageElement | null {
  if (!url) return null;
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function applyGatherSpawn(data: any): void {
  for (const n of Array.isArray(data?.nodes) ? data.nodes : []) {
    const id = Number(n?.id);
    if (!Number.isFinite(id)) continue;
    nodes.set(id, { id, x: Number(n.x), y: Number(n.y), item: String(n.item ?? ""), icon: n.icon ?? null, size: Number(n.size) > 0 ? Number(n.size) : DEFAULT_SIZE });
  }
}

export function applyGatherDespawn(data: any): void {
  for (const id of Array.isArray(data?.ids) ? data.ids : []) nodes.delete(Number(id));
}

export function clearGatherNodes(): void {
  nodes.clear();
}

/** The gathering editor's preview, or null to stop drawing it. */
export function setGatherPreview(next: GatherPreview | null): void {
  preview = next;
}

/** The square a node of this size is drawn in, centred on its tile. */
function boxOf(n: { x: number; y: number }, size: number) {
  const cy = n.y + TO_CENTRE;
  return { left: n.x - size / 2, top: cy - size / 2, right: n.x + size / 2, bottom: cy + size / 2 };
}

/** The node drawn under a point of the world (a click or a tap), if any. */
export function gatherNodeAt(worldX: number, worldY: number, slop = 0): GatherNode | null {
  for (const n of nodes.values()) {
    const b = boxOf(n, n.size);
    if (worldX >= b.left - slop && worldX <= b.right + slop && worldY >= b.top - slop && worldY <= b.bottom + slop) return n;
  }
  return null;
}

/** Asks the server to gather a node. It says why not, when it cannot be. */
export function gather(node: GatherNode): void {
  sendRequest({ type: "GATHER", data: { nodeId: node.id } });
}

function me(): any {
  const cache = Cache.getInstance();
  return Array.from(cache.players as Iterable<any>).find((p: any) => p.id === cachedPlayerId);
}

/** The nearest node in reach of the player, if any: the one E gathers. */
function nearestNode(): GatherNode | null {
  const p = me();
  const x = Number(p?.position?.x ?? p?.renderPosition?.x);
  const y = Number(p?.position?.y ?? p?.renderPosition?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best: GatherNode | null = null;
  let bestDistance = GATHER_RANGE;
  for (const n of nodes.values()) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= bestDistance) {
      best = n;
      bestDistance = d;
    }
  }
  return best;
}

/** E: gathers the nearest node in reach. False when there is none. */
export function gatherNearest(): boolean {
  const best = nearestNode();
  if (!best) return false;
  gather(best);
  return true;
}

const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

/**
 * The E badge over the node E would gather, in screen space, as a mailbox's and an NPC's are (mail.ts
 * renderMailboxHint). Not when E talks to an NPC or opens a mailbox instead, and not on a touch screen (a tap gathers).
 */
export function renderGatherHint(ctx: CanvasRenderingContext2D, npcNear: boolean): void {
  hintedId = null;
  if (npcNear || TOUCH || nearMailbox()) return;
  const node = nearestNode();
  if (!node) return;
  hintedId = node.id;
  const dpr = canvasDpr();
  const spot = worldToScreen(node.x, boxOf(node, node.size).top - 12);
  const x = spot.x * dpr;
  const y = spot.y * dpr;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold ${11 * dpr}px 'Comic Relief', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 1)";
  ctx.shadowBlur = 3 * dpr;
  ctx.fillText("E", x, y + 0.5 * dpr);
  ctx.restore();
}

/** Draws a node's picture in its square: the longest side at `size`, the other in proportion, standing on the square's bottom. No shadow. */
function drawIcon(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, icon: string | null, size: number, alpha: number, label?: string): void {
  const b = boxOf(at, size);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (label) {
    // the item's name under it, in white, outlined as creature names are (creature.ts)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "12px 'Comic Relief'";
    ctx.shadowColor = "black";
    ctx.shadowBlur = 2;
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeText(label, at.x, b.bottom + 4);
    ctx.fillText(label, at.x, b.bottom + 4);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }
  const img = imageOf(icon);
  if (img) {
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, at.x - w / 2, b.bottom - h, w, h);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(b.left + size / 4, b.top + size / 4, size / 2, size / 2);
  }
  ctx.restore();
}

/** The nodes, and the editor's preview spots, to stand among the characters: each with its foot and how it is drawn. */
export function standingGatherNodes(): Array<{ feet: number; draw(ctx: CanvasRenderingContext2D): void }> {
  const out: Array<{ feet: number; draw(ctx: CanvasRenderingContext2D): void }> = [];
  for (const n of nodes.values()) out.push({ feet: boxOf(n, n.size).bottom, draw: (ctx) => drawIcon(ctx, n, n.icon, n.size, 1, n.id === hintedId ? n.item : undefined) });
  if (preview && preview.map.toLowerCase() === mapName()) {
    const { icon, size } = preview;
    for (const spot of preview.spots) out.push({ feet: boxOf(spot, size).bottom, draw: (ctx) => drawIcon(ctx, spot, icon, size, 0.55) });
  }
  return out;
}

/** The preview's circle, over the world, while the gathering editor shows one on this map. */
export function renderGatherPreviewArea(ctx: CanvasRenderingContext2D): void {
  if (!preview || preview.map.toLowerCase() !== mapName()) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(preview.x, preview.y, preview.radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(120, 200, 120, 0.12)";
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(120, 220, 120, 0.9)";
  ctx.stroke();
  ctx.restore();
}
