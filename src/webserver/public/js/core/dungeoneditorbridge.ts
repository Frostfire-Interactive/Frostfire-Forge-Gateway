import type { EditorShell, ListRow, RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, el, listed, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";
import { colourField } from "./particleeditorparts.js";
import { DEFAULT_NAME_MAX, entranceHint, entranceProblem, mapProblem, nameMaxOf, savedIdOf, type MapOption } from "./dungeoneditorrules.js";
import type { ToolHost, ToolPart } from "./dungeontoolparts.js";
import { ToolPartBase } from "./toolpart.js";

// The Dungeons tab of the Dungeon Tool (dungeontoolbridge.ts): every dungeon and raid, listed, made and edited.

type SizeKey = "5" | "10" | "20";
interface Multiplier { health: number | null; damage: number | null }

interface Dungeon {
  id: number | null;
  name: string;
  map: string;
  type: "dungeon" | "raid";
  sizes: number[];
  multipliers: Record<SizeKey, Multiplier>;
  entranceX: number | null;
  entranceY: number | null;
  enabled: boolean;
  /** "#rrggbb", or null for the type's own colour. */
  portalColor: string | null;
  /** The entrance portal it leads from, as portalKey writes it, or "" for none. Kept here only: saved as `portal`. */
  portal?: string;
}

/** A dungeon portal on a map (made on the Portals tab), and the dungeon it leads into (null: none). */
interface PortalRef { map: string; name: string; dungeonId: number | null }
const portalKey = (p: { map: string; name: string }): string => JSON.stringify([p.map, p.name]);
const bareMap = (map: string): string => String(map ?? "").replace(/\.json$/i, "");

/** As the server's dungeoneditor.ts: the multiplier range. */
const MULTIPLIER_MIN = 0.1;
const MULTIPLIER_MAX = 100;
const SIZE_KEYS: SizeKey[] = ["5", "10", "20"];
const RAID_BITS = [{ bit: 1, size: 10 }, { bit: 2, size: 20 }];
/** As the server's DEFAULT_PORTAL_COLORS: a dungeon's portal is blue and a raid's green. */
const PORTAL_DEFAULTS: Record<Dungeon["type"], string> = { dungeon: "#6eaaff", raid: "#6eff8c" };
const PORTAL_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_DEFAULTS: Record<SizeKey, Multiplier> = { "5": { health: 1, damage: 1 }, "10": { health: 2, damage: 1.5 }, "20": { health: 4, damage: 2 } };

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const typeWord = (type: string): string => (type === "raid" ? "Raid" : "Dungeon");

export class DungeonPart extends ToolPartBase<EditorShell> implements ToolPart {
  readonly kind = "dungeons";
  protected readonly listPacket = "DUNGEON_EDITOR_LIST";
  private data: { dungeons: Dungeon[]; maps: MapOption[]; portals: PortalRef[]; defaults: Record<SizeKey, Multiplier>; ready: boolean } = {
    dungeons: [], maps: [], portals: [], defaults: clone(FALLBACK_DEFAULTS), ready: true,
  };
  /** The longest name the server takes. */
  private nameMax = DEFAULT_NAME_MAX;
  /** Id of the dungeon being edited, or null for a new one. */
  private originalId: number | null = null;
  protected draft: Dungeon | null = null;
  private dirty = false;
  private summaryEl: HTMLElement | null = null;
  /** Sizes that have been on in the open draft: one turned on for the first time gets the default multipliers. */
  private sizesSeen = new Set<number>();
  /** The raid sizes last picked, brought back when the type goes from dungeon to raid again. */
  private raidSizes: number[] = [10];

  private fields = new FieldRenderer({
    rerender: () => this.renderForm(),
    flags: RAID_BITS.map(({ bit, size }) => ({ bit, label: `${size} players` })),
  });

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
    return this.data.dungeons.length;
  }

  unsaved(): string | null {
    return this.dirty && this.draft ? String(this.draft.name || "New dungeon") : null;
  }

  discard(): void {
    this.draft = null;
    this.originalId = null;
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
  }

  protected onUpdated(msg: any): void {
    toast(`${shown(msg?.by)} changed a dungeon. The list shows it as it is now.`);
    this.askForList();
  }

  protected adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.dungeons)) this.data.dungeons = [];
    if (!Array.isArray(this.data.maps)) this.data.maps = [];
    if (!Array.isArray(this.data.portals)) this.data.portals = [];
    if (!this.data.defaults || typeof this.data.defaults !== "object") this.data.defaults = clone(FALLBACK_DEFAULTS);
    for (const d of this.data.dungeons) this.complete(d);
    this.nameMax = nameMaxOf(this.data);
    this.landed();
    if (!follow || this.originalId === null || this.dirty || this.pending) return;
    const now = this.find(this.originalId);
    if (now) this.draft = clone(now);
    else {
      toast(`${this.draft?.name ?? "The dungeon"} was deleted in another editor, so it has been closed here.`);
      this.draft = null;
      this.originalId = null;
      this.refused = false;
      this.clearProblems();
    }
  }

  /** Every size has a multiplier pair, so the form can show one the moment a size is turned on. */
  private complete(d: Dungeon): void {
    if (!Array.isArray(d.sizes)) d.sizes = [];
    if (!d.multipliers || typeof d.multipliers !== "object") d.multipliers = {} as Record<SizeKey, Multiplier>;
    for (const key of SIZE_KEYS) d.multipliers[key] ??= { ...this.defaultsOf(key) };
    if (typeof d.portalColor !== "string" || !PORTAL_COLOR.test(d.portalColor)) d.portalColor = null;
    if (typeof d.portal !== "string") d.portal = this.portalOf(d.id);
  }

  /** The portal that leads into the dungeon now, or "" for none. */
  private portalOf(id: number | null): string {
    const linked = id === null ? undefined : this.data.portals.find((p) => p.dungeonId === id);
    return linked ? portalKey(linked) : "";
  }

  private portalLabel(p: PortalRef): string {
    return `${p.name} (${bareMap(p.map)})`;
  }

  /** The dungeon portals it can lead from: its own, and those that lead into no dungeon. */
  private portalOptions(): Array<{ value: string; label: string }> {
    const free = this.data.portals.filter((p) => p.dungeonId === null || (this.originalId !== null && p.dungeonId === this.originalId));
    return [{ value: "", label: "None" }, ...free.map((p) => ({ value: portalKey(p), label: this.portalLabel(p) }))];
  }

  private defaultsOf(key: SizeKey): Multiplier {
    return { ...(this.data.defaults?.[key] ?? FALLBACK_DEFAULTS[key]) };
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
    // a new dungeon is followed by the id the server gave it
    const savedId = savedIdOf(msg, (msg.data?.dungeons as Dungeon[] | undefined) ?? []);
    if (savedId !== null) this.originalId = savedId;
    this.adopt(msg.data);
    toast([`Saved ${msg.name ?? "the dungeon"}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
    this.host.settled(this.kind, true);
  }

  protected onDeleteResult(msg: any, asked: string): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      void noticeDialog(`${asked} was not deleted`, [...(msg.errors?.length ? msg.errors : ["The server refused to delete it."]), ...(msg.notes ?? [])]);
      this.renderForm();
      return;
    }
    if (this.draft && msg.name === this.draft.name) {
      this.draft = null;
      this.originalId = null;
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
    }
    this.adopt(msg.data);
    toast([`Deleted ${msg.name ?? asked}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  // ------------------------------------------------------------------ rules

  private find(id: number | null): Dungeon | undefined {
    return id === null ? undefined : this.data.dungeons.find((d) => d.id === id);
  }

  private mapOf(name: string): MapOption | undefined {
    return this.data.maps.find((m) => m.name === name);
  }

  /** The dungeon other than the open one that is on a map. */
  private onMap(map: string): Dungeon | undefined {
    return this.data.dungeons.find((d) => d.id !== this.originalId && d.map === map);
  }

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const others = this.data.dungeons.filter((o) => o.id !== this.originalId);
    const name = String(d.name ?? "").trim();
    if (!name) errors.name = "Name is required.";
    else if (name.length > this.nameMax) errors.name = `Name must be ${this.nameMax} characters or fewer.`;
    else if (others.some((o) => lower(o.name) === lower(name))) errors.name = "A dungeon with that name already exists.";

    const map = this.mapOf(d.map);
    const mapError = mapProblem(d.map, map);
    if (mapError) errors.map = mapError;
    else if (others.some((o) => o.map === map!.name)) errors.map = "That map already has a dungeon.";

    if (d.type !== "dungeon" && d.type !== "raid") errors.type = "Type must be dungeon or raid.";
    if (d.type === "dungeon" && (d.sizes.length !== 1 || d.sizes[0] !== 5)) errors.sizes = "A dungeon is for a party of 5.";
    if (d.type === "raid") {
      if (!d.sizes.length) errors.sizes = "Pick at least one raid size.";
      else if (d.sizes.some((s) => s !== 10 && s !== 20)) errors.sizes = "A raid is for 10 or 20 players.";
    }

    for (const size of d.sizes) {
      for (const key of ["health", "damage"] as const) {
        const value = d.multipliers[String(size) as SizeKey]?.[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < MULTIPLIER_MIN || value > MULTIPLIER_MAX) {
          errors[`multipliers.${size}.${key}`] = `The ${key} multiplier must be a number from ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX}.`;
        }
      }
    }

    for (const [key, limit] of [["entranceX", map?.widthPx], ["entranceY", map?.heightPx]] as const) {
      const problem = entranceProblem(d[key], limit);
      if (problem) errors[key] = problem;
    }
    if (d.portalColor !== null && !PORTAL_COLOR.test(d.portalColor)) errors.portalColor = "The portal colour must be a code like #ff8a3d.";
    if (d.portal && !this.portalOptions().some((o) => o.value === d.portal)) errors.portal = "Pick a dungeon portal that leads into no other dungeon.";
    return errors;
  }

  /** Where the marked fields are, or, when none is marked, what the server said that is not about one field. */
  private blank(): Dungeon {
    const d: Dungeon = {
      id: null, name: "New dungeon", map: "", type: "dungeon", sizes: [5],
      multipliers: { "5": this.defaultsOf("5"), "10": this.defaultsOf("10"), "20": this.defaultsOf("20") },
      entranceX: 0, entranceY: 0, enabled: true, portalColor: null, portal: "",
    };
    return d;
  }

  private openRow(): Dungeon | null {
    return this.find(this.originalId) ?? this.draft;
  }

  /** Puts a size on or off; one on for the first time in this draft starts from the default multipliers. */
  private setSizes(sizes: number[]): void {
    const d = this.draft!;
    d.sizes = [...new Set(sizes)].sort((a, b) => a - b);
    for (const size of d.sizes) {
      if (this.sizesSeen.has(size)) continue;
      const key = String(size) as SizeKey;
      d.multipliers[key] = this.defaultsOf(key);
      this.sizesSeen.add(size);
    }
    if (d.type === "raid") this.raidSizes = d.sizes.slice();
    for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("multipliers") || path === "sizes") delete this.fieldErrors[path];
  }

  // ---------------------------------------------------------------- in words

  private sizeWords(d: Dungeon): string {
    if (!d.sizes.length) return "no size";
    return `${listed(d.sizes.map(String))} players`;
  }

  private noteOf(d: Dungeon): string {
    return `${typeWord(d.type)} · ${d.map || "no map"} · ${this.sizeWords(d)}`;
  }

  /** What the open dungeon adds up to in the game, one sentence to a line. */
  private summary(): string[] {
    const d = this.draft!;
    const name = String(d.name || "").trim() || "New dungeon";
    const lines = [
      d.map ? `${name} is a ${lower(typeWord(d.type))} played on the map ${d.map}.` : `${name} is a ${lower(typeWord(d.type))} with no map picked yet.`,
      d.type === "raid"
        ? (d.sizes.length ? `It is entered by a raid group of ${this.sizeWords(d)}.` : "No raid size is picked yet.")
        : "It is entered by a party of up to 5.",
    ];
    for (const size of d.sizes) {
      const m = d.multipliers[String(size) as SizeKey];
      lines.push(`At ${size} players: creatures have ${m?.health ?? "?"}× health and deal ${m?.damage ?? "?"}× damage.`);
    }
    lines.push(d.portalColor
      ? `Its portals glow ${d.portalColor}.`
      : `Its portals glow ${d.type === "raid" ? "green" : "blue"}, the ${lower(typeWord(d.type))} colour.`);
    const from = d.portal ? this.data.portals.find((p) => portalKey(p) === d.portal) : undefined;
    lines.push(from
      ? `Players go in through the portal ${from.name} on ${bareMap(from.map)}.`
      : "No portal leads into it yet: pick an entrance portal.");
    lines.push(`Players arrive at ${d.entranceX ?? "?"}, ${d.entranceY ?? "?"} on the map.`);
    lines.push(d.enabled
      ? "It is open: dungeon portals that lead to it take players in."
      : "It is closed: portals that lead to it say so. Copies that are already open keep running.");
    lines.push("Each party gets its own copy of the map. Copies already open keep what they were opened with.");
    return lines;
  }

  // ------------------------------------------------------------------ render

  protected renderList(): void {
    if (!this.ready || !this.active) return;
    const wanted = lower(this.shell.query);
    const rows: ListRow[] = [];
    if (this.draft && this.originalId === null) {
      rows.push({
        id: "\u0000new", name: String(this.draft.name || "New dungeon"), note: "Not saved yet", selected: true,
        thumb: thumb(null, { fallback: "portal" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const d of this.data.dungeons) {
      if (wanted && !lower(d.name).includes(wanted) && !lower(d.map).includes(wanted)) continue;
      rows.push({
        id: String(d.id), name: d.name, note: this.noteOf(d), selected: d.id === this.originalId,
        thumb: thumb(null, { fallback: "portal" }),
        tags: d.enabled ? [] : [tag("Closed", "muted")],
        actions: [
          { icon: "copy", label: `Duplicate ${d.name}`, onClick: () => void this.duplicateOf(d) },
          { icon: "trash" as const, label: `Delete ${d.name}`, danger: true, onClick: () => void this.deleteEntry(d) },
        ],
        onOpen: () => void this.select(d.id),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No dungeons match that search", text: "Check the spelling, or search for less of the name or map." }
        : { title: "There are no dungeons yet", text: "Start the first one with New dungeon, then pick a portal made on the Portals tab to lead into it." },
    });
  }

  private banner(): { tone: "danger"; icon: "alert"; text: string } | null {
    return this.data.ready ? null : { tone: "danger", icon: "alert", text: "The dungeons table could not be read when the game server started, so nothing can be saved. The server log says why." };
  }

  protected chrome(): void {
    if (!this.active) return;
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setBanner(this.banner());
      return;
    }
    const saved = this.originalId !== null;
    shell.setRecord({ title: String(d.name || "").trim() || "New dungeon", note: typeWord(d.type), thumb: thumb(null, { size: "lg", fallback: "portal" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    const deleting = this.pending?.kind === "delete";
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (this.pending.kind === "save" ? "save" : deleting ? "delete" : "other") : null,
      canSave: this.data.ready, canDuplicate: saved, canDelete: saved,
      why: { duplicate: "Save it first, then it can be copied", delete: "It has not been saved, so there is nothing to delete" },
    });
    shell.setBanner(this.banner());
  }

  protected renderForm(): void {
    if (!this.active) return;
    this.chrome();
    this.summaryEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Pick a dungeon from the list on the left, or start a new one.", this.data.dungeons.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New dungeon", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(this.pageKey(), { aside: true });
    const d = this.draft;
    const map = this.mapOf(d.map);

    const about = this.section(main, "Dungeon", "What it is called and where it is played");
    about.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: this.nameMax, wide: true, hint: "Shown to players. Must be unique." }, "name"));
    about.appendChild(this.field({
      key: "map", label: "Map", type: "asset", noIcons: true, assets: () => this.mapOptions(), fallback: "map", rerender: true,
      hint: map ? `${map.widthPx} × ${map.heightPx} pixels. Each party plays its own copy of it.` : "The map the dungeon is played on. A map has one dungeon at most.",
    }, "map"));
    about.appendChild(this.field({
      key: "type", label: "Type", type: "segmented", rerender: true,
      options: () => [{ value: "dungeon", label: "Dungeon" }, { value: "raid", label: "Raid" }],
      hint: d.type === "raid" ? "A raid group of 10 or 20 players." : "A party of up to 5 players.",
    }, "type"));
    about.appendChild(this.field({ key: "enabled", label: "Enabled", type: "switch", hint: "When off, portals into it say it is closed. Copies that are already open keep running." }, "enabled"));
    about.appendChild(this.portalColourField(d));

    const sizes = this.section(main, "Sizes", "How many players it is for, and how much harder each size makes its creatures");
    if (d.type === "raid") {
      const bits = { sizes: RAID_BITS.reduce((mask, { bit, size }) => (d.sizes.includes(size) ? mask | bit : mask), 0) };
      const wrap = this.field({ key: "sizes", label: "Raid sizes", type: "flags", wide: true, hint: "The sizes a raid group can enter it at." }, "sizes", bits, () => {
        this.setSizes(RAID_BITS.filter(({ bit }) => (bits.sizes & bit) !== 0).map(({ size }) => size));
        this.renderForm();
      });
      wrap.classList.add("dg-sizes");
      sizes.appendChild(wrap);
    } else {
      sizes.appendChild(this.field({ key: "size", label: "Size", type: "readonly", wide: true, hint: "A dungeon is always for a party of 5." }, "sizes", { size: "5 players" }));
    }
    for (const size of d.sizes) {
      const key = String(size) as SizeKey;
      const target = d.multipliers[key];
      sizes.appendChild(this.field({
        key: "health", label: `Health × at ${size}`, type: "number", min: MULTIPLIER_MIN, max: MULTIPLIER_MAX, step: 0.1, unit: "×", newRow: true,
        hint: `Creatures' health at ${size} players. From ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX}.`,
      }, `multipliers.${key}.health`, target));
      sizes.appendChild(this.field({
        key: "damage", label: `Damage × at ${size}`, type: "number", min: MULTIPLIER_MIN, max: MULTIPLIER_MAX, step: 0.1, unit: "×",
        hint: `Creatures' damage at ${size} players. From ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX}.`,
      }, `multipliers.${key}.damage`, target));
    }

    const entrance = this.section(main, "Entrance", "The portal players go in through, and where they arrive on the map");
    entrance.appendChild(this.field({
      key: "portal", label: "Entrance portal", type: "select", wide: true, asText: true, options: () => this.portalOptions(),
      hint: "A dungeon portal made on the Portals tab that leads into no other dungeon. A dungeon leads from one portal.",
    }, "portal"));
    entrance.appendChild(this.field({
      key: "entranceX", label: "Entrance X", type: "number", min: 0, max: map ? Math.max(0, map.widthPx - 1) : undefined, step: 1, unit: "px",
      hint: entranceHint(map?.widthPx, "left"),
    }, "entranceX"));
    entrance.appendChild(this.field({
      key: "entranceY", label: "Entrance Y", type: "number", min: 0, max: map ? Math.max(0, map.heightPx - 1) : undefined, step: 1, unit: "px",
      hint: entranceHint(map?.heightPx, "top"),
    }, "entranceY"));

    // what the fields add up to in the game, beside the form
    const { body } = card(aside, "In plain words", "What this dungeon is in the game");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.append(el("span", "tl-preview-name", String(d.name || "New dungeon")), el("span", "tl-preview-kind", typeWord(d.type)));
    head.append(thumb(null, { size: "xl", fallback: "portal" }), said);
    this.summaryEl = el("div", "tl-summary");
    body.append(head, this.summaryEl);
    this.paintLive();
  }

  /** The portal's colour: the type's own until one is picked, and a button back to it. */
  private portalColourField(d: Dungeon): HTMLElement {
    const view = { portalColor: d.portalColor ?? PORTAL_DEFAULTS[d.type] };
    const own = d.type === "raid" ? "green" : "blue";
    const wrap = colourField({
      key: "portalColor", label: "Portal colour",
      hint: d.portalColor ? `Its portals glow in this colour. Use ${own} puts back the ${lower(typeWord(d.type))} colour.` : `A ${lower(typeWord(d.type))}'s portals glow ${own} unless a colour is picked.`,
    }, view, () => {
      d.portalColor = view.portalColor.toLowerCase();
      this.touched("portalColor", wrap);
      reset.hidden = false;
    });
    const reset = button(`Use ${own}`, () => {
      d.portalColor = null;
      this.touched("portalColor", wrap);
      this.renderForm();
    }, { kind: "quiet", small: true });
    reset.hidden = d.portalColor === null;
    wrap.querySelector(".pe-colour")?.appendChild(reset);
    if (this.fieldErrors.portalColor) setFieldError(wrap, this.fieldErrors.portalColor);
    return wrap;
  }

  private mapOptions(): AssetOption[] {
    return this.data.maps.map((m) => {
      const taken = this.onMap(m.name);
      return { value: m.name, label: taken ? `${m.name} (${taken.name})` : m.name };
    });
  }

  private paintLive(): void {
    if (!this.draft) return;
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  // ------------------------------------------------------------------ fields

  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields tl-fields-2");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  private field(field: Field, path: string, target: object = this.draft!, after?: () => void): HTMLElement {
    const wrap = this.fields.renderField({ ...field, path }, target, () => {
      this.touched(path, wrap);
      after?.();
    }, { error: this.fieldErrors[path] });
    return wrap;
  }

  private touched(path: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    if (path === "type") this.setSizes(this.draft!.type === "raid" ? this.raidSizes : [5]);
    if (path === "map") {
      delete this.fieldErrors.entranceX;
      delete this.fieldErrors.entranceY;
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
    if (path === "name" || path === "map") this.renderList();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(String(this.draft.name || "New dungeon"));
  }

  private open(draft: Dungeon, originalId: number | null, dirty: boolean): void {
    this.complete(draft);
    this.originalId = originalId;
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.sizesSeen = new Set(draft.sizes);
    this.raidSizes = draft.type === "raid" && draft.sizes.length ? draft.sizes.slice() : [10];
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(id: number | null): Promise<void> {
    if (id === null || id === this.originalId || !(await this.mayLeave())) return;
    const d = this.find(id);
    if (!d) return;
    this.open(clone(d), id, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  private async duplicateOf(d: Dungeon | null): Promise<void> {
    if (!d || !(await this.mayLeave())) return;
    const copy = clone(d);
    copy.id = null;
    copy.name = `${copy.name} copy`.slice(0, this.nameMax);
    // a map has one dungeon at most, so the copy needs a map of its own; and a portal leads into one dungeon
    copy.map = "";
    copy.portal = "";
    this.open(copy, null, true);
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
    const data: any = {
      id: this.originalId, name: String(d.name ?? "").trim(), map: d.map, type: d.type, sizes: d.sizes.slice(),
      multipliers: Object.fromEntries(SIZE_KEYS.map((k) => [k, { health: d.multipliers[k].health, damage: d.multipliers[k].damage }])),
      entranceX: d.entranceX, entranceY: d.entranceY, enabled: d.enabled, portalColor: d.portalColor,
    };
    // the portal links are sent only when the pick changed, so a save leaves links made elsewhere alone
    if ((d.portal ?? "") !== this.portalOf(this.originalId)) {
      const [map, name] = d.portal ? JSON.parse(d.portal) as [string, string] : [null, null];
      data.portal = map === null ? null : { map, name };
    }
    this.beginRequest("save", "DUNGEON_EDITOR_SAVE", data, String(d.name ?? ""));
  }

  private async deleteEntry(d: Dungeon | null): Promise<void> {
    if (!d || d.id === null || this.pending || !this.find(d.id)) return;
    const agreed = await this.shell.confirmDelete(d.name, [
      "This cannot be undone.",
      "Copies that are already open keep running until they close. No new ones open, and portals that lead to it say it is closed.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "DUNGEON_EDITOR_DELETE", { id: d.id }, d.name);
  }
}
