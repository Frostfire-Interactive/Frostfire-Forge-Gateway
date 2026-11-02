// The cutscene document and what a moment of it looks like. Everything here works out the state of a scene at a time t
// from the document alone, with nothing remembered from the moment before, so a scene plays, scrubs and jumps the same.
// No DOM and no game state: the editor's popup uses it as well as the game window (cutscene.ts).
//
// The document is described in docs/superpowers/specs/2026-10-31-cutscene-tool-design.md; the server checks every field
// of it when it is saved (the engine's systems/cutscenes.ts).

export type Ease = "linear" | "smooth" | "in" | "out" | "hold";
export type Dir = "up" | "down" | "left" | "right";
export type Point = { x: number; y: number };

export interface Settings {
  letterbox: boolean; letterboxSize: number;
  hideHud: boolean; hideOthers: boolean; hideSelf: boolean; hideCreatures: boolean;
  skippable: boolean; lock: boolean;
  worldVolume: number; fadeIn: number; fadeOut: number;
}

export type Look =
  | { kind: "npc"; npcId: number }
  | { kind: "viewer" }
  | { kind: "layers"; sprite_type: "animated" | "static"; body: string | null; head: string | null; helmet: string | null; shoulderguards: string | null; neck: string | null; hands: string | null; chest: string | null; feet: string | null; legs: string | null; weapon: string | null };

export interface Actor {
  id: string; name: string; showName: boolean; look: Look;
  x: number; y: number; direction: Dir; visible: boolean;
  // Filled in by the server when it resolves a doc.
  sprite_type?: string; spriteLayers?: any;
}

export interface Item { id: string; t: number; d: number }
export interface CameraKey extends Item { x: number; y: number; zoom: number; ease: Ease; follow: string | null }
export interface ShakeClip extends Item { strength: number; speed: number }
export interface ScreenClip extends Item { effect: "fade" | "flash" | "tint" | "vignette"; color: string; amount: number; in: number; out: number }
export interface TextClip extends Item {
  style: "title" | "subtitle" | "caption" | "dialogue";
  text: string; sub: string; speaker: string; x: number; y: number;
  in: number; out: number; typewriter: number; color: string; size: number;
}
export type ActorItem = Item & (
  | { do: "move"; path: Point[]; ease: Ease; animation: string }
  | { do: "place"; x: number; y: number; direction: Dir }
  | { do: "face"; direction: Dir }
  | { do: "animate"; animation: string }
  | { do: "say"; text: string }
  | { do: "show" }
  | { do: "hide" }
);
export interface AudioClip extends Item { sound: string; bus: "music" | "effects"; volume: number; rate: number; loop: boolean; in: number; out: number }
export type WorldClip = Item & (
  | { do: "weather"; weather: string; weatherData?: any }
  | { do: "time"; from: number; to: number }
  | { do: "particles"; particle: string; x: number; y: number; particleData?: any }
);
export interface Mark extends Item { name: string }

export type Track =
  | { id: string; kind: "camera"; label: string; muted?: boolean; items: CameraKey[] }
  | { id: string; kind: "shake"; label: string; muted?: boolean; items: ShakeClip[] }
  | { id: string; kind: "screen"; label: string; muted?: boolean; items: ScreenClip[] }
  | { id: string; kind: "text"; label: string; muted?: boolean; items: TextClip[] }
  | { id: string; kind: "actor"; label: string; muted?: boolean; actor: string; items: ActorItem[] }
  | { id: string; kind: "audio"; label: string; muted?: boolean; items: AudioClip[] }
  | { id: string; kind: "world"; label: string; muted?: boolean; items: WorldClip[] }
  | { id: string; kind: "mark"; label: string; muted?: boolean; items: Mark[] };

export interface Trigger {
  id: string;
  on: "area" | "map" | "login" | "quest_accept" | "quest_complete" | "npc";
  once: boolean; minLevel: number;
  x: number; y: number; w: number; h: number;
  questId: number | null; npcId: number | null;
}

export interface CutsceneDoc {
  name: string; description: string; map: string; duration: number;
  settings: Settings;
  actors: Actor[]; tracks: Track[]; triggers: Trigger[];
  end: { teleport: { map: string; x: number; y: number } | null; next: string | null };
}

/** A thing of the scene that has a place in the world, as the editor's popup and the game window speak of it. */
export type PlaceRef =
  | { kind: "key" | "place" | "particle"; track: string; item: string }
  | { kind: "point"; track: string; item: string; index: number }
  | { kind: "newPoint"; track: string; item: string }
  | { kind: "actor"; actor: string }
  | { kind: "teleport" }
  | { kind: "trigger"; trigger: string; part: "move" | "size" }
  | { kind: "area"; trigger: string };

/** The settings of a new scene. */
export function defaultSettings(): Settings {
  return {
    letterbox: true, letterboxSize: 0.1,
    hideHud: true, hideOthers: false, hideSelf: false, hideCreatures: false,
    skippable: true, lock: true,
    worldVolume: 1, fadeIn: 0.5, fadeOut: 0.5,
  };
}

