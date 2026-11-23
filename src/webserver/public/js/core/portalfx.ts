import { sendRequest, cachedPlayerId } from "./socket.js";
import { loadTilesets } from "./map.js";
import Cache from "./cache.js";
import { PLAYER_FEET } from "./depthorder.js";
import { queueGlow, queueLight } from "./glowqueue.js";
import { getAmbientLevel, getNightFactor } from "./ambience.js";
import {
  PEEK_HALF_H, PEEK_HALF_W, PEEK_RATE_MS, applyPeekFrame, inMirror, mirrorPose, peekChanges, portalsOnMap, wantedPeeks,
  type PeekFigure, type PlacedPortal,
} from "./portalpeek.js";
import { transit } from "./portaltransit.js";

/** What a portal on this map shows (DUNGEON_PORTAL_PREVIEW_DATA, asked for by name): the far place's map, the spot,
 *  its tilesets and the portal's colour. A dungeon's entrance, a teleport's place, or an exit portal's spot outside. */
interface PortalPreview {
  portal?: string; dungeonId?: number; map: string | null; x?: number; y?: number;
  tilewidth?: number; tileheight?: number; tilesets?: any[]; color?: string;
}

/** The far side, one map pixel per pixel: seen through the opening, wavering a little. */
interface Picture { data: Uint8ClampedArray; width: number; height: number }

// The far side of each portal on this map, by name: its tiles round the far place (the peek box, map pixels), and the
// picture the opening shows; null while it is asked for or drawn, or when there is none.
const bases = new Map<string, HTMLCanvasElement>();
const pictures = new Map<string, Picture | null>();
// Answers asked for before the map changed, or before the previews were forgotten, are dropped.
let generation = 0;
const PICTURE_TILES = 30;
const CHUNK_TILES: Record<number, number> = { 16: 64, 32: 32, 64: 16 };
const SKIPPED_LAYER = /collision|nopvp|no-pvp|shadow/i;

// The arch's size, until its image loads and gives the real one.
let W = 94, H = 114;

/** Answers the ask a portal made: draws its far side for the inside of the portal. */
export async function setPortalPreview(data: PortalPreview): Promise<void> {
  const name = typeof data?.portal === "string" ? data.portal : null;
  if (name === null) return;
  if (typeof data.color === "string" && COLOUR_CODE.test(data.color)) colours.set(name, data.color.toLowerCase());
  if (!data.map || !Array.isArray(data.tilesets) || !data.tilesets.length) return;
  const asked = generation;
  try {
    const base = await drawFarSide(data);
    if (asked !== generation || !base) return;
    bases.set(name, base);
    pictures.set(name, blurred(base));
    live.delete(name);
  } catch (error) {
    console.warn(`The picture inside portal ${name} could not be drawn:`, error);
  }
}

