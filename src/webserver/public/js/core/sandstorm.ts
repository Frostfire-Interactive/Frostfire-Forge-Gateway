/**
 * USER REQUEST 2026-10-16 ("a new weather called sandstorm that only happens when the player is in the desert biome.
 * It should tint the screen and look identical to a real life sandstorm"; "if it's windy with the weather_api, a
 * sandstorm should occur at different levels of harshness"): the sandstorm, drawn on the weather canvas when the
 * weather is "sandstorm" and the player stands in one of the map's desert zones (window.mapData.deserts, outlines in
 * tiles, sent with a world). Outside a desert, or on a map with none, the sky is clear.
 *
 * What a real one looks like, from back to front:
 * - the light itself turns orange: a full-screen tint under the weather canvas, multiplied over the scene (TINT);
 * - the air is thick with dust, lighter and flatter than the ground: an even haze, denser away from the player, so
 *   only what is near is seen clearly;
 * - the dust rolls past in billows: two layers of soft fractal cloud, carried along the wind at different paces;
 * - dust blows by in round motes, soft at the edge, in three tones, the nearest the largest and quickest (USER
 *   REQUEST 2026-10-16: "The sand particles should be circles, not lines. It should look like dust").
 *
 * How harsh it is comes from the wind speed (HARSH_FROM to HARSH_FULL mph, never less than LEAST): the seeded
 * sandstorm blows at 35, a dry reading of the real weather at SANDSTORM_WIND (1, any wind, systems/weatherapi.ts in the
 * engine) or more. Gusts thicken it. It rises and falls over FADE_SECONDS when the player walks in or out of a desert,
 * and when the weather changes.
 */
const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

// (from still air up: a breeze of a few mph is a faint drift of sand, 15 a light storm, 35 a heavy one)
const HARSH_FROM = 0, HARSH_FULL = 45, LEAST = 0.04;
const FADE_SECONDS = 2.5;
/** How often (ms) the player is looked for in the deserts. */
const LOOK_EVERY = 250;
/** A frame gap this long (ms) means the weather was not drawn for a while (a house, a map change): the storm is gone. */
const STALE_GAP = 250;
/** The tint at full harshness: multiplied over the scene, as much as TINT_MAX. */
const TINT = "rgb(224, 158, 88)", TINT_MAX = 0.72;
const HAZE = "196, 142, 84", HAZE_MAX = 0.4, EDGE_MAX = 0.38;
const GRAIN_COUNT = isMobileDevice ? 350 : 1400;
/** A light, a middle and a dark tone: against sand, a grain is seen by being lighter or darker than it. */
const GRAIN_TONES = ["252, 232, 186", "226, 178, 112", "142, 94, 50"];
/**
 * USER REPORT 2026-10-17 ("the particles should only ever move left or right, not up or down because it makes it look
 * like snow"): the sand blows left with a wind to the left, and right with any other (up, down, none: the real weather's
 * wind can blow any of them). Its turbulence speeds and slows it along the wind, never up or down.
 *
 * USER REPORT 2026-10-17 ("Sandstorm when weather_api is selected flickers"): the dust clouds were placed by the
 * camera's place in the world plus how far they had drifted, which only grows: on the 10240-tile world, hundreds of
 * thousands of px, past what the graphics card keeps exactly, so the clouds jumped about. Their pattern repeats, so
 * each place is taken within one repeat (the same picture, small numbers). A gust thickens the storm and speeds the
 * sand, eased in and out over GUST_EASE seconds, not as fast as the gust rises (a quick throb in the tint and haze).
 */
const GUST_EASE = 1.2;

interface Desert {
  bbox: { x: number; y: number; w: number; h: number };
  outline: number[][][];
}