/** A new, empty scene on a map. */
export function emptyDoc(map: string): CutsceneDoc {
  return {
    name: "", description: "", map, duration: 10,
    settings: defaultSettings(),
    actors: [],
    tracks: [{ id: "t1", kind: "camera", label: "Camera", items: [] }],
    triggers: [],
    end: { teleport: null, next: null },
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

export function ease(kind: Ease, p: number): number {
  switch (kind) {
    case "hold": return p >= 1 ? 1 : 0;
    case "in": return p * p;
    case "out": return 1 - (1 - p) * (1 - p);
    case "smooth": return p * p * (3 - 2 * p);
    default: return p;
  }
}

/** How far in a clip with these fades is at t, 0 to 1: nothing outside it. */
export function envelope(t: number, start: number, length: number, fadeIn: number, fadeOut: number): number {
  const into = t - start, left = start + length - t;
  if (into < 0 || left < 0) return 0;
  return Math.min(fadeIn > 0 ? clamp01(into / fadeIn) : 1, fadeOut > 0 ? clamp01(left / fadeOut) : 1);
}

/**
 * A document made ready to read many times a frame: the live tracks' items gathered by kind and put in time order, so a
 * muted track simply is not there.
 */
export interface Plan {
  keys: CameraKey[];
  shakes: ShakeClip[];
  screens: ScreenClip[];
  texts: TextClip[];
  audio: AudioClip[];
  world: { weather: (WorldClip & { do: "weather" })[]; time: (WorldClip & { do: "time" })[]; particles: (WorldClip & { do: "particles" })[] };
  /** What each actor does, by actor id. */
  acts: Map<string, ActorItem[]>;
}

export function makePlan(doc: CutsceneDoc): Plan {
  const plan: Plan = { keys: [], shakes: [], screens: [], texts: [], audio: [], world: { weather: [], time: [], particles: [] }, acts: new Map() };
  for (const track of doc.tracks) {
    if (track.muted) continue;
    switch (track.kind) {
      case "camera": plan.keys.push(...track.items); break;
      case "shake": plan.shakes.push(...track.items); break;
      case "screen": plan.screens.push(...track.items); break;
      case "text": plan.texts.push(...track.items); break;
      case "audio": plan.audio.push(...track.items); break;
      case "world":
        for (const item of track.items) {
          if (item.do === "weather") plan.world.weather.push(item);
          else if (item.do === "time") plan.world.time.push(item);
          else plan.world.particles.push(item);
        }
        break;
      case "actor": {
        const acts = plan.acts.get(track.actor);
        if (acts) acts.push(...track.items);
        else plan.acts.set(track.actor, [...track.items]);
        break;
      }
    }
  }
  const byTime = (a: Item, b: Item) => a.t - b.t;
  plan.keys.sort(byTime);
  plan.world.weather.sort(byTime);
  plan.world.time.sort(byTime);
  for (const acts of plan.acts.values()) acts.sort(byTime);
  return plan;
}

function pointOnPath(from: Point, path: Point[], p: number): { x: number; y: number; dx: number; dy: number } {
  const stops = [from, ...path];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    const l = Math.hypot(stops[i]!.x - stops[i - 1]!.x, stops[i]!.y - stops[i - 1]!.y);
    lengths.push(l);
    total += l;
  }
  let walked = total * p;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!, a = stops[i]!, b = stops[i + 1]!;
    if (walked <= l || i === lengths.length - 1) {
      const q = l > 0 ? clamp01(walked / l) : 1;
      return { x: lerp(a.x, b.x, q), y: lerp(a.y, b.y, q), dx: b.x - a.x, dy: b.y - a.y };
    }
    walked -= l;
  }
  return { x: from.x, y: from.y, dx: 0, dy: 0 };
}

