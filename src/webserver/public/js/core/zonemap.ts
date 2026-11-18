// Zone map popup (/zone-map): the whole current map, where zone borders are drawn and edited (the game has no zone
// editing of its own). It opens from the map editor window (tileeditorbridge.ts) and talks to the game window
// (window.opener.opener, tileeditor.ts), which holds the zones. Every edit made here is sent there: one undo step of
// the map editor, the Zones layer marked unsaved, saved with the map editor's Save. What the game sends back is what
// is drawn.
//
// The messages, all of this site and of type zoneMap*:
//   game to here: zoneMapInit { map, assetServerUrl, zones, unsaved, player }, zoneMapZones { map, zones, unsaved },
//                 zoneMapPlayer { player }, zoneMapRefused { message }
//   here to game: zoneMapReady, zoneMapEdit { name, zone }, zoneMapCommand { name }, zoneMapClosed
//
// The picture is the asset server's baked image of the map (/worldmap, the one the world map shows), with its
// full-detail pieces once zoomed in close enough. Positions are in tiles; a zone's points are tile corners.
import { brandName, button, confirmDialog, el, empty, icon, iconButton, note, num, pill, screen, searchBox, toast, type IconName } from "./toolkit.js";
import { FieldRenderer } from "./toolfields.js";
import { zoneArea, zoneAt, zoneLabelPoint, zonesList, type ClientZone } from "./zonelogic.js";
import { edgeNear, makesCross, moveZone, outlineCrosses, pathCrosses, pointNear, zoneBox, ZONE_LIMITS } from "./tileeditorzones.js";
import { clampView, detailPieces, fitScale, toScreen, toTile, zoomAt, type View } from "./zonemapview.js";
import { DETAIL_TILES } from "./bakedmap.js";

interface MapInfo {
  name: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
}

type Tool = "select" | "draw";

type Drag =
  | { kind: "pan"; x: number; y: number; view: View; moved: boolean; click: (() => void) | null }
  | { kind: "zone"; name: string; start: { x: number; y: number }; from: ClientZone; now: ClientZone }
  | { kind: "point"; name: string; ring: number; index: number; from: ClientZone; now: ClientZone; added: boolean };

const TOOLS: Array<{ id: Tool; label: string; key: string; glyph: IconName; hint: string }> = [
  { id: "select", label: "Select", key: "S", glyph: "move", hint: "Click a zone to select it, drag it to move it. Drag a point to move it, click an edge to add one, right-click a point to delete it." },
  { id: "draw", label: "Draw", key: "D", glyph: "pencil", hint: "Click to place points on tile corners. Click the first point or double-click to close the zone. Backspace takes back a point, Esc stops." },
];

/** How near the cursor must be to a point or an edge to take it, in screen pixels. */
const GRAB_PX = 8;
/** How far the mouse moves with the button down before a click becomes a drag, in screen pixels. */
const DRAG_PX = 4;
/** The most full-detail pieces kept loaded (one is 4 MB once decoded). */
const DETAIL_KEEP = 30;

const sideEl = document.getElementById("zm-side")!;
const topEl = document.getElementById("zm-topbar")!;
const toolbarEl = document.getElementById("zm-toolbar")!;
const pageEl = document.getElementById("zm-page")!;

const stageEl = el("div", "zm-stage");
const canvasBox = el("div", "zm-canvas-box");
const canvas = el("canvas", "zm-canvas");
const ctx = canvas.getContext("2d")!;
const waitEl = el("div", "zm-wait");
const footEl = el("div", "zm-foot");
const footTile = el("span", "zm-foot-tile");
const footZone = el("span", "zm-foot-zone");
const footZoom = el("span", "zm-foot-zoom");
const detailsEl = el("aside", "zm-details");
detailsEl.setAttribute("aria-label", "Zone details");

const titleEl = el("h1", "tl-title", "Zone map");
const noteEl = el("span", "tl-record-note", "");
const statusEl = el("div", "zm-status");
const hintEl = el("span", "zm-hint");
const listEl = el("div", "tl-list zm-list");
const countEl = el("span", "tl-count");
const toolBtns = new Map<Tool, HTMLButtonElement>();
let saveBtn: HTMLButtonElement | null = null;

let map: MapInfo | null = null;
let server = "";
let zones: Record<string, ClientZone> = {};
let unsaved = false;
let player: { x: number; y: number } | null = null;
let view: View = { x: 0, y: 0, scale: 1 };
let fitted = false;
let tool: Tool = "select";
let selected: string | null = null;
let selectedPoint: { ring: number; index: number } | null = null;
let hover: { x: number; y: number } | null = null;
let drag: Drag | null = null;
let draft: number[][] = [];
let lastEditFrom: string | null = null;
let search = "";
let frame = 0;
let detailsKey = "";

let baked: HTMLImageElement | null = null;
let bakedState: "idle" | "loading" | "ready" | "missing" = "idle";
let bakeScale = 1;
const pieces = new Map<string, { img: HTMLImageElement; ready: boolean }>();

let audio: Array<{ value: string; label: string }> = [];
let audioState: "idle" | "loading" | "loaded" | "failed" = "idle";

const fields = new FieldRenderer({ rerender: () => renderDetails(true) });

// ------------------------------------------------------------ the game window

/** The game window: the window that opened the map editor that opened this one. Null when either has closed. */
function gameWindow(): Window | null {
  try {
    const editor = window.opener as Window | null;
    const game = editor && !editor.closed ? (editor.opener as Window | null) : null;
    return game && !game.closed ? game : null;
  } catch {
    return null;
  }
}

function post(msg: Record<string, unknown>): void {
  const game = gameWindow();
  if (!game) return;
  try {
    game.postMessage(msg, location.origin);
  } catch {
    // closed between the check and the send: the close check below closes this window
  }
}

