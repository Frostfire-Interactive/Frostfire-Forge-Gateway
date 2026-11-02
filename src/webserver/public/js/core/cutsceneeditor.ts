// Game-window half of the cutscene editor (/cutsceneeditor): owns the popup window, relays its messages to the server,
// as mounteditor.ts does, and shows the scene being worked on in the game. The popup (cutsceneeditorbridge.ts) holds the
// document and sends it here after each edit. This never changes it: a mark dragged about in the game window is reported
// to the popup, which changes the document and sends it back.
//
// The preview is on this client alone: no other player sees anything of it (cutscene.ts). The director's view is a layer
// over the game that takes the pointer, so that the camera can be flown anywhere while the player stays where they are.
import Cache from "./cache.js";
import { config } from "../web/global.js";
import { cachedPlayerId, sendRequest } from "./socket.js";
import { getSceneShot, onScene, previewClose, previewPause, previewPlay, previewScene, previewSeek, sceneClock, setFreeCamera, setGuides } from "./cutscene.js";
import { eventToWorld, userZoom, worldToScreen, worldZoom } from "./worldzoom.js";
import { loadEffect, soundLength } from "./audio.js";
import { cancelCapture, startCapture, stopCapture, saveStill, type CaptureOptions, type CaptureState } from "./cutscenecapture.js";
import { makePlan, poseAt, shotAt, type CutsceneDoc, type Look, type PlaceRef, type Plan, type Point, type Shot } from "./cutscenedoc.js";

const cache = Cache.getInstance();

const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 800;

/** How often the popup is told where the scene's clock is, and where the camera is. */
const CLOCK_MS = 33;
const HERE_MS = 200;
/** The changes to a scene are looked over this long after the last, for what the server has yet to fill in. */
const RESOLVE_WAIT_MS = 150;
/** After a saved scene ends: the gap in which the next of a chain, or the map it moves to, comes. */
const RESUME_AFTER_END_MS = 1200;
/** A saved scene asked for that has not come by now was refused (the server says why in the game window). */
const RESUME_AFTER_NOTHING_MS = 3000;
/** How near the pointer has to be to a mark to take it, in screen pixels. */
const GRAB_PX = 11;
const MIN_ZOOM = 1, MAX_ZOOM = 3;
/** The name a scene being resolved is checked under: the document sent is a stand-in made of what needs resolving. */
const STAND_IN_NAME = "preview";
/** What the free camera's overlay says between one pick and the next. */
const RESTING_HINT = "Free camera: drag to look around, scroll to zoom, drag a shot or an actor to move it";

const CAMERA = "#7dd3fc", ACTOR = "#86efac", PROP = "#f0abfc", AREA = "#fca5a5", PICKED = "#ffffff";

type View = "scene" | "free" | "game";

/** The server sends pictures as paths on the asset server: only this client knows the address it reaches it at. */
function withPictures(data: any): any {
  const located = (list: any) => (Array.isArray(list) ? list : []).map((entry: any) => (
    typeof entry?.image === "string" && entry.image.startsWith("/") ? { ...entry, image: `${config.ASSET_SERVER_URL}${entry.image}` } : entry
  ));
  const spriteSheets = Object.fromEntries(Object.entries(data?.spriteSheets ?? {}).map(([slot, sheets]) => [slot, located(sheets)]));
  return { ...data, spriteSheets, icons: located(data?.icons) };
}

/** A mark in the world, as it was last drawn. */
interface Mark {
  ref: PlaceRef;
  x: number;
  y: number;
  /** What a key following something moves about: its x and y are measured from here. */
  anchor: Point | null;
  color: string;
  label: string;
  picked: boolean;
}

const bareMap = (name: unknown) => String(name ?? "").replace(/\.json$/i, "");
const lookKey = (look: Look) => JSON.stringify(look);

class CutsceneEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private hereTimer: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;

  private doc: CutsceneDoc | null = null;
  private plan: Plan | null = null;
  private view: View = "free";
  private free: Shot | null = null;
  private picks: Array<{ track: string; item: string }> = [];
  /** A scene from the server has the screen: the preview waits. */
  private suspended = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastClock = 0;
  private lastPlaying = false;
  /** Where the playhead is: a preview put up again, after the Game view or a saved scene, comes back to here. */
  private playhead = 0;
  /** The view to go back to after a recording. */
  private viewBefore: View | null = null;

  // What the server filled in, by what it was asked about. A preview shows what it has, and more as it comes.
  private looks = new Map<string, { sprite_type: string; spriteLayers: any }>();
  private weathers = new Map<string, any>();
  private particles = new Map<string, any>();
  private failed = new Set<string>();
  private asking: { looks: Look[]; refs: string[] } | null = null;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private measured = new Set<string>();

  private overlay: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  private marks: Mark[] = [];
  /** The next click in the game says where this goes. */
  private picking: PlaceRef | null = null;
  /** The next drag in the game draws this area. */
  private drawing: PlaceRef | null = null;
  private drawn: { from: Point; to: Point } | null = null;

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    window.addEventListener("pagehide", () => {
      try {
        if (this.editorWindow && !this.editorWindow.closed) this.editorWindow.close();
      } catch {
        // Window already gone.
      }
    });
    onScene((event) => this.onSceneEvent(event));
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Escape" || (!this.picking && !this.drawing)) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      this.endPicking();
    }, { capture: true });
  }

  toggle(): void {
    if (this.isActive) this.close();
    else this.open();
  }

  private open(): void {
    this.isActive = true;
    const url = window.location.origin + "/cutscene-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2) + 48);
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2) + 48);
    this.editorWindow = window.open(url, "CutsceneEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    sendRequest({ type: "CUTSCENE_EDITOR_LIST", data: {} });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
    }, 500);
    this.hereTimer = setInterval(() => this.tellHere(), HERE_MS);
  }

  close(): void {
    this.isActive = false;
    if (this.closeWatcher) {
      clearInterval(this.closeWatcher);
      this.closeWatcher = null;
    }
    if (this.hereTimer) {
      clearInterval(this.hereTimer);
      this.hereTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    try {
      this.editorWindow?.close();
    } catch {
      // Window already gone.
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.queue = [];
    this.doc = null;
    this.plan = null;
    this.free = null;
    this.suspended = false;
    cancelCapture();
    this.applyView();
  }

  private toEditor(msg: any): void {
    if (!this.editorWindow || this.editorWindow.closed) return;
    if (!this.bridgeReady) {
      this.queue.push(msg);
      return;
    }
    this.editorWindow.postMessage(msg, "*");
  }

  // -------------------------------------------------------- server messages

  onData(data: any): void {
    this.lastData = withPictures(data);
    // What can be resolved may have changed with the lists: a weather added, a particle changed.
    this.looks.clear();
    this.weathers.clear();
    this.particles.clear();
    this.failed.clear();
    this.toEditor({ type: "data", data: this.lastData });
    this.askResolve();
  }

  onResult(data: any): void {
    if (data?.action === "CUTSCENE_EDITOR_RESOLVE") {
      this.onResolveRefused(data);
      return;
    }
    this.toEditor({ type: "result", ...data });
  }

  onResolved(data: any): void {
    const asked = this.asking;
    this.asking = null;
    const resolved: CutsceneDoc | undefined = data?.doc;
    if (!asked || !resolved) return;
    resolved.actors.forEach((actor, i) => {
      const look = asked.looks[i];
      if (look) this.looks.set(lookKey(look), { sprite_type: actor.sprite_type ?? "none", spriteLayers: actor.spriteLayers ?? null });
    });
    const clips: any[] = resolved.tracks[0]?.items ?? [];
    for (const clip of clips) {
      if (clip.do === "weather") {
        if (clip.weatherData === undefined) this.failed.add(`weather ${clip.weather}`);
        else this.weathers.set(clip.weather, clip.weatherData);
      } else if (clip.do === "particles") {
        if (clip.particleData === undefined) this.failed.add(`particle ${clip.particle}`);
        else this.particles.set(clip.particle, clip.particleData);
      }
    }
    this.showScene();
    this.askResolve();
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  /** One thing named in a stand-in was refused (an NPC since deleted): the rest are asked for again without it. */
  private onResolveRefused(data: any): void {
    const asked = this.asking;
    this.asking = null;
    if (!asked) return;
    const wrong = new Set<string>();
    for (const path of Object.keys(data?.fields ?? {})) {
      const actor = /^actors\.(\d+)/.exec(path);
      const clip = /^tracks\.0\.items\.(\d+)/.exec(path);
      const look = actor ? asked.looks[Number(actor[1])] : undefined;
      if (look) wrong.add(`look ${lookKey(look)}`);
      const ref = clip ? asked.refs[Number(clip[1])] : undefined;
      if (ref) wrong.add(ref);
    }
    // Refused as a whole (no permission any more): nothing is asked for again.
    if (!wrong.size) {
      for (const look of asked.looks) wrong.add(`look ${lookKey(look)}`);
      for (const ref of asked.refs) wrong.add(ref);
    }
    for (const key of wrong) this.failed.add(key);
    this.askResolve();
  }

  // ------------------------------------------------------- what the server fills in

  private askResolve(): void {
    if (!this.doc || this.resolveTimer) return;
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      this.sendResolve();
    }, RESOLVE_WAIT_MS);
  }

  /** Asks about what the document uses and is not known yet, in a stand-in that holds only that: a scene being worked on may not be valid yet. */
  private sendResolve(): void {
    const doc = this.doc;
    if (!doc || this.asking) return;
    const looks: Look[] = [], seen = new Set<string>();
    for (const actor of doc.actors) {
      const key = lookKey(actor.look);
      if (actor.look.kind === "viewer" || seen.has(key) || this.looks.has(key) || this.failed.has(`look ${key}`)) continue;
      seen.add(key);
      looks.push(actor.look);
    }
    const refs: string[] = [], items: any[] = [];
    for (const track of doc.tracks) {
      if (track.kind !== "world") continue;
      for (const clip of track.items) {
        if (clip.do === "time") continue;
        const name = clip.do === "weather" ? clip.weather : clip.particle;
        const ref = `${clip.do === "weather" ? "weather" : "particle"} ${name}`;
        const held = clip.do === "weather" ? this.weathers.has(name) : this.particles.has(name);
        if (!name || held || refs.includes(ref) || this.failed.has(ref)) continue;
        refs.push(ref);
        const id = `w${items.length}`;
        items.push(clip.do === "weather" ? { id, t: 0, d: 0, do: "weather", weather: name } : { id, t: 0, d: 0, do: "particles", particle: name, x: 0, y: 0 });
      }
    }
    if (!looks.length && !items.length) return;
    this.asking = { looks, refs };
    sendRequest({
      type: "CUTSCENE_EDITOR_RESOLVE",
      data: {
        doc: {
          name: STAND_IN_NAME, description: "", map: bareMap(window.mapData?.name) || doc.map, duration: 1, settings: {},
          actors: looks.map((look, i) => ({ id: `a${i}`, name: "", showName: false, look, x: 0, y: 0, direction: "down", visible: true })),
          tracks: items.length ? [{ id: "w", kind: "world", label: "", items }] : [],
          triggers: [], end: { teleport: null, next: null },
        },
      },
    });
  }

  /** The document with what is known so far filled in. */
  private filled(doc: CutsceneDoc): CutsceneDoc {
    for (const actor of doc.actors) {
      const look = this.looks.get(lookKey(actor.look));
      if (!look) continue;
      actor.sprite_type = look.sprite_type;
      actor.spriteLayers = look.spriteLayers;
    }
    for (const track of doc.tracks) {
      if (track.kind !== "world") continue;
      for (const clip of track.items) {
        if (clip.do === "weather" && this.weathers.has(clip.weather)) clip.weatherData = this.weathers.get(clip.weather);
        else if (clip.do === "particles" && this.particles.has(clip.particle)) clip.particleData = this.particles.get(clip.particle);
      }
    }
    return doc;
  }

  private measureSounds(doc: CutsceneDoc): void {
    for (const track of doc.tracks) {
      if (track.kind !== "audio") continue;
      for (const clip of track.items) {
        if (!clip.sound || this.measured.has(clip.sound)) continue;
        const sound = clip.sound;
        this.measured.add(sound);
        void loadEffect(sound).then(() => {
          const length = soundLength(sound);
          if (length !== null) this.toEditor({ type: "lengths", lengths: { [sound]: length } });
        });
      }
    }
  }

  // ------------------------------------------------------------------- view

  private takeScene(doc: CutsceneDoc | null): void {
    this.doc = doc;
    this.plan = doc ? makePlan(doc) : null;
    if (doc) {
      this.measureSounds(doc);
      this.askResolve();
    }
    this.applyView();
  }

  private showScene(): void {
    if (this.doc && !this.suspended && this.view !== "game") previewScene(this.filled(this.doc), this.playhead);
  }

  private applyView(): void {
    const showing = this.isActive && !!this.doc && !this.suspended && this.view !== "game";
    if (!showing) {
      previewClose();
      setFreeCamera(null);
      setGuides(null);
      this.setOverlay(false);
      return;
    }
    this.showScene();
    if (this.view === "free") {
      this.free ??= this.startingShot();
      setFreeCamera(this.free);
      setGuides(this.drawGuides);
      this.setOverlay(true);
    } else {
      setFreeCamera(null);
      setGuides(null);
      this.setOverlay(false);
    }
  }

  private selfPlayer(): any {
    return Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  }

  private startingShot(): Shot {
    const shot = getSceneShot();
    if (shot) return { ...shot };
    return { x: Number((window as any).cameraX) || 0, y: Number((window as any).cameraY) || 0, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, userZoom())) };
  }

  private suspend(): void {
    this.suspended = true;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.applyView();
    this.toEditor({ type: "live", on: true });
  }

  private resumeAfter(ms: number): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (sceneClock()?.mode === "live") return;
      this.suspended = false;
      this.applyView();
      this.toEditor({ type: "live", on: false });
    }, ms);
  }

  private onSceneEvent(event: string): void {
    if (!this.isActive) return;
    const clock = sceneClock();
    if (clock?.mode === "live") {
      if (!this.suspended) this.suspend();
      else if (this.resumeTimer) {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
      }
    } else if (!clock && this.suspended && event !== "frame") {
      this.resumeAfter(RESUME_AFTER_END_MS);
    }
    if (clock?.mode === "preview") this.playhead = clock.t;
    if (clock) this.tellClock(clock.t, clock.playing, clock.mode === "live");
  }

  private tellClock(t: number, playing: boolean, live: boolean): void {
    const now = performance.now();
    if (now - this.lastClock < CLOCK_MS && playing === this.lastPlaying) return;
    this.lastClock = now;
    this.lastPlaying = playing;
    this.toEditor({ type: "clock", t, playing, live });
  }

  private tellHere(): void {
    if (!this.bridgeReady) return;
    this.toEditor({
      type: "here",
      x: Math.round(Number((window as any).cameraX) || 0), y: Math.round(Number((window as any).cameraY) || 0),
      zoom: this.free && this.view === "free" ? this.free.zoom : userZoom(),
      map: bareMap(window.mapData?.name),
    });
  }

  // ---------------------------------------------------------- the director's view

  private setOverlay(on: boolean): void {
    if (!on) {
      this.endPicking();
      this.setHint(null);
      this.overlay?.remove();
      this.overlay = null;
      return;
    }
    if (this.overlay) return;
    const overlay = document.createElement("div");
    overlay.id = "cutscene-director";
    overlay.addEventListener("pointerdown", (e) => this.onPress(e));
    overlay.addEventListener("pointermove", (e) => this.onHover(e));
    overlay.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.setHint(RESTING_HINT);
  }

  private setHint(text: string | null): void {
    if (!text) {
      this.hint?.remove();
      this.hint = null;
      return;
    }
    if (!this.hint) {
      this.hint = document.createElement("div");
      this.hint.id = "cutscene-director-hint";
      this.overlay?.appendChild(this.hint);
    }
    this.hint.textContent = text;
  }

  private beginPicking(ref: PlaceRef, area: boolean): void {
    this.view = "free";
    this.applyView();
    this.picking = area ? null : ref;
    this.drawing = area ? ref : null;
    this.setHint(area ? "Drag out the area. Esc cancels." : "Click where it goes. Esc cancels.");
    if (this.overlay) this.overlay.dataset.mode = "pick";
    this.toEditor({ type: "view", mode: "free" });
    window.focus();
  }

  private endPicking(): void {
    this.picking = null;
    this.drawing = null;
    this.drawn = null;
    if (!this.overlay) return;
    this.setHint(RESTING_HINT);
    delete this.overlay.dataset.mode;
  }

  private moved(ref: PlaceRef, place: Record<string, number>, done: boolean): void {
    this.toEditor({ type: "moved", ref, place, done });
  }

  private onPress(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = eventToWorld(e);
    if (this.picking) {
      this.moved(this.picking, { x: Math.round(at.x), y: Math.round(at.y) }, true);
      this.endPicking();
      return;
    }
    if (this.drawing) {
      this.drawn = { from: at, to: at };
      this.follow(e, (move) => { if (this.drawn) this.drawn.to = eventToWorld(move); }, () => {
        const box = this.drawn, ref = this.drawing;
        this.endPicking();
        if (!box || !ref) return;
        const x = Math.min(box.from.x, box.to.x), y = Math.min(box.from.y, box.to.y);
        this.moved(ref, { x: Math.round(x), y: Math.round(y), w: Math.round(Math.abs(box.to.x - box.from.x)), h: Math.round(Math.abs(box.to.y - box.from.y)) }, true);
      });
      return;
    }
    const mark = this.markAt(e);
    if (mark) {
      if ("track" in mark.ref && "item" in mark.ref) this.toEditor({ type: "select", track: mark.ref.track, item: mark.ref.item });
      let moved = false;
      this.follow(e, (move) => {
        const to = eventToWorld(move);
        moved = true;
        this.moved(mark.ref, { x: Math.round(to.x - (mark.anchor?.x ?? 0)), y: Math.round(to.y - (mark.anchor?.y ?? 0)) }, false);
      }, () => { if (moved) this.toEditor({ type: "movedDone" }); });
      return;
    }
    const startX = e.clientX, startY = e.clientY, from = this.free ? { ...this.free } : null;
    this.follow(e, (move) => {
      if (!this.free || !from) return;
      const scale = worldZoom();
      this.setCamera({ x: from.x - (move.clientX - startX) / scale, y: from.y - (move.clientY - startY) / scale, zoom: this.free.zoom });
    });
  }

  private follow(start: PointerEvent, onMove: (e: PointerEvent) => void, onEnd?: () => void): void {
    const up = (e: PointerEvent) => {
      if (e.pointerId !== start.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd?.();
    };
    const move = (e: PointerEvent) => { if (e.pointerId === start.pointerId) onMove(e); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  private onHover(e: PointerEvent): void {
    if (!this.overlay || this.overlay.dataset.mode === "pick") return;
    this.overlay.classList.toggle("over-mark", !!this.markAt(e));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.free) return;
    this.setCamera({ ...this.free, zoom: this.free.zoom * Math.exp(-e.deltaY * 0.0012) });
  }

  /** Puts the director's camera somewhere inside the map, as the game keeps its own there (renderer.ts). */
  private setCamera(shot: Shot): void {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, shot.zoom));
    const map = window.mapData;
    let { x, y } = shot;
    if (map) {
      const halfW = window.innerWidth / zoom / 2, halfH = window.innerHeight / zoom / 2;
      const w = map.width * map.tilewidth, h = map.height * map.tileheight;
      x = Math.max(halfW, Math.min(Math.max(halfW, w - halfW), x));
      y = Math.max(halfH, Math.min(Math.max(halfH, h - halfH), y));
    }
    this.free = { x, y, zoom };
    setFreeCamera(this.free);
  }

  private markAt(e: { clientX: number; clientY: number }): Mark | null {
    let best: Mark | null = null, gap = GRAB_PX;
    for (const mark of this.marks) {
      const at = worldToScreen(mark.x, mark.y);
      const away = Math.hypot(at.x - e.clientX, at.y - e.clientY);
      if (away < gap) {
        gap = away;
        best = mark;
      }
    }
    return best;
  }

  private isPicked(track: string, item: string): boolean {
    return this.picks.some((p) => p.track === track && p.item === item);
  }

  private whereAt(doc: CutsceneDoc, plan: Plan, t: number): (who: string) => Point | null {
    return (who) => {
      if (who === "viewer") {
        const self = this.selfPlayer();
        return self?.renderPosition ?? self?.position ?? null;
      }
      const actor = doc.actors.find((a) => a.id === who);
      return actor ? poseAt(plan, actor, t) : null;
    };
  }

  private line(ctx: CanvasRenderingContext2D, points: Point[], color: string, dash: number[] = []): void {
    ctx.beginPath();
    points.forEach((p, i) => {
      const at = worldToScreen(p.x, p.y);
      if (i) ctx.lineTo(at.x, at.y);
      else ctx.moveTo(at.x, at.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** What the camera would see from a shot. */
  private frame(ctx: CanvasRenderingContext2D, shot: Shot, color: string): void {
    const w = window.innerWidth / shot.zoom / 2, h = window.innerHeight / shot.zoom / 2;
    this.line(ctx, [
      { x: shot.x - w, y: shot.y - h }, { x: shot.x + w, y: shot.y - h }, { x: shot.x + w, y: shot.y + h },
      { x: shot.x - w, y: shot.y + h }, { x: shot.x - w, y: shot.y - h },
    ], color, [8, 6]);
  }

  private cameraGuides(ctx: CanvasRenderingContext2D, doc: CutsceneDoc, plan: Plan): void {
    const trail: Point[] = [];
    if (plan.keys.length > 1) {
      const steps = Math.max(30, Math.min(240, Math.round(doc.duration * 15)));
      const first = plan.keys[0]!.t, last = plan.keys[plan.keys.length - 1]!.t;
      for (let i = 0; i <= steps; i++) {
        const t = first + (last - first) * (i / steps);
        const shot = shotAt(plan, t, this.whereAt(doc, plan, t));
        if (shot) trail.push(shot);
      }
      this.line(ctx, trail, CAMERA);
    }
    for (const track of doc.tracks) {
      if (track.kind !== "camera" || track.muted) continue;
      for (const key of track.items) {
        const anchor = key.follow ? this.whereAt(doc, plan, key.t)(key.follow) : null;
        const x = key.x + (anchor?.x ?? 0), y = key.y + (anchor?.y ?? 0);
        const picked = this.isPicked(track.id, key.id);
        this.marks.push({ ref: { kind: "key", track: track.id, item: key.id }, x, y, anchor, color: CAMERA, label: `${key.t.toFixed(1)}s`, picked });
        if (picked) this.frame(ctx, { x, y, zoom: key.zoom }, PICKED);
      }
    }
    const now = sceneClock();
    const shot = now ? shotAt(plan, now.t, this.whereAt(doc, plan, now.t)) : null;
    if (shot) this.frame(ctx, shot, CAMERA);
  }

  private actorGuides(ctx: CanvasRenderingContext2D, doc: CutsceneDoc): void {
    for (const actor of doc.actors) {
      this.marks.push({ ref: { kind: "actor", actor: actor.id }, x: actor.x, y: actor.y, anchor: null, color: ACTOR, label: actor.name || actor.id, picked: false });
      const path: Point[] = [{ x: actor.x, y: actor.y }];
      const steps: Array<{ t: number; trackId: string; act: any }> = [];
      for (const track of doc.tracks) {
        if (track.kind !== "actor" || track.actor !== actor.id || track.muted) continue;
        for (const act of track.items) steps.push({ t: act.t, trackId: track.id, act });
      }
      steps.sort((a, b) => a.t - b.t);
      for (const { trackId, act } of steps) {
        const picked = this.isPicked(trackId, act.id);
        if (act.do === "place") {
          path.push({ x: act.x, y: act.y });
          this.marks.push({ ref: { kind: "place", track: trackId, item: act.id }, x: act.x, y: act.y, anchor: null, color: ACTOR, label: "", picked });
        } else if (act.do === "move") {
          act.path.forEach((stop: Point, index: number) => {
            path.push(stop);
            this.marks.push({ ref: { kind: "point", track: trackId, item: act.id, index }, x: stop.x, y: stop.y, anchor: null, color: ACTOR, label: "", picked });
          });
        }
      }
      if (path.length > 1) this.line(ctx, path, ACTOR, [4, 4]);
    }
  }

  private worldGuides(ctx: CanvasRenderingContext2D, doc: CutsceneDoc): void {
    for (const track of doc.tracks) {
      if (track.kind !== "world" || track.muted) continue;
      for (const clip of track.items) {
        if (clip.do !== "particles") continue;
        this.marks.push({ ref: { kind: "particle", track: track.id, item: clip.id }, x: clip.x, y: clip.y, anchor: null, color: PROP, label: clip.particle, picked: this.isPicked(track.id, clip.id) });
      }
    }
    for (const trigger of doc.triggers) {
      if (trigger.on !== "area") continue;
      const { x, y, w, h } = trigger;
      this.line(ctx, [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }], AREA);
      this.marks.push({ ref: { kind: "trigger", trigger: trigger.id, part: "move" }, x: x + w / 2, y: y + h / 2, anchor: { x: w / 2, y: h / 2 }, color: AREA, label: "", picked: false });
      this.marks.push({ ref: { kind: "trigger", trigger: trigger.id, part: "size" }, x: x + w, y: y + h, anchor: null, color: AREA, label: "", picked: false });
    }
    if (doc.end.teleport && bareMap(window.mapData?.name).toLowerCase() === doc.end.teleport.map.toLowerCase()) {
      this.marks.push({ ref: { kind: "teleport" }, x: doc.end.teleport.x, y: doc.end.teleport.y, anchor: null, color: PROP, label: "End", picked: false });
    }
  }

  private drawGuides = (ctx: CanvasRenderingContext2D): void => {
    const doc = this.doc, plan = this.plan;
    if (!doc || !plan) return;
    const scale = ctx.canvas.width / window.innerWidth;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.marks = [];
    this.worldGuides(ctx, doc);
    this.actorGuides(ctx, doc);
    this.cameraGuides(ctx, doc, plan);
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const mark of this.marks) {
      const at = worldToScreen(mark.x, mark.y);
      ctx.beginPath();
      ctx.arc(at.x, at.y, mark.picked ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = mark.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = mark.picked ? PICKED : "rgba(0, 0, 0, 0.6)";
      ctx.stroke();
      if (!mark.label) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.strokeText(mark.label, at.x + 10, at.y);
      ctx.fillStyle = PICKED;
      ctx.fillText(mark.label, at.x + 10, at.y);
    }
    if (this.drawn) {
      const { from, to } = this.drawn;
      this.line(ctx, [from, { x: to.x, y: from.y }, to, { x: from.x, y: to.y }, from], AREA);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // --------------------------------------------------------------- the popup

  private tellCapture = (state: CaptureState): void => {
    this.toEditor({ type: "capture", ...state });
    if ((state.state !== "done" && state.state !== "error" && state.state !== "idle") || !this.viewBefore) return;
    this.view = this.viewBefore;
    this.viewBefore = null;
    this.applyView();
    this.toEditor({ type: "view", mode: this.view });
  };

  /** A recording shows the scene as a player gets it, whichever view was up. */
  private beginCapture(options: CaptureOptions): void {
    this.viewBefore ??= this.view;
    this.view = "scene";
    this.applyView();
    this.toEditor({ type: "view", mode: "scene" });
    void startCapture(options, this.tellCapture, () => {
      if (options.source !== "saved") return;
      this.suspend();
      this.resumeAfter(RESUME_AFTER_NOTHING_MS);
      sendRequest({ type: "CUTSCENE_EDITOR_PLAY", data: { name: options.name } });
    });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    // Only this editor's own popup is listened to (every editor's popup posts to this window).
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        if (this.lastData) this.editorWindow?.postMessage({ type: "data", data: this.lastData }, "*");
        for (const queued of this.queue.splice(0)) {
          if (queued.type !== "data") this.editorWindow?.postMessage(queued, "*");
        }
        break;
      case "request":
        // Only cutscene editor packets leave from here; the server checks permission again on every one.
        if (typeof msg.packet !== "string" || !msg.packet.startsWith("CUTSCENE_EDITOR_")) break;
        if (msg.packet === "CUTSCENE_EDITOR_PLAY") {
          this.suspend();
          this.resumeAfter(RESUME_AFTER_NOTHING_MS);
        }
        sendRequest({ type: msg.packet, data: msg.data && typeof msg.data === "object" ? msg.data : {} });
        break;
      case "scene": this.takeScene(msg.doc ?? null); break;
      case "picks": this.picks = Array.isArray(msg.picks) ? msg.picks : []; break;
      case "view":
        this.view = msg.mode === "scene" || msg.mode === "game" ? msg.mode : "free";
        this.applyView();
        break;
      case "seek":
        this.playhead = Number(msg.t) || 0;
        previewSeek(this.playhead);
        break;
      case "play": previewPlay(); break;
      case "pause": previewPause(); break;
      case "pick": this.beginPicking(msg.ref, false); break;
      case "drawArea": this.beginPicking(msg.ref, true); break;
      case "cameraTo":
        if (this.free) this.setCamera({ x: Number(msg.x) || 0, y: Number(msg.y) || 0, zoom: Number(msg.zoom) || this.free.zoom });
        break;
      case "capture": this.beginCapture(msg.options as CaptureOptions); break;
      case "captureStop": stopCapture(); break;
      case "still": saveStill(msg.options as CaptureOptions, this.tellCapture); break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const cutsceneEditor = new CutsceneEditor();
export default cutsceneEditor;
