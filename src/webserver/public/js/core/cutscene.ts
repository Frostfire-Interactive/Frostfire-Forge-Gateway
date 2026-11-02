// Plays a scene in the game window, the same way for a player and for the editor's preview. A frame of it is worked out
// from the time alone (cutscenedoc.ts), and applied to the game: the camera (renderer.ts asks cutsceneCamera), the zoom
// (worldzoom.ts), actors, which are local NPC objects with ids of their own and so are drawn, animated and depth-sorted
// like any other (npc.ts), and the weather, the hour and the sound.
//
// "live" is a scene the server sent: it holds the player (the server does too, this only stops the client trying) and
// tells the server when it has begun and ended. "preview" is the editor's: it talks to nobody, and no other player sees
// anything of it. There is one scene at a time.

import Cache from "./cache.js";
import { cachedPlayerId, getIsLoaded, sendRequest } from "./socket.js";
import { createNPC, deleteNPC } from "./npc.js";
import { changeLayeredAnimation } from "./layeredAnimation.js";
import { getWeatherData, getWeatherType, setWeatherData, setWeatherType } from "./renderer.js";
import { getHasWeather, setDarknessAmbience, setHasWeather, setScriptedHour, setStormAmbience } from "./ambience.js";
import { loadEffect, playClip, setWorldVolume, soundLength, type ClipHandle } from "./audio.js";
import { setCinematicZoom } from "./worldzoom.js";
import { drawOverlay } from "./cutsceneoverlay.js";
import { setCutsceneHold } from "./cutscenehold.js";
import { clipLength, envelope, hourAt, makePlan, poseAt, shakeAt, shotAt, weatherAt, type Actor, type CutsceneDoc, type Plan, type Point, type Shot } from "./cutscenedoc.js";

const cache = Cache.getInstance();

/** How long a scene waits for its sprites and sounds before starting without what has not come. */
const PREPARE_LIMIT_MS = 5000;
/** The world is left this long at the first shot before the clock starts, for its chunks to arrive under the fade. */
const PREROLL_MS = 400;
/** A live scene offers its skip button this long after it starts, so a scene started by accident can go. */
const SKIP_AFTER_MS = 1000;
/** A clock this far from where the sounds are playing has been moved: they start again from the new place. */
const SOUND_DRIFT = 0.25;

type SceneEvent = "started" | "ended" | "stopped" | "frame";

interface Run {
  doc: CutsceneDoc;
  plan: Plan;
  mode: "live" | "preview";
  token: string | null;
  t: number;
  playing: boolean;
  /** The scene's clock has been running and the world is set up. */
  ready: boolean;
  preparing: boolean;
  prepared: boolean;
  lastNow: number;
  holdUntil: number;
  skipAt: number;
  actors: Map<string, { npc: any; key: string }>;
  props: Map<string, any>;
  clips: Map<string, ClipHandle>;
  soundT: number;
  /** Which weather clip is showing, and what to put back afterwards. */
  weatherClip: string | null;
  base: { weather: string | null; data: any; has: boolean } | null;
  heldWeather: any;
  shot: Shot | null;
}

let run: Run | null = null;
/** The director's own camera (cutsceneeditor.ts): takes over from the scene's while it is set. */
let freeCamera: Shot | null = null;
/** What the director draws over the scene, on the same canvas. */
let guides: ((ctx: CanvasRenderingContext2D) => void) | null = null;
let layerUsed = false;
const listeners = new Set<(event: SceneEvent) => void>();

const layer = document.getElementById("cutscene-layer") as HTMLCanvasElement | null;
const layerCtx = layer ? layer.getContext("2d") : null;
const skipButton = document.getElementById("cutscene-skip") as HTMLButtonElement | null;

const emit = (event: SceneEvent) => { for (const listener of listeners) listener(event); };

