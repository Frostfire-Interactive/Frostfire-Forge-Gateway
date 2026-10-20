// Client view of server-authoritative creatures. The client never simulates
// creatures; it only renders the snapshots the game server sends.
import { initializeLayeredAnimation, updateLayeredAnimation, changeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";
import { createCachedImage, getCachedImage } from "./images.js";
import { getSkeletonSpriteUrl } from "./skeletons.js";
import { formatDuration } from "./tooltip.js";
import { NUMBER_FONT, fontFor } from "./fonts.js";
import { config } from "../web/global.js";
import Cache from "./cache.js";
import { TARGET_ARROWS, ARROW_GAP, spriteArtTop, type ArrowPalette } from "./targetmarker.js";
import { unzoomAbout } from "./worldzoom.js";
const cache = Cache.getInstance();

export interface CreatureView {
  id: number;
  templateId: number;
  name: string;
  subname: string | null;
  level: number;
  rank: "normal" | "elite" | "rare" | "rare_elite" | "boss";
  stance: "aggressive" | "neutral" | "passive";
  creatureType: string;
  health: number;
  maxHealth: number;
  x: number;
  y: number;
  dir: string;
  moving: boolean;
  state: string;
  victimId: string | null;
  /** Tap state for the local player: grey nameplate when "other". */
  tap: "none" | "mine" | "other";
  /** Local player may loot this corpse. */
  lootable: boolean;
  /** Snapshot form from the server; converted to castStart/castEnd on arrival. */
  casting: { spell: string; durationMs: number; remainingMs: number; targetId: string } | null;
  cast: { spell: string; startedAt: number; endsAt: number } | null;
  auras: Array<{ id: string; kind: string; spell?: string; debuff?: boolean; icon?: string | null; remainingMs: number; stacks: number }>;
  aurasAt: number;
  spriteType: "animated" | "static" | "none";
  sprite: string | null;
  spriteLayers: any;
  scale: number;
  // Loaded client-side from spriteLayers.
  anim: any | null;
  staticImage: HTMLImageElement | null;
  /** When its sprite started loading (performance.now()), until it has; 0 once loaded, failed, or with none to load. */
  loadingSince: number;
  /** When it was first drawn (performance.now()), for its fade in; 0 until then. */
  shownAt: number;
  // Client-side interpolation between server positions.
  renderX: number;
  renderY: number;
  fromX: number;
  fromY: number;
  lerpStart: number;
}

export const creatures = new Map<number, CreatureView>();

// Server AI ticks every 100ms; interpolate across one tick.
const INTERPOLATION_MS = 100;

/** Client target ids for creatures are prefixed so they never collide with player/NPC ids. */
export const CREATURE_TARGET_PREFIX = "c:";
export const creatureTargetKey = (id: number) => `${CREATURE_TARGET_PREFIX}${id}`;
export function parseCreatureTarget(targetId: unknown): number | null {
  if (typeof targetId !== "string" || !targetId.startsWith(CREATURE_TARGET_PREFIX)) return null;
  const id = Number(targetId.slice(CREATURE_TARGET_PREFIX.length));
  return Number.isFinite(id) ? id : null;
}

/** Live position of a creature by client target key or id, for projectiles and effects. */
export function creaturePositionFor(key: unknown): { x: number; y: number } | null {
  const id = typeof key === "number" ? key : parseCreatureTarget(key);
  if (id === null) return null;
  const c = creatures.get(id);
  return c ? { x: c.renderX, y: c.renderY } : null;
}

/** Creature the local player is auto-attacking, if any. */
let autoAttackingId: number | null = null;
export const getAutoAttackingId = () => autoAttackingId;
export function setAutoAttackingId(id: number | null): void {
  autoAttackingId = id;
}

/** px: a creature sent again further than this from where it is drawn is put straight there, not slid across. */
const SNAP_DISTANCE = 48;
/** ms: a sprite still loading after this long is given up on, and the creature is drawn without it. */
const SPRITE_WAIT_MS = 4000;

export function applyCreatureSpawn(data: any): void {
  const list = Array.isArray(data?.creatures) ? data.creatures : [];
  for (const c of list) {
    if (typeof c?.id !== "number") continue;
    const existing = creatures.get(c.id);
    const view = c as CreatureView;
    const now = performance.now();
    // Keep an already-loaded sprite when the same creature is re-sent.
    const sameSprite = !!existing && existing.templateId === view.templateId && existing.sprite === view.sprite;
    // The same creature sent again slides on from where it is drawn. A new one, one that respawned, or one far from
    // there (it walked while out of view) starts where the server says it is: it is not drawn somewhere else first.
    const slide = !!existing && sameSprite
      && (existing.state === "dead") === (view.state === "dead")
      && Math.hypot(existing.renderX - c.x, existing.renderY - c.y) <= SNAP_DISTANCE;
    view.renderX = slide ? existing!.renderX : c.x;
    view.renderY = slide ? existing!.renderY : c.y;
    view.fromX = view.renderX;
    view.fromY = view.renderY;
    view.lerpStart = now;
    // One that slides on is already there; one put down somewhere new fades in again.
    view.shownAt = slide ? existing!.shownAt : 0;
    view.cast = c.casting
      ? { spell: c.casting.spell, startedAt: now - (c.casting.durationMs - c.casting.remainingMs), endsAt: now + c.casting.remainingMs }
      : null;
    view.auras = Array.isArray(c.auras) ? c.auras : [];
    view.aurasAt = now;
    view.anim = sameSprite ? existing!.anim : null;
    view.staticImage = sameSprite ? existing!.staticImage : null;
    view.loadingSince = sameSprite ? existing!.loadingSince : hasSpriteToLoad(view) ? now : 0;
    creatures.set(c.id, view);
    if (!sameSprite) void loadCreatureSprite(view);
  }
}

function hasSpriteToLoad(c: CreatureView): boolean {
  return !!c.spriteLayers && c.spriteType !== "none" && !!c.sprite && !spriteFailures.has(c.sprite);
}

/**
 * A living creature is not drawn while its sprite loads: it would show as the
 * placeholder body first, and then change. It shows once the sprite is there,
 * or failed, or has taken too long.
 */
function waitingForSprite(c: CreatureView, now: number): boolean {
  return c.state !== "dead" && c.loadingSince > 0 && now - c.loadingSince < SPRITE_WAIT_MS;
}

const spriteFailures = new Set<string>();

async function loadCreatureSprite(c: CreatureView): Promise<void> {
  try {
    await loadSprite(c);
  } finally {
    c.loadingSince = 0;
    const now = holderOf(c);
    if (now) now.loadingSince = 0;
  }
}

/**
 * The creature as it is held now, when it still has the sprite `c` was loading:
 * the server may have sent it again meanwhile, and the copy it sent is the one drawn.
 */
function holderOf(c: CreatureView): CreatureView | null {
  const now = creatures.get(c.id);
  return now && now.templateId === c.templateId && now.sprite === c.sprite ? now : null;
}

async function loadSprite(c: CreatureView): Promise<void> {
  const layers = c.spriteLayers;
  if (!hasSpriteToLoad(c)) return;
  try {
    if (c.spriteType === "static" && layers.body?.imageUrl) {
      const image = await createCachedImage(layers.body.imageUrl);
      const now = holderOf(c);
      if (now) now.staticImage = image;
      return;
    }
    if (c.spriteType === "animated" && layers.body) {
      const anim = await initializeLayeredAnimation(
        null,
        layers.body,
        layers.head || null,
        layers.helmet || null,
        layers.shoulderguards || null,
        layers.neck || null,
        layers.hands || null,
        layers.chest || null,
        layers.feet || null,
        layers.legs || null,
        layers.weapon || null,
        animationNameFor(c)
      );
      const now = holderOf(c);
      if (now) now.anim = anim;
    }
  } catch (error) {
    // Fall back to the placeholder body; don't retry a broken sheet every spawn.
    spriteFailures.add(c.sprite!);
    console.error(`Creature sprite ${c.sprite} failed to load:`, error);
  }
}

function animationNameFor(c: CreatureView): string {
  const dir = c.dir || "down";
  if (c.cast && c.state !== "dead") return `cast_idle_${dir}`;
  if (c.moving && c.state !== "dead") return `walk_${dir}`;
  return `idle_${dir}`;
}

/** entries: [id, x, y, dir, moving] */
export function applyCreatureMove(data: any): void {
  const entries = Array.isArray(data?.c) ? data.c : [];
  const now = performance.now();
  for (const e of entries) {
    if (!Array.isArray(e)) continue;
    const c = creatures.get(e[0]);
    if (!c) continue;
    c.fromX = c.renderX;
    c.fromY = c.renderY;
    c.lerpStart = now;
    c.x = e[1];
    c.y = e[2];
    c.dir = e[3];
    c.moving = e[4] === 1;
  }
}

function updateRenderPosition(c: CreatureView, now: number): void {
  const t = Math.min(1, Math.max(0, (now - c.lerpStart) / INTERPOLATION_MS));
  c.renderX = c.fromX + (c.x - c.fromX) * t;
  c.renderY = c.fromY + (c.y - c.fromY) * t;
}

export function applyCreatureDespawn(data: any): number[] {
  const ids: number[] = Array.isArray(data?.ids) ? data.ids : [];
  for (const id of ids) {
    creatures.delete(id);
    if (autoAttackingId === id) autoAttackingId = null;
  }
  return ids;
}

export function applyCreatureState(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.state = data.state;
  c.victimId = data.victimId ?? null;
  // A corpse stays targeted (its frame says "Dead"); only the attack on it stops.
  if (c.state === "dead" && autoAttackingId === c.id) autoAttackingId = null;
}

export function applyCreatureHealth(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.health = data.health;
  c.maxHealth = data.maxHealth;
}

export function applyCreatureTap(data: any): void {
  const c = creatures.get(data?.id);
  if (c) c.tap = data.tap;
}

export function applyCreatureLootable(data: any): void {
  const c = creatures.get(data?.id);
  if (c) c.lootable = !!data.lootable;
}

/** "+N XP" over the local player. */
export function applyCreatureXp(data: any, localPlayerId: string | null): void {
  if (!localPlayerId || !(data?.amount > 0)) return;
  floatingTexts.push({
    creatureId: data.creatureId,
    playerId: localPlayerId,
    text: `+${data.amount} XP`,
    color: "#c080ff",
    size: 14,
    start: performance.now(),
    jitter: 0,
  });
}

export function applyCreatureCast(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  const now = performance.now();
  c.cast = { spell: String(data.spell), startedAt: now, endsAt: now + (Number(data.durationMs) || 0) };
}

export function applyCreatureCastEnd(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.cast = null;
  if (data.result === "interrupted") {
    floatingTexts.push({ creatureId: c.id, playerId: null, text: "Interrupted", color: "#ff9040", size: 13, start: performance.now(), jitter: 0 });
  }
}

export function applyCreatureAuras(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.auras = Array.isArray(data.auras) ? data.auras : [];
  c.aurasAt = performance.now();
}

export function applyCreatureAttackStopped(data: any): void {
  if (autoAttackingId === data?.id) autoAttackingId = null;
}

export function clearCreatures(): void {
  creatures.clear();
  floatingTexts.length = 0;
  autoAttackingId = null;
}

// ------------------------------------------------------------- combat text

interface FloatingText {
  creatureId: number;
  /** Player id when the text belongs over a player instead of the creature. */
  playerId: string | null;
  text: string;
  color: string;
  size: number;
  start: number;
  jitter: number;
}

const floatingTexts: FloatingText[] = [];
const FLOAT_MS = 1200;

const TEXT_STYLES: Record<string, { color: string; label?: string; size: number }> = {
  hit: { color: "#ffffff", size: 14 },
  spell: { color: "#ffe066", size: 14 },
  crit: { color: "#ffffff", size: 20 },
  crush: { color: "#ff6060", size: 20 },
  glancing: { color: "#cccccc", size: 12 },
  miss: { color: "#ffffff", label: "Miss", size: 13 },
  dodge: { color: "#ffffff", label: "Dodge", size: 13 },
  parry: { color: "#ffffff", label: "Parry", size: 13 },
  evade: { color: "#ffffff", label: "Evading", size: 13 },
  immune: { color: "#ffffff", label: "Immune", size: 13 },
  resist: { color: "#b0b0ff", label: "Resist", size: 13 },
  heal: { color: "#40ff60", size: 14 },
  interrupted: { color: "#ff9040", label: "Interrupted", size: 13 },
};

/** data: { creatureId, targetId, sourceId, kind, amount } */
export function applyCreatureCombatText(data: any): void {
  // Interrupts are shown from CREATURE_CAST_END so stuns and kicks look the same.
  if (!data || data.kind === "interrupted") return;
  const onCreature = typeof data.targetId === "string" && data.targetId.startsWith("creature:");
  if (onCreature && !creatures.has(data.creatureId)) return;
  const style = TEXT_STYLES[data.kind] ?? TEXT_STYLES.hit;
  // Damage numbers on players already arrive through UPDATESTATS; only show avoidance there.
  if (!onCreature && !style.label) return;
  const emphasis = data.kind === "crit" || data.kind === "crush" ? "!" : "";
  floatingTexts.push({
    creatureId: data.creatureId,
    playerId: onCreature ? null : data.targetId,
    text: style.label ?? `${data.kind === "heal" ? "+" : ""}${data.amount}${emphasis}`,
    color: style.color,
    size: style.size,
    start: performance.now(),
    jitter: Math.random() * 20 - 10,
  });
  if (floatingTexts.length > 100) floatingTexts.splice(0, floatingTexts.length - 100);
}

/** Creature under a world-space point, nearest first. Corpses only when `corpses` is set. */
/**
 * Creature under a world point, nearest first. The hit circle is centred on the
 * sprite's middle and covers most of a 64px body; `slop` widens it for touch,
 * where a fingertip is far less precise than a cursor.
 */
export function creatureAt(worldX: number, worldY: number, corpses = false, slop = 0): CreatureView | null {
  let best: CreatureView | null = null;
  let bestDist = Infinity;
  const now = performance.now();
  for (const c of creatures.values()) {
    if ((c.state === "dead") !== corpses) continue;
    // Not drawn yet, so not there to be clicked.
    if (waitingForSprite(c, now)) continue;
    const radius = 24 * (c.scale || 1) + slop;
    const d = Math.hypot(worldX - c.renderX, worldY - c.renderY);
    if (d <= radius && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

// WoW grey-level formula: creatures at or below this level are trivial.
export function greyLevel(playerLevel: number): number {
  if (playerLevel <= 5) return 0;
  if (playerLevel <= 39) return playerLevel - Math.floor(playerLevel / 10) - 5;
  if (playerLevel <= 59) return playerLevel - Math.floor(playerLevel / 5) - 1;
  return playerLevel - 9;
}

export function levelColor(creatureLevel: number, playerLevel: number): string {
  const diff = creatureLevel - playerLevel;
  if (diff >= 5) return "#ff2020";
  if (diff >= 3) return "#ff8040";
  if (diff >= -2) return "#ffff00";
  if (creatureLevel > greyLevel(playerLevel)) return "#40c040";
  return "#808080";
}

const TAPPED_COLOR = "#8f8f8f";

const STANCE_COLORS: Record<CreatureView["stance"], string> = {
  aggressive: "#ff4040",
  neutral: "#ffff40",
  passive: "#80e080",
};

/** The target arrow's colours for a creature: grey for a corpse or when someone else tagged it, else by its stance, as its name is. */
function arrowPalette(c: CreatureView): ArrowPalette {
  if (c.state === "dead" || c.tap === "other") return TARGET_ARROWS.tapped;
  if (c.stance === "aggressive") return TARGET_ARROWS.hostile;
  if (c.stance === "passive") return TARGET_ARROWS.friendly;
  return TARGET_ARROWS.neutral;
}

/**
 * Where the target arrow goes over a creature, and how: its tip just over the head (over the cast bar
 * while it casts), or over the skeleton of a corpse. Drawn by the renderer over the top tile layers.
 */
export function targetArrowFor(c: CreatureView): { x: number; tipY: number; palette: ArrowPalette; alpha: number } | null {
  // Not drawn yet (its sprite is loading, or it is out of view): nothing over it either.
  if (!c.shownAt) return null;
  let tipY: number;
  if (c.state === "dead") {
    tipY = c.renderY - 10 - CORPSE_SKELETON_SIZE / 2 - ARROW_GAP;
  } else {
    const metrics = spriteMetrics(c);
    const headY = metrics ? groundLine(c, metrics) - metrics.height : c.renderY + 8 - bodyRadius(c);
    // Just over the top of the art itself: a sprite's frame is often far taller than what is drawn in it.
    const artTop = spriteArtTop(c.anim, c.staticImage, c.renderY, c.scale > 0 ? c.scale : 1) ?? headY;
    tipY = artTop - ARROW_GAP;
    // Clear of the cast bar (drawCastBar: headY - 6 down to headY + 4) while it casts.
    if (c.cast) tipY = Math.min(tipY, headY - 8);
  }
  return { x: c.renderX, tipY, palette: arrowPalette(c), alpha: fadeOf(c) };
}

let lastRenderAt = 0;

/**
 * Moves every creature along and steps its animation for this frame, and
 * returns the ones in view. The renderer draws those with drawCreature, in
 * depth order with the players.
 */
export function stepCreatures(isInView: (x: number, y: number) => boolean): CreatureView[] {
  const now = performance.now();
  const deltaSeconds = Math.min(0.1, lastRenderAt ? (now - lastRenderAt) / 1000 : 0);
  lastRenderAt = now;
  const inView: CreatureView[] = [];
  for (const c of creatures.values()) {
    updateRenderPosition(c, now);
    if (c.anim) {
      const wanted = animationNameFor(c);
      if (c.anim.currentAnimationName !== wanted) void changeLayeredAnimation(c.anim, wanted);
      updateLayeredAnimation(c.anim, deltaSeconds);
    }
    if (waitingForSprite(c, now)) continue;
    if (!isInView(c.renderX, c.renderY)) continue;
    // The fade in starts the first time it is drawn.
    if (!c.shownAt) c.shownAt = now;
    inView.push(c);
  }
  return inView;
}

/** Combat text over creatures and players; drawn after every character so none of them covers it. */
export function drawFloatingTexts(
  ctx: CanvasRenderingContext2D,
  playerPosition: (playerId: string) => { x: number; y: number } | null
): void {
  if (floatingTexts.length === 0) return;
  const now = performance.now();
  ctx.save();
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const t = floatingTexts[i];
    const age = now - t.start;
    if (age >= FLOAT_MS) {
      floatingTexts.splice(i, 1);
      continue;
    }
    let anchor: { x: number; y: number } | null = null;
    if (t.playerId) {
      anchor = playerPosition(t.playerId);
    } else {
      const c = creatures.get(t.creatureId);
      if (c) anchor = { x: c.renderX, y: c.renderY - 30 * (c.scale || 1) };
    }
    if (!anchor) continue;
    const progress = age / FLOAT_MS;
    ctx.globalAlpha = 1 - progress * progress;
    // Numbers use the hotbar's font; words ("Miss", "Evading") the text font.
    ctx.font = `bold ${t.size}px ${fontFor(t.text)}`;
    const x = anchor.x + t.jitter;
    const y = anchor.y - 20 - progress * 30;
    // One size on the screen at any zoom, rising from the anchor.
    ctx.save();
    unzoomAbout(ctx, anchor.x, anchor.y);
    ctx.strokeText(t.text, x, y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x, y);
    ctx.restore();
  }
  ctx.restore();
}

/** Draws the creature's sprite centred on its anchor. Returns the drawn height, or 0 if nothing was drawn. */
/**
 * Where the sprite's feet land, and how tall it is, without drawing anything.
 *
 * A sprite frame is mostly empty space below the character, so the feet are not
 * the bottom edge of the image. Players put their shadow a quarter of a frame
 * below the anchor (+16 on a 64px frame); creatures use the same rule so both
 * stand on the ground the same way.
 */
export const FEET_FRACTION = 0.25;

function spriteMetrics(c: CreatureView): { height: number; feetY: number } | null {
  const scale = c.scale > 0 ? c.scale : 1;
  if (c.anim) {
    let height = 0;
    for (const layer of getVisibleLayersSorted(c.anim)) {
      if (!layer.frames.length) continue;
      const frame = layer.frames[layer.currentFrame];
      if (!frame?.imageElement?.complete || !frame.imageElement.naturalWidth) continue;
      height = Math.max(height, frame.height * scale);
    }
    return height > 0 ? { height, feetY: c.renderY + height * FEET_FRACTION } : null;
  }
  const img = c.staticImage;
  if (img?.complete && img.naturalWidth > 0) {
    const height = img.height * scale;
    return { height, feetY: c.renderY + height * FEET_FRACTION };
  }
  return null;
}

function drawCreatureSprite(ctx: CanvasRenderingContext2D, c: CreatureView): number {
  // The template's scale grows every layer about the frame centre (like
  // players), with each layer's offset scaled too - so head, body and gear
  // keep their relative alignment at any scale instead of overlapping.
  const scale = c.scale > 0 ? c.scale : 1;
  const draw = (image: CanvasImageSource, width: number, height: number, ox: number, oy: number): void => {
    ctx.drawImage(
      image,
      Math.round(c.renderX - (width * scale) / 2 + ox * scale),
      Math.round(c.renderY - (height * scale) / 2 + oy * scale),
      Math.round(width * scale),
      Math.round(height * scale)
    );
  };

  if (c.anim) {
    const layers = getVisibleLayersSorted(c.anim);
    let height = 0;
    ctx.imageSmoothingEnabled = false;
    for (const layer of layers) {
      if (!layer.frames.length) continue;
      const frame = layer.frames[layer.currentFrame];
      if (!frame?.imageElement?.complete || !frame.imageElement.naturalWidth) continue;
      draw(frame.imageElement, frame.width, frame.height, frame.offset?.x || 0, frame.offset?.y || 0);
      height = Math.max(height, frame.height * scale);
    }
    return height;
  }
  const img = c.staticImage;
  if (img?.complete && img.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false;
    draw(img, img.width, img.height, 0, 0);
    return img.height * scale;
  }
  return 0;
}

/** Longest edge of a corpse skeleton, matching player death markers. */
const CORPSE_SKELETON_SIZE = 56;

/**
 * A dead creature is drawn as a skeleton, the same marker players leave, in
 * place of its sprite. It stays as long as the server keeps the corpse (so it
 * can still be looted), then disappears with it.
 */
function drawCreatureCorpse(ctx: CanvasRenderingContext2D, c: CreatureView): void {
  const img = getCachedImage(getSkeletonSpriteUrl());
  if (!img.complete || img.naturalWidth === 0) return;
  const fit = Math.min(1, CORPSE_SKELETON_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * fit));
  const h = Math.max(1, Math.round(img.naturalHeight * fit));
  const x = c.renderX;
  const y = c.renderY;

  const fade = fadeOf(c);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = fade;
  // Same placement as player skeletons (skeletons.ts).
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h / 2 - 10), w, h);
  if (c.lootable) drawLootSparkles(ctx, c, x, y - 10, w, fade);
  ctx.restore();
}