/** Which of the four ways a move goes. */
function facing(dx: number, dy: number, otherwise: Dir): Dir {
  if (dx === 0 && dy === 0) return otherwise;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

export interface Pose { x: number; y: number; direction: Dir; visible: boolean; animation: string; say: string }

/** An actor at time t: its start, then everything it has done by then, in order. */
export function poseAt(plan: Plan, actor: Actor, t: number): Pose {
  let x = actor.x, y = actor.y, direction = actor.direction, visible = actor.visible, animation = "idle", say = "";
  for (const act of plan.acts.get(actor.id) ?? []) {
    if (act.t > t) break;
    const within = t < act.t + act.d;
    switch (act.do) {
      case "place": x = act.x; y = act.y; direction = act.direction; break;
      case "face": direction = act.direction; break;
      case "show": visible = true; break;
      case "hide": visible = false; break;
      case "say": if (within) say = act.text; break;
      case "animate": animation = act.d === 0 || within ? act.animation : "idle"; break;
      case "move": {
        const p = act.d > 0 ? clamp01((t - act.t) / act.d) : 1;
        const at = pointOnPath({ x, y }, act.path, ease(act.ease, p));
        x = at.x;
        y = at.y;
        direction = facing(at.dx, at.dy, direction);
        animation = p < 1 ? act.animation : "idle";
        break;
      }
    }
  }
  return { x, y, direction, visible, animation: `${animation}_${direction}`, say };
}

export interface Shot { x: number; y: number; zoom: number }

const curve = (a: number, b: number, c: number, d: number, p: number) =>
  0.5 * (2 * b + (c - a) * p + (2 * a - 5 * b + 4 * c - d) * p * p + (3 * b - a - 3 * c + d) * p * p * p);

/**
 * Where the camera is at time t; null when the scene sets no camera (it stays on the player).
 *
 * The camera runs on one curve through its keys, so a path bends rather than turning at each key. A key's `ease` says
 * how it arrives: "linear" keeps its speed and runs on through the key, "smooth" slows into it, "hold" cuts to it.
 * Zoom is eased by ratio, so going from 1 to 2 feels the same as going from 2 to 3. `where` finds what a key follows.
 */
export function shotAt(plan: Plan, t: number, where: (who: string) => Point | null): Shot | null {
  const keys = plan.keys;
  if (!keys.length) return null;
  const spot = (key: CameraKey): Point => {
    const anchor = key.follow ? where(key.follow) : null;
    return { x: key.x + (anchor?.x ?? 0), y: key.y + (anchor?.y ?? 0) };
  };
  const first = keys[0]!, last = keys[keys.length - 1]!;
  if (t <= first.t) return { ...spot(first), zoom: first.zoom };
  if (t >= last.t) return { ...spot(last), zoom: last.zoom };
  let i = 0;
  while (keys[i + 1]!.t <= t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const p = ease(b.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
  const pa = spot(a), pb = spot(b);
  // (a cut on either side ends the curve: what is across it does not bend this stretch)
  const before = a.ease === "hold" || !keys[i - 1] ? pa : spot(keys[i - 1]!);
  const after = keys[i + 2] && keys[i + 2]!.ease !== "hold" ? spot(keys[i + 2]!) : pb;
  return {
    x: curve(before.x, pa.x, pb.x, after.x, p),
    y: curve(before.y, pa.y, pb.y, after.y, p),
    zoom: a.zoom * (b.zoom / a.zoom) ** p,
  };
}

/** The camera's shake at time t, world pixels off its place. Two waves, so it does not read as a single wobble. */
export function shakeAt(plan: Plan, t: number): Point {
  let x = 0, y = 0;
  for (const clip of plan.shakes) {
    const amount = clip.strength * envelope(t, clip.t, clip.d, Math.min(0.1, clip.d / 4), clip.d / 2);
    if (amount <= 0) continue;
    const w = t * clip.speed * Math.PI * 2;
    x += amount * Math.sin(w) * Math.cos(w * 0.37);
    y += amount * Math.sin(w * 1.3 + 1) * Math.cos(w * 0.53);
  }
  return { x, y };
}

/** The hour the scene sets at time t, null when it sets none yet. */
export function hourAt(plan: Plan, t: number): number | null {
  let hour: number | null = null;
  for (const clip of plan.world.time) {
    if (clip.t > t) break;
    const p = clip.d > 0 ? clamp01((t - clip.t) / clip.d) : 1;
    hour = lerp(clip.from, clip.to, ease("smooth", p));
  }
  return hour;
}

/** The weather the scene sets at time t, null when it sets none yet. */
export function weatherAt(plan: Plan, t: number): (WorldClip & { do: "weather" }) | null {
  let weather: (WorldClip & { do: "weather" }) | null = null;
  for (const clip of plan.world.weather) {
    if (clip.t > t) break;
    weather = clip;
  }
  return weather;
}

/** How far the letterbox bars have come in, 0 to 1, at time t. */
const BARS_MOVE = 0.6;
export function barsAt(doc: CutsceneDoc, t: number): number {
  if (!doc.settings.letterbox) return 0;
  return ease("smooth", Math.min(clamp01(t / BARS_MOVE), clamp01((doc.duration - t) / BARS_MOVE)));
}

/** How black the scene's own fades leave the screen, 0 to 1, at time t. */
export function blackAt(doc: CutsceneDoc, t: number): number {
  const { fadeIn, fadeOut } = doc.settings;
  const opening = fadeIn > 0 ? 1 - clamp01(t / fadeIn) : 0;
  const closing = fadeOut > 0 ? 1 - clamp01((doc.duration - t) / fadeOut) : 0;
  return Math.max(opening, closing);
}

/** A clip's text as it stands at time t: all of it, or as far as the typewriter has reached. */
export function typedText(clip: TextClip, t: number): string {
  if (clip.typewriter <= 0) return clip.text;
  return clip.text.slice(0, Math.floor((t - clip.t) * clip.typewriter));
}

/** A clip's whole length: its own, or for a sound with none, the file's at the clip's speed. */
export function clipLength(clip: AudioClip, fileLength: number | null): number {
  if (clip.d > 0) return clip.d;
  return fileLength !== null ? fileLength / clip.rate : 0;
}