async function drawFarSide(data: PortalPreview): Promise<HTMLCanvasElement | null> {
  const tw = Number(data.tilewidth) || 32, th = Number(data.tileheight) || 32;
  const cs = CHUNK_TILES[tw] || 32;
  const tilesets = data.tilesets!;
  const images = await loadTilesets(tilesets);
  const left = Math.floor(Number(data.x) / tw) - PICTURE_TILES / 2;
  const top = Math.floor(Number(data.y) / th) - PICTURE_TILES / 2;

  const base = (window as any).__assetServerUrl || "";
  const chunks = new Map<string, any>();
  for (let cy = Math.floor(Math.max(0, top) / cs); cy <= Math.floor((top + PICTURE_TILES - 1) / cs); cy++) {
    for (let cx = Math.floor(Math.max(0, left) / cs); cx <= Math.floor((left + PICTURE_TILES - 1) / cs); cx++) {
      const response = await fetch(`${base}/map-chunk?map=${encodeURIComponent(data.map!)}&x=${cx}&y=${cy}&size=${cs}`);
      if (response.ok) chunks.set(`${cx}-${cy}`, await response.json());
    }
  }
  if (!chunks.size) return null;

  const full = document.createElement("canvas");
  full.width = PICTURE_TILES * tw;
  full.height = PICTURE_TILES * th;
  const g = full.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = false;

  const layerNames = new Map<string, number>();
  for (const chunk of chunks.values()) {
    for (const layer of chunk.layers ?? []) {
      if (!SKIPPED_LAYER.test(String(layer.name ?? ""))) layerNames.set(String(layer.name), Number(layer.zIndex) || 0);
    }
  }
  const order = [...layerNames].sort((a, b) => a[1] - b[1]).map(([name]) => name);

  for (const name of order) {
    for (let ty = top; ty < top + PICTURE_TILES; ty++) {
      for (let tx = left; tx < left + PICTURE_TILES; tx++) {
        if (tx < 0 || ty < 0) continue;
        const chunk = chunks.get(`${Math.floor(tx / cs)}-${Math.floor(ty / cs)}`);
        const layer = chunk?.layers?.find((l: any) => l.name === name);
        if (!layer) continue;
        const width = Number(layer.width ?? chunk.width) || cs;
        const gid = Number(layer.data?.[(ty - Number(chunk.startY ?? Math.floor(ty / cs) * cs)) * width + (tx - Number(chunk.startX ?? Math.floor(tx / cs) * cs))]) || 0;
        if (!gid) continue;
        const raw = gid & 0x0FFFFFFF;
        const index = tilesets.findIndex((t: any) => t.firstgid <= raw && raw < t.firstgid + t.tilecount);
        const tileset = tilesets[index], image = images[index];
        if (!tileset || !image) continue;
        const local = raw - tileset.firstgid;
        const perRow = Math.floor(tileset.imagewidth / tileset.tilewidth) || 1;
        g.drawImage(image,
          (local % perRow) * tileset.tilewidth, Math.floor(local / perRow) * tileset.tileheight, tileset.tilewidth, tileset.tileheight,
          (tx - left) * tw, (ty - top) * th, tw, th);
      }
    }
  }

  // Only the box round the far place is kept: the opening shows no more, and the live players are drawn on it.
  // It is kept as a mirror shows it, flipped top to bottom about the far place.
  const crop = document.createElement("canvas");
  crop.width = PEEK_HALF_W * 2;
  crop.height = PEEK_HALF_H * 2;
  const c = crop.getContext("2d");
  if (!c) return null;
  c.imageSmoothingEnabled = false;
  c.setTransform(...mirrorTransform(crop.height));
  c.drawImage(full, Number(data.x) - left * tw - PEEK_HALF_W, Number(data.y) - top * th - PEEK_HALF_H, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop;
}

/** The transform that flips a crop this high top to bottom about its middle, the far place; left and right kept. */
export function mirrorTransform(height: number): [number, number, number, number, number, number] {
  return [1, 0, 0, -1, 0, height];
}

// Where a picture is made: shrunk smoothly to one picture pixel per pixel of the opening's finer grid (PICTURE_DETAIL),
// so the far side reads as a clean, distant view, and softened a little, as if seen through the portal's haze.
let shrink: CanvasRenderingContext2D | null = null;
function blurred(source: HTMLCanvasElement): Picture | null {
  const scale = PICTURE_DETAIL / PICTURE_ZOOM;
  shrink ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!shrink) return null;
  const small = shrink.canvas;
  const w = Math.max(1, Math.round(source.width * scale)), h = Math.max(1, Math.round(source.height * scale));
  if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
  shrink.clearRect(0, 0, w, h);
  shrink.imageSmoothingEnabled = true;
  shrink.imageSmoothingQuality = "high";
  shrink.filter = `blur(${PICTURE_BLUR}px)`;
  shrink.drawImage(source, 0, 0, w, h);
  shrink.filter = "none";
  return { data: shrink.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** After a dungeon or a portal is saved in an editor: each portal asks again for its picture and colour. */
export function forgetPortalPreviews(): void {
  generation++;
  bases.clear();
  pictures.clear();
  colours.clear();
  live.clear();
  composed.clear();
}

/** A new map: nothing of the last one's portals is kept. Its feeds end with the map on the server too. */
export function resetPortalFx(): void {
  forgetPortalPreviews();
  peeks.clear();
  figures.clear();
  animatedAt.clear();
  wakes.clear();
}

/* Portal peek feed: the live players on the far side of the awake portals (at most two), drawn as their sprites on the
   far side's tiles, the picture made again at the feed's rate while anyone is there. */

const peeks = new Set<string>();
const figures = new Map<string, Map<string, PeekFigure>>();
const live = new Map<string, { picture: Picture | null; at: number }>();
// When each portal's far-side figures last stepped on (performance.now() ms).
const animatedAt = new Map<string, number>();
const PEEK_SLACK_MS = 4;
let layered: typeof import("./layeredAnimation.js") | null = null;

/** Starts the feed of the portals the player is near, and stops the others. */
function updatePeeks(portals: PlacedPortal[]): void {
  let at: { x: number; y: number } | null = null;
  for (const pl of Cache.getInstance().players) {
    if (pl.id !== cachedPlayerId) continue;
    at = pl.renderPosition ?? pl.position ?? null;
    break;
  }
  const { on, off } = peekChanges(peeks, wantedPeeks(portals, at, WAKE_FAR));
  for (const name of off) {
    peeks.delete(name);
    figures.delete(name);
    live.delete(name);
    sendRequest({ type: "DUNGEON_PORTAL_PEEK", data: { portal: name, on: false } });
  }
  for (const name of on) {
    peeks.add(name);
    sendRequest({ type: "DUNGEON_PORTAL_PEEK", data: { portal: name, on: true } });
  }
}

/** A frame of a portal's feed (DUNGEON_PORTAL_PEEK_DATA): the players there, and the looks of the new ones. */
export function setPortalPeek(data: any): void {
  const name = typeof data?.portal === "string" ? data.portal : "";
  if (!peeks.has(name)) return;
  let shown = figures.get(name);
  if (!shown) { shown = new Map(); figures.set(name, shown); }
  const { newLooks } = applyPeekFrame(shown, data);
  for (const [id, f] of shown) {
    const pose = mirrorPose(f.d, f.m);
    if (newLooks.includes(id)) void dress(f);
    else if (f.anim && f.pose !== pose) {
      f.pose = pose;
      void layered?.changeLayeredAnimation(f.anim, pose);
    }
  }
}

/** A figure's sprites, as SPAWN_PLAYER builds a player's. */
async function dress(f: PeekFigure): Promise<void> {
  const look = f.look;
  if (!look) return;
  try {
    layered ??= await import("./layeredAnimation.js");
    const pose = mirrorPose(f.d, f.m);
    const anim = await layered.initializeLayeredAnimation(
      look.mountSprite || null, look.bodySprite || null, look.headSprite || null, look.armorHelmetSprite || null,
      look.armorShoulderguardsSprite || null, look.armorNeckSprite || null, look.armorHandsSprite || null, look.armorChestSprite || null,
      look.armorFeetSprite || null, look.armorLegsSprite || null, look.armorWeaponSprite || null, pose);
    if (f.look !== look) return;
    f.anim = anim;
    f.pose = pose;
    const now = mirrorPose(f.d, f.m);
    if (now !== pose) { f.pose = now; void layered.changeLayeredAnimation(anim, now); }
  } catch (error) {
    console.warn("A player behind a portal could not be drawn:", error);
  }
}

/** Someone walking through a portal (named `portal`) whose feet are past its plane: their sprites, and where they are
 *  (map pixels, as players are placed). */
export interface PortalWalker { portal: string; anim: any; x: number; y: number }
let walkers = new Map<string, PortalWalker[]>();
// the players (ids) a trip through a portal draws now: not on any portal's picture of the far side as well
let travelling: ReadonlySet<string> = new Set();

/** This frame's walkers through the portals: each is drawn in its portal's opening, on its picture, where they are.
 *  `hidden` are the players a trip draws now (TransitTracker.travellers), left off the pictures of the far side. */
export function setPortalWalkers(list: readonly PortalWalker[], hidden: ReadonlySet<string> = new Set()): void {
  if (hidden.size !== travelling.size || [...hidden].some((id) => !travelling.has(id))) live.clear();
  travelling = hidden;
  walkers = new Map();
  for (const w of list) {
    if (!w.anim) continue;
    let here = walkers.get(w.portal);
    if (!here) walkers.set(w.portal, (here = []));
    here.push(w);
  }
  if (walkers.size && !layered) void import("./layeredAnimation.js").then((m) => { layered ??= m; });
}

/** Where on a picture of the portal standing at (x, foot) a point of the map near it falls: the opening shows the
 *  picture's pixel there (drawPortal), so what is drawn there is seen where it is. */
export function onPicture(portal: { x: number; foot: number }, at: { x: number; y: number }, box: { left: number; right: number }, w: number, h: number): { x: number; y: number } {
  const left = Math.round(portal.x - w / 2), top = Math.round(portal.foot - h);
  return {
    x: PEEK_HALF_W + at.x - left - (box.left + box.right + 1) / 2,
    y: PEEK_HALF_H + at.y - top - h,
  };
}

// The far side of a portal whose picture has not come (or that shows none): the opening's own dark.
let blank: Picture | null = null;
function blankPicture(): Picture | null {
  if (!blank) {
    const c = document.createElement("canvas");
    c.width = PEEK_HALF_W * 2;
    c.height = PEEK_HALF_H * 2;
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "rgb(24, 20, 28)";
    g.fillRect(0, 0, c.width, c.height);
    blank = blurred(c);
  }
  return blank;
}

/** Lays `sprite` over `on` with its top left at (x, y), as a canvas draws one picture over another; what falls past
 *  the edge is left off. Both are as getImageData gives them (not premultiplied). */
export function layOn(on: Picture, sprite: Picture, x: number, y: number): void {
  const out = on.data, src = sprite.data;
  const x0 = Math.max(0, -x), y0 = Math.max(0, -y);
  const x1 = Math.min(sprite.width, on.width - x), y1 = Math.min(sprite.height, on.height - y);
  for (let sy = y0; sy < y1; sy++) {
    let i = (sy * sprite.width + x0) * 4, o = ((y + sy) * on.width + x + x0) * 4;
    for (let sx = x0; sx < x1; sx++, i += 4, o += 4) {
      const a = src[i + 3]!;
      if (a === 0) continue;
      if (a === 255) { out[o] = src[i]!; out[o + 1] = src[i + 1]!; out[o + 2] = src[i + 2]!; continue; }
      const k = a / 255;
      out[o] = out[o]! + (src[i]! - out[o]!) * k;
      out[o + 1] = out[o + 1]! + (src[i + 1]! - out[o + 1]!) * k;
      out[o + 2] = out[o + 2]! + (src[i + 2]! - out[o + 2]!) * k;
    }
  }
}

// Each sprite frame (and the shadow at a figure's feet) as it is laid on a picture: grown to the picture's grid and
// softened as the picture is (blurred), with room round it for the softening. Made once each, so a picture with
// figures on it is its far side's picture with these laid over, not drawn and read back from a canvas again.
const SPRITE_PAD = 3;
const sprites = new WeakMap<object, Picture | null>();
let grow: CanvasRenderingContext2D | null = null;
function softened(image: CanvasImageSource, w: number, h: number): Picture | null {
  const scale = PICTURE_DETAIL / PICTURE_ZOOM;
  grow ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!grow) return null;
  const c = grow.canvas;
  const gw = Math.max(1, Math.round(w * scale)) + SPRITE_PAD * 2, gh = Math.max(1, Math.round(h * scale)) + SPRITE_PAD * 2;
  if (c.width !== gw || c.height !== gh) { c.width = gw; c.height = gh; }
  grow.clearRect(0, 0, gw, gh);
  grow.imageSmoothingEnabled = true;
  grow.imageSmoothingQuality = "high";
  grow.filter = `blur(${PICTURE_BLUR}px)`;
  grow.drawImage(image, SPRITE_PAD, SPRITE_PAD, gw - SPRITE_PAD * 2, gh - SPRITE_PAD * 2);
  grow.filter = "none";
  return { data: grow.getImageData(0, 0, gw, gh).data, width: gw, height: gh };
}
function spriteOf(image: HTMLImageElement): Picture | null {
  if (!sprites.has(image)) sprites.set(image, softened(image, image.naturalWidth, image.naturalHeight));
  return sprites.get(image) ?? null;
}
let shadow: Picture | null | undefined;
function shadowSprite(): Picture | null {
  if (shadow === undefined) {
    const c = document.createElement("canvas");
    c.width = 30;
    c.height = 10;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "rgba(0, 0, 0, 0.35)";
      g.beginPath();
      g.ellipse(15, 5, 15, 5, 0, 0, Math.PI * 2);
      g.fill();
    }
    shadow = g ? softened(c, 30, 10) : null;
  }
  return shadow;
}