/** Whether a point in tiles is in a desert: inside an odd number of its rings (a ring inside another is a hole). */
function inDesert(deserts: Desert[] | null | undefined, x: number, y: number): boolean {
  if (!Array.isArray(deserts)) return false;
  for (const desert of deserts) {
    const b = desert.bbox;
    if (!b || x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
    let inside = false;
    for (const ring of desert.outline || []) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

/**
 * A soft, tileable cloud of dust: fractal value noise, its brightness turned into how thick the dust is. Made once;
 * drawn scaled up, so it is small.
 */
function makeDustTexture(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const octaves = [{ cells: 4, weight: 0.5 }, { cells: 8, weight: 0.26 }, { cells: 16, weight: 0.14 }, { cells: 32, weight: 0.1 }];
  const grids = octaves.map((o) => Array.from({ length: o.cells * o.cells }, () => Math.random()));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let n = 0;
      octaves.forEach((o, k) => {
        const fx = (px / size) * o.cells, fy = (py / size) * o.cells;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
        const at = (x: number, y: number) => grids[k][((y % o.cells) * o.cells) + (x % o.cells)];
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        n += (top + (bottom - top) * ty) * o.weight;
      });
      // Thin spots let the scene through; the thick ones are billows.
      // (browner than the sand, so a billow is seen rolling over the ground, the thickest the darkest)
      const t = Math.min(1, Math.max(0, (n - 0.38) / 0.3));
      const i = (py * size + px) * 4;
      image.data[i] = 196 - t * 40;
      image.data[i + 1] = 138 - t * 36;
      image.data[i + 2] = 78 - t * 26;
      image.data[i + 3] = smooth(t) * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // Softened, so the noise's grid does not show as squares: blurred among copies of itself on every side, then cut
  // back out, so it still tiles without a seam.
  const tiled = document.createElement("canvas");
  tiled.width = tiled.height = size * 3;
  const tiledCtx = tiled.getContext("2d")!;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) tiledCtx.drawImage(canvas, dx * size, dy * size);
  const soft = document.createElement("canvas");
  soft.width = soft.height = size;
  const softCtx = soft.getContext("2d")!;
  softCtx.filter = `blur(${Math.round(size / 28)}px)`;
  if (softCtx.filter === "none") return canvas;
  softCtx.drawImage(tiled, -size, -size);
  return soft;
}

class Grain {
  x = 0;
  y = 0;
  /** 0 far to 1 near: the near ones are larger, quicker and more see-through. */
  depth = 0;
  pace = 1;
  /** Its speed more or less along the wind than the rest, px a second: turbulence, a random walk. */
  along = 0;
  tone = 0;
  /** Its radius, px. */
  size = 1;

  reset(width: number, height: number, anywhere: boolean, angle: number) {
    this.depth = Math.random();
    this.pace = 0.6 + this.depth * 0.9 + Math.random() * 0.2;
    this.along = 0;
    this.tone = Math.floor(Math.random() * GRAIN_TONES.length);
    this.size = this.depth > NEAR ? 1.8 + Math.random() * 2.2 : 0.9 + Math.random() * 1;
    if (anywhere) {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      return;
    }
    // In from the side the wind blows from.
    const cos = Math.cos(angle), sin = Math.sin(angle);
    if (Math.abs(cos) >= Math.abs(sin)) {
      this.x = cos > 0 ? -40 * Math.random() : width + 40 * Math.random();
      this.y = Math.random() * height;
    } else {
      this.x = Math.random() * width;
      this.y = sin > 0 ? -40 * Math.random() : height + 40 * Math.random();
    }
  }
}

const grains: Grain[] = [];
/** Deeper than this a mote is near: drawn larger and fainter. */
const NEAR = 0.6;
/** A mote's share of the wind's pace: dust drifts and swirls, slower than the wind that carries it. */
const DRIFT = 0.45;
/**
 * USER REPORT 2026-10-16 ("Why do the sand particle bob like they are in water? That's unrealistic"): a mote was swung
 * across the wind on a sine, the same beat over and over. Air does not beat: a mote is now pushed by turbulence, a
 * random walk of its speed along the wind (not across it since 2026-10-17: see GUST_EASE) that is pulled back toward
 * none (an Ornstein-Uhlenbeck process). TURB_PULL is how fast it is pulled back (a second), TURB_KICK how hard it is pushed, px a second for each
 * mph of wind (plus TURB_STILL), the near motes the most: a mote veers, gets carried off a little, and settles, never
 * twice the same.
 */
const TURB_PULL = 1.8, TURB_KICK = 4, TURB_STILL = 20;
/** A random number of about a normal spread (mean 0, deviation 1), cheaply. */
const jolt = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

/** One soft round mote of each tone: solid in the middle, fading to nothing at its edge. Drawn scaled to each mote. */
let motes: HTMLCanvasElement[] | null = null;
function moteSprites(): HTMLCanvasElement[] {
  if (motes) return motes;
  return (motes = GRAIN_TONES.map((tone) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    const fill = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    fill.addColorStop(0, `rgba(${tone}, 1)`);
    fill.addColorStop(0.5, `rgba(${tone}, 0.9)`);
    fill.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 32, 32);
    return canvas;
  }));
}

