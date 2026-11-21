import { ambienceSlider, effectsSlider, musicSlider, mutedCheckbox, weatherSlider } from "./ui.js";
import { fadePoints, musicLevel, ZONE_MUSIC_FADE, zoneMusicAction } from "./zonelogic.js";

let audio: AudioContext | null = null;
function unlock() {
  if (!audio) {
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    try { audio = new Ctor(); } catch { return; }
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
}
unlock();
// the events that count as a user's gesture (touchstart and pointerdown of a touch do not, touchend does)
for (const type of ["pointerdown", "pointerup", "mousedown", "click", "keydown", "touchend"]) window.addEventListener(type, unlock, { capture: true, passive: true });

let masterBus: GainNode | null = null, worldBus: GainNode | null = null;
function master(ctx: AudioContext): GainNode {
  if (!masterBus) {
    masterBus = ctx.createGain();
    masterBus.connect(ctx.destination);
  }
  return masterBus;
}
function world(ctx: AudioContext): GainNode {
  if (!worldBus) {
    worldBus = ctx.createGain();
    worldBus.connect(master(ctx));
  }
  return worldBus;
}

/** The level of the world's own sounds, 0..1, glided to so it is not a jump. */
export function setWorldVolume(level: number): void {
  if (audio) world(audio).gain.setTargetAtTime(Math.min(1, Math.max(0, level)), audio.currentTime, 0.15);
}

/** All the game's sound, as a stream to record; null when there is no audio. `close` ends the tap. */
export function tapSound(): { stream: MediaStream; close: () => void } | null {
  if (!audio) return null;
  const tap = audio.createMediaStreamDestination(), bus = master(audio);
  bus.connect(tap);
  return { stream: tap.stream, close: () => bus.disconnect(tap) };
}

let settingsApplied = false;
/** The player's saved audio settings are on the sliders and the mute switch: they set the volumes from now on. */
export function audioSettingsApplied(): void { settingsApplied = true; }

/** A slider (0-100) as a gain, 0..1: nothing when muted; squared, so the lower half of the slider is not all "loud". */
function sliderVolume(slider: HTMLInputElement | null | undefined): number {
  if (!settingsApplied || mutedCheckbox?.checked) return 0;
  const v = Math.min(100, Math.max(0, Number(slider?.value) || 0)) / 100;
  return v * v;
}
/** The Effects slider as a gain, 0..1. */
export function effectsVolume(): number { return sliderVolume(effectsSlider); }
/** The Ambience slider as a gain, 0..1 (the track of the sound NPCs: npcsounds.ts). */
export function ambienceVolume(): number { return sliderVolume(ambienceSlider); }
export function weatherVolume(): number { return sliderVolume(weatherSlider); }

const PEAK = 0.7, BOOST_MAX = 80;
const SILENT = 0.002;
interface Sound { buffer: AudioBuffer; boost: number; loudness: number; loopStart: number; loopEnd: number; looped?: AudioBuffer }
function measured(buffer: AudioBuffer): Sound {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
  let first = buffer.length, last = -1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < first; i++) if (Math.abs(d[i]) > peak * SILENT) { first = i; break; }
    for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > peak * SILENT) { last = i; break; }
  }
  const whole = last <= first;
  let sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) sum += d[i] * d[i]; }
  const rms = Math.sqrt(sum / Math.max(1, buffer.length * buffer.numberOfChannels));
  return {
    buffer, boost: peak > 0 ? Math.min(BOOST_MAX, PEAK / peak) : 1, loudness: peak > 0 ? rms / peak : 0,
    loopStart: whole ? 0 : first / buffer.sampleRate, loopEnd: whole ? buffer.duration : (last + 1) / buffer.sampleRate,
  };
}