/** One figure's sprites laid on a picture, its middle at (x, y) of the far side, with its shadow at its feet. */
function layFigure(on: Picture, anim: any, x: number, y: number): void {
  if (!layered) return;
  const s = PICTURE_DETAIL / PICTURE_ZOOM;
  const sh = shadowSprite();
  if (sh) layOn(on, sh, Math.round(x - 15) * s - SPRITE_PAD, Math.round(y + 11) * s - SPRITE_PAD);
  for (const layer of layered.getVisibleLayersSorted(anim)) {
    const frame = layer.frames[layer.currentFrame];
    const image = frame?.imageElement;
    if (!image?.complete || !image.naturalWidth) continue;
    const sprite = spriteOf(image);
    if (!sprite) continue;
    layOn(on, sprite,
      Math.round(x - frame.width / 2 + (frame.offset?.x || 0)) * s - SPRITE_PAD,
      Math.round(y - frame.height / 2 + (frame.offset?.y || 0)) * s - SPRITE_PAD);
  }
}

// Each portal's picture with its figures on it, made again in place.
const composed = new Map<string, Picture>();

/** The far side with the players on it now, back to front, as in a mirror: upright. Those walking through the portal
 *  past its plane (`through`) are laid over it where they are, as they were before it. */
function composeLive(p: PlacedPortal, now: number, through: readonly PortalWalker[] = []): Picture | null {
  const under = (p.mirror && bases.has(p.name) ? pictures.get(p.name) : null) ?? (through.length ? blankPicture() : null);
  const here = p.mirror ? figures.get(p.name) : undefined;
  const shown = here ? [...here].filter(([id]) => !travelling.has(id)).map(([, f]) => f) : [];
  if (!under || (!shown.length && !through.length) || !layered) return null;
  let picture = composed.get(p.name);
  if (!picture || picture.data.length !== under.data.length) {
    picture = { data: new Uint8ClampedArray(under.data.length), width: under.width, height: under.height };
    composed.set(p.name, picture);
  }
  picture.width = under.width;
  picture.height = under.height;
  picture.data.set(under.data);
  // (their sprites step on by the time since this portal's last picture, however often it is made)
  const dt = Math.min(100, Math.max(0, now - (animatedAt.get(p.name) ?? now - PEEK_RATE_MS)));
  animatedAt.set(p.name, now);
  for (const { figure: f, x: mx, y: my } of inMirror(shown)) {
    if (!f.anim) continue;
    layered.updateLayeredAnimation(f.anim, dt);
    layFigure(picture, f.anim, PEEK_HALF_W + mx, PEEK_HALF_H + my);
  }
  for (const w of [...through].sort((a, b) => a.y - b.y)) {
    const at = onPicture(p, w, openBox, W, H);
    layFigure(picture, w.anim, at.x, at.y);
  }
  return picture;
}

// The colour each portal is drawn in, from its preview. Until that arrives (and with Mirror other side off, when none
// is asked for), a dungeon portal's own blue, a teleport's purple.
const colours = new Map<string, string>();
const DEFAULT_COLOUR = "#6eaaff", TELEPORT_COLOUR = "#c08cff";
const COLOUR_CODE = /^#[0-9a-f]{6}$/i;

type RGB = [number, number, number];
/** Every colour a portal is drawn in, made from its one colour; and its light on the arch, made once the arch has loaded. */
interface Palette {
  rim: RGB; core: RGB;
  // how much of the colour the far side takes, and how much of the night its light on the ground takes back
  tint: RGB; pool: RGB;
  halo: [string, string, string]; spill: [string, string, string];
  rune: string; runeBleed: string; sparkHead: string; sparkTail: string; boltEdge: string; boltCore: string;
  wisp: string; wispBright: string; mote: string; moteBright: string;
  rimGlow?: HTMLCanvasElement; stepGlow?: HTMLCanvasElement; runeCut?: HTMLCanvasElement;
  night?: { key: string; pool: HTMLCanvasElement; open: HTMLCanvasElement };
}
const palettes = new Map<string, Palette>();
const lift = (c: RGB, k: number): RGB => c.map((v) => Math.round(v + (255 - v) * k)) as RGB;
const sink = (c: RGB, by: number): RGB => c.map((v) => Math.max(0, v - by)) as RGB;
const triple = (c: RGB): string => c.join(", ");
const rgb = (c: RGB): string => `rgb(${triple(c)})`;

/** The colours a portal of one colour (#rrggbb) is drawn in. The eye of the vortex, the sparks, the lightning,
 *  the wisps and the motes are that colour lightened part of the way to white, so they keep its hue. */
export function portalPalette(code: string): Palette {
  const c = [1, 3, 5].map((i) => parseInt(code.slice(i, i + 2), 16)) as RGB;
  const core = lift(c, 0.35);
  return {
    rim: c, core,
    tint: c.map((v) => (v / 255) * 0.45) as RGB,
    pool: c.map((v) => 0.95 * (v / 255) ** 0.8) as RGB,
    halo: [triple(c), triple(sink(c, 32)), triple(sink(c, 60))],
    spill: [triple(lift(c, 0.05)), triple(sink(c, 37)), triple(sink(c, 55))],
    rune: rgb(c), runeBleed: rgb(sink(c, 50)),
    sparkHead: rgb(lift(c, 0.5)), sparkTail: rgb(lift(c, 0.2)),
    boltEdge: rgb(c), boltCore: rgb(lift(c, 0.55)),
    wisp: rgb(lift(c, 0.08)), wispBright: rgb(core),
    mote: rgb(lift(c, 0.12)), moteBright: rgb(core),
  };
}

function paletteOf(portal: PlacedPortal): Palette {
  const code = colours.get(portal.name) ?? (portal.kind === "teleport" ? TELEPORT_COLOUR : DEFAULT_COLOUR);
  let p = palettes.get(code);
  if (!p) {
    p = portalPalette(code);
    palettes.set(code, p);
  }
  if (opening) {
    p.rimGlow ??= tinted(rimMask, p.rim);
    p.stepGlow ??= tinted(stepMask, p.rim);
    p.runeCut ??= cutRunes(p.rim);
  }
  return p;
}

