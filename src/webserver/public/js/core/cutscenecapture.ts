// Records a cutscene to a file on this computer, from the Capture tab of the cutscene editor. A recording runs in real
// time, as the game draws: the scene plays, and each frame is either composed here from the game's own layers, at the
// size asked for and with nothing of the interface in it, or taken from the browser tab as it stands.
//
// The game is a stack of canvases and CSS layers that the browser blends. Composing a frame means blending them again
// on one canvas, in the same order and with the same operations (game.css); paintFrame says which. It has to happen
// right after the game draws, in the same frame, so the renderer calls captureFrame at the end of its loop. The game is
// laid out for the file while it does (cutsceneframe.ts), so the layers come at the file's size.
import { aboveCanvas, ambience, ambienceCool, canvas, ghostCanvas, lightCanvas, lightDodgeCanvas, sunFlare, weatherCanvas } from "./ui.js";
import { getAmbiencePaint } from "./ambience.js";
import { setClipsAtFullLevel, tapSound } from "./audio.js";
import { drawOverlayInto, previewPause, previewPlay, previewSeek, sceneClock } from "./cutscene.js";
import { enterFrame, leaveFrame } from "./cutsceneframe.js";

export interface CaptureOptions {
  /** The frames composed from the layers, or the browser tab recorded as it stands. */
  mode: "composite" | "tab";
  /** The edit being worked on here, or what the server has saved: only that goes on to the next scene of a chain. */
  source: "preview" | "saved";
  format: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  /** Mbit/s. */
  bitrate: number;
  sound: boolean;
  from: number;
  to: number | null;
  /** The scene's name, for the file's. */
  name?: string;
}

export interface CaptureState {
  state: "idle" | "waiting" | "recording" | "saving" | "done" | "error";
  seconds: number;
  error?: string;
  file?: string;
  /** Sound was asked for, and the game has none to give yet. */
  silent?: boolean;
}

type Tell = (state: CaptureState) => void;

interface Take {
  options: CaptureOptions;
  tell: Tell;
  begin: () => void;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  extension: string;
  /** Null when the browser tab is what is recorded. */
  out: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; track: CanvasCaptureMediaStreamTrack } | null;
  tap: { close: () => void } | null;
  /** Keeps frames coming in a window nobody can see. */
  beat: Worker | null;
  phase: "arming" | "rolling" | "ending";
  armedAt: number;
  /** When the camera was put where the take starts, 0 before that. */
  placedAt: number;
  rolledAt: number;
  /** Time spent paused, between the scenes of a chain. */
  gapTotal: number;
  /** When the scene last went away, 0 while there is one. */
  gapSince: number;
  nextFrame: number;
  lastTold: number;
}

/** The first sound or frame of a scene that has not come by now will not come. */
const ARM_LIMIT_MS = 20000;
/** After a saved scene ends: the gap in which the next of a chain, or the map it moves to, comes. */
const GAP_LIMIT_MS = 6000;
/** How long the ground a frame shows is waited for: past the map's edge some of it never comes. */
const SETTLE_LIMIT_MS = 3000;
/** Frames the game draws at a new size before they are all at it: each layer takes the size when it is next drawn. */
const SETTLE_FRAMES = 3;
const TELL_MS = 250;
const AUDIO_BITS = 192000;
/** The H.264 encoder behind a recorder gives each frame its share of the bits as if the video ran at this rate, whatever it runs at. */
const H264_BUDGET_FPS = 30;
/** The sun's rays are soft enough to be drawn this much smaller. */
const FLARE_SCALE = 4;

/** What a file can hold, best first. The level of the H.264 ones is high enough for the largest size offered. */
const TYPES: Record<CaptureOptions["format"], string[]> = {
  mp4: ["video/mp4;codecs=avc1.640034,mp4a.40.2", "video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4"],
  webm: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
};

let take: Take | null = null;
let still: { options: CaptureOptions; tell: Tell; since: number; frames: number } | null = null;
let drawNow: () => void = () => {};

/** How to draw a frame where the browser has stopped giving animation frames (renderer.ts). */
export function setFrameDrawer(draw: () => void): void {
  drawNow = draw;
}

// Worked out once and redrawn only when what they show changes: the blur of the rays is not cheap.
const sky = document.createElement("canvas");
const flare = document.createElement("canvas");
let skyKey = "", flareKey = "";

const opacityOf = (element: Element, pseudo?: string): number => Number(getComputedStyle(element, pseudo).opacity) || 0;

/** The same colour with nothing of it showing: `transparent` is black, and a gradient to it goes grey on the way. */
function clearOf(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.fillStyle = color;
  return `${ctx.fillStyle}00`;
}

