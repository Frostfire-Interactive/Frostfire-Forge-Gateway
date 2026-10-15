// Class editor popup (USER REQUEST 2026-10-14: "create a class editor that can define certain base stats and learn
// certain spells at certain levels"). Talks to the game window over postMessage; the game window forwards everything
// to the server (engine src/systems/classeditor.ts), which validates and persists. The window itself is the shared
// workbench (tooleditor.ts); this file holds what is the class editor's own: its fields, the server's rules repeated
// so a slip is caught before the round trip, the list of spells a class learns, and its conversation with the server.
// There are few classes, so the list is held whole here: every answer of the server carries it afresh.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, empty, forbid, icon, iconButton, listed, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";

interface NumberRule { label: string; min: number; max: number; hint: string }
interface ClassSpell { spell: string; level: number }
interface SpellOption { name: string; icon: string | null; description: string; type: string | null }

interface CharacterClass {
  id: number | null;
  name: string;
  description: string;
  max_health: number | null;
  max_stamina: number | null;
  stat_damage: number | null;
  stat_armor: number | null;
  stat_critical_chance: number | null;
  stat_critical_damage: number | null;
  stat_avoidance: number | null;
  spells: ClassSpell[];
}

/** The base stats, in the order the form shows them, and what each is counted in. */
const STAT_KEYS = ["max_health", "max_stamina", "stat_damage", "stat_armor", "stat_critical_chance", "stat_critical_damage", "stat_avoidance"] as const;
const PERCENT = new Set(["stat_critical_chance", "stat_critical_damage", "stat_avoidance"]);