const LOOP_CROSS = 1;
function loopedBuffer(ctx: BaseAudioContext, sound: Sound): AudioBuffer {
  if (sound.looped) return sound.looped;
  const { buffer } = sound, rate = buffer.sampleRate;
  const first = Math.round(sound.loopStart * rate), length = Math.max(1, Math.round(sound.loopEnd * rate) - first);
  const cross = Math.min(Math.round(LOOP_CROSS * rate), Math.floor(length / 4));
  const kept = length - cross;
  if (cross < 2 || kept < 2) return (sound.looped = buffer);
  const looped = ctx.createBuffer(buffer.numberOfChannels, kept, rate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const from = buffer.getChannelData(c), to = looped.getChannelData(c);
    to.set(from.subarray(first, first + kept));
    for (let i = 0; i < cross; i++) {
      const t = (i / cross) * (Math.PI / 2);
      to[i] = from[first + i] * Math.sin(t) + from[first + kept + i] * Math.cos(t);
    }
  }
  return (sound.looped = looped);
}

/** Starts `sound` looping without a seam (loopedBuffer), from a random point of it, at `rate`, into `into`. */
function startLoop(ctx: AudioContext, sound: Sound, rate: number, ...into: AudioNode[]): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = loopedBuffer(ctx, sound);
  source.loop = true;
  source.playbackRate.value = rate;
  for (const node of into) source.connect(node);
  source.start(0, Math.random() * source.buffer.duration);
  return source;
}

/** name (lower case) -> the decoded sound, null when the server has none (asked once only), or its load in progress */
const sounds = new Map<string, Sound | null | Promise<Sound | null>>();

export function loadEffect(name: string): Promise<Sound | null> {
  const key = name.trim().toLowerCase(), ctx = audio, server = (window as any).__assetServerUrl;
  if (!key || !ctx || !server) return Promise.resolve(null);
  const hit = sounds.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const load = fetch(`${server}/audio?name=${encodeURIComponent(key)}`)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`audio "${name}": ${res.status}`))))
    .then((bytes) => ctx.decodeAudioData(bytes))
    .then(measured)
    .catch((err) => { console.warn(`[audio] ${err?.message ?? err}`); return null; })
    .then((sound) => { sounds.set(key, sound); return sound; });
  sounds.set(key, load);
  return load;
}

/** How long a loaded sound's file plays, in seconds; null when it is not loaded (yet). */
export function soundLength(name: string): number | null {
  const sound = sounds.get(name.trim().toLowerCase());
  return sound && !(sound instanceof Promise) ? sound.buffer.duration : null;
}

export function playEffect(name: string, opts: { volume?: number; rate?: number; track?: "effects" | "weather" } = {}): boolean {
  const ctx = audio, gain = (opts.track === "weather" ? weatherVolume() : effectsVolume()) * Math.min(1, Math.max(0, opts.volume ?? 1));
  if (!ctx || ctx.state !== "running" || gain <= 0) return false;
  const sound = sounds.get(name.trim().toLowerCase());
  if (sound === undefined) { void loadEffect(name); return false; }
  if (!sound || sound instanceof Promise) return false;
  const source = ctx.createBufferSource(), level = ctx.createGain();
  source.buffer = sound.buffer;
  source.playbackRate.value = opts.rate ?? 1;
  level.gain.value = gain * sound.boost;
  source.connect(level).connect(world(ctx));
  source.start();
  return true;
}

/** A sound a cutscene plays: faded by asking for a new level each frame, stopped when the scene is done with it. */
export interface ClipHandle { setLevel(level: number): void; stop(): void }
/** A recording takes a scene's sounds at their full level, whatever the player's sliders are set to. */
let clipsAtFullLevel = false;
export function setClipsAtFullLevel(full: boolean): void { clipsAtFullLevel = full; }

export function playClip(name: string, opts: { bus: "music" | "effects"; level: number; rate: number; loop: boolean; offset: number }): ClipHandle | null {
  const ctx = audio, sound = sounds.get(name.trim().toLowerCase());
  if (!ctx || ctx.state !== "running" || !sound || sound instanceof Promise) return null;
  const slider = () => (clipsAtFullLevel ? 1 : sliderVolume(opts.bus === "music" ? musicSlider : effectsSlider));
  const source = ctx.createBufferSource(), level = ctx.createGain();
  source.buffer = opts.loop ? loopedBuffer(ctx, sound) : sound.buffer;
  source.loop = opts.loop;
  source.playbackRate.value = opts.rate;
  level.gain.value = opts.level * slider() * sound.boost;
  source.connect(level).connect(master(ctx));
  source.start(0, opts.offset);
  return {
    setLevel: (next) => level.gain.setTargetAtTime(next * slider() * sound.boost, ctx.currentTime, 0.02),
    stop: () => {
      level.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      source.stop(ctx.currentTime + 0.1);
    },
  };
}

