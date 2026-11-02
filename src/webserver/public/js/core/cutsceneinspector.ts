// What can be set on each kind of item of a cutscene, for the editor's popup: the fields of its form, what a new one
// starts as, and the tidying after an edit. The server checks all of it again when the scene is saved (the engine's
// systems/cutscenes.ts).
import type { Field, Option } from "./toolfields.js";
import type { Actor, CutsceneDoc, Item, Track } from "./cutscenedoc.js";
import type { IconName } from "./toolkit.js";

export interface SceneLists {
  npcs: Array<{ id: number; name: string; map: string }>;
  weathers: string[];
  particles: string[];
  sounds: string[];
  quests: Array<{ id: number; name: string }>;
  maps: string[];
}

export interface Limits {
  nameMax: number; descriptionMax: number; durationMin: number; durationMax: number; letterboxSizeMax: number; fadeMax: number;
  actorsMax: number; tracksMax: number; triggersMax: number; itemsPerTrackMax: number; textMax: number; subMax: number;
  speakerMax: number; sayMax: number; markNameMax: number; actorNameMax: number; labelMax: number; layerNameMax: number;
  pathPointsMax: number; minLevelMax: number;
}

const of = (values: string[]): Option[] => values.map((value) => ({ value, label: value }));
const titled = (values: string[]): Option[] => values.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1).replace("_", " ") }));

export const DIRECTIONS = titled(["down", "up", "left", "right"]);
const EASES: Option[] = [
  { value: "smooth", label: "Smooth" }, { value: "linear", label: "Steady" }, { value: "in", label: "Speed up" },
  { value: "out", label: "Slow down" }, { value: "hold", label: "Cut" },
];
const MOVE_ANIMATIONS = titled(["walk", "mount_walk", "cast_walk"]);
const ACTOR_ANIMATIONS = titled(["idle", "walk", "cast_idle", "cast_walk", "mount_idle", "mount_walk"]);

/** What can be put on a track of several kinds of item. */
export const ACTOR_ACTIONS: Array<{ value: string; label: string; icon: IconName }> = [
  { value: "move", label: "Move", icon: "move" }, { value: "place", label: "Place", icon: "pin" }, { value: "face", label: "Face", icon: "target" },
  { value: "animate", label: "Animate", icon: "sparkle" }, { value: "say", label: "Say", icon: "megaphone" },
  { value: "show", label: "Show", icon: "eye" }, { value: "hide", label: "Hide", icon: "eyeOff" },
];
export const WORLD_ACTIONS: Array<{ value: string; label: string; icon: IconName }> = [
  { value: "weather", label: "Weather", icon: "cloud" }, { value: "time", label: "Time of day", icon: "clock" }, { value: "particles", label: "Particles", icon: "sparkle" },
];

/** A new item of a track at time t. `here` is where the game's camera is, for what is placed in the world. */
export function blankItem(track: Track, action: string | null, id: string, t: number, here: { x: number; y: number; zoom: number }, lists: SceneLists): any {
  const x = Math.round(here.x), y = Math.round(here.y);
  switch (track.kind) {
    case "camera": return { id, t, d: 0, x, y, zoom: Math.max(1, Math.min(3, here.zoom)), ease: "smooth", follow: null };
    case "shake": return { id, t, d: 1, strength: 6, speed: 12 };
    case "screen": return { id, t, d: 1, effect: "fade", color: "#000000", amount: 1, in: 0.25, out: 0.25 };
    case "text": return { id, t, d: 3, style: "subtitle", text: "", sub: "", speaker: "", x: 0.5, y: 0.85, in: 0.3, out: 0.3, typewriter: 0, color: "#ffffff", size: 1 };
    case "audio": return { id, t, d: 0, sound: lists.sounds[0] ?? "", bus: "music", volume: 1, rate: 1, loop: false, in: 0, out: 0 };
    case "mark": return { id, t, d: 0, name: "mark" };
    case "world":
      if (action === "time") return { id, t, d: 4, do: "time", from: 12, to: 18 };
      if (action === "particles") return { id, t, d: 4, do: "particles", particle: lists.particles[0] ?? "", x, y };
      return { id, t, d: 0, do: "weather", weather: lists.weathers[0] ?? "" };
    case "actor":
      switch (action) {
        case "place": return { id, t, d: 0, do: "place", x, y, direction: "down" };
        case "face": return { id, t, d: 0, do: "face", direction: "down" };
        case "animate": return { id, t, d: 2, do: "animate", animation: "idle" };
        case "say": return { id, t, d: 3, do: "say", text: "" };
        case "show": case "hide": return { id, t, d: 0, do: action };
        default: return { id, t, d: 2, do: "move", path: [{ x, y }], ease: "linear", animation: "walk" };
      }
  }
}

/** The unit of a field whose value the scene keeps as a fraction: the form shows it, and takes it, as a percentage. */
export const PERCENT = "%";