let dust: HTMLCanvasElement | null = null;
let tint: HTMLDivElement | null = null;
let presence = 0;
let harshness = 0;
let inside = false;
let lookedAt = 0;
let lastDraw = 0;
let driftA = 0, driftB = 0;
let gust = 0;
let lastCameraX = NaN, lastCameraY = NaN;
let time = 0;

function ensureTint(): HTMLDivElement {
  if (tint) return tint;
  tint = document.createElement("div");
  tint.id = "sandstorm-tint";
  tint.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;mix-blend-mode:multiply;background:${TINT};opacity:0;`;
  // Under the weather canvas (same z-index, earlier in the page): it colours the scene, not the dust.
  const canvas = document.getElementById("weather");
  if (canvas?.parentNode) canvas.parentNode.insertBefore(tint, canvas);
  else document.body.appendChild(tint);
  return tint;
}

function setTint(opacity: number) {
  if (!tint && opacity <= 0) return;
  const next = opacity.toFixed(3);
  const el = ensureTint();
  if (el.style.opacity !== next) el.style.opacity = next;
}

// Not drawn for a while (the weather canvas is not drawn in a house, nor between maps): the tint goes with it.
setInterval(() => {
  if (presence > 0 && performance.now() - lastDraw > STALE_GAP) {
    presence = 0;
    setTint(0);
  }
}, STALE_GAP);

export interface SandstormFrame {
  /** Whether the weather is a sandstorm. */
  wanted: boolean;
  deltaMs: number;
  /** The weather's wind speed (mph), without gusts: how harsh it is. */
  baseWind: number;
  /** The gust now, 0 to 1. */
  gust: number;
  windDirection: string | null;
  /** The weather canvas's top left in the world, px. */
  cameraX: number;
  cameraY: number;
  width: number;
  height: number;
  /** Where the player is, in world px (the storm is around them, and they are in a desert or not). */
  focusX: number;
  focusY: number;
}

/** Draws the sandstorm for this frame. Returns how much of it is shown, 0 to 1. */
export function drawSandstorm(ctx: CanvasRenderingContext2D, f: SandstormFrame): number {
  const now = performance.now();
  if (now - lastDraw > STALE_GAP) {
    // Coming back to it (a map change, a hidden tab): start from where things are, not from where they were.
    presence = 0;
    lastCameraX = NaN;
    lookedAt = 0;
  }
  lastDraw = now;
  const seconds = Math.min(0.1, f.deltaMs / 1000);
  time += seconds;

  if (f.wanted && now - lookedAt >= LOOK_EVERY) {
    lookedAt = now;
    const map = (window as any).mapData;
    inside = inDesert(map?.deserts, f.focusX / (map?.tilewidth || 16), f.focusY / (map?.tileheight || 16));
  }
  const target = f.wanted && inside ? 1 : 0;
  const step = seconds / FADE_SECONDS;
  presence = target > presence ? Math.min(target, presence + step) : Math.max(target, presence - step);

  const harsh = Math.min(1, Math.max(LEAST, (f.baseWind - HARSH_FROM) / (HARSH_FULL - HARSH_FROM)));
  harshness += (harsh - harshness) * Math.min(1, seconds / FADE_SECONDS * 2);

  if (presence <= 0) {
    setTint(0);
    lastCameraX = NaN;
    return 0;
  }

  const p = presence * presence * (3 - 2 * presence);
  const amount = p * harshness;
  gust += (f.gust - gust) * Math.min(1, seconds / GUST_EASE);
  const thick = Math.min(1, amount * (0.94 + 0.12 * gust));
  const { width, height } = f;
  // left or right only: 1 to the right, -1 to the left
  const cos = String(f.windDirection ?? "").trim().toLowerCase() === "left" ? -1 : 1;
  const angle = cos > 0 ? 0 : Math.PI;
  // How fast the sand flies, px a second: a 35 mph storm is a blur.
  const pace = (260 + f.baseWind * 22) * (1 + 0.3 * gust);

  // The camera's move since the last frame: what blows past moves against it, the nearest the most.
  const moveX = Number.isNaN(lastCameraX) ? 0 : f.cameraX - lastCameraX;
  const moveY = Number.isNaN(lastCameraY) ? 0 : f.cameraY - lastCameraY;
  lastCameraX = f.cameraX;
  lastCameraY = f.cameraY;

  setTint(TINT_MAX * thick);

  ctx.save();

  // The haze: even, and thicker away from the player, so far things fade into the dust.
  ctx.fillStyle = `rgba(${HAZE}, ${(HAZE_MAX * thick).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);
  const cx = f.focusX - f.cameraX, cy = f.focusY - f.cameraY;
  const near = Math.min(width, height) * (0.42 - 0.22 * thick);
  const far = Math.hypot(width, height) * 0.6;
  const edge = ctx.createRadialGradient(cx, cy, near, cx, cy, far);
  edge.addColorStop(0, `rgba(${HAZE}, 0)`);
  edge.addColorStop(1, `rgba(${HAZE}, ${(EDGE_MAX * thick).toFixed(3)})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, width, height);

  // The billows: two layers of dust cloud blown along the wind, the far one larger and slower.
  if (!dust) dust = makeDustTexture(isMobileDevice ? 128 : 192);
  const pattern = ctx.createPattern(dust, "repeat");
  if (pattern) {
    // (kept small: only where they are within a repeat matters)
    driftA = (driftA + pace * 0.35 * seconds) % (dust.width * 4.5 * 64);
    driftB = (driftB + pace * 0.6 * seconds) % (dust.width * 4.8 * 64);
    const layers = isMobileDevice
      ? [{ drift: driftB, scale: 4, parallax: 0.9, alpha: 0.45 }]
      : [
        { drift: driftA, scale: 4.5, parallax: 0.7, alpha: 0.4 },
        { drift: driftB, scale: 2.4, parallax: 1, alpha: 0.28 },
      ];
    const wrap = (v: number, period: number) => ((v % period) + period) % period;
    for (const layer of layers) {
      // Along the wind, swaying slowly a little above and below it, so the billows change shape as they pass one another;
      // each place taken within one repeat of the pattern (it is the same picture there)
      const period = dust.width * layer.scale;
      const sway = Math.sin(time * 0.15 + layer.scale) * 40;
      const ox = wrap(cos * layer.drift - f.cameraX * layer.parallax, period);
      const oy = wrap(sway - f.cameraY * layer.parallax, period);
      pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(layer.scale));
      ctx.globalAlpha = Math.min(1, layer.alpha * Math.min(1, thick * 1.5));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalAlpha = 1;
  }

  // The dust: round motes carried along the wind, swirling as they go.
  while (grains.length < GRAIN_COUNT) {
    const g = new Grain();
    g.reset(width, height, true, angle);
    grains.push(g);
  }
  // USER REPORT 2026-10-16 ("they are too visible when there is barely any sand being blown"): how many motes, and how
  // solid, both follow the harshness, and the number the faster of the two: a breeze carries a few faint ones, a gale
  // the lot (6 mph about 5% of them at half strength, 15 mph about 25%, 35 mph about 90%).
  const dense = Math.min(1, harshness * 1.2);
  const count = Math.round(GRAIN_COUNT * p * Math.pow(dense, 1.5));
  const solid = 0.3 + 0.7 * dense;
  const kick = (TURB_STILL + TURB_KICK * f.baseWind) * Math.sqrt(seconds);
  const pull = Math.max(0, 1 - TURB_PULL * seconds);
  const sprites = moteSprites();
  for (let tone = 0; tone < GRAIN_TONES.length; tone++) {
    for (const layer of [0, 1]) {
      // The far motes small and solid, the near ones large and faint.
      ctx.globalAlpha = (layer ? 0.7 : 1) * (0.5 + 0.5 * p) * solid;
      for (let i = 0; i < count; i++) {
        const g = grains[i];
        if (g.tone !== tone || (g.depth > NEAR ? 1 : 0) !== layer) continue;
        const push = kick * (0.5 + g.depth);
        g.along = g.along * pull + jolt() * push;
        const run = Math.max(0, pace * DRIFT * g.pace + g.along) * seconds;
        // along the wind only; the camera's move is what shifts them up or down
        g.x += cos * run - moveX * (0.4 + g.depth * 0.6);
        g.y -= moveY * (0.4 + g.depth * 0.6);
        if (g.x < -60 || g.x > width + 60 || g.y < -60 || g.y > height + 60) {
          g.reset(width, height, false, angle);
          continue;
        }
        const diameter = g.size * 2.4;
        ctx.drawImage(sprites[tone], g.x - diameter / 2, g.y - diameter / 2, diameter, diameter);
      }
    }
  }
  ctx.globalAlpha = 1;

  ctx.restore();
  return p;
}
