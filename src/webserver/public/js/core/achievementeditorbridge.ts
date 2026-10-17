// Achievement editor popup (/achievements). Talks to the game window over postMessage; the game window forwards the
// requests to the server (engine src/systems/achievements/editor.ts), which checks every field and saves. The window
// itself is the shared workbench (tooleditor.ts). Design: engine repo,
// docs/superpowers/specs/2026-10-17-achievements-design.md.
//
// A record is one achievement: what counts toward it, how many, and what it gives. There are few, so the list is
// searched here, at every key.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";

type Rule = "none" | "optional" | "required";
type Pick = "creatures" | "quests" | "items" | "mounts" | "maps" | "spells";

interface Achievement {
  id: number | null;
  name: string;
  description: string;
  icon: string | null;
  type: string;
  target: string | null;
  count: number | null;
  reward_item: string | null;
  reward_quantity: number | null;
  reward_mount: string | null;
  enabled: boolean;
}
interface Option { value: string; label: string; image?: string | null }
interface Criterion { type: string; label: string; target: Rule; pick: Pick | null }
type Options = Record<Pick | "icons", Option[]>;
interface Limits { nameMax: number; descriptionMax: number; iconMax: number; countMax: number; quantityMax: number }
interface EditorData { achievements: Achievement[]; criteria: Criterion[]; options: Options; limits: Limits; ready: boolean }

const PICK_LABEL: Record<Pick, string> = { creatures: "Creature", quests: "Quest", items: "Item", mounts: "Mount", maps: "Map", spells: "Spell" };
const NO_OPTIONS: Options = { creatures: [], quests: [], items: [], mounts: [], maps: [], spells: [], icons: [] };

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const blank = (value: unknown): boolean => value === null || value === undefined || String(value).trim() === "";

