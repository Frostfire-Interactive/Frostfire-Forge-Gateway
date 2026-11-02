// Cutscene editor popup (/cutscene-editor). Holds the document being worked on and talks to the game window over
// postMessage. The game window forwards the requests to the server (engine src/systems/cutscenes.ts), which checks every
// field and saves, and it shows the scene in the game (cutsceneeditor.ts): each change here is sent to it, and a mark
// dragged about over there comes back here as a change. The window itself is the shared workbench (tooleditor.ts).
//
// A record is one scene: a timeline of tracks, the actors in it, how it is presented, what starts it. There are few
// scenes, so the list is searched here, at every key. Every edit is one step of undo, kept as a copy of the whole scene.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, inAnimationsFolder, setFieldError, sheetOptions, type AssetOption, type Field, type Option } from "./toolfields.js";
import { askText, button, card, confirmDialog, count, el, icon, iconButton, note, noticeDialog, segments, setIcon, shown, subcard, tag, thumb, toast, tooltip } from "./toolkit.js";
import { defaultSettings, emptyDoc, type Actor, type CutsceneDoc, type Item, type Look, type PlaceRef, type Track, type Trigger } from "./cutscenedoc.js";
import { ACTOR_ACTIONS, DIRECTIONS, PERCENT, WORLD_ACTIONS, blankItem, itemAbout, itemFields, itemIds, itemTitle, lookLine, nextId, tidyItem, type Limits, type SceneLists } from "./cutsceneinspector.js";
import { Timeline, TRACK_ICONS, popMenu, type MenuEntry, type Picked } from "./cutscenetimeline.js";
import type { CaptureOptions, CaptureState } from "./cutscenecapture.js";

type Stored = CutsceneDoc & { updatedBy?: string | null; updatedAt?: number };
type Sheet = { name: string; image: string | null };
interface EditorData extends SceneLists { cutscenes: Stored[]; spriteSheets: Record<string, Sheet[]>; icons: Sheet[]; limits: Limits }
type Tab = "timeline" | "actors" | "settings" | "triggers" | "capture";
type View = "scene" | "free" | "game";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "timeline", label: "Timeline" }, { id: "actors", label: "Actors" }, { id: "settings", label: "Settings" },
  { id: "triggers", label: "When it plays" }, { id: "capture", label: "Record video" },
];

/** What the game window can show while a scene is worked on. */
const VIEWS: Array<{ id: View; label: string; tip: string }> = [
  { id: "free", label: "Free camera", tip: "Fly around the world yourself, with the camera path, actors and places drawn so you can drag them" },
  { id: "scene", label: "Player's view", tip: "The scene as a player sees it, stopped at the playhead" },
  { id: "game", label: "Normal game", tip: "The game as usual, with the scene out of the way" },
];

const GUIDE_PAGE = "/docs#/tools/cutscene-editor";
const SHORTCUTS = [
  "Space: play or pause",
  "Home: back to the start",
  "Left and Right: move what is picked a little, or the playhead when nothing is picked. Hold Shift for larger steps",
  "Delete: delete what is picked",
  "Ctrl+D: duplicate",
  "Ctrl+C and Ctrl+V: copy, and paste at the playhead",
  "Ctrl+Z and Ctrl+Y: undo and redo",
  "Ctrl and the mouse wheel over the timeline: zoom it",
];

const NAME_RULE = /^[A-Za-z0-9 _-]+$/;
const SLOTS = ["body", "head", "helmet", "shoulderguards", "neck", "hands", "chest", "feet", "legs", "weapon"] as const;
/** What is worn over the body and head, in the NPC editor's words. */
const WORN: Array<{ slot: (typeof SLOTS)[number]; label: string }> = [
  { slot: "helmet", label: "Helmet" }, { slot: "shoulderguards", label: "Shoulders" }, { slot: "neck", label: "Neck" }, { slot: "hands", label: "Gloves" },
  { slot: "chest", label: "Chest" }, { slot: "feet", label: "Boots" }, { slot: "legs", label: "Pants" }, { slot: "weapon", label: "Weapon" },
];
const DRAWN_AS: Option[] = [{ value: "animated", label: "Animated" }, { value: "static", label: "Still image" }];
const DRAWN_HOW: Record<string, string> = {
  animated: "Drawn from sprite sheets, one over the other, as a player is.",
  static: "Drawn as one still image.",
};
const KIND_LABELS: Record<Track["kind"], string> = {
  camera: "Camera", shake: "Camera shake", screen: "Screen effect", text: "Text", actor: "Actor", audio: "Sound", world: "World", mark: "Marks",
};
const TRIGGER_KINDS: Option[] = [
  { value: "area", label: "Walks into an area" }, { value: "map", label: "Arrives on the map" }, { value: "login", label: "Logs in on the map" },
  { value: "quest_accept", label: "Accepts a quest" }, { value: "quest_complete", label: "Finishes a quest" }, { value: "npc", label: "Talks to an NPC" },
];
const RESOLUTIONS: Option[] = [
  { value: "1280x720", label: "720p (1280 by 720)" }, { value: "1920x1080", label: "1080p (1920 by 1080)" }, { value: "2560x1440", label: "1440p (2560 by 1440)" },
  { value: "3840x2160", label: "4K (3840 by 2160)" }, { value: "1080x1080", label: "Square (1080 by 1080)" }, { value: "1080x1920", label: "Vertical (1080 by 1920)" },
];

const UNDO_MAX = 100;
/** Changes go to the game window this often at most. */
const SEND_MS = 45;
/** Typing in a field counts as one step of undo until it stops for this long. */
const MARK_MS = 600;
const SAVE_WAIT_MS = 15000;

const lower = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const round = (t: number): number => Math.round(t * 1000) / 1000;
const docOf = (s: Stored): CutsceneDoc => clone({
  name: s.name, description: s.description, map: s.map, duration: s.duration, settings: s.settings,
  actors: s.actors, tracks: s.tracks, triggers: s.triggers, end: s.end,
});

