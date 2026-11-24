import type { EditorShell, ListRow, RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, el, noticeDialog, tag, thumb, toast } from "./toolkit.js";
import type { ToolHost, ToolPart } from "./dungeontoolparts.js";
import { ToolPartBase } from "./toolpart.js";

// The Portals tab of the Dungeon Tool (dungeontoolbridge.ts): the portals of the map the editor is on. A portal leads
// into a dungeon (linked on the Dungeons tab) or is a teleport to a place on a live map. The server checks everything again.

interface MapOption { name: string; widthPx: number; heightPx: number }
interface Portal {
  name: string;
  kind: "dungeon" | "teleport";
  dungeonId: number | null;
  mirror: boolean;
  target: { map: string; x: number | null; y: number | null } | null;
  position: { x: number | null; y: number | null };
  size: { width: number | null; height: number | null };
  layer?: string | null;
  /** Set on a return portal: the teleport it leads back to, or (a dungeon portal) the entrance portal of the dungeon whose exit it is. It follows that portal and is not edited on its own. */
  returnOf?: { map: string; name: string } | null;
}
interface Draft extends Portal {
  destination: "none" | "teleport";
  target: { map: string; x: number | null; y: number | null };
}
interface Data {
  map: string; portals: Portal[]; dungeons: Record<string, string>; maps: MapOption[];
  here: { x: number; y: number } | null; nameMax: number; sizeMin: number; sizeMax: number;
}

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const NEW = "\u0000new";
/** Players come out of a portal this many pixels in front of (below) it; a teleport's return portal stands just behind its place (the server's ARRIVAL_GAP). */
const ARRIVAL_GAP = 16;

/** Why a return portal is not edited here: it follows its source. Null for any other portal. */
const returnNote = (p: Portal | null | undefined): string | null =>
  p?.returnOf ? `"${p.name}" is the return portal of "${p.returnOf.name}" on ${p.returnOf.map}. It follows that portal: edit, move or delete "${p.returnOf.name}" instead.` : null;

export class PortalPart extends ToolPartBase<EditorShell> implements ToolPart {
  readonly kind = "portals";
  protected readonly listPacket = "PORTAL_EDITOR_LIST";
  private data: Data = { map: "", portals: [], dungeons: {}, maps: [], here: null, nameMax: 48, sizeMin: 8, sizeMax: 512 };
  /** Name of the portal being edited, or null for a new one. */
  private original: string | null = null;
  protected draft: Draft | null = null;
  /** A draft just placed where the editor stands: the next list (asked for on placing) has where that is now. */
  private placing: Draft | null = null;
  /** A teleport just pointed at where the editor stands: the next list (asked for then) has where that is now. */
  private arriving: Draft | null = null;
  /** The map the open portal stands on: it stays open when the editor walks to another map. */
  private home = "";
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

  duplicate(): void {
    void this.duplicateOf(this.openRow());
  }

  remove(): void {
    void this.deleteEntry(this.openRow());
  }

  count(): number {
    return this.data.portals.length;
  }

  unsaved(): string | null {
    return this.dirty && this.draft ? String(this.draft.name || "New portal") : null;
  }

  discard(): void {
    this.close();
  }