function onMessage(e: MessageEvent): void {
  const game = gameWindow();
  if (e.origin !== location.origin || !game || e.source !== game) return;
  const msg = e.data;
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "zoneMapInit":
      start(msg);
      break;
    case "zoneMapZones":
      if (!map) break;
      // Another map is open in the game now: ask for all of it again.
      if (typeof msg.map === "string" && msg.map !== map.name) {
        post({ type: "zoneMapReady" });
        break;
      }
      takeZones(msg.zones, !!msg.unsaved);
      break;
    case "zoneMapPlayer":
      player = goodPoint(msg.player);
      schedule();
      break;
    case "zoneMapRefused":
      toast(String(msg.message || "The game did not make that change"), "error");
      break;
  }
}

function goodPoint(p: any): { x: number; y: number } | null {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

/** The map and its zones, sent by the game once this window said it was ready (and again for a new map). */
function start(msg: any): void {
  const info = msg.map ?? {};
  const name = String(info.name ?? "");
  const changed = !map || map.name !== name;
  map = {
    name,
    width: Math.max(1, Number(info.width) || 1),
    height: Math.max(1, Number(info.height) || 1),
    tilewidth: Number(info.tilewidth) || 16,
    tileheight: Number(info.tileheight) || 16,
  };
  server = String(msg.assetServerUrl || "");
  player = goodPoint(msg.player);
  if (changed) {
    selected = null;
    selectedPoint = null;
    draft = [];
    drag = null;
    fitted = false;
    loadBaked();
  }
  waitEl.hidden = true;
  for (const control of document.querySelectorAll<HTMLButtonElement>(".tl-topbar button, .zm-toolbar button")) control.disabled = false;
  takeZones(msg.zones, !!msg.unsaved);
  void loadAudio();
  fitOnce();
  paintTop();
}

/** The zones as the game has them now. A selection whose zone has gone is dropped (or follows a rename that failed). */
function takeZones(raw: unknown, isUnsaved: boolean): void {
  const next: Record<string, ClientZone> = {};
  for (const zone of zonesList(raw as any)) {
    if (!zone?.name || !Array.isArray(zone.outline)) continue;
    next[zone.name] = { ...zone, bbox: zone.bbox ?? zoneBox(zone.outline) };
  }
  zones = next;
  unsaved = isUnsaved;
  if (selected !== null && !zones[selected]) {
    selected = lastEditFrom !== null && zones[lastEditFrom] ? lastEditFrom : null;
  }
  if (selectedPoint && selected !== null) {
    const ring = zones[selected].outline[selectedPoint.ring];
    if (!ring || selectedPoint.index >= ring.length) selectedPoint = null;
  }
  paintTop();
  renderList();
  renderDetails();
  schedule();
}

/**
 * An edit, sent to the game: the zone `oldName` (null: a new zone) becomes `zone` (null: it is deleted). It is shown
 * here at once; what the game sends back replaces it, and a refused edit comes back with the reason.
 */
function commit(oldName: string | null, zone: ClientZone | null): void {
  const next = { ...zones };
  if (oldName !== null) delete next[oldName];
  const sent = zone ? { ...zone, bbox: zoneBox(zone.outline) } : null;
  if (sent) next[sent.name] = sent;
  zones = next;
  lastEditFrom = oldName;
  post({ type: "zoneMapEdit", name: oldName, zone: sent });
  renderList();
  renderDetails();
  schedule();
}

function command(name: "undo" | "redo" | "save"): void {
  // A field being typed in is put in first, so it is part of what is saved.
  const active = document.activeElement as HTMLElement | null;
  if (active && detailsEl.contains(active)) active.blur();
  post({ type: "zoneMapCommand", name });
}

function select(name: string | null): void {
  if (name === selected) return;
  selected = name;
  selectedPoint = null;
  renderList();
  renderDetails();
  schedule();
}

// ------------------------------------------------------------ the pictures

function loadBaked(): void {
  baked = null;
  bakeScale = 1;
  pieces.clear();
  if (!map) return;
  bakedState = "loading";
  const name = map.name;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (map?.name !== name) return;
    baked = img;
    const ratio = img.naturalWidth > 0 ? map.width / img.naturalWidth : 1, whole = Math.round(ratio);
    bakeScale = whole >= 2 && Math.abs(ratio - whole) < 0.01 ? whole : 1;
    bakedState = "ready";
    schedule();
  };
  img.onerror = () => {
    if (map?.name !== name) return;
    bakedState = "missing";
    schedule();
  };
  img.src = `${server}/worldmap?name=${encodeURIComponent(name)}`;
}

/** A full-detail piece (DETAIL_TILES tiles a side at a pixel a tile), loaded on first ask; null while it loads. */
function piece(rx: number, ry: number): HTMLImageElement | null {
  const key = `${rx},${ry}`;
  let entry = pieces.get(key);
  if (entry) {
    pieces.delete(key);
    pieces.set(key, entry);
  } else {
    const img = new Image();
    const made = { img, ready: false };
    entry = made;
    img.crossOrigin = "anonymous";
    img.onload = () => {
      made.ready = true;
      schedule();
    };
    img.src = `${server}/worldmap?name=${encodeURIComponent(map?.name ?? "")}&rx=${rx}&ry=${ry}`;
    pieces.set(key, made);
    while (pieces.size > DETAIL_KEEP) {
      const oldest = pieces.keys().next().value;
      if (oldest === undefined) break;
      pieces.delete(oldest);
    }
  }
  return entry.ready ? entry.img : null;
}

