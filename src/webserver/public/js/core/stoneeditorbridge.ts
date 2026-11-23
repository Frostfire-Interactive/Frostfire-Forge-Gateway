import type { EditorShell, ListRow, RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type Field } from "./toolfields.js";
import { button, card, el, noticeDialog, tag, thumb, toast } from "./toolkit.js";
import { colourField } from "./particleeditorparts.js";
import type { ToolHost, ToolPart } from "./dungeontoolparts.js";
import { ToolPartBase } from "./toolpart.js";

// The Summoning stones tab of the Dungeon Tool (dungeontoolbridge.ts): the summoning stones of the map the editor is on,
// listed, placed and edited by name. Two party members who touch a stone summon a third to it. The server checks
// everything again, and takes no stones on a dungeon's map.

interface Stone {
  name: string;
  /** The stone's foot: x the middle, y the ground line. */
  position: { x: number | null; y: number | null };
  glowColor: string;
  layer?: string | null;
}
interface Draft extends Stone {
  /** Placed on the editor's own position when saved (the server's, as it is then). */
  atMe: boolean;
}
interface Data {
  map: string;
  stones: Stone[];
  here: { x: number; y: number } | null;
  nameMax: number;
  /** Why this map takes no stones (a dungeon's map), or null. */
  refused: string | null;
}

/** As the server's DEFAULT_GLOW: the colour a stone's white parts glow until another is picked. */
const DEFAULT_GLOW = "#66ccff";
const GLOW = /^#[0-9a-f]{6}$/i;
const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const NEW = "\u0000new";

export class StonePart extends ToolPartBase<EditorShell> implements ToolPart {
  readonly kind = "stones";
  protected readonly listPacket = "SUMMON_STONE_EDITOR_LIST";
  private data: Data = { map: "", stones: [], here: null, nameMax: 48, refused: null };
  /** Name of the stone being edited, or null for a new one. */
  private original: string | null = null;
  protected draft: Draft | null = null;
  private dirty = false;
  private summaryEl: HTMLElement | null = null;

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor(shell: EditorShell, host: ToolHost) {
    super(shell, host, toast);
  }

  // ---------------------------------------------------------------- the tab

  search(): void {
    this.renderList();
  }

  create(): void {
    void this.newEntry();
  }

  remove(): void {
    void this.deleteEntry(this.find(this.original));
  }

  count(): number {
    return this.data.stones.length;
  }

  unsaved(): string | null {
    return this.dirty && this.draft ? String(this.draft.name || "New summoning stone") : null;
  }

  discard(): void {
    this.close();
  }

