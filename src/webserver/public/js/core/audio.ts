import { ambienceSlider, effectsSlider, mutedCheckbox } from "./ui.js";

/**
 * Sound effects. A sound is an audio file of the asset server (its assets/audio folder), asked for by name with or
 * without its extension ("footstep sand"), fetched and decoded once, then played from memory as often as needed.
 * How loud: the pause menu's Effects slider (0-100) and its Muted box, read at every play, so a change is heard at once.
 *
 * The files are decoded from their bytes (decodeAudioData), whatever their name says: the game's footstep ".wav" files
 * are AAC in an MP4 container (measured 2026-10-03: "ftypM4A"), which an <audio> element served as audio/wav may refuse.
 */

// A browser decides when a page may make sound (its autoplay policy), whatever the page: no page can switch that off.
// USER REQUEST 2026-10-14 ("bypass the user needing to interact with the game before audio plays"): so the audio
// context is made as soon as this module loads, not on the first key press, and asked to start at once. Where the
// browser allows it, sound starts with the game:
// - Chrome and Edge let a page play when the user clicked on an earlier page of the same site in that tab. The way in
//   is the realm selection page (a click on a realm, then /game on the same origin), so the click there counts.
// - They also let a site play that the user often hears sound from (Chrome's Media Engagement Index), and a desktop
//   wrapper (Electron) can drop the policy (autoplay-policy=no-user-gesture-required); the Claude desktop app's own
//   browser runs this context at once.
// - Firefox and Safari wait for a gesture on this page: the first click, tap or key press below starts it.
// Until then the context exists suspended, which is enough to fetch and decode the sounds, so nothing is late once it
// runs. (A suspended context made before a gesture logs a warning in Chrome's console; it is harmless.)
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

/** A slider (0-100) as a gain, 0..1: nothing when muted; squared, so the lower half of the slider is not all "loud". */
function sliderVolume(slider: HTMLInputElement | null | undefined): number {
  if (mutedCheckbox?.checked) return 0;
  const v = Math.min(100, Math.max(0, Number(slider?.value) || 0)) / 100;
  return v * v;
}
/** The Effects slider as a gain, 0..1. */
export function effectsVolume(): number { return sliderVolume(effectsSlider); }
/** The Ambience slider as a gain, 0..1 (the track of the looping sounds of the world around: the rain). */
export function ambienceVolume(): number { return sliderVolume(ambienceSlider); }

/**
 * Every sound is brought to the same loudness when it is loaded: its loudest sample to PEAK of full scale (measured
 * 2026-10-03: the footstep files peak at 0.017 - 0.053 of full scale, "footstep sand" at 0.017: played as recorded it
 * could not be heard). A file that is next to silent is raised by BOOST_MAX at most.
 */
const PEAK = 0.7, BOOST_MAX = 80;
/** A looped sound plays from its first to its last sample over SILENT of its peak: the files are AAC, whose encoder
 * pads the start and the end with silence, which would be heard as a gap at every turn of the loop. */
const SILENT = 0.002;
interface Sound { buffer: AudioBuffer; boost: number; loopStart: number; loopEnd: number }
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
  return {
    buffer, boost: peak > 0 ? Math.min(BOOST_MAX, PEAK / peak) : 1,
    loopStart: whole ? 0 : first / buffer.sampleRate, loopEnd: whole ? buffer.duration : (last + 1) / buffer.sampleRate,
  };
}

/** name (lower case) -> the decoded sound, null when the server has none (asked once only), or its load in progress */
const sounds = new Map<string, Sound | null | Promise<Sound | null>>();

/** Fetches and decodes a sound; null when it cannot be had or no sound may be made yet. */
export function loadEffect(name: string): Promise<Sound | null> {
  const key = name.trim().toLowerCase(), ctx = audio;
  if (!key || !ctx) return Promise.resolve(null);
  const hit = sounds.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const load = fetch(`${(window as any).__assetServerUrl || ""}/audio?name=${encodeURIComponent(key)}`)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`audio "${name}": ${res.status}`))))
    .then((bytes) => ctx.decodeAudioData(bytes))
    .then(measured)
    .catch((err) => { console.warn(`[audio] ${err?.message ?? err}`); return null; })
    .then((sound) => { sounds.set(key, sound); return sound; });
  sounds.set(key, load);
  return load;
}