function paintSky(w: number, h: number): void {
  const { fill, warm } = getAmbiencePaint();
  const warmOpacity = opacityOf(ambience, "::before");
  const key = `${w}:${h}:${fill.join()}:${warm}:${warmOpacity.toFixed(3)}`;
  if (key === skyKey) return;
  skyKey = key;
  if (sky.width !== w || sky.height !== h) {
    sky.width = w;
    sky.height = h;
  }
  const ctx = sky.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, fill[0]!);
  gradient.addColorStop(1, fill[fill.length - 1]!);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  if (warmOpacity <= 0) return;
  const glow = ctx.createLinearGradient(0, 0, 0, h);
  glow.addColorStop(0, warm);
  glow.addColorStop(0.7, clearOf(ctx, warm));
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = warmOpacity;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

/** The sun's rays as #sun-flare-rays and its mask draw them. */
function paintFlare(w: number, h: number, scale: number): void {
  const rays = getAmbiencePaint().flare;
  if (!rays) return;
  const key = `${w}:${h}:${rays.sunX}:${rays.sunY}:${rays.angle}:${rays.color}`;
  if (key === flareKey) return;
  flareKey = key;
  const cw = Math.ceil(w / FLARE_SCALE), ch = Math.ceil(h / FLARE_SCALE), s = scale / FLARE_SCALE;
  const viewW = window.innerWidth, viewH = window.innerHeight;
  flare.width = cw;
  flare.height = ch;
  const ctx = flare.getContext("2d")!;
  const clear = clearOf(ctx, rays.color);
  const reach = 2 * Math.max(viewW, viewH);
  ctx.filter = `blur(${7 * s}px)`;
  ctx.translate((viewW / 2) * s, (viewH / 2) * s);
  ctx.scale(s, s);
  ctx.rotate((rays.angle * Math.PI) / 180);
  for (let x = -reach; x < reach; x += 160) {
    const band = ctx.createLinearGradient(x + 40, 0, x + 88, 0);
    band.addColorStop(0, clear);
    band.addColorStop(0.5, rays.color);
    band.addColorStop(1, clear);
    ctx.fillStyle = band;
    ctx.fillRect(x + 40, -reach, 48, reach * 2);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  // The mask: an ellipse round the sun, in a space where it is a circle of radius one.
  const rx = 0.65 * viewW * s, ry = 0.95 * viewH * s;
  const cx = rays.sunX * s, cy = rays.sunY * s;
  ctx.globalCompositeOperation = "destination-in";
  ctx.setTransform(rx, 0, 0, ry, cx, cy);
  const mask = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  mask.addColorStop(0, "rgba(0, 0, 0, 0.95)");
  mask.addColorStop(0.35, "rgba(0, 0, 0, 0.5)");
  mask.addColorStop(0.72, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = mask;
  ctx.fillRect(-cx / rx, -cy / ry, cw / rx, ch / ry);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

/** One frame, in the order the browser stacks the layers (game.css). The game is laid out for it: each layer covers it. */
function paintFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const scale = w / window.innerWidth;
  const layer = (source: HTMLCanvasElement, operation: GlobalCompositeOperation) => {
    ctx.globalCompositeOperation = operation;
    ctx.drawImage(source, 0, 0, w, h);
  };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);

  layer(canvas, "source-over");
  layer(ghostCanvas, "source-over");
  layer(aboveCanvas, "source-over");
  // (the weather's canvas stands out past the screen on every side, so that what blows in is already moving)
  const margin = -parseFloat(getComputedStyle(weatherCanvas).left) * scale;
  ctx.drawImage(weatherCanvas, -margin, -margin, w + margin * 2, h + margin * 2);

  const dark = opacityOf(ambience);
  if (dark > 0) {
    paintSky(w, h);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = dark;
    ctx.drawImage(sky, 0, 0);
    ctx.globalAlpha = 1;
  }
  layer(lightDodgeCanvas, "color-dodge");

  const cool = opacityOf(ambienceCool);
  if (cool > 0) {
    const [from, to] = getAmbiencePaint().cool;
    const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    shine.addColorStop(0, from);
    shine.addColorStop(1, to);
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = cool;
    ctx.fillStyle = shine;
    ctx.setTransform(1.2 * w, 0, 0, h, 0.5 * w, 0.4 * h);
    ctx.fillRect(-2, -2, 4, 4);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
  const rays = getAmbiencePaint().flare, sun = opacityOf(sunFlare);
  if (sun > 0 && rays) {
    paintFlare(w, h, scale);
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = sun * rays.opacity;
    ctx.drawImage(flare, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  const lightning = document.getElementById("lightning-flash");
  const flash = lightning ? opacityOf(lightning) : 0;
  if (flash > 0) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = flash;
    ctx.fillStyle = "#aaccff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  layer(lightCanvas, "screen");

  ctx.globalCompositeOperation = "source-over";
  drawOverlayInto(ctx, w, h);
}

function fileName(name: string | undefined, extension: string): string {
  const now = new Date(), two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${(name || "cutscene").trim().replace(/[^A-Za-z0-9_-]+/g, "-")}-${stamp}.${extension}`;
}

function download(blob: Blob, file: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function pickType(format: CaptureOptions["format"]): { type: string; extension: string } | null {
  for (const wanted of [format, format === "mp4" ? "webm" : "mp4"] as const) {
    const type = TYPES[wanted].find((t) => MediaRecorder.isTypeSupported(t));
    if (type) return { type, extension: wanted };
  }
  return null;
}

function secondsOf(t: Take, now: number): number {
  return t.rolledAt ? (now - t.rolledAt - t.gapTotal - (t.gapSince ? now - t.gapSince : 0)) / 1000 : 0;
}

/** A number of an EBML file at `at`: an element's id, marker kept, or its size, marker off, and how long it is written. */
function ebmlNumber(bytes: Uint8Array, at: number, id: boolean): { length: number; value: number; unknown: boolean } | null {
  const first = bytes[at] ?? 0;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) return null;
  let value = id ? first : first & (0xff >> length);
  let unknown = !id && value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { length, value, unknown };
}

function writeEbmlSize(bytes: Uint8Array, at: number, length: number, size: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bytes[at + i] = size % 256;
    size = Math.floor(size / 256);
  }
  bytes[at]! |= 0x80 >> (length - 1);
}

const EBML_SEGMENT = 0x18538067, EBML_INFO = 0x1549a966, EBML_TIMECODE_SCALE = 0x2ad7b1, EBML_DURATION = 0x4489;
/** The head of a recording: every element before the first frame is in it. */
const WEBM_HEAD = 65536;

/**
 * A browser writes a WebM as it goes and cannot know how long it will be, so a player shows no length for the file and
 * none can be seeked by its bar. The length goes in the file's Info element, near the start. Any file this cannot read
 * is given back as it came.
 */
async function withDuration(file: Blob, seconds: number): Promise<Blob> {
  const part = new Uint8Array(await file.slice(0, WEBM_HEAD).arrayBuffer());
  const element = (at: number) => {
    const id = ebmlNumber(part, at, true);
    const size = id && ebmlNumber(part, at + id.length, false);
    if (!id || !size) return null;
    const body = at + id.length + size.length;
    return { id: id.value, sizeAt: at + id.length, sizeLength: size.length, size: size.value, unknown: size.unknown, body, end: body + size.value };
  };
  const header = element(0);
  const segment = header && element(header.end);
  if (segment?.id !== EBML_SEGMENT) return file;
  let info = element(segment.body);
  while (info && info.id !== EBML_INFO) info = info.end < part.length ? element(info.end) : null;
  if (!info || info.end > part.length) return file;
  let timecodeScale = 1e6;
  for (let inner = element(info.body); inner && inner.body < info.end; inner = inner.end < info.end ? element(inner.end) : null) {
    if (inner.id === EBML_DURATION) return file;
    if (inner.id === EBML_TIMECODE_SCALE) {
      timecodeScale = 0;
      for (let i = 0; i < inner.size; i++) timecodeScale = timecodeScale * 256 + part[inner.body + i]!;
    }
  }
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (seconds * 1e9) / timecodeScale);
  if (info.size + duration.length >= 2 ** (7 * info.sizeLength) - 1) return file;
  writeEbmlSize(part, info.sizeAt, info.sizeLength, info.size + duration.length);
  if (!segment.unknown) writeEbmlSize(part, segment.sizeAt, segment.sizeLength, segment.size + duration.length);
  return new Blob([part.subarray(0, info.end), duration, part.subarray(info.end), file.slice(part.length)], { type: file.type });
}

/**
 * A window nobody can see (minimised, or covered by the editor) is given no animation frames and its timers are slowed,
 * but a worker's are not. Its beat draws a frame when the browser has stopped giving them, so a recording runs on behind
 * other windows. `document.hidden` does not say so: a covered window can go without frames and still read as visible.
 */
function startBeat(fps: number): Worker {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${1000 / fps});`], { type: "text/javascript" }));
  const beat = new Worker(url);
  URL.revokeObjectURL(url);
  beat.onmessage = () => drawNow();
  return beat;
}

function release(t: Take): void {
  for (const track of t.stream.getTracks()) track.stop();
  t.tap?.close();
  t.beat?.terminate();
  setClipsAtFullLevel(false);
  if (t.out) leaveFrame();
  if (take === t) take = null;
}

function fail(t: Take, error: string): void {
  t.recorder.onstop = null;
  if (t.recorder.state !== "inactive") t.recorder.stop();
  release(t);
  t.tell({ state: "error", seconds: 0, error });
}

function finish(t: Take): void {
  if (t.phase === "ending") return;
  t.phase = "ending";
  if (t.options.source === "preview") previewPause();
  t.tell({ state: "saving", seconds: secondsOf(t, performance.now()) });
  if (t.recorder.state === "inactive") {
    release(t);
    t.tell({ state: "idle", seconds: 0 });
    return;
  }
  // A paused recorder gives what it has when stopped, and the time spent paused is not in the file.
  t.recorder.stop();
}

function record(options: CaptureOptions, tell: Tell, begin: () => void, stream: MediaStream, out: Take["out"], tap: Take["tap"]): void {
  const picked = pickType(options.format);
  if (!picked) {
    for (const track of stream.getTracks()) track.stop();
    tap?.close();
    tell({ state: "error", seconds: 0, error: "This browser cannot write video files." });
    return;
  }
  const share = picked.extension === "mp4" ? Math.min(1, H264_BUDGET_FPS / options.fps) : 1;
  const recorder = new MediaRecorder(stream, { mimeType: picked.type, videoBitsPerSecond: options.bitrate * 1e6 * share, audioBitsPerSecond: AUDIO_BITS, videoBitrateMode: "constant" } as MediaRecorderOptions);
  const t: Take = {
    options, tell, begin, stream, recorder, chunks: [], extension: picked.extension, out, tap, beat: out ? startBeat(options.fps) : null,
    phase: "arming", armedAt: performance.now(), placedAt: 0, rolledAt: 0, gapTotal: 0, gapSince: 0, nextFrame: 0, lastTold: 0,
  };
  take = t;
  recorder.ondataavailable = (e) => { if (e.data.size) t.chunks.push(e.data); };
  recorder.onerror = () => fail(t, "The recording failed.");
  recorder.onstop = async () => {
    const seconds = secondsOf(t, performance.now());
    const file = fileName(options.name, t.extension);
    release(t);
    if (!t.chunks.length) {
      tell({ state: "error", seconds: 0, error: "Nothing was recorded." });
      return;
    }
    const video = new Blob(t.chunks, { type: picked.type });
    download(t.extension === "webm" ? await withDuration(video, seconds).catch(() => video) : video, file);
    tell({ state: "done", seconds, file });
  };
  // The tab's recording can be ended from the browser's own bar.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (take === t) finish(t); });
  if (out) enterFrame(out.canvas.width, out.canvas.height);
  setClipsAtFullLevel(true);
  tell({ state: "recording", seconds: 0, silent: options.sound && !stream.getAudioTracks().length });
  begin();
}

function askForTab(options: CaptureOptions, tell: Tell, begin: () => void): void {
  // A browser lets only a click in this window ask to record it, and the popup's clicks are not this window's.
  const start = document.createElement("button");
  start.id = "cutscene-capture-start";
  start.type = "button";
  start.textContent = "Start recording";
  start.addEventListener("click", async () => {
    start.remove();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: options.fps }, audio: options.sound, preferCurrentTab: true } as DisplayMediaStreamOptions);
      record(options, tell, begin, stream, null, null);
    } catch {
      tell({ state: "error", seconds: 0, error: "The browser was not allowed to record the tab." });
    }
  });
  document.body.appendChild(start);
  tell({ state: "waiting", seconds: 0 });
}

