// Mount editor popup (/mounteditor). Talks to the game window over postMessage; the game window forwards the
// requests to the server (engine src/systems/mounteditor.ts), which checks every field and saves. The window itself
// is the shared workbench (tooleditor.ts); the shape is the achievement editor's (achievementeditorbridge.ts).
//
// A record is one mount: its name, what its tooltip says, and its icon. What it looks like when ridden is the sprite
// sheet mount_<name> on the asset server. There are few mounts, so the list is searched here, at every key.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, note, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";

interface Mount {
  name: string;
  description: string;
  icon: string | null;
  /** The sprite sheet it is drawn with when ridden: mount_<name>. */
  sheet: string;
  /** That sheet is on the asset server. */
  hasSheet: boolean;
}
interface Limits { nameMax: number; descriptionMax: number; iconMax: number }
interface EditorData { mounts: Mount[]; icons: Array<{ name: string; image: string | null }>; limits: Limits; assetServerUrl?: string }

const lower = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const blank = (value: unknown): boolean => value === null || value === undefined || String(value).trim() === "";
/** The sheet a mount of that name is drawn with, as the server names it. */
const sheetOf = (name: string): string => `mount_${name.trim().toLowerCase()}`;

class MountEditorBridge {
  private data: EditorData = { mounts: [], icons: [], limits: { nameMax: 255, descriptionMax: 500, iconMax: 255 } };
  private ready = false;
  private draft: Mount | null = null;
  /** Name of the mount being edited, or null for a new one. A saved mount keeps its name. */
  private originalName: string | null = null;
  private opened = 0;
  private dirty = false;
  private refused = false;
  private query = "";
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private shell = new EditorShell({
    tool: "Mount Editor", noun: "mount", icon: "paw", liveSearch: true,
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
    this.shell.send({ type: "request", packet: "MOUNT_EDITOR_LIST", data: {} });
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
        toast(`${shown(msg.by)} changed the mounts. The list shows them as they are now.`);
        this.askForList();
        break;
    }
  }

