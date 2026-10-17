/**
 * USER REQUEST 2026-10-17 ("a tornado system ... that spawn 1 or 2 on the map at most during a thunderstorm with a rare
 * chance or '/weather tornado' is set. Tornadoes when close to players should pull them in and do 5% damage every
 * second"): the tornadoes the server says are on this map (the TORNADOES packet: where each is, in world px, ten times a
 * second), drawn in the world's own place (renderer.ts), so they follow the camera and the zoom like everything
 * else on the ground. The server moves them, pulls and hurts; this only shows them.
 *
 * USER REPORT 2026-10-17 ("They are on top of every layer which looks super weird"): they were drawn after the map's
 * upper layers. Then, sorted among the characters, a tree's canopy cut its funnel in two ("looks way more broken"), and
 * then ("can we have it ignore trees?"): it is drawn twice. Once among the characters (standingTornadoes), sorted with
 * the NPCs, players and creatures by where its foot is, so whoever stands in front of it is drawn in front; and once
 * more over the map's upper layers, only on their pixels (drawTornadoesOverCovers: "source-atop"), so no tree or roof
 * hides it and the ground around is left as it was. (Where the upper layers are a canvas of their own, the phone
 * renderer, it is drawn over them whole.)
 *
 * What one looks like, seen from above and in front like the rest of the game, back to front:
 * - a ring of dust kicked up and spun round its foot (no shadow: USER REQUEST 2026-10-17);
 * - the funnel (USER REQUEST 2026-10-17, "make the funnel of the tornado look more realistic, the bottom debris is
 *   perfect"): a cone of condensed cloud round an axis that leans the way it goes and sways (a rope, not a post),
 *   narrow at the ground, widening up into the wall cloud. Shaded as the round thing it is: lit down one side, in
 *   shadow down the other, its edges thin and soft; browned by dust low down. STRANDS of cloud twist round the front of
 *   it as it turns (its spin is seen), and FUNNEL_PUFFS soft wisps ride its edges, so its outline is ragged, not drawn;
 * - the wall cloud it hangs from: a wide, dark, slowly turning lowering of the storm cloud;
 * - debris (dark specks) whirled round its lower part, the odd one flung out.
 * A tornado eases toward each place the server gives (it moves smoothly between packets), grows in when it forms and
 * shrinks away when it is gone. It roars: "regular wind" slowed down, on the Weather track, louder the nearer it is.
 */
import { setWeatherSound } from "./audio.js";

const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** How tall a funnel is drawn, and how wide at its foot and its top, world px. */
const HEIGHT = 300, FOOT = 14, TOP = 92;
/** Strands of cloud twisting round the funnel; puffs of the wall cloud. */
const STRANDS = isMobileDevice ? 6 : 11, WALL = isMobileDevice ? 10 : 18;
const FUNNEL_PUFFS = isMobileDevice ? 70 : 160, DEBRIS = isMobileDevice ? 16 : 40, DUST = isMobileDevice ? 30 : 70;
/** Seconds to grow in, and to shrink away. */
const FORM = 2.5, FADE = 2;
/**
 * How quickly it closes on where the server last put it (ten times a second): a time constant, seconds. Short, so it is
 * drawn where it pulls from, not trailing behind (the server moves it at 30 Hz).
 */
const EASE = 0.1;
/** The roar: heard from ROAR_FAR px away, full at its foot; "regular wind" played this much slower (deeper). */
const ROAR = "regular wind", ROAR_KEY = "tornado roar", ROAR_FAR = 700, ROAR_RATE = 0.7;

interface Puff { h: number; angle: number; spin: number; spread: number; size: number; shade: number }
interface Bit { angle: number; spin: number; h: number; reach: number; size: number }
interface Twister {
  id: string;
  /** Where it is drawn, and where the server last put it. */
  x: number; y: number; toX: number; toY: number;
  /** 0 (not there) to 1 (fully formed). */
  grown: number;
  gone: boolean;
  /** Its lean, px at the top, eased toward the way it moves. */
  lean: number;
  seed: number;
  puffs: Puff[]; debris: Bit[]; dust: Bit[];
}

const twisters = new Map<string, Twister>();
let shownMap = "";
let time = 0;

/** Sprites of one soft puff (light grey, dark grey, brown dust): solid in the middle, fading out at the edge. */
let sprites: HTMLCanvasElement[] | null = null;
function puffSprites(): HTMLCanvasElement[] {
  if (sprites) return sprites;
  return (sprites = ["168, 166, 160", "92, 90, 88", "150, 118, 82"].map((tone) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const fill = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    fill.addColorStop(0, `rgba(${tone}, 0.9)`);
    fill.addColorStop(0.45, `rgba(${tone}, 0.55)`);
    fill.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 64, 64);
    return canvas;
  }));
}