/** Sets a recording up. `begin` is called once it can roll: the scene is then played, and recording starts when it is up. */
export async function startCapture(options: CaptureOptions, tell: Tell, begin: () => void): Promise<void> {
  if (take || document.getElementById("cutscene-capture-start")) return;
  if (options.mode === "tab") {
    askForTab(options, tell, begin);
    return;
  }
  const output = document.createElement("canvas");
  output.width = options.width;
  output.height = options.height;
  const ctx = output.getContext("2d", { alpha: false });
  const stream = output.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!ctx || !track) {
    tell({ state: "error", seconds: 0, error: "This browser cannot record a canvas." });
    return;
  }
  const tap = options.sound ? tapSound() : null;
  for (const sound of tap?.stream.getAudioTracks() ?? []) stream.addTrack(sound);
  record(options, tell, begin, stream, { canvas: output, ctx, track }, tap);
}

/** The Stop button: what there is so far goes to a file. */
export function stopCapture(): void {
  document.getElementById("cutscene-capture-start")?.remove();
  if (take) finish(take);
}

/** The editor closed: nothing is kept. */
export function cancelCapture(): void {
  document.getElementById("cutscene-capture-start")?.remove();
  const t = take;
  if (!t) return;
  t.recorder.onstop = null;
  if (t.recorder.state !== "inactive") t.recorder.stop();
  release(t);
}

