// Gathering editor popup (/gathering). USER REQUEST 2026-10-17: "Add a gathering system with an editor that allows
// setting the item to spawn (image) selectable from the asset server. Able to configure spawn rate and preview how
// dense it will look". Talks to the game window over postMessage; the game window forwards the requests to the
// server (engine src/systems/gathering/editor.ts), which validates and saves, and draws the preview in the world.
// The window itself is the shared workbench (tooleditor.ts).
//
// A record is an area of the map the admin is on: a circle where nodes of one item spawn. The list holds every area
// of that map; there are few, so it is searched here, at every key.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";

interface Area {
  id: number | null;
  x: number | null; y: number | null; radius: number | null;
  // how big a node is drawn: its picture's longest side, px
  size: number | null;
  item: string;
  quantity_min: number | null; quantity_max: number | null;
  max_nodes: number | null;
  respawn_min_s: number | null; respawn_max_s: number | null;
  enabled: boolean;
}
interface EditorItem { name: string; image: string | null }
interface Limits { radiusMin: number; radiusMax: number; sizeMin: number; sizeMax: number; quantityMax: number; nodesMax: number; respawnMax: number; coordinateMax: number }
interface EditorData { here: string; areas: Area[]; items: EditorItem[]; limits: Limits; ready: boolean }

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const seconds = (s: number | null) => (s === null ? "?" : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

class GatheringEditorBridge {
  private data: EditorData = { here: "", areas: [], items: [], limits: { radiusMin: 32, radiusMax: 4096, sizeMin: 8, sizeMax: 128, quantityMax: 999, nodesMax: 200, respawnMax: 86400, coordinateMax: 1_000_000 }, ready: true };
  private ready = false;
  private draft: Area | null = null;
  private opened = 0;
  private dirty = false;
  private refused = false;
  private query = "";
  private previewing = false;
  private previewNote: string | null = null;
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The redraw of the preview waiting for typing to pause. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  private shell = new EditorShell({
    tool: "Gathering Editor", noun: "area", icon: "box", liveSearch: true,
    onSearch: (query) => { this.query = query; this.renderList(); },
    onNew: () => void this.startNew(),
    onSave: () => this.save(),
    onDelete: () => void this.deleteEntry(),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
    window.addEventListener("beforeunload", () => this.shell.send({ type: "clearPreview" }));
  }

  private askForList(): void {
    this.shell.send({ type: "request", packet: "GATHERING_EDITOR_LIST", data: {} });
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "data":
        this.adopt(msg.data);
        this.renderList();
        this.renderForm();
        break;
      case "mapChanged":
        this.draft = null;
        this.dirty = false;
        this.previewing = false;
        this.askForList();
        break;
      case "result": {
        if (msg.action === "GATHERING_EDITOR_PREVIEW") {
          // a refused preview
          this.previewing = false;
          this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
          this.showProblems(msg.errors ?? []);
          return;
        }
        const mine = !!this.pending && msg.action === this.pending.packet;
        if (!mine) {
          if (msg.data) this.adopt(msg.data);
          this.renderList();
          if (this.ready) this.renderForm();
          return;
        }
        const kind = this.pending!.kind;
        this.endRequest();
        if (kind === "save") this.onSaveResult(msg);
        else this.onDeleteResult(msg);
        this.renderList();
        break;
      }
      case "preview":
        this.previewing = true;
        this.previewNote = msg.note ?? `${count(Number(msg.count) || 0, "node")} drawn in the game, where they would stand.`;
        this.renderForm();
        break;
      case "updated":
        toast(`${shown(msg.by)} changed the gathering areas. The list shows them as they are now.`);
        this.askForList();
        break;
      case "standing":
        if (this.draft && lower(msg.map) === lower(this.data.here)) {
          this.draft.x = Number(msg.x);
          this.draft.y = Number(msg.y);
          this.changed();
        }
        break;
    }
  }

  private adopt(data: any): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.areas)) this.data.areas = [];
    if (!Array.isArray(this.data.items)) this.data.items = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.areas.length);
    if (!this.draft || this.dirty || this.pending || this.draft.id === null) return;
    const now = this.find(this.draft.id);
    this.draft = now ? clone(now) : null;
    // the area was deleted elsewhere: nothing is left to hide the preview with
    if (!this.draft) this.stopPreview();
  }

  /** Hides the preview in the game and forgets any redraw waiting to be asked for. */
  private stopPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewing = false;
    this.previewNote = null;
    this.shell.send({ type: "clearPreview" });
  }

  private find(id: number | null): Area | undefined {
    return id === null ? undefined : this.data.areas.find((a) => a.id === id);
  }

  private iconOf(item: string): string | null {
    return this.data.items.find((i) => lower(i.name) === lower(item))?.image ?? null;
  }

  private onSaveResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data);
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.previewing = false;
    this.clearProblems();
    if (this.draft) this.draft.id = Number(msg.id);
    this.adopt(msg.data);
    toast("Saved the area. Its nodes spawn now.");
    this.renderForm();
  }

  private onDeleteResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data);
      void noticeDialog("The area was not deleted", msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
      this.renderForm();
      return;
    }
    this.draft = null;
    this.dirty = false;
    this.stopPreview();
    this.clearProblems();
    this.adopt(msg.data);
    toast("Deleted the area. Its nodes are gone.");
    this.renderForm();
  }

  // ------------------------------------------------------------------ rules

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const l = this.data.limits;
    const whole = (key: keyof Area, min: number, max: number, label: string) => {
      const v = d[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors[key] = `${label} must be a whole number from ${min} to ${max}.`;
    };
    whole("x", 0, l.coordinateMax, "X");
    whole("y", 0, l.coordinateMax, "Y");
    whole("radius", l.radiusMin, l.radiusMax, "Radius");
    whole("size", l.sizeMin, l.sizeMax, "Size");
    whole("quantity_min", 1, l.quantityMax, "Least per gather");
    whole("quantity_max", 1, l.quantityMax, "Most per gather");
    whole("max_nodes", 1, l.nodesMax, "Nodes at once");
    whole("respawn_min_s", 0, l.respawnMax, "Shortest regrow");
    whole("respawn_max_s", 0, l.respawnMax, "Longest regrow");
    if (!errors["quantity_max"] && Number(d.quantity_min) > Number(d.quantity_max)) errors["quantity_max"] = "Most per gather can't be less than least per gather.";
    if (!errors["respawn_max_s"] && Number(d.respawn_min_s) > Number(d.respawn_max_s)) errors["respawn_max_s"] = "Longest regrow can't be shorter than shortest regrow.";
    if (!this.data.items.some((i) => lower(i.name) === lower(d.item))) errors["item"] = "Pick an item.";
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
    this.shell.setProblems(this.problemLines());
    this.renderForm();
  }

  // ---------------------------------------------------------------- in words

  private noteOf(a: Area): string {
    const parts = [`${a.max_nodes} at once`, `regrow ${seconds(a.respawn_min_s)} to ${seconds(a.respawn_max_s)}`];
    return a.enabled ? parts.join(" · ") : `Off · ${parts.join(" · ")}`;
  }

  private summary(): string[] {
    const d = this.draft!;
    const lines = [
      `Up to ${d.max_nodes ?? "?"} ${d.item || "nodes"} stand at once inside ${d.radius ?? "?"} px of (${d.x ?? "?"}, ${d.y ?? "?"}), on each layer of ${this.data.here}.`,
      `One gather takes 1 s and gives ${d.quantity_min ?? "?"} to ${d.quantity_max ?? "?"}. A gathered node grows back in ${seconds(d.respawn_min_s)} to ${seconds(d.respawn_max_s)}, somewhere else in the circle.`,
    ];
    if (!d.enabled) lines.push("It is off: nothing spawns until it is turned on and saved.");
    lines.push("Preview draws where the nodes would stand, in the game, only for you.");
    return lines;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const rows: ListRow[] = this.data.areas
      .filter((a) => !this.query || lower(a.item).includes(lower(this.query)))
      .map((a) => ({
        id: String(a.id), name: a.item, note: this.noteOf(a), selected: a.id === this.draft?.id,
        thumb: thumb(this.iconOf(a.item), { fallback: "box" }),
        tags: a.enabled ? [] : [tag("Off")],
        onOpen: () => void this.select(a.id),
      }));
    this.shell.setList({
      rows,
      empty: this.query
        ? { icon: "search", title: "No area gives that item", text: "Check the spelling." }
        : { title: "No area on this map", text: "New adds one where you stand." },
      foot: `The areas of ${this.data.here}. Go to another map to edit its areas.`,
    });
  }

  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    const missing = this.data.ready ? null : { tone: "danger" as const, icon: "alert" as const, text: "The gathering_areas table could not be made when the game server started, so nothing can be saved. The server log says why." };
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setBanner(missing);
      return;
    }
    shell.setRecord({ title: d.item || "New area", note: `Gathering area · ${this.data.here}`, thumb: thumb(this.iconOf(d.item), { size: "lg", fallback: "box" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending?.kind === "delete" ? "deleting" : this.refused ? "error" : d.id === null ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty || d.id === null,
      busy: this.pending ? this.pending.kind : null,
      canSave: this.data.ready, canDelete: d.id !== null,
      why: { delete: "It is not saved yet" },
      deleteTip: "Delete the area: its nodes go at once",
    });
    shell.setBanner(missing);
  }

  private itemAssets(): AssetOption[] {
    return this.data.items.map((i) => ({ value: i.name, label: i.name, image: i.image }));
  }

  private renderForm(): void {
    this.chrome();
    if (!this.ready) return;
    const d = this.draft;
    if (!d) {
      const box = this.shell.idle("Pick an area from the list on the left, or add one where you stand.", null);
      box.appendChild(button("New area", () => void this.startNew(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}`, { aside: true });
    const l = this.data.limits;

    const what = card(main, "What spawns", "The item a gather gives. Its icon is what stands in the world.");
    const whatGrid = el("div", "tl-fields tl-fields-2");
    what.body.appendChild(whatGrid);
    whatGrid.appendChild(this.field({ key: "item", label: "Item", type: "asset", assets: () => this.itemAssets(), fallback: "box", wide: true, rerender: true }));
    whatGrid.appendChild(this.field({ key: "size", label: "Size", type: "number", min: l.sizeMin, max: l.sizeMax, step: 1, unit: "px", hint: "The longest side of its picture in the world. The other side keeps its proportion.", wide: true }));
    whatGrid.appendChild(this.field({ key: "quantity_min", label: "Least per gather", type: "number", min: 1, max: l.quantityMax, step: 1 }));
    whatGrid.appendChild(this.field({ key: "quantity_max", label: "Most per gather", type: "number", min: 1, max: l.quantityMax, step: 1 }));

    const where = card(main, "Where", "A circle on this map, in px from its top left");
    where.tools.append(button("Use my position", () => this.shell.send({ type: "whereAmI" }), { icon: "pin", kind: "quiet" }));
    const whereGrid = el("div", "tl-fields tl-fields-2");
    where.body.appendChild(whereGrid);
    whereGrid.appendChild(this.field({ key: "x", label: "X", type: "number", min: 0, max: l.coordinateMax, step: 1, unit: "px" }));
    whereGrid.appendChild(this.field({ key: "y", label: "Y", type: "number", min: 0, max: l.coordinateMax, step: 1, unit: "px" }));
    whereGrid.appendChild(this.field({ key: "radius", label: "Radius", type: "number", min: l.radiusMin, max: l.radiusMax, step: 1, unit: "px" }));

    const rate = card(main, "Spawn rate", "How many stand at once, and how soon a gathered one grows back");
    const rateGrid = el("div", "tl-fields tl-fields-2");
    rate.body.appendChild(rateGrid);
    rateGrid.appendChild(this.field({ key: "max_nodes", label: "Nodes at once", type: "number", min: 1, max: l.nodesMax, step: 1, wide: true }));
    rateGrid.appendChild(this.field({ key: "respawn_min_s", label: "Shortest regrow", type: "number", min: 0, max: l.respawnMax, step: 1, unit: "s" }));
    rateGrid.appendChild(this.field({ key: "respawn_max_s", label: "Longest regrow", type: "number", min: 0, max: l.respawnMax, step: 1, unit: "s" }));
    rateGrid.appendChild(this.field({ key: "enabled", label: "On", type: "switch", wide: true }));

    const look = card(main, "Preview", "How dense it will look, drawn in the game for you only");
    look.tools.append(button(this.previewing ? "Hide preview" : "Preview", () => this.togglePreview(), { kind: this.previewing ? "quiet" : "primary" }));
    if (this.previewing && this.previewNote) look.body.appendChild(el("p", "tl-why", this.previewNote));

    const { body } = card(aside, "In plain words", "What this area is in the game");
    body.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  private field(field: Field): HTMLElement {
    const path = field.key;
    const wrap = this.fields.renderField({ ...field, path }, this.draft!, () => this.touched(path, wrap), { error: this.fieldErrors[path] });
    return wrap;
  }

  private touched(path: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.renderList();
    // the preview shows the settings it was asked with: drawn again when typing pauses
    if (this.previewing) this.schedulePreview();
  }

  private changed(): void {
    this.dirty = true;
    this.refused = false;
    this.renderList();
    this.renderForm();
    if (this.previewing) this.schedulePreview();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.draft.item || "the new area");
  }

  private open(draft: Area, dirty: boolean): void {
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.stopPreview();
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(id: number | null): Promise<void> {
    if (id === this.draft?.id || !(await this.mayLeave())) return;
    const record = this.find(id);
    if (record) this.open(clone(record), false);
  }

  private async startNew(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open({ id: null, x: null, y: null, radius: 128, size: 32, item: "", quantity_min: 1, quantity_max: 1, max_nodes: 5, respawn_min_s: 60, respawn_max_s: 120, enabled: true }, true);
    // centred where the admin stands
    this.shell.send({ type: "whereAmI" });
  }

  // ----------------------------------------------------------------- actions

  private payload(): any {
    const d = this.draft!;
    return { id: d.id, x: d.x, y: d.y, radius: d.radius, size: d.size, item: d.item, quantity_min: d.quantity_min, quantity_max: d.quantity_max, max_nodes: d.max_nodes, respawn_min_s: d.respawn_min_s, respawn_max_s: d.respawn_max_s, enabled: d.enabled };
  }

  private togglePreview(): void {
    if (this.previewing) {
      this.stopPreview();
      this.renderForm();
      return;
    }
    this.askPreview();
  }

  /** Typing changed the settings of a preview that is shown: drawn again once typing pauses. */
  private schedulePreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.refreshPreview(), 250);
  }

  /** The redraw: asked for only when the settings are valid. Half-typed ones leave the last preview drawn. */
  private refreshPreview(): void {
    this.previewTimer = null;
    if (!this.draft || !this.previewing) return;
    if (Object.keys(this.validate()).length > 0) return;
    this.shell.send({ type: "request", packet: "GATHERING_EDITOR_PREVIEW", data: this.payload(), icon: this.iconOf(this.draft.item) });
  }

  private askPreview(): void {
    if (!this.draft) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.previewing = false;
      this.shell.send({ type: "clearPreview" });
      this.showProblems();
      return;
    }
    this.shell.send({ type: "request", packet: "GATHERING_EDITOR_PREVIEW", data: this.payload(), icon: this.iconOf(this.draft.item) });
  }

  private save(): void {
    if (!this.draft || this.pending) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    this.beginRequest("save", "GATHERING_EDITOR_SAVE", this.payload());
  }

  private async deleteEntry(): Promise<void> {
    const d = this.draft;
    if (!d || d.id === null || this.pending) return;
    const agreed = await this.shell.confirmDelete(`the ${d.item} area`, ["This cannot be undone.", "Its nodes disappear from the world at once."]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "GATHERING_EDITOR_DELETE", { id: d.id });
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any): void {
    this.pending = { kind, packet };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      toast("The server did not answer in 15 s, so nothing was confirmed.", "error");
      this.askForList();
    }, 15000);
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

new GatheringEditorBridge();