function makeTwister(id: string, x: number, y: number): Twister {
  const puffs: Puff[] = [];
  for (let i = 0; i < FUNNEL_PUFFS; i++) {
    // more of them low down, where the funnel is narrow and dense
    const h = Math.pow(Math.random(), 1.35);
    puffs.push({
      h, angle: Math.random() * Math.PI * 2, spin: 0.8 + Math.random() * 0.5,
      spread: 0.7 + Math.random() * 0.5, size: 0.8 + Math.random() * 0.6, shade: Math.random(),
    });
  }
  const debris: Bit[] = [];
  for (let i = 0; i < DEBRIS; i++) {
    debris.push({ angle: Math.random() * Math.PI * 2, spin: 2 + Math.random() * 2.5, h: Math.random() * 0.45, reach: 1.4 + Math.random() * 1.6, size: 1 + Math.random() * 1.6 });
  }
  const dust: Bit[] = [];
  for (let i = 0; i < DUST; i++) {
    dust.push({ angle: Math.random() * Math.PI * 2, spin: 1.2 + Math.random() * 1.2, h: Math.random() * 0.12, reach: 1.5 + Math.random() * 3.5, size: 10 + Math.random() * 16 });
  }
  return { id, x, y, toX: x, toY: y, grown: 0, gone: false, lean: 0, seed: Math.random() * 100, puffs, debris, dust };
}