const TIME: Field = { key: "t", label: "Starts at", type: "number", min: 0, step: 0.05, unit: "s" };
const LENGTH: Field = { key: "d", label: "Lasts", type: "number", min: 0, step: 0.05, unit: "s" };
const FADES: Field[] = [
  { key: "in", label: "Fade in", type: "number", min: 0, step: 0.05, unit: "s" },
  { key: "out", label: "Fade out", type: "number", min: 0, step: 0.05, unit: "s" },
];

/** The form of an item. */
export function itemFields(track: Track, item: any, doc: CutsceneDoc, lists: SceneLists, limits: Limits): Field[] {
  switch (track.kind) {
    case "camera": {
      const follow: Option[] = [{ value: "", label: "Nothing (stays where it is put)" }, { value: "viewer", label: "The player watching" }, ...doc.actors.map((a) => ({ value: a.id, label: a.name || a.id }))];
      return [
        TIME,
        { key: "zoom", label: "Zoom", type: "number", min: 1, max: 3, step: 0.05 },
        { key: "ease", label: "Arrives", type: "select", options: () => EASES, hint: "How the camera comes to this point from the one before." },
        { key: "follow", label: "Follows", type: "select", asText: true, options: () => follow, rerender: true },
        { key: "x", label: item.follow ? "Offset X" : "X", type: "number", step: 1, unit: "px" },
        { key: "y", label: item.follow ? "Offset Y" : "Y", type: "number", step: 1, unit: "px" },
      ];
    }
    case "shake":
      return [
        { key: "strength", label: "Strength", type: "number", min: 0, max: 64, step: 1, unit: "px" },
        { key: "speed", label: "Speed", type: "number", min: 1, max: 60, step: 1, unit: "per s" },
        TIME, LENGTH];
    case "screen":
      return [
        { key: "effect", label: "Effect", type: "select", options: () => titled(["fade", "flash", "tint", "vignette"]) },
        TIME, LENGTH,
        { key: "color", label: "Colour", type: "text", maxLength: 7, hint: "As #rrggbb." },
        { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 5, unit: PERCENT },
        ...FADES];
    case "text": {
      const fields: Field[] = [
        { key: "text", label: item.style === "dialogue" ? "Line" : "Text", type: "textarea", maxLength: limits.textMax, rows: 2 },
        { key: "style", label: "Style", type: "select", options: () => titled(["title", "subtitle", "caption", "dialogue"]), rerender: true }];
      if (item.style === "title") fields.push({ key: "sub", label: "Line under it", type: "text", maxLength: limits.subMax, wide: true });
      if (item.style === "dialogue") fields.push({ key: "speaker", label: "Who speaks", type: "text", maxLength: limits.speakerMax });
      fields.push(TIME, LENGTH,
        { key: "x", label: "Across the screen", type: "number", min: 0, max: 100, step: 1, unit: PERCENT, hint: "0 is the left edge, 100 the right." },
        { key: "y", label: "Down the screen", type: "number", min: 0, max: 100, step: 1, unit: PERCENT, hint: "0 is the top, 100 the bottom." },
        { key: "size", label: "Size", type: "number", min: 0.5, max: 3, step: 0.1 },
        { key: "color", label: "Colour", type: "text", maxLength: 7, hint: "As #rrggbb." },
        { key: "typewriter", label: "Types out at", type: "number", min: 0, max: 120, step: 1, unit: "chars/s", hint: "0 shows it all at once." },
        ...FADES);
      return fields;
    }
    case "audio":
      return [
        { key: "sound", label: "Sound", type: "asset", noIcons: true, assets: () => of(lists.sounds) },
        TIME,
        { ...LENGTH, hint: "0 plays the whole sound." },
        { key: "bus", label: "Plays as", type: "segmented", options: () => [{ value: "music", label: "Music" }, { value: "effects", label: "Effect" }], hint: "The player's slider of that name sets how loud it is." },
        { key: "volume", label: "Volume", type: "number", min: 0, max: 100, step: 5, unit: PERCENT },
        { key: "rate", label: "Speed", type: "number", min: 0.25, max: 4, step: 0.05 },
        { key: "loop", label: "Loop", type: "switch" },
        ...FADES];
    case "mark":
      return [{ key: "name", label: "Name", type: "text", maxLength: limits.markNameMax, hint: "Scripts on the server hear this name when the scene reaches it." }, TIME];
    case "world":
      if (item.do === "weather") return [{ key: "weather", label: "Weather", type: "asset", noIcons: true, assets: () => of(lists.weathers), hint: "From here on, until the next weather or the end of the scene." }, TIME];
      if (item.do === "time") {
        return [
          { key: "from", label: "From hour", type: "number", min: 0, max: 24, step: 0.25 },
          { key: "to", label: "To hour", type: "number", min: 0, max: 24, step: 0.25, hint: "It stays at this hour until the scene ends." },
          TIME, LENGTH];
      }
      return [
        { key: "particle", label: "Particles", type: "asset", noIcons: true, assets: () => of(lists.particles), hint: lists.particles.length ? undefined : "The game has no particle effects yet." },
        TIME, LENGTH,
        { key: "x", label: "X", type: "number", step: 1, unit: "px" },
        { key: "y", label: "Y", type: "number", step: 1, unit: "px" }];
    case "actor":
      switch (item.do) {
        case "move":
          return [TIME, LENGTH,
            { key: "ease", label: "Pace", type: "select", options: () => EASES.filter((e) => e.value !== "hold") },
            { key: "animation", label: "Walks as", type: "select", options: () => MOVE_ANIMATIONS }];
        case "place":
          return [TIME,
            { key: "x", label: "X", type: "number", step: 1, unit: "px" },
            { key: "y", label: "Y", type: "number", step: 1, unit: "px" },
            { key: "direction", label: "Facing", type: "select", options: () => DIRECTIONS }];
        case "face": return [{ key: "direction", label: "Facing", type: "select", options: () => DIRECTIONS }, TIME];
        case "animate": return [{ key: "animation", label: "Animation", type: "select", options: () => ACTOR_ANIMATIONS }, TIME, { ...LENGTH, hint: "0 keeps it up until something else changes it." }];
        case "say": return [{ key: "text", label: "Says", type: "textarea", maxLength: limits.sayMax, rows: 2 }, TIME, LENGTH];
        default: return [TIME];
      }
  }
}