// A light on the arch in one colour: the mask's shape and strength, the colour's hue.
function tinted(mask: HTMLCanvasElement | null, colour: RGB): HTMLCanvasElement | undefined {
  if (!mask) return undefined;
  const c = document.createElement("canvas");
  c.width = mask.width; c.height = mask.height;
  const g = c.getContext("2d");
  if (!g) return undefined;
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = rgb(colour);
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// The runes' cuts: dark edges and a dim groove of the portal's colour, so the runes read unlit.
function cutRunes(colour: RGB): HTMLCanvasElement | undefined {
  const cut = document.createElement("canvas");
  cut.width = W; cut.height = H;
  const cg = cut.getContext("2d");
  if (!cg) return undefined;
  cg.fillStyle = "rgba(14, 10, 18, 0.5)";
  for (const rune of runes) for (const j of rune.rim) cg.fillRect(j % W, (j - (j % W)) / W, 1, 1);
  cg.fillStyle = rgb(colour.map((v) => Math.round(v * 0.44)) as RGB);
  for (const rune of runes) for (const j of rune.pixels) cg.fillRect(j % W, (j - (j % W)) / W, 1, 1);
  return cut;
}

/** What the opening shows: nothing with Mirror other side off; else the far side, with its players while the feed has
 *  any. Anyone walking through it past its plane is drawn on it, every frame. */
function pictureFor(p: PlacedPortal, now: number): Picture | null {
  if (p.mirror && !pictures.has(p.name)) {
    pictures.set(p.name, null);
    sendRequest({ type: "DUNGEON_PORTAL_PREVIEW", data: { portal: p.name } });
  }
  const through = walkers.get(p.name);
  if (through?.length) {
    const picture = composeLive(p, now, through);
    // (the feed's picture is made again once they are through: this one has them on it)
    live.delete(p.name);
    if (picture) return picture;
  }
  if (!p.mirror) return null;
  if (peeks.has(p.name) && figures.get(p.name)?.size) {
    const shown = live.get(p.name);
    // (made again at the feed's rate, 30 a second; a few ms early is on time, so a 60 Hz screen does not drop to 20)
    if (!shown || now - shown.at >= PEEK_RATE_MS - PEEK_SLACK_MS) live.set(p.name, { picture: composeLive(p, now), at: now });
    return live.get(p.name)!.picture ?? pictures.get(p.name) ?? null;
  }
  return pictures.get(p.name) ?? null;
}

// Where each portal stands: centred on its rectangle, its foot on the rectangle's bottom edge.
function placed(): PlacedPortal[] {
  return portalsOnMap(window.mapData?.dungeonPortals);
}

// How awake each portal is: 0 asleep, 1 with the player at its foot. It wakes as the player walks up
// and settles again as they leave; its clock runs faster the more awake it is.
interface Wake {
  level: number; phase: number; at: number; frame?: HTMLCanvasElement; frameData?: ImageData; fx?: HTMLCanvasElement; sparks?: HTMLCanvasElement;
  // its light at night, in the game canvas's pixels: the glow and the colour-dodge light
  nightGlow?: HTMLCanvasElement; nightLight?: HTMLCanvasElement;
}
const wakes = new Map<string, Wake>();
const WAKE_FAR = 200, WAKE_NEAR = 48;
function wakeFor(p: { x: number; foot: number }, now: number): Wake {
  const key = `${p.x},${p.foot}`;
  let w = wakes.get(key);
  if (!w) { w = { level: 0, phase: now / 1000, at: now }; wakes.set(key, w); }
  const dt = Math.min(0.25, Math.max(0, (now - w.at) / 1000));
  w.at = now;
  let target = 0;
  for (const pl of Cache.getInstance().players) {
    if (pl.id !== cachedPlayerId) continue;
    const pos = pl.renderPosition ?? pl.position;
    if (pos) target = Math.min(1, Math.max(0, (WAKE_FAR - Math.hypot(pos.x - p.x, pos.y + PLAYER_FEET - p.foot)) / (WAKE_FAR - WAKE_NEAR)));
    break;
  }
  w.level += (target - w.level) * (1 - Math.exp(-dt * 2.5));
  w.phase += dt * (1 + 1.4 * w.level);
  return w;
}

/** The light the portals cast on the ground round their foot, under everyone. */
export function renderDungeonPortalGround(ctx: CanvasRenderingContext2D, now: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * 2.2);
  for (const p of placed()) {
    const awake = wakeFor(p, now).level, { spill: tone } = paletteOf(p);
    // Soft light spilling over the step onto the ground in front: brightest at the step, fading out.
    const a = 0.2 + 0.06 * pulse + 0.14 * awake, rx = W * 0.6, ry = 12;
    ctx.save();
    ctx.translate(p.x, p.foot);
    ctx.scale(1, ry / rx);
    const spill = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    spill.addColorStop(0, `rgba(${tone[0]}, ${a})`);
    spill.addColorStop(0.45, `rgba(${tone[1]}, ${a * 0.4})`);
    spill.addColorStop(1, `rgba(${tone[2]}, 0)`);
    ctx.fillStyle = spill;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
  }
}

/** The portals, standing among the characters: drawn in depth order with them, at their foot. */
export function standingDungeonPortals(ctx: CanvasRenderingContext2D, now: number): Array<{ feet: number; draw: () => void }> {
  lit = [];
  const portals = placed();
  updatePeeks(portals);
  return portals.map((p) => ({ feet: p.foot, draw: () => drawPortal(ctx, p.x, p.foot, now / 1000, pictureFor(p, now), wakeFor(p, now), paletteOf(p), transit.flashOf(p.name, now)) }));
}

/** A light drawn so far this frame at night on the layers over the scene: whose foot it stands at, how far to each side
 *  of its middle it reaches, its canvases (laid on the game canvas at dx, dy), cut where someone stands in front of it. */
export type NightLit = { x: number; foot: number; half: number; canvases: HTMLCanvasElement[]; dx: number; dy: number };
// The portals (and summoning stones) drawn so far this frame with their light at night.
let lit: NightLit[] = [];
// Whoever stands in front of a lit portal is drawn here first, to cut them out of its light.
let front: CanvasRenderingContext2D | null = null;
// How far in front of a portal's foot, and to either side of its light, someone can stand and still be in it.
const FRONT_REACH = 120, SIDE_REACH = 40;

/** Something else standing among the characters with its light at night (a summoning stone) adds it here as it is drawn. */
export function addNightLit(light: NightLit): void { lit.push(light); }

/** The lights that someone standing at `feet` (and `x`, when known) is in front of. */
export function inLightOf(entry: { feet: number; x?: number }, lights: NightLit[]): NightLit[] {
  return lights.filter((p) => entry.feet >= p.foot && entry.feet < p.foot + FRONT_REACH
    && (entry.x === undefined || Math.abs(entry.x - p.x) < p.half + SIDE_REACH));
}

/** Draws one of those standing in the scene, back to front. At night the portals' (and stones') light lies on layers
 *  over the scene, so anyone standing in front of one is cut out of its light: it stays behind them. */
export function drawStanding(scene: CanvasRenderingContext2D, entry: { feet: number; x?: number; draw: (into?: CanvasRenderingContext2D) => void }): void {
  const behind = inLightOf(entry, lit);
  if (!behind.length) { entry.draw(scene); return; }
  const game = scene.canvas as HTMLCanvasElement;
  front ??= document.createElement("canvas").getContext("2d");
  if (!front) { entry.draw(scene); return; }
  const layer = front.canvas;
  if (layer.width !== game.width || layer.height !== game.height) { layer.width = game.width; layer.height = game.height; }
  front.setTransform(1, 0, 0, 1, 0, 0);
  front.globalAlpha = 1;
  front.globalCompositeOperation = "source-over";
  front.clearRect(0, 0, layer.width, layer.height);
  front.setTransform(scene.getTransform());
  front.imageSmoothingEnabled = scene.imageSmoothingEnabled;
  entry.draw(front);
  scene.save();
  scene.setTransform(1, 0, 0, 1, 0, 0);
  scene.globalAlpha = 1;
  scene.globalCompositeOperation = "source-over";
  scene.drawImage(layer, 0, 0);
  scene.restore();
  for (const p of behind) {
    for (const canvas of p.canvases) {
      const g = canvas.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "destination-out";
      g.drawImage(layer, -p.dx, -p.dy);
      g.globalCompositeOperation = "source-over";
    }
  }
}