/** The TORNADOES packet: the tornadoes on `map` now. Any not in it shrink away. */
export function setTornadoes(data: { map?: string; tornadoes?: Array<{ id: string | number; x: number; y: number }> }): void {
  const here = String((window as any).mapData?.name ?? "").replace(".json", "");
  const map = String(data?.map ?? "").replace(".json", "");
  if (map && here && map !== here) return;
  if (map !== shownMap) { twisters.clear(); shownMap = map; }
  const seen = new Set<string>();
  for (const t of Array.isArray(data?.tornadoes) ? data.tornadoes : []) {
    const id = String(t.id), x = Number(t.x), y = Number(t.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    seen.add(id);
    const known = twisters.get(id);
    if (known) { known.toX = x; known.toY = y; known.gone = false; }
    else twisters.set(id, makeTwister(id, x, y));
  }
  for (const [id, t] of twisters) if (!seen.has(id)) t.gone = true;
}

/**
 * Where each tornado on this map is, in world px, as the server last put it: for the world map (USER REQUEST
 * 2026-10-17: "I should also be able to track the tornado on the world map"). The server tells every player of a map
 * of all its tornadoes, near or far, so every one is here.
 */
export function tornadoSpots(): Array<{ id: string; x: number; y: number }> {
  const spots: Array<{ id: string; x: number; y: number }> = [];
  for (const t of twisters.values()) if (!t.gone) spots.push({ id: t.id, x: t.toX, y: t.toY });
  return spots;
}

/** How far the nearest tornado is from (x, y), world px; Infinity when there is none. */
function nearest(x: number, y: number): number {
  let best = Infinity;
  for (const t of twisters.values()) if (!t.gone) best = Math.min(best, Math.hypot(t.x - x, t.y - y));
  return best;
}

/**
 * Moves the tornadoes on by `seconds` (since the last frame) and sets their roar for a listener at (`listenX`,
 * `listenY`). Called once a frame, before they are drawn (standingTornadoes).
 */
export function stepTornadoes(seconds: number, listenX: number, listenY: number): void {
  const here = String((window as any).mapData?.name ?? "").replace(".json", "");
  if (shownMap && here && shownMap !== here) { twisters.clear(); shownMap = here; }
  const dt = Math.min(0.1, Math.max(0, seconds));
  time += dt;

  const far = nearest(listenX, listenY);
  const roar = Number.isFinite(far) ? Math.pow(Math.max(0, 1 - far / ROAR_FAR), 1.6) : 0;
  setWeatherSound(ROAR, roar, { key: ROAR_KEY, even: true, rate: ROAR_RATE + 0.15 * roar, glide: 0.3 });
  if (!twisters.size) return;

  for (const [id, t] of twisters) {
    // closing on where the server put it; leaning the way it goes
    const k = 1 - Math.exp(-dt / EASE);
    const moveX = (t.toX - t.x) * k;
    t.x += moveX;
    t.y += (t.toY - t.y) * k;
    t.lean += (Math.max(-60, Math.min(60, (moveX / Math.max(dt, 0.001)) * 0.6)) - t.lean) * Math.min(1, dt * 0.8);
    t.grown = t.gone ? Math.max(0, t.grown - dt / FADE) : Math.min(1, t.grown + dt / FORM);
    if (t.gone && t.grown <= 0) { twisters.delete(id); continue; }
    for (const d of t.dust) d.angle += d.spin * dt;
    for (const p of t.puffs) p.angle += p.spin * (2.6 - 1.6 * p.h) * dt;
    for (const d of t.debris) d.angle += d.spin * dt;
  }
}

/**
 * The tornadoes as the renderer's standing things: `feet` the y of its foot, in world px, and `draw` drawing it on a
 * context set to the world's place (its transform has the camera and the zoom; world px are drawn as they are).
 */
export function standingTornadoes(): Array<{ feet: number; draw: (ctx: CanvasRenderingContext2D) => void }> {
  const list: Array<{ feet: number; draw: (ctx: CanvasRenderingContext2D) => void }> = [];
  for (const t of twisters.values()) {
    list.push({
      feet: t.y,
      draw: (ctx) => {
        ctx.save();
        drawOne(ctx, t, puffSprites());
        ctx.restore();
      },
    });
  }
  return list;
}

/**
 * The tornadoes again over the map's upper layers (trees, roofs), `ctx` being their canvas set to the world's place:
 * only on the pixels those layers drew (`onCovers`), or whole where they are not on it.
 */
export function drawTornadoesOverCovers(ctx: CanvasRenderingContext2D, onCovers: boolean): void {
  if (!twisters.size) return;
  ctx.save();
  if (onCovers) ctx.globalCompositeOperation = "source-atop";
  for (const t of twisters.values()) drawOne(ctx, t, puffSprites());
  ctx.restore();
}

/** The axis at height h (0 the ground, 1 the top): where it is across, as the funnel leans and sways. */
function axisAt(t: Twister, h: number): number {
  const sway = Math.sin(time * 0.9 + t.seed + h * 2.4) * 16 * h + Math.sin(time * 2.1 + t.seed * 2 + h * 5) * 5 * h;
  return t.lean * h * h + sway;
}

function drawOne(ctx: CanvasRenderingContext2D, t: Twister, art: HTMLCanvasElement[]): void {
  const g = t.grown * t.grown * (3 - 2 * t.grown);
  const height = HEIGHT * (0.4 + 0.6 * g);
  const widthAt = (h: number) => (FOOT + (TOP - FOOT) * Math.pow(h, 1.6)) * (0.5 + 0.5 * g);
  // the funnel's roundness seen from above and in front: a circle on the ground is drawn this flat
  const flat = 0.35;

  // the dust spun round its foot: back half now, front half after the funnel
  const dustDraw = (front: boolean) => {
    for (const d of t.dust) {
      if ((Math.sin(d.angle) > 0) !== front) continue;
      const r = FOOT * d.reach * (0.6 + 0.4 * g);
      const x = t.x + Math.cos(d.angle) * r, y = t.y + Math.sin(d.angle) * r * flat - d.h * height;
      ctx.globalAlpha = 0.6 * g * (front ? 1 : 0.75);
      const s = d.size * (0.6 + 0.4 * g);
      ctx.drawImage(art[2], x - s, y - s * 0.7, s * 2, s * 1.4);
    }
  };
  dustDraw(false);

  // the funnel: an outline up one side and down the other, round the swaying axis
  const STEPS = 28;
  const edge = (side: number, inset: number) => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= STEPS; i++) {
      const h = i / STEPS;
      // ragged: the edge breathes in and out a little, differently up its length
      const ragged = 1 + 0.06 * Math.sin(h * 23 + time * 5 + side * 2 + t.seed) + 0.04 * Math.sin(h * 41 - time * 7 + t.seed);
      points.push([t.x + axisAt(t, h) + side * widthAt(h) * inset * ragged, t.y - h * height]);
    }
    return points;
  };
  const band = (left: Array<[number, number]>, right: Array<[number, number]>) => {
    ctx.beginPath();
    for (const [x, y] of left) ctx.lineTo(x, y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
  };
  // the body: condensed cloud, darker up into the storm, browned by dust low down; it thins out at the top into the
  // wall cloud and at the very foot into the debris
  const body = ctx.createLinearGradient(0, t.y - height, 0, t.y);
  body.addColorStop(0, "rgba(58, 58, 64, 0)");
  body.addColorStop(0.12, "rgba(66, 66, 72, 0.95)");
  body.addColorStop(0.5, "rgba(112, 112, 116, 0.9)");
  body.addColorStop(0.82, "rgba(128, 118, 102, 0.85)");
  body.addColorStop(0.95, "rgba(124, 104, 80, 0.55)");
  body.addColorStop(1, "rgba(124, 104, 80, 0)");
  ctx.globalAlpha = g;
  ctx.filter = "blur(2.5px)";
  ctx.fillStyle = body;
  band(edge(-1, 0.85), edge(1, 0.85));
  ctx.fill();
  // round: lit down the left, in shadow down the right
  ctx.filter = "blur(4px)";
  ctx.fillStyle = "rgb(196, 196, 198)";
  ctx.globalAlpha = g * 0.22;
  band(edge(-1, 0.55), edge(-1, 0.05));
  ctx.fill();
  ctx.fillStyle = "rgb(24, 24, 30)";
  ctx.globalAlpha = g * 0.4;
  band(edge(1, 0.2), edge(1, 0.85));
  ctx.fill();
  ctx.filter = "none";

  // its spin: strands of cloud wound round it, seen where they pass in front, drifting round as it turns
  ctx.lineCap = "round";
  for (let k = 0; k < STRANDS; k++) {
    const phase = (k / STRANDS) * Math.PI * 2 + t.seed;
    const twist = 7 + (k % 3);
    const alpha = g * (k % 3 === 0 ? 0.22 : 0.16);
    ctx.strokeStyle = k % 3 === 0 ? "rgb(36, 36, 42)" : "rgb(176, 176, 180)";
    ctx.lineWidth = 1 + (k % 2);
    let drawing = false;
    for (let i = 0; i <= STEPS * 2; i++) {
      const h = i / (STEPS * 2);
      const a = phase + h * twist - time * (3.2 - 1.6 * h);
      const front = Math.cos(a);
      const x = t.x + axisAt(t, h) + Math.sin(a) * widthAt(h) * 0.8, y = t.y - h * height + front * widthAt(h) * 0.8 * flat;
      // (only in front; faint where it turns away, and at the top and the foot)
      const show = front * Math.sin(Math.min(1, h * 1.15) * Math.PI);
      if (show > 0.15) {
        if (!drawing) { ctx.beginPath(); ctx.moveTo(x, y); drawing = true; }
        else ctx.lineTo(x, y);
      } else if (drawing) {
        ctx.globalAlpha = alpha;
        ctx.stroke();
        drawing = false;
      }
    }
    if (drawing) { ctx.globalAlpha = alpha; ctx.stroke(); }
  }

  // wisps riding its edges, so its outline is ragged: behind the axis first, then in front
  for (const front of [false, true]) {
    for (const p of t.puffs) {
      const sin = Math.sin(p.angle);
      if ((sin > 0) !== front) continue;
      const w = widthAt(p.h) * p.spread;
      const x = t.x + axisAt(t, p.h) + Math.cos(p.angle) * w;
      const y = t.y - p.h * height + sin * w * flat;
      const s = (5 + 16 * p.h) * p.size * (0.6 + 0.4 * g);
      const dusty = p.h < 0.22 && p.shade < 0.7;
      ctx.globalAlpha = g * (front ? 0.3 : 0.2) * (0.5 + 0.5 * Math.abs(Math.cos(p.angle)));
      ctx.drawImage(dusty ? art[2] : Math.cos(p.angle) > 0 ? art[1] : art[0], x - s, y - s, s * 2, s * 2);
    }
  }

  // the wall cloud it hangs from: wide, dark and flat underneath, turning slowly
  const topX = t.x + axisAt(t, 1), topY = t.y - height;
  for (let i = 0; i < WALL; i++) {
    const a = time * 0.35 + (i / WALL) * Math.PI * 2 + t.seed;
    const r = widthAt(1) * (0.5 + (1.6 * ((i * 7) % WALL)) / WALL);
    const x = topX + Math.cos(a) * r, y = topY - 10 + Math.sin(a) * r * flat;
    const s = (48 + (i % 4) * 14) * (0.6 + 0.4 * g);
    ctx.globalAlpha = g * (Math.sin(a) > 0 ? 0.6 : 0.45);
    ctx.drawImage(art[1], x - s, y - s * 0.55, s * 2, s * 1.1);
  }

  // debris, whirled round the lower part; the odd bit flung out and brought back
  ctx.fillStyle = "#2e2620";
  for (const d of t.debris) {
    const fling = Math.max(0, Math.sin(time * 0.7 + d.reach * 3)) ** 8 * 2.5;
    const r = widthAt(d.h) * (d.reach + fling);
    const x = t.x + axisAt(t, d.h) + Math.cos(d.angle) * r;
    const y = t.y - d.h * height + Math.sin(d.angle) * r * flat;
    ctx.globalAlpha = 0.85 * g;
    ctx.fillRect(x - d.size / 2, y - d.size / 2, d.size, d.size);
  }

  dustDraw(true);
  ctx.globalAlpha = 1;
}
