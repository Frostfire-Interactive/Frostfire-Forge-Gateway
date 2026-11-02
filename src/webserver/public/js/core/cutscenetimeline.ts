// The timeline of the cutscene editor's popup: a row to each track, its items laid out along the scene's seconds, and
// the playhead over them. Items are dragged along their track, stretched by their ends and picked to edit below. The
// document is the editor's (cutsceneeditorbridge.ts): this changes the items it is shown and says that it did.
import { el, icon, iconButton, type IconName } from "./toolkit.js";
import type { CutsceneDoc, Item, Track } from "./cutscenedoc.js";

/** One item picked, by its track's id and its own. */
export interface Picked { track: string; item: string }

export interface TimelineHost {
  doc(): CutsceneDoc | null;
  /** The document changed. `done` ends the drag that changed it: that is one step of undo. */
  changed(done: boolean): void;
  seek(t: number): void;
  /** Something else is picked now. */
  picked(): void;
  /** Add an item to a track at this time: an item of a track that has several kinds asks which, by this button. */
  add(track: Track, t: number, anchor: HTMLElement): void;
  /** The track's own menu. */
  trackMenu(track: Track, anchor: HTMLElement): void;
  /** How long a sound's file is, when the game window has said. */
  fileLength(sound: string): number | null;
  /** The server found something wrong with this item. */
  wrong(track: Track, item: Item): boolean;
}

/** What each kind of track is drawn with. */
export const TRACK_ICONS: Record<Track["kind"], IconName> = {
  camera: "image", shake: "pulse", screen: "eye", text: "pencil", actor: "user", audio: "megaphone", world: "cloud", mark: "pin",
};

/** What an empty row says it is for. */
const EMPTY_ROWS: Record<Track["kind"], string> = {
  camera: "a camera shot", shake: "a camera shake", screen: "a fade or flash", text: "text", actor: "what this actor does",
  audio: "a sound", world: "weather, time of day or particles", mark: "a marker",
};

const HEAD_WIDTH = 188;
/** Half a moment's diamond, as in cutsceneeditor.css. */
const KEY_HALF = 6;
/** How near (in screen pixels) a dragged edge has to come to another item, or the playhead, to land on it. */
const SNAP_PX = 7;
/** A sound with no length yet is drawn this long. */
const UNKNOWN_LENGTH = 2;
const MIN_ZOOM = 6, MAX_ZOOM = 400;

/** An item that is a moment, drawn as a mark and not as a bar. A sound with no length of its own lasts as its file does. */
export const isMoment = (track: Track, item: Item): boolean => track.kind !== "audio" && item.d === 0;

/** Moments of what kind cannot be given a length. */
const momentOnly = (track: Track, item: any): boolean =>
  track.kind === "camera" || track.kind === "mark" || (track.kind === "world" && item.do === "weather")
  || (track.kind === "actor" && ["place", "face", "show", "hide"].includes(item.do));

/** What an item is, in a few words on its bar. */
export function itemLabel(track: Track, item: any): string {
  switch (track.kind) {
    case "camera": return item.follow ? `Follow, zoom ${item.zoom}` : `Shot, zoom ${item.zoom}`;
    case "shake": return `Shake ${item.strength}`;
    case "screen": return item.effect.charAt(0).toUpperCase() + item.effect.slice(1);
    case "text": return item.text || `(${item.style})`;
    case "audio": return item.sound || "(no sound)";
    case "mark": return item.name;
    case "world":
      if (item.do === "weather") return item.weather || "(no weather)";
      if (item.do === "time") return `${item.from}:00 to ${item.to}:00`;
      return item.particle || "(no particles)";
    case "actor":
      if (item.do === "say") return item.text ? `"${item.text}"` : "say";
      if (item.do === "animate") return item.animation;
      if (item.do === "move") return `move, ${item.path.length} ${item.path.length === 1 ? "stop" : "stops"}`;
      return item.do;
  }
}

/** The seconds between the ruler's marks at this zoom, and between the places a drag lands. */
function stepsFor(pps: number): { major: number; snap: number } {
  for (const major of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) {
    if (major * pps >= 64) return { major, snap: major <= 1 ? major / 10 : major / 5 };
  }
  return { major: 300, snap: 30 };
}