/** How many sparkles rise from a lootable corpse at once, and how long each takes to rise and fade. */
const LOOT_SPARKLES = 7;
const LOOT_SPARKLE_MS = 1600;
/** How far a sparkle rises before it is gone. */
const LOOT_SPARKLE_RISE = 30;

/**
 * "You can loot this": small gold sparkles that rise from the corpse and fade.
 * Each one's spot and timing come from the creature's id and the clock, so
 * nothing is kept between frames.
 */
function drawLootSparkles(ctx: CanvasRenderingContext2D, c: CreatureView, x: number, y: number, width: number, fade: number): void {
  const now = performance.now();
  for (let i = 0; i < LOOT_SPARKLES; i++) {
    // A fixed spread per sparkle; every cycle it starts again a little to one side.
    const seed = Math.sin((c.id + 1) * 12.9898 + i * 78.233) * 43758.5453;
    const offset = seed - Math.floor(seed);
    const t = ((now + offset * LOOT_SPARKLE_MS + (i * LOOT_SPARKLE_MS) / LOOT_SPARKLES) % LOOT_SPARKLE_MS) / LOOT_SPARKLE_MS;
    const cycle = Math.floor((now + offset * LOOT_SPARKLE_MS + (i * LOOT_SPARKLE_MS) / LOOT_SPARKLES) / LOOT_SPARKLE_MS);
    const lane = Math.sin((cycle + 1) * 3.7 + i * 1.9);
    const sx = x + lane * width * 0.35 + Math.sin(t * Math.PI * 2 + i) * 2;
    const sy = y + 8 - t * LOOT_SPARKLE_RISE;
    // Fades in quickly, out slowly, and twinkles on the way up.
    const alpha = Math.min(1, t * 6) * (1 - t) * (0.7 + 0.3 * Math.sin(now * 0.02 + i * 2));
    const size = 1.5 + (1 - t) * 2;
    ctx.globalAlpha = Math.max(0, alpha) * fade;
    ctx.fillStyle = "#fff6c0";
    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 1;
    // A four-pointed star: a thin cross with a bright centre.
    ctx.beginPath();
    ctx.moveTo(sx, sy - size * 2);
    ctx.lineTo(sx, sy + size * 2);
    ctx.moveTo(sx - size * 2, sy);
    ctx.lineTo(sx + size * 2, sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, size * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = fade;
}

/** ms: how long a creature takes to fade in when it first shows. */
const FADE_IN_MS = 400;

/** How far a creature has faded in, 0 to 1: everything of it is drawn this much. */
function fadeOf(c: CreatureView): number {
  if (!c.shownAt) return 1;
  return Math.min(1, Math.max(0, (performance.now() - c.shownAt) / FADE_IN_MS));
}

/** Radius of the placeholder body drawn while a creature has no sprite. */
const bodyRadius = (c: CreatureView): number => 14 * (c.scale || 1);

/** Where a creature touches the ground: its sprite's feet, or the bottom of the placeholder body. */
function groundLine(c: CreatureView, metrics: { feetY: number } | null): number {
  return metrics ? metrics.feetY : c.renderY + 8 + bodyRadius(c) * 0.9;
}

/** The line a living creature is depth-sorted by against the other characters. */
export function creatureFeetY(c: CreatureView): number {
  return groundLine(c, spriteMetrics(c));
}

export function drawCreature(ctx: CanvasRenderingContext2D, c: CreatureView, targeted: boolean): void {
  if (c.state === "dead") {
    drawCreatureCorpse(ctx, c);
    return;
  }
  const radius = bodyRadius(c);
  // Server anchor matches players: horizontal centre, footprint below y.
  const cx = c.renderX;
  const cy = c.renderY + 8;
  const fade = fadeOf(c);

  ctx.save();
  ctx.globalAlpha = fade;

  // Ground markers go under the creature's feet and are drawn before the
  // sprite, so nothing is painted over the creature itself.
  const metrics = spriteMetrics(c);
  const groundY = groundLine(c, metrics);
  const groundRx = metrics ? Math.max(radius, 10 * (c.scale || 1)) : radius;

  // Same as players (player.ts show()): a dark shadow. A target has an arrow over its head (targetArrowFor).
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  ctx.ellipse(cx, groundY, groundRx, groundRx * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Sprite if loaded, otherwise the placeholder body.
  const spriteHeight = drawCreatureSprite(ctx, c);
  if (spriteHeight === 0) {
    ctx.fillStyle = "#7a5c3e";
    ctx.strokeStyle = targeted ? "#ffffff" : "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = targeted ? 2 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = fade;

  // Bars and icons sit above the drawn sprite, so they follow scaled creatures.
  // Measured from the feet so bars clear the head of a tall or scaled sprite.
  const headY = spriteHeight > 0 ? groundY - spriteHeight : cy - radius;
  drawNameplate(ctx, c, targeted, headY, groundY);
  drawCastBar(ctx, c, headY);
  ctx.restore();
}

/** Same layout as player nameplates: name below the feet, subname in the guild slot, health bar when targeted. */
function drawNameplate(ctx: CanvasRenderingContext2D, c: CreatureView, targeted: boolean, headY: number, groundY: number): void {
  const x = c.renderX;
  // Below the feet (feet sit a quarter frame under the anchor, players offset
  // their name the same way), so a scaled creature's shadow never lands on it.
  const nameY = groundY + 34;
  const tappedByOther = c.tap === "other";

  ctx.textAlign = "center";
  ctx.font = "14px 'Comic Relief'";
  ctx.shadowColor = "black";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "black";
  ctx.lineWidth = 1;
  ctx.fillStyle = tappedByOther ? TAPPED_COLOR : STANCE_COLORS[c.stance] || STANCE_COLORS.neutral;
  ctx.strokeText(c.name, x, nameY);
  ctx.fillText(c.name, x, nameY);

  const subOffset = c.subname ? 16 : 0;
  if (c.subname) {
    ctx.font = "12px 'Comic Relief'";
    ctx.fillStyle = "#c9a655";
    ctx.shadowBlur = 1;
    ctx.strokeText(`<${c.subname}>`, x, nameY + 16);
    ctx.fillText(`<${c.subname}>`, x, nameY + 16);
    ctx.shadowBlur = 2;
  }

  if (targeted) {
    const barY = nameY + 6 + subOffset;
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(x - 50, barY, 100, 3);
    const pct = c.maxHealth > 0 ? Math.max(0, Math.min(1, c.health / c.maxHealth)) : 0;
    if (pct < 0.3) ctx.fillStyle = "#C81D1D";
    else if (pct < 0.5) ctx.fillStyle = "#C87C1D";
    else if (pct < 0.8) ctx.fillStyle = "#C8C520";
    else ctx.fillStyle = "#519D41";
    ctx.fillRect(x - 50, barY, pct * 100, 3);
  }

  drawAuras(ctx, c, headY);

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.textAlign = "center";
}

/** Same buff/debuff icons as players: rows of five above the head, buffs first, timers underneath. */
function drawAuras(ctx: CanvasRenderingContext2D, c: CreatureView, headY: number): void {
  const elapsed = performance.now() - (c.aurasAt || 0);
  const active = (c.auras || [])
    .map((a) => ({ ...a, left: a.remainingMs - elapsed, debuff: a.debuff ?? a.kind !== "hot" }))
    .filter((a) => a.left > 0)
    .sort((a, b) => (a.debuff ? 1 : 0) - (b.debuff ? 1 : 0))
    .slice(0, 10);
  if (active.length === 0) return;

  const iconSize = 18;
  const gap = 3;
  const maxPerRow = 5;
  const timerHeight = 12;
  const rowHeight = iconSize + timerHeight + gap;
  const baseIconY = headY - 63;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  // One size on the screen at any zoom, kept the same height over the head.
  unzoomAbout(ctx, c.renderX, headY);
  for (let r = 0; r * maxPerRow < active.length; r++) {
    const row = active.slice(r * maxPerRow, (r + 1) * maxPerRow);
    const rowWidth = row.length * iconSize + (row.length - 1) * gap;
    let x = Math.round(c.renderX - rowWidth / 2);
    const y = Math.round(baseIconY - r * rowHeight);

    for (const aura of row) {
      const iconUrl = aura.icon || (aura.spell && cache.spells?.[aura.spell]?.spriteUrl) || `${config.ASSET_SERVER_URL}/icon?name=missing_icon`;
      const img = getCachedImage(iconUrl);

      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(x - 1, y - 1, iconSize + 2, iconSize + 2);
      if (img.complete && img.naturalWidth > 0) ctx.drawImage(img, x, y, iconSize, iconSize);

      ctx.strokeStyle = aura.debuff ? "rgba(255, 90, 90, 0.9)" : "rgba(120, 170, 255, 0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, y - 0.5, iconSize + 1, iconSize + 1);

      const stacks = Number(aura.stacks) || 1;
      if (stacks > 1) {
        ctx.font = `bold 10px ${NUMBER_FONT}`;
        ctx.textAlign = "right";
        ctx.fillStyle = "#ffd75e";
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.strokeText(`${stacks}`, x + iconSize, y + iconSize - 1);
        ctx.fillText(`${stacks}`, x + iconSize, y + iconSize - 1);
      }

      const remaining = Math.ceil(aura.left / 1000);
      if (remaining > 0) {
        const label = formatDuration(remaining);
        ctx.font = `bold 10px ${NUMBER_FONT}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "white";
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.strokeText(label, x + iconSize / 2, y + iconSize + timerHeight - 2);
        ctx.fillText(label, x + iconSize / 2, y + iconSize + timerHeight - 2);
      }

      x += iconSize + gap;
    }
  }
  ctx.restore();
}

/** Same cast bar as players, above the head. */
function drawCastBar(ctx: CanvasRenderingContext2D, c: CreatureView, headY: number): void {
  if (!c.cast) return;
  const total = Math.max(1, c.cast.endsAt - c.cast.startedAt);
  const progress = Math.max(0, Math.min(1, (performance.now() - c.cast.startedAt) / total));
  const barWidth = 110;
  const barHeight = 10;
  const barX = c.renderX - barWidth / 2;
  const barY = headY - 6;

  ctx.fillStyle = "rgba(8, 8, 16, 0.9)";
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(160, 150, 130, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 3);
  ctx.stroke();

  ctx.fillStyle = "rgba(212, 168, 38, 0.95)";
  ctx.beginPath();
  ctx.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, barHeight - 2, 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, (barHeight - 2) / 2, [2, 2, 0, 0]);
  ctx.fill();

  const label = c.cast.spell.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  ctx.font = "bold 10px 'Comic Relief'";
  ctx.fillStyle = "#e8e0d0";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = 3;
  ctx.fillText(label, c.renderX, barY - 5);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
}