  private adopt(data: any): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.mounts)) this.data.mounts = [];
    if (!Array.isArray(this.data.icons)) this.data.icons = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.mounts.length);
    // The open mount as the server now has it, unless it has changes of its own.
    if (!this.draft || this.dirty || this.pending || this.originalName === null) return;
    const now = this.find(this.originalName);
    this.draft = now ? clone(now) : null;
    if (!now) this.originalName = null;
  }

  private find(name: string | null): Mount | undefined {
    return name === null ? undefined : this.data.mounts.find((m) => lower(m.name) === lower(name));
  }

  /** Icon URL for a stored icon name: the listed one, or one built the way the game builds icon URLs. */
  private iconImage(name: string | null): string | null {
    if (blank(name)) return null;
    const bare = String(name).trim().replace(/\.(png|jpg|jpeg|gif)$/i, "");
    const listed = this.data.icons.find((i) => lower(i.name) === lower(bare));
    if (listed?.image) return listed.image;
    return this.data.assetServerUrl ? `${this.data.assetServerUrl}/icon?name=${encodeURIComponent(bare)}` : null;
  }

  /** The icons to pick from; the one the mount has is offered even when it is not in the list. */
  private iconAssets(): AssetOption[] {
    const current = String(this.draft?.icon ?? "");
    const options: AssetOption[] = [{ value: "", label: "None" }, ...this.data.icons.map((i) => ({ value: i.name, label: i.name, image: i.image }))];
    if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current, image: this.iconImage(current) });
    return options;
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
    if (msg.name) this.originalName = String(msg.name);
    this.adopt(msg.data);
    toast(`Saved ${this.originalName ?? "the mount"}.`);
    this.renderForm();
  }

  private onDeleteResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data);
      void noticeDialog("The mount was not deleted", msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
      this.renderForm();
      return;
    }
    this.draft = null;
    this.originalName = null;
    this.dirty = false;
    this.clearProblems();
    this.adopt(msg.data);
    toast(`Deleted ${msg.name ?? "the mount"}.`);
    this.renderForm();
  }

  // ------------------------------------------------------------------ rules

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const l = this.data.limits;
    if (this.originalName === null) {
      const name = d.name.trim();
      if (!name) errors["name"] = "Enter a name.";
      else if (name.length > l.nameMax) errors["name"] = `A name is ${l.nameMax} characters at most.`;
      else if (/[\\/]|\.\./.test(name)) errors["name"] = "A name cannot hold / or \\ or two dots in a row.";
      else if (this.find(name)) errors["name"] = `There is already a mount called ${name}.`;
    }
    const description = (d.description ?? "").trim();
    if (!description) errors["description"] = "Enter a description.";
    else if (description.length > l.descriptionMax) errors["description"] = `A description is ${l.descriptionMax} characters at most.`;
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

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const rows: ListRow[] = [];
    // A mount that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.originalName === null) {
      rows.push({
        id: "\u0000new", name: this.draft.name.trim() || "New mount", note: "Not saved yet", selected: true,
        thumb: thumb(this.iconImage(this.draft.icon), { fallback: "paw" }), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const m of this.data.mounts.filter((m) => !this.query || lower(m.name).includes(lower(this.query)))) {
      rows.push({
        id: m.name, name: m.name, note: m.hasSheet ? m.sheet : "No sprite sheet yet", selected: lower(m.name) === lower(this.originalName),
        thumb: thumb(this.iconImage(m.icon), { fallback: "paw" }),
        tags: m.hasSheet ? [] : [tag("No sheet", "warning")],
        onOpen: () => void this.select(m.name),
      });
    }
    this.shell.setList({
      rows,
      empty: this.query
        ? { icon: "search", title: "No mount has that name", text: "Check the spelling." }
        : { title: "No mounts yet", text: "New adds one." },
      foot: "Players get a mount from the player editor or an achievement.",
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
    shell.setRecord({ title: d.name.trim() || "New mount", note: "Mount", thumb: thumb(this.iconImage(d.icon), { size: "lg", fallback: "paw" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending?.kind === "delete" ? "deleting" : this.refused ? "error" : this.originalName === null ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty || this.originalName === null,
      busy: this.pending ? this.pending.kind : null,
      canDelete: this.originalName !== null,
      why: { delete: "It is not saved yet" },
      deleteTip: "Delete the mount",
    });
  }

  private renderForm(): void {
    this.chrome();
    if (!this.ready) return;
    const d = this.draft;
    if (!d) {
      const box = this.shell.idle("Pick a mount from the list on the left, or add one.", this.data.mounts.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New mount", () => void this.startNew(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}`, { aside: true });
    const l = this.data.limits;
    const saved = this.originalName !== null;

    const about = card(main, "Mount", "What players see in their collection and its tooltip");
    const grid = el("div", "tl-fields tl-fields-2");
    about.body.appendChild(grid);
    grid.appendChild(saved
      ? this.field({ key: "name", label: "Name", type: "readonly", wide: true, hint: "A saved mount keeps its name: players' collections and achievement rewards know it by name." })
      : this.field({ key: "name", label: "Name", type: "text", maxLength: l.nameMax, wide: true, rerender: true, hint: "Must be unique. It also names the sprite sheet the mount is drawn with." }));
    grid.appendChild(this.field({ key: "description", label: "Description", type: "textarea", maxLength: l.descriptionMax, rows: 3 }));
    grid.appendChild(this.field({ key: "icon", label: "Icon", type: "asset", assets: () => this.iconAssets(), fallback: "paw", rerender: true, hint: "Shown in the player's collectables window (K)." }));

    const looks = card(main, "When ridden", "The sprite sheet it is drawn with comes from the asset server");
    looks.body.appendChild(this.sheetNote());

    const { body } = card(aside, "In plain words", "What this mount is in the game");
    body.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  /** Which sheet the mount is drawn with, and whether the asset server has it. */
  private sheetNote(): HTMLElement {
    const d = this.draft!;
    const name = d.name.trim();
    if (!name) return note("Give it a name first: the sheet it is drawn with is named after it.", "plain", "image");
    const sheet = sheetOf(name);
    const listed = this.data.mounts.find((m) => m.sheet === sheet);
    if (listed?.hasSheet) return note(`Drawn with the sprite sheet ${sheet}.`, "plain", "image");
    const file = `spritesheets/mounts/${name.toLowerCase()}.png`;
    // A mount not saved yet has not been asked about: the server says whether its sheet is there once it is saved.
    return listed
      ? note([`The asset server has no sprite sheet ${sheet}, so riding it shows nothing.`, `Add ${file} to the asset server, then restart it.`], "warning")
      : note([`It will be drawn with the sprite sheet ${sheet}.`, `Add ${file} to the asset server if it is not there yet.`], "plain", "image");
  }

  private summary(): string[] {
    const d = this.draft!;
    const name = d.name.trim() || "This mount";
    const lines = [`${name} can be ridden by players who have it in their collection.`];
    lines.push("Give it to a player in the player editor (Add mount), or make it the reward of an achievement.");
    if (this.originalName === null) lines.push("It is not saved yet, so nothing can give it.");
    return lines;
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
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.draft.name.trim() || "the new mount");
  }

  private open(draft: Mount, originalName: string | null, dirty: boolean): void {
    this.draft = draft;
    this.originalName = originalName;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(name: string): Promise<void> {
    if (lower(name) === lower(this.originalName) || !(await this.mayLeave())) return;
    const record = this.find(name);
    if (record) this.open(clone(record), record.name, false);
  }

  private async startNew(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open({ name: "", description: "", icon: null, sheet: "", hasSheet: false }, null, true);
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
    this.beginRequest("save", "MOUNT_EDITOR_SAVE", {
      originalName: this.originalName, name: d.name.trim(), description: (d.description ?? "").trim(), icon: blank(d.icon) ? null : d.icon,
    });
  }

  private async deleteEntry(): Promise<void> {
    const name = this.originalName;
    if (!this.draft || name === null || this.pending) return;
    const agreed = await this.shell.confirmDelete(name, [
      "Players who have it no longer see it in their collection from their next login. A mount made later with the same name gives it back to them.",
      "Achievements that give it should be changed to give something else.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "MOUNT_EDITOR_DELETE", { originalName: name });
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

new MountEditorBridge();