/** The scene as it stands goes to a picture, once the game has been drawn at the picture's size. */
export function saveStill(options: CaptureOptions, tell: Tell): void {
  if (take || still) return;
  still = { options, tell, since: 0, frames: 0 };
}

function paintStill(viewLoaded: () => boolean): void {
  if (!still) return;
  const { options, tell } = still, now = performance.now();
  if (!still.since) {
    still.since = now;
    enterFrame(options.width, options.height);
    return;
  }
  if (++still.frames < SETTLE_FRAMES || (now - still.since < SETTLE_LIMIT_MS && !viewLoaded())) return;
  still = null;
  const output = document.createElement("canvas");
  output.width = options.width;
  output.height = options.height;
  const ctx = output.getContext("2d", { alpha: false });
  const failed = () => tell({ state: "error", seconds: 0, error: "The picture could not be made." });
  if (!ctx) {
    leaveFrame();
    failed();
    return;
  }
  const file = fileName(options.name, "png");
  try {
    paintFrame(ctx, output.width, output.height);
    output.toBlob((blob) => {
      if (!blob) {
        failed();
        return;
      }
      download(blob, file);
      tell({ state: "done", seconds: 0, file });
    }, "image/png");
  } catch {
    failed();
  }
  leaveFrame();
}

function arm(t: Take, now: number, viewLoaded: () => boolean): void {
  const clock = sceneClock(), wanted = t.options.source === "saved" ? "live" : "preview";
  if (clock?.mode !== wanted || !clock.ready) {
    if (now - t.armedAt > ARM_LIMIT_MS) fail(t, "The scene did not start. Is the game on its map?");
    return;
  }
  // A preview waits at the take's first frame for the ground round it, which may be more than the window ever showed.
  // A saved scene is under way and cannot wait.
  if (wanted === "preview") {
    if (!t.placedAt) {
      t.placedAt = now;
      previewSeek(t.options.from);
      return;
    }
    if (now - t.placedAt < SETTLE_LIMIT_MS && !viewLoaded()) return;
  }
  t.phase = "rolling";
  t.rolledAt = now;
  t.recorder.start(1000);
  if (wanted === "preview") previewPlay();
}

