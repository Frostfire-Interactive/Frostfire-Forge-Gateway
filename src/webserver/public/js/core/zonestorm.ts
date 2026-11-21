const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

// (from still air up: a breeze of a few mph is a faint drift, 15 a light storm, 35 a heavy one)
const HARSH_FROM = 0, HARSH_FULL = 45, LEAST = 0.04;
const FADE_SECONDS = 2.5;
/** How often (ms) the player is looked for in the zones. */
const LOOK_EVERY = 250;
/** A frame gap this long (ms) means the weather was not drawn for a while (a house, a map change): the storm is gone. */
const STALE_GAP = 250;
const GUST_EASE = 1.2;
/** Deeper than this a mote is near: drawn larger and fainter. */
const NEAR = 0.6;
/** Turbulence: how fast a mote's own speed is pulled back to none (a second), and how hard it is pushed. */
const TURB_PULL = 1.8, TURB_KICK = 4, TURB_STILL = 20;
/** A random number of about a normal spread (mean 0, deviation 1), cheaply. */
const jolt = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

/** What makes one storm look as it does. */
export interface ZoneStormLook {
  /** The zones it blows in: the name of their list in window.mapData. */
  zones: "deserts" | "snowfields";
  /** The tint's element id, colour, how it is blended over the scene, and how strong at full harshness. */
  tintId: string;
  tint: string;
  blend: "multiply" | "screen";
  tintMax: number;
  /** The haze: "r, g, b", how thick everywhere and how much more far from the player. */
  haze: string;
  hazeMax: number;
  edgeMax: number;
  /** A billow's colour for how thick it is there, t 0 to 1. */
  billow: (t: number) => [number, number, number];
  /** The billows' strength against the sand's (1). */
  billowAlpha: number;
  /** The motes: how many at most, their three tones ("r, g, b"), their radius far and near ([least, most] px). */
  count: number;
  tones: string[];
  far: [number, number];
  near: [number, number];
  /** A mote's share of the wind's pace. */
  drift: number;
  /** Most px a second a mote falls (when the storm falls at all: SandstormFrame `fall`), and whether it swirls up and down. */
  fall: number;
  swirl: boolean;
}

export interface ZoneStormFrame {
  /** Whether the weather is this storm. */
  wanted: boolean;
  deltaMs: number;
  /** The weather's wind speed (mph), without gusts: how harsh it is. */
  baseWind: number;
  /** The gust now, 0 to 1. */
  gust: number;
  windDirection: string | null;
  /** How much of what blows also falls from the sky, 0 to 1 (a storm with nothing falling still blows). */
  fall?: number;
  /** The weather canvas's top left in the world, px. */
  cameraX: number;
  cameraY: number;
  width: number;
  height: number;
  /** Where the player is, in world px (the storm is around them, and they are in a zone or not). */
  focusX: number;
  focusY: number;
}

interface Zone {
  bbox: { x: number; y: number; w: number; h: number };
  outline: number[][][];
}

