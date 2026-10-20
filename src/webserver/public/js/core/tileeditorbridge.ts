// Map editor popup: the tile palette, the layers and the tools. The painting
// itself happens in the game window (js/core/tileeditor.ts); this window says
// what to paint with. The two talk over postMessage, and none of that
// conversation is changed here.
//
// The window is built from the shared kit (css/tools.css, js/core/toolkit.ts)
// but not from the editor workbench, which is for a list of records and a
// form: this is a tool window. What is its own is in css/mapeditor.css (me-*).
//
// The game window tells this one little: the map's tilesets and layers, which
// layer is selected, which layers are locked or have unsaved edits, and the
// tiles picked up from the map. It does not answer a Save, a tool change or
// the choice of an object layer, so what is shown here is only what it said.
import { arrowKeys, brandName, button, confirmDialog, count, el, empty, icon, iconButton, num, oneStop, openDialog, pill, screen, segments, setBusy, setIcon, toast, tooltip, type IconName } from "./toolkit.js";
import { FieldRenderer, setFieldError } from "./toolfields.js";
import { config } from "../web/global.js";

type Tool = "paint" | "erase" | "copy" | "paste";

const TOOLS: Array<{ id: Tool; label: string; key: string; glyph: IconName; does: string }> = [
  { id: "paint", label: "Paint", key: "P", glyph: "brush", does: "Paint the picked tiles onto the selected layer" },
  { id: "erase", label: "Erase", key: "E", glyph: "eraser", does: "Erase tiles from the selected layer" },
  { id: "copy", label: "Copy", key: "C", glyph: "copy", does: "Pick tiles up from the map, in the game window" },
  { id: "paste", label: "Paste", key: "V", glyph: "paste", does: "Put the picked tiles down as they were copied" },
];

const OBJECTS: Array<{ type: string; glyph: IconName }> = [
  { type: "Graveyards", glyph: "headstone" },
  { type: "Warps", glyph: "portal" },
];

/** How large the tiles of the palette can be shown: whole multiples, so every pixel stays a square. */
const ZOOMS = [1, 2, 3, 4];
const ZOOM_KEY = "ff-map-editor-zoom";
/**
 * The two tabs of the window: Tiles (the tools and the palette to paint with) and Sounds (USER REQUEST 2026-10-19: "a
 * separate tab that allows selecting multiple tiles to share a sound (picked from asset server)"): tiles of the palette
 * picked and given one footstep sound, for every map at once (js/core/tilesounds.ts).
 */
