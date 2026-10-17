import { ambienceSlider, effectsSlider, mutedCheckbox, weatherSlider } from "./ui.js";

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
/** The Ambience slider as a gain, 0..1 (the track of the sound NPCs: npcsounds.ts). */
export function ambienceVolume(): number { return sliderVolume(ambienceSlider); }
/**
 * The Weather slider as a gain, 0..1 (the track of the weather: rain, wind, thunder). USER REQUEST 2026-10-16:
 * "Weather should be separate from ambience in the audio slider. Ambience should be used for those spatial audio npcs".
 */
export function weatherVolume(): number { return sliderVolume(weatherSlider); }

/**
 * Every sound is brought to the same loudness when it is loaded: its loudest sample to PEAK of full scale (measured
 * 2026-10-03: the footstep files peak at 0.017 - 0.053 of full scale, "footstep sand" at 0.017: played as recorded it
 * could not be heard). A file that is next to silent is raised by BOOST_MAX at most.
 */
const PEAK = 0.7, BOOST_MAX = 80;
/** A looped sound plays from its first to its last sample over SILENT of its peak: the files are AAC, whose encoder
 * pads the start and the end with silence, which would be heard as a gap at every turn of the loop. */
const SILENT = 0.002;
/**
 * `loudness`: the sound's average level (root mean square) against its peak. Two files brought to the same peak can
 * still be heard at different levels (measured 2026-10-16 over the whole file: "Gentle Wind 2" 0.17 of its peak,
 * "Gentle Wind" 0.19, "Regular Wind" 0.21);
 * setWeatherSound's `even` plays them by this instead, so a cross from one to the other is not a jump.
 */
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

/**
 * USER REPORT 2026-10-16 ("I noticed some clipping on weather audio when it loops"): the weather files are not made to
 * loop. Measured the same day, the step from the last sample to the first is 4 to 40 times a usual step from one
 * sample to the next ("Regular Wind" 0.33 of its peak against 0.008), and some end louder than they start ("Gentle
 * Wind" 0.24 against 0.18): a click at every turn of the loop. A looped sound is played from a copy made to loop
 * instead: its last LOOP_CROSS seconds (a quarter of it at most) are crossfaded, at equal power, into its first ones
 * and cut off the end, so its end runs straight into its start. Made the first time the sound is looped, then kept.
 */
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
    // (the head fades in as the tail that follows the cut fades out: sample kept - 1 runs on into sample 0, which is
    // the tail's first, as it did in the file)
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

/**
 * Fetches and decodes a sound; null when it cannot be had or no sound may be made yet.
 *
 * USER REPORT 2026-10-16 ("[audio] Unable to decode audio data"): the asset server's address comes with the first map
 * (map.ts sets __assetServerUrl), and the weather can arrive before it. Asked for then, "/audio" went to the Gateway,
 * which answers an unknown path with its login page; that page was decoded as sound, failed, and the sound was kept as
 * "none" for good. Nothing is asked for until the address is known, and nothing is remembered: the next ask fetches.
 */
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

/**
 * Plays a sound effect once. `volume` (0..1) is the sound's own level under the Effects slider (or the Ambience
 * slider, with `track: "weather"`: thunder), `rate` its speed and pitch (1 = as recorded). A sound not loaded yet
 * starts loading and is skipped this time (a footstep that comes late is worse than one missing). Returns whether it
 * played.
 */
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
  source.connect(level).connect(ctx.destination);
  source.start();
  return true;
}

/**
 * USER REQUEST 2026-10-14 ("Hard Rain.wav" and "Soft Rain.wav" ... "Fade the sound in and out. It should be a new
 * 'ambience' sound track"): sounds that loop for as long as they are wanted, under the pause menu's Weather slider
 * (its Ambience slider until 2026-10-16, when that became the sound NPCs' own).
 *
 * setWeatherSound(name, level) says how loud a looping sound should be now (0..1 of the slider); it is asked every frame.
 * A change is never a jump: the sound glides to it, AMBIENCE_FADE seconds being the time constant (most of the way in
 * about three of them), so rain that starts, stops or turns harder fades in, out or across. The slider and the Muted
 * box glide the same way. A loop starts at a random point of its file (two rains started together do not beat), and
 * is stopped once it has been all but silent for AMBIENCE_STOP time constants.
 */