function roll(t: Take, now: number): void {
  const clock = sceneClock();
  if (t.options.source === "preview") {
    const to = Math.min(t.options.to ?? Infinity, clock?.duration ?? 0);
    if (clock?.mode !== "preview" || clock.t >= to) {
      finish(t);
      return;
    }
  } else if (clock?.mode === "live" && clock.ready) {
    if (t.gapSince) {
      t.gapTotal += now - t.gapSince;
      t.gapSince = 0;
      t.recorder.resume();
    }
  } else {
    if (!t.gapSince) {
      t.gapSince = now;
      t.recorder.pause();
    }
    if (now - t.gapSince > GAP_LIMIT_MS) {
      finish(t);
      return;
    }
  }
  if (t.out && !t.gapSince && now >= t.nextFrame) {
    t.nextFrame = Math.max(t.nextFrame + 1000 / t.options.fps, now + 500 / t.options.fps);
    paintFrame(t.out.ctx, t.out.canvas.width, t.out.canvas.height);
    t.out.track.requestFrame();
  }
  if (now - t.lastTold >= TELL_MS) {
    t.lastTold = now;
    t.tell({ state: "recording", seconds: secondsOf(t, now) });
  }
}

/**
 * The renderer's last word on each frame. `viewLoaded` says whether the ground in view has come. Whatever goes wrong
 * here ends the take and not the game: a throw out of this leaves the next frame unasked for.
 */
export function captureFrame(viewLoaded: () => boolean): void {
  paintStill(viewLoaded);
  const t = take;
  if (!t) return;
  const now = performance.now();
  try {
    if (t.phase === "arming") arm(t, now, viewLoaded);
    if (t.phase === "rolling") roll(t, now);
  } catch {
    fail(t, "The recording failed.");
  }
}