/**
 * Plays a sound effect once. `volume` (0..1) is the sound's own level under the Effects slider, `rate` its speed and
 * pitch (1 = as recorded). A sound not loaded yet starts loading and is skipped this time (a footstep that comes late
 * is worse than one missing). Returns whether it played.
 */
export function playEffect(name: string, opts: { volume?: number; rate?: number } = {}): boolean {
  const ctx = audio, gain = effectsVolume() * Math.min(1, Math.max(0, opts.volume ?? 1));
  if (!ctx || ctx.state !== "running" || gain <= 0) return false;
  const sound = sounds.get(name.trim().toLowerCase());
  if (sound === undefined) { void loadEffect(name); return false; }
  if (!sound || sound instanceof Promise) return false;
  const source = ctx.createBufferSource(), level = ctx.createGain();
  source.buffer = sound.buffer;
  source.playbackRate.value = opts.rate ?? 1;
  level.gain.value = gain * sound.boost;
  source.connect(level).connect(ctx.destination);
  source.start();
  return true;
}

/**
 * USER REQUEST 2026-10-14 ("Hard Rain.wav" and "Soft Rain.wav" ... "Fade the sound in and out. It should be a new
 * 'ambience' sound track"): sounds that loop for as long as they are wanted, under the pause menu's Ambience slider.
 *
 * setAmbience(name, level) says how loud a looping sound should be now (0..1 of the slider); it is asked every frame.
 * A change is never a jump: the sound glides to it, AMBIENCE_FADE seconds being the time constant (most of the way in
 * about three of them), so rain that starts, stops or turns harder fades in, out or across. The slider and the Muted
 * box glide the same way. A loop starts at a random point of its file (two rains started together do not beat), and
 * is stopped once it has been all but silent for AMBIENCE_STOP time constants.
 */
export const AMBIENCE_FADE = 1.5, AMBIENCE_STOP = 6;
interface Loop { source: AudioBufferSourceNode | null; gain: GainNode; target: number; silentSince: number }
const loops = new Map<string, Loop>();

export function setAmbience(name: string, level: number): void {
  const ctx = audio;
  if (!ctx) return;
  const key = name.trim().toLowerCase(), want = Math.min(1, Math.max(0, level)) * ambienceVolume();
  // (not allowed to sound yet: fetched and decoded meanwhile, so it starts the moment the browser allows it)
  if (ctx.state !== "running") { if (want > 0 && !sounds.has(key)) void loadEffect(name); return; }
  let loop = loops.get(key);
  if (!loop) {
    if (want <= 0) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    loops.set(key, loop = { source: null, gain, target: 0, silentSince: ctx.currentTime });
  }
  const sound = sounds.get(key);
  if (sound === undefined) { void loadEffect(name); return; }
  if (!sound || sound instanceof Promise) return;
  const target = want * sound.boost, now = ctx.currentTime;
  if (!loop.source && target > 0) {
    const source = ctx.createBufferSource();
    source.buffer = sound.buffer;
    source.loop = true;
    source.loopStart = sound.loopStart;
    source.loopEnd = sound.loopEnd;
    source.connect(loop.gain);
    source.start(0, sound.loopStart + Math.random() * (sound.loopEnd - sound.loopStart));
    loop.source = source;
  }
  if (Math.abs(target - loop.target) > 0.001 * Math.max(1, sound.boost)) {
    const g = loop.gain.gain;
    // hold where the glide is now, then glide from there (a plain cancel would jump back to the last set value)
    if (typeof (g as any).cancelAndHoldAtTime === "function") (g as any).cancelAndHoldAtTime(now);
    else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
    g.setTargetAtTime(target, now, AMBIENCE_FADE);
    if (target <= 0 && loop.target > 0) loop.silentSince = now;
    loop.target = target;
  }
  if (loop.source && loop.target <= 0 && now - loop.silentSince > AMBIENCE_STOP * AMBIENCE_FADE) {
    loop.source.stop();
    loop.source.disconnect();
    loop.source = null;
  }
}