class AchievementEditorBridge {
  private data: EditorData = {
    achievements: [], criteria: [], options: NO_OPTIONS,
    limits: { nameMax: 100, descriptionMax: 500, iconMax: 255, countMax: 1_000_000, quantityMax: 999 }, ready: true,
  };
  private ready = false;
  private draft: Achievement | null = null;
  private opened = 0;
  private dirty = false;
  private refused = false;
  private query = "";
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private shell = new EditorShell({
    tool: "Achievement Editor", noun: "achievement", icon: "sparkle", liveSearch: true,
    onSearch: (query) => { this.query = query; this.renderList(); },
    onNew: () => void this.startNew(),
    onSave: () => this.save(),
    onDelete: () => void this.deleteEntry(),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private askForList(): void {
    this.shell.send({ type: "request", packet: "ACHIEVEMENT_EDITOR_LIST", data: {} });
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "data":
        this.adopt(msg.data);
        this.renderList();
        this.renderForm();
        break;
      case "result": {
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
      case "updated":
        toast(`${shown(msg.by)} changed the achievements. The list shows them as they are now.`);
        this.askForList();
        break;
    }
  }

  private adopt(data: any): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data, options: { ...NO_OPTIONS, ...(data.options ?? {}) } };
    if (!Array.isArray(this.data.achievements)) this.data.achievements = [];
    if (!Array.isArray(this.data.criteria)) this.data.criteria = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.achievements.length);
    if (!this.draft || this.dirty || this.pending || this.draft.id === null) return;
    const now = this.find(this.draft.id);
    this.draft = now ? clone(now) : null;
  }

  private find(id: number | null): Achievement | undefined {
    return id === null ? undefined : this.data.achievements.find((a) => a.id === id);
  }

  private criterion(type: string): Criterion | undefined {
    return this.data.criteria.find((c) => c.type === type);
  }

  private iconImage(name: string | null): string | null {
    if (blank(name)) return null;
    return this.data.options.icons.find((i) => lower(i.value) === lower(name))?.image ?? null;
  }

  private targetLabel(c: Criterion, target: string): string {
    const listed = c.pick ? this.data.options[c.pick].find((o) => lower(o.value) === lower(target)) : undefined;
    return listed?.label ?? target;
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
    this.clearProblems();
    if (this.draft) this.draft.id = Number(msg.id);
    this.adopt(msg.data);
    toast("Saved. It counts from now on.");
    for (const note of Array.isArray(msg.notes) ? msg.notes : []) toast(String(note));
    this.renderForm();
  }

  private onDeleteResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data);
      void noticeDialog("The achievement was not deleted", msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
      this.renderForm();
      return;
    }
    this.draft = null;
    this.dirty = false;
    this.clearProblems();
    this.adopt(msg.data);
    toast("Deleted the achievement.");
    this.renderForm();
  }

  // ------------------------------------------------------------------ rules

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const l = this.data.limits;
    const name = d.name.trim();
    if (!name) errors["name"] = "Enter a name.";
    else if (name.length > l.nameMax) errors["name"] = `A name is ${l.nameMax} characters at most.`;
    else if (this.data.achievements.some((a) => a.id !== d.id && lower(a.name).trim() === lower(name))) errors["name"] = `Another achievement is called ${name}.`;
    if ((d.description ?? "").trim().length > l.descriptionMax) errors["description"] = `A description is ${l.descriptionMax} characters at most.`;
    const c = this.criterion(d.type);
    if (!c) errors["type"] = "Pick what counts.";
    else if (c.target === "required" && blank(d.target) && c.pick) errors["target"] = `Pick the ${PICK_LABEL[c.pick].toLowerCase()}.`;
    const whole = (key: "count" | "reward_quantity", max: number, label: string) => {
      const v = d[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) errors[key] = `${label} must be a whole number from 1 to ${max}.`;
    };
    whole("count", l.countMax, d.type === "level" ? "Level" : "How many");
    if (!blank(d.reward_item)) whole("reward_quantity", l.quantityMax, "Quantity");
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

  private noteOf(a: Achievement): string {
    const c = this.criterion(a.type);
    const what = a.type === "level" ? `Level ${a.count ?? "?"}` : `${c?.label ?? a.type} · ${a.count ?? "?"}`;
    return a.enabled ? what : `Off · ${what}`;
  }

  private summary(): string[] {
    const d = this.draft!;
    const c = this.criterion(d.type);
    const lines: string[] = [];
    if (d.type === "level") lines.push(`Earned on reaching level ${d.count ?? "?"}.`);
    else if (c) {
      const target = c.pick && !blank(d.target) ? this.targetLabel(c, d.target!) : c.target === "optional" ? "any" : null;
      lines.push(`${c.label}${target ? ` (${target})` : ""}: ${d.count ?? "?"} to earn it.`);
    }
    const gifts: string[] = [];
    if (!blank(d.reward_item)) gifts.push(`${d.reward_quantity ?? 1} x ${d.reward_item}`);
    if (!blank(d.reward_mount)) gifts.push(`the mount ${d.reward_mount}`);
    lines.push(gifts.length > 0 ? `Gives ${gifts.join(" and ")}. An item that does not fit in the bags is mailed.` : "Gives no reward.");
    lines.push("Only what players do from now on counts. Earning it shows a popup and tells the party and the guild.");
    if (!d.enabled) lines.push("It is off: players do not see it and nothing counts toward it until it is turned on and saved.");
    return lines;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const rows: ListRow[] = this.data.achievements
      .filter((a) => !this.query || lower(a.name).includes(lower(this.query)))
      .map((a) => ({
        id: String(a.id), name: a.name, note: this.noteOf(a), selected: a.id === this.draft?.id,
        thumb: thumb(this.iconImage(a.icon), { fallback: "sparkle" }),
        tags: a.enabled ? [] : [tag("Off")],
        onOpen: () => void this.select(a.id),
      }));
    this.shell.setList({
      rows,
      empty: this.query
        ? { icon: "search", title: "No achievement has that name", text: "Check the spelling." }
        : { title: "No achievements yet", text: "New adds one." },
      foot: "Players see the ones that are on, in their achievements window (Y).",
    });
  }

  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    const missing = this.data.ready ? null : { tone: "danger" as const, icon: "alert" as const, text: "The achievement tables could not be made when the game server started, so nothing can be saved. The server log says why." };
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setBanner(missing);
      return;
    }
    shell.setRecord({ title: d.name || "New achievement", note: this.criterion(d.type)?.label ?? "Achievement", thumb: thumb(this.iconImage(d.icon), { size: "lg", fallback: "sparkle" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending?.kind === "delete" ? "deleting" : this.refused ? "error" : d.id === null ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty || d.id === null,
      busy: this.pending ? this.pending.kind : null,
      canSave: this.data.ready, canDelete: d.id !== null,
      why: { delete: "It is not saved yet" },
      deleteTip: "Delete the achievement and every player's progress toward it",
    });
    shell.setBanner(missing);
  }

  private noneFirst(options: Option[]): AssetOption[] {
    return [{ value: "", label: "None" }, ...options.map((o) => ({ value: o.value, label: o.label, image: o.image ?? null }))];
  }

  private targetOptions(c: Criterion): AssetOption[] {
    const listed = c.pick ? this.data.options[c.pick] : [];
    const any: AssetOption[] = c.target === "optional" ? [{ value: "", label: "Any" }] : [];
    return [...any, ...listed.map((o) => ({ value: o.value, label: o.label, image: o.image ?? null }))];
  }

  private renderForm(): void {
    this.chrome();
    if (!this.ready) return;
    const d = this.draft;
    if (!d) {
      const box = this.shell.idle("Pick an achievement from the list on the left, or add one.", null);
      box.appendChild(button("New achievement", () => void this.startNew(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}`, { aside: true });
    const l = this.data.limits;
    const c = this.criterion(d.type);

    const about = card(main, "Achievement", "What players see in the popup and in their achievements window");
    const aboutGrid = el("div", "tl-fields tl-fields-2");
    about.body.appendChild(aboutGrid);
    aboutGrid.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: l.nameMax, wide: true }));
    aboutGrid.appendChild(this.field({ key: "description", label: "Description", type: "textarea", maxLength: l.descriptionMax, rows: 3 }));
    aboutGrid.appendChild(this.field({ key: "icon", label: "Icon", type: "asset", assets: () => this.noneFirst(this.data.options.icons), fallback: "sparkle", rerender: true }));
    aboutGrid.appendChild(this.field({ key: "enabled", label: "On", type: "switch" }));

    const counts = card(main, "What counts", "One kind of deed, counted from now on");
    const countsGrid = el("div", "tl-fields tl-fields-2");
    counts.body.appendChild(countsGrid);
    countsGrid.appendChild(this.field({ key: "type", label: "Counts", type: "select", options: () => this.data.criteria.map((x) => ({ value: x.type, label: x.label })), asText: true, rerender: true, wide: true }));
    if (c && c.target !== "none" && c.pick) {
      const pick = c.pick;
      countsGrid.appendChild(this.field({
        key: "target", label: PICK_LABEL[pick], type: "asset", assets: () => this.targetOptions(c),
        noIcons: pick !== "items" && pick !== "mounts", fallback: "target", wide: true,
        ...(c.target === "optional" ? { hint: "Any counts every one." } : {}),
      }));
    }
    countsGrid.appendChild(this.field({ key: "count", label: d.type === "level" ? "Level" : "How many", type: "number", min: 1, max: l.countMax, step: 1 }));

    const reward = card(main, "Reward", "Given when it is earned. An item that does not fit in the bags is mailed.");
    const rewardGrid = el("div", "tl-fields tl-fields-2");
    reward.body.appendChild(rewardGrid);
    rewardGrid.appendChild(this.field({ key: "reward_item", label: "Item", type: "asset", assets: () => this.noneFirst(this.data.options.items), fallback: "box", rerender: true }));
    if (!blank(d.reward_item)) rewardGrid.appendChild(this.field({ key: "reward_quantity", label: "Quantity", type: "number", min: 1, max: l.quantityMax, step: 1 }));
    rewardGrid.appendChild(this.field({ key: "reward_mount", label: "Mount", type: "asset", assets: () => this.noneFirst(this.data.options.mounts), fallback: "paw", wide: true }));

    const { body } = card(aside, "In plain words", "What this achievement is in the game");
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
    // another kind of deed: what was picked for the last one does not fit it
    if (path === "type" && this.draft) this.draft.target = null;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.renderList();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.draft.name || "the new achievement");
  }

  private open(draft: Achievement, dirty: boolean): void {
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
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
    this.open({
      id: null, name: "", description: "", icon: null, type: this.data.criteria[0]?.type ?? "creature_kill", target: null, count: 1,
      reward_item: null, reward_quantity: 1, reward_mount: null, enabled: true,
    }, true);
  }

  // ----------------------------------------------------------------- actions

  private payload(): any {
    const d = this.draft!;
    return {
      id: d.id, name: d.name.trim(), description: (d.description ?? "").trim(), icon: blank(d.icon) ? null : d.icon,
      type: d.type, target: blank(d.target) ? null : d.target, count: d.count,
      reward_item: blank(d.reward_item) ? null : d.reward_item, reward_quantity: blank(d.reward_item) ? 1 : d.reward_quantity,
      reward_mount: blank(d.reward_mount) ? null : d.reward_mount, enabled: d.enabled,
    };
  }

  private save(): void {
    if (!this.draft || this.pending) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    this.beginRequest("save", "ACHIEVEMENT_EDITOR_SAVE", this.payload());
  }

  private async deleteEntry(): Promise<void> {
    const d = this.draft;
    if (!d || d.id === null || this.pending) return;
    const agreed = await this.shell.confirmDelete(d.name || "this achievement", [
      "This cannot be undone.",
      "Every player's progress toward it is deleted, and those who earned it lose it from their list. Rewards already given stay.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "ACHIEVEMENT_EDITOR_DELETE", { id: d.id });
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

new AchievementEditorBridge();