  protected adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    const mapBefore = this.data.map;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.stones)) this.data.stones = [];
    if (typeof this.data.refused !== "string" || !this.data.refused) this.data.refused = null;
    this.landed();
    // on another map: what was open was on the last one
    if (mapBefore && mapBefore !== this.data.map && this.draft) {
      if (this.active) toast(`You are on ${this.data.map} now, so its summoning stones are listed.${this.dirty ? " The changes not saved were dropped." : ""}`);
      this.close();
      return;
    }
    if (this.data.refused && this.draft) return this.close();
    if (!follow || this.original === null || this.dirty || this.pending) return;
    const now = this.find(this.original);
    if (now) this.draft = this.toDraft(now);
    else {
      toast(`${this.draft?.name ?? "The summoning stone"} was deleted in another editor, so it has been closed here.`);
      this.close();
    }
  }

  private close(): void {
    this.draft = null;
    this.original = null;
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
  }

  protected onSaveResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      this.host.settled(this.kind, false);
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
    if (typeof msg.name === "string") this.original = msg.name;
    this.adopt(msg.data);
    toast(`Saved ${msg.name ?? "the summoning stone"}.`);
    this.renderForm();
    this.host.settled(this.kind, true);
  }

  protected onDeleteResult(msg: any, asked: string): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      void noticeDialog(`${asked} was not deleted`, msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
      this.renderForm();
      return;
    }
    if (this.draft && this.original === asked) this.close();
    this.adopt(msg.data);
    toast(`Deleted ${asked}.`);
    this.renderForm();
  }

  // ------------------------------------------------------------------ rules

  private find(name: string | null): Stone | undefined {
    return name === null ? undefined : this.data.stones.find((s) => s.name === name);
  }

  private toDraft(s: Stone): Draft {
    const c = clone(s);
    return { ...c, glowColor: typeof c.glowColor === "string" && GLOW.test(c.glowColor) ? c.glowColor.toLowerCase() : DEFAULT_GLOW, atMe: false };
  }

  /** The server's checks, run here first. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const { nameMax } = this.data;
    const name = String(d.name ?? "").trim();
    if (!name) errors.name = "Name is required.";
    else if (name.length > nameMax) errors.name = `Name must be ${nameMax} characters or fewer.`;
    else if (this.data.stones.some((s) => s.name !== this.original && lower(s.name) === lower(name))) errors.name = "This map already has a summoning stone with that name.";
    if (!GLOW.test(String(d.glowColor ?? ""))) errors.glowColor = "The glow color must be a #rrggbb color.";
    if (!d.atMe) {
      for (const key of ["x", "y"] as const) {
        const v = d.position[key];
        if (typeof v !== "number" || !Number.isFinite(v)) errors[`position.${key}`] = "The position must be a number.";
        else if (v < 0) errors[`position.${key}`] = "The summoning stone must be inside the map.";
      }
    }
    return errors;
  }

  private blank(): Draft {
    const d: Draft = { name: "New summoning stone", position: { x: 0, y: 0 }, glowColor: DEFAULT_GLOW, layer: null, atMe: false };
    this.placeAtMe(d);
    return d;
  }

  /** Where the editor stands, as the server places it: the stone's foot on the editor's position. */
  private placeAtMe(d: Draft): void {
    const at = this.data.here;
    if (!at) return;
    d.position = { x: Math.round(at.x), y: Math.round(at.y) };
    d.atMe = true;
  }

  // ---------------------------------------------------------------- in words

  private noteOf(s: Stone): string {
    return `At ${s.position.x ?? "?"}, ${s.position.y ?? "?"} · glows ${s.glowColor}`;
  }

  private summary(): string[] {
    const d = this.draft!;
    const name = String(d.name || "").trim() || "New summoning stone";
    return [
      d.atMe
        ? `${name} is placed where you stand when it is saved.`
        : `${name} stands with its foot at ${d.position.x ?? "?"}, ${d.position.y ?? "?"} on ${this.data.map}.`,
      `Its white parts glow ${d.glowColor}.`,
      "When two members of a party touch it, the first picks a member of the party to summon to it.",
    ];
  }

  // ------------------------------------------------------------------ render

  protected renderList(): void {
    if (!this.ready || !this.active) return;
    if (this.data.refused) {
      this.shell.setList({ rows: [], empty: { icon: "lock", title: "No summoning stones here", text: this.data.refused } });
      return;
    }
    const wanted = lower(this.shell.query);
    const rows: ListRow[] = [];
    if (this.draft && this.original === null) {
      rows.push({
        id: NEW, name: String(this.draft.name || "New summoning stone"), note: "Not saved yet", selected: true,
        thumb: thumb(null, { fallback: "pin" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const s of this.data.stones) {
      if (wanted && !lower(s.name).includes(wanted)) continue;
      rows.push({
        id: s.name, name: s.name, note: this.noteOf(s), selected: s.name === this.original,
        thumb: thumb(null, { fallback: "pin" }),
        actions: [{ icon: "trash" as const, label: `Delete ${s.name}`, danger: true, onClick: () => void this.deleteEntry(s) }],
        onOpen: () => void this.select(s.name),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No summoning stones match that search", text: "Check the spelling, or search for less of the name." }
        : { title: `${this.data.map || "This map"} has no summoning stones`, text: "Start one with New summoning stone. It is placed where you stand." },
    });
  }

  protected chrome(): void {
    if (!this.active) return;
    const d = this.draft;
    const { shell } = this;
    shell.setBanner(this.data.map && !this.data.refused
      ? { tone: "info", icon: "map", text: `The summoning stones of ${this.data.map}, the map you are on. Go to another map to edit its stones.` }
      : null);
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      return;
    }
    const saved = this.original !== null;
    shell.setRecord({ title: String(d.name || "").trim() || "New summoning stone", note: "Summoning stone", thumb: thumb(null, { size: "lg", fallback: "pin" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (this.pending.kind === "save" ? "save" : "delete") : null,
      canSave: true, canDuplicate: false, canDelete: saved,
      why: { duplicate: "A summoning stone is placed, not copied", delete: "It has not been saved, so there is nothing to delete" },
    });
  }

  protected renderForm(): void {
    if (!this.active) return;
    this.chrome();
    this.summaryEl = null;
    if (!this.ready) return;
    if (this.data.refused) {
      // a dungeon's map: its words in place of the form
      this.shell.screen("lock", "No summoning stones here", this.data.refused);
      return;
    }
    if (!this.draft) {
      const box = this.shell.idle(`Pick a summoning stone of ${this.data.map || "this map"} from the list on the left, or start a new one.`, this.data.stones.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New summoning stone", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(this.pageKey(), { aside: true });
    const d = this.draft;

    const about = this.section(main, "Summoning stone", "What it is called and the colour it glows");
    about.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: this.data.nameMax, wide: true, hint: "Unique on this map." }, "name"));
    about.appendChild(this.glowField(d));

    const place = this.section(main, "Position", `Where its foot stands on ${this.data.map}, in pixels`);
    place.appendChild(this.field({ key: "x", label: "X", type: "number", min: 0, step: 1, unit: "px", hint: "The middle of the stone." }, "position.x", d.position));
    place.appendChild(this.field({ key: "y", label: "Y", type: "number", min: 0, step: 1, unit: "px", hint: "Its ground line. Players touch it from within 150 pixels." }, "position.y", d.position));
    const here = el("div", "tl-field tl-field-wide");
    const atMe = button("Place at my position", () => {
      this.placeAtMe(d);
      this.dirty = true;
      this.refused = false;
      for (const k of ["position.x", "position.y"]) delete this.fieldErrors[k];
      this.renderForm();
    }, { icon: "pin", tip: "Where you stand, when it is saved" });
    atMe.disabled = !this.data.here;
    here.appendChild(atMe);
    place.appendChild(here);

    const { body } = card(aside, "In plain words", "What this summoning stone is in the game");
    this.summaryEl = el("div", "tl-summary");
    body.append(this.summaryEl);
    this.paintLive();
  }

  private glowField(d: Draft): HTMLElement {
    const wrap = colourField({ key: "glowColor", label: "Glow color", hint: "The colour its white parts glow." }, d, () => {
      d.glowColor = String(d.glowColor).toLowerCase();
      this.touched("glowColor", wrap);
    });
    if (this.fieldErrors.glowColor) setFieldError(wrap, this.fieldErrors.glowColor);
    return wrap;
  }

  private paintLive(): void {
    if (this.draft && this.summaryEl) this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  // ------------------------------------------------------------------ fields

  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields tl-fields-2");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  private field(field: Field, path: string, target: object = this.draft!): HTMLElement {
    const wrap = this.fields.renderField({ ...field, path }, target, () => this.touched(path, wrap), { error: this.fieldErrors[path] });
    return wrap;
  }

  private touched(path: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    // a position typed in is kept, not the editor's
    if (path.startsWith("position.")) this.draft!.atMe = false;
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
    if (path === "name") this.renderList();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(String(this.draft.name || "New summoning stone"));
  }

  private open(draft: Draft, original: string | null, dirty: boolean): void {
    this.original = original;
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(name: string): Promise<void> {
    if (name === this.original || !(await this.mayLeave())) return;
    const s = this.find(name);
    if (s) this.open(this.toDraft(s), name, false);
  }

  private async newEntry(): Promise<void> {
    if (this.data.refused) return void toast(this.data.refused, "error");
    if (!(await this.mayLeave())) return;
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  save(): void {
    if (!this.draft || this.pending) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    const d = this.draft;
    const data: any = { original: this.original, name: String(d.name ?? "").trim(), position: { ...d.position }, glowColor: d.glowColor.toLowerCase() };
    if (d.atMe) data.atMe = true;
    this.beginRequest("save", "SUMMON_STONE_EDITOR_SAVE", data, String(d.name ?? ""));
  }

  private async deleteEntry(s: Stone | undefined | null): Promise<void> {
    if (!s || this.pending || !this.find(s.name)) return;
    if (!(await this.shell.confirmDelete(s.name, "This cannot be undone.")) || this.pending) return;
    this.beginRequest("delete", "SUMMON_STONE_EDITOR_DELETE", { name: s.name }, s.name);
  }
}