/** Puts an edited item back within what the document allows: a box left empty takes what a new item starts with. */
export function tidyItem(track: Track, item: any, doc: CutsceneDoc, lists: SceneLists): void {
  const blank = blankItem(track, item.do ?? null, item.id, 0, { x: 0, y: 0, zoom: 1 }, lists);
  for (const key of Object.keys(blank)) {
    if (typeof blank[key] === "number" && !Number.isFinite(item[key])) item[key] = blank[key];
  }
  if (item.follow === "") item.follow = null;
  item.t = Math.max(0, Math.min(doc.duration, item.t));
  if (blank.d === 0 && track.kind !== "audio") item.d = 0;
  item.d = Math.max(0, Math.min(doc.duration, item.d));
}

const ACTION_NAMES: Record<string, string> = Object.fromEntries([...ACTOR_ACTIONS, ...WORLD_ACTIONS].map((action) => [action.value, action.label]));

/** What an item is, heading its form. */
export function itemTitle(track: Track, item: any): string {
  switch (track.kind) {
    case "camera": return "Camera shot";
    case "shake": return "Camera shake";
    case "screen": return `Screen ${item.effect}`;
    case "text": return "Text on screen";
    case "audio": return "Sound";
    case "mark": return "Marker";
    case "world": return ACTION_NAMES[item.do] ?? "World";
    case "actor": return `${track.label}: ${ACTION_NAMES[item.do] ?? item.do}`;
  }
}

/** What an item does, in a line under its heading. */
export function itemAbout(track: Track, item: any): string {
  switch (track.kind) {
    case "camera": return item.follow ? "From this time the camera stays on who it follows." : "The camera is here at this time, and travels on to the next shot.";
    case "shake": return "Shakes the camera for as long as this lasts.";
    case "screen": return "Covers the screen with colour for as long as this lasts.";
    case "text": return "Shows words over the scene.";
    case "audio": return "Plays a sound or a piece of music.";
    case "mark": return "Tells the server's scripts that the scene got this far.";
    case "world":
      if (item.do === "weather") return "Changes the weather the player sees.";
      if (item.do === "time") return "Moves the light from one hour to another.";
      return "Runs a particle effect at a place in the world.";
    case "actor":
      switch (item.do) {
        case "move": return "Walks along the stops below. Add a stop, then click the place in the game window.";
        case "place": return "Puts the actor somewhere at once.";
        case "face": return "Turns the actor.";
        case "animate": return "Plays one of the actor's animations.";
        case "say": return "Shows a speech bubble over the actor.";
        case "show": return "Brings the actor into view.";
        default: return "Takes the actor out of view.";
      }
  }
}

/** One line on who an actor looks like. */
export function lookLine(actor: Actor, lists: SceneLists): string {
  const look = actor.look;
  if (look.kind === "viewer") return "Looks like the player watching";
  if (look.kind === "layers") return look.sprite_type === "static" && look.body ? `Looks like ${look.body}` : "Dressed by hand";
  const npc = lists.npcs.find((n) => n.id === look.npcId);
  return npc ? `Looks like ${npc.name}` : "Looks like an NPC";
}

/** The largest number after a prefix among ids, plus one: ids stay unique through undo, copy and paste. */
export function nextId(prefix: string, ids: Iterable<string>): string {
  let top = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > top) top = n;
  }
  return `${prefix}${top + 1}`;
}

/** Every item's id in the document. */
export function* itemIds(doc: CutsceneDoc): Iterable<string> {
  for (const track of doc.tracks) for (const item of track.items as Item[]) yield item.id;
}