type View = "paint" | "sounds";
const VIEW_KEY = "ff-map-editor-view";
/** How long a sound save may go without the server's answer before it is called not saved. */
const SOUND_SAVE_WAIT_MS = 6000;
/** An audio file's name as a tile keeps it: without its extension, in lower case (the asset server finds it so). */
const audioName = (file: string): string => file.replace(/\.[^.]+$/, "").trim().toLowerCase();
/** The colour a sound is marked in on the palette: the same for a name every time. */
function soundHue(sound: string): number {
  let h = 0;
  for (let i = 0; i < sound.length; i++) h = (h * 31 + sound.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** New map: a map's size in tiles, a world's (whole chunks of WORLD_CHUNK tiles), as the server allows them. */
const MAP_MIN = 16, MAP_MAX = 1024, WORLD_CHUNK = 64, WORLD_MIN = 64, WORLD_MAX = 16384;
/** How long a New map may go without the new map arriving before it is called not made (a large world takes a while). */
const CREATE_WAIT_MS = 30000;

/** With nothing from the game window for this long, the page says so. */
const WAIT_MS = 12000;
/** How long a Save may go without the game window's answer before it is called not saved. */
const SAVE_WAIT_MS = 1500;

class TileEditorBridge {
  private sideEl = document.getElementById("me-side") as HTMLElement;
  private topEl = document.getElementById("me-topbar") as HTMLElement;
  private toolbarEl = document.getElementById("me-toolbar") as HTMLElement;
  private pageEl = document.getElementById("me-page") as HTMLElement;

  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private saveBtn!: HTMLButtonElement;
  private layersList = el("div", "tl-list");
  private objectsList = el("div", "tl-list");
  private layerCount = el("span", "tl-count");
  private tilesetTabs = el("div", "tl-tabs");
  private tilesetContainer = el("div", "me-stage");
  private tilesetCanvas = el("canvas", "me-canvas");
  private tilesetCtx: CanvasRenderingContext2D;
  private stageNote = el("div", "me-stage-note");
  private zoomSeg!: HTMLElement;
  private pickedEl = el("div", "me-foot-picked");
  private underEl = el("div", "me-foot-under");
  private legendEl = el("div", "me-legend");
  private titleEl = el("h1", "tl-title", "Map Editor");
  private noteEl = el("span", "tl-record-note");
  private statusEl = el("div", "me-status");

  private tilesets: any[] = [];
  private tilesetImages: HTMLImageElement[] = [];
  private currentTilesetIndex: number = 0;

  private layerData: any[] = [];
  private layerVisibility: Map<string, boolean> = new Map();
  private layerLocked: Map<string, boolean> = new Map();
  private objectLayerVisibility: Map<string, boolean> = new Map();
  private unsavedLayers: Set<string> = new Set();

  private currentTool: string = 'paint';
  private selectedLayer: string | null = null;
  private selectedObject: string | null = null;
  private selectedTile: number | null = null;
  private selectedTiles: number[][] = [];
  private selectedTilesFromMap: boolean = false;

  private hoveredTilesetPos: { x: number; y: number } | null = null;
  private isSelectingTiles: boolean = false;
  private selectionStartTile: { x: number; y: number } | null = null;
  private selectionEndTile: { x: number; y: number } | null = null;

  private isPanningTileset: boolean = false;
  private tilesetPanStartX: number = 0;
  private tilesetPanStartY: number = 0;
  private tilesetScrollStartX: number = 0;
  private tilesetScrollStartY: number = 0;

  private paletteAnimRunning = false;
  private lastPaletteAnimSignature = '';

  /** The four tools are off (the selected layer is locked, or an object layer is selected), and Paste is off. */
  private toolsOff = false;
  private pasteOff = false;
  /** How many times each tile of the palette is magnified. Only how large the canvas is shown: what is drawn on it is the same. */
  private zoom = 1;
  /** The game window has sent the map. */
  private inited = false;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** A Save has been sent and the game window has not said the layers are saved yet. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tileset pictures the game window sent that could not be read. */
  private brokenImages = new Set<number>();
  /** The tileset to go back to once the game window has sent the map again. */
  private wantedTileset: number | null = null;
  private pictureTimer: ReturnType<typeof setTimeout> | null = null;
  private pictureLate = false;

  /** The tab in view, and the toolbar each has. */
  private view: View = "paint";
  private paintBar = el("div", "me-toolbar-set");
  private soundBar = el("div", "me-toolbar-set");
  private viewTabs = el("div", "tl-seg me-views");
  /** The sounds set on tiles for every map: tileset key -> tile id -> sound ("" for none). */
  private tileSounds: Record<string, Record<string, string>> = {};
  /** The tiles picked in the Sounds tab, by tileset (index in the map's list) and tile id. Apart from the tiles to paint with. */
  private soundPicked = new Map<number, Set<number>>();
  /** A drag across the palette in the Sounds tab, and what it does to the tiles picked. */
  private soundDrag: { start: { x: number; y: number }; end: { x: number; y: number }; mode: "set" | "add" | "remove" } | null = null;
  /** The asset server's audio files: the name a tile keeps (no extension), and the file's name to show. */
  private audio: Array<{ value: string; label: string }> = [];
  private audioState: "none" | "loading" | "loaded" | "failed" = "none";
  /** The sound chosen to give the picked tiles: null while none is, "" for no sound at all. */
  private chosenSound: string | null = null;
  private soundPickBtn!: HTMLButtonElement;
  private soundPlayBtn!: HTMLButtonElement;
  private soundApplyBtn!: HTMLButtonElement;
  private soundResetBtn!: HTMLButtonElement;
  private soundLegendEl = el("div", "me-sound-legend");
  private soundSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A save on its way: the tiles (tileset key, ids) and the sound they are to have, null for back to the map's own. */
  private soundSaving: { key: string; ids: number[]; sound: string | null } | null = null;
  private preview: HTMLAudioElement | null = null;
  private fields = new FieldRenderer({ rerender: () => {} });

  /** New map: a request is on its way, its button, and the time it may take. */
  private creatingMap = false;
  private createBtn: HTMLButtonElement | null = null;
  private createTimer: ReturnType<typeof setTimeout> | null = null;
  /** The asset server's tileset pictures by key ("environment" -> "environment.png"), and the form's tileset switches. */
  private tilesetFiles = new Map<string, string>();
  private tilesetSetsEl: HTMLElement | null = null;
  private tilesetPicked: Set<string> | null = null;

  constructor() {
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;
    try {
      const kept = Number(localStorage.getItem(ZOOM_KEY));
      if (ZOOMS.includes(kept)) this.zoom = kept;
    } catch {
      // No storage here: the palette opens at its usual size.
    }

    this.buildSide();
    this.buildTop();
    this.buildToolbar();
    this.buildPalette();
    this.paintStatus();
    this.paintTools();
    this.paintPicked();

    // Opened by hand, not from the game: there is no game window to talk to.
    if (!window.opener) {
      this.standalone();
      return;
    }

    this.setupEventListeners();
    this.setupMessageListener();
    this.setupBeforeUnload();
    this.startPaletteAnimation();

    this.waiting();
    this.notifyReady();
  }

  private notifyReady() {
    if (window.opener) {
      window.opener.postMessage({ type: 'bridgeReady' }, '*');
    }
  }

  private setupBeforeUnload() {
    window.addEventListener('beforeunload', () => {
      if (window.opener) {
        window.opener.postMessage({ type: 'editorClosed' }, '*');
      }
    });
  }

  private setupMessageListener() {
    window.addEventListener('message', (e) => {
      if (e.source !== window.opener) return;

      const msg = e.data;
      switch (msg.type) {
        case 'init':
          this.handleInit(msg);
          break;
        case 'tilesetImage':
          this.handleTilesetImage(msg);
          break;
        case 'layerUpdate':
          this.handleLayerUpdate(msg);
          break;
        case 'toolUpdate':
          this.handleToolUpdate(msg);
          break;
        case 'layerSelectUpdate':
          this.handleLayerSelectUpdate(msg);
          break;
        case 'layerVisibilityUpdate':
          this.handleLayerVisibilityUpdate(msg);
          break;
        case 'layerLockUpdate':
          this.handleLayerLockUpdate(msg);
          break;
        case 'objectSelectUpdate':
          this.handleObjectSelectUpdate(msg);
          break;
        case 'objectVisibilityUpdate':
          this.handleObjectVisibilityUpdate(msg);
          break;
        case 'tileSelectUpdate':
          this.handleTileSelectUpdate(msg);
          break;
        case 'tileSoundsUpdate':
          this.handleTileSoundsUpdate(msg);
          break;
        case 'createMapFailed':
          this.createMapDone(String(msg.message || "The map was not made."));
          break;
        case 'close':
          window.close();
          break;
      }
    });
  }

  private send(msg: any) {
    if (window.opener) {
      window.opener.postMessage(msg, '*');
    }
  }

  // ---------------------------------------------------- building the window

  private buildSide() {
    const brand = el("div", "tl-brand");
    const brandMark = el("span", "tl-brand-mark");
    brandMark.appendChild(icon("flame", 18));
    const name = el("span", "tl-brand-words");
    name.append(el("span", "tl-brand-name", brandName()), el("span", "tl-brand-sub", "Map Editor"));
    brand.append(brandMark, name);

    const part = (title: string, list: HTMLElement, className: string, tail?: HTMLElement) => {
      const box = el("div", `me-side-part ${className}`);
      const head = el("div", "tl-list-head");
      const heading = el("h2", "tl-list-title", title);
      heading.id = `me-${title.toLowerCase()}-title`;
      head.appendChild(heading);
      if (tail) head.appendChild(tail);
      list.setAttribute("role", "list");
      list.setAttribute("aria-labelledby", heading.id);
      box.append(head, list);
      return box;
    };
    this.layerCount.hidden = true;
    const layers = part("Layers", this.layersList, "me-side-layers", this.layerCount);
    const objects = part("Objects", this.objectsList, "me-side-objects");
    // Up and down move through the rows of a list, as in any list.
    for (const list of [this.layersList, this.objectsList]) {
      list.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const rows = [...list.querySelectorAll<HTMLElement>(".tl-list-open")];
        const at = rows.indexOf((document.activeElement as HTMLElement)?.closest(".tl-list-row")?.querySelector(".tl-list-open") as HTMLElement);
        if (at < 0) return;
        e.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      });
    }
    this.sideEl.append(brand, layers, objects);
  }

  private buildTop() {
    const thumb = el("span", "tl-thumb tl-thumb-lg");
    thumb.setAttribute("aria-hidden", "true");
    thumb.appendChild(icon("map", 18));
    const slot = el("span", "tl-record-thumb");
    slot.appendChild(thumb);
    const said = el("div", "tl-record-words");
    said.append(this.titleEl, this.noteEl);
    const record = el("div", "tl-record");
    record.append(slot, said);
    this.statusEl.setAttribute("role", "status");

    const undo = iconButton("undo", "Undo (Ctrl+Z)", () => this.send({ type: 'command', name: 'undo' }));
    const redo = iconButton("redo", "Redo (Ctrl+Y)", () => this.send({ type: 'command', name: 'redo' }));
    this.saveBtn = button("Save", () => this.save(), { icon: "save" });
    const newMap = button("New map", () => void this.newMap(), { icon: "plus", kind: "quiet", fold: true, tip: "Make a new, blank map or world and go there" });
    const actions = el("div", "tl-topbar-actions");
    actions.append(newMap, el("span", "tl-topbar-rule"), undo, redo, el("span", "tl-topbar-rule"), this.saveBtn);
    this.topEl.append(record, this.statusEl, actions);
  }

  private buildToolbar() {
    const group = el("div", "tl-seg me-tools");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Tool");
    for (const tool of TOOLS) {
      const btn = el("button", "tl-seg-item");
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.dataset.value = tool.id;
      btn.append(icon(tool.glyph, 15), el("span", "", tool.label), el("kbd", "tl-kbd", tool.key));
      // Paste only does anything once a tile has been picked.
      btn.addEventListener('click', () => {
        if (tool.id !== 'paste' || this.selectedTile !== null) this.setTool(tool.id);
      });
      this.toolBtns.set(tool.id, btn);
      group.appendChild(btn);
    }
    arrowKeys(group);

    const rotate = button("Rotate", () => this.send({ type: 'command', name: 'rotateTile' }), { icon: "restart", kind: "quiet", tip: "Turn the picked tiles a quarter turn (Z)" });
    rotate.appendChild(el("kbd", "tl-kbd me-key", "Z"));

    const grid = button("Grid", () => this.send({ type: 'command', name: 'toggleGrid' }), { icon: "grid", kind: "quiet", fold: true, tip: "Show or hide the grid in the game window" });
    const clear = button("Clear edits", () => this.send({ type: 'command', name: 'clear' }), { icon: "history", kind: "quiet", fold: true, tip: "Take back every edit of mine that is not saved" });
    const end = el("div", "me-toolbar-end");
    end.append(grid, clear);

    this.paintBar.append(el("span", "me-toolbar-title", "Tool"), group, rotate, end);
    this.buildSoundBar();

    this.viewTabs.setAttribute("role", "tablist");
    this.viewTabs.setAttribute("aria-label", "What to do");
    const views: Array<[View, string, IconName, string]> = [
      ["paint", "Tiles", "brush", "Paint tiles onto the map"],
      ["sounds", "Sounds", "megaphone", "Give tiles the footstep sound they make, on every map"],
    ];
    for (const [id, label, glyph, does] of views) {
      const tab = el("button", "tl-seg-item");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.value = id;
      tab.title = does;
      tab.append(icon(glyph, 15), el("span", "", label));
      tab.addEventListener("click", () => this.setView(id));
      this.viewTabs.appendChild(tab);
    }
    arrowKeys(this.viewTabs);
    this.toolbarEl.append(this.viewTabs, el("span", "tl-topbar-rule"), this.paintBar, this.soundBar);
    let kept: string | null = null;
    try {
      kept = localStorage.getItem(VIEW_KEY);
    } catch {
      // No storage here: the window opens on Paint.
    }
    this.setView(kept === "sounds" ? "sounds" : "paint", false);
  }

  private buildPalette() {
    const inner = el("div", "tl-page-inner");
    const card = el("section", "tl-card me-palette");
    card.setAttribute("aria-label", "Tile palette");

    this.tilesetTabs.setAttribute("role", "tablist");
    this.tilesetTabs.setAttribute("aria-label", "Tilesets");
    // Left and right move through the tilesets and show the one they land on.
    this.tilesetTabs.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const all = [...this.tilesetTabs.querySelectorAll<HTMLElement>(".tl-tab")];
      const next = all[(all.indexOf(document.activeElement as HTMLElement) + step + all.length) % all.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.click();
    });
    // The wheel moves along the tabs when there are more than fit.
    this.tilesetTabs.addEventListener("wheel", (e) => {
      if (this.tilesetTabs.scrollWidth <= this.tilesetTabs.clientWidth || e.ctrlKey) return;
      e.preventDefault();
      this.tilesetTabs.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: false });
    this.tilesetTabs.addEventListener("scroll", () => this.paintTabEnds());
    window.addEventListener("resize", () => this.paintTabEnds());

    this.zoomSeg = segments(ZOOMS.map((z) => [String(z), `${z}×`] as [string, string]), String(this.zoom), (z) => this.setZoom(Number(z)), "Size of the tiles");
    const zoom = el("div", "me-zoom");
    zoom.append(el("span", "", "Zoom"), this.zoomSeg);
    tooltip(zoom, "How large the tiles are shown. Ctrl and the wheel change it too.");
    const head = el("div", "me-palette-head");
    head.append(this.tilesetTabs, zoom);

    this.tilesetCanvas.setAttribute("role", "img");
    this.tilesetCanvas.setAttribute("aria-label", "The tiles of the tileset in view");
    this.tilesetContainer.append(this.tilesetCanvas, this.stageNote);

    const legendMark = el("span", "me-legend-mark");
    this.legendEl.append(legendMark, el("span", "", "moves"));
    tooltip(this.legendEl, "A yellow corner marks a tile that is animated");
    const foot = el("div", "me-foot");
    foot.append(this.pickedEl, this.legendEl, this.soundLegendEl, this.underEl);

    card.append(head, this.tilesetContainer, foot);
    inner.appendChild(card);
    this.pageEl.appendChild(inner);
  }

  // ----------------------------------------------- nothing to show, and why

  /** Something in place of the tileset: the palette is hidden behind it until there is one to show. */
  private showNote(...nodes: Node[]) {
    this.stageNote.replaceChildren(...nodes);
    this.stageNote.hidden = false;
    this.tilesetCanvas.hidden = true;
  }

  private hideNote() {
    this.stageNote.hidden = true;
    this.stageNote.replaceChildren();
    this.tilesetCanvas.hidden = false;
  }

  /** The tabs fade out at an end that has more tilesets beyond it. */
  private paintTabEnds() {
    const tabs = this.tilesetTabs;
    tabs.classList.toggle("has-more-before", tabs.scrollLeft > 1);
    tabs.classList.toggle("has-more-after", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
  }

  private standalone() {
    for (const control of document.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
    empty(this.layersList, "plug", "Not connected", "The layers are listed here once the editor is opened from the game.");
    this.sideEl.querySelector<HTMLElement>(".me-side-objects")!.hidden = true;
    this.statusEl.hidden = true;
    this.noteEl.hidden = true;
    const box = el("div");
    screen(box, "plug", "This window opens from the game", "Log in to the game as an admin and open the map editor from there. It stays connected to your game, and what you pick here is painted there.");
    this.showNote(box.firstElementChild!);
  }

  /** Until the game window sends the map: the shapes of what is loading. If nothing has come after a while, the page says so. */
  private waiting() {
    this.inited = false;
    this.layersList.replaceChildren();
    this.layersList.setAttribute("aria-busy", "true");
    for (let i = 0; i < 6; i++) this.layersList.appendChild(el("div", "tl-skeleton tl-skeleton-row"));
    this.objectsList.replaceChildren(el("div", "tl-skeleton tl-skeleton-row"), el("div", "tl-skeleton tl-skeleton-row"));
    const wait = el("div", "me-stage-wait");
    wait.setAttribute("aria-busy", "true");
    wait.append(el("p", "", "Waiting for the game window to send the map. It does so once it has synced it with the server."), el("div", "tl-skeleton"));
    this.showNote(wait);
    this.paintStatus();
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      this.layersList.removeAttribute("aria-busy");
      this.layersList.replaceChildren();
      empty(this.layersList, "plug", "Nothing to list", "The game window has not sent the map yet.");
      this.objectsList.replaceChildren();
      const box = el("div");
      const said = screen(box, "plug", "The game window is not answering", "Nothing has come back for the map editor yet. Check that your game is still connected and that your account may edit maps, then try again.");
      said.appendChild(button("Try again", () => {
        this.waiting();
        this.notifyReady();
      }, { icon: "refresh", kind: "primary" }));
      this.showNote(said);
    }, WAIT_MS);
  }

  /**
   * What the palette shows in place of a tileset it cannot draw: that the map
   * has none, that the picture of this one is on its way, or that it never
   * came. With a tileset to draw, the note is taken away.
   */
  private paintStage() {
    if (!this.inited) return;
    if (this.pictureTimer) clearTimeout(this.pictureTimer);
    this.pictureTimer = null;
    const tileset = this.tilesets[this.currentTilesetIndex];
    const image = this.tilesetImages[this.currentTilesetIndex];
    const name = tileset ? String(tileset.name || `Tileset ${this.currentTilesetIndex + 1}`) : "";
    this.legendEl.hidden = !tileset || this.getAnimatedTilesForTileset(tileset).size === 0;
    if (!tileset) {
      const box = el("div");
      this.showNote(empty(box, "image", "This map has no tilesets", "There is nothing to pick tiles from. Tilesets are added to the map file, on the asset server."));
      return;
    }
    if (image && image.complete) {
      this.pictureLate = false;
      this.hideNote();
      return;
    }
    const again = () => button("Ask the game window again", () => {
      // The game window sends everything again, which goes back to the first tileset: come back to this one after.
      this.wantedTileset = this.currentTilesetIndex;
      this.pictureLate = false;
      this.brokenImages.delete(this.currentTilesetIndex);
      this.paintStage();
      this.notifyReady();
    }, { icon: "refresh" });
    const box = el("div");
    if (this.brokenImages.has(this.currentTilesetIndex)) {
      const said = empty(box, "alert", `The picture of ${name} could not be read`, "The game window sent it, but it is not a picture this window can show.");
      said.appendChild(again());
      this.showNote(said);
    } else if (this.pictureLate) {
      const said = empty(box, "image", `The picture of ${name} has not arrived`, "The game window sends a tileset's picture once it has loaded it itself.");
      said.appendChild(again());
      this.showNote(said);
    } else {
      const wait = el("div", "me-stage-wait");
      wait.setAttribute("aria-busy", "true");
      wait.append(el("p", "", `Fetching the picture of ${name} from the game window.`), el("div", "tl-skeleton"));
      this.showNote(wait);
      this.pictureTimer = setTimeout(() => {
        this.pictureLate = true;
        this.paintStage();
      }, WAIT_MS);
    }
  }

  // ------------------------------------------- what the game window sends

  /** The name of the map being edited. The game window does not send it: it is read from where the game window keeps it. */
  private mapName(): string {
    try {
      const name = (window.opener as any)?.mapData?.name;
      return typeof name === "string" ? name : "";
    } catch {
      return "";
    }
  }

  private handleInit(msg: any) {
    this.inited = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.layersList.removeAttribute("aria-busy");

    // The tiles picked for a sound belong to the tilesets as they were: a map with other tilesets starts afresh
    const keys = (list: any[]) => list.map((t: any) => this.keyOf(t)).join("|");
    if (keys(msg.tilesets || []) !== keys(this.tilesets)) this.soundPicked.clear();
    this.tilesets = msg.tilesets || [];
    this.currentTilesetIndex = 0;
    this.tileSounds = msg.tileSounds && typeof msg.tileSounds === "object" ? msg.tileSounds : {};

    this.layerData = msg.layers || [];

    this.layerVisibility.clear();
    if (msg.layerVisibility) {
      msg.layerVisibility.forEach(([key, val]: [string, boolean]) => this.layerVisibility.set(key, val));
    }
    this.layerLocked.clear();
    if (msg.layerLocked) {
      msg.layerLocked.forEach(([key, val]: [string, boolean]) => this.layerLocked.set(key, val));
    }
    this.objectLayerVisibility.clear();
    this.objectLayerVisibility.set('Graveyards', msg.objectVisibility?.Graveyards ?? true);
    this.objectLayerVisibility.set('Warps', msg.objectVisibility?.Warps ?? true);

    this.unsavedLayers.clear();
    if (msg.unsavedLayers) {
      msg.unsavedLayers.forEach((s: string) => this.unsavedLayers.add(s));
    }

    this.currentTool = msg.tool || 'paint';
    this.selectedLayer = msg.selectedLayer || null;
    this.selectedObject = msg.selectedObject || null;
    this.selectedTile = msg.selectedTile || null;
    this.selectedTiles = msg.selectedTiles || [];
    this.selectedTilesFromMap = msg.selectedTilesFromMap || false;

    this.updateToolButtons();
    this.buildLayerList();
    this.buildObjectList();
    this.buildTilesetTabs();
    this.updatePasteButtonState();

    // Back to the tileset that was in view when the game window was asked to send everything again.
    const wanted = this.wantedTileset;
    this.wantedTileset = null;
    if (wanted !== null && wanted > 0 && wanted < this.tilesets.length) this.selectTileset(wanted);

    const name = this.mapName();
    this.titleEl.textContent = name || "Map Editor";
    this.titleEl.title = name;
    document.title = name ? `${name} · Map Editor` : "Map Editor";
    this.paintStage();
    this.paintStatus();
    this.paintPicked();
  }

  private handleTilesetImage(msg: any) {
    const img = new Image();
    img.onload = () => {
      this.tilesetImages[msg.index] = img;
      this.brokenImages.delete(msg.index);
      if (msg.index === this.currentTilesetIndex) {
        this.drawTileset();
        this.paintStage();
      }
    };
    img.onerror = () => {
      this.brokenImages.add(msg.index);
      if (msg.index === this.currentTilesetIndex) this.paintStage();
    };
    img.src = msg.dataUrl;
  }

  private handleLayerUpdate(msg: any) {
    this.layerData = msg.layers || [];
    this.unsavedLayers.clear();
    if (msg.unsavedLayers) {
      msg.unsavedLayers.forEach((s: string) => this.unsavedLayers.add(s));
    }
    this.buildLayerList();
    this.paintObjectMarks();
    this.paintStatus();
    this.saveAnswered();
  }

  private handleToolUpdate(msg: any) {
    this.currentTool = msg.tool;
    this.updateToolButtons();
    this.updatePasteButtonState();
  }

  private handleLayerSelectUpdate(msg: any) {
    this.selectedLayer = msg.layerName;
    this.selectedObject = null;
    this.updateLayerSelection();
    this.updateObjectSelection();
    this.updatePasteButtonState();

    const isLocked = this.layerLocked.get(msg.layerName) ?? false;
    this.setEditButtonsLocked(isLocked);
  }

  private handleLayerVisibilityUpdate(msg: any) {
    this.layerVisibility.set(msg.layerName, msg.visible);
    this.updateLayerListItem(msg.layerName);
  }

  private handleLayerLockUpdate(msg: any) {
    this.layerLocked.set(msg.layerName, msg.locked);
    this.updateLayerListItem(msg.layerName);

    if (this.selectedLayer === msg.layerName) {
      this.setEditButtonsLocked(msg.locked);
      this.updatePasteButtonState();
    }
  }

  private handleObjectSelectUpdate(msg: any) {
    this.selectedObject = msg.objectType;
    this.selectedLayer = null;
    this.updateLayerSelection();
    this.updateObjectSelection();
    this.updatePasteButtonState();

    this.setEditButtonsLocked(!!msg.objectType);
  }

  private handleObjectVisibilityUpdate(msg: any) {
    this.objectLayerVisibility.set(msg.objectType, msg.visible);
    this.updateObjectListItem(msg.objectType);
  }

  private handleTileSelectUpdate(msg: any) {
    this.selectedTile = msg.tileId;
    this.selectedTiles = msg.selectedTiles || [];
    this.selectedTilesFromMap = msg.selectedTilesFromMap || false;
    this.updatePasteButtonState();
    this.drawTileset();
    this.paintPicked();
  }

  // ------------------------------------------------------------------ tools

  private setEditButtonsLocked(locked: boolean): void {
    this.toolsOff = locked;
    this.pasteOff = locked;
    this.paintTools();
    this.paintStatus();
  }

  private updatePasteButtonState(): void {
    const isLocked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    this.pasteOff = this.selectedTile === null || isLocked || !!this.selectedObject;
    this.paintTools();
    this.paintStatus();
  }

  /** Why the tools are off, for the tooltip of each. */
  private whyOff(): string {
    if (this.selectedObject) return `${this.selectedObject} is selected: the tools work on tile layers. Select a layer to use them.`;
    if (this.selectedLayer && (this.layerLocked.get(this.selectedLayer) ?? false)) return `${this.selectedLayer} is locked. Unlock it to use the tools on it.`;
    return "The tools are off for what is selected. Select a layer to use them.";
  }

  /** Which tool is in use, and which can be picked now. */
  private paintTools(): void {
    for (const tool of TOOLS) {
      const btn = this.toolBtns.get(tool.id);
      if (!btn) continue;
      const checked = this.currentTool === tool.id;
      // Paste can do nothing without a tile, so it is off then too.
      const off = tool.id === 'paste' ? this.pasteOff || this.selectedTile === null : this.toolsOff;
      btn.setAttribute("aria-checked", String(checked));
      btn.disabled = off;
      btn.title = !off ? `${tool.does} (${tool.key})` : tool.id === 'paste' ? this.whyNoPaste() : this.whyOff();
    }
    // The tool in use is the one the Tab key lands on, or the first that can be used while it is off.
    const group = this.toolBtns.get("paint")?.parentElement;
    if (group) oneStop(group);
  }

  /** Why Paste is off: it has rules of its own on top of the other tools'. */
  private whyNoPaste(): string {
    const locked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    if (this.toolsOff || this.selectedObject || locked) return this.whyOff();
    if (this.selectedTile === null) return "Nothing to paste yet: pick one tile first";
    // The tile was picked here, and the game window has said nothing since: the button waits for it, the key does not.
    return "Press V to paste the tile just picked. The button turns on when the game window next reports what is selected.";
  }

  private setupEventListeners() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.tilesetCanvas.addEventListener('mousedown', (e) => this.onTilesetMouseDown(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseup', (e) => this.onTilesetMouseUp(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));

    // Ctrl and the wheel change the size of the tiles, about the tile under the pointer.
    this.tilesetContainer.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const at = ZOOMS.indexOf(this.zoom) + (e.deltaY < 0 ? 1 : -1);
      if (at < 0 || at >= ZOOMS.length) return;
      const box = this.tilesetContainer.getBoundingClientRect();
      this.setZoom(ZOOMS[at], { x: e.clientX - box.left, y: e.clientY - box.top });
    }, { passive: false });
    // The palette is a surface to drag on: the browser's own menu has no place on it.
    this.tilesetContainer.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (this.view === "sounds") return this.soundKeyDown(e);

    if (this.selectedObject && ['p', 'e', 'c', 'v'].includes(e.key)) return;

    const isLocked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    if (isLocked && ['p', 'e', 'v'].includes(e.key)) return;

    if (e.key === 'p') this.setTool('paint');
    if (e.key === 'e') this.setTool('erase');
    if (e.key === 'c') this.setTool('copy');
    if (e.key === 'v' && this.selectedTile !== null) this.setTool('paste');

    if (e.key === 'z' && !e.ctrlKey) {
      e.preventDefault();
      this.send({ type: 'command', name: 'rotateTile' });
    }

    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      this.send({ type: 'command', name: 'undo' });
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      this.send({ type: 'command', name: 'redo' });
    }
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this.save();
    }
  }

  private setTool(tool: string) {
    if (tool !== 'copy' && this.selectedLayer && (this.layerLocked.get(this.selectedLayer) ?? false)) return;

    this.currentTool = tool;
    this.updateToolButtons();

    if (this.selectedObject) {
      this.send({ type: 'objectSelect', objectType: null });
    }

    this.send({ type: 'toolChange', tool });
  }

  private updateToolButtons() {
    this.paintTools();
    this.paintStatus();
  }

  /**
   * Save: the game window is asked to, as ever. It answers by saying the layers
   * have no unsaved edits left; when it says nothing, it did not save (it
   * shows why itself), and that is said here rather than left to be guessed.
   */
  private save() {
    this.send({ type: 'command', name: 'save' });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveBtn.classList.add("is-busy");
    this.saveBtn.setAttribute("aria-busy", "true");
    this.saveTimer = setTimeout(() => {
      this.saveDone();
      toast("The game window did not save the map.\nIt shows the reason itself: a warp that is not valid, or a save straight after another.", "error");
    }, SAVE_WAIT_MS);
  }

  private saveDone() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveBtn.classList.remove("is-busy");
    this.saveBtn.removeAttribute("aria-busy");
  }

  /** The game window sent the layers again: if a Save was waiting on that and nothing is unsaved now, it went through. */
  private saveAnswered() {
    if (!this.saveTimer || this.unsavedLayers.size > 0) return;
    this.saveDone();
    toast("Saved the map.");
  }

  // ----------------------------------------------------------------- status

  /** The top bar: the layer and the tool in use, and whether anything is unsaved. */
  private paintStatus(): void {
    const tool = TOOLS.find((t) => t.id === this.currentTool);
    const pills: HTMLElement[] = [];
    if (!this.inited) {
      if (window.opener) pills.push(pill("Waiting for the game window", "wait"));
    } else {
      const locked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
      let layer: HTMLElement;
      if (this.selectedObject) layer = this.statusPill(this.selectedObject, "info", OBJECTS.find((o) => o.type === this.selectedObject)?.glyph ?? "layers", "The object layer selected in the game window");
      else if (this.selectedLayer) layer = this.statusPill(locked ? `${this.selectedLayer} · locked` : this.selectedLayer, locked ? "warning" : "", locked ? "lock" : "layers", locked ? "The selected layer is locked: unlock it to paint on it" : "The layer the tools work on");
      else layer = this.statusPill("No layer selected", "", "layers", "Select a layer on the left to paint on it");
      layer.classList.add("me-pill-layer");
      pills.push(layer);
      if (tool) {
        const using = this.statusPill(tool.label, "", tool.glyph, `The tool in use: ${tool.does.charAt(0).toLowerCase()}${tool.does.slice(1)}`);
        using.classList.add("me-pill-tool");
        pills.push(using);
      }
      const unsaved = [...this.unsavedLayers];
      const saved = unsaved.length
        ? this.statusPill(count(unsaved.length, "layer") + " unsaved", "warning", "dot", `Not saved yet: ${unsaved.join(", ")}`)
        : this.statusPill("No unsaved edits", "", "check", "Everything painted has been saved");
      saved.classList.add("me-pill-saved");
      pills.push(saved);
      this.noteEl.textContent = `${count(this.layerData.length, "layer")} · ${count(this.tilesets.length, "tileset")}`;
    }
    this.noteEl.hidden = !this.inited;
    this.statusEl.replaceChildren(...pills);
    if (this.saveBtn) {
      this.saveBtn.classList.toggle("tl-btn-primary", this.unsavedLayers.size > 0);
      tooltip(this.saveBtn, this.unsavedLayers.size > 0 ? "Save the map (Ctrl+S)" : "Save the map (Ctrl+S). Nothing here is unsaved.");
    }
  }

  private statusPill(text: string, level: string, glyph: IconName | "dot", tip: string): HTMLElement {
    const node = pill(text, level, glyph);
    node.title = tip;
    return node;
  }

  // ----------------------------------------------------------------- layers

  private buildLayerList() {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".me-layer")?.dataset.layer;
    const which = (document.activeElement as HTMLElement | null)?.dataset.part;
    this.layersList.replaceChildren();
    this.layerCount.hidden = this.layerData.length === 0;
    this.layerCount.textContent = num(this.layerData.length);

    if (this.layerData.length === 0) {
      if (this.inited) empty(this.layersList, "layers", "No layers", "This map has no tile layers to paint on.");
      return;
    }

    this.layerData.forEach((layer: any) => {
      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');
      const isShadow = layer.name.toLowerCase().includes('shadow');

      if (!this.layerVisibility.has(layer.name)) {
        this.layerVisibility.set(layer.name, true);
      }
      if (!this.layerLocked.has(layer.name)) {
        this.layerLocked.set(layer.name, layer.locked ?? false);
      }

      const kind = isCollision ? { cls: "collision", glyph: "ban" as IconName, said: "Collision layer" }
        : isNoPvp ? { cls: "nopvp", glyph: "shield" as IconName, said: "No-PvP zone layer" }
        : isShadow ? { cls: "shadow", glyph: "moon" as IconName, said: "Shadow layer" }
        : { cls: "tiles", glyph: "layers" as IconName, said: "Tile layer" };

      const row = el("div", "tl-list-row me-layer");
      row.setAttribute("role", "listitem");
      row.dataset.layer = layer.name;
      row.dataset.kind = kind.said;

      const open = el("button", "tl-list-open");
      open.type = "button";
      open.dataset.part = "open";
      const kindMark = el("span", `me-kind me-kind-${kind.cls}`);
      kindMark.appendChild(icon(kind.glyph, 15));
      open.append(kindMark, el("span", "tl-list-name", layer.name));
      open.addEventListener('click', () => this.send({ type: 'layerSelect', layerName: layer.name }));

      const lock = iconButton("lock", "", () => {
        const newLocked = !(this.layerLocked.get(layer.name) ?? false);
        this.layerLocked.set(layer.name, newLocked);
        this.updateLayerListItem(layer.name);
        this.send({ type: 'layerLock', layerName: layer.name, locked: newLocked });
      }, { size: 15 });
      lock.classList.add("me-toggle");
      lock.dataset.part = "lock";
      const eye = iconButton("eye", "", () => {
        const newVisibility = !(this.layerVisibility.get(layer.name) ?? true);
        this.layerVisibility.set(layer.name, newVisibility);
        this.updateLayerListItem(layer.name);
        this.send({ type: 'layerToggle', layerName: layer.name, visible: newVisibility });
      }, { size: 15 });
      eye.classList.add("me-toggle");
      eye.dataset.part = "eye";
      const actions = el("span", "me-layer-actions");
      actions.append(lock, eye);

      row.append(open, actions);
      this.layersList.appendChild(row);
      this.paintLayerRow(row);
    });
    if (focused) this.layersList.querySelector<HTMLElement>(`.me-layer[data-layer="${CSS.escape(focused)}"] [data-part="${which ?? "open"}"]`)?.focus({ preventScroll: true });
  }

  /** How a layer's row stands: selected, locked, hidden, with unsaved edits. */
  private paintLayerRow(row: HTMLElement) {
    const name = row.dataset.layer ?? "";
    const isVisible = this.layerVisibility.get(name) ?? true;
    const isLocked = this.layerLocked.get(name) ?? false;
    const isUnsaved = this.unsavedLayers.has(name);
    const isActive = this.selectedLayer === name && !this.selectedObject;
    row.classList.toggle("is-selected", isActive);
    row.classList.toggle("is-locked", isLocked);
    row.classList.toggle("is-unseen", !isVisible);

    const open = row.querySelector<HTMLElement>(".tl-list-open")!;
    if (isActive) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
    const states = [row.dataset.kind, isLocked ? "locked" : "", isVisible ? "" : "hidden in the game window", isUnsaved ? "unsaved edits" : ""].filter(Boolean);
    open.title = `${name} (${states.join(", ")})`;
    open.querySelector(".me-unsaved")?.remove();
    if (isUnsaved) {
      const dot = el("span", "me-unsaved");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "unsaved edits");
      open.appendChild(dot);
    }

    const lock = row.querySelector<HTMLButtonElement>('[data-part="lock"]')!;
    setIcon(lock, isLocked ? "lock" : "unlock", 15);
    lock.classList.toggle("is-locked", isLocked);
    lock.setAttribute("aria-pressed", String(isLocked));
    lock.setAttribute("aria-label", isLocked ? `Unlock ${name}` : `Lock ${name}`);
    tooltip(lock, isLocked ? "Locked: nobody can paint on it. Click to unlock." : "Lock, so nobody paints on it");
    const eye = row.querySelector<HTMLButtonElement>('[data-part="eye"]')!;
    setIcon(eye, isVisible ? "eye" : "eyeOff", 15);
    eye.classList.toggle("is-unseen", !isVisible);
    eye.setAttribute("aria-pressed", String(!isVisible));
    eye.setAttribute("aria-label", isVisible ? `Hide ${name}` : `Show ${name}`);
    tooltip(eye, isVisible ? "Hide in my game window" : "Hidden in my game window. Click to show.");
  }

  private layerRows(): HTMLElement[] {
    return [...this.layersList.querySelectorAll<HTMLElement>('.me-layer')];
  }

  private updateLayerListItem(layerName: string) {
    for (const row of this.layerRows()) {
      if (row.dataset.layer === layerName) this.paintLayerRow(row);
    }
    this.paintStatus();
  }

  private updateLayerSelection() {
    for (const row of this.layerRows()) this.paintLayerRow(row);
    this.paintStatus();
  }

  private buildObjectList() {
    this.objectsList.replaceChildren();

    OBJECTS.forEach(({ type, glyph }) => {
      if (!this.objectLayerVisibility.has(type)) {
        this.objectLayerVisibility.set(type, true);
      }

      const row = el("div", "tl-list-row me-layer");
      row.setAttribute("role", "listitem");
      row.dataset.object = type;

      const open = el("button", "tl-list-open");
      open.type = "button";
      const kindMark = el("span", "me-kind me-kind-object");
      kindMark.appendChild(icon(glyph, 15));
      open.append(kindMark, el("span", "tl-list-name", type));
      open.addEventListener('click', () => this.send({ type: 'objectSelect', objectType: type }));

      const eye = iconButton("eye", "", () => {
        const newVisibility = !(this.objectLayerVisibility.get(type) ?? true);
        this.objectLayerVisibility.set(type, newVisibility);
        this.updateObjectListItem(type);
        this.send({ type: 'objectToggle', objectType: type, visible: newVisibility });
      }, { size: 15 });
      eye.classList.add("me-toggle");
      const actions = el("span", "me-layer-actions");
      actions.appendChild(eye);

      row.append(open, actions);
      this.objectsList.appendChild(row);
      this.paintObjectRow(row);
    });
  }

  private paintObjectRow(row: HTMLElement) {
    const type = row.dataset.object ?? "";
    const isVisible = this.objectLayerVisibility.get(type) ?? true;
    const isUnsaved = this.unsavedLayers.has(type);
    const isActive = this.selectedObject === type;
    row.classList.toggle("is-selected", isActive);
    row.classList.toggle("is-unseen", !isVisible);
    const open = row.querySelector<HTMLElement>(".tl-list-open")!;
    if (isActive) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
    open.title = `${type}: select to place, move and remove them in the game window${isUnsaved ? " (unsaved edits)" : ""}`;
    open.querySelector(".me-unsaved")?.remove();
    if (isUnsaved) {
      const dot = el("span", "me-unsaved");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "unsaved edits");
      open.appendChild(dot);
    }
    const eye = row.querySelector<HTMLButtonElement>(".me-toggle")!;
    setIcon(eye, isVisible ? "eye" : "eyeOff", 15);
    eye.classList.toggle("is-unseen", !isVisible);
    eye.setAttribute("aria-pressed", String(!isVisible));
    eye.setAttribute("aria-label", isVisible ? `Hide ${type}` : `Show ${type}`);
    tooltip(eye, isVisible ? "Hide in my game window" : "Hidden in my game window. Click to show.");
  }

  private objectRows(): HTMLElement[] {
    return [...this.objectsList.querySelectorAll<HTMLElement>('.me-layer')];
  }

  private updateObjectListItem(type: string) {
    for (const row of this.objectRows()) {
      if (row.dataset.object === type) this.paintObjectRow(row);
    }
  }

  private updateObjectSelection() {
    for (const row of this.objectRows()) this.paintObjectRow(row);
    this.paintStatus();
  }

  /** The object layers have unsaved edits of their own, which arrive with the tile layers'. */
  private paintObjectMarks() {
    for (const row of this.objectRows()) this.paintObjectRow(row);
  }

  // ---------------------------------------------------------------- tilesets

  private buildTilesetTabs() {
    this.tilesetTabs.replaceChildren();

    this.tilesets.forEach((tileset: any, index: number) => {
      const tabName = tileset.name || `Tileset ${index + 1}`;
      const tab = el("button", "tl-tab");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.appendChild(el("span", "", tabName));
      tab.title = tabName;
      tab.addEventListener('click', () => this.selectTileset(index));
      this.tilesetTabs.appendChild(tab);
    });
    this.paintTabEnds();

    if (this.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;

    const tabs = this.tilesetTabs.querySelectorAll<HTMLElement>('.tl-tab');
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      if (i === index) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    this.drawTileset();
    this.send({ type: 'tilesetSelect', index });
    this.pictureLate = false;
    this.paintStage();
    this.paintPicked();
  }

  /** Show the tiles `zoom` times their size. With a point of the palette given, the tile under it stays under it. */
  private setZoom(zoom: number, about?: { x: number; y: number }) {
    const box = this.tilesetContainer;
    const pad = this.tilesetCanvas.offsetLeft;
    const at = about ?? { x: box.clientWidth / 2, y: box.clientHeight / 2 };
    const tileX = (box.scrollLeft + at.x - pad) / this.zoom;
    const tileY = (box.scrollTop + at.y - pad) / this.zoom;
    this.zoom = zoom;
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // No storage here: the size is kept for this visit only.
    }
    for (const item of this.zoomSeg.querySelectorAll<HTMLElement>('[role="radio"]')) item.setAttribute("aria-checked", String(item.dataset.value === String(zoom)));
    oneStop(this.zoomSeg);
    this.sizeCanvas();
    box.scrollLeft = tileX * zoom + pad - at.x;
    box.scrollTop = tileY * zoom + pad - at.y;
  }

  /** How large the canvas is shown: its own pixels, each `zoom` across. What is drawn on it does not change. */
  private sizeCanvas() {
    this.tilesetCanvas.style.width = `${this.tilesetCanvas.width * this.zoom}px`;
    this.tilesetCanvas.style.height = `${this.tilesetCanvas.height * this.zoom}px`;
  }

  // --- Tileset Canvas Rendering ---

  private drawTileset() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const image = this.tilesetImages[this.currentTilesetIndex];

    if (!tileset || !image || !image.complete) return;

    const scale = 1;
    this.tilesetCanvas.width = tileset.imagewidth * scale;
    this.tilesetCanvas.height = tileset.imageheight * scale;
    this.sizeCanvas();

    this.tilesetCtx.imageSmoothingEnabled = false;
    this.tilesetCtx.drawImage(image, 0, 0, tileset.imagewidth * scale, tileset.imageheight * scale);

    const animatedTiles = this.getAnimatedTilesForTileset(tileset);
    if (animatedTiles.size > 0) {
      const animTilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
      const animTw = tileset.tilewidth * scale;
      const animTh = tileset.tileheight * scale;
      const animNow = performance.now();
      animatedTiles.forEach((info, localId) => {
        const col = localId % animTilesPerRow;
        const rowIdx = Math.floor(localId / animTilesPerRow);
        const destX = col * animTw;
        const destY = rowIdx * animTh;
        const frameTileId = this.getCurrentAnimationTileId(info.animation, info.totalDuration, animNow);
        const srcX = (frameTileId % animTilesPerRow) * tileset.tilewidth;
        const srcY = Math.floor(frameTileId / animTilesPerRow) * tileset.tileheight;

        this.tilesetCtx.clearRect(destX, destY, animTw, animTh);
        this.tilesetCtx.drawImage(
          image,
          srcX, srcY, tileset.tilewidth, tileset.tileheight,
          destX, destY, animTw, animTh
        );

        const badge = Math.max(4, Math.min(animTw, animTh) * 0.28);
        this.tilesetCtx.fillStyle = 'rgba(255, 210, 40, 0.9)';
        this.tilesetCtx.beginPath();
        this.tilesetCtx.moveTo(destX, destY);
        this.tilesetCtx.lineTo(destX + badge, destY);
        this.tilesetCtx.lineTo(destX, destY + badge);
        this.tilesetCtx.closePath();
        this.tilesetCtx.fill();
      });
    }

    this.tilesetCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.tilesetCtx.lineWidth = 1;

    const tileWidth = tileset.tilewidth * scale;
    const tileHeight = tileset.tileheight * scale;
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);

    this.tilesetCtx.beginPath();

    for (let x = 0; x <= cols; x++) {
      this.tilesetCtx.moveTo(x * tileWidth, 0);
      this.tilesetCtx.lineTo(x * tileWidth, rows * tileHeight);
    }

    for (let y = 0; y <= rows; y++) {
      this.tilesetCtx.moveTo(0, y * tileHeight);
      this.tilesetCtx.lineTo(cols * tileWidth, y * tileHeight);
    }

    this.tilesetCtx.stroke();

    if (this.view === "sounds") {
      this.drawSounds(tileset, tileWidth, tileHeight, cols);
      return;
    }

    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
      const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
      const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
      const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
      this.tilesetCtx.fillRect(minX * tileWidth, minY * tileHeight, (maxX - minX + 1) * tileWidth, (maxY - minY + 1) * tileHeight);

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 2;
      this.tilesetCtx.strokeRect(minX * tileWidth, minY * tileHeight, (maxX - minX + 1) * tileWidth, (maxY - minY + 1) * tileHeight);
    } else if (this.selectedTiles.length > 0 && !this.selectedTilesFromMap) {
      const height = this.selectedTiles.length;
      const width = this.selectedTiles[0].length;

      const firstTileId = this.selectedTiles[0][0];
      if (firstTileId >= tileset.firstgid && firstTileId < tileset.firstgid + tileset.tilecount) {
        const localTileId = firstTileId - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const startX = (localTileId % tilesPerRow);
        const startY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
        this.tilesetCtx.fillRect(startX * tileWidth, startY * tileHeight, width * tileWidth, height * tileHeight);

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(startX * tileWidth, startY * tileHeight, width * tileWidth, height * tileHeight);
      }
    } else if (this.selectedTile) {
      const baseGID = this.selectedTile & 0x0FFFFFFF;
      if (baseGID >= tileset.firstgid && baseGID < tileset.firstgid + tileset.tilecount) {
        const localTileId = baseGID - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const selectedX = (localTileId % tilesPerRow);
        const selectedY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(selectedX * tileWidth, selectedY * tileHeight, tileWidth, tileHeight);
      }
    }

    if (this.hoveredTilesetPos && !this.isSelectingTiles) {
      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      this.tilesetCtx.fillRect(this.hoveredTilesetPos.x * tileWidth, this.hoveredTilesetPos.y * tileHeight, tileWidth, tileHeight);
    }
  }

  private getAnimatedTilesForTileset(tileset: any): Map<number, { animation: Array<{ tileid: number; duration: number }>; totalDuration: number }> {
    const lookup = new Map<number, { animation: Array<{ tileid: number; duration: number }>; totalDuration: number }>();
    if (!tileset || !Array.isArray(tileset.tiles)) return lookup;
    for (const tile of tileset.tiles) {
      if (!Array.isArray(tile.animation) || tile.animation.length === 0) continue;
      const totalDuration = tile.animation.reduce((sum: number, frame: any) => sum + (frame.duration || 0), 0);
      lookup.set(tile.id, { animation: tile.animation, totalDuration });
    }
    return lookup;
  }

  private getCurrentAnimationTileId(animation: Array<{ tileid: number; duration: number }>, totalDuration: number, now: number): number {
    if (!animation || animation.length === 0) return 0;
    if (totalDuration <= 0) return animation[0].tileid;
    let t = now % totalDuration;
    for (let i = 0; i < animation.length; i++) {
      if (t < animation[i].duration) return animation[i].tileid;
      t -= animation[i].duration;
    }
    return animation[animation.length - 1].tileid;
  }

  private computePaletteAnimSignature(): string {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const animated = this.getAnimatedTilesForTileset(tileset);
    if (animated.size === 0) return '';
    const now = performance.now();
    let sig = '';
    animated.forEach((info, localId) => {
      sig += `${localId}:${this.getCurrentAnimationTileId(info.animation, info.totalDuration, now)};`;
    });
    return sig;
  }

  private startPaletteAnimation() {
    if (this.paletteAnimRunning) return;
    this.paletteAnimRunning = true;
    const tick = () => {
      if (this.tilesetCtx && this.tilesets.length > 0) {
        const sig = this.computePaletteAnimSignature();
        if (sig !== this.lastPaletteAnimSignature) {
          this.lastPaletteAnimSignature = sig;
          this.drawTileset();
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------- what is picked, in words

  /** Which tileset a tile belongs to, and where it is in it. */
  private placeOf(tileId: number): { tileset: any; column: number; row: number } | null {
    const base = tileId & 0x0FFFFFFF;
    for (const tileset of this.tilesets) {
      if (base < tileset.firstgid || base >= tileset.firstgid + tileset.tilecount) continue;
      const perRow = Math.max(1, Math.floor(tileset.imagewidth / tileset.tilewidth));
      const local = base - tileset.firstgid;
      return { tileset, column: local % perRow, row: Math.floor(local / perRow) };
    }
    return null;
  }

  /** How a picked tile has been turned with Rotate, from the marks the map format keeps on it. */
  private turnOf(tileId: number): string {
    const flags = (tileId & 0xE0000000) >>> 0;
    return flags === 0 ? "" : flags === 0xA0000000 ? ", turned a quarter" : flags === 0xC0000000 ? ", turned a half" : flags === 0x60000000 ? ", turned three quarters" : ", flipped";
  }

  /** Under the palette: what is picked to paint with. */
  private paintPicked() {
    if (this.view === "sounds") return this.paintSoundPicked();
    let said: string;
    let none = false;
    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const w = Math.abs(this.selectionEndTile.x - this.selectionStartTile.x) + 1;
      const h = Math.abs(this.selectionEndTile.y - this.selectionStartTile.y) + 1;
      said = w * h === 1 ? "Picking 1 tile" : `Picking ${num(w)} × ${num(h)} tiles`;
    } else if (this.selectedTiles.length > 0 && this.selectedTiles[0].length > 0) {
      const h = this.selectedTiles.length;
      const w = this.selectedTiles[0].length;
      const first = this.selectedTiles[0][0];
      const place = this.placeOf(first);
      const from = this.selectedTilesFromMap ? " from the map" : place ? ` from ${place.tileset.name || "the tileset"}` : "";
      if (w * h === 1) said = `Picked: 1 tile${from}${place && !this.selectedTilesFromMap ? `, column ${num(place.column + 1)}, row ${num(place.row + 1)}` : ""}${this.turnOf(first)}`;
      else said = `Picked: ${num(w)} × ${num(h)} tiles${from}${this.selectedTilesFromMap && first ? this.turnOf(first) : ""}`;
    } else if (this.selectedTile) {
      const place = this.placeOf(this.selectedTile);
      said = `Picked: 1 tile${place ? ` from ${place.tileset.name || "the tileset"}, column ${num(place.column + 1)}, row ${num(place.row + 1)}` : ""}${this.turnOf(this.selectedTile)}`;
    } else {
      said = "Nothing picked. Click a tile, or drag across several.";
      none = true;
    }
    this.pickedEl.classList.toggle("is-none", none);
    this.pickedEl.replaceChildren(el("span", "", said));
    this.pickedEl.title = said;
    this.paintUnder();
  }

  /** Under the palette, at the end: the tile under the pointer, or how large the tileset is. */
  private paintUnder() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return void (this.underEl.textContent = "");
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);
    const at = this.hoveredTilesetPos;
    if (at && at.x >= 0 && at.y >= 0 && at.x < cols && at.y < rows) this.underEl.textContent = `Column ${num(at.x + 1)}, row ${num(at.y + 1)}${this.view === "sounds" ? ` · ${this.soundWords(tileset, at.y * cols + at.x)}` : ""}`;
    else this.underEl.textContent = `${num(cols)} × ${num(rows)} tiles of ${num(tileset.tilewidth)} px`;
  }

  // --- Tileset Canvas Mouse Events ---

  private onTilesetMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if (this.view === "sounds") return this.soundMouseDown(e);

    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const containerRect = this.tilesetContainer.getBoundingClientRect();

    if (e.clientX < containerRect.left || e.clientX > containerRect.right ||
        e.clientY < containerRect.top || e.clientY > containerRect.bottom) {
      return;
    }

    // (the canvas is shown `zoom` times its size: a point on screen is that many times further in than the tile it is on)
    const x = (e.clientX - rect.left) / this.zoom;
    const y = (e.clientY - rect.top) / this.zoom;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    this.isSelectingTiles = true;
    this.selectionStartTile = { x: tileX, y: tileY };
    this.selectionEndTile = { x: tileX, y: tileY };

    this.drawTileset();
    this.paintPicked();
  }

  private onTilesetMouseUp(_e: MouseEvent) {
    if (this.view === "sounds") return this.soundMouseUp();
    if (!this.isSelectingTiles) return;

    this.isSelectingTiles = false;
    this.selectedTilesFromMap = false;

    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset || !this.selectionStartTile || !this.selectionEndTile) return;

    const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
    const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
    const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
    const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);

    this.selectedTiles = [];
    for (let y = minY; y <= maxY; y++) {
      const row: number[] = [];
      for (let x = minX; x <= maxX; x++) {
        const localTileId = y * tilesPerRow + x;
        const globalTileId = tileset.firstgid + localTileId;
        row.push(globalTileId);
      }
      this.selectedTiles.push(row);
    }

    if (this.selectedTiles.length === 1 && this.selectedTiles[0].length === 1) {
      this.selectedTile = this.selectedTiles[0][0];
    } else {
      this.selectedTile = null;
    }

    this.setTool('paint');

    this.send({
      type: 'tileSelect',
      tileId: this.selectedTile,
      tilesetIndex: this.currentTilesetIndex,
      selectedTiles: this.selectedTiles,
      selectedTilesFromMap: this.selectedTilesFromMap
    });

    this.drawTileset();
    this.paintTools();
    this.paintPicked();
  }

  private onTilesetMouseMove(e: MouseEvent) {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoom;
    const y = (e.clientY - rect.top) / this.zoom;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    if (this.soundDrag) {
      this.soundDrag.end = { x: tileX, y: tileY };
      this.drawTileset();
      this.paintPicked();
      return;
    }

    if (this.isSelectingTiles) {
      this.selectionEndTile = { x: tileX, y: tileY };
      this.drawTileset();
      this.paintPicked();
      return;
    }

    if (!this.hoveredTilesetPos || this.hoveredTilesetPos.x !== tileX || this.hoveredTilesetPos.y !== tileY) {
      this.hoveredTilesetPos = { x: tileX, y: tileY };
      this.drawTileset();
      this.paintUnder();
    }
  }

  private onTilesetMouseLeave() {
    // A drag in the Sounds tab that leaves the palette picks what it covered so far
    if (this.soundDrag) this.soundMouseUp();
    if (this.isSelectingTiles) {
      this.isSelectingTiles = false;
      this.drawTileset();
      this.paintPicked();
    }

    if (this.hoveredTilesetPos) {
      this.hoveredTilesetPos = null;
      this.drawTileset();
      this.paintUnder();
    }
  }

  // ------------------------------------------------------------- New map

  /**
   * New map (USER REQUEST 2026-10-19: "Add support for creating new maps within the editor. Allow defining map size,
   * infinite or not and optionally allow creating .world maps. Each map should be blank and upon creation, warp to
   * them."): a form, then the game window asks the server (CREATE_MAP), which makes it blank on the asset server and
   * moves the admin onto it. Loading the new map closes this window and opens the editor again there.
   */
  private async newMap() {
    if (!this.inited || this.creatingMap) return;
    if (this.unsavedLayers.size > 0) {
      const go = await confirmDialog({
        title: "Leave unsaved edits?",
        body: [`${count(this.unsavedLayers.size, "layer")} of ${this.mapName() || "this map"} ${this.unsavedLayers.size === 1 ? "has" : "have"} edits that are not saved.`, "Making a new map moves you onto it, and those edits are taken back. Save first to keep them."],
        okLabel: "Go on without saving",
      });
      if (!go) return;
    }
    void this.loadTilesetNames();
    const form = {
      name: "",
      kind: "map" as "map" | "world",
      width: 64,
      height: 64,
      infinite: false,
      // this map's own tilesets to start with: a new map is usually drawn from what this one is
      picked: new Set<string>(this.tilesets.map((t: any) => this.keyOf(t))),
    };
    // (USER FEEDBACK 2026-10-19, "clicking off the new map popup screen should not close it")
    const parts = openDialog("New map", { keepOnOutsideClick: true });
    const intro = el("p", "tl-muted me-newmap-lead", "A blank map with the layers every map has. You are moved onto it once it is made.");
    const grid = el("div", "tl-fields me-newmap-fields");
    const sets = el("div", "tl-checks me-newmap-sets");
    const wraps = new Map<string, HTMLElement>();
    const fields = new FieldRenderer({ rerender: () => paint() });
    const paint = () => {
      grid.replaceChildren();
      wraps.clear();
      const add = (field: any) => {
        const wrap = fields.renderField(field, form, () => setFieldError(wraps.get(field.key) ?? null, null));
        wraps.set(field.key, wrap);
        grid.appendChild(wrap);
      };
      const world = form.kind === "world";
      if (world) form.infinite = false;
      add({ key: "name", label: "Name", type: "text", maxLength: 48, placeholder: "my-map", hint: "Lower case letters, digits, - and _. It is what /warp takes." });
      add({
        key: "kind", label: "Kind", type: "segmented", rerender: true, options: () => [{ value: "map", label: "Map" }, { value: "world", label: "World" }],
        hint: world ? "A .world map, kept in chunks: for a large map." : "One map file: for a small map, a house, a cave, a dungeon.",
      });
      const lo = world ? WORLD_MIN : MAP_MIN, hi = world ? WORLD_MAX : MAP_MAX;
      const sizeHint = world ? `${num(lo)} to ${num(hi)}, in steps of ${WORLD_CHUNK}` : `${num(lo)} to ${num(hi)}`;
      add({ key: "width", label: "Width", type: "number", min: lo, max: hi, step: world ? WORLD_CHUNK : 1, unit: "tiles", hint: sizeHint, newRow: true });
      add({ key: "height", label: "Height", type: "number", min: lo, max: hi, step: world ? WORLD_CHUNK : 1, unit: "tiles", hint: sizeHint });
      if (!world) add({ key: "infinite", label: "Infinite", type: "switch", hint: "It grows as it is painted past its edges." });
      this.paintTilesetChoices(sets, form.picked);
    };
    paint();
    parts.body.append(intro, grid, el("h3", "me-newmap-head", "Tilesets"), sets);

    const create = button("Create and go there", () => {
      const wrong = this.newMapProblems(form);
      for (const [key, wrap] of wraps) setFieldError(wrap, wrong[key] ?? null);
      if (wrong.tilesets) toast(wrong.tilesets, "error");
      if (Object.keys(wrong).length) return;
      this.creatingMap = true;
      this.createBtn = create;
      setBusy(create, true);
      create.disabled = true;
      const tilesets = [...form.picked].map((key) => this.tilesetFiles.get(key) ?? `${key}.png`);
      this.send({ type: "createMap", map: { name: form.name.trim().toLowerCase(), kind: form.kind, width: form.width, height: form.height, infinite: form.infinite, tilesets } });
      this.createTimer = setTimeout(() => this.createMapDone("The map was not made: the server did not answer."), CREATE_WAIT_MS);
    }, { icon: "plus", kind: "primary" });
    parts.foot.append(button("Cancel", () => parts.close()), create);
  }

  /** What is wrong with the form, by field; nothing when it may be sent. The server checks it all again. */
  private newMapProblems(form: { name: string; kind: "map" | "world"; width: number; height: number; picked: Set<string> }): Record<string, string> {
    const wrong: Record<string, string> = {};
    const name = String(form.name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) wrong.name = "Lower case letters, digits, - and _ only, starting with a letter or digit.";
    const world = form.kind === "world";
    const lo = world ? WORLD_MIN : MAP_MIN, hi = world ? WORLD_MAX : MAP_MAX;
    for (const key of ["width", "height"] as const) {
      const n = form[key];
      if (!Number.isInteger(n) || n < lo || n > hi) wrong[key] = `${num(lo)} to ${num(hi)} tiles.`;
      else if (world && n % WORLD_CHUNK !== 0) wrong[key] = `A world is whole chunks: a multiple of ${WORLD_CHUNK}.`;
    }
    if (form.picked.size === 0) wrong.tilesets = "Pick at least one tileset.";
    return wrong;
  }

  /** The asset server's tileset pictures, asked for each time the form opens (one added since is then offered too). */
  private async loadTilesetNames(): Promise<void> {
    try {
      // (never the browser's cache: a permanent redirect kept from before the route existed broke /tile-sounds so)
      const res = await fetch(`${config.ASSET_SERVER_URL}/tileset-list`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      for (const file of Array.isArray(body?.tilesets) ? body.tilesets : []) {
        const name = String(file);
        this.tilesetFiles.set(name.replace(/\.[^.]+$/, "").toLowerCase(), name);
      }
      if (this.tilesetSetsEl && this.tilesetPicked) this.paintTilesetChoices(this.tilesetSetsEl, this.tilesetPicked);
    } catch {
      // No list: this map's own tilesets are offered.
    }
  }

  /** A tick box for each tileset there is (the asset server's, and this map's), ticked for those picked. */
  private paintTilesetChoices(box: HTMLElement, picked: Set<string>) {
    this.tilesetSetsEl = box;
    this.tilesetPicked = picked;
    const keys = new Set<string>([...this.tilesetFiles.keys(), ...this.tilesets.map((t: any) => this.keyOf(t))]);
    box.replaceChildren();
    for (const key of [...keys].sort()) {
      const row = el("label", "tl-check");
      const box1 = el("input");
      box1.type = "checkbox";
      box1.checked = picked.has(key);
      box1.addEventListener("change", () => {
        if (box1.checked) picked.add(key);
        else picked.delete(key);
      });
      row.append(box1, el("span", "", key));
      box.appendChild(row);
    }
  }

  /** A New map came to an end without moving here: the server refused it (why, when it said), or did not answer. */
  private createMapDone(why?: string) {
    if (this.createTimer) clearTimeout(this.createTimer);
    this.createTimer = null;
    if (!this.creatingMap) return;
    this.creatingMap = false;
    if (this.createBtn) {
      setBusy(this.createBtn, false);
      this.createBtn.disabled = false;
    }
    if (why) toast(why, "error");
  }

  // ------------------------------------------------------------- the Sounds tab

  /** A tileset's key in the list of tile sounds (the game window sends it: the picture's name, in lower case). */
  private keyOf(tileset: any): string {
    return String(tileset?.key || tileset?.name || "").trim().toLowerCase();
  }

  /** Show the Paint tab or the Sounds tab. The tiles picked in each are kept apart. */
  private setView(view: View, keep = true) {
    this.view = view;
    for (const tab of this.viewTabs.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const on = tab.dataset.value === view;
      tab.setAttribute("aria-selected", String(on));
      tab.setAttribute("aria-checked", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    this.paintBar.hidden = view !== "paint";
    this.soundBar.hidden = view !== "sounds";
    if (keep) {
      try {
        localStorage.setItem(VIEW_KEY, view);
      } catch {
        // No storage here: the window opens on Paint next time.
      }
    }
    this.soundDrag = null;
    this.isSelectingTiles = false;
    if (view === "sounds") void this.loadAudio();
    this.drawTileset();
    this.paintPicked();
    this.paintSoundLegend();
  }

  private buildSoundBar() {
    this.soundPickBtn = button("Choose a sound", () => this.chooseSound(), { icon: "megaphone" });
    this.soundPickBtn.classList.add("me-sound-pick");
    this.soundPlayBtn = iconButton("play", "Play the sound", () => this.playSound());
    this.soundApplyBtn = button("Apply", () => this.applySound(this.chosenSound), { icon: "check", kind: "primary", tip: "Give the picked tiles this sound, on every map that uses the tileset" });
    this.soundResetBtn = button("Use the map's own", () => this.applySound(null), { icon: "undo", kind: "quiet", fold: true, tip: "Take the picked tiles off the list: each sounds again as its map says" });
    const same = button("Pick all with it", () => this.pickSame(), { icon: "target", kind: "quiet", fold: true, tip: "Pick every tile of this tileset that has the chosen sound now" });
    same.classList.add("me-sound-same");
    const clear = button("Pick none", () => this.pickNone(), { icon: "close", kind: "quiet", fold: true, tip: "Pick no tiles (Esc)" });
    const end = el("div", "me-toolbar-end");
    end.append(same, clear);
    this.soundBar.append(el("span", "me-toolbar-title", "Sound"), this.soundPickBtn, this.soundPlayBtn, this.soundApplyBtn, this.soundResetBtn, end);
    this.soundLegendEl.hidden = true;
  }

  /** The asset server's audio files, asked for the first time the tab is shown (once more after a failure). */
  private async loadAudio(): Promise<void> {
    if (this.audioState === "loading" || this.audioState === "loaded") return;
    this.audioState = "loading";
    try {
      const res = await fetch(`${config.ASSET_SERVER_URL}/audios`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const seen = new Set<string>();
      this.audio = (Array.isArray(body?.audio) ? body.audio : [])
        .map((entry: any) => String(entry?.name ?? ""))
        .filter((file: string) => file && !seen.has(audioName(file)) && !!seen.add(audioName(file)))
        .map((file: string) => ({ value: audioName(file), label: file.replace(/\.[^.]+$/, "") }))
        .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));
      this.audioState = "loaded";
    } catch {
      this.audioState = "failed";
    }
    this.paintSoundBar();
  }

  /** Every tile of a tileset that makes a sound or is kept silent: its sound ("" for none), and whether the list says so (else its map does). */
  private soundsOf(tileset: any): Map<number, { sound: string; set: boolean }> {
    const out = new Map<number, { sound: string; set: boolean }>();
    for (const t of tileset?.tiles ?? []) {
      const p = (t?.properties ?? []).find((q: any) => String(q?.name).toLowerCase() === "footstep_sound");
      if (p && typeof p.value === "string" && p.value.trim()) out.set(Number(t.id), { sound: p.value.trim().toLowerCase(), set: false });
    }
    for (const [id, sound] of Object.entries(this.tileSounds[this.keyOf(tileset)] ?? {})) out.set(Number(id), { sound: String(sound), set: true });
    return out;
  }

  /** A tile's sound, in words. */
  private soundWords(tileset: any, id: number): string {
    const it = this.soundsOf(tileset).get(id);
    if (!it) return "no sound";
    if (!it.sound) return "no sound (set here)";
    return `${it.sound} (${it.set ? "set here" : "from the map"})`;
  }

  /** The tiles picked in the tileset in view. */
  private pickedHere(): Set<number> {
    let set = this.soundPicked.get(this.currentTilesetIndex);
    if (!set) this.soundPicked.set(this.currentTilesetIndex, set = new Set());
    return set;
  }

  /** On the palette: each tile's sound in its own colour (strong with an edge when set here), the silenced ones dark, then what is picked. */
  private drawSounds(tileset: any, tw: number, th: number, cols: number) {
    const ctx = this.tilesetCtx;
    for (const [id, { sound, set }] of this.soundsOf(tileset)) {
      const x = (id % cols) * tw, y = Math.floor(id / cols) * th;
      if (!sound) {
        ctx.fillStyle = "rgba(2, 6, 23, 0.6)";
        ctx.fillRect(x, y, tw, th);
        ctx.strokeStyle = "rgba(248, 113, 113, 0.95)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 3);
        ctx.lineTo(x + tw - 3, y + th - 3);
        ctx.stroke();
        continue;
      }
      const hue = soundHue(sound);
      ctx.fillStyle = `hsla(${hue}, 85%, 55%, ${set ? 0.45 : 0.25})`;
      ctx.fillRect(x, y, tw, th);
      if (set) {
        ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 1)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y + 1.5, tw - 3, th - 3);
        // (USER REPORT 2026-10-19, sounds set on snow tiles looked "gone after reload": a tint is lost on pale tiles) a
        // solid corner in the sound's colour, outlined dark, marks a tile set here on any art
        const k = Math.max(5, Math.round(Math.min(tw, th) * 0.45));
        ctx.beginPath();
        ctx.moveTo(x + tw, y + th - k);
        ctx.lineTo(x + tw, y + th);
        ctx.lineTo(x + tw - k, y + th);
        ctx.closePath();
        ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        ctx.fill();
        ctx.strokeStyle = "rgba(2, 6, 23, 0.9)";
        ctx.stroke();
      }
    }
    ctx.fillStyle = "rgba(0, 150, 255, 0.4)";
    ctx.strokeStyle = "rgba(0, 150, 255, 1)";
    ctx.lineWidth = 1;
    for (const id of this.soundPicked.get(this.currentTilesetIndex) ?? []) {
      const x = (id % cols) * tw, y = Math.floor(id / cols) * th;
      ctx.fillRect(x, y, tw, th);
      ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
    }
    const d = this.soundDrag;
    if (d) {
      const minX = Math.min(d.start.x, d.end.x), maxX = Math.max(d.start.x, d.end.x);
      const minY = Math.min(d.start.y, d.end.y), maxY = Math.max(d.start.y, d.end.y);
      const rgb = d.mode === "remove" ? "248, 113, 113" : "0, 150, 255";
      ctx.fillStyle = `rgba(${rgb}, 0.25)`;
      ctx.fillRect(minX * tw, minY * th, (maxX - minX + 1) * tw, (maxY - minY + 1) * th);
      ctx.strokeStyle = `rgba(${rgb}, 1)`;
      ctx.lineWidth = 2;
      ctx.strokeRect(minX * tw, minY * th, (maxX - minX + 1) * tw, (maxY - minY + 1) * th);
    } else if (this.hoveredTilesetPos) {
      ctx.fillStyle = "rgba(0, 150, 255, 0.4)";
      ctx.fillRect(this.hoveredTilesetPos.x * tw, this.hoveredTilesetPos.y * th, tw, th);
    }
  }

  /** Under the palette: how many tiles are picked, and the sound they share. */
  private paintSoundPicked() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const picked = this.soundPicked.get(this.currentTilesetIndex) ?? new Set<number>();
    let said: string;
    let none = false;
    const d = this.soundDrag;
    if (d) {
      const w = Math.abs(d.end.x - d.start.x) + 1, h = Math.abs(d.end.y - d.start.y) + 1;
      said = `${d.mode === "remove" ? "Taking away" : d.mode === "add" ? "Adding" : "Picking"} ${w * h === 1 ? "1 tile" : `${num(w)} × ${num(h)} tiles`}`;
    } else if (picked.size > 0 && tileset) {
      const sounds = this.soundsOf(tileset), shared = new Set<string>();
      for (const id of picked) shared.add(sounds.get(id)?.sound ?? "");
      const one = shared.size === 1 ? [...shared][0] : null;
      said = `${count(picked.size, "tile")} picked · ${one === null ? `${num(shared.size)} different sounds` : one ? `all ${one}` : "none makes a sound"}`;
    } else {
      said = "Nothing picked. Click a tile or drag across several; Shift adds, Alt takes away.";
      none = true;
    }
    this.pickedEl.classList.toggle("is-none", none);
    this.pickedEl.replaceChildren(el("span", "", said));
    this.pickedEl.title = said;
    this.paintUnder();
    this.paintSoundBar();
    this.paintSoundLegend();
  }

  /** The sound bar: the chosen sound on its button, and what can be done now. */
  private paintSoundBar() {
    if (!this.soundPickBtn) return;
    const picked = this.soundPicked.get(this.currentTilesetIndex)?.size ?? 0;
    const label = this.chosenSound === null ? "Choose a sound" : this.chosenSound === "" ? "No sound" : this.chosenSound;
    this.soundPickBtn.querySelector("span")!.textContent = label;
    this.soundPickBtn.title = this.audioState === "failed" ? "The asset server's audio files could not be listed. Click to try again." : "The footstep sound to give the picked tiles, from the asset server's audio files";
    this.soundPlayBtn.disabled = !this.chosenSound;
    const busy = this.soundSaving !== null;
    this.soundApplyBtn.querySelector("span")!.textContent = picked > 0 ? `Apply to ${count(picked, "tile")}` : "Apply";
    this.soundApplyBtn.disabled = busy || picked === 0 || this.chosenSound === null || !this.inited;
    this.soundApplyBtn.title = picked === 0 ? "Pick tiles first" : this.chosenSound === null ? "Choose a sound first" : "Give the picked tiles this sound, on every map that uses the tileset (Enter)";
    this.soundResetBtn.disabled = busy || picked === 0 || !this.inited;
    const same = this.soundBar.querySelector<HTMLButtonElement>(".me-sound-same");
    if (same) same.disabled = this.chosenSound === null;
  }

  /** At the foot of the palette: the sounds of the tileset in view, in their colours, most used first. */
  private paintSoundLegend() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    this.soundLegendEl.replaceChildren();
    this.soundLegendEl.hidden = this.view !== "sounds" || !tileset;
    if (this.soundLegendEl.hidden) return;
    const counts = new Map<string, number>();
    for (const { sound } of this.soundsOf(tileset).values()) counts.set(sound, (counts.get(sound) ?? 0) + 1);
    const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (list.length === 0) {
      this.soundLegendEl.appendChild(el("span", "", "No tile of this tileset makes a sound yet"));
      return;
    }
    for (const [sound, n] of list.slice(0, 5)) {
      const key = el("span", "me-sound-key");
      const swatch = el("span", "me-sound-swatch");
      swatch.style.background = sound ? `hsl(${soundHue(sound)}, 85%, 55%)` : "rgba(2, 6, 23, 0.9)";
      if (!sound) swatch.style.boxShadow = "inset 0 0 0 1px rgba(248, 113, 113, 0.95)";
      key.append(swatch, el("span", "", `${sound || "no sound"} ${num(n)}`));
      this.soundLegendEl.appendChild(key);
    }
    if (list.length > 5) this.soundLegendEl.appendChild(el("span", "", `and ${num(list.length - 5)} more`));
    tooltip(this.soundLegendEl, "Tiles with a sound are tinted in its colour: strongly, with an edge and a solid corner, when it was set here; lightly when the map gives it. Dark with a red stroke: set here to make no sound.");
  }

  /** The tile under the pointer, or null off the tileset. */
  private soundTileAt(e: MouseEvent): { x: number; y: number } | null {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return null;
    const rect = this.tilesetCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.zoom / tileset.tilewidth);
    const y = Math.floor((e.clientY - rect.top) / this.zoom / tileset.tileheight);
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth), rows = Math.floor(tileset.imageheight / tileset.tileheight);
    return x >= 0 && y >= 0 && x < cols && y < rows ? { x, y } : null;
  }

  /** A click or a drag: picks those tiles (in place of the others), with Shift or Ctrl adds them, with Alt takes them away. */
  private soundMouseDown(e: MouseEvent) {
    const at = this.soundTileAt(e);
    if (!at) return;
    const mode = e.altKey ? "remove" : e.shiftKey || e.ctrlKey || e.metaKey ? "add" : "set";
    this.soundDrag = { start: at, end: at, mode };
    this.drawTileset();
    this.paintPicked();
  }

  private soundMouseUp() {
    const d = this.soundDrag;
    this.soundDrag = null;
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!d || !tileset) return;
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const ids: number[] = [];
    for (let y = Math.min(d.start.y, d.end.y); y <= Math.max(d.start.y, d.end.y); y++) {
      for (let x = Math.min(d.start.x, d.end.x); x <= Math.max(d.start.x, d.end.x); x++) {
        const id = y * cols + x;
        if (x >= 0 && y >= 0 && x < cols && id < tileset.tilecount) ids.push(id);
      }
    }
    const set = this.pickedHere();
    const one = ids.length === 1 ? ids[0] : null;
    if (d.mode === "set") {
      // A click on the only tile picked takes it away again
      const again = one !== null && set.size === 1 && set.has(one);
      set.clear();
      if (!again) for (const id of ids) set.add(id);
    } else if (d.mode === "add") {
      // Ctrl or Shift and a click on a picked tile takes that one away
      if (one !== null && set.has(one)) set.delete(one);
      else for (const id of ids) set.add(id);
    } else {
      for (const id of ids) set.delete(id);
    }
    this.drawTileset();
    this.paintPicked();
  }

  private soundKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this.save();
      return;
    }
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      this.send({ type: 'command', name: 'undo' });
      return;
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      this.send({ type: 'command', name: 'redo' });
      return;
    }
    if (e.ctrlKey && e.key === 'a') {
      e.preventDefault();
      const tileset = this.tilesets[this.currentTilesetIndex];
      if (!tileset) return;
      const set = this.pickedHere();
      for (let id = 0; id < tileset.tilecount; id++) set.add(id);
      this.drawTileset();
      this.paintPicked();
      return;
    }
    if (e.key === 'Escape') {
      this.pickNone();
      return;
    }
    if (e.key === 'Enter' && !this.soundApplyBtn.disabled && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
      e.preventDefault();
      this.applySound(this.chosenSound);
    }
  }

  private pickNone() {
    this.soundPicked.get(this.currentTilesetIndex)?.clear();
    this.drawTileset();
    this.paintPicked();
  }

  /** Pick every tile of the tileset in view that has the chosen sound now (no sound: the tiles set here to make none). */
  private pickSame() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset || this.chosenSound === null) return;
    const set = this.pickedHere();
    set.clear();
    for (const [id, { sound }] of this.soundsOf(tileset)) if (sound === this.chosenSound) set.add(id);
    if (set.size === 0) toast(`No tile of ${tileset.name || "this tileset"} has ${this.chosenSound ? `the sound ${this.chosenSound}` : "its sound taken away"}.`);
    this.drawTileset();
    this.paintPicked();
  }

  /** The searchable list of the asset server's audio files, and No sound. */
  private chooseSound() {
    if (this.audioState === "failed" || this.audioState === "none") void this.loadAudio();
    if (this.audioState !== "loaded") {
      toast(this.audioState === "loading" ? "The audio files are still being listed. Try again in a moment." : "The asset server's audio files could not be listed.", this.audioState === "loading" ? "info" : "error");
      return;
    }
    const options = [{ value: "", label: "No sound" }, ...this.audio];
    this.fields.openAssetPicker("Footstep sound", options, (option) => {
      this.chosenSound = String(option.value);
      this.paintSoundBar();
      // Enter in the picker's search picks a sound: the same key press must not also press the button focused after
      // it (it did: Apply ran at once). The focus moves to Apply once the key is done with.
      (document.activeElement as HTMLElement | null)?.blur();
      setTimeout(() => this.soundApplyBtn.focus(), 0);
    }, { icons: false, current: this.chosenSound ?? undefined, fallback: "megaphone" });
  }

  /** Hear the chosen sound once, as the asset server has it. */
  private playSound() {
    if (!this.chosenSound) return;
    this.preview?.pause();
    this.preview = new Audio(`${config.ASSET_SERVER_URL}/audio?name=${encodeURIComponent(this.chosenSound)}`);
    this.preview.volume = 0.6;
    this.preview.play().catch(() => toast(`${this.chosenSound} could not be played.`, "error"));
  }

  /**
   * Give the picked tiles a sound ("" for none), or with null take them off the list. The game window passes it to
   * the server, which keeps it on the asset server and sends the list again to everyone (handleTileSoundsUpdate).
   */
  private applySound(sound: string | null) {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const ids = [...(this.soundPicked.get(this.currentTilesetIndex) ?? [])].sort((a, b) => a - b);
    if (!tileset || ids.length === 0 || this.soundSaving) return;
    if (sound === null && !ids.some((id) => this.tileSounds[this.keyOf(tileset)]?.[String(id)] !== undefined)) {
      toast("None of the picked tiles has a sound set here: they already sound as their map says.");
      return;
    }
    this.soundSaving = { key: this.keyOf(tileset), ids, sound };
    this.send({ type: 'tileSoundsSave', changes: [{ tileset: this.keyOf(tileset), ids, sound }] });
    setBusy(this.soundApplyBtn, true);
    this.paintSoundBar();
    if (this.soundSaveTimer) clearTimeout(this.soundSaveTimer);
    this.soundSaveTimer = setTimeout(() => {
      this.soundSaveDone();
      toast("The sounds were not saved: the server did not answer.\nThe game window shows the reason when it gave one (an account that may not save maps, for one).", "error");
    }, SOUND_SAVE_WAIT_MS);
  }

  private soundSaveDone() {
    if (this.soundSaveTimer) clearTimeout(this.soundSaveTimer);
    this.soundSaveTimer = null;
    this.soundSaving = null;
    setBusy(this.soundApplyBtn, false);
    this.paintSoundBar();
  }

  /** The list of tile sounds as it is now, after a save (this window's or anyone's). */
  private handleTileSoundsUpdate(msg: any) {
    this.tileSounds = msg.tileSounds && typeof msg.tileSounds === "object" ? msg.tileSounds : {};
    // Only the list with this window's change in it answers its save: the list also comes when the game window first
    // fetches it, and after anyone else's save, and neither of those says this one was kept
    const saved = this.soundSaving;
    const row = saved ? this.tileSounds[saved.key] ?? {} : {};
    if (saved && saved.ids.every((id) => (saved.sound === null ? row[String(id)] === undefined : row[String(id)] === saved.sound))) {
      this.soundSaveDone();
      toast(`Saved for ${count(saved.ids.length, "tile")}, on every map: ${saved.sound === null ? "back to the map's own sound" : saved.sound || "no sound"}.`);
    }
    this.drawTileset();
    this.paintPicked();
  }

  // --- Tileset Panning ---

  private onTilesetPanStart(e: MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();
    this.isPanningTileset = true;
    this.tilesetPanStartX = e.clientX;
    this.tilesetPanStartY = e.clientY;
    this.tilesetScrollStartX = this.tilesetContainer.scrollLeft;
    this.tilesetScrollStartY = this.tilesetContainer.scrollTop;
    this.tilesetContainer.classList.add("is-panning");
  }

  private onTilesetPan(e: MouseEvent) {
    if (!this.isPanningTileset) return;
    e.preventDefault();
    const deltaX = e.clientX - this.tilesetPanStartX;
    const deltaY = e.clientY - this.tilesetPanStartY;
    this.tilesetContainer.scrollLeft = this.tilesetScrollStartX - deltaX;
    this.tilesetContainer.scrollTop = this.tilesetScrollStartY - deltaY;
  }

  private onTilesetPanEnd(_e: MouseEvent) {
    if (!this.isPanningTileset) return;
    this.isPanningTileset = false;
    this.tilesetContainer.classList.remove("is-panning");
  }
}

new TileEditorBridge();