// The stone arch the portal stands in (public/img/portal-frame.png), drawn one art pixel per world pixel.
const archImage = typeof Image !== "undefined" ? new Image() : null;
// The arch as drawn: the image with a stone step laid across the foot of its opening.
let archArt: HTMLCanvasElement | null = null;
// The step: the plinth at the foot of the left pillar (its bottom rows, its face from column 6 to 23),
// carried across between the pillars from column 26 to its mirror.
const SILL_ROWS = 8, SILL_FROM = 26, SILL_SOURCE: [number, number] = [6, 24];
let opening: Uint8Array | null = null;   // 1 where the arch is open, 2 on the opening's edge
let openBox = { left: 0, right: 0, top: 0, bottom: 0 };
// Pixels from the opening's edge, inside the opening and out onto the stone, up to RIM_REACH.
const RIM_REACH = 6;
// The opening's light on the arch's inner edge reaches this many pixels onto the stone, at most this strong.
const RIM_GLOW_REACH = 5, RIM_GLOW_STRENGTH = 0.55;
// The rim glow's strength at distance d from the opening: a smooth curve that reaches zero just past the reach.
export const rimGlowFalloff = (d: number): number => (1 - Math.min(1, d / (RIM_GLOW_REACH + 1))) ** 2;
let rimDist: Uint8Array | null = null;
// Where and how strongly the opening's light falls on the arch's inner edge, and on the step at its foot:
// drawn over the stone in the portal's colour (Palette).
let rimMask: HTMLCanvasElement | null = null;
let stepMask: HTMLCanvasElement | null = null;
// The opening's edge pixels in order round the rim, for the sparks that run along it.
let rimPath: Int32Array | null = null;
// How far from the opening's edge distances are measured.
const DIST_REACH = 10;
// Runes cut into the arch, from the foot of the left pillar over the crown to the right: where each
// lies along the arch (0 to 1), its strokes, and the cut's edge round them.
let runes: Array<{ along: number; pixels: number[]; rim: number[] }> = [];
// Runes sit on the middle of the stone: this far from the opening's edge.
const RUNE_DIST = 14;
// How many steps along that line a rune may move to find a flat face.
const RUNE_SLIDE = 9;
// One rune per place, left foot to right foot, in strokes two pixels wide; the crown's is even, so it sits
// on the arch's middle.
const GLYPHS = [
  ["..##..", ".####.", "######", "..##..", "..##..", "..##..", "..##.."],
  ["##..##", "##.##.", "####..", "##..##", "##.##.", "####..", "##...."],
  ["....##", "...##.", "..##..", ".##...", "..##..", "...##.", "....##"],
  ["##....", "####..", "##.##.", "##..##", "##.##.", "####..", "##...."],
  ["..##..", ".####.", "##..##", ".####.", "..##..", ".####.", "##..##"],
  ["...##.", "..##..", ".##...", ".####.", "...##.", "..##..", ".##..."],
  ["####..", "##.##.", "##..##", "##.##.", "####..", "##.##.", "##..##"],
  ["##..##", "##..##", ".####.", "..##..", ".####.", "##..##", "##..##"],
  ["##..##", "##..##", "###.##", "##.###", "##..##", "##..##", "##..##"],
];
if (archImage) {
  archImage.onload = () => {
    W = archImage.naturalWidth; H = archImage.naturalHeight;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.drawImage(archImage, 0, 0);
    // The step, so the swirl is framed all round and the arch stands on one base.
    const art = g.getImageData(0, 0, W, H);
    const span = SILL_SOURCE[1] - SILL_SOURCE[0];
    for (let y = Math.max(0, H - SILL_ROWS); y < H; y++) for (let x = SILL_FROM; x < W - SILL_FROM; x++) {
      const from = (y * W + SILL_SOURCE[0] + ((x - SILL_FROM) % span)) * 4;
      art.data.copyWithin((y * W + x) * 4, from, from + 4);
    }
    g.putImageData(art, 0, 0);
    archArt = c;
    const alpha = art.data;
    const solid = (x: number, y: number) => alpha[(y * W + x) * 4 + 3]! > 128;
    // Open: a clear pixel with stone on both sides of it in its row, below the arch's crown.
    const mask = new Uint8Array(W * H);
    let left = W, right = 0, top = H, bottom = 0;
    for (let y = 0; y < H; y++) {
      let first = -1, last = -1;
      for (let x = 0; x < W; x++) if (solid(x, y)) { if (first < 0) first = x; last = x; }
      if (first < 0) continue;
      for (let x = first + 1; x < last; x++) {
        if (solid(x, y)) continue;
        // Only the run that holds the middle of the arch, not gaps between stones.
        let a = x; while (a > first && !solid(a, y)) a--;
        let b = x; while (b < last && !solid(b, y)) b++;
        if (a >= W / 2 || b <= W / 2) continue;
        mask[y * W + x] = 1;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask[y * W + x - 1] || !mask[y * W + x + 1] || !mask[(y - 1) * W + x] || !mask[(y + 1) * W + x]) mask[y * W + x] = 2;
    }
    // Walk out from the edge, one pixel a step, both into the opening and onto the stone round it.
    const dist = new Uint8Array(W * H).fill(255);
    let ring: number[] = [];
    for (let i = 0; i < W * H; i++) if (mask[i] === 2) { dist[i] = 0; ring.push(i); }
    for (let d = 1; d <= DIST_REACH && ring.length; d++) {
      const next: number[] = [];
      for (const i of ring) {
        const x = i % W, y = (i - x) / W;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx! < 0 || ny! < 0 || nx! >= W || ny! >= H) continue;
          const j = ny! * W + nx!;
          if (dist[j]! <= d) continue;
          dist[j] = d; next.push(j);
        }
      }
      ring = next;
    }
    const glow = document.createElement("canvas");
    glow.width = W; glow.height = H;
    const gg = glow.getContext("2d");
    if (gg) {
      const img = gg.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const d = dist[i]!;
        if (mask[i] || d > RIM_GLOW_REACH || alpha[i * 4 + 3]! <= 128) continue;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = Math.round(255 * rimGlowFalloff(d) * RIM_GLOW_STRENGTH);
      }
      gg.putImageData(img, 0, 0);
      rimMask = glow;
    }
    // On the step: strongest under the opening, fading toward the pillars and down the step's face.
    const steps = document.createElement("canvas");
    steps.width = W; steps.height = H;
    const sg = steps.getContext("2d");
    if (sg) {
      const img = sg.createImageData(W, H);
      const mid = (left + right + 1) / 2, half = (right - left + 1) / 2 + 4, rows = Math.max(1, H - 1 - bottom);
      for (let y = bottom + 1; y < H; y++) for (let x = 0; x < W; x++) {
        if (!solid(x, y)) continue;
        const across = Math.abs(x + 0.5 - mid) / half, down = (y - bottom - 1) / rows;
        const k = Math.max(0, 1 - across * across) * (1 - 0.6 * down);
        if (k < 0.02) continue;
        const q = (y * W + x) * 4;
        img.data[q] = img.data[q + 1] = img.data[q + 2] = 255;
        img.data[q + 3] = Math.round(255 * 0.45 * k);
      }
      sg.putImageData(img, 0, 0);
      stepMask = steps;
    }
    const ocx = (left + right + 1) / 2, ocy = (top + bottom + 1) / 2;
    const edge: number[] = [];
    for (let i = 0; i < W * H; i++) if (mask[i] === 2) edge.push(i);
    const angle = (i: number) => Math.atan2((i - (i % W)) / W + 0.5 - ocy, (i % W) + 0.5 - ocx);
    edge.sort((a, b) => angle(a) - angle(b));
    rimPath = Int32Array.from(edge);
    // Runes along a line through the middle of the stone, ordered from straight down, round by the left,
    // over the top; each where it and a pixel round it are all stone.
    const round = (i: number) => ((angle(i) - Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const stone = (px: number, py: number) => px >= 0 && py >= 0 && px < W && py < H && !mask[py * W + px] && alpha[(py * W + px) * 4 + 3]! > 128;
    const line: number[] = [];
    for (let i = 0; i < W * H; i++) {
      const px = i % W, py = (i - px) / W;
      if (!stone(px, py)) continue;
      let near = Infinity;
      for (const e of edge) { const ex = e % W; near = Math.min(near, (ex - px) ** 2 + ((e - ex) / W - py) ** 2); }
      if (Math.abs(Math.sqrt(near) - RUNE_DIST) < 0.5) line.push(i);
    }
    line.sort((a, b) => round(a) - round(b));
    const fits = (cx: number, cy: number) => {
      for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 3; x++) if (!stone(x, y)) return false;
      return true;
    };
    // How uneven the stone under a rune is: low on a flat face, high across a joint between blocks.
    const lum = (px: number, py: number) => { const q = (py * W + px) * 4; return alpha[q]! * 0.3 + alpha[q + 1]! * 0.59 + alpha[q + 2]! * 0.11; };
    const rough = (cx: number, cy: number) => {
      let n = 0, sum = 0, sq = 0;
      for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 3; x++) { const v = lum(x, y); n++; sum += v; sq += v * v; }
      return sq / n - (sum / n) ** 2;
    };
    // The left side's runes slide a little along the line onto a flat face; the eye sits at the crown's
    // middle; the right side mirrors the left.
    const found: typeof runes = [];
    const count = GLYPHS.length, mid = (count - 1) / 2;
    const centres: Array<[number, number] | null> = [];
    for (let k = 0; k < count && line.length; k++) {
      let c: [number, number] | null = null;
      const mirror = k > mid ? centres[count - 1 - k] : null;
      if (mirror && fits(W - mirror[0], mirror[1])) c = [W - mirror[0], mirror[1]];
      if (!c) {
        const want = Math.floor(((k + 0.5) / count) * line.length);
        let best = Infinity;
        for (let j = Math.max(0, want - RUNE_SLIDE); j <= Math.min(line.length - 1, want + RUNE_SLIDE); j++) {
          const i = line[j]!, cx = i % W, cy = (i - cx) / W;
          if (!fits(cx, cy)) continue;
          const score = k === mid ? Math.abs(cx - W / 2) * 1000 + Math.abs(j - want) : rough(cx, cy) + 2 * Math.abs(j - want);
          if (score < best) { best = score; c = [cx, cy]; }
        }
      }
      centres.push(c);
      if (!c) continue;
      const gx = c[0] - 3, gy = c[1] - 3;
      const strokes = new Set<number>();
      GLYPHS[k]!.forEach((row, ry) => [...row].forEach((ch, rx) => { if (ch === "#") strokes.add((gy + ry) * W + gx + rx); }));
      const rim = new Set<number>();
      for (const j of strokes) {
        const jx = j % W, jy = (j - jx) / W;
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          if (stone(jx + ox, jy + oy) && !strokes.has(j + oy * W + ox)) rim.add(j + oy * W + ox);
        }
      }
      found.push({ along: k / (count - 1), pixels: [...strokes], rim: [...rim] });
    }
    runes = found;
    rimDist = dist;
    opening = mask;
    openBox = { left, right, top, bottom };
  };
  archImage.src = "/img/portal-frame.png";
}