/** Told when a scene starts, ends, is stopped, and on every frame of it. Returns how to stop being told. */
export function onScene(listener: (event: SceneEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function selfPlayer(): any {
  return Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
}

const sameMap = (a: string, b: string) => a.replace(/\.json$/i, "").toLowerCase() === b.replace(/\.json$/i, "").toLowerCase();
const onSceneMap = (doc: CutsceneDoc) => sameMap(String(window.mapData?.name ?? ""), doc.map);

function setWorldWeather(weather: string | null, data: any, has: boolean): void {
  setHasWeather(has);
  setWeatherType(weather);
  setStormAmbience(weather === "thunderstorm", data?.ambience);
  setDarknessAmbience(weather === "darkness", data?.ambience);
  setWeatherData(data ?? null);
}

/** The viewer's own sprites, as an actor wears them. */
function viewerSprites(): { sprite_type: string; spriteLayers: any } {
  const sprites = selfPlayer()?.spriteData;
  if (!sprites) return { sprite_type: "none", spriteLayers: null };
  return {
    sprite_type: "animated",
    spriteLayers: {
      mount: sprites.mountSprite, body: sprites.bodySprite, head: sprites.headSprite, helmet: sprites.armorHelmetSprite,
      shoulderguards: sprites.armorShoulderguardsSprite, neck: sprites.armorNeckSprite, hands: sprites.armorHandsSprite,
      chest: sprites.armorChestSprite, feet: sprites.armorFeetSprite, legs: sprites.armorLegsSprite, weapon: sprites.armorWeaponSprite,
    },
  };
}

function spritesOf(actor: Actor): { sprite_type: string; spriteLayers: any } {
  if (actor.look.kind === "viewer") return viewerSprites();
  return { sprite_type: actor.sprite_type || "none", spriteLayers: actor.spriteLayers ?? null };
}

function localNpc(id: string, x: number, y: number, fields: Record<string, unknown>): any {
  return createNPC({
    id, location: { x, y, direction: "down" }, dialog: "", gossip: null, hidden: false, particles: [], script: null, map: "",
    position: { x, y }, last_updated: null, sprite_type: "none", spriteLayers: null, name: null, ...fields,
  });
}

function makeActor(r: Run, actor: Actor): void {
  const look = spritesOf(actor);
  const npc = localNpc(`cs-${actor.id}`, actor.x, actor.y, { ...look, name: actor.showName ? actor.name : null, hidden: !actor.visible });
  npc.direction = actor.direction;
  // an actor is there at once, not faded in as an NPC walking into view is
  npc.shownAt = 1;
  r.actors.set(actor.id, { npc, key: JSON.stringify([actor.look, look.sprite_type, !!look.spriteLayers, actor.name, actor.showName]) });
}

/** Brings the actors in line with the document: the editor changes it while a preview is up. */
function matchActors(r: Run): Promise<unknown>[] {
  const wanted = new Set(r.doc.actors.map((a) => a.id));
  for (const [id, held] of r.actors) {
    if (wanted.has(id)) continue;
    deleteNPC(held.npc);
    r.actors.delete(id);
  }
  const loading: Promise<unknown>[] = [];
  for (const actor of r.doc.actors) {
    const held = r.actors.get(actor.id);
    const look = spritesOf(actor);
    if (held && held.key === JSON.stringify([actor.look, look.sprite_type, !!look.spriteLayers, actor.name, actor.showName])) continue;
    if (held) deleteNPC(held.npc);
    makeActor(r, actor);
    loading.push(r.actors.get(actor.id)!.npc.spriteReady);
  }
  return loading;
}

async function prepare(r: Run): Promise<void> {
  const loading = [...matchActors(r), ...r.plan.audio.map((clip) => loadEffect(clip.sound))];
  await Promise.race([Promise.all(loading), new Promise((done) => setTimeout(done, PREPARE_LIMIT_MS))]);
  r.prepared = true;
}

function begin(r: Run, now: number): void {
  r.ready = true;
  r.lastNow = now;
  r.holdUntil = r.mode === "live" ? now + PREROLL_MS : 0;
  r.skipAt = now + SKIP_AFTER_MS;
  r.base = { weather: getWeatherType(), data: getWeatherData(), has: getHasWeather() };
  setWorldVolume(r.playing ? r.doc.settings.worldVolume : 1);
  document.body.classList.toggle("cutscene-no-hud", r.doc.settings.hideHud);
  if (r.mode === "live") sendRequest({ type: "CUTSCENE_STARTED", data: { token: r.token } });
  emit("started");
}

function stopSounds(r: Run): void {
  for (const clip of r.clips.values()) clip.stop();
  r.clips.clear();
}

function unload(r: Run): void {
  for (const { npc } of r.actors.values()) deleteNPC(npc);
  for (const prop of r.props.values()) deleteNPC(prop);
  r.actors.clear();
  r.props.clear();
  stopSounds(r);
  if (r.ready) {
    setWorldVolume(1);
    setScriptedHour(null);
    if (r.heldWeather) setWorldWeather(r.heldWeather.weather, r.heldWeather.weatherData, true);
    else if (r.weatherClip && r.base) setWorldWeather(r.base.weather, r.base.data, r.base.has);
  }
  setCinematicZoom(freeCamera ? freeCamera.zoom : null);
  document.body.classList.remove("cutscene-no-hud");
  if (skipButton) skipButton.hidden = true;
  run = null;
}

function applyActors(r: Run): void {
  for (const actor of r.doc.actors) {
    const npc = r.actors.get(actor.id)?.npc;
    if (!npc) continue;
    // (a map load or the NPC list clears the NPCs the client holds)
    if (!cache.npcs.includes(npc)) cache.npcs.push(npc);
    const pose = poseAt(r.plan, actor, r.t);
    npc.position.x = pose.x;
    npc.position.y = pose.y;
    npc.hidden = !pose.visible;
    npc.dialog = pose.say;
    if (npc.layeredAnimation) void changeLayeredAnimation(npc.layeredAnimation, pose.animation);
  }
}

function applyProps(r: Run): void {
  const live = new Set<string>();
  for (const clip of r.plan.world.particles) {
    if (r.t < clip.t || r.t >= clip.t + clip.d || !clip.particleData) continue;
    live.add(clip.id);
    let prop = r.props.get(clip.id);
    // (the editor can change which particles a clip shows while a preview is up)
    if (prop && prop.particleName !== clip.particle) {
      deleteNPC(prop);
      prop = undefined;
    }
    if (!prop) {
      prop = localNpc(`cs-p-${clip.id}`, clip.x, clip.y, { hidden: true, particles: [{ ...clip.particleData, visible: true }] });
      prop.particleName = clip.particle;
      r.props.set(clip.id, prop);
    }
    prop.position.x = clip.x;
    prop.position.y = clip.y;
    if (!cache.npcs.includes(prop)) cache.npcs.push(prop);
  }
  for (const [id, prop] of r.props) {
    if (live.has(id)) continue;
    deleteNPC(prop);
    r.props.delete(id);
  }
}

function applyWorld(r: Run): void {
  const weather = weatherAt(r.plan, r.t);
  // (keyed by what it shows: an edit, or its values arriving from the server, changes that with no new clip)
  const key = weather ? `${weather.id} ${weather.weather} ${weather.weatherData === undefined ? 0 : 1}` : null;
  if (key !== r.weatherClip) {
    r.weatherClip = key;
    if (weather) setWorldWeather(weather.weather, weather.weatherData, true);
    else if (r.base) setWorldWeather(r.base.weather, r.base.data, r.base.has);
  }
  setScriptedHour(hourAt(r.plan, r.t));
}

/**
 * Every sound of the scene is asked each frame whether it should be sounding now, and started, faded or stopped to
 * match. So a scene entered at any time, a jump, and a sound the browser would not let start until now all come out right.
 */
function applySound(r: Run): void {
  if (Math.abs(r.t - r.soundT) > SOUND_DRIFT) stopSounds(r);
  r.soundT = r.t;
  for (const clip of r.plan.audio) {
    const length = clipLength(clip, soundLength(clip.sound));
    const held = r.clips.get(clip.id);
    if (!r.playing || r.t < clip.t || r.t >= clip.t + length) {
      if (held) { held.stop(); r.clips.delete(clip.id); }
      continue;
    }
    const level = clip.volume * envelope(r.t, clip.t, length, clip.in, clip.out);
    if (held) { held.setLevel(level); continue; }
    const started = playClip(clip.sound, { bus: clip.bus, level, rate: clip.rate, loop: clip.loop, offset: (r.t - clip.t) * clip.rate });
    if (started) r.clips.set(clip.id, started);
  }
}

function whereIs(r: Run, who: string): Point | null {
  if (who === "viewer") {
    const self = selfPlayer();
    return self?.renderPosition ?? self?.position ?? null;
  }
  const actor = r.doc.actors.find((a) => a.id === who);
  return actor ? poseAt(r.plan, actor, r.t) : null;
}

function applyCamera(r: Run): void {
  const shot = shotAt(r.plan, r.t, (who) => whereIs(r, who));
  if (shot) {
    const shake = shakeAt(r.plan, r.t);
    shot.x += shake.x;
    shot.y += shake.y;
  }
  r.shot = shot;
  if (!freeCamera) setCinematicZoom(shot ? shot.zoom : null);
}

function applyFrame(r: Run): void {
  applyActors(r);
  applyProps(r);
  applyWorld(r);
  applySound(r);
  applyCamera(r);
}

/** The last live scene this client finished, as it told the server. */
let lastEnd: { token: string | null; skipped: boolean } | null = null;

function finishLive(r: Run, skipped: boolean): void {
  const token = r.token;
  unload(r);
  lastEnd = { token, skipped };
  sendRequest({ type: "CUTSCENE_END", data: lastEnd });
  emit("ended");
}

/**
 * HANDOFF_DONE: nothing sent while the client changed server node arrived, so where its scene stands is said again.
 * The new node ignores what it has already heard.
 */
export function repeatCutsceneState(): void {
  if (run?.mode === "live" && run.ready) sendRequest({ type: "CUTSCENE_STARTED", data: { token: run.token } });
  else if (lastEnd) sendRequest({ type: "CUTSCENE_END", data: lastEnd });
  lastEnd = null;
}

/** Called once a frame, before the camera is worked out (renderer.ts). */
export function tickCutscene(now: number): void {
  const r = run;
  if (!r) return;
  if (!r.ready) {
    // (a scene can come before its map has: a login's, or one following on from another map)
    if (!getIsLoaded() || !window.mapData || (r.mode === "live" && !onSceneMap(r.doc))) return;
    if (!r.preparing) {
      r.preparing = true;
      void prepare(r);
    }
    if (!r.prepared) return;
    begin(r, now);
  }
  if (r.mode === "live" && !onSceneMap(r.doc)) {
    finishLive(r, false);
    return;
  }
  if (r.playing && now >= r.holdUntil) r.t += (now - r.lastNow) / 1000;
  r.lastNow = now;
  if (r.t >= r.doc.duration) {
    r.t = r.doc.duration;
    if (r.mode === "live") {
      finishLive(r, false);
      return;
    }
    r.playing = false;
    applyFrame(r);
    emit("ended");
    return;
  }
  applyFrame(r);
  if (skipButton) skipButton.hidden = !(r.mode === "live" && r.doc.settings.skippable && now >= r.skipAt);
  emit("frame");
}

/** Clears and draws the scene's canvas, once a frame, after the world. */
export function drawCutsceneLayer(): void {
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  if (!layer || !layerCtx || !canvas) return;
  if (!run && !guides && !layerUsed) return;
  if (layer.width !== canvas.width || layer.height !== canvas.height) {
    layer.width = canvas.width;
    layer.height = canvas.height;
  }
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, layer.width, layer.height);
  drawOverlayInto(layerCtx, layer.width, layer.height);
  if (guides) guides(layerCtx);
  layerUsed = !!run || !!guides;
}

/**
 * The overlay of the scene that is up, on the game or in the recorder's frame. Free view is for placing things, so the
 * scene does not cover the world there: a fade at the playhead would leave it black. So is a preview stopped at its
 * very start: that shows the first shot, not the black it will fade in from.
 */
export function drawOverlayInto(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (!run?.ready || freeCamera) return;
  drawOverlay(ctx, run.doc, run.plan, run.t, w, h, run.mode === "preview" && !run.playing && run.t === 0);
}

function newRun(doc: CutsceneDoc, mode: "live" | "preview", token: string | null): Run {
  return {
    doc, plan: makePlan(doc), mode, token, t: 0, playing: mode === "live", ready: false, preparing: false, prepared: false,
    lastNow: 0, holdUntil: 0, skipAt: 0, actors: new Map(), props: new Map(), clips: new Map(), soundT: 0,
    weatherClip: null, base: null, heldWeather: null, shot: null,
  };
}

/** CUTSCENE_PLAY: the server plays a scene to this player. */
export function startCutscene(data: { token: string; doc: CutsceneDoc }): void {
  if (!data?.doc) return;
  if (run) unload(run);
  run = newRun(data.doc, "live", data.token);
}

/** CUTSCENE_STOP: the server ended the scene. */
export function stopCutscene(data: { token?: string }): void {
  if (run?.mode !== "live" || (data?.token && data.token !== run.token)) return;
  unload(run);
  emit("stopped");
}

function skip(): void {
  if (!run || run.mode !== "live" || !run.ready || !run.doc.settings.skippable) return;
  finishLive(run, true);
}

skipButton?.addEventListener("click", skip);
window.addEventListener("keydown", (event) => {
  if (event.code !== "Escape" || run?.mode !== "live" || !run.doc.settings.skippable || !run.ready) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  skip();
}, { capture: true });

/** A scene is loaded, or on its way. */
export const cutsceneActive = () => !!run;
/** A scene the server sent holds the player. */
setCutsceneHold(() => run?.mode === "live" && run.doc.settings.lock);
/** The camera, while a scene or the director has it. */
export function cutsceneCamera(): Point | null {
  return freeCamera ?? run?.shot ?? null;
}
export function cutsceneHidesPlayer(self: boolean): boolean {
  if (!run?.ready) return false;
  const { hideSelf, hideOthers } = run.doc.settings;
  if (self) return hideSelf || run.doc.actors.some((a) => a.look.kind === "viewer");
  return hideOthers;
}
export const cutsceneHidesCreatures = () => !!run?.ready && run.doc.settings.hideCreatures;
export const cutsceneHidesHud = () => !!run?.ready && run.doc.settings.hideHud;

/**
 * The server's weather while a scene sets its own: kept for after the scene instead of being applied. True when it is
 * kept. A scene that sets no weather leaves the world's alone.
 */
export function holdWeather(data: any): boolean {
  if (!run?.plan.world.weather.length) return false;
  run.heldWeather = data;
  return true;
}

// The editor's preview (cutsceneeditor.ts).

/** Puts a scene up to preview at this time, or takes in a changed document for the one that is up, keeping its place. */
export function previewScene(doc: CutsceneDoc, at = 0): void {
  if (run?.mode === "live") return;
  if (!run) {
    run = newRun(doc, "preview", null);
    run.t = Math.min(at, doc.duration);
    return;
  }
  run.doc = doc;
  run.plan = makePlan(doc);
  run.t = Math.min(run.t, doc.duration);
  stopSounds(run);
  matchActors(run);
  document.body.classList.toggle("cutscene-no-hud", doc.settings.hideHud);
  setWorldVolume(run.playing ? doc.settings.worldVolume : 1);
}

export function previewSeek(t: number): void {
  if (run?.mode !== "preview") return;
  run.t = Math.max(0, Math.min(run.doc.duration, t));
  stopSounds(run);
}

export function previewPlay(): void {
  if (run?.mode !== "preview") return;
  if (run.t >= run.doc.duration) run.t = 0;
  run.playing = true;
  run.lastNow = performance.now();
  setWorldVolume(run.doc.settings.worldVolume);
}

export function previewPause(): void {
  if (run?.mode !== "preview") return;
  run.playing = false;
  stopSounds(run);
  setWorldVolume(1);
}

export function previewClose(): void {
  if (run?.mode === "preview") unload(run);
}

/** Where the scene that is up has got to. */
export function sceneClock(): { t: number; duration: number; playing: boolean; ready: boolean; mode: "live" | "preview"; name: string } | null {
  return run ? { t: run.t, duration: run.doc.duration, playing: run.playing, ready: run.ready, mode: run.mode, name: run.doc.name } : null;
}

/** The director's free camera, null to hand the view back to the scene. */
export function setFreeCamera(shot: Shot | null): void {
  freeCamera = shot;
  setCinematicZoom(shot ? shot.zoom : run?.shot?.zoom ?? null);
}

export function getSceneShot(): Shot | null {
  return run?.shot ?? null;
}

export function setGuides(draw: ((ctx: CanvasRenderingContext2D) => void) | null): void {
  guides = draw;
}