/** The record split as the other editors split theirs (the spell and item editors): what it is, its numbers, its list. */
const TABS = [
  { id: "general", label: "General" },
  { id: "stats", label: "Stats" },
  { id: "spells", label: "Spells" },
];
const TAB_TITLES: Record<string, string> = { general: "General", stats: "Stats", spells: "Spells" };

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class ClassEditorBridge {
  private data: {
    classes: CharacterClass[]; spells: SpellOption[]; numbers: Record<string, NumberRule>;
    nameMax: number; descriptionMax: number; spellsMax: number; levelMax: number; ready: boolean;
  } = { classes: [], spells: [], numbers: {}, nameMax: 45, descriptionMax: 500, spellsMax: 50, levelMax: 1000, ready: true };
  private ready = false;
  /** Id of the class being edited, or null for a new one. */
  private originalId: number | null = null;
  private draft: CharacterClass | null = null;
  private opened = 0;
  private dirty = false;
  private refused = false;
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string; name: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private tab = "general";
  private summaryEl: HTMLElement | null = null;
  /** What follows the fields as they are typed in: the line under each spell's title. */
  private live: Array<() => void> = [];

  private shell = new EditorShell({
    tool: "Class Editor", noun: "class", plural: "classes", icon: "sword", tabs: TABS,
    liveSearch: true,
    onTab: (id) => this.switchTab(id),
    onSearch: () => this.renderList(),
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicate(this.openRow()),
    onDelete: () => void this.deleteEntry(this.openRow()),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private askForList(): void {
    this.shell.send({ type: "request", packet: "CLASS_EDITOR_LIST", data: null });
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.adopt(msg.data);
      this.renderList();
      this.renderForm();
    } else if (msg.type === "result") {
      const mine = !!this.pending && (!msg.action || msg.action === this.pending.packet);
      if (!mine) {
        if (msg.data) this.adopt(msg.data);
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        this.renderList();
        if (this.ready) this.renderForm();
        return;
      }
      const { kind, name } = this.pending!;
      this.endRequest();
      if (kind === "save") this.onSaveResult(msg);
      else this.onDeleteResult(msg, name);
      this.renderList();
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed a class. The list shows it as it is now.`);
      this.askForList();
    }
  }

  private adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.classes)) this.data.classes = [];
    if (!Array.isArray(this.data.spells)) this.data.spells = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.classes.length);
    if (!follow || this.originalId === null || this.dirty || this.pending) return;
    const now = this.find(this.originalId);
    if (now) this.draft = clone(now);
    else {
      toast(`${this.draft?.name ?? "The class"} was deleted in another editor, so it has been closed here.`);
      this.draft = null;
      this.originalId = null;
      this.refused = false;
      this.clearProblems();
    }
  }

  private onSaveResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
    // a new class is followed by its name: the server gave it its id
    const saved = (msg.data?.classes as CharacterClass[] | undefined)?.find((c) => c.name === msg.name);
    if (saved) this.originalId = saved.id;
    this.adopt(msg.data);
    toast([`Saved ${msg.name ?? "the class"}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  private onDeleteResult(msg: any, asked: string): void {
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

  private report(lines: string[]): void {
    if (!this.ready) this.shell.refused(lines, () => this.askForList());
    else if (this.draft) {
      this.otherProblems = lines;
      this.shell.setProblems(this.problemLines());
    } else toast(lines.join("\n"), "error");
  }

  // ------------------------------------------------------------------ rules

  private find(id: number | null): CharacterClass | undefined {
    return id === null ? undefined : this.data.classes.find((c) => c.id === id);
  }

  private spell(name: string): SpellOption | undefined {
    return this.data.spells.find((s) => s.name === name);
  }

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const name = String(d.name ?? "").trim();
    if (!name) errors.name = "Name is required.";
    else if (name.length > this.data.nameMax) errors.name = `Name must be ${this.data.nameMax} characters or fewer.`;
    else if (this.data.classes.some((c) => c.id !== this.originalId && lower(c.name) === lower(name))) errors.name = "A class with that name already exists.";
    if (String(d.description ?? "").length > this.data.descriptionMax) errors.description = `Description must be ${this.data.descriptionMax} characters or fewer.`;
    for (const key of STAT_KEYS) {
      const rule = this.data.numbers[key];
      const value = d[key];
      if (!rule) continue;
      if (typeof value !== "number" || !Number.isInteger(value)) errors[key] = `${rule.label} must be a whole number.`;
      else if (value < rule.min || value > rule.max) errors[key] = `${rule.label} must be between ${rule.min} and ${rule.max}.`;
    }
    if (d.spells.length > this.data.spellsMax) errors.spells = `A class learns ${this.data.spellsMax} spells at most.`;
    const seen = new Set<string>();
    d.spells.forEach((entry, i) => {
      const key = `spells.${i}`;
      if (!entry.spell) errors[`${key}.spell`] = "Pick a spell.";
      else if (!this.spell(entry.spell)) errors[`${key}.spell`] = `${entry.spell} is not a spell (any more).`;
      else if (seen.has(lower(entry.spell))) errors[`${key}.spell`] = `${entry.spell} is in the list twice.`;
      if (!Number.isInteger(entry.level) || entry.level < 1 || entry.level > this.data.levelMax) errors[`${key}.level`] = `The level must be a whole number from 1 to ${this.data.levelMax}.`;
      seen.add(lower(entry.spell));
    });
    return errors;
  }

  private tabOf(path: string): string {
    if (path.startsWith("spells")) return "spells";
    return (STAT_KEYS as readonly string[]).includes(path) ? "stats" : "general";
  }

  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of Object.keys(this.fieldErrors)) counts[this.tabOf(path)] = (counts[this.tabOf(path)] ?? 0) + 1;
    return counts;
  }

  /** Where the marked fields are, or, when none is marked, what the server said that is not about one field. */
  private problemLines(): string[] {
    const fields = Object.keys(this.fieldErrors);
    if (fields.length === 0) return this.otherProblems;
    const tabs = [...new Set(fields.map((f) => this.tabOf(f)))];
    const lines = [`${count(fields.length, "field needs", "fields need")} fixing, on ${listed(tabs.map((t) => TAB_TITLES[t]))}.`];
    if (this.fieldErrors.spells) lines.push(this.fieldErrors.spells);
    return lines;
  }

  private clearProblems(): void {
    this.fieldErrors = {};
    this.otherProblems = [];
    this.shell.setProblems([]);
  }

  private showProblems(serverErrors: string[] = []): void {
    this.otherProblems = serverErrors;
    const tabs = [...new Set(Object.keys(this.fieldErrors).map((f) => this.tabOf(f)))];
    // show a tab that has a problem, unless the one in view already does
    if (tabs.length && !tabs.includes(this.tab)) this.tab = tabs[0];
    this.shell.setProblems(this.problemLines());
    this.renderForm();
  }

  private blank(): CharacterClass {
    const first = this.data.spells[0]?.name;
    return {
      id: null, name: "New class", description: "",
      max_health: 100, max_stamina: 100, stat_damage: 0, stat_armor: 0, stat_critical_chance: 10, stat_critical_damage: 10, stat_avoidance: 0,
      spells: first ? [{ spell: first, level: 1 }] : [],
    };
  }

  private openRow(): CharacterClass | null {
    return this.find(this.originalId) ?? this.draft;
  }

  // ---------------------------------------------------------------- in words

  private noteOf(c: CharacterClass): string {
    const spells = c.spells.length === 0 ? "no spells" : count(c.spells.length, "spell");
    return `${c.max_health ?? 0} health · ${c.max_stamina ?? 0} stamina · ${spells}`;
  }

  /** What the open class adds up to in the game, one sentence to a line. */
  private summary(): string[] {
    const d = this.draft!;
    const lines = [
      `A new ${String(d.name || "character").trim()} starts at level 1 with ${d.max_health ?? 0} health and ${d.max_stamina ?? 0} stamina, ${d.stat_damage ?? 0} damage and ${d.stat_armor ?? 0} armor.`,
      `Critical hits: ${d.stat_critical_chance ?? 0}% of hits, for ${d.stat_critical_damage ?? 0}% more damage. Avoids ${d.stat_avoidance ?? 0}% of hits.`,
    ];
    if (d.spells.length === 0) lines.push("Learns no spells.");
    else {
      const byLevel = new Map<number, string[]>();
      for (const s of [...d.spells].sort((a, b) => a.level - b.level)) byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), s.spell || "(no spell picked)"]);
      for (const [level, names] of byLevel) lines.push(`Level ${level}: learns ${listed(names)}.`);
    }
    lines.push("These are starting values: levelling works as for every character. Characters already made keep their stats; they learn spells added here once they reach the level (at their next login for levels already passed).");
    return lines;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const wanted = lower(this.shell.query);
    const rows: ListRow[] = [];
    if (this.draft && this.originalId === null) {
      rows.push({
        id: "\u0000new", name: String(this.draft.name || "New class"), note: "Not saved yet", selected: true,
        thumb: thumb(null, { fallback: "sword" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const c of this.data.classes) {
      if (wanted && !lower(c.name).includes(wanted)) continue;
      rows.push({
        id: String(c.id), name: c.name, note: this.noteOf(c), selected: c.id === this.originalId,
        thumb: thumb(null, { fallback: "sword" }),
        tags: [],
        actions: [
          { icon: "copy", label: `Duplicate ${c.name}`, onClick: () => void this.duplicate(c) },
          { icon: "trash" as const, label: `Delete ${c.name}`, danger: true, onClick: () => void this.deleteEntry(c) },
        ],
        onOpen: () => void this.select(c.id),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No classes match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "There are no classes yet", text: "While there are none, accounts go straight into the game with no character page. Start the first one with New class." },
    });
  }

  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setTabs(null);
      shell.setBanner(this.data.ready ? null : { tone: "danger", icon: "alert", text: "The classes table could not be made when the game server started, so nothing can be saved. The server log says why." });
      return;
    }
    const saved = this.originalId !== null;
    shell.setRecord({ title: String(d.name || "").trim() || "New class", note: "Class", thumb: thumb(null, { size: "lg", fallback: "sword" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    const deleting = this.pending?.kind === "delete";
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (this.pending.kind === "save" ? "save" : deleting ? "delete" : "other") : null,
      canSave: this.data.ready, canDuplicate: saved, canDelete: saved,
      why: { duplicate: "Save it first, then it can be copied", delete: "It has not been saved, so there is nothing to delete" },
    });
    shell.setTabs(this.tab, this.problemsByTab());
    shell.setBanner(this.data.ready ? null : { tone: "danger", icon: "alert", text: "The classes table could not be made when the game server started, so nothing can be saved. The server log says why." });
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    this.renderForm();
  }

  private renderForm(): void {
    this.chrome();
    this.summaryEl = null;
    this.live = [];
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Pick a class from the list on the left, or start a new one.", this.data.classes.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New class", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}:${this.tab}`, { aside: true });

    if (this.tab === "spells") this.renderSpells(main);
    else if (this.tab === "stats") this.renderStats(main);
    else this.renderGeneral(main);

    // what the numbers add up to in the game, beside the form on every tab
    const { body } = card(aside, "In plain words", "What this class is in the game");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.append(el("span", "tl-preview-name", String(this.draft.name || "New class")), el("span", "tl-preview-kind", "Class"));
    head.append(thumb(null, { size: "xl", fallback: "sword" }), said);
    this.summaryEl = el("div", "tl-summary");
    body.append(head, this.summaryEl);
    this.paintLive();
  }

  private renderGeneral(main: HTMLElement): void {
    const about = this.section(main, "Class", "What players see on the character page");
    about.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: this.data.nameMax, wide: true, hint: "Shown on the character page. Must be unique. It can be changed later: characters keep their class." }, "name"));
    about.appendChild(this.field({ key: "description", label: "Description", type: "textarea", rows: 3, maxLength: this.data.descriptionMax, wide: true, hint: "A sentence or two about the class, shown when a player picks it." }, "description"));
  }

  private renderStats(main: HTMLElement): void {
    const stats = this.section(main, "Base stats", "What a new character of this class starts with at level 1. Levelling works as for every character");
    for (const key of STAT_KEYS) {
      const rule = this.data.numbers[key];
      if (!rule) continue;
      stats.appendChild(this.field({
        key, label: rule.label, type: "number", min: rule.min, max: rule.max, step: 1, unit: PERCENT.has(key) ? "%" : undefined,
        hint: `${rule.hint} From ${rule.min} to ${rule.max}.`,
      }, key));
    }
  }

  /** The spells it learns: a card each, as the spell editor's effects and the quest editor's rewards. */
  private renderSpells(main: HTMLElement): void {
    const d = this.draft!;
    if (d.spells.length === 0) {
      const none = el("section", "tl-card");
      empty(none, "wand", "No spells", "Characters of this class learn no spells. Add one below; level 1 spells are known from the start.");
      main.appendChild(none);
    }

    d.spells.forEach((entry, index) => {
      const at = `spells.${index}`;
      const part = card(main, `Spell ${index + 1} · ${entry.spell || "No spell picked"}`, this.spellLine(entry));
      const lead = part.root.querySelector<HTMLElement>(".tl-card-lead");
      this.live.push(() => { if (lead) lead.textContent = this.spellLine(entry); });
      part.tools.append(iconButton("trash", `Remove spell ${index + 1}`, () => {
        d.spells.splice(index, 1);
        this.dirty = true;
        this.refused = false;
        // positions changed, so the problems reported by position no longer line up
        for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("spells")) delete this.fieldErrors[path];
        this.renderForm();
      }, { danger: true, size: 15 }));
      // what the server said about the spell as a whole
      const wrong = this.fieldErrors[at];
      if (wrong) part.body.appendChild(this.entryError(wrong));

      const grid = el("div", "tl-fields tl-fields-2");
      part.body.appendChild(grid);
      grid.appendChild(this.field(
        { key: "spell", label: "Spell", type: "asset", assets: () => this.spellOptions(), fallback: "wand", rerender: true, hint: this.spell(entry.spell)?.description || "Made in the spell editor." },
        `${at}.spell`, entry,
      ));
      grid.appendChild(this.field(
        { key: "level", label: "Learned at level", type: "number", min: 1, max: this.data.levelMax, step: 1 },
        `${at}.level`, entry,
      ));
    });

    const add = button("Add spell", () => {
      const used = new Set(d.spells.map((s) => lower(s.spell)));
      const top = d.spells.reduce((m, s) => Math.max(m, Number(s.level) || 1), 1);
      d.spells.push({ spell: this.data.spells.find((s) => !used.has(lower(s.name)))?.name ?? "", level: top });
      this.dirty = true;
      this.refused = false;
      delete this.fieldErrors.spells;
      this.renderForm();
    }, { icon: "plus", add: true });
    main.appendChild(add);
    const why = this.data.spells.length === 0 ? "There are no spells yet. Make them in the spell editor (/se)."
      : d.spells.length >= this.data.spellsMax ? `A class learns ${this.data.spellsMax} spells at most.` : "";
    if (why) {
      forbid(add, why);
      const said = el("p", "tl-why");
      said.append(icon("lock", 13), el("span", "", why));
      main.appendChild(said);
    }
  }

  private spellOptions(): AssetOption[] {
    return this.data.spells.map((s) => ({ value: s.name, label: s.name, image: s.icon }));
  }

  /** The line under a spell's title. */
  private spellLine(entry: ClassSpell): string {
    if (!Number.isInteger(entry.level) || entry.level < 1) return "Give it a level";
    return entry.level === 1 ? "Known from the start" : `Learned at level ${entry.level}`;
  }

  private entryError(message: string): HTMLElement {
    const line = el("p", "tl-field-error");
    line.setAttribute("role", "alert");
    line.append(icon("alert", 13), el("span", "", message));
    return line;
  }

  private paintLive(): void {
    if (!this.draft) return;
    for (const paint of this.live) paint();
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  // ------------------------------------------------------------------ fields

  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
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
    // a spell's own field put right: what was said about the spell as a whole goes too
    const entry = /^spells\.\d+/.exec(path)?.[0];
    if (entry) delete this.fieldErrors[entry];
    if (path.startsWith("spells")) delete this.fieldErrors.spells;
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
    if (path === "name") this.renderList();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(String(this.draft.name || "New class"));
  }

  private open(draft: CharacterClass, originalId: number | null, dirty: boolean): void {
    this.originalId = originalId;
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(id: number | null): Promise<void> {
    if (id === null || id === this.originalId || !(await this.mayLeave())) return;
    const c = this.find(id);
    if (!c) return;
    this.open(clone(c), id, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  private async duplicate(c: CharacterClass | null): Promise<void> {
    if (!c || !(await this.mayLeave())) return;
    const copy = clone(c);
    copy.id = null;
    copy.name = `${copy.name} copy`.slice(0, this.data.nameMax);
    this.open(copy, null, true);
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    const d = this.draft;
    this.beginRequest("save", "CLASS_EDITOR_SAVE", {
      id: this.originalId, name: String(d.name ?? "").trim(), description: String(d.description ?? ""),
      ...Object.fromEntries(STAT_KEYS.map((k) => [k, d[k]])),
      spells: d.spells.map((s) => ({ spell: s.spell, level: s.level })),
    }, String(d.name ?? ""));
  }

  private async deleteEntry(c: CharacterClass | null): Promise<void> {
    if (!c || c.id === null || this.pending || !this.find(c.id)) return;
    const others = this.data.classes.length - 1;
    const agreed = await this.shell.confirmDelete(c.name, [
      "This cannot be undone.",
      "Characters already of this class keep their stats and spells and go on playing. They learn no more of its spells.",
      others === 0
        ? "It is the last class: with none left, accounts go straight into the game again, with no character page."
        : "New characters can no longer choose it.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "CLASS_EDITOR_DELETE", { id: c.id }, c.name);
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      toast("The server did not answer in time, so nothing was confirmed.", "error");
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

new ClassEditorBridge();