export const AMBIENCE_FADE = 1.5, AMBIENCE_STOP = 6;
const AMBIENCE_FADE_OUT = 0.5, SILENT_LEVEL = 0.001;
const EVEN_RMS = 0.115, EVEN_MAX = 1.4, RATE_GLIDE = 0.4;
interface Loop { source: AudioBufferSourceNode | null; gain: GainNode; target: number; silentSince: number; rate: number }
const loops = new Map<string, Loop>();

export function setWeatherSound(name: string, level: number, opts: { even?: boolean; rate?: number; glide?: number; key?: string } = {}): void {
  const ctx = audio;
  if (!ctx) return;
  const soundKey = name.trim().toLowerCase(), key = (opts.key ?? name).trim().toLowerCase();
  const want = level > SILENT_LEVEL ? Math.min(1, level) * weatherVolume() : 0;
  // (not allowed to sound yet: fetched and decoded meanwhile, so it starts the moment the browser allows it)
  if (ctx.state !== "running") { if (want > 0 && !sounds.has(soundKey)) void loadEffect(name); return; }
  let loop = loops.get(key);
  if (!loop) {
    if (want <= 0) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(world(ctx));
    loops.set(key, loop = { source: null, gain, target: 0, silentSince: ctx.currentTime, rate: 1 });
  }
  const sound = sounds.get(soundKey);
  if (sound === undefined) { void loadEffect(name); return; }
  if (!sound || sound instanceof Promise) return;
  const even = opts.even && sound.loudness > 0 ? Math.min(EVEN_MAX, EVEN_RMS / (sound.loudness * PEAK)) : 1;
  const target = want * sound.boost * even, now = ctx.currentTime, rate = Math.min(4, Math.max(0.25, opts.rate ?? 1));
  if (!loop.source && target > 0) { loop.source = startLoop(ctx, sound, rate, loop.gain); loop.rate = rate; }
  if (loop.source && Math.abs(rate - loop.rate) > 0.005) {
    loop.source.playbackRate.setTargetAtTime(rate, now, RATE_GLIDE);
    loop.rate = rate;
  }
  if (Math.abs(target - loop.target) > 0.001 * Math.max(1, sound.boost)) {
    const g = loop.gain.gain;
    // hold where the glide is now, then glide from there (a plain cancel would jump back to the last set value)
    if (typeof (g as any).cancelAndHoldAtTime === "function") (g as any).cancelAndHoldAtTime(now);
    else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
    g.setTargetAtTime(target, now, target <= 0 ? AMBIENCE_FADE_OUT : opts.glide ?? AMBIENCE_FADE);
    if (target <= 0 && loop.target > 0) loop.silentSince = now;
    loop.target = target;
  }
  if (loop.source && loop.target <= 0 && now - loop.silentSince > AMBIENCE_STOP * AMBIENCE_FADE_OUT) {
    loop.source.stop();
    loop.source.disconnect();
    loop.source = null;
  }
}

const SPOT_FADE = 0.25, SPOT_MOVE = 0.05;
function hrtfLift(at: { x: number; y: number; z: number }): number {
  const overhead = Math.abs(at.y) / (Math.hypot(at.x, at.y, at.z) || 1);
  return 10 ** ((5.5 + 3 * overhead) / 20);
}
interface Spot {
  name: string; source: AudioBufferSourceNode | null; gain: GainNode; panner: PannerNode;
  /** the two ways to the ears: as recorded (both alike), and through the panner */
  direct: GainNode; panned: GainNode;
  target: number; silentSince: number;
}
const spots = new Map<string, Spot>();

function dropSpot(key: string, spot: Spot): void {
  if (spot.source) { spot.source.stop(); spot.source.disconnect(); }
  spot.panner.disconnect();
  spot.direct.disconnect();
  spot.panned.disconnect();
  spot.gain.disconnect();
  spots.delete(key);
}