async function loadAudio(): Promise<void> {
  if (audioState === "loading" || audioState === "loaded") return;
  audioState = "loading";
  try {
    const res = await fetch(`${server}/audios`);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const audioName = (file: string): string => file.replace(/\.[^.]+$/, "").trim().toLowerCase();
    const seen = new Set<string>();
    audio = (Array.isArray(body?.audio) ? body.audio : [])
      .map((entry: any) => String(entry?.name ?? ""))
      .filter((file: string) => file && !seen.has(audioName(file)) && !!seen.add(audioName(file)))
      .map((file: string) => ({ value: audioName(file), label: file.replace(/\.[^.]+$/, "") }))
      .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));
    audioState = "loaded";
  } catch {
    audioState = "failed";
  }
  renderDetails(true);
}

// ------------------------------------------------------------ the view

function size(): { w: number; h: number } {
  return { w: canvasBox.clientWidth, h: canvasBox.clientHeight };
}

function fitOnce(): void {
  if (fitted || !map) return;
  const { w, h } = size();
  if (w <= 0 || h <= 0) return;
  fitted = true;
  fitMap();
}

/** The view moved by a button or a key rather than the mouse: the tile under the pointer is not known until it moves. */
function jump(next: View): void {
  view = next;
  hover = null;
  paintFoot();
  schedule();
}

function fitMap(): void {
  if (!map) return;
  const { w, h } = size();
  jump(clampView({ x: 0, y: 0, scale: fitScale(w, h, map.width, map.height) }, w, h, map.width, map.height));
}

/** The view centred on (x, y) at `scale` (kept inside the zoom limits). */
function centreOn(x: number, y: number, scale: number): void {
  if (!map) return;
  const { w, h } = size();
  jump(clampView({ x: x - w / 2 / scale, y: y - h / 2 / scale, scale }, w, h, map.width, map.height));
}

/** The view around a zone, with room about it. */
function frameZone(name: string): void {
  const zone = zones[name];
  if (!zone || !map) return;
  const { w, h } = size();
  const b = zone.bbox;
  const scale = Math.min(24, fitScale(w * 0.7, h * 0.7, Math.max(b.w, 4), Math.max(b.h, 4)));
  centreOn(b.x + b.w / 2, b.y + b.h / 2, scale);
}

function zoomBy(factor: number): void {
  if (!map) return;
  const { w, h } = size();
  jump(zoomAt(view, factor, w / 2, h / 2, w, h, map.width, map.height));
}

function resize(): void {
  const { w, h } = size();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  if (map) {
    if (!fitted) fitOnce();
    else view = clampView(view, w, h, map.width, map.height);
  }
  paintFoot();
  draw();
}

// ------------------------------------------------------------ drawing

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Why a border is refused (checkZoneEdit in tileeditorzones.ts gives the game the same words). */
const CROSSES = "A zone's border cannot cross itself";
/** The colour of a border that crosses itself, and of a next edge that would make one. */
const CROSS_RED = "#ef4444";

type Shape = { path: Path2D; label: { x: number; y: number }; area: number; crosses: boolean };
const shapes = new WeakMap<ClientZone, Shape>();
function shapeOf(zone: ClientZone): Shape {
  let shape = shapes.get(zone);
  if (!shape) {
    const path = new Path2D();
    for (const ring of zone.outline || []) {
      ring.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      path.closePath();
    }
    shape = { path, label: zoneLabelPoint(zone), area: zoneArea(zone), crosses: outlineCrosses(zone.outline || []) };
    shapes.set(zone, shape);
  }
  return shape;
}

/** The zone as drawn: while it is being dragged, where it is being dragged to. */
function shown(name: string): ClientZone | null {
  if (drag && drag.kind !== "pan" && drag.name === name) return drag.now;
  return zones[name] ?? null;
}

/** An image laid over the tiles (x, y, tw, th), only the part in view drawn. */
function drawOver(img: HTMLImageElement, x: number, y: number, tw: number, th: number, w: number, h: number): void {
  const x0 = Math.max(x, view.x), y0 = Math.max(y, view.y);
  const x1 = Math.min(x + tw, view.x + w / view.scale), y1 = Math.min(y + th, view.y + h / view.scale);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = img.naturalWidth / tw, ky = img.naturalHeight / th;
  const at = toScreen(view, x0, y0);
  ctx.drawImage(img, (x0 - x) * kx, (y0 - y) * ky, (x1 - x0) * kx, (y1 - y0) * ky, at.x, at.y, (x1 - x0) * view.scale, (y1 - y0) * view.scale);
}