// The portal's light at night goes on the colour-dodge layer, as the lamps' light does: it brightens what the
// night darkened and keeps its texture. The opening shines as by day; light of its colour lies on the ground round its foot.
const LIGHT_TEX = 128;
function nightTextures(palette: Palette): Palette["night"] | null {
  if (typeof document === "undefined" || !opening) return null;
  const level = getAmbientLevel(), key = level.map((v) => Math.round(v * 64)).join(",");
  const nightLight = palette.night;
  if (nightLight?.key === key) return nightLight;
  // colour-dodge gains 1 / (1 - c): c = 1 - level undoes the night
  const undo = level.map((v) => Math.round(Math.min(1, Math.max(0, 1 - v)) * 255));
  const pool = nightLight?.pool ?? document.createElement("canvas");
  pool.width = pool.height = LIGHT_TEX;
  const pg = pool.getContext("2d")!, half = LIGHT_TEX / 2;
  const c = undo.map((u, k) => Math.round(u * palette.pool[k]!));
  const grad = pg.createRadialGradient(half, half, 0, half, half, half);
  for (const [at, a] of [[0, 1], [0.15, 0.82], [0.35, 0.5], [0.6, 0.2], [0.85, 0.05], [1, 0]] as Array<[number, number]>) {
    grad.addColorStop(at, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`);
  }
  pg.fillStyle = grad;
  pg.fillRect(0, 0, LIGHT_TEX, LIGHT_TEX);
  const open = nightLight?.open ?? document.createElement("canvas");
  open.width = W; open.height = H;
  const og = open.getContext("2d")!, img = og.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    if (!opening[i]) continue;
    img.data[i * 4] = undo[0]!; img.data[i * 4 + 1] = undo[1]!; img.data[i * 4 + 2] = undo[2]!; img.data[i * 4 + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  palette.night = { key, pool, open };
  return palette.night;
}
// A steady pseudo-random number in [0, 1) for n, so every viewer sees the same lightning.
function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}
// Smooth noise in [0, 1): the smoke carried round in the vortex.
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (a: number, b: number) => hash(a * 57.31 + b * 113.7);
  const upper = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
  const lower = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
  return upper + (lower - upper) * sy;
}
// The vortex: how far it turns per beat of the portal's clock, how fast the far side is drawn into the
// eye (doublings in size per beat), and how much its inner parts are wound round past the outer.
const VORTEX_TURN = 0.7, VORTEX_PULL = 0.3, VORTEX_WIND = 1.6;
// The far side shrinks toward the eye, as seen down a tunnel: shown at radius r, it is sampled at r ** this.
const VORTEX_DEPTH = 0.7;
// The streaks of light lie along the way the vortex pours, so they hold still while the smoke runs along them.
const STREAK_LEAN = (VORTEX_DEPTH * VORTEX_TURN) / (VORTEX_PULL * Math.LN2);
// The far side, map pixels per pixel of the opening, and how far (pixels of the opening) its waver moves it at most.
const PICTURE_ZOOM = 1, WAVER = 0.6;
// How fast the far side wavers (radians per second of a steady clock, times each wave's own rate): slow, and it does not hurry as the portal wakes.
const WAVER_SPEED = 0.35;
// The far side is drawn this many times finer than the world's pixels (the camera draws the world at 3x), so it is not blocky.
const PICTURE_DETAIL = 3;
// The far side's blur, in its own pixels (a third of a world pixel each).
const PICTURE_BLUR = 1;
// The opening is drawn a little see-through: this much of it covers what stands behind the arch.
const OPENING_ALPHA = 0.85;
// Below the arch's foot the halo lies on the ground in front, its height flattened to this fraction.
const HALO_GROUND = 0.4;

// When someone goes in or comes out (core/portaltransit.ts), the inner trim flashes: at the flash's peak the rim glow
// is laid on again this much more, the step at its foot this much, the opening's edge is lifted this far toward the
// eye's bright colour, and at night the trim's glow is this much stronger.
export const TRIM_FLASH_RIM = 1.6, TRIM_FLASH_STEP = 0.7, TRIM_FLASH_EDGE = 0.6, TRIM_FLASH_NIGHT = 0.8;

/** How many times, and how strongly each, a glow is laid on again for a boost: once at full for each whole 1, then the rest. */
export function glowPasses(boost: number): number[] {
  const passes: number[] = [];
  for (let left = boost; left > 0.001; left -= 1) passes.push(Math.min(1, left));
  return passes;
}

function drawPortal(ctx: CanvasRenderingContext2D, x: number, foot: number, t: number, picture: Picture | null, wake: Wake, pal: Palette, trim = 0): void {
  if (typeof document === "undefined" || !archImage || !opening) return;
  const D = PICTURE_DETAIL, FW = W * D;
  const frame = wake.frame ??= document.createElement("canvas");
  if (frame.width !== FW || frame.height !== H * D) { frame.width = FW; frame.height = H * D; wake.frameData = undefined; }
  const g = frame.getContext("2d");
  if (!g) return;
  const frameData = wake.frameData ??= g.createImageData(FW, H * D);
  const out = frameData.data;
  out.fill(0);
  const opacity = Math.round(255 * OPENING_ALPHA);

  // The swirl turns round the middle of the opening; it reaches the rim at r = 1.
  const cx = (openBox.left + openBox.right + 1) / 2, cy = (openBox.top + openBox.bottom + 1) / 2;
  const ax = (openBox.right - openBox.left + 1) / 2, ay = (openBox.bottom - openBox.top + 1) / 2;
  // The far side is hung by the far place on the arch's foot (the mirror line), the ground in front of it rising up the opening.
  const my = H;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  // The portal's own clock: the swirl, sparks, lightning and wisps all hurry as it wakes.
  const awake = wake.level, sp = wake.phase, ws = t * WAVER_SPEED;
  const mix = (rgb: [number, number, number], to: readonly number[], k: number): [number, number, number] =>
    [rgb[0] + (to[0]! - rgb[0]) * k, rgb[1] + (to[1]! - rgb[1]) * k, rgb[2] + (to[2]! - rgb[2]) * k];

  // The far side pours into the eye without end: two copies of it, one twice the other's size, each
  // shrinking inward and fading out before it starts again from the rim.
  const layers = [0, 0.5].map((offset) => {
    const phase = (sp * VORTEX_PULL + offset) % 1;
    return { scale: 2 ** phase, weight: 1 - Math.abs(2 * phase - 1) };
  });
  const turn = sp * VORTEX_TURN;
  for (let py = openBox.top; py <= openBox.bottom; py++) {
    for (let px = openBox.left; px <= openBox.right; px++) {
      const m = opening[py * W + px];
      if (!m) continue;
      const dx = (px + 0.5 - cx) / ax, dy = (py + 0.5 - cy) / ay;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const theta = Math.atan2(dy, dx);
      // Turning as one, its inner parts wound further round; the far side seen down a tunnel.
      const wind = VORTEX_WIND * (1 - r) ** 1.5;
      const a = theta + turn + wind, ca = Math.cos(a), sa = Math.sin(a);
      const rr = r ** VORTEX_DEPTH;
      let smoke = 0;
      for (const layer of layers) smoke += layer.weight * noise((ca * rr * layer.scale * ax) / 6 + 40, (sa * rr * layer.scale * ay) / 6 + 40);
      // The far side does not turn with the swirl: it holds still, wavering a little as if seen through moving water.
      const wx = WAVER * (Math.sin(py * 0.45 + ws * 2.3) + 0.5 * Math.sin((px + py) * 0.3 - ws * 1.7));
      const wy = WAVER * (Math.sin(px * 0.5 - ws * 2.0) + 0.5 * Math.sin((px - py) * 0.27 + ws * 1.4));
      // Seen through the portal's light: the far side takes its colour, darkens toward the eye and
      // has smoke drifting across it.
      const shade = (0.45 + 0.55 * Math.min(1, r * 1.3)) * (0.7 + 0.6 * smoke);
      // Streaks of light along the way it pours, brighter where the smoke is thick, strongest inward.
      const band = 0.5 + 0.5 * Math.sin(3 * (theta + wind - STREAK_LEAN * Math.log(r + 0.04)));
      const streak = Math.min(1, band ** 4 * (0.3 + 0.9 * smoke) * (0.2 + 0.6 * (1 - r)) * (0.8 + 0.4 * awake));
      // The portal's colour at the rim, fading into the opening.
      const d = rimDist ? rimDist[py * W + px]! : 255;
      const k = m === 2 ? 1 : Math.max(0, 1 - d / RIM_REACH) * (0.45 + 0.2 * pulse);
      // The bright eye of the vortex.
      const core = Math.min(1, Math.exp(-((r / 0.22) ** 2)) * (0.7 + 0.2 * pulse + 0.3 * awake));
      // The trim's flash, on the opening's edge, fading inward as the rim's colour does.
      const edge = trim > 0 ? trim * TRIM_FLASH_EDGE * (m === 2 ? 1 : Math.max(0, 1 - d / RIM_REACH)) : 0;
      // The light and smoke are per world pixel; the far side under them is drawn D x D finer.
      for (let sy = 0; sy < D; sy++) {
        for (let sx = 0; sx < D; sx++) {
          let pr = 24, pg = 20, pb = 28;
          if (picture) {
            const qx = Math.min(picture.width - 1, Math.max(0, Math.floor(picture.width / 2 + (px - cx + wx) * D + sx + 0.5)));
            const qy = Math.min(picture.height - 1, Math.max(0, Math.floor(picture.height / 2 + (py - my + wy) * D + sy + 0.5)));
            const q = (qy * picture.width + qx) * 4;
            pr = picture.data[q]!; pg = picture.data[q + 1]!; pb = picture.data[q + 2]!;
          }
          const lum = pr * 0.3 + pg * 0.59 + pb * 0.11;
          let rgb: RGB = [(pr * 0.55 + lum * pal.tint[0]) * shade, (pg * 0.55 + lum * pal.tint[1]) * shade, (pb * 0.55 + lum * pal.tint[2]) * shade];
          rgb = mix(rgb, pal.rim, streak);
          if (k > 0) rgb = mix(rgb, pal.rim, k);
          rgb = mix(rgb, pal.core, core);
          if (edge > 0) rgb = mix(rgb, pal.core, edge);
          const i = ((py * D + sy) * FW + px * D + sx) * 4;
          out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = opacity;
        }
      }
    }
  }
  g.putImageData(frameData, 0, 0);

  const left = Math.round(x - W / 2), top = Math.round(foot - H);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, left, top, W, H);
  ctx.drawImage(archArt ?? archImage, left, top, W, H);
  const { rimGlow, stepGlow, runeCut } = pal;
  if (runeCut) ctx.drawImage(runeCut, left, top, W, H);
  if (rimGlow) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, 0.6 + 0.2 * pulse + 0.2 * awake);
    ctx.drawImage(rimGlow, left, top, W, H);
    for (const a of glowPasses(trim * TRIM_FLASH_RIM)) { ctx.globalAlpha = a; ctx.drawImage(rimGlow, left, top, W, H); }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }
  const stepLight = Math.min(1, 0.45 + 0.15 * pulse + 0.3 * awake);
  if (stepGlow) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = stepLight;
    ctx.drawImage(stepGlow, left, top, W, H);
    for (const a of glowPasses(trim * TRIM_FLASH_STEP)) { ctx.globalAlpha = a; ctx.drawImage(stepGlow, left, top, W, H); }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }
  const fx = wake.fx ??= document.createElement("canvas");
  if (fx.width !== W || fx.height !== H) { fx.width = W; fx.height = H; }
  const f = fx.getContext("2d")!;
  f.clearRect(0, 0, W, H);
  f.globalCompositeOperation = "lighter";
  ctx.globalCompositeOperation = "lighter";
  // Lightning: now and then an arc cracks across the opening and the whole portal flares.
  const seed = x * 0.013;
  const beat = sp / 1.7 + seed, bolt = Math.floor(beat);
  const striking = !!rimPath && rimPath.length > 8 && beat - bolt < 0.14 && hash(bolt) > 0.3 - 0.3 * awake;
  const flash = striking ? 1 - (beat - bolt) / 0.14 : 0;
  // Runes on the arch, glowing in turn as a wave of light climbs one pillar, crosses the crown and
  // runs down the other.
  const wave = (sp * 0.45) % 1.6 - 0.3;
  for (const rune of runes) {
    const near = Math.exp(-((rune.along - wave) ** 2) / 0.02);
    const lit = Math.min(1, 0.35 + 0.15 * pulse + 0.65 * near + 0.5 * flash + 0.4 * awake);
    f.globalAlpha = lit;
    f.fillStyle = pal.rune;
    for (const j of rune.pixels) f.fillRect(j % W, (j - (j % W)) / W, 1, 1);
    // the light bleeding out of the cut
    f.globalAlpha = 0.35 * lit;
    f.fillStyle = pal.runeBleed;
    for (const j of rune.rim) f.fillRect(j % W, (j - (j % W)) / W, 1, 1);
  }
  f.globalAlpha = 1;
  // A halo of the portal's light round the whole arch.
  const hx = left + cx, hy = top + cy, hr = Math.max(ax, ay) * (1.9 + 0.3 * awake);
  const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
  // Soft light: low peak, eased stops so it fades to nothing without a visible edge or flat plateau.
  const hp = 0.09 + 0.04 * pulse + 0.12 * flash + 0.05 * awake;
  for (const [t, k, col] of [[0, 1, 0], [0.2, 0.7, 0], [0.4, 0.4, 1], [0.6, 0.18, 1], [0.8, 0.05, 2], [1, 0, 2]] as const) {
    halo.addColorStop(t, `rgba(${pal.halo[col]}, ${hp * k})`);
  }
  ctx.fillStyle = halo;
  // The halo reaches below the arch's foot (its radius is larger than the distance from the opening's middle
  // to the foot). Above the foot it is round; below, it lies on the ground in front, flattened to HALO_GROUND
  // of its height from the foot line down, so it fades out there and meets the round part without a seam.
  const base = top + H;
  ctx.fillRect(hx - hr, hy - hr, hr * 2, base - (hy - hr));
  if (hy + hr > base) {
    ctx.save();
    ctx.translate(0, base);
    ctx.scale(1, HALO_GROUND);
    ctx.translate(0, -base);
    ctx.fillRect(hx - hr, base, hr * 2, hy + hr - base);
    ctx.restore();
  }
  // Sparks and lightning go on a layer of their own, laid over the portal rather than added to its light,
  // so they keep the portal's colour instead of adding up to white over the bright rim and opening.
  const sparks = wake.sparks ??= document.createElement("canvas");
  if (sparks.width !== W || sparks.height !== H) { sparks.width = W; sparks.height = H; }
  const s = sparks.getContext("2d")!;
  s.clearRect(0, 0, W, H);
  // Sparks running round the rim, each with a fading tail.
  if (rimPath && rimPath.length) {
    const n = rimPath.length;
    for (let k = 0; k < 4; k++) {
      const dir = k % 2 ? -1 : 1;
      const head = Math.floor(((sp * (0.35 + k * 0.07) * dir + k / 4) % 1 + 1) % 1 * n);
      for (let tail = 0; tail < 6; tail++) {
        const i = rimPath[((head - tail * dir) % n + n) % n]!;
        s.globalAlpha = 1 - tail / 6;
        s.fillStyle = tail === 0 ? pal.sparkHead : pal.sparkTail;
        s.fillRect(i % W, (i - (i % W)) / W, 1, 1);
      }
    }
  }
  if (striking && rimPath) {
    const n = rimPath.length;
    const from = Math.floor(hash(bolt * 1.37) * n);
    const to = (from + Math.floor(n * (0.35 + 0.3 * hash(bolt * 2.71)))) % n;
    const a = rimPath[from]!, b = rimPath[to]!;
    const x0 = a % W, y0 = (a - x0) / W, x1 = b % W, y1 = (b - x1) / W;
    // Jagged: the line's points pushed sideways, changing a few times while it lasts.
    const flicker = Math.floor(sp * 30);
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    const pts: Array<[number, number]> = [];
    const segs = 7;
    for (let k = 0; k <= segs; k++) {
      const f = k / segs, off = k === 0 || k === segs ? 0 : (hash(flicker + k * 7.1 + bolt) - 0.5) * 9;
      pts.push([x0 + (x1 - x0) * f + nx * off, y0 + (y1 - y0) * f + ny * off]);
    }
    s.globalAlpha = Math.min(1, 0.4 + flash);
    for (let k = 0; k < segs; k++) {
      const [sx, sy] = pts[k]!, [ex, ey] = pts[k + 1]!;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ex - sx), Math.abs(ey - sy))));
      for (let q = 0; q <= steps; q++) {
        const px = Math.round(sx + (ex - sx) * q / steps), py = Math.round(sy + (ey - sy) * q / steps);
        if (px < 0 || py < 0 || px >= W || py >= H || !opening[py * W + px]) continue;
        s.fillStyle = pal.boltEdge;
        s.fillRect(px - 1, py, 3, 1);
        s.fillStyle = pal.boltCore;
        s.fillRect(px, py, 1, 1);
      }
    }
  }
  s.globalAlpha = 1;
  ctx.globalAlpha = 1;
  ctx.drawImage(fx, left, top, W, H);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(sparks, left, top, W, H);
  // At night the opening shines as by day and its light falls on the ground round the foot, a little
  // brighter as the portal wakes or lightning strikes; the rim, step, runes and sparks keep a faint glow.
  // Drawn here in the game canvas's pixels, so whoever then stands in front can be cut out of it (drawStanding).
  const night = getNightFactor() >= 0.01 ? nightTextures(pal) : null;
  if (night) {
    const m = ctx.getTransform();
    // light spilling out in front of the opening: wide and flat, its middle a little in front of the foot
    const rx = W * 0.75, ry = 22;
    const a = m.transformPoint(new DOMPoint(Math.min(left, x - rx), top));
    const b = m.transformPoint(new DOMPoint(Math.max(left + W, x + rx), Math.max(foot, foot + 4 + ry)));
    const dx = Math.floor(Math.min(a.x, b.x)), dy = Math.floor(Math.min(a.y, b.y));
    const dw = Math.max(1, Math.ceil(Math.max(a.x, b.x)) - dx), dh = Math.max(1, Math.ceil(Math.max(a.y, b.y)) - dy);
    const light = wake.nightLight ??= document.createElement("canvas");
    const glow = wake.nightGlow ??= document.createElement("canvas");
    const place = new DOMMatrix().translate(-dx, -dy).multiply(m);
    const [lg, gg] = [light, glow].map((c) => {
      if (c.width !== dw || c.height !== dh) { c.width = dw; c.height = dh; }
      const g = c.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, dw, dh);
      g.setTransform(place);
      g.imageSmoothingEnabled = true;
      return g;
    }) as [CanvasRenderingContext2D, CanvasRenderingContext2D];
    lg.drawImage(night.open, left, top, W, H);
    lg.globalCompositeOperation = "lighten";
    lg.globalAlpha = Math.min(1, 0.8 + 0.08 * pulse + 0.2 * flash + 0.15 * awake);
    lg.drawImage(night.pool, x - rx, foot + 4 - ry, rx * 2, ry * 2);
    gg.globalCompositeOperation = "lighter";
    if (rimGlow) { gg.globalAlpha = Math.min(1, 0.3 + 0.1 * pulse + 0.15 * awake + TRIM_FLASH_NIGHT * trim); gg.drawImage(rimGlow, left, top, W, H); }
    if (stepGlow) { gg.globalAlpha = Math.min(1, 0.6 * stepLight + TRIM_FLASH_NIGHT * 0.5 * trim); gg.drawImage(stepGlow, left, top, W, H); }
    gg.globalAlpha = 0.45;
    gg.drawImage(fx, left, top, W, H);
    gg.drawImage(sparks, left, top, W, H);
    const screen = new DOMMatrix();
    queueLight(screen, light, dx, dy, dw, dh, 1);
    queueGlow(screen, glow, dx, dy, dw, dh, 1);
    lit.push({ x, foot, half: W * 0.75, canvases: [glow, light], dx, dy });
  }
  // Wisps drawn in from round the portal, spiralling into the vortex. They and the motes are laid over the
  // scene (source-over, as set above) in their own colour, not added to it, so they do not turn white.
  const reach = Math.max(ax, ay) * 1.9;
  // Twice as many as it wakes: every other one fades in.
  for (let m = 0; m < 24; m++) {
    const shown = m % 2 ? awake : 1;
    if (shown < 0.02) continue;
    const cycle = sp * 0.5 + m / 24, life = cycle % 1, lap = Math.floor(cycle);
    const r = reach * (1 - life) ** 1.3;
    const a = m * 2.39996 + lap * 1.7 + life * 3.2;
    const wx = Math.round(left + cx + Math.cos(a) * r), wy = Math.round(top + cy + Math.sin(a) * r * 0.85);
    if (wy > top + H - 2 || r < 2) continue;
    ctx.globalAlpha = Math.min(1, life * 3) * 0.75 * shown;
    ctx.fillStyle = m % 3 === 0 ? pal.wispBright : pal.wisp;
    ctx.fillRect(wx, wy, 1, 1);
  }
  // Motes spiralling up out of the opening, some bigger and brighter.
  for (let m = 0; m < 16; m++) {
    const life = (t * (0.3 + (m % 4) * 0.06) + m / 16) % 1;
    const sway = Math.sin(m * 2.1 + t * 1.3 + life * 6) * ax * (0.9 - life * 0.4);
    const mx = Math.round(left + cx + sway);
    const my = Math.round(top + openBox.bottom - life * (openBox.bottom - openBox.top + 24));
    const big = m % 5 === 0;
    ctx.globalAlpha = Math.sin(life * Math.PI) * (big ? 1 : 0.8);
    ctx.fillStyle = big ? pal.moteBright : pal.mote;
    ctx.fillRect(mx, my, big ? 2 : 1, big ? 2 : 1);
  }
  ctx.restore();
}