const second = (t: number): string => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m}:${String(Math.floor(s)).padStart(2, "0")}` : Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
};

export class Timeline {
  readonly root = el("div", "cs-timeline");
  /** What is picked, in the order it was picked. */
  picks: Picked[] = [];

  private scroller = el("div", "cs-scroll");
  private rows = el("div", "cs-rows");
  private ruler = el("div", "cs-ruler");
  private playhead = el("div", "cs-playhead");
  private pps = 40;
  private fitted: string | null = null;
  private time = 0;

  constructor(private host: TimelineHost) {
    this.scroller.append(this.rows);
    this.rows.addEventListener("pointerdown", (e) => this.pressEmpty(e, this.rows));
    this.root.appendChild(this.scroller);
    this.scroller.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const box = this.scroller.getBoundingClientRect();
      const x = e.clientX - box.left - HEAD_WIDTH;
      this.zoomTo(this.pps * Math.exp(-e.deltaY * 0.002), x);
    }, { passive: false });
    window.addEventListener("resize", () => { if (this.fitted) this.fit(); });
  }

  /** Fits the scene's length to the window, once for each scene unless asked again. */
  fit(key?: string): void {
    const doc = this.host.doc();
    if (!doc) return;
    if (key !== undefined && key === this.fitted) return;
    this.fitted = key ?? this.fitted;
    const room = Math.max(120, this.scroller.clientWidth - HEAD_WIDTH - 24);
    this.pps = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, room / doc.duration));
    this.render();
  }

  /** Zooms in or out by this many steps, keeping the playhead in place. */
  zoomBy(direction: number): void {
    this.zoomTo(this.pps * 1.4 ** direction, this.time * this.pps - this.scroller.scrollLeft);
  }

  private zoomTo(pps: number, aboutX: number): void {
    const at = (this.scroller.scrollLeft + aboutX) / this.pps;
    this.pps = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pps));
    this.render();
    this.scroller.scrollLeft = at * this.pps - aboutX;
  }

  isPicked(track: string, item: string): boolean {
    return this.picks.some((p) => p.track === track && p.item === item);
  }

  pick(picks: Picked[]): void {
    this.picks = picks;
    this.render();
    this.host.picked();
  }

  /** The items picked, with their tracks. Those that have gone (undone, deleted) are left out. */
  pickedItems(): Array<{ track: Track; item: Item }> {
    const doc = this.host.doc();
    const found: Array<{ track: Track; item: Item }> = [];
    for (const p of this.picks) {
      const track = doc?.tracks.find((t) => t.id === p.track);
      const item = (track?.items as Item[] | undefined)?.find((i) => i.id === p.item);
      if (track && item) found.push({ track, item });
    }
    return found;
  }

  setTime(t: number): void {
    this.time = t;
    this.playhead.style.left = `${HEAD_WIDTH + t * this.pps}px`;
    // While playing, the page turns as the playhead reaches its edge.
    const x = t * this.pps, left = this.scroller.scrollLeft, room = this.scroller.clientWidth - HEAD_WIDTH;
    if (x < left || x > left + room - 8) this.scroller.scrollLeft = Math.max(0, x - room * 0.1);
  }

  render(): void {
    const doc = this.host.doc();
    if (!doc) return;
    this.rows.replaceChildren(this.buildRuler(doc), ...doc.tracks.map((track) => this.buildRow(doc, track)), this.playhead);
    this.rows.style.width = `${HEAD_WIDTH + doc.duration * this.pps + 24}px`;
    this.playhead.style.left = `${HEAD_WIDTH + this.time * this.pps}px`;
  }

  private buildRuler(doc: CutsceneDoc): HTMLElement {
    const row = el("div", "cs-row cs-row-ruler");
    const corner = el("div", "cs-head cs-head-ruler");
    this.ruler.replaceChildren();
    const { major } = stepsFor(this.pps);
    for (let t = 0; t <= doc.duration + 1e-6; t += major) {
      const tick = el("span", "cs-tick", second(Math.round(t * 100) / 100));
      tick.style.left = `${t * this.pps}px`;
      this.ruler.appendChild(tick);
    }
    this.ruler.onpointerdown = (e) => this.scrub(e);
    this.ruler.title = "Drag to move through the scene";
    row.append(corner, this.ruler);
    return row;
  }

  private scrub(start: PointerEvent): void {
    const doc = this.host.doc();
    if (!doc) return;
    const box = this.ruler.getBoundingClientRect();
    const seekTo = (x: number) => this.host.seek(Math.max(0, Math.min(doc.duration, (x - box.left) / this.pps)));
    seekTo(start.clientX);
    follow(start, (e) => seekTo(e.clientX));
  }

  private pressEmpty(e: PointerEvent, space: HTMLElement): void {
    if (e.target !== space) return;
    // Picking draws the rows again, so only when there is something to clear: otherwise each press of a double click
    // replaces the lane, and the browser never sends the double click.
    if (!e.ctrlKey && !e.shiftKey && this.picks.length) this.pick([]);
  }

  private buildRow(doc: CutsceneDoc, track: Track): HTMLElement {
    const row = el("div", "cs-row");
    row.dataset.kind = track.kind;
    if (track.muted) row.classList.add("is-muted");

    const head = el("div", "cs-head");
    head.appendChild(icon(TRACK_ICONS[track.kind], 14));
    head.appendChild(el("span", "cs-head-label", track.label));
    head.title = track.label;
    const toggle = iconButton(track.muted ? "eyeOff" : "eye", track.muted ? "Turn the track on" : "Turn the track off", () => {
      track.muted = !track.muted;
      if (!track.muted) delete track.muted;
      this.host.changed(true);
      this.render();
    }, { size: 13 });
    const more = iconButton("more", "Track menu", () => this.host.trackMenu(track, more), { size: 13 });
    const add = iconButton("plus", "Add at the playhead", () => this.host.add(track, this.time, add), { size: 13 });
    head.append(add, toggle, more);

    const lane = el("div", "cs-lane");
    lane.addEventListener("pointerdown", (e) => this.pressEmpty(e, lane));
    lane.addEventListener("dblclick", (e) => {
      if (e.target !== lane) return;
      const box = lane.getBoundingClientRect();
      this.host.add(track, Math.max(0, Math.min(doc.duration, (e.clientX - box.left) / this.pps)), lane);
    });
    if (!track.items.length) lane.appendChild(el("span", "cs-lane-hint", `Double-click to add ${EMPTY_ROWS[track.kind]}`));
    for (const item of track.items as Item[]) lane.appendChild(this.buildItem(doc, track, item));
    row.append(head, lane);
    return row;
  }

  private buildItem(doc: CutsceneDoc, track: Track, item: Item): HTMLElement {
    const moment = isMoment(track, item);
    const box = el("div", moment ? "cs-key" : "cs-item");
    const label = itemLabel(track, item);
    // A moment at the very start stays whole, not half under the row's head: most scenes open on one.
    box.style.left = `${moment ? Math.max(KEY_HALF, item.t * this.pps) : item.t * this.pps}px`;
    box.title = `${label} at ${item.t.toFixed(2)}s`;
    if (this.isPicked(track.id, item.id)) box.classList.add("is-picked");
    if (this.host.wrong(track, item)) box.classList.add("is-wrong");
    if (moment) {
      box.appendChild(el("span", "cs-key-label", label));
    } else {
      const file = track.kind === "audio" && item.d === 0 ? this.host.fileLength((item as any).sound) : null;
      box.style.width = `${Math.max(4, (item.d || file || UNKNOWN_LENGTH) * this.pps)}px`;
      box.appendChild(el("span", "cs-item-label", label));
      if (!momentOnly(track, item)) {
        const start = el("span", "cs-edge cs-edge-start"), end = el("span", "cs-edge cs-edge-end");
        start.addEventListener("pointerdown", (e) => this.dragEdge(e, doc, track, item, "start"));
        end.addEventListener("pointerdown", (e) => this.dragEdge(e, doc, track, item, "end"));
        box.append(start, end);
      }
    }
    box.addEventListener("pointerdown", (e) => this.pressItem(e, doc, track, item));
    return box;
  }

  private pressItem(e: PointerEvent, doc: CutsceneDoc, track: Track, item: Item): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const held = this.isPicked(track.id, item.id);
    if (e.ctrlKey || e.shiftKey) {
      this.pick(held ? this.picks.filter((p) => !(p.track === track.id && p.item === item.id)) : [...this.picks, { track: track.id, item: item.id }]);
      return;
    }
    if (!held) this.pick([{ track: track.id, item: item.id }]);
    const moving = this.pickedItems();
    const from = moving.map((m) => m.item.t);
    const earliest = Math.min(...from);
    const latest = Math.max(...moving.map((m) => m.item.t + m.item.d));
    const ignore = new Set(moving.map((m) => m.item));
    const grabbedAt = item.t;
    let moved = false;
    follow(e, (move) => {
      const landed = this.snapped(doc, grabbedAt + (move.clientX - e.clientX) / this.pps, ignore, move.altKey);
      const shift = Math.max(-earliest, Math.min(doc.duration - latest, landed - grabbedAt));
      moving.forEach((m, i) => { m.item.t = round(from[i]! + shift); });
      moved = true;
      this.host.changed(false);
      this.render();
    }, () => { if (moved) this.host.changed(true); });
  }

  private dragEdge(e: PointerEvent, doc: CutsceneDoc, track: Track, item: Item, edge: "start" | "end"): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!this.isPicked(track.id, item.id)) this.pick([{ track: track.id, item: item.id }]);
    const fromT = item.t, fromEnd = item.t + item.d;
    const ignore = new Set([item]);
    let moved = false;
    follow(e, (move) => {
      const shift = (move.clientX - e.clientX) / this.pps;
      if (edge === "end") {
        const end = Math.max(fromT + 0.05, Math.min(doc.duration, this.snapped(doc, fromEnd + shift, ignore, move.altKey)));
        item.d = round(end - fromT);
      } else {
        const start = Math.max(0, Math.min(fromEnd - 0.05, this.snapped(doc, fromT + shift, ignore, move.altKey)));
        item.t = round(start);
        item.d = round(fromEnd - start);
      }
      moved = true;
      this.host.changed(false);
      this.render();
    }, () => { if (moved) this.host.changed(true); });
  }

  /** Where a dragged time lands: on the playhead or the edge of another item when near one, otherwise on the grid. Alt lets it go anywhere. */
  private snapped(doc: CutsceneDoc, t: number, ignore: Set<Item>, free: boolean): number {
    if (free) return t;
    let best = t, gap = SNAP_PX / this.pps;
    const offer = (v: number) => {
      const g = Math.abs(v - t);
      if (g < gap) { gap = g; best = v; }
    };
    offer(this.time);
    offer(0);
    offer(doc.duration);
    for (const track of doc.tracks) {
      for (const other of track.items as Item[]) {
        if (ignore.has(other)) continue;
        offer(other.t);
        offer(other.t + other.d);
      }
    }
    if (best !== t) return best;
    const { snap } = stepsFor(this.pps);
    return Math.round(t / snap) * snap;
  }
}

const round = (t: number): number => Math.round(t * 1000) / 1000;

/** Follows the pointer until it is let go. */
function follow(start: PointerEvent, onMove: (e: PointerEvent) => void, onEnd?: () => void): void {
  start.preventDefault();
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

export interface MenuEntry { label: string; icon?: IconName; danger?: boolean; off?: boolean; onPick(): void }

/** A short list of choices under a button, gone once one is made or the pointer goes elsewhere. */
export function popMenu(anchor: HTMLElement, entries: MenuEntry[]): void {
  document.querySelector(".cs-menu")?.remove();
  const menu = el("div", "cs-menu");
  menu.setAttribute("role", "menu");
  const close = () => {
    menu.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", key, true);
  };
  const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  for (const entry of entries) {
    const line = el("button", "cs-menu-line" + (entry.danger ? " is-danger" : ""));
    line.type = "button";
    line.disabled = !!entry.off;
    line.setAttribute("role", "menuitem");
    if (entry.icon) line.appendChild(icon(entry.icon, 14));
    line.appendChild(el("span", "", entry.label));
    line.addEventListener("click", () => {
      close();
      entry.onPick();
    });
    menu.appendChild(line);
  }
  document.body.appendChild(menu);
  const box = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(window.innerWidth - size.width - 4, box.left))}px`;
  menu.style.top = `${box.bottom + size.height + 4 > window.innerHeight ? Math.max(4, box.top - size.height - 4) : box.bottom + 4}px`;
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", key, true);
  (menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
}