function draw(): void {
  frame = 0;
  const { w, h } = size();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, w, h);
  if (!map) return;
  const W = map.width, H = map.height, s = view.scale;
  const origin = toScreen(view, 0, 0);

  // the map: its baked picture, then the full-detail pieces in view over it
  ctx.fillStyle = "#121826";
  ctx.fillRect(origin.x, origin.y, W * s, H * s);
  if (baked) {
    ctx.imageSmoothingEnabled = (baked.naturalWidth / W) * s < 1;
    drawOver(baked, 0, 0, W, H, w, h);
  }
  if (baked && bakeScale > 1) {
    ctx.imageSmoothingEnabled = s < 1;
    for (const [rx, ry] of detailPieces(view, w, h, W, H, bakeScale, DETAIL_TILES)) {
      const img = piece(rx, ry);
      if (img) drawOver(img, rx * DETAIL_TILES, ry * DETAIL_TILES, Math.min(DETAIL_TILES, W - rx * DETAIL_TILES), Math.min(DETAIL_TILES, H - ry * DETAIL_TILES), w, h);
    }
  }
  ctx.imageSmoothingEnabled = true;

  // close up, the tiles' corners, where points go
  if (s >= 16) {
    const x0 = Math.max(0, Math.floor(view.x)), x1 = Math.min(W, Math.ceil(view.x + w / s));
    const y0 = Math.max(0, Math.floor(view.y)), y1 = Math.min(H, Math.ceil(view.y + h / s));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round((x - view.x) * s) + 0.5;
      ctx.moveTo(sx, Math.max(0, origin.y));
      ctx.lineTo(sx, Math.min(h, origin.y + H * s));
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round((y - view.y) * s) + 0.5;
      ctx.moveTo(Math.max(0, origin.x), sy);
      ctx.lineTo(Math.min(w, origin.x + W * s), sy);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(origin.x) + 0.5, Math.round(origin.y) + 0.5, Math.round(W * s) - 1, Math.round(H * s) - 1);

  // the zones, the largest first so a small one inside a large one is on top
  const hoverZone = tool === "select" && !drag && hover ? zoneAt(Object.values(zones), hover.x, hover.y)?.name ?? null : null;
  const list = Object.keys(zones).map((name) => shown(name)!).filter(Boolean);
  list.sort((a, b) => shapeOf(b).area - shapeOf(a).area);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * -view.x * s, dpr * -view.y * s);
  ctx.lineJoin = "round";
  for (const zone of list) {
    const { path, crosses } = shapeOf(zone);
    const h0 = hue(zone.name), on = zone.name === selected, lit = zone.name === hoverZone;
    ctx.fillStyle = `hsla(${h0}, 75%, 60%, ${on ? 0.3 : lit ? 0.24 : 0.14})`;
    ctx.fill(path, "evenodd");
    ctx.strokeStyle = "rgba(5, 8, 14, 0.8)";
    ctx.lineWidth = (on ? 4 : 3) / s;
    ctx.stroke(path);
    // a border that crosses itself is red, so it can be found and set right
    ctx.strokeStyle = crosses ? CROSS_RED : on ? "#ffffff" : `hsla(${h0}, 85%, 70%, ${lit ? 1 : 0.85})`;
    ctx.lineWidth = (on ? 2 : 1.25) / s;
    ctx.stroke(path);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // their names, where there is room for one (the selected zone's always)
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(5, 8, 14, 0.9)";
  for (const zone of list) {
    const b = zone.bbox;
    const on = zone.name === selected;
    if (!on && (b.w * s < 40 || b.h * s < 16)) continue;
    const at = toScreen(view, shapeOf(zone).label.x, shapeOf(zone).label.y);
    if (at.x < -100 || at.y < -20 || at.x > w + 100 || at.y > h + 20) continue;
    ctx.strokeText(zone.name, at.x, at.y);
    ctx.fillStyle = on ? "#ffffff" : "rgba(241, 245, 249, 0.92)";
    ctx.fillText(zone.name, at.x, at.y);
  }

  // the selected zone's points
  const sel = selected !== null ? shown(selected) : null;
  if (sel) {
    sel.outline.forEach((ring, r) => ring.forEach(([x, y], i) => {
      const at = toScreen(view, x, y);
      if (at.x < -8 || at.y < -8 || at.x > w + 8 || at.y > h + 8) return;
      const picked = selectedPoint?.ring === r && selectedPoint.index === i;
      ctx.fillStyle = picked ? "#2ecc71" : "#0b0f17";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.fillRect(Math.round(at.x) - 4, Math.round(at.y) - 4, 8, 8);
      ctx.strokeRect(Math.round(at.x) - 3.5, Math.round(at.y) - 3.5, 7, 7);
    }));
  }

  // the zone being drawn
  if (tool === "draw") {
    const near = hover ? snap(hover) : null;
    const closes = draft.length >= 3 && hover && nearFirst(hover);
    if (draft.length) {
      ctx.beginPath();
      draft.forEach(([x, y], i) => {
        const at = toScreen(view, x, y);
        if (i) ctx.lineTo(at.x, at.y);
        else ctx.moveTo(at.x, at.y);
      });
      ctx.strokeStyle = "#2ecc71";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (near) {
        const last = toScreen(view, draft[draft.length - 1][0], draft[draft.length - 1][1]);
        const to = closes ? toScreen(view, draft[0][0], draft[0][1]) : toScreen(view, near[0], near[1]);
        const crosses = closes ? outlineCrosses([draft]) : pathCrosses([...draft, near]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(to.x, to.y);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = crosses ? CROSS_RED : "#2ecc71";
        ctx.stroke();
        ctx.setLineDash([]);
      }
      draft.forEach(([x, y], i) => {
        const at = toScreen(view, x, y);
        ctx.beginPath();
        ctx.arc(at.x, at.y, i === 0 ? (closes ? 7 : 5) : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && closes ? "#2ecc71" : "#0b0f17";
        ctx.fill();
        ctx.strokeStyle = i === 0 ? "#ffffff" : "#2ecc71";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
    if (near && !closes) {
      const at = toScreen(view, near[0], near[1]);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
  }

  // the player
  if (player) {
    const at = toScreen(view, player.x, player.y);
    ctx.beginPath();
    ctx.arc(at.x, at.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#60a5fa";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (bakedState === "missing") {
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(203, 213, 225, 0.8)";
    ctx.fillText("The asset server has no picture of this map", w / 2, 24);
  }
}

// ------------------------------------------------------------ the mouse

function snap(t: { x: number; y: number }): number[] {
  const W = map?.width ?? 0, H = map?.height ?? 0;
  return [Math.max(0, Math.min(W, Math.round(t.x))), Math.max(0, Math.min(H, Math.round(t.y)))];
}

function grab(): number {
  return GRAB_PX / view.scale;
}

function nearFirst(t: { x: number; y: number }): boolean {
  if (!draft.length) return false;
  const [fx, fy] = draft[0];
  return Math.hypot(fx - t.x, fy - t.y) <= Math.max(grab(), 0.5);
}

function tileAt(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return toTile(view, e.clientX - r.left, e.clientY - r.top);
}

/** A copy of a zone with one point put in, moved (`p`), or taken out (`p` null). */
function withPoint(zone: ClientZone, ring: number, index: number, p: number[] | null, insert = false): ClientZone {
  const outline = zone.outline.map((points, i) => {
    if (i !== ring) return points;
    const next = points.slice();
    if (insert && p) next.splice(index, 0, p);
    else if (p) next[index] = p;
    else next.splice(index, 1);
    return next;
  });
  return { ...zone, outline, bbox: zoneBox(outline) };
}

const sameOutline = (a: ClientZone, b: ClientZone) => JSON.stringify(a.outline) === JSON.stringify(b.outline);

function onDown(e: MouseEvent): void {
  if (!map) return;
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    e.preventDefault();
    drag = { kind: "pan", x: e.clientX, y: e.clientY, view, moved: false, click: null };
    return;
  }
  if (e.button !== 0) return;
  const t = tileAt(e);
  if (tool === "draw") {
    drag = { kind: "pan", x: e.clientX, y: e.clientY, view, moved: false, click: () => addDraftPoint(t) };
    return;
  }
  const sel = selected !== null ? zones[selected] : null;
  if (sel) {
    const point = pointNear(sel, t.x, t.y, grab());
    if (point) {
      selectedPoint = point;
      drag = { kind: "point", name: sel.name, ring: point.ring, index: point.index, from: sel, now: sel, added: false };
      schedule();
      return;
    }
    const edge = edgeNear(sel, t.x, t.y, grab() * 0.75);
    if (edge) {
      const ring = sel.outline[edge.ring];
      if (ring.length >= ZONE_LIMITS.maxPoints) {
        toast(`A zone has at most ${ZONE_LIMITS.maxPoints} points`, "warning");
        return;
      }
      const p = snap(t);
      const before = ring[edge.index - 1], after = ring[edge.index % ring.length];
      if ((before && before[0] === p[0] && before[1] === p[1]) || (after && after[0] === p[0] && after[1] === p[1])) return;
      const now = withPoint(sel, edge.ring, edge.index, p, true);
      selectedPoint = { ring: edge.ring, index: edge.index };
      drag = { kind: "point", name: sel.name, ring: edge.ring, index: edge.index, from: sel, now, added: true };
      schedule();
      return;
    }
  }
  const hit = zoneAt(Object.values(zones), t.x, t.y);
  if (hit) {
    select(hit.name);
    selectedPoint = null;
    drag = { kind: "zone", name: hit.name, start: t, from: zones[hit.name], now: zones[hit.name] };
    return;
  }
  drag = { kind: "pan", x: e.clientX, y: e.clientY, view, moved: false, click: () => select(null) };
}

function onMove(e: MouseEvent): void {
  if (!map) return;
  const over = e.target === canvas;
  if (over || drag) {
    hover = tileAt(e);
    paintFoot();
  }
  if (drag?.kind === "pan") {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    drag.moved = true;
    const { w, h } = size();
    view = clampView({ x: drag.view.x - dx / drag.view.scale, y: drag.view.y - dy / drag.view.scale, scale: drag.view.scale }, w, h, map.width, map.height);
    canvas.style.cursor = "grabbing";
  } else if (drag?.kind === "zone" && hover) {
    drag.now = moveZone(drag.from, Math.round(hover.x - drag.start.x), Math.round(hover.y - drag.start.y), map.width, map.height);
  } else if (drag?.kind === "point" && hover) {
    drag.now = withPoint(drag.added ? drag.now : drag.from, drag.ring, drag.index, snap(hover));
  } else if (over) {
    canvas.style.cursor = cursorAt(hover!);
  }
  schedule();
}

function cursorAt(t: { x: number; y: number }): string {
  if (tool === "draw") return "crosshair";
  const sel = selected !== null ? zones[selected] : null;
  if (sel && pointNear(sel, t.x, t.y, grab())) return "move";
  if (sel && edgeNear(sel, t.x, t.y, grab() * 0.75)) return "copy";
  if (zoneAt(Object.values(zones), t.x, t.y)) return "pointer";
  return "grab";
}

function onUp(e: MouseEvent): void {
  if (!drag) return;
  const done = drag;
  drag = null;
  if (done.kind === "pan") {
    if (!done.moved && done.click) done.click();
  } else if (done.kind === "zone") {
    if (!sameOutline(done.from, done.now)) commit(done.name, done.now);
  } else if (makesCross(done.from.outline, done.now.outline)) {
    // the point goes back where it was (a point put in on an edge goes)
    if (done.added) selectedPoint = null;
    toast(CROSSES, "warning");
  } else if (done.added || !sameOutline(done.from, done.now)) {
    commit(done.name, done.now);
  }
  if (e.target === canvas && hover) canvas.style.cursor = cursorAt(hover);
  schedule();
}

function onWheel(e: WheelEvent): void {
  if (!map) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const { w, h } = size();
  const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  view = zoomAt(view, factor, e.clientX - r.left, e.clientY - r.top, w, h, map.width, map.height);
  hover = tileAt(e);
  paintFoot();
  schedule();
}

function onContext(e: MouseEvent): void {
  e.preventDefault();
  if (tool !== "select" || selected === null) return;
  const t = tileAt(e);
  const point = pointNear(zones[selected], t.x, t.y, grab());
  if (point) deletePoint(point.ring, point.index);
}

// ------------------------------------------------------------ drawing a zone

function addDraftPoint(t: { x: number; y: number }): void {
  if (draft.length >= 3 && nearFirst(t)) {
    closeDraft();
    return;
  }
  const p = snap(t);
  const last = draft[draft.length - 1];
  if (last && last[0] === p[0] && last[1] === p[1]) return;
  if (draft.length >= 3 && draft[0][0] === p[0] && draft[0][1] === p[1]) {
    closeDraft();
    return;
  }
  if (draft.length >= ZONE_LIMITS.maxPoints) {
    toast(`A zone has at most ${ZONE_LIMITS.maxPoints} points`, "warning");
    return;
  }
  if (pathCrosses([...draft, p])) {
    toast(CROSSES, "warning");
    return;
  }
  draft.push(p);
  paintFoot();
  schedule();
}

function freeName(base = "New zone"): string {
  const taken = new Set(Object.keys(zones).map((name) => name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** The zone being drawn is closed: it is made, selected, and its name is ready to be typed over. */
function closeDraft(): void {
  if (draft.length < ZONE_LIMITS.minPoints) {
    toast(`A zone needs at least ${ZONE_LIMITS.minPoints} points`, "warning");
    return;
  }
  if (outlineCrosses([draft])) {
    toast(CROSSES, "warning");
    return;
  }
  const outline = [draft];
  const zone: ClientZone = { name: freeName(), outline, bbox: zoneBox(outline) };
  draft = [];
  commit(null, zone);
  setTool("select");
  select(zone.name);
  const input = detailsEl.querySelector<HTMLInputElement>("input[data-key='name']");
  input?.focus();
  input?.select();
}

function deletePoint(ring: number, index: number): void {
  if (selected === null) return;
  const zone = zones[selected];
  const points = zone?.outline[ring];
  if (!points) return;
  if (points.length > ZONE_LIMITS.minPoints) {
    commit(zone.name, withPoint(zone, ring, index, null));
  } else if (zone.outline.length > 1) {
    // a hole of three points: the hole goes
    const outline = zone.outline.filter((_, i) => i !== ring);
    commit(zone.name, { ...zone, outline, bbox: zoneBox(outline) });
  } else {
    toast(`A zone needs at least ${ZONE_LIMITS.minPoints} points. Delete the zone to remove it.`, "warning");
    return;
  }
  selectedPoint = null;
  schedule();
}

async function deleteZone(name: string): Promise<void> {
  if (!zones[name]) return;
  const yes = await confirmDialog({
    title: `Delete ${name}?`,
    body: "Its border, text, music and kind are removed from the map. Undo brings the zone back.",
    okLabel: "Delete zone",
  });
  if (!yes || !zones[name]) return;
  commit(name, null);
  select(null);
}

// ------------------------------------------------------------ the keyboard

function onKey(e: KeyboardEvent): void {
  if (document.querySelector("dialog[open]")) return;
  const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "s") {
    e.preventDefault();
    command("save");
    return;
  }
  if (typing || !map) return;
  if (ctrl && e.key.toLowerCase() === "z") {
    e.preventDefault();
    command(e.shiftKey ? "redo" : "undo");
    return;
  }
  if (ctrl && e.key.toLowerCase() === "y") {
    e.preventDefault();
    command("redo");
    return;
  }
  if (ctrl || e.altKey) return;
  switch (e.key) {
    case "s": case "S": setTool("select"); break;
    case "d": case "D": setTool("draw"); break;
    case "f": case "F": fitMap(); break;
    case "+": case "=": zoomBy(1.5); break;
    case "-": case "_": zoomBy(1 / 1.5); break;
    case "Escape":
      if (draft.length) draft = [];
      else if (selectedPoint) selectedPoint = null;
      else select(null);
      paintFoot();
      break;
    case "Enter":
      if (tool === "draw" && draft.length) closeDraft();
      break;
    case "Backspace":
      e.preventDefault();
      if (tool === "draw") draft.pop();
      else if (selectedPoint) deletePoint(selectedPoint.ring, selectedPoint.index);
      else if (selected !== null) void deleteZone(selected);
      paintFoot();
      break;
    case "Delete":
      if (tool === "draw" && draft.length) draft.pop();
      else if (selectedPoint) deletePoint(selectedPoint.ring, selectedPoint.index);
      else if (selected !== null) void deleteZone(selected);
      break;
    default:
      return;
  }
  schedule();
}

// ------------------------------------------------------------ the window around the map

function setTool(next: Tool): void {
  if (next !== "draw") draft = [];
  tool = next;
  for (const [id, btn] of toolBtns) btn.setAttribute("aria-checked", String(id === tool));
  hintEl.textContent = TOOLS.find((t) => t.id === tool)!.hint;
  canvas.style.cursor = tool === "draw" ? "crosshair" : "grab";
  paintFoot();
  schedule();
}

function buildSide(): void {
  const brand = el("div", "tl-brand");
  const mark = el("span", "tl-brand-mark");
  mark.appendChild(icon("flame", 18));
  const words = el("span", "tl-brand-words");
  words.append(el("span", "tl-brand-name", brandName()), el("span", "tl-brand-sub", "Zone Map"));
  brand.append(mark, words);

  const part = el("div", "zm-side-part");
  const head = el("div", "tl-list-head");
  const heading = el("h2", "tl-list-title", "Zones");
  heading.id = "zm-zones-title";
  head.append(heading, countEl);
  const find = searchBox("Find a zone", (value) => {
    search = value.trim().toLowerCase();
    renderList();
  });
  listEl.setAttribute("role", "list");
  listEl.setAttribute("aria-labelledby", heading.id);
  part.append(head, find.root, listEl);
  sideEl.append(brand, part);
}

function buildTop(): void {
  const thumb = el("span", "tl-thumb tl-thumb-lg");
  thumb.setAttribute("aria-hidden", "true");
  thumb.appendChild(icon("map", 18));
  const slot = el("span", "tl-record-thumb");
  slot.appendChild(thumb);
  const said = el("div", "tl-record-words");
  said.append(titleEl, noteEl);
  const record = el("div", "tl-record");
  record.append(slot, said);
  statusEl.setAttribute("role", "status");

  const fit = button("Whole map", () => fitMap(), { icon: "map", kind: "quiet", fold: true, tip: "Show the whole map (F)" });
  const me = button("Find me", () => {
    if (player) centreOn(player.x, player.y, Math.max(view.scale, 8));
    else toast("Your character is not on this map", "info");
  }, { icon: "target", kind: "quiet", fold: true, tip: "Go to your character" });
  const undo = iconButton("undo", "Undo (Ctrl+Z)", () => command("undo"));
  const redo = iconButton("redo", "Redo (Ctrl+Y)", () => command("redo"));
  saveBtn = button("Save", () => command("save"), { icon: "save", tip: "Save the map (Ctrl+S), as the map editor's Save does" });
  const actions = el("div", "tl-topbar-actions");
  actions.append(fit, me, el("span", "tl-topbar-rule"), undo, redo, el("span", "tl-topbar-rule"), saveBtn);
  topEl.append(record, statusEl, actions);
}

function buildToolbar(): void {
  const group = el("div", "tl-seg zm-tools");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Tool");
  for (const t of TOOLS) {
    const btn = el("button", "tl-seg-item");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.value = t.id;
    btn.append(icon(t.glyph, 15), el("span", "", t.label), el("kbd", "tl-kbd", t.key));
    btn.addEventListener("click", () => setTool(t.id));
    toolBtns.set(t.id, btn);
    group.appendChild(btn);
  }
  toolbarEl.append(group, hintEl);
}

function buildPage(): void {
  canvas.setAttribute("aria-label", "The map and its zones");
  canvasBox.append(canvas, waitEl);
  footEl.append(footTile, footZone, footZoom);
  stageEl.append(canvasBox, footEl);
  pageEl.append(stageEl, detailsEl);

  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", () => {
    if (tool === "draw" && draft.length >= ZONE_LIMITS.minPoints) closeDraft();
  });
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("mouseleave", () => {
    if (drag) return;
    hover = null;
    paintFoot();
    schedule();
  });
  new ResizeObserver(resize).observe(canvasBox);
}

function paintTop(): void {
  if (map) {
    titleEl.textContent = map.name || "Zone map";
    const total = Object.keys(zones).length;
    noteEl.textContent = `${total === 1 ? "1 zone" : `${num(total)} zones`} · ${num(map.width)} × ${num(map.height)} tiles`;
  }
  statusEl.replaceChildren(map ? (unsaved ? pill("Unsaved zones", "warning") : pill("Zones saved", "good")) : pill("Waiting for the game window", "wait"));
  saveBtn?.classList.toggle("tl-btn-primary", unsaved);
}

function paintFoot(): void {
  footTile.textContent = hover && map ? `Tile ${num(Math.floor(hover.x))}, ${num(Math.floor(hover.y))}` : "";
  const under = hover ? zoneAt(Object.values(zones), hover.x, hover.y) : null;
  footZone.textContent = tool === "draw" && draft.length
    ? `${draft.length === 1 ? "1 point" : `${draft.length} points`}${draft.length >= ZONE_LIMITS.minPoints ? " · click the first point or double-click to close" : ""}`
    : under ? under.name : "";
  const s = view.scale;
  footZoom.textContent = !map ? "" : s >= 1 ? `${s >= 10 ? Math.round(s) : s.toFixed(1)} px per tile` : `${(1 / s).toFixed(1)} tiles per px`;
}

function renderList(): void {
  const names = Object.keys(zones).sort((a, b) => a.localeCompare(b));
  countEl.textContent = names.length ? num(names.length) : "";
  const wanted = search ? names.filter((name) => name.toLowerCase().includes(search)) : names;
  listEl.replaceChildren();
  if (!map) {
    for (let i = 0; i < 5; i++) listEl.appendChild(el("div", "tl-skeleton tl-skeleton-row"));
    return;
  }
  if (!names.length) {
    empty(listEl, "map", "No zones yet", "Pick Draw (D) and click the corners of a zone on the map.");
    return;
  }
  if (!wanted.length) {
    empty(listEl, "search", "No zone matches", "");
    return;
  }
  for (const name of wanted) {
    const zone = zones[name];
    const row = el("div", "tl-list-row zm-row" + (name === selected ? " is-selected" : ""));
    row.setAttribute("role", "listitem");
    const open = el("button", "tl-list-open");
    open.type = "button";
    const swatch = el("span", "zm-swatch");
    const h0 = hue(name);
    swatch.style.background = `hsla(${h0}, 75%, 60%, 0.35)`;
    swatch.style.borderColor = `hsl(${h0}, 85%, 70%)`;
    open.append(swatch, el("span", "tl-list-name", name));
    if (zone.music) open.appendChild(icon("play", 12));
    open.addEventListener("click", () => {
      select(name);
      frameZone(name);
    });
    if (name === selected) open.setAttribute("aria-current", "true");
    row.appendChild(open);
    listEl.appendChild(row);
  }
}

function field(label: string, control: HTMLElement, hint = ""): HTMLElement {
  const wrap = el("div", "tl-field");
  const id = `zm-${label.toLowerCase()}`;
  control.id = id;
  const name = el("label", "tl-field-label", label);
  name.htmlFor = id;
  wrap.append(name, control);
  if (hint) wrap.appendChild(el("span", "tl-field-hint", hint));
  return wrap;
}

/** One of the selected zone's fields changed: an empty one is taken off the zone. */
function setField(key: "text" | "music" | "kind", value: string): void {
  if (selected === null || !zones[selected]) return;
  const zone = zones[selected];
  const next: ClientZone = { ...zone };
  const kept = value.trim();
  if (kept) next[key] = kept;
  else delete next[key];
  if ((zone[key] ?? "") === (next[key] ?? "")) return;
  commit(zone.name, next);
}

function rename(value: string, input: HTMLInputElement): void {
  if (selected === null || !zones[selected]) return;
  const zone = zones[selected];
  const name = value.trim();
  if (name === zone.name) return;
  if (!name) {
    toast("A zone needs a name", "warning");
    input.value = zone.name;
    return;
  }
  const lower = name.toLowerCase();
  if (Object.keys(zones).some((other) => other !== zone.name && other.toLowerCase() === lower)) {
    toast(`There is already a zone called ${name}`, "warning");
    input.value = zone.name;
    return;
  }
  // The selection follows the zone to its new name (and back again if the game refuses it).
  selected = name;
  commit(zone.name, { ...zone, name });
}

/** The details of the selected zone. Drawn again only when what its fields show changed, so typing is not lost. */
function renderDetails(force = false): void {
  const zone = selected !== null ? zones[selected] : null;
  const crosses = zone ? shapeOf(zone).crosses : false;
  const key = zone ? JSON.stringify([zone.name, zone.text ?? "", zone.music ?? "", zone.kind ?? "", crosses]) : "";
  const facts = detailsEl.querySelector<HTMLElement>(".zm-facts");
  if (!force && key === detailsKey && detailsEl.childElementCount) {
    if (zone && facts) facts.textContent = factsOf(zone);
    return;
  }
  detailsKey = key;
  // The field that had the focus has it again in the new details (Tab from a changed field goes on to the next one).
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  detailsEl.replaceChildren();
  queueMicrotask(() => {
    if (focused) detailsEl.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
  });
  if (!map) return;
  if (!zone) {
    empty(detailsEl, "map", "No zone selected", "Pick a zone on the map or in the list, or draw one with Draw (D).");
    return;
  }

  const head = el("div", "zm-details-head");
  head.append(el("h2", "zm-details-title", "Zone"), el("span", "zm-facts", factsOf(zone)));

  const name = el("input", "tl-input");
  name.dataset.key = "name";
  name.value = zone.name;
  name.maxLength = ZONE_LIMITS.name;
  name.spellcheck = false;
  name.addEventListener("change", () => rename(name.value, name));
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });

  const text = el("input", "tl-input");
  text.dataset.key = "text";
  text.value = zone.text ?? "";
  text.maxLength = ZONE_LIMITS.text;
  text.placeholder = zone.name;
  text.addEventListener("change", () => setField("text", text.value));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") text.blur(); });

  const music = { music: zone.music ?? "" };
  const musicField = fields.renderField({
    key: "music",
    label: "Music",
    type: "asset",
    noIcons: true,
    fallback: "play",
    hint: audioState === "failed" ? "The music list did not load." : "Plays while a player is in the zone.",
    assets: () => [{ value: "", label: "No music" }, ...audio],
  }, music, () => setField("music", String(music.music ?? "")));

  const kind = el("select", "tl-input tl-select");
  kind.dataset.key = "kind";
  const kinds = ["", "desert", "snow"];
  if (zone.kind && !kinds.includes(zone.kind)) kinds.push(zone.kind);
  for (const k of kinds) {
    const option = el("option", "", k || "None");
    option.value = k;
    option.selected = (zone.kind ?? "") === k;
    kind.appendChild(option);
  }
  kind.addEventListener("change", () => setField("kind", kind.value));

  const form = el("div", "zm-form");
  form.append(
    field("Name", name),
    field("Text", text, "Shown when a player walks in. The name is shown when this is empty."),
    musicField,
    field("Kind", kind, "A desert has sandstorms, snow has blizzards."),
  );

  const actions = el("div", "zm-details-actions");
  actions.append(
    button("Show on map", () => frameZone(zone.name), { icon: "target", kind: "quiet", small: true }),
    button("Delete zone", () => void deleteZone(zone.name), { icon: "trash", kind: "quiet-danger", small: true }),
  );
  detailsEl.append(head);
  if (crosses) {
    detailsEl.append(note(
      "This zone's border crosses itself, so part of what it goes round is left out of the zone. Drag its points until its red border no longer crosses.",
      "warning", "alert"));
  }
  detailsEl.append(form, actions);
}

function factsOf(zone: ClientZone): string {
  const points = zone.outline.reduce((total, ring) => total + ring.length, 0);
  return `${num(points)} points · ${num(zone.bbox.w)} × ${num(zone.bbox.h)} tiles`;
}

// ------------------------------------------------------------ start

function standalone(): void {
  for (const control of document.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
  waitEl.hidden = false;
  waitEl.replaceChildren();
  screen(waitEl, "plug", "This window opens from the map editor", "Open the map editor in the game and press Zones in its row of views. The zone map stays connected to your game.");
  listEl.replaceChildren();
  empty(listEl, "plug", "Not connected", "");
  statusEl.hidden = true;
}

function waiting(): void {
  for (const control of document.querySelectorAll<HTMLButtonElement>(".tl-topbar button, .zm-toolbar button")) control.disabled = true;
  waitEl.replaceChildren(el("p", "", "Waiting for the game window to send the map."), el("div", "tl-skeleton"));
  setTimeout(() => {
    if (map) return;
    waitEl.replaceChildren();
    screen(waitEl, "plug", "The game window did not answer", "Close this window and open the zone map again from the map editor, with the map editor still open in the game.");
  }, 5000);
}

buildSide();
buildTop();
buildToolbar();
buildPage();
setTool("select");
paintTop();
renderList();
renderDetails(true);
paintFoot();

if (!gameWindow()) {
  standalone();
} else {
  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", () => post({ type: "zoneMapClosed" }));
  // the map editor or the game closed: there is nothing left to draw zones for
  setInterval(() => {
    if (!gameWindow()) window.close();
  }, 1000);
  waiting();
  post({ type: "zoneMapReady" });
}