/** m:ss.cc */
function clockText(t: number): string {
  const whole = Math.max(0, t), m = Math.floor(whole / 60), s = whole - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** The tab a field of the document is edited on. */
function tabOf(path: string): Tab {
  if (path.startsWith("tracks")) return "timeline";
  if (path.startsWith("actors")) return "actors";
  if (path.startsWith("triggers")) return "triggers";
  return "settings";
}

/** Numbers left empty in a form take what a new one starts with. */
function tidyNumbers(target: any, blank: Record<string, unknown>): void {
  for (const key of Object.keys(blank)) {
    if (typeof blank[key] === "number" && !Number.isFinite(target[key])) target[key] = blank[key];
  }
}

class CutsceneEditorBridge {
  private data: EditorData = {
    cutscenes: [], npcs: [], weathers: [], particles: [], sounds: [], quests: [], maps: [], spriteSheets: {}, icons: [],
    limits: {
      nameMax: 64, descriptionMax: 500, durationMin: 0.5, durationMax: 600, letterboxSizeMax: 0.25, fadeMax: 10, actorsMax: 32, tracksMax: 64, triggersMax: 16,
      itemsPerTrackMax: 500, textMax: 500, subMax: 200, speakerMax: 64, sayMax: 200, markNameMax: 64, actorNameMax: 64, labelMax: 64, layerNameMax: 128,
      pathPointsMax: 64, minLevelMax: 1000,
    },
  };
  private ready = false;
  private draft: CutsceneDoc | null = null;
  /** Name of the scene being edited, or null for a new one. A saved scene keeps its name. */
  private originalName: string | null = null;
  private opened = 0;
  private dirty = false;
  /** The scene as it was last saved: undoing back to this leaves nothing to save. */
  private saved: string | null = null;
  private refused = false;
  private query = "";
  private tab: Tab = "timeline";
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private past: string[] = [];
  private future: string[] = [];
  /** The scene as of the last step of undo. */
  private last = "";
  private markTimer: ReturnType<typeof setTimeout> | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private clipboard: Array<{ track: string; kind: Track["kind"]; item: any }> = [];

  // How things stand in the game window.
  private here = { x: 0, y: 0, zoom: 1, map: "" };
  private time = 0;
  private playing = false;
  private live = false;
  private view: View = "free";
  /** Where to go back to when the scene stops: it plays in Player's view, whichever view it was started from. */
  private viewToRestore: View | null = null;
  private lengths = new Map<string, number>();
  /** The scene has been played through at least once since it was opened, or was already saved. */
  private watched = false;

  private openActors = new Set<string>();
  private openTriggers = new Set<string>();
  private take: CaptureOptions = { mode: "composite", source: "preview", format: "mp4", width: 1920, height: 1080, fps: 60, bitrate: 12, sound: true, from: 0, to: null };
  private captureState: CaptureState = { state: "idle", seconds: 0 };
  private silentTake = false;
  private captureLine = el("div", "cs-capture-state");
  private recordButton: HTMLButtonElement | null = null;
  private stopButton: HTMLButtonElement | null = null;

  private shell = new EditorShell({
    tool: "Cutscene Editor", noun: "cutscene", icon: "play", liveSearch: true, tabs: TABS,
    onSearch: (query) => { this.query = query; this.renderList(); },
    onNew: () => void this.startNew(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicateScene(),
    onDelete: () => void this.deleteScene(),
    onTab: (id) => { this.tab = id as Tab; this.render(); },
  });

  private fields = new FieldRenderer({
    assetOptions: (field, value) => sheetOptions(this.data.spriteSheets, field.slot || "other", String(value ?? "")).filter((option) => !inAnimationsFolder(option)),
    rerender: () => this.redrawForm(),
  });

  private timeline = new Timeline({
    doc: () => this.draft,
    changed: (done) => this.edited(done),
    seek: (t) => this.seek(t),
    picked: () => this.picksChanged(),
    add: (track, t, anchor) => this.addItem(track, t, anchor),
    trackMenu: (track, anchor) => this.trackMenu(track, anchor),
    fileLength: (sound) => this.lengths.get(sound) ?? null,
    wrong: (track, item) => this.itemWrong(track, item),
  });

  private playButton = iconButton("play", "Play (Space)", () => this.togglePlay(), { size: 18 });
  private timeText = el("span", "cs-time", clockText(0));
  private lengthInput = el("input", "tl-input cs-length");
  private viewSlot = el("div", "cs-view");
  private transport = this.buildTransport();
  private inspector = el("aside", "cs-inspector");
  /** What the page shows, while it stays the same the timeline stays where it is. */
  private pageKey: string | null = null;

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  private askForList(): void {
    this.shell.send({ type: "request", packet: "CUTSCENE_EDITOR_LIST", data: {} });
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "data":
        this.adopt(msg.data);
        this.renderList();
        this.render();
        break;
      case "result": {
        const mine = !!this.pending && msg.action === this.pending.packet;
        if (!mine) return;
        const kind = this.pending!.kind;
        this.endRequest();
        if (kind === "save") this.onSaveResult(msg);
        else this.onDeleteResult(msg);
        this.renderList();
        break;
      }
      case "updated":
        toast(`${shown(msg.by)} changed the cutscenes. The list shows them as they are now.`);
        this.askForList();
        break;
      case "here": {
        const moved = msg.map !== this.here.map;
        this.here = { x: msg.x, y: msg.y, zoom: msg.zoom, map: msg.map };
        if (moved) this.banner();
        break;
      }
      case "clock":
        // The scrubbing here says where the clock is, unless the scene is running on its own.
        if (msg.playing || this.playing) this.showTime(msg.t);
        if (msg.playing !== this.playing) this.playingChanged(msg.playing);
        break;
      case "lengths":
        for (const sound of Object.keys(msg.lengths ?? {})) this.lengths.set(sound, msg.lengths[sound]);
        if (this.tab === "timeline") this.timeline.render();
        break;
      case "live":
        this.live = !!msg.on;
        this.banner();
        break;
      case "view":
        this.view = msg.mode;
        this.drawView();
        break;
      case "moved": this.onMoved(msg.ref, msg.place, !!msg.done); break;
      case "movedDone":
        this.mark();
        this.chrome();
        this.renderList();
        this.redrawForm();
        break;
      case "select":
        this.tab = "timeline";
        this.timeline.picks = [{ track: msg.track, item: msg.item }];
        this.sendPicks();
        this.render();
        break;
      case "capture":
        this.captureState = msg;
        this.drawCaptureState();
        break;
    }
  }

  private adopt(data: any): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data, limits: { ...this.data.limits, ...data.limits } };
    if (!Array.isArray(this.data.cutscenes)) this.data.cutscenes = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.cutscenes.length);
    // The open scene as the server now has it, unless it has changes of its own.
    if (!this.draft || this.dirty || this.pending || this.originalName === null) return;
    const now = this.find(this.originalName);
    if (!now) {
      this.closeScene();
      return;
    }
    const fresh = docOf(now);
    if (JSON.stringify(fresh) === this.last) return;
    this.draft = fresh;
    this.last = JSON.stringify(fresh);
    this.saved = this.last;
    this.sendSceneNow();
  }

  private find(name: string | null): Stored | undefined {
    return name === null ? undefined : this.data.cutscenes.find((s) => lower(s.name) === lower(name));
  }

  private onSaveResult(msg: any): void {
    if (!msg.ok) {
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      const first = Object.keys(this.fieldErrors)[0];
      if (first) {
        this.tab = tabOf(first);
        const at = /^tracks\.(\d+)\.items\.(\d+)/.exec(first);
        const track = at ? this.draft?.tracks[Number(at[1])] : undefined;
        const item = at ? (track?.items as Item[] | undefined)?.[Number(at[2])] : undefined;
        if (track && item) {
          this.timeline.picks = [{ track: track.id, item: item.id }];
          this.sendPicks();
        }
      }
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      return;
    }
    this.dirty = false;
    this.saved = JSON.stringify(this.draft);
    this.refused = false;
    this.clearProblems();
    if (msg.name) this.originalName = String(msg.name);
    toast(`Saved ${this.originalName ?? "the cutscene"}.`);
    this.askForList();
    this.render();
  }

  private onDeleteResult(msg: any): void {
    if (!msg.ok) {
      void noticeDialog("The cutscene was not deleted", msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
      this.render();
      return;
    }
    this.closeScene();
    this.clearProblems();
    toast(`Deleted ${msg.name ?? "the cutscene"}.`);
    this.askForList();
    this.render();
  }

  // ------------------------------------------------------------------ rules

  private nameProblem(name: string): string | null {
    if (!NAME_RULE.test(name)) return "A name is letters, numbers, spaces, - and _.";
    if (name.length > this.data.limits.nameMax) return `A name is ${this.data.limits.nameMax} characters at most.`;
    if (this.find(name)) return `There is already a cutscene called ${name}.`;
    return null;
  }

  /** The server's checks of what is typed here, run here first. The server runs them all and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!, l = this.data.limits;
    if (this.originalName === null) {
      const wrong = this.nameProblem(d.name.trim());
      if (wrong) errors["name"] = wrong;
    }
    if (!d.map) errors["map"] = "Pick the map it plays on.";
    if (!(d.duration >= l.durationMin && d.duration <= l.durationMax)) errors["duration"] = `A scene lasts between ${l.durationMin} and ${l.durationMax} seconds.`;
    return errors;
  }

  private problemLines(): string[] {
    const wrong = Object.keys(this.fieldErrors).length;
    return wrong > 0 ? [`${count(wrong, "field needs", "fields need")} fixing.`, ...this.otherProblems] : this.otherProblems;
  }

  private clearProblems(): void {
    this.fieldErrors = {};
    this.otherProblems = [];
    this.shell.setProblems([]);
  }

  private showProblems(serverErrors: string[] = []): void {
    this.otherProblems = serverErrors;
    this.pageKey = null;
    this.render();
    this.shell.setProblems(this.problemLines());
  }

  private itemWrong(track: Track, item: Item): boolean {
    const d = this.draft;
    if (!d) return false;
    const base = `tracks.${d.tracks.indexOf(track)}.items.${(track.items as Item[]).indexOf(item)}`;
    return Object.keys(this.fieldErrors).some((path) => path === base || path.startsWith(`${base}.`));
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const rows: ListRow[] = [];
    // A scene that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.originalName === null) {
      rows.push({
        id: "\u0000new", name: this.draft.name.trim() || "New cutscene", note: "Not saved yet", selected: true,
        thumb: thumb(null, { fallback: "play" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const s of this.data.cutscenes.filter((s) => !this.query || lower(s.name).includes(lower(this.query)))) {
      rows.push({
        id: s.name, name: s.name, note: `${s.map}, ${s.duration}s`, selected: lower(s.name) === lower(this.originalName),
        thumb: thumb(null, { fallback: "play" }),
        tags: s.triggers.length ? [tag("Triggered", "", "bolt")] : [],
        onOpen: () => void this.select(s.name),
      });
    }
    this.shell.setList({
      rows,
      empty: this.query
        ? { icon: "search", title: "No cutscene has that name", text: "Check the spelling." }
        : { title: "No cutscenes yet", text: "New adds one." },
      foot: "A scene plays by what is set under When it plays, or with /cutscene play.",
    });
  }

  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      return;
    }
    shell.setRecord({ title: d.name.trim() || "New cutscene", note: `Cutscene on ${d.map || "no map yet"}`, thumb: thumb(null, { size: "lg", fallback: "play" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending?.kind === "delete" ? "deleting" : this.refused ? "error" : this.originalName === null ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    const undo = iconButton("undo", "Undo (Ctrl+Z)", () => this.undo());
    const redo = iconButton("redo", "Redo (Ctrl+Y)", () => this.redo());
    undo.disabled = !this.past.length;
    redo.disabled = !this.future.length;
    shell.setActions({
      open: true, dirty: this.dirty || this.originalName === null,
      busy: this.pending ? this.pending.kind : null,
      canDuplicate: this.originalName !== null,
      canDelete: this.originalName !== null,
      why: { delete: "It is not saved yet", duplicate: "It is not saved yet" },
      deleteTip: "Delete the cutscene",
      extra: [undo, redo],
    });
  }

  private banner(): void {
    const d = this.draft;
    if (this.live) {
      this.shell.setBanner({ tone: "info", icon: "play", text: "A saved scene is playing in the game. The preview comes back when it ends." });
    } else if (d && this.here.map && lower(this.here.map) !== lower(d.map)) {
      this.shell.setBanner({ tone: "warning", icon: "map", text: `This scene plays on ${d.map}, and you are on ${this.here.map}.`, action: { label: "Go there", onClick: () => this.goThere() } });
    } else {
      this.shell.setBanner(null);
    }
  }

  private goThere(): void {
    const d = this.draft;
    if (!d) return;
    const key = d.tracks.flatMap((t) => (t.kind === "camera" ? t.items : [])).find((k) => !k.follow);
    const spot = key ?? d.actors[0] ?? { x: 0, y: 0 };
    this.shell.send({ type: "request", packet: "CUTSCENE_EDITOR_GOTO", data: { map: d.map, x: spot.x, y: spot.y } });
  }

  private drawTabs(): void {
    const d = this.draft;
    if (!d) {
      this.shell.setTabs(null);
      return;
    }
    const problems: Record<string, number> = {};
    for (const path of Object.keys(this.fieldErrors)) {
      const tab = tabOf(path);
      problems[tab] = (problems[tab] ?? 0) + 1;
    }
    this.shell.setTabs(this.tab, problems, { actors: d.actors.length, triggers: d.triggers.length });
  }

  private render(): void {
    this.chrome();
    if (!this.ready) return;
    const d = this.draft;
    const page = document.getElementById("tl-page");
    const wide = !!d && this.tab === "timeline";
    page?.classList.toggle("tl-page-fill", wide);
    page?.classList.toggle("cs-wide", wide);
    this.drawTabs();
    this.banner();
    if (!d) {
      this.pageKey = null;
      const box = this.shell.idle("Pick a cutscene from the list on the left, or add one.", this.data.cutscenes.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New cutscene", () => void this.startNew(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const key = `${this.opened}:${this.tab}`;
    switch (this.tab) {
      case "timeline": this.renderTimeline(key); break;
      case "actors": this.renderActors(key); break;
      case "settings": this.renderSettings(key); break;
      case "triggers": this.renderTriggers(key); break;
      case "capture": this.renderCapture(key); break;
    }
  }

  /** Draws the form again, keeping the timeline where it is. */
  private redrawForm(): void {
    if (this.tab === "timeline") this.renderInspector();
    else this.render();
  }

  private field(target: any, base: string, field: Field, after?: () => void): HTMLElement {
    const path = base ? `${base}.${field.key}` : field.key;
    const wrap = this.fields.renderField({ ...field, path }, target, () => {
      after?.();
      this.touched(path, wrap);
    }, { error: this.fieldErrors[path] });
    return wrap;
  }

  /** A fraction in the scene, a percentage in the form. A box left empty is null, for `after` to fill in. */
  private percentField(target: any, base: string, field: Field, after?: () => void): HTMLElement {
    const shown: Record<string, number | null> = { [field.key]: Math.round(target[field.key] * 100) };
    return this.field(shown, base, { ...field, unit: PERCENT }, () => {
      const value = shown[field.key];
      target[field.key] = typeof value === "number" ? value / 100 : null;
      after?.();
    });
  }

  private touched(path: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.sendScene();
    if (this.tab === "timeline") this.timeline.render();
    this.drawTabs();
    this.chrome();
    this.renderList();
    if (this.markTimer) clearTimeout(this.markTimer);
    this.markTimer = setTimeout(() => this.mark(), MARK_MS);
  }

  // ---------------------------------------------------------------- the scene

  private sendScene(): void {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.sendSceneNow();
    }, SEND_MS);
  }

  private sendSceneNow(): void {
    this.shell.send({ type: "scene", doc: this.draft });
  }

  private sendPicks(): void {
    this.shell.send({ type: "picks", picks: this.timeline.picks });
  }

  /** A step of undo: the scene as it now is, if it has changed. */
  private mark(): void {
    if (this.markTimer) clearTimeout(this.markTimer);
    this.markTimer = null;
    const now = JSON.stringify(this.draft);
    if (now === this.last) return;
    this.past.push(this.last);
    if (this.past.length > UNDO_MAX) this.past.shift();
    this.future = [];
    this.last = now;
  }

  private restore(snapshot: string): void {
    this.last = snapshot;
    this.draft = JSON.parse(snapshot);
    this.dirty = snapshot !== this.saved;
    this.refused = false;
    this.clearProblems();
    this.sendSceneNow();
    this.renderList();
    this.render();
  }

  private undo(): void {
    this.mark();
    const before = this.past.pop();
    if (!before) return;
    this.future.push(this.last);
    this.restore(before);
  }

  private redo(): void {
    this.mark();
    const after = this.future.pop();
    if (!after) return;
    this.past.push(this.last);
    this.restore(after);
  }

  /** The timeline changed something. */
  private edited(done: boolean): void {
    this.dirty = true;
    this.refused = false;
    this.sendScene();
    if (!done) return;
    this.mark();
    this.chrome();
    this.renderList();
    this.renderInspector();
  }

  /** Something was added or taken away: the server's words about what is where no longer fit. */
  private rebuilt(): void {
    this.dirty = true;
    this.refused = false;
    this.fieldErrors = {};
    this.otherProblems = [];
    this.shell.setProblems([]);
    this.mark();
    this.sendScene();
    this.renderList();
    this.render();
  }

  private seek(t: number): void {
    this.showTime(t);
    this.shell.send({ type: "seek", t });
  }

  private showTime(t: number): void {
    this.time = t;
    this.timeline.setTime(t);
    this.timeText.textContent = clockText(t);
  }

  private togglePlay(): void {
    if (this.playing) {
      this.shell.send({ type: "pause" });
      return;
    }
    if (this.draft && this.time >= this.draft.duration - 0.01) this.seek(0);
    // Free camera leaves out the text and the camera's moves, and Normal game has no scene up at all.
    const from = this.view;
    if (from !== "scene") this.setView("scene");
    this.viewToRestore = from === "scene" ? null : from;
    this.shell.send({ type: "play" });
    if (this.watched) return;
    this.watched = true;
    this.renderInspector();
  }

  private playingChanged(playing: boolean): void {
    this.playing = playing;
    const label = playing ? "Pause (Space)" : "Play (Space)";
    setIcon(this.playButton, playing ? "pause" : "play", 18);
    this.playButton.setAttribute("aria-label", label);
    tooltip(this.playButton, label);
    if (!playing && this.viewToRestore) this.setView(this.viewToRestore);
  }

  private picksChanged(): void {
    this.sendPicks();
    this.renderInspector();
  }

  private setView(mode: View): void {
    this.view = mode;
    this.viewToRestore = null;
    this.shell.send({ type: "view", mode });
    this.drawView();
  }

  private drawView(): void {
    const choices = segments<View>(VIEWS.map((v) => [v.id, v.label]), this.view, (mode) => this.setView(mode), "Game window shows");
    for (const option of VIEWS) {
      const choice = choices.querySelector<HTMLElement>(`[data-value="${option.id}"]`);
      if (choice) tooltip(choice, option.tip);
    }
    this.viewSlot.replaceChildren(choices);
  }

  private place(ref: PlaceRef): void {
    this.shell.send({ type: "pick", ref });
    toast("Now click the spot in the game window. Esc cancels.");
  }

  private onMoved(ref: PlaceRef, place: { x: number; y: number; w?: number; h?: number }, done: boolean): void {
    const d = this.draft;
    if (!d) return;
    const track = "track" in ref ? d.tracks.find((t) => t.id === ref.track) : undefined;
    const item: any = "track" in ref ? (track?.items as Item[] | undefined)?.find((i) => i.id === ref.item) : undefined;
    const trigger = ref.kind === "trigger" || ref.kind === "area" ? d.triggers.find((t) => t.id === ref.trigger) : undefined;
    switch (ref.kind) {
      case "key": case "place": case "particle":
        if (!item) return;
        item.x = place.x;
        item.y = place.y;
        break;
      case "point":
        if (!item?.path?.[ref.index]) return;
        item.path[ref.index] = { x: place.x, y: place.y };
        break;
      case "newPoint":
        if (!item?.path || item.path.length >= this.data.limits.pathPointsMax) return;
        item.path.push({ x: place.x, y: place.y });
        break;
      case "actor": {
        const actor = d.actors.find((a) => a.id === ref.actor);
        if (!actor) return;
        actor.x = place.x;
        actor.y = place.y;
        break;
      }
      case "teleport":
        if (!d.end.teleport) return;
        d.end.teleport.x = place.x;
        d.end.teleport.y = place.y;
        break;
      case "trigger":
        if (!trigger) return;
        if (ref.part === "move") {
          trigger.x = place.x;
          trigger.y = place.y;
        } else {
          trigger.w = Math.max(1, place.x - trigger.x);
          trigger.h = Math.max(1, place.y - trigger.y);
        }
        break;
      case "area":
        if (!trigger) return;
        trigger.x = place.x;
        trigger.y = place.y;
        trigger.w = Math.max(1, place.w ?? 1);
        trigger.h = Math.max(1, place.h ?? 1);
        break;
    }
    this.edited(false);
    if (!done) return;
    this.mark();
    this.chrome();
    this.renderList();
    this.redrawForm();
  }

  // --------------------------------------------------------------- the timeline

  private buildTransport(): HTMLElement {
    const bar = el("div", "cs-transport");
    const group = (...nodes: HTMLElement[]) => {
      const box = el("div", "cs-group");
      box.append(...nodes);
      return box;
    };
    this.lengthInput.type = "number";
    this.lengthInput.step = "0.5";
    this.lengthInput.title = "How long the scene lasts, in seconds";
    this.lengthInput.addEventListener("change", () => this.setLength(Number(this.lengthInput.value)));
    const add = button("Add", () => this.addMenu(add), { icon: "plus", small: true, kind: "primary", tip: "Add something to the scene at the playhead" });
    const help = iconButton("info", "How it works", () => this.helpMenu(help));
    bar.append(
      group(iconButton("back", "To the start (Home)", () => this.seek(0)), this.playButton, this.timeText),
      add,
      button("Add camera shot", () => this.keyAtCamera(), { icon: "image", small: true, tip: "Keeps what the game window's camera sees now as a shot at the playhead" }),
      el("span", "cs-spring"),
      button("Watch as a player", () => this.playSaved(), { icon: "user", small: true, tip: "Plays the saved scene to you the way a player gets it" }),
      help,
      el("span", "cs-break"),
      group(el("span", "cs-label", "Scene length"), this.lengthInput, el("span", "cs-label", "seconds")),
      group(
        el("span", "cs-label", "Zoom"),
        button("-", () => this.timeline.zoomBy(-1), { small: true, tip: "Show more of the scene" }),
        button("Fit", () => this.timeline.fit(), { small: true, tip: "Fit the whole scene in the window" }),
        button("+", () => this.timeline.zoomBy(1), { small: true, tip: "Show less of the scene, larger" }),
      ),
      group(el("span", "cs-label", "Game window shows"), this.viewSlot),
    );
    return bar;
  }

  private helpMenu(anchor: HTMLElement): void {
    popMenu(anchor, [
      { label: "Keyboard shortcuts", icon: "info", onPick: () => void confirmDialog({ title: "Keyboard shortcuts", body: SHORTCUTS, okLabel: "Close", notice: true, danger: false }) },
      { label: "Read the guide", icon: "book", onPick: () => void window.open(GUIDE_PAGE, "_blank", "noopener") },
    ]);
  }

  private setLength(value: number): void {
    const d = this.draft;
    if (!d) return;
    const l = this.data.limits;
    d.duration = Math.round(Math.max(l.durationMin, Math.min(l.durationMax, Number.isFinite(value) ? value : d.duration)) * 100) / 100;
    for (const track of d.tracks) {
      for (const item of track.items as Item[]) {
        item.t = Math.min(item.t, d.duration);
        item.d = round(Math.min(item.d, d.duration - item.t));
      }
    }
    this.rebuilt();
    this.timeline.fit();
  }

  private renderTimeline(key: string): void {
    const d = this.draft!;
    if (this.pageKey !== key) {
      const { main } = this.shell.page(key);
      main.classList.add("cs-work");
      const below = el("div", "cs-below");
      below.append(this.timeline.root, this.inspector);
      main.append(this.transport, below);
      this.pageKey = key;
      requestAnimationFrame(() => this.timeline.fit(String(this.opened)));
    }
    this.lengthInput.min = String(this.data.limits.durationMin);
    this.lengthInput.max = String(this.data.limits.durationMax);
    if (document.activeElement !== this.lengthInput) this.lengthInput.value = String(d.duration);
    this.drawView();
    this.timeline.render();
    this.renderInspector();
  }

  private renderInspector(): void {
    const d = this.draft, box = this.inspector;
    if (!d) return;
    const active = box.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-field]")?.dataset["field"] ?? null : null;
    box.replaceChildren();
    const picked = this.timeline.pickedItems();
    if (!picked.length) {
      this.nextSteps(box);
      return;
    }
    if (picked.length > 1) {
      box.appendChild(el("h3", "cs-inspector-title", `${picked.length} items picked`));
      box.appendChild(el("p", "cs-hint", "Drag one to move them all. Ctrl+D copies them, Delete removes them."));
      box.appendChild(button("Delete them", () => this.deletePicked(), { icon: "trash", small: true }));
      return;
    }
    const { track, item } = picked[0]!;
    const base = `tracks.${d.tracks.indexOf(track)}.items.${(track.items as Item[]).indexOf(item)}`;
    const head = el("div", "cs-inspector-head");
    head.append(
      el("h3", "cs-inspector-title", itemTitle(track, item)),
      iconButton("clock", "Move the playhead here", () => this.seek(item.t), { size: 14 }),
      iconButton("copy", "Duplicate (Ctrl+D)", () => this.duplicatePicked(), { size: 14 }),
      iconButton("trash", "Delete (Delete)", () => this.deletePicked(), { danger: true, size: 14 }),
    );
    box.appendChild(head);
    box.appendChild(el("p", "cs-hint", itemAbout(track, item)));
    const grid = el("div", "tl-fields");
    for (const field of itemFields(track, item, d, this.data, this.data.limits)) {
      const tidy = () => tidyItem(track, item, d, this.data);
      const wrap = field.unit === PERCENT ? this.percentField(item, base, field, tidy) : this.field(item, base, field, tidy);
      if (field.key === "color") this.addColourPicker(wrap, item, `${base}.color`);
      grid.appendChild(wrap);
    }
    box.appendChild(grid);
    this.placeTools(box, track, item);
    box.appendChild(button("Done", () => this.timeline.pick([]), { small: true, tip: "Back to the next steps" }));
    if (active) (box.querySelector(`[data-field="${CSS.escape(active)}"] input, [data-field="${CSS.escape(active)}"] select, [data-field="${CSS.escape(active)}"] textarea`) as HTMLElement | null)?.focus();
  }

  /** With nothing picked: what the scene still needs, the next of it with the button that does it. */
  private nextSteps(box: HTMLElement): void {
    const d = this.draft!;
    const used = (test: (track: Track) => boolean) => d.tracks.some((track) => test(track) && track.items.length > 0);
    const add = button("Add to the scene", () => this.addMenu(add), { icon: "plus", small: true, kind: "primary" });
    const steps: Array<{ done: boolean; title: string; text: string; action: HTMLElement }> = [
      {
        done: used((track) => track.kind === "camera"), title: "Frame the first shot",
        text: "Put this window beside the game window. Drag in the game to look around, scroll to zoom, then keep what you see.",
        action: button("Add camera shot", () => this.keyAtCamera(), { icon: "image", small: true, kind: "primary" }),
      },
      { done: used((track) => track.kind !== "camera"), title: "Add what happens", text: "Text, sound, fades, and actors who walk and talk.", action: add },
      { done: this.watched, title: "Watch it", text: "It plays in the game window.", action: button("Play", () => this.togglePlay(), { icon: "play", small: true, kind: "primary" }) },
      { done: this.originalName !== null && !this.dirty, title: "Save it", text: "Players only ever get what is saved.", action: button("Save", () => this.save(), { small: true, kind: "primary" }) },
      {
        done: d.triggers.length > 0, title: "Choose when it plays", text: "Walking into an area, finishing a quest, talking to an NPC.",
        action: button("Choose", () => { this.tab = "triggers"; this.render(); }, { icon: "bolt", small: true, kind: "primary" }),
      },
    ];
    const next = steps.find((step) => !step.done);
    if (next) {
      box.appendChild(el("h3", "cs-inspector-title", "Next steps"));
      const list = el("ol", "cs-steps");
      for (const step of steps) {
        const line = el("li", "cs-step" + (step.done ? " is-done" : step === next ? " is-next" : ""));
        const mark = el("span", "cs-step-mark");
        if (step.done) mark.appendChild(icon("check", 12));
        const words = el("div", "cs-step-words");
        words.appendChild(el("div", "cs-step-title", step.title));
        if (step === next) words.append(el("p", "cs-hint", step.text), step.action);
        line.append(mark, words);
        list.appendChild(line);
      }
      box.appendChild(list);
    }
    box.appendChild(el("p", "cs-hint", "Click anything on the timeline to edit it. Double-click a row to add to it."));
  }

  private addColourPicker(wrap: HTMLElement, item: any, path: string): void {
    const text = wrap.querySelector("input");
    if (!text) return;
    const picker = el("input", "cs-colour");
    picker.type = "color";
    picker.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : "#000000";
    picker.setAttribute("aria-label", "Pick a colour");
    picker.addEventListener("input", () => {
      item.color = picker.value;
      text.value = picker.value;
      this.touched(path, wrap);
    });
    text.parentElement?.insertBefore(picker, text);
  }

  /** The buttons that put an item somewhere in the world. */
  private placeTools(box: HTMLElement, track: Track, item: any): void {
    const ref: PlaceRef | null = track.kind === "camera" && !item.follow ? { kind: "key", track: track.id, item: item.id }
      : track.kind === "actor" && item.do === "place" ? { kind: "place", track: track.id, item: item.id }
      : track.kind === "world" && item.do === "particles" ? { kind: "particle", track: track.id, item: item.id } : null;
    if (ref) {
      const tools = el("div", "cs-place");
      tools.append(
        button("Set from game camera", () => {
          item.x = this.here.x;
          item.y = this.here.y;
          if (track.kind === "camera") item.zoom = Math.max(1, Math.min(3, Math.round(this.here.zoom * 100) / 100));
          this.edited(true);
        }, { icon: "image", small: true, tip: "Takes where the game window's camera is now" }),
        button("Place in game", () => this.place(ref), { icon: "target", small: true, tip: "Your next click in the game window says where it goes" }),
        button("Show in game", () => this.shell.send({ type: "cameraTo", x: item.x, y: item.y, zoom: item.zoom }), { icon: "eye", small: true, tip: "Takes the game window's free camera to it" }),
      );
      box.appendChild(tools);
    }
    if (track.kind === "actor" && item.do === "move") this.pathEditor(box, track, item);
  }

  private pathEditor(box: HTMLElement, track: Track, item: any): void {
    const base = `tracks.${this.draft!.tracks.indexOf(track)}.items.${(track.items as Item[]).indexOf(item)}.path`;
    box.appendChild(el("h4", "cs-inspector-sub", "Stops along the way"));
    item.path.forEach((stop: { x: number; y: number }, index: number) => {
      const row = el("div", "cs-stop");
      const blank = { x: 0, y: 0 }, after = () => tidyNumbers(stop, blank);
      row.append(
        el("span", "cs-label", String(index + 1)),
        this.field(stop, `${base}.${index}`, { key: "x", label: "X", type: "number", step: 1 }, after),
        this.field(stop, `${base}.${index}`, { key: "y", label: "Y", type: "number", step: 1 }, after),
        iconButton("target", "Place in game", () => this.place({ kind: "point", track: track.id, item: item.id, index }), { size: 14 }),
      );
      const remove = iconButton("trash", "Remove the stop", () => {
        item.path.splice(index, 1);
        this.rebuilt();
      }, { danger: true, size: 14 });
      remove.disabled = item.path.length < 2;
      row.appendChild(remove);
      box.appendChild(row);
    });
    const add = button("Add a stop", () => this.place({ kind: "newPoint", track: track.id, item: item.id }), { icon: "plus", small: true, tip: "The next click in the game window says where it is" });
    add.disabled = item.path.length >= this.data.limits.pathPointsMax;
    box.appendChild(add);
  }

  private addItem(track: Track, t: number, anchor: HTMLElement): void {
    const actions = track.kind === "actor" ? ACTOR_ACTIONS : track.kind === "world" ? WORLD_ACTIONS : null;
    if (actions) popMenu(anchor, actions.map((a) => ({ label: a.label, icon: a.icon, onPick: () => this.create(track, a.value, t) })));
    else this.create(track, null, t);
  }

  private create(track: Track, action: string | null, t: number): void {
    const d = this.draft;
    if (!d) return;
    if (track.items.length >= this.data.limits.itemsPerTrackMax) {
      toast(`A track holds ${this.data.limits.itemsPerTrackMax} items at most.`, "error");
      return;
    }
    const item = blankItem(track, action, nextId("i", itemIds(d)), round(t), this.here, this.data);
    // Added at the very end, it starts early enough to have its length.
    item.t = round(Math.min(item.t, Math.max(0, d.duration - item.d)));
    item.d = Math.min(item.d, round(d.duration - item.t));
    (track.items as any[]).push(item);
    this.timeline.picks = [{ track: track.id, item: item.id }];
    this.sendPicks();
    this.rebuilt();
    this.inspector.querySelector("textarea")?.focus();
  }

  /**
   * The track of this kind to add to: the one being worked on if it is one, or a new one. Text, sounds and the like go
   * to a row with room at the playhead, not on top of what is there. An actor keeps to its own row.
   */
  private trackFor(kind: Track["kind"], actor?: Actor): Track | null {
    const d = this.draft!;
    const fits = (track: Track) => track.kind === kind && (!actor || (track.kind === "actor" && track.actor === actor.id));
    const working = this.timeline.pickedItems()[0]?.track;
    const near = this.time + 0.01;
    const room = (track: Track) => !!actor || !(track.items as Item[]).some((item) => item.t <= near && near < item.t + Math.max(item.d, 0.02));
    const candidates = working && fits(working) ? [working, ...d.tracks.filter((t) => t !== working && fits(t))] : d.tracks.filter(fits);
    const found = candidates.find(room);
    if (found) return found;
    if (d.tracks.length >= this.data.limits.tracksMax) {
      if (candidates[0]) return candidates[0];
      toast(`A scene holds ${this.data.limits.tracksMax} tracks at most.`, "error");
      return null;
    }
    const track = this.newTrack(kind, actor);
    d.tracks.push(track);
    return track;
  }

  private addHere(kind: Track["kind"], action: string | null = null, actor?: Actor): void {
    const track = this.trackFor(kind, actor);
    if (track) this.create(track, action, this.time);
  }

  private addMenu(anchor: HTMLElement): void {
    const d = this.draft;
    if (!d) return;
    const entries: MenuEntry[] = [
      { label: "Camera shot", icon: TRACK_ICONS.camera, onPick: () => this.keyAtCamera() },
      { label: "Text on screen", icon: TRACK_ICONS.text, onPick: () => this.addHere("text") },
      { label: "Fade or flash", icon: TRACK_ICONS.screen, onPick: () => this.addHere("screen") },
      { label: "Camera shake", icon: TRACK_ICONS.shake, onPick: () => this.addHere("shake") },
      { label: "Sound or music", icon: TRACK_ICONS.audio, onPick: () => this.addHere("audio") },
      ...WORLD_ACTIONS.map((action) => ({ label: action.label, icon: action.icon, onPick: () => this.addHere("world", action.value) })),
      ...d.actors.map((actor) => ({
        label: `What ${actor.name || actor.id} does`, icon: TRACK_ICONS.actor,
        onPick: () => popMenu(anchor, ACTOR_ACTIONS.map((action) => ({ label: action.label, icon: action.icon, onPick: () => this.addHere("actor", action.value, actor) }))),
      })),
      {
        label: "New actor", icon: "plus", off: d.actors.length >= this.data.limits.actorsMax,
        onPick: () => {
          this.tab = "actors";
          this.addActor();
        },
      },
      { label: "Marker for scripts", icon: TRACK_ICONS.mark, onPick: () => this.addHere("mark") },
      { label: "Empty track", icon: "plus", off: d.tracks.length >= this.data.limits.tracksMax, onPick: () => this.addTrackMenu(anchor) },
    ];
    popMenu(anchor, entries);
  }

  private keyAtCamera(): void {
    if (!this.draft) return;
    const track = this.trackFor("camera");
    if (!track || track.kind !== "camera") return;
    const held = track.items.find((k) => Math.abs(k.t - this.time) < 0.02);
    if (held) {
      held.x = this.here.x;
      held.y = this.here.y;
      held.zoom = Math.max(1, Math.min(3, Math.round(this.here.zoom * 100) / 100));
      held.follow = null;
      this.timeline.picks = [{ track: track.id, item: held.id }];
      this.sendPicks();
      this.rebuilt();
      return;
    }
    this.create(track, null, this.time);
  }

  private playSaved(): void {
    if (this.originalName === null || this.dirty) {
      toast("Save the scene first: a player gets what is saved.", "error");
      return;
    }
    this.shell.send({ type: "request", packet: "CUTSCENE_EDITOR_PLAY", data: { name: this.originalName } });
  }

  private addTrackMenu(anchor: HTMLElement): void {
    const d = this.draft;
    if (!d) return;
    const kinds: Array<Track["kind"]> = ["camera", "shake", "screen", "text", "audio", "world", "mark"];
    const entries: MenuEntry[] = kinds.map((kind) => ({ label: KIND_LABELS[kind], icon: TRACK_ICONS[kind], onPick: () => this.addTrack(kind) }));
    for (const actor of d.actors) entries.push({ label: `Track for ${actor.name || actor.id}`, icon: TRACK_ICONS.actor, onPick: () => this.addTrack("actor", actor) });
    popMenu(anchor, entries);
  }

  private newTrack(kind: Track["kind"], actor?: Actor): Track {
    const id = nextId("t", this.draft!.tracks.map((t) => t.id));
    return (actor ? { id, kind, label: actor.name || actor.id, actor: actor.id, items: [] } : { id, kind, label: KIND_LABELS[kind], items: [] }) as Track;
  }

  private addTrack(kind: Track["kind"], actor?: Actor): void {
    const d = this.draft;
    if (!d) return;
    if (d.tracks.length >= this.data.limits.tracksMax) {
      toast(`A scene holds ${this.data.limits.tracksMax} tracks at most.`, "error");
      return;
    }
    d.tracks.push(this.newTrack(kind, actor));
    this.rebuilt();
  }

  private trackMenu(track: Track, anchor: HTMLElement): void {
    const d = this.draft;
    if (!d) return;
    const at = d.tracks.indexOf(track);
    popMenu(anchor, [
      { label: "Rename", icon: "pencil", onPick: () => void this.renameTrack(track) },
      { label: "Move up", icon: "arrowUp", off: at === 0, onPick: () => this.moveTrack(at, -1) },
      { label: "Move down", icon: "arrowDown", off: at === d.tracks.length - 1, onPick: () => this.moveTrack(at, 1) },
      { label: "Delete", icon: "trash", danger: true, onPick: () => this.deleteTrack(track) },
    ]);
  }

  private async renameTrack(track: Track): Promise<void> {
    const label = await askText({ title: "Rename the track", label: "Name", okLabel: "Rename", value: track.label, maxLength: this.data.limits.labelMax });
    if (label === null) return;
    track.label = label;
    this.rebuilt();
  }

  private moveTrack(at: number, by: number): void {
    const d = this.draft!;
    const [track] = d.tracks.splice(at, 1);
    d.tracks.splice(at + by, 0, track!);
    this.rebuilt();
  }

  private deleteTrack(track: Track): void {
    const d = this.draft!;
    d.tracks = d.tracks.filter((t) => t !== track);
    this.timeline.picks = this.timeline.picks.filter((p) => p.track !== track.id);
    this.sendPicks();
    this.rebuilt();
    toast(`Deleted the track ${track.label}. Ctrl+Z brings it back.`);
  }

  private deletePicked(): void {
    const picked = this.timeline.pickedItems();
    if (!picked.length) return;
    for (const { track, item } of picked) (track as { items: Item[] }).items = (track.items as Item[]).filter((i) => i !== item);
    this.timeline.picks = [];
    this.sendPicks();
    this.rebuilt();
  }

  private copyPicked(): void {
    const picked = this.timeline.pickedItems();
    if (!picked.length) return;
    const first = Math.min(...picked.map((p) => p.item.t));
    this.clipboard = picked.map((p) => ({ track: p.track.id, kind: p.track.kind, item: { ...clone(p.item), t: p.item.t - first } }));
  }

  private paste(at: number): void {
    const d = this.draft;
    if (!d || !this.clipboard.length) return;
    const ids = new Set(itemIds(d));
    const made: Picked[] = [];
    for (const copied of this.clipboard) {
      const track = d.tracks.find((t) => t.id === copied.track) ?? d.tracks.find((t) => t.kind === copied.kind);
      if (!track || track.items.length >= this.data.limits.itemsPerTrackMax) continue;
      const id = nextId("i", ids);
      ids.add(id);
      (track.items as any[]).push({ ...clone(copied.item), id, t: Math.min(d.duration, round(at + copied.item.t)) });
      made.push({ track: track.id, item: id });
    }
    if (!made.length) return;
    this.timeline.picks = made;
    this.sendPicks();
    this.rebuilt();
  }

  private duplicatePicked(): void {
    const picked = this.timeline.pickedItems();
    if (!picked.length) return;
    const held = this.clipboard;
    const start = Math.min(...picked.map((p) => p.item.t));
    const end = Math.max(...picked.map((p) => p.item.t + (p.item.d || 0.5)));
    this.copyPicked();
    this.paste(start + (end - start));
    this.clipboard = held;
  }

  private nudge(by: number): void {
    const d = this.draft;
    if (!d) return;
    for (const { item } of this.timeline.pickedItems()) item.t = round(Math.max(0, Math.min(d.duration - item.d, item.t + by)));
    this.timeline.render();
    this.edited(true);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.draft || document.querySelector("dialog[open]")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (ctrl && key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (ctrl && key === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (this.tab !== "timeline") return;
    const picks = this.timeline.picks.length > 0;
    if (key === " ") {
      e.preventDefault();
      this.togglePlay();
    } else if (key === "home") {
      e.preventDefault();
      this.seek(0);
    } else if (key === "delete" || key === "backspace") {
      e.preventDefault();
      this.deletePicked();
    } else if (ctrl && key === "d") {
      e.preventDefault();
      this.duplicatePicked();
    } else if (ctrl && key === "c") {
      this.copyPicked();
    } else if (ctrl && key === "v") {
      e.preventDefault();
      this.paste(this.time);
    } else if (key === "arrowleft" || key === "arrowright") {
      e.preventDefault();
      const direction = key === "arrowleft" ? -1 : 1;
      if (picks) this.nudge(direction * (e.shiftKey ? 1 : 0.1));
      else this.seek(Math.max(0, Math.min(this.draft.duration, this.time + direction * (e.shiftKey ? 1 : 1 / 30))));
    }
  }

  // ------------------------------------------------------------------- actors

  /** The NPCs to pick from. `current` is what a scene already names: it may not be in the list. */
  private npcOptions(current?: number | null): AssetOption[] {
    const options: AssetOption[] = this.data.npcs.map((n) => ({ value: n.id, label: `${n.name} (${n.map})` }));
    if (current !== null && current !== undefined && !this.data.npcs.some((n) => n.id === current)) options.unshift({ value: current, label: `NPC ${current}` });
    return options;
  }

  private renderActors(key: string): void {
    const d = this.draft!;
    const { main } = this.shell.page(key);
    this.pageKey = key;
    const box = card(main, "Actors", "Who is in the scene. They exist for the player watching it and for nobody else.");
    const add = button("Add an actor", () => this.addActor(), { icon: "plus", small: true });
    add.disabled = d.actors.length >= this.data.limits.actorsMax;
    box.tools.appendChild(add);
    if (!d.actors.length) box.body.appendChild(note("No actors yet. Scenes can do without: the world goes on as it is.", "plain", "user"));
    d.actors.forEach((actor, index) => box.body.appendChild(this.actorCard(actor, index)));
  }

  private addActor(): void {
    const d = this.draft!;
    const id = nextId("a", d.actors.map((a) => a.id));
    const here = this.npcHere();
    const look: Look = here ? { kind: "npc", npcId: here.id } : { kind: "viewer" };
    const actor: Actor = { id, name: `Actor ${d.actors.length + 1}`, showName: false, look, x: this.here.x, y: this.here.y, direction: "down", visible: true };
    d.actors.push(actor);
    if (d.tracks.length < this.data.limits.tracksMax) d.tracks.push(this.newTrack("actor", actor));
    this.openActors.add(id);
    this.rebuilt();
  }

  private removeActor(actor: Actor): void {
    const d = this.draft!;
    d.actors = d.actors.filter((a) => a !== actor);
    d.tracks = d.tracks.filter((t) => !(t.kind === "actor" && t.actor === actor.id));
    for (const track of d.tracks) {
      if (track.kind !== "camera") continue;
      for (const key of track.items) {
        if (key.follow !== actor.id) continue;
        key.follow = null;
      }
    }
    this.timeline.picks = [];
    this.sendPicks();
    this.rebuilt();
    toast(`Removed ${actor.name || actor.id}, and its tracks. Ctrl+Z brings them back.`);
  }

  /** The NPC a new actor starts as: one from the scene's map where there is one. */
  private npcHere(): EditorData["npcs"][number] | undefined {
    const map = lower(this.draft!.map);
    return this.data.npcs.find((n) => lower(n.map) === map) ?? this.data.npcs[0];
  }

  private setLook(actor: Actor, kind: Look["kind"]): void {
    if (kind === "npc") actor.look = { kind, npcId: this.npcHere()?.id ?? 0 };
    else if (kind === "viewer") actor.look = { kind };
    else actor.look = { kind, sprite_type: "animated", body: null, head: null, helmet: null, shoulderguards: null, neck: null, hands: null, chest: null, feet: null, legs: null, weapon: null };
    this.rebuilt();
  }

  private actorCard(actor: Actor, index: number): HTMLElement {
    const l = this.data.limits, base = `actors.${index}`;
    const open = this.openActors.has(actor.id);
    const wrong = Object.keys(this.fieldErrors).some((path) => path.startsWith(`${base}.`));
    const sub = subcard({
      title: actor.name || actor.id, lead: lookLine(actor, this.data), wrong, open,
      onToggle: () => {
        if (open) this.openActors.delete(actor.id);
        else this.openActors.add(actor.id);
        this.render();
      },
    });
    sub.tools.appendChild(iconButton("trash", "Remove the actor", () => this.removeActor(actor), { danger: true, size: 14 }));
    if (!open) return sub.root;
    const who = el("div", "tl-fields tl-fields-2");
    who.append(
      this.field(actor, base, { key: "name", label: "Name", type: "text", maxLength: l.actorNameMax, rerender: true }),
      this.field(actor, base, { key: "showName", label: "Show the name over it", type: "switch" }),
    );
    sub.body.appendChild(who);

    sub.body.appendChild(el("h4", "cs-inspector-sub", "Looks like"));
    sub.body.appendChild(segments<Look["kind"]>([["npc", "An NPC"], ["viewer", "The player watching"], ["layers", "Dressed by hand"]], actor.look.kind, (kind) => this.setLook(actor, kind), `Look of ${actor.id}`));
    const look = actor.look;
    if (look.kind === "npc") {
      sub.body.appendChild(this.field(look, `${base}.look`, { key: "npcId", label: "NPC", type: "asset", noIcons: true, assets: () => this.npcOptions(look.npcId), rerender: true }));
    } else if (look.kind === "layers") {
      this.lookPickers(look, `${base}.look`, sub.body);
    }

    sub.body.appendChild(el("h4", "cs-inspector-sub", "Where it stands when the scene starts"));
    const tools = el("div", "cs-place");
    tools.append(
      button("Place in game", () => this.place({ kind: "actor", actor: actor.id }), { icon: "target", small: true, tip: "Your next click in the game window says where it stands" }),
      button("Set from game camera", () => {
        actor.x = this.here.x;
        actor.y = this.here.y;
        this.rebuilt();
      }, { icon: "image", small: true, tip: "Puts it where the game window's camera is now" }),
    );
    sub.body.appendChild(tools);
    const after = () => tidyNumbers(actor, { x: 0, y: 0 });
    const stands = el("div", "tl-fields tl-fields-2");
    stands.append(
      this.field(actor, base, { key: "x", label: "X", type: "number", step: 1, unit: "px" }, after),
      this.field(actor, base, { key: "y", label: "Y", type: "number", step: 1, unit: "px" }, after),
      this.field(actor, base, { key: "direction", label: "Facing", type: "select", options: () => DIRECTIONS }),
      this.field(actor, base, { key: "visible", label: "In view from the start", type: "switch" }),
    );
    sub.body.appendChild(stands);
    return sub.root;
  }

  /** Dressing an actor by hand is picking an NPC's sprites: the same names, as the NPC editor offers them. */
  private lookPickers(look: Extract<Look, { kind: "layers" }>, base: string, into: HTMLElement): void {
    const tidy = () => {
      for (const slot of SLOTS) if (look[slot] === "") look[slot] = null;
    };
    const was = look.sprite_type;
    into.appendChild(this.field(look, base, {
      key: "sprite_type", label: "Drawn as", type: "segmented", asText: true, options: () => DRAWN_AS, rerender: true, wide: true, hint: DRAWN_HOW[was],
    }, () => {
      // The body is a sheet for one and an icon for the other: neither name means anything to the other.
      if (look.sprite_type !== was) look.body = null;
    }));
    const grid = el("div", "tl-fields tl-fields-2");
    into.appendChild(grid);
    if (was === "static") {
      grid.appendChild(this.field(look, base, {
        key: "body", label: "Still image", type: "asset", rerender: true,
        assets: () => [{ value: "", label: "None" }, ...this.data.icons.map((icon) => ({ value: icon.name, label: icon.name, image: icon.image }))],
      }, tidy));
      return;
    }
    grid.append(
      this.field(look, base, { key: "body", label: "Body sheet", type: "sheet", slot: "body", noIcons: true, rerender: true }, tidy),
      this.field(look, base, { key: "head", label: "Head sheet", type: "sheet", slot: "head", noIcons: true, rerender: true }, tidy),
    );
    into.appendChild(el("h4", "cs-inspector-sub", "Worn"));
    const worn = el("div", "tl-fields tl-fields-2");
    for (const piece of WORN) worn.appendChild(this.field(look, base, { key: piece.slot, label: piece.label, type: "sheet", slot: piece.slot, rerender: true }, tidy));
    into.appendChild(worn);
  }

  // ----------------------------------------------------------------- settings

  private renderSettings(key: string): void {
    const d = this.draft!, l = this.data.limits, s = d.settings;
    const { main } = this.shell.page(key);
    this.pageKey = key;
    const saved = this.originalName !== null;

    const about = card(main, "The scene", "What it is called and where it plays");
    const grid = el("div", "tl-fields tl-fields-2");
    about.body.appendChild(grid);
    grid.append(
      saved
        ? this.field(d, "", { key: "name", label: "Name", type: "readonly", hint: "A saved scene keeps its name: triggers, commands and other scenes know it by name." })
        : this.field(d, "", { key: "name", label: "Name", type: "text", maxLength: l.nameMax }),
      this.field(d, "", { key: "map", label: "Map", type: "asset", noIcons: true, assets: () => this.mapOptions(d.map), rerender: true, hint: "Where the scene takes place." }),
      this.field(d, "", { key: "duration", label: "Length", type: "number", min: l.durationMin, max: l.durationMax, step: 0.5, unit: "s" }, () => { if (!Number.isFinite(d.duration)) d.duration = 10; }),
      this.field(d, "", { key: "description", label: "Notes", type: "textarea", maxLength: l.descriptionMax, rows: 2 }),
    );

    const after = () => tidyNumbers(s, defaultSettings() as unknown as Record<string, unknown>);
    const play = card(main, "While it plays", "How the game looks and what the player can do");
    const looks = el("div", "tl-fields tl-fields-3");
    play.body.appendChild(looks);
    looks.append(
      this.field(s, "settings", { key: "letterbox", label: "Black bars", type: "switch", rerender: true }),
      this.field(s, "settings", { key: "hideHud", label: "Hide the interface", type: "switch" }),
      this.field(s, "settings", { key: "hideOthers", label: "Hide other players", type: "switch" }),
      this.field(s, "settings", { key: "hideSelf", label: "Hide the player watching", type: "switch" }),
      this.field(s, "settings", { key: "hideCreatures", label: "Hide creatures", type: "switch" }),
      this.field(s, "settings", { key: "skippable", label: "Can be skipped", type: "switch" }),
      this.field(s, "settings", { key: "lock", label: "Holds the player still", type: "switch", hint: "They cannot move or be harmed until it ends." }),
    );
    const amounts = el("div", "tl-fields");
    play.body.appendChild(amounts);
    amounts.append(
      this.field(s, "settings", { key: "fadeIn", label: "Fade in", type: "number", min: 0, max: l.fadeMax, step: 0.1, unit: "s" }, after),
      this.field(s, "settings", { key: "fadeOut", label: "Fade out", type: "number", min: 0, max: l.fadeMax, step: 0.1, unit: "s" }, after),
      this.percentField(s, "settings", { key: "worldVolume", label: "Game sounds", type: "number", min: 0, max: 100, step: 5, hint: "How loud the game goes on under the scene." }, after),
    );
    if (s.letterbox) {
      amounts.appendChild(this.percentField(s, "settings", { key: "letterboxSize", label: "Bar height", type: "number", min: 0, max: Math.round(l.letterboxSizeMax * 100), step: 1, hint: "How much of the screen's height." }, after));
    }

    const end = card(main, "When it ends", "What comes after the last frame");
    const ending = { move: !!d.end.teleport };
    const rows = el("div", "tl-fields tl-fields-3");
    end.body.appendChild(rows);
    rows.append(
      this.field(d.end, "end", { key: "next", label: "Goes on to", type: "asset", noIcons: true, assets: () => this.sceneOptions(), rerender: true, hint: "Another scene, straight after this one." }, () => { if (!d.end.next) d.end.next = null; }),
      this.field(ending, "", {
        key: "move", label: "Move the player", type: "switch", rerender: true,
      }, () => { d.end.teleport = ending.move ? { map: d.map, x: this.here.x, y: this.here.y } : null; }),
    );
    const teleport = d.end.teleport;
    if (teleport) {
      const blank = { x: 0, y: 0 }, tidy = () => tidyNumbers(teleport, blank);
      const tools = el("div", "cs-place");
      tools.append(
        button("Place in game", () => this.place({ kind: "teleport" }), { icon: "target", small: true, tip: "Your next click in the game window says where they go" }),
        el("span", "cs-label", "Click the spot in the game window, or type it in."),
      );
      end.body.appendChild(tools);
      const place = el("div", "tl-fields tl-fields-3");
      place.append(
        this.field(teleport, "end.teleport", { key: "map", label: "To the map", type: "asset", noIcons: true, assets: () => this.mapOptions(teleport.map) }),
        this.field(teleport, "end.teleport", { key: "x", label: "X", type: "number", step: 1, unit: "px" }, tidy),
        this.field(teleport, "end.teleport", { key: "y", label: "Y", type: "number", step: 1, unit: "px" }, tidy),
      );
      end.body.appendChild(place);
    }
  }

  private mapOptions(current: string): Option[] {
    const maps = this.data.maps.includes(current) || !current ? this.data.maps : [current, ...this.data.maps];
    return maps.map((map) => ({ value: map, label: map }));
  }

  private sceneOptions(): Option[] {
    const own = lower(this.originalName ?? this.draft?.name);
    return [{ value: "", label: "Nothing" }, ...this.data.cutscenes.filter((s) => lower(s.name) !== own).map((s) => ({ value: s.name, label: s.name }))];
  }

  // ----------------------------------------------------------------- triggers

  private renderTriggers(key: string): void {
    const d = this.draft!;
    const { main } = this.shell.page(key);
    this.pageKey = key;
    const box = card(main, "When it plays", "What starts the scene for a player. Without a trigger it plays only from the /cutscene command or a script.");
    const add = button("Add a trigger", () => this.addTrigger(), { icon: "plus", small: true });
    add.disabled = d.triggers.length >= this.data.limits.triggersMax;
    box.tools.appendChild(add);
    if (!d.triggers.length) box.body.appendChild(note("Nothing starts this scene yet.", "plain", "bolt"));
    d.triggers.forEach((trigger, index) => box.body.appendChild(this.triggerCard(trigger, index)));
  }

  private addTrigger(): void {
    const d = this.draft!;
    const id = nextId("g", d.triggers.map((t) => t.id));
    d.triggers.push({ id, on: "area", once: true, minLevel: 0, x: this.here.x - 64, y: this.here.y - 64, w: 128, h: 128, questId: null, npcId: null });
    this.openTriggers.add(id);
    this.rebuilt();
  }

  private triggerCard(trigger: Trigger, index: number): HTMLElement {
    const l = this.data.limits, base = `triggers.${index}`;
    const open = this.openTriggers.has(trigger.id);
    const wrong = Object.keys(this.fieldErrors).some((path) => path.startsWith(`${base}.`));
    const said = TRIGGER_KINDS.find((k) => k.value === trigger.on)?.label ?? trigger.on;
    const sub = subcard({
      title: said, lead: trigger.once ? "Once for each player" : "Every time", wrong, open,
      onToggle: () => {
        if (open) this.openTriggers.delete(trigger.id);
        else this.openTriggers.add(trigger.id);
        this.render();
      },
    });
    sub.tools.appendChild(iconButton("trash", "Remove the trigger", () => {
      this.draft!.triggers = this.draft!.triggers.filter((t) => t !== trigger);
      this.rebuilt();
    }, { danger: true, size: 14 }));
    if (!open) return sub.root;
    const blank = { x: 0, y: 0, w: 64, h: 64, minLevel: 0 }, after = () => tidyNumbers(trigger, blank);
    const clean = () => {
      if (!trigger.questId) trigger.questId = null;
      if (!trigger.npcId) trigger.npcId = null;
    };
    const grid = el("div", "tl-fields tl-fields-3");
    grid.append(
      this.field(trigger, base, { key: "on", label: "When a player", type: "select", asText: true, options: () => TRIGGER_KINDS, rerender: true }),
      this.field(trigger, base, { key: "once", label: "Once for each player", type: "switch", rerender: true }),
      this.field(trigger, base, { key: "minLevel", label: "From level", type: "number", min: 0, max: l.minLevelMax, step: 1 }, after),
    );
    sub.body.appendChild(grid);
    if (trigger.on === "area") {
      const tools = el("div", "cs-place");
      tools.append(
        button("Draw on the map", () => {
          this.shell.send({ type: "drawArea", ref: { kind: "area", trigger: trigger.id } });
          toast("Now drag out the area in the game window. Esc cancels.");
        }, { icon: "brush", small: true, tip: "Drag out the area in the game window" }),
        el("span", "cs-label", "Drag it out in the game window, or type it in."),
      );
      sub.body.appendChild(tools);
      const area = el("div", "tl-fields");
      area.append(
        this.field(trigger, base, { key: "x", label: "X", type: "number", step: 1, unit: "px" }, after),
        this.field(trigger, base, { key: "y", label: "Y", type: "number", step: 1, unit: "px" }, after),
        this.field(trigger, base, { key: "w", label: "Width", type: "number", min: 1, step: 1, unit: "px" }, after),
        this.field(trigger, base, { key: "h", label: "Height", type: "number", min: 1, step: 1, unit: "px" }, after),
      );
      sub.body.appendChild(area);
    } else if (trigger.on === "quest_accept" || trigger.on === "quest_complete") {
      sub.body.appendChild(this.field(trigger, base, { key: "questId", label: "Quest", type: "asset", noIcons: true, assets: () => this.data.quests.map((q) => ({ value: q.id, label: q.name })) }, clean));
    } else if (trigger.on === "npc") {
      sub.body.appendChild(this.field(trigger, base, { key: "npcId", label: "NPC", type: "asset", noIcons: true, assets: () => this.npcOptions(trigger.npcId) }, clean));
    }
    return sub.root;
  }

  // ------------------------------------------------------------------ capture

  private renderCapture(key: string): void {
    const d = this.draft!, take = this.take;
    const { main, aside } = this.shell.page(key, { aside: true });
    this.pageKey = key;
    const size = { size: `${take.width}x${take.height}` };
    const options = card(main, "Record a video", "Records the scene to a video file on this computer");
    const grid = el("div", "tl-fields tl-fields-3");
    options.body.appendChild(grid);
    grid.append(
      this.takeField(take, { key: "mode", label: "Records", type: "segmented", options: () => [{ value: "composite", label: "The scene" }, { value: "tab", label: "The browser tab" }], rerender: true, hint: "The scene is drawn at the size picked here. The tab is the window as it stands." }),
      this.takeField(take, { key: "source", label: "Plays", type: "segmented", options: () => [{ value: "preview", label: "This edit" }, { value: "saved", label: "The saved scene" }], rerender: true, hint: "Only the saved scene goes on to the next of a chain." }),
      this.takeField(take, { key: "format", label: "File", type: "segmented", options: () => [{ value: "mp4", label: "MP4" }, { value: "webm", label: "WebM" }] }),
    );
    if (take.mode === "composite") {
      grid.append(
        this.takeField(size, { key: "size", label: "Size", type: "select", asText: true, options: () => RESOLUTIONS }, () => {
          const [width, height] = size.size.split("x").map(Number);
          take.width = width ?? take.width;
          take.height = height ?? take.height;
        }),
        this.takeField(take, { key: "fps", label: "Frames", type: "select", options: () => [{ value: "30", label: "30 a second" }, { value: "60", label: "60 a second" }] }),
      );
    }
    grid.append(
      this.takeField(take, { key: "bitrate", label: "Quality", type: "number", min: 1, max: 80, step: 1, unit: "Mbit/s" }, () => {
        if (!Number.isFinite(take.bitrate)) take.bitrate = 12;
      }),
      this.takeField(take, { key: "sound", label: "Sound", type: "switch" }),
    );
    if (take.source === "preview") {
      grid.append(
        this.takeField(take, { key: "from", label: "From", type: "number", min: 0, max: d.duration, step: 0.1, unit: "s" }, () => {
          if (!Number.isFinite(take.from)) take.from = 0;
        }),
        this.takeField(take, { key: "to", label: "To", type: "number", min: 0, max: d.duration, step: 0.1, unit: "s", placeholder: "The end" }, () => {
          if (!Number.isFinite(take.to)) take.to = null;
        }),
      );
    }
    const tools = el("div", "cs-place");
    this.recordButton = button("Record", () => this.record(), { icon: "play", kind: "primary" });
    this.stopButton = button("Stop", () => this.shell.send({ type: "captureStop" }), { icon: "stop" });
    tools.append(
      this.recordButton,
      this.stopButton,
      button("Save this frame", () => this.shell.send({ type: "still", options: { ...this.take, name: d.name } }), { icon: "image" }),
      this.captureLine,
    );
    options.body.appendChild(tools);
    this.drawCaptureState();

    const { body } = card(aside, "How it works", "What happens when you press Record");
    body.replaceChildren(...[
      "It runs in real time: the scene plays in the game window from start to finish, and the file is saved to your downloads when it ends.",
      take.mode === "tab" ? "Leave the tab showing while it runs: what the tab shows is what is recorded." : "It goes on while the game window is behind another one.",
      take.mode === "tab" ? "The game window shows a button to start: the browser only lets a click there ask to record the tab." : "The interface is left out of it. What the camera sees, the sound and the scene's text are in it.",
    ].map((line) => el("p", "", line)));
  }

  /** A setting of the recording: these stay in this window, and are no change to the scene. */
  private takeField(target: any, field: Field, after?: () => void): HTMLElement {
    return this.fields.renderField({ ...field, path: `capture.${field.key}` }, target, () => after?.());
  }

  private record(): void {
    if (this.take.source === "saved" && (this.originalName === null || this.dirty)) {
      toast("Save the scene first: this plays what is saved.", "error");
      return;
    }
    this.silentTake = false;
    this.shell.send({ type: "capture", options: { ...this.take, name: this.originalName ?? this.draft?.name ?? "cutscene" } });
  }

  private drawCaptureState(): void {
    const { state, seconds, error, file, silent } = this.captureState;
    if (state === "recording" && silent) this.silentTake = true;
    const running = state === "waiting" || state === "recording";
    if (this.recordButton) this.recordButton.disabled = running || state === "saving";
    if (this.stopButton) this.stopButton.disabled = !running;
    this.captureLine.textContent =
      state === "waiting" ? "Click the button in the game window to start."
      : state === "recording" ? `Recording: ${clockText(seconds)}${this.silentTake ? ", without sound (the game has not played any yet)" : ""}`
      : state === "saving" ? "Saving the file..."
      : state === "done" ? `Saved ${file ?? "the file"}.`
      : state === "error" ? error ?? "The recording failed."
      : "";
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.draft.name.trim() || "the new cutscene");
  }

  private open(draft: CutsceneDoc, originalName: string | null, dirty: boolean): void {
    this.draft = draft;
    this.originalName = originalName;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.tab = "timeline";
    this.watched = originalName !== null;
    this.past = [];
    this.future = [];
    this.last = JSON.stringify(draft);
    this.saved = dirty ? null : this.last;
    this.openActors.clear();
    this.openTriggers.clear();
    this.timeline.picks = [];
    this.showTime(0);
    this.sendPicks();
    this.sendSceneNow();
    this.shell.send({ type: "seek", t: 0 });
    this.shell.send({ type: "view", mode: this.view });
    this.renderList();
    this.render();
  }

  private closeScene(): void {
    this.draft = null;
    this.originalName = null;
    this.dirty = false;
    this.saved = null;
    this.past = [];
    this.future = [];
    this.timeline.picks = [];
    this.shell.send({ type: "scene", doc: null });
  }

  private async select(name: string): Promise<void> {
    if (lower(name) === lower(this.originalName) || !(await this.mayLeave())) return;
    const record = this.find(name);
    if (record) this.open(docOf(record), record.name, false);
  }

  private askName(title: string, okLabel: string, value: string): Promise<string | null> {
    return askText({
      title, okLabel, value, label: "Name", icon: "play", maxLength: this.data.limits.nameMax,
      body: "A saved scene keeps its name: triggers, commands and other scenes know it by name.",
      check: (name) => this.nameProblem(name),
    });
  }

  private async startNew(): Promise<void> {
    if (!(await this.mayLeave())) return;
    const name = await this.askName("New cutscene", "Create", "");
    if (name === null) return;
    const doc = emptyDoc(this.here.map || this.data.maps[0] || "");
    doc.name = name;
    this.open(doc, null, true);
  }

  private async duplicateScene(): Promise<void> {
    const d = this.draft;
    if (!d || !(await this.mayLeave())) return;
    const name = await this.askName("Duplicate the cutscene", "Duplicate", `${d.name} copy`);
    if (name === null) return;
    // A copy starts nothing by itself: two scenes on one trigger would race for the player.
    const copy: CutsceneDoc = { ...clone(d), name, triggers: [] };
    this.open(copy, null, true);
    if (d.triggers.length) toast("The triggers were left behind: this copy starts nothing yet.");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    this.fieldErrors = this.validate();
    const first = Object.keys(this.fieldErrors)[0];
    if (first) {
      this.refused = true;
      this.tab = tabOf(first);
      this.showProblems();
      return;
    }
    this.draft.name = this.draft.name.trim();
    this.mark();
    this.beginRequest("save", "CUTSCENE_EDITOR_SAVE", { originalName: this.originalName, doc: this.draft });
  }

  private async deleteScene(): Promise<void> {
    const name = this.originalName;
    if (!this.draft || name === null || this.pending) return;
    const leading = this.data.cutscenes.filter((s) => lower(s.end?.next) === lower(name)).map((s) => s.name);
    const agreed = await this.shell.confirmDelete(name, [
      "Its triggers stop with it, and players stop being told they have seen it.",
      ...(leading.length ? [`${leading.join(", ")} will end where ${leading.length === 1 ? "it goes" : "they go"} on to this one, and ${leading.length === 1 ? "its" : "their"} "Goes on to" is cleared.`] : []),
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "CUTSCENE_EDITOR_DELETE", { originalName: name });
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any): void {
    this.pending = { kind, packet };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright: don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      toast("The server did not answer in 15 s, so nothing was confirmed.", "error");
      this.askForList();
    }, SAVE_WAIT_MS);
    this.shell.send({ type: "request", packet, data });
    this.chrome();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.chrome();
  }
}

new CutsceneEditorBridge();