  protected adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    const mapBefore = this.data.map;
    this.data = { ...this.data, ...data };
    // placed where the editor stood when placing it, never moved by a later list
    const placing = this.placing;
    this.placing = null;
    if (placing && placing === this.draft && !this.away) this.placeAt(placing);
    // players arrive where the editor stood when pointing it there, never moved by a later list
    const arriving = this.arriving;
    this.arriving = null;
    if (arriving && arriving === this.draft) this.arriveAt(arriving);
    if (!Array.isArray(this.data.portals)) this.data.portals = [];
    if (!Array.isArray(this.data.maps)) this.data.maps = [];
    if (!this.data.dungeons || typeof this.data.dungeons !== "object") this.data.dungeons = {};
    this.landed();
    // on another map: what is open stays open, and is still saved on its own map
    if (mapBefore && mapBefore !== this.data.map && this.draft && this.data.map !== this.home) {
      if (this.active) toast(`You are on ${this.data.map} now, so its portals are listed. ${this.draft.name || "The new portal"} stays open on ${this.home}.`);
    }
    if (!follow || this.original === null || this.dirty || this.pending || this.away) return;
    const now = this.find(this.original);
    if (now) this.draft = this.toDraft(now);
    else {
      toast(`${this.draft?.name ?? "The portal"} was deleted in another editor, so it has been closed here.`);
      this.close();
    }
  }

  /** What is open stands on another map than the editor. */
  private get away(): boolean {
    return !!this.draft && this.home !== this.data.map;
  }

  private close(): void {
    this.draft = null;
    this.home = "";
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
    toast([`Saved ${msg.name ?? "the portal"}.`, ...(msg.notes ?? [])].join("\n"));
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

  private find(name: string | null): Portal | undefined {
    return name === null ? undefined : this.data.portals.find((p) => p.name === name);
  }

  private mapOf(name: string): MapOption | undefined {
    return this.data.maps.find((m) => m.name === name);
  }

  private toDraft(p: Portal): Draft {
    const c = clone(p);
    return {
      ...c,
      destination: c.kind === "teleport" ? "teleport" : "none",
      target: c.target ? { map: c.target.map, x: c.target.x, y: c.target.y } : { map: "", x: 0, y: 0 },
    };
  }

  /** The server's checks, run here first. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const { nameMax, sizeMin, sizeMax } = this.data;
    const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
    const name = String(d.name ?? "").trim();
    if (!name) errors.name = "Name is required.";
    else if (name.length > nameMax) errors.name = `Name must be ${nameMax} characters or fewer.`;
    else if (!this.away && this.data.portals.some((p) => p.name !== this.original && lower(p.name) === lower(name))) errors.name = "This map already has a portal with that name.";
    if (d.destination === "teleport") {
      const to = this.mapOf(d.target.map);
      if (!to) errors["target.map"] = "Pick the map it leads to.";
      for (const [key, limit] of [["x", to?.widthPx], ["y", to?.heightPx]] as const) {
        const v = d.target[key];
        if (!whole(v)) errors[`target.${key}`] = "The place must be whole pixels.";
        else if (v < 0 || (limit !== undefined && v > limit - 1)) errors[`target.${key}`] = limit !== undefined ? `The place must be inside the map (0 to ${limit - 1}).` : "The place must be 0 or more.";
      }
      const y = d.target.y, h = d.size.height;
      if (!errors["target.y"] && whole(y) && whole(h) && y - ARRIVAL_GAP - h < 0) {
        errors["target.y"] = `Leave ${ARRIVAL_GAP + h} pixels above the place for its return portal, which stands just behind where players arrive.`;
      }
    }
    for (const key of ["width", "height"] as const) {
      const v = d.size[key];
      if (!whole(v) || v < sizeMin || v > sizeMax) errors[`size.${key}`] = `The ${key} must be whole pixels from ${sizeMin} to ${sizeMax}.`;
    }
    const here = this.mapOf(this.home);
    for (const [key, span, limit] of [["x", d.size.width, here?.widthPx], ["y", d.size.height, here?.heightPx]] as const) {
      const v = d.position[key];
      if (!whole(v)) errors[`position.${key}`] = "The position must be whole pixels.";
      else if (v < 0 || (limit !== undefined && whole(span) && v + span > limit)) errors[`position.${key}`] = "The portal must be inside the map.";
    }
    return errors;
  }

  private blank(): Draft {
    const d: Draft = {
      name: "New portal", kind: "dungeon", dungeonId: null, mirror: true, destination: "none",
      target: { map: "", x: 0, y: 0 }, position: { x: 0, y: 0 }, size: { width: 32, height: 32 }, layer: null,
    };
    this.placeAtMe(d);
    return d;
  }

  /**
   * Centred where the editor stands now, inside the map. The list's position may be old, so it is asked for again and
   * the portal placed by the answer; after that it stays put, wherever the editor saves from.
   */
  private placeAtMe(d: Draft): void {
    this.placeAt(d);
    this.placing = d;
    this.askForList();
  }

  private arriveAtMe(d: Draft): void {
    this.arriveAt(d);
    this.arriving = d;
    this.askForList();
  }

  private arriveAt(d: Draft): void {
    const at = this.data.here;
    if (!at) return;
    d.target = { map: this.data.map, x: Math.round(at.x), y: Math.round(at.y) };
  }

  private placeAt(d: Draft): void {
    const at = this.data.here;
    if (!at) return;
    const w = d.size.width ?? 32, h = d.size.height ?? 32, here = this.mapOf(this.data.map);
    const fit = (v: number, span: number, limit?: number) => Math.max(0, limit !== undefined ? Math.min(v, limit - span) : v);
    d.position = { x: fit(Math.floor(at.x - w / 2), w, here?.widthPx), y: fit(Math.floor(at.y - h / 2), h, here?.heightPx) };
  }

  private openRow(): Portal | null {
    return this.find(this.original) ?? this.draft;
  }

  // ---------------------------------------------------------------- in words

  private leadsTo(p: Portal | Draft): string {
    if (p.returnOf) return p.kind === "dungeon" ? `Exit of the dungeon behind ${p.returnOf.name} on ${p.returnOf.map}` : `Return of ${p.returnOf.name} on ${p.returnOf.map}`;
    const teleport = "destination" in p ? p.destination === "teleport" : p.kind === "teleport";
    if (teleport) return p.target?.map ? `Teleport to ${p.target.map} at ${p.target.x ?? "?"}, ${p.target.y ?? "?"}` : "Teleport, no place picked";
    if (p.dungeonId === null) return "Dungeon portal, not linked";
    return `Into ${this.data.dungeons[String(p.dungeonId)] ?? `dungeon #${p.dungeonId}`}`;
  }

  private summary(): string[] {
    const d = this.draft!;
    const name = String(d.name || "").trim() || "New portal";
    const lines: string[] = [];
    if (d.returnOf && d.kind === "dungeon") {
      lines.push(`${name} is the exit of the dungeon that ${d.returnOf.name} on ${d.returnOf.map} leads into. In a copy it takes players back out to where they came in; on this map it leads nowhere.`);
      lines.push(`It was made for ${d.returnOf.name} and follows it: it moves, changes and goes when that portal or its dungeon does.`);
      lines.push(d.mirror ? "Its opening shows the far side, with the players there moving live." : "Its opening shows the swirl only, not the far side.");
      return lines;
    }
    if (d.returnOf) {
      lines.push(`${name} takes players back to ${d.returnOf.name} on ${d.returnOf.map}. They come out just in front of it.`);
      lines.push(`It was made for ${d.returnOf.name} and follows it: it moves, changes and goes when that portal does.`);
      lines.push(d.mirror ? "Its opening shows the far side, with the players there moving live." : "Its opening shows the swirl only, not the far side.");
      return lines;
    }
    if (d.destination === "teleport") {
      lines.push(d.target.map
        ? `${name} takes players straight to ${d.target.map} at ${d.target.x ?? "?"}, ${d.target.y ?? "?"}. No copy is opened.`
        : `${name} is a teleport with no place picked yet.`);
      if (d.target.map) lines.push(`A return portal stands on ${d.target.map} just behind that place and leads back to just in front of ${name}. It is made, moved and deleted with ${name}.`);
    } else if (d.dungeonId !== null) {
      lines.push(`${name} leads into ${this.data.dungeons[String(d.dungeonId)] ?? `dungeon #${d.dungeonId}`}. Each party gets its own copy.`);
      lines.push("The dungeon's map has an exit portal just behind where players arrive in a copy, made, moved and deleted with the portals that lead into it.");
    } else {
      lines.push(`${name} leads nowhere yet. Pick it as a dungeon's entrance portal on the Dungeons tab.`);
    }
    lines.push(d.mirror
      ? "Its opening shows the far side, with the players there moving live."
      : "Its opening shows the swirl only, not the far side.");
    lines.push(`It stands at ${d.position.x ?? "?"}, ${d.position.y ?? "?"} on ${this.home}, ${d.size.width ?? "?"} × ${d.size.height ?? "?"} pixels.`);
    return lines;
  }

  // ------------------------------------------------------------------ render

  protected renderList(): void {
    if (!this.ready || !this.active) return;
    const wanted = lower(this.shell.query);
    const rows: ListRow[] = [];
    if (this.draft && this.original === null) {
      rows.push({
        id: NEW, name: String(this.draft.name || "New portal"), note: "Not saved yet", selected: true,
        thumb: thumb(null, { fallback: "portal" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const p of this.data.portals) {
      if (wanted && !lower(p.name).includes(wanted)) continue;
      const tags = [];
      if (p.returnOf) tags.push(tag(p.kind === "dungeon" ? "Exit" : "Return", "muted"));
      else if (p.kind === "teleport") tags.push(tag("Teleport", "muted"));
      if (!p.mirror) tags.push(tag("No mirror", "muted"));
      rows.push({
        id: p.name, name: p.name, note: this.leadsTo(p), selected: p.name === this.original,
        thumb: thumb(null, { fallback: "portal" }), tags,
        // a return portal follows its source: it is not copied or deleted on its own
        actions: p.returnOf ? [] : [
          { icon: "copy", label: `Duplicate ${p.name}`, onClick: () => void this.duplicateOf(p) },
          { icon: "trash" as const, label: `Delete ${p.name}`, danger: true, onClick: () => void this.deleteEntry(p) },
        ],
        onOpen: () => void this.select(p.name),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No portals match that search", text: "Check the spelling, or search for less of the name." }
        : { title: `${this.data.map || "This map"} has no portals`, text: "Start one with New portal. It is placed where you stand." },
    });
  }

  protected chrome(): void {
    if (!this.active) return;
    const d = this.draft;
    const { shell } = this;
    shell.setBanner(this.data.map ? { tone: "info", icon: "map", text: `The portals of ${this.data.map}, the map you are on. Go to another map to edit its portals.` } : null);
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      return;
    }
    const saved = this.original !== null;
    const follows = returnNote(d);
    if (follows) {
      shell.setRecord({ title: d.name, note: `Return portal of ${d.returnOf!.name}`, thumb: thumb(null, { size: "lg", fallback: "portal" }) });
      shell.setState("saved");
      shell.setActions({
        open: true, dirty: false, busy: this.pending ? "other" : null,
        canSave: false, canDuplicate: false, canDelete: false,
        why: { save: follows, duplicate: follows, delete: follows },
      });
      return;
    }
    shell.setRecord({ title: String(d.name || "").trim() || "New portal", note: d.destination === "teleport" ? "Teleport" : "Dungeon portal", thumb: thumb(null, { size: "lg", fallback: "portal" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (this.pending.kind === "save" ? "save" : "delete") : null,
      canSave: true, canDuplicate: saved, canDelete: saved,
      why: { duplicate: "Save it first, then it can be copied", delete: "It has not been saved, so there is nothing to delete" },
    });
  }

  protected renderForm(): void {
    if (!this.active) return;
    this.chrome();
    this.summaryEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle(`Pick a portal of ${this.data.map || "this map"} from the list on the left, or start a new one.`, this.data.portals.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New portal", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(this.pageKey(), { aside: true });
    const d = this.draft;
    const { sizeMin, sizeMax } = this.data;

    const follows = returnNote(d);
    if (follows) {
      const { body: about } = d.kind === "dungeon"
        ? card(main, "Dungeon exit portal", `Leads out of the dungeon behind ${d.returnOf!.name} on ${d.returnOf!.map}`)
        : card(main, "Return portal", `Leads back to ${d.returnOf!.name} on ${d.returnOf!.map}`);
      about.append(
        el("p", "", follows),
        el("p", "", `It stands at ${d.position.x ?? "?"}, ${d.position.y ?? "?"} on ${this.home}, ${d.size.width ?? "?"} × ${d.size.height ?? "?"} pixels, and takes players to ${d.target.map} at ${d.target.x ?? "?"}, ${d.target.y ?? "?"}.`),
      );
      const { body } = card(aside, "In plain words", "What this portal is in the game");
      this.summaryEl = el("div", "tl-summary");
      body.append(this.summaryEl);
      this.paintLive();
      return;
    }

    const about = this.section(main, "Portal", "What it is called and what its opening shows");
    about.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: this.data.nameMax, wide: true, hint: "Unique on this map. The Dungeons tab lists it by this name." }, "name"));
    about.appendChild(this.field({ key: "mirror", label: "Mirror other side", type: "switch", wide: true, hint: "On: the opening shows the far side and the players there. Off: the swirl only." }, "mirror"));

    const where = this.section(main, "Destination", "Where it takes players");
    where.appendChild(this.field({
      key: "destination", label: "Destination", type: "segmented", wide: true, rerender: true,
      options: () => [{ value: "none", label: "None (dungeon)" }, { value: "teleport", label: "Teleport" }],
      hint: d.destination === "teleport"
        ? "One way to a place on a live map. No copy is opened."
        : d.dungeonId !== null ? `Leads into ${this.data.dungeons[String(d.dungeonId)] ?? `dungeon #${d.dungeonId}`}, as linked on the Dungeons tab.` : "Leads into the dungeon that picks it as its entrance portal on the Dungeons tab.",
    }, "destination"));
    if (d.destination === "teleport") {
      const to = this.mapOf(d.target.map);
      where.appendChild(this.field({ key: "map", label: "Map", type: "asset", noIcons: true, fallback: "map", wide: true, rerender: true, assets: () => this.mapOptions(), hint: to ? `${to.widthPx} × ${to.heightPx} pixels.` : "The map it leads to." }, "target.map", d.target));
      where.appendChild(this.field({ key: "x", label: "X", type: "number", min: 0, max: to ? to.widthPx - 1 : undefined, step: 1, unit: "px", hint: "Where players arrive, from the left." }, "target.x", d.target));
      where.appendChild(this.field({ key: "y", label: "Y", type: "number", min: 0, max: to ? to.heightPx - 1 : undefined, step: 1, unit: "px", hint: "Where players arrive, from the top. Its return portal stands just above." }, "target.y", d.target));
      const arrive = el("div", "tl-field tl-field-wide");
      const toMe = button("Place at my position", () => {
        this.arriveAtMe(d);
        this.dirty = true;
        for (const k of ["target.map", "target.x", "target.y"]) delete this.fieldErrors[k];
        this.renderForm();
      }, { icon: "pin", tip: "Players arrive where you stand now" });
      toMe.disabled = !this.data.here;
      arrive.appendChild(toMe);
      where.appendChild(arrive);
    }

    const place = this.section(main, "Placement", `Where it stands on ${this.home}, in pixels`);
    place.appendChild(this.field({ key: "x", label: "X", type: "number", min: 0, step: 1, unit: "px", hint: "Its left edge." }, "position.x", d.position));
    place.appendChild(this.field({ key: "y", label: "Y", type: "number", min: 0, step: 1, unit: "px", hint: "Its top edge. Players step in at its bottom edge." }, "position.y", d.position));
    place.appendChild(this.field({ key: "width", label: "Width", type: "number", min: sizeMin, max: sizeMax, step: 1, unit: "px", hint: `From ${sizeMin} to ${sizeMax}.` }, "size.width", d.size));
    place.appendChild(this.field({ key: "height", label: "Height", type: "number", min: sizeMin, max: sizeMax, step: 1, unit: "px", hint: `From ${sizeMin} to ${sizeMax}.` }, "size.height", d.size));
    const here = el("div", "tl-field tl-field-wide");
    const atMe = button("Place at my position", () => {
      this.placeAtMe(d);
      this.dirty = true;
      for (const k of ["position.x", "position.y"]) delete this.fieldErrors[k];
      this.renderForm();
    }, { icon: "pin", tip: "Centred where you stand now" });
    atMe.disabled = !this.data.here || this.away;
    here.appendChild(atMe);
    place.appendChild(here);

    const { body } = card(aside, "In plain words", "What this portal is in the game");
    this.summaryEl = el("div", "tl-summary");
    body.append(this.summaryEl);
    this.paintLive();
  }

  private mapOptions(): AssetOption[] {
    return this.data.maps.map((m) => ({ value: m.name, label: m.name }));
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
    if (path.startsWith("position.")) this.placing = null;
    if (path.startsWith("target.")) this.arriving = null;
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
    if (path === "name") this.renderList();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(String(this.draft.name || "New portal"));
  }

  private open(draft: Draft, original: string | null, dirty: boolean): void {
    this.original = original;
    this.draft = draft;
    this.home = this.data.map;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(name: string): Promise<void> {
    if (name === this.original || !(await this.mayLeave())) return;
    const p = this.find(name);
    if (p) this.open(this.toDraft(p), name, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  private async duplicateOf(p: Portal | null): Promise<void> {
    if (!p || p.returnOf || !(await this.mayLeave())) return;
    const copy = this.toDraft(p as Portal);
    copy.name = `${copy.name} copy`.slice(0, this.data.nameMax);
    // a portal leads into one dungeon at most
    copy.dungeonId = null;
    this.open(copy, null, true);
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  save(): void {
    if (!this.draft || this.pending) return;
    // saved where it stands now
    this.placing = null;
    this.arriving = null;
    const follows = returnNote(this.draft);
    if (follows) {
      toast(follows, "error");
      return;
    }
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    const d = this.draft;
    this.beginRequest("save", "PORTAL_EDITOR_SAVE", {
      original: this.original, map: this.home, name: String(d.name ?? "").trim(), mirror: d.mirror, destination: d.destination,
      target: d.destination === "teleport" ? { ...d.target } : null,
      position: { ...d.position }, size: { ...d.size },
    }, String(d.name ?? ""));
  }

  private async deleteEntry(p: Portal | null): Promise<void> {
    if (!p || this.pending || !this.find(p.name)) return;
    const follows = returnNote(p);
    if (follows) {
      void noticeDialog(`${p.name} cannot be deleted here`, [follows]);
      return;
    }
    const lines = ["This cannot be undone."];
    if (p.kind === "teleport" && p.target?.map) lines.push(`Its return portal on ${p.target.map} is deleted with it.`);
    if (p.dungeonId !== null) lines.push(`It is the entrance of ${this.data.dungeons[String(p.dungeonId)] ?? "a dungeon"}, which then has no portal into it. Its exit portal on the dungeon's map is deleted with it, unless another portal leads into that dungeon.`);
    if (!(await this.shell.confirmDelete(p.name, lines)) || this.pending) return;
    this.beginRequest("delete", "PORTAL_EDITOR_DELETE", { name: p.name }, p.name);
  }
}