/** Whether a point in tiles is in one of `zones`: inside an odd number of its rings (a ring inside another is a hole). */
export function inZone(zones: Zone[] | null | undefined, x: number, y: number): boolean {
  if (!Array.isArray(zones)) return false;
  for (const zone of zones) {
    const b = zone.bbox;
    if (!b || x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
    let inside = false;
    for (const ring of zone.outline || []) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

export function makeCloudTexture(size: number, colour: (t: number) => [number, number, number]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const puff = (radius: number, strength: number) => {
    const x = Math.random() * size, y = Math.random() * size;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const px = x + dx, py = y + dy;
        if (px + radius < 0 || px - radius > size || py + radius < 0 || py - radius > size) continue;
        const fill = ctx.createRadialGradient(px, py, 0, px, py, radius);
        // (about a bell curve, so no puff has an edge)
        fill.addColorStop(0, `rgba(255, 255, 255, ${strength})`);
        fill.addColorStop(0.3, `rgba(255, 255, 255, ${strength * 0.78})`);
        fill.addColorStop(0.6, `rgba(255, 255, 255, ${strength * 0.32})`);
        fill.addColorStop(0.85, `rgba(255, 255, 255, ${strength * 0.07})`);
        fill.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = fill;
        ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
      }
    }
  };
  // a few broad billows, then smaller ones on and between them
  for (let i = 0; i < 30; i++) puff(size * (0.14 + Math.random() * 0.16), 0.2 + Math.random() * 0.2);
  for (let i = 0; i < 60; i++) puff(size * (0.07 + Math.random() * 0.06), 0.08 + Math.random() * 0.1);

  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  const heap: number[] = [];
  for (let i = 3; i < data.length; i += 4 * 7) heap.push(data[i]);
  heap.sort((a, b) => a - b);
  const clear = heap[Math.floor(heap.length * 0.2)], full = Math.max(clear + 1, heap[Math.floor(heap.length * 0.99)]);
  for (let i = 0; i < data.length; i += 4) {
    const t = Math.min(1, Math.max(0, (data[i + 3] - clear) / (full - clear)));
    const [r, g, b] = colour(t);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = t * t * 255;
  }
  const cloud = document.createElement("canvas");
  cloud.width = cloud.height = size;
  cloud.getContext("2d")!.putImageData(image, 0, 0);
  return cloud;
}

interface Mote {
  x: number;
  y: number;
  /** 0 far to 1 near: the near ones are larger, quicker and more see-through. */
  depth: number;
  pace: number;
  /** Its own speed along the wind, and up or down (`swirl` only), px a second: turbulence, a random walk. */
  along: number;
  across: number;
  tone: number;
  /** Its radius, px. */
  size: number;
}

/** A storm that looks as `look` says: returns its draw, which draws it for a frame and says how much of it shows, 0 to 1. */
export function makeZoneStorm(look: ZoneStormLook): (ctx: CanvasRenderingContext2D, f: ZoneStormFrame) => number {
  const count = isMobileDevice ? Math.round(look.count / 4) : look.count;
  const motes: Mote[] = [];
  let sprites: HTMLCanvasElement[] | null = null;
  let tint: HTMLDivElement | null = null;
  let presence = 0, harshness = 0, inside = false, lookedAt = 0, lastDraw = 0;
  let gust = 0;
  const billows = (isMobileDevice
    ? [{ size: 160, scale: 4, parallax: 0.9, alpha: 0.45, speed: 0.6 }]
    : [
      { size: 256, scale: 4.5, parallax: 0.7, alpha: 0.4, speed: 0.35 },
      { size: 384, scale: 2.4, parallax: 1, alpha: 0.28, speed: 0.6 },
    ]).map((layer) => ({ ...layer, cloud: null as HTMLCanvasElement | null, x: 0, y: 0 }));
  /** How much longer a billow is along the wind than across it. */
  const STRETCH = 1.35;
  let lastCameraX = NaN, lastCameraY = NaN;

  const reset = (m: Mote, width: number, height: number, anywhere: boolean, cos: number, falling: boolean) => {
    m.depth = Math.random();
    m.pace = 0.6 + m.depth * 0.9 + Math.random() * 0.2;
    m.along = 0;
    m.across = 0;
    m.tone = Math.floor(Math.random() * look.tones.length);
    const [least, most] = m.depth > NEAR ? look.near : look.far;
    m.size = least + Math.random() * (most - least);
    if (anywhere) {
      m.x = Math.random() * width;
      m.y = Math.random() * height;
      return;
    }
    // In from the side the wind blows from, or, when it falls, as often from the top as its fall is to its run.
    if (falling && Math.random() < 0.35) {
      m.x = Math.random() * width;
      m.y = -40 * Math.random();
      return;
    }
    m.x = cos > 0 ? -40 * Math.random() : width + 40 * Math.random();
    m.y = Math.random() * height;
  };

  const moteSprites = (): HTMLCanvasElement[] => {
    if (sprites) return sprites;
    return (sprites = look.tones.map((tone) => {
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
  };

  const ensureTint = (): HTMLDivElement => {
    if (tint) return tint;
    tint = document.createElement("div");
    tint.id = look.tintId;
    tint.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;mix-blend-mode:${look.blend};background:${look.tint};opacity:0;`;
    // Under the weather canvas (same z-index, earlier in the page): it colours the scene, not what blows.
    const canvas = document.getElementById("weather");
    if (canvas?.parentNode) canvas.parentNode.insertBefore(tint, canvas);
    else document.body.appendChild(tint);
    return tint;
  };
  const setTint = (opacity: number) => {
    if (!tint && opacity <= 0) return;
    const next = opacity.toFixed(3);
    const el = ensureTint();
    if (el.style.opacity !== next) el.style.opacity = next;
  };

  // Not drawn for a while (the weather canvas is not drawn in a house, nor between maps): the tint goes with it.
  setInterval(() => {
    if (presence > 0 && performance.now() - lastDraw > STALE_GAP) {
      presence = 0;
      setTint(0);
    }
  }, STALE_GAP);

  return (ctx, f) => {
    const now = performance.now();
    if (now - lastDraw > STALE_GAP) {
      // Coming back to it (a map change, a hidden tab): start from where things are, not from where they were.
      presence = 0;
      lastCameraX = NaN;
      lookedAt = 0;
    }
    lastDraw = now;
    const seconds = Math.min(0.1, f.deltaMs / 1000);

    if (f.wanted && now - lookedAt >= LOOK_EVERY) {
      lookedAt = now;
      const map = (window as any).mapData;
      inside = inZone(map?.[look.zones], f.focusX / (map?.tilewidth || 16), f.focusY / (map?.tileheight || 16));
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
    // How fast it flies, px a second: a 35 mph storm is a blur.
    const pace = (260 + f.baseWind * 22) * (1 + 0.3 * gust);
    const falling = Math.min(1, Math.max(0, f.fall ?? 0));
    const fall = look.fall * falling;

    // The camera's move since the last frame: what blows past moves against it, the nearest the most.
    const moveX = Number.isNaN(lastCameraX) ? 0 : f.cameraX - lastCameraX;
    const moveY = Number.isNaN(lastCameraY) ? 0 : f.cameraY - lastCameraY;
    lastCameraX = f.cameraX;
    lastCameraY = f.cameraY;

    setTint(look.tintMax * thick);

    ctx.save();

    // The haze: even, and thicker away from the player, so far things fade into it.
    ctx.fillStyle = `rgba(${look.haze}, ${(look.hazeMax * thick).toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
    const cx = f.focusX - f.cameraX, cy = f.focusY - f.cameraY;
    const near = Math.min(width, height) * (0.42 - 0.22 * thick);
    const far = Math.hypot(width, height) * 0.6;
    const edge = ctx.createRadialGradient(cx, cy, near, cx, cy, far);
    edge.addColorStop(0, `rgba(${look.haze}, 0)`);
    edge.addColorStop(1, `rgba(${look.haze}, ${(look.edgeMax * thick).toFixed(3)})`);
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, width, height);

    const wrap = (v: number, period: number) => ((v % period) + period) % period;
    for (const layer of billows) {
      if (!layer.cloud) layer.cloud = makeCloudTexture(layer.size, look.billow);
      const pattern = ctx.createPattern(layer.cloud, "repeat");
      if (!pattern) continue;
      const scaleX = layer.scale * STRETCH, periodX = layer.size * scaleX, periodY = layer.size * layer.scale;
      layer.x = wrap(layer.x + cos * pace * layer.speed * seconds, periodX);
      layer.y = wrap(layer.y + fall * layer.speed * seconds, periodY);
      const ox = wrap(layer.x - f.cameraX * layer.parallax, periodX);
      const oy = wrap(layer.y - f.cameraY * layer.parallax, periodY);
      pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(scaleX, layer.scale));
      ctx.globalAlpha = Math.min(1, layer.alpha * look.billowAlpha * Math.min(1, thick * 1.5));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalAlpha = 1;

    // The motes: carried along the wind, swirling as they go.
    while (motes.length < count) {
      const m: Mote = { x: 0, y: 0, depth: 0, pace: 1, along: 0, across: 0, tone: 0, size: 1 };
      reset(m, width, height, true, cos, falling > 0);
      motes.push(m);
    }
    const dense = Math.min(1, harshness * 1.2);
    const shown = Math.round(count * p * Math.pow(dense, 1.5));
    const solid = 0.3 + 0.7 * dense;
    const kick = (TURB_STILL + TURB_KICK * f.baseWind) * Math.sqrt(seconds);
    const pull = Math.max(0, 1 - TURB_PULL * seconds);
    const art = moteSprites();
    for (let tone = 0; tone < look.tones.length; tone++) {
      for (const layer of [0, 1]) {
        // The far motes small and solid, the near ones large and faint.
        ctx.globalAlpha = (layer ? 0.7 : 1) * (0.5 + 0.5 * p) * solid;
        for (let i = 0; i < shown; i++) {
          const m = motes[i];
          if (m.tone !== tone || (m.depth > NEAR ? 1 : 0) !== layer) continue;
          const push = kick * (0.5 + m.depth);
          m.along = m.along * pull + jolt() * push;
          if (look.swirl) m.across = m.across * pull + jolt() * push * 0.8;
          const run = Math.max(0, pace * look.drift * m.pace + m.along) * seconds;
          // along the wind (and, when it falls or swirls, down and about); the camera's move shifts them against it
          m.x += cos * run - moveX * (0.4 + m.depth * 0.6);
          m.y += (fall * m.pace + m.across) * seconds - moveY * (0.4 + m.depth * 0.6);
          if (m.x < -60 || m.x > width + 60 || m.y < -60 || m.y > height + 60) {
            reset(m, width, height, false, cos, falling > 0);
            continue;
          }
          const diameter = m.size * 2.4;
          ctx.drawImage(art[tone], m.x - diameter / 2, m.y - diameter / 2, diameter, diameter);
        }
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore();
    return p;
  };
}