export const AMBIENCE_FADE = 1.5, AMBIENCE_STOP = 6;
/**
 * USER REPORT 2026-10-16 ("Weather effects like wind and sounds stay around even when the weather has changed"): a
 * sound turned off altogether glides out with this shorter time constant (inaudible in about two seconds, stopped after
 * AMBIENCE_STOP of them), not AMBIENCE_FADE, whose tail was heard for some eight seconds after the weather changed.
 * A level under SILENT_LEVEL counts as off (a cross at its end leaves cos(pi/2), 6e-17, not 0, which restarted the
 * loop every frame).
 */
const AMBIENCE_FADE_OUT = 0.5, SILENT_LEVEL = 0.001;
/**
 * USER REQUEST 2026-10-16 (the three winds: "adjust the sound of each also based on wind speed"), for the wind (weather.ts):
 * - `even`: played by its average level (Sound.loudness) instead of its peak: at level 1 its average is EVEN_RMS of full
 *   scale, raised by EVEN_MAX at most so a quiet file is not pushed into clipping;
 * - `rate`: its speed and pitch (1 = as recorded), glided to over RATE_GLIDE seconds (a time constant);
 * - `glide`: the time constant its level glides with, AMBIENCE_FADE when not given (the wind's is shorter: its gusts
 *   are heard).
 * - `key`: tells this loop from another of the same file (a tornado's roar is "regular wind" too, beside the wind's own);
 *   the file's name when not given.
 */
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
    gain.connect(ctx.destination);
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

/**
 * USER REQUEST 2026-10-16 ("sound NPCs with a radius for applying spatial audio effects that fade in/out and work with
 * surround sound headphones"): looping sounds placed in the world, under the Ambience slider.
 *
 * setSoundAt(key, name, level, at, spread) is asked every frame for each placed sound: `key` tells one placed sound
 * from another (two NPCs may play the same file), `level` (0..1 of the slider) is how loud it should be now, `at` is
 * where it is from the listener (x to the right, y up, z toward the back: the screen's down; any unit), and `spread`
 * (0..1) how much it is heard from there. The sound goes two ways at once: as recorded, the same in both ears, and
 * through an HRTF panner, so on headphones it is heard from its side, in front or behind. `spread` crosses from the
 * first to the second (equal power: the loudness stays). USER REPORT 2026-10-16 ("There's no fade, it just suddenly
 * switches from center audio to right/left"): the panner alone cannot do it. Chrome's HRTF takes left and right from
 * the direction across the ground only, so a sound placed overhead and moved 1 px to the right was measured 7.5 dB
 * louder in the right ear than the left at once; the crossing is measured 0.2 dB at 10 %, 4.2 dB halfway, 11.3 dB
 * when it is all the panner's. The panner only places it (no distance rolloff), the loudness is `level`. Level changes
 * glide (SPOT_FADE seconds being the time constant), so walking in, out or across is a fade, never a jump, and a sound
 * that has been all but silent for AMBIENCE_STOP time constants is stopped. fadeSoundsExcept(keys) fades out every
 * placed sound not among `keys` (its NPC has gone).
 */
const SPOT_FADE = 0.25, SPOT_MOVE = 0.05;
/**
 * What the HRTF panner takes away, given back. USER REPORT 2026-10-16 ("It sounds extremely quiet"): measured in
 * Chrome on stereo noise, the panner's output is 5.5 dB under the same sound unpanned when it is level with the
 * listener, and 8.5 dB under when it is straight overhead (where a player at a sound NPC's middle hears it). Lifting
 * by 5.5 dB plus 3 dB times how much it is overhead brings every direction to within 3 dB of unpanned (in front and
 * at the side about level, behind 3 dB under).
 */
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
    gain.connect(ctx.destination);
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