/** Glides a placed sound to `target`, and stops it once it has been silent long enough. */
function glideSpot(ctx: AudioContext, key: string, spot: Spot, target: number, boost: number): void {
  const now = ctx.currentTime;
  if (Math.abs(target - spot.target) > 0.001 * Math.max(1, boost)) {
    const g = spot.gain.gain;
    if (typeof (g as any).cancelAndHoldAtTime === "function") (g as any).cancelAndHoldAtTime(now);
    else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
    g.setTargetAtTime(target, now, SPOT_FADE);
    if (target <= 0 && spot.target > 0) spot.silentSince = now;
    spot.target = target;
  }
  if (spot.target <= 0 && now - spot.silentSince > AMBIENCE_STOP * SPOT_FADE) dropSpot(key, spot);
}

export function setSoundAt(key: string, name: string, level: number, at: { x: number; y: number; z: number }, spread = 1): void {
  const ctx = audio;
  if (!ctx) return;
  const soundKey = name.trim().toLowerCase(), want = Math.min(1, Math.max(0, level)) * ambienceVolume();
  if (ctx.state !== "running") { if (want > 0 && !sounds.has(soundKey)) void loadEffect(name); return; }
  let spot = spots.get(key);
  // (it plays another file now: the old one stops at once, the new one fades in)
  if (spot && spot.name !== soundKey) { dropSpot(key, spot); spot = undefined; }
  if (!spot) {
    if (want <= 0) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.rolloffFactor = 0;
    const direct = ctx.createGain(), panned = ctx.createGain();
    panned.gain.value = 0;
    gain.connect(world(ctx));
    direct.connect(gain);
    panner.connect(panned).connect(gain);
    spots.set(key, spot = { name: soundKey, source: null, gain, panner, direct, panned, target: 0, silentSince: ctx.currentTime });
  }
  const now = ctx.currentTime, p = spot.panner;
  if (p.positionX) {
    p.positionX.setTargetAtTime(at.x, now, SPOT_MOVE);
    p.positionY.setTargetAtTime(at.y, now, SPOT_MOVE);
    p.positionZ.setTargetAtTime(at.z, now, SPOT_MOVE);
  } else (p as any).setPosition(at.x, at.y, at.z);
  const share = Math.min(1, Math.max(0, spread)) * Math.PI / 2;
  spot.direct.gain.setTargetAtTime(Math.cos(share), now, SPOT_MOVE);
  spot.panned.gain.setTargetAtTime(Math.sin(share) * hrtfLift(at), now, SPOT_MOVE);
  const sound = sounds.get(soundKey);
  if (sound === undefined) { void loadEffect(name); return; }
  if (!sound || sound instanceof Promise) return;
  const target = want * sound.boost;
  if (!spot.source && target > 0) spot.source = startLoop(ctx, sound, 1, spot.direct, spot.panner);
  glideSpot(ctx, key, spot, target, sound.boost);
}

export function fadeSoundsExcept(keys: Set<string>): void {
  const ctx = audio;
  if (!ctx) return;
  for (const [key, spot] of [...spots]) if (!keys.has(key)) glideSpot(ctx, key, spot, 0, 1);
}

const ZONE_MUSIC_GLIDE = 0.15;
interface ZoneTrack { name: string; source: AudioBufferSourceNode; level: GainNode; boost: number; fadeUntil: number }
let zoneWanted: string | null = null, zoneTrack: ZoneTrack | null = null;
const zoneFading: ZoneTrack[] = [];
let zoneCutscene = false, zoneTarget = -1;

function zoneMusicLevel(): number {
  return musicLevel(Number(musicSlider?.value), !settingsApplied || !!mutedCheckbox?.checked, zoneCutscene);
}

function holdGain(g: AudioParam, now: number): void {
  if (typeof (g as any).cancelAndHoldAtTime === "function") (g as any).cancelAndHoldAtTime(now);
  else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
}

/** Ramps a gain from the level it has now to `to` along fadePoints. */
function fadeGain(g: AudioParam, to: number, now: number, seconds: number): void {
  holdGain(g, now);
  const from = g.value;
  for (const [at, level] of fadePoints(from, to, seconds)) g.linearRampToValueAtTime(level, now + at);
}

/** Fades a track out to silence over ZONE_MUSIC_FADE seconds, then stops it. */
function fadeOutZoneTrack(ctx: AudioContext, track: ZoneTrack): void {
  const now = ctx.currentTime;
  fadeGain(track.level.gain, 0, now, ZONE_MUSIC_FADE);
  track.fadeUntil = now + ZONE_MUSIC_FADE;
  try { track.source.stop(now + ZONE_MUSIC_FADE + 0.05); } catch { /* already stopped */ }
  track.source.onended = () => {
    track.source.disconnect();
    track.level.disconnect();
    const at = zoneFading.indexOf(track);
    if (at >= 0) zoneFading.splice(at, 1);
  };
  zoneFading.push(track);
}

function startZoneTrack(): void {
  const ctx = audio, name = zoneWanted;
  if (!ctx || !name || zoneTrack || ctx.state !== "running") return;
  const sound = sounds.get(name);
  if (sound === undefined) { void loadEffect(name); return; }
  if (!sound || sound instanceof Promise) return;
  const source = ctx.createBufferSource(), level = ctx.createGain(), now = ctx.currentTime;
  source.buffer = sound.buffer;
  source.loop = true;
  zoneTarget = zoneMusicLevel();
  level.gain.setValueAtTime(0, now);
  for (const [at, value] of fadePoints(0, zoneTarget * sound.boost, ZONE_MUSIC_FADE)) level.gain.linearRampToValueAtTime(value, now + at);
  source.connect(level).connect(master(ctx));
  source.start(0, 0);
  zoneTrack = { name, source, level, boost: sound.boost, fadeUntil: now + ZONE_MUSIC_FADE };
}

/** Which zone music should play: a file name, or null for none. Asked every look; only a change does anything. */
export function setZoneMusic(name: string | null): void {
  const key = name?.trim().toLowerCase() || null;
  if (key === zoneWanted) { startZoneTrack(); return; }
  zoneWanted = key;
  const ctx = audio;
  const action = zoneMusicAction(key, zoneTrack?.name ?? null, zoneFading.map((track) => track.name));
  if (ctx && action !== "keep") {
    if (zoneTrack) { fadeOutZoneTrack(ctx, zoneTrack); zoneTrack = null; }
    const back = action === "revive" ? zoneFading.find((track) => track.name === key) : undefined;
    if (back) { reviveZoneTrack(ctx, back); return; }
  }
  startZoneTrack();
}

/** Brings back a track still fading out (walking back over a zone's edge): it fades up from where it is, not anew. */
function reviveZoneTrack(ctx: AudioContext, track: ZoneTrack): void {
  const now = ctx.currentTime;
  zoneFading.splice(zoneFading.indexOf(track), 1);
  track.source.onended = null;
  // a later stop() replaces the one the fade set, while the source has not stopped yet
  try { track.source.stop(now + 1e7); } catch { /* stopped already */ }
  zoneTarget = zoneMusicLevel();
  fadeGain(track.level.gain, zoneTarget * track.boost, now, ZONE_MUSIC_FADE);
  track.fadeUntil = now + ZONE_MUSIC_FADE;
  zoneTrack = track;
}

export function updateZoneMusic(cutscene: boolean): void {
  zoneCutscene = cutscene;
  const ctx = audio;
  if (!ctx) return;
  if (!zoneTrack) { startZoneTrack(); return; }
  const target = zoneMusicLevel();
  if (Math.abs(target - zoneTarget) < 0.001) return;
  const now = ctx.currentTime, g = zoneTrack.level.gain, level = target * zoneTrack.boost;
  if (target >= 0.001 && (zoneTarget < 0.001 || now < zoneTrack.fadeUntil)) {
    const seconds = zoneTarget < 0.001 ? ZONE_MUSIC_FADE : Math.max(ZONE_MUSIC_GLIDE, zoneTrack.fadeUntil - now);
    fadeGain(g, level, now, seconds);
    zoneTrack.fadeUntil = now + seconds;
  } else {
    holdGain(g, now);
    g.setTargetAtTime(level, now, ZONE_MUSIC_GLIDE);
    zoneTrack.fadeUntil = 0;
  }
  zoneTarget = target;
}
