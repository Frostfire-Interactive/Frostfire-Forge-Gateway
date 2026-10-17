// Mailbox editor popup (/mailbox). USER REQUEST 2026-10-16 ("Add a /mailbox command to open a UI to edit where
// mailboxes are placed and the ability to move them"), on the editor pattern of the others (USER REQUEST
// 2026-10-17). Talks to the game window over postMessage; the game window forwards the requests to the server
// (engine src/systems/mailboxeditor.ts), which validates and persists, and draws in the world what is open here.
// The window itself is the shared workbench (tooleditor.ts).
//
// A record is a map. The list is the map the admin is on and the maps they visited last (visitedmaps.ts); any other
// map is found by a search of its name, which the server answers 50 at a time, as the item editor's search. A map left alone has
// its mailboxes in front of its inns; saving gives it a list of its own, and Delete gives it back to its inns.
// The mailboxes of the map the admin is on are dragged in the game, and each change shows there at once; nothing
// is saved until Save. There are few such maps, so the list is held whole here: every answer carries it afresh.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type Field } from "./toolfields.js";
import { button, card, count, el, empty, icon, iconButton, noticeDialog, shown, tag, thumb, toast } from "./toolkit.js";

interface Spot { x: number | null; y: number | null }
interface EditorMap { map: string; mailboxes: Spot[]; placed: boolean }
interface EditorData { here: string; maps: EditorMap[]; query: string; truncated: number; coordinateMax: number; ready: boolean }

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** How far right of the last mailbox (px) "Add mailbox" puts one on a map the admin is not on. */
const STEP = 32;

class MailboxEditorBridge {
  private data: EditorData = { here: "", maps: [], query: "", truncated: 0, coordinateMax: 1_000_000, ready: true };
  private ready = false;
  /** The map open, and its mailboxes as they are being edited. */
  private draft: EditorMap | null = null;
  private opened = 0;
  private dirty = false;
  private refused = false;
  /** The mailbox picked in the game, or in the list here: drawn in gold there. */
  private picked: number | null = null;
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  private pending: { kind: "save" | "delete"; packet: string; name: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private summaryEl: HTMLElement | null = null;
  /** A mailbox picked in the game on a map the list did not have: picked once the list comes with it. */
  private pickWaiting: { map: string; index: number } | null = null;

  private shell = new EditorShell({
    tool: "Mailbox Editor", noun: "map", icon: "map",
    // the server searches, as in the item editor: the whole list of maps is never sent
    onSearch: (query) => this.askForList(query),
    onSave: () => this.save(),
    onDelete: () => void this.deleteEntry(this.draft?.map ?? null),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
    // the game draws the mailboxes as the server holds them again
    window.addEventListener("beforeunload", () => this.shell.send({ type: "preview", map: null }));
  }

  /** Asks for the list: the search as typed, and the map open, so it stays listed. */
  private askForList(query = this.shell.query): void {
    this.shell.send({ type: "request", packet: "MAILBOX_EDITOR_LIST", data: { query, open: this.draft?.map ?? null } });
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "data": {
        this.adopt(msg.data);
        this.renderList();
        this.renderForm();
        const waiting = this.pickWaiting;
        this.pickWaiting = null;
        if (waiting) void this.pickInGame(waiting.map, waiting.index);
        break;
      }
      case "mapChanged":
        // the admin went to another map: it is listed first now
        this.askForList();
        break;
      case "result": {
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
        break;
      }
      case "updated":
        toast(`${shown(msg.by)} changed the mailboxes of a map. The list shows them as they are now.`);
        this.askForList();
        break;
      case "pick":
        void this.pickInGame(String(msg.map ?? ""), Number(msg.index));
        break;
      case "moved":
        this.movedInGame(String(msg.map ?? ""), Number(msg.index), Number(msg.x), Number(msg.y), !!msg.final);
        break;
      case "standing":
        this.placeBesideMe(String(msg.map ?? ""), Number(msg.x), Number(msg.y), msg.purpose, Number(msg.index));
        break;
    }
  }

  private adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.maps)) this.data.maps = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.maps.length);
    if (!follow || !this.draft || this.dirty || this.pending) return;
    const now = this.find(this.draft.map);
    if (now) {
      this.draft = clone(now);
      if (this.picked !== null && this.picked >= now.mailboxes.length) this.picked = null;
    } else {
      // left behind by the admin, or given back to its inns in another editor
      this.draft = null;
      this.picked = null;
      this.refused = false;
      this.clearProblems();
    }
    this.sendPreview();
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
    this.adopt(msg.data);
    toast([`Saved the mailboxes of ${msg.name ?? "the map"}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  private onDeleteResult(msg: any, asked: string): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      void noticeDialog(`The mailboxes of ${asked} were not deleted`, [...(msg.errors?.length ? msg.errors : ["The server refused to delete them."]), ...(msg.notes ?? [])]);
      this.renderForm();
      return;
    }
    if (this.draft?.map === msg.name) {
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
    }
    this.adopt(msg.data);
    toast([`Deleted the mailboxes placed by hand on ${msg.name ?? asked}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  private report(lines: string[]): void {
    if (!this.ready) this.shell.refused(lines, () => this.askForList());
    else if (this.draft) {
      this.otherProblems = lines;
      this.shell.setProblems(this.problemLines());
    } else toast(lines.join("\n"), "error");
  }

  // ------------------------------------------------------------------ the game

  /** Tells the game what is open: drawn there while it is the map the admin is on. */
  private sendPreview(): void {
    const d = this.draft;
    this.shell.send(d
      ? { type: "preview", map: d.map, mailboxes: d.mailboxes.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)), picked: this.picked }
      : { type: "preview", map: null });
  }

  private isHere(map: string | undefined): boolean {
    return !!map && lower(map) === lower(this.data.here);
  }

  /** A mailbox was clicked or tapped in the game: the map it is on is opened, and it is picked. */
  private async pickInGame(map: string, index: number): Promise<void> {
    if (!this.ready || !Number.isInteger(index) || index < 0) return;
    if (!this.draft || lower(this.draft.map) !== lower(map)) {
      const record = this.find(map);
      if (!record) {
        // not in the list as searched: the search is cleared, and the map is picked once the list comes
        if (this.pickWaiting) return;
        this.pickWaiting = { map, index };
        this.shell.clearQuery();
        this.askForList("");
        return;
      }
      if (!(await this.mayLeave())) return;
      this.open(clone(record), false);
    }
    this.picked = index;
    this.sendPreview();
    this.renderForm();
    this.shell.reveal(`[data-mailbox="${index}"]`);
  }

  /** A mailbox was dragged in the game: its place, as it moves (`final`: let go). */
  private movedInGame(map: string, index: number, x: number, y: number, final: boolean): void {
    const d = this.draft;
    const spot = d && lower(d.map) === lower(map) ? d.mailboxes[index] : undefined;
    if (!spot || !Number.isFinite(x) || !Number.isFinite(y)) return;
    spot.x = Math.round(x);
    spot.y = Math.round(y);
    this.picked = index;
    this.dirty = true;
    this.refused = false;
    for (const path of Object.keys(this.fieldErrors)) if (path.startsWith(`mailboxes.${index}`)) delete this.fieldErrors[path];
    this.renderForm();
    if (final) this.sendPreview();
  }

  /** Where the game said the admin stands: a mailbox added there, or the picked one brought there. */
  private placeBesideMe(map: string, x: number, y: number, purpose: unknown, index: number): void {
    const d = this.draft;
    if (!d || lower(d.map) !== lower(map) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (purpose === "bring" && d.mailboxes[index]) {
      d.mailboxes[index] = { x, y };
      this.picked = index;
    } else if (purpose === "add") {
      d.mailboxes.push({ x, y });
      this.picked = d.mailboxes.length - 1;
    } else return;
    this.changed();
  }

  // ------------------------------------------------------------------ rules

  private find(map: string): EditorMap | undefined {
    return this.data.maps.find((m) => lower(m.map) === lower(map));
  }

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    const most = this.data.coordinateMax;
    const seen = new Set<string>();
    d.mailboxes.forEach((spot, i) => {
      for (const axis of ["x", "y"] as const) {
        const value = spot[axis];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > most) errors[`mailboxes.${i}.${axis}`] = `${axis.toUpperCase()} must be a whole number from 0 to ${most}.`;
      }
      const at = `${spot.x}:${spot.y}`;
      if (seen.has(at)) errors[`mailboxes.${i}`] = "Another mailbox stands on the same spot.";
      seen.add(at);
    });
    return errors;
  }

  private problemLines(): string[] {
    const marked = new Set(Object.keys(this.fieldErrors).map((path) => /^mailboxes\.\d+/.exec(path)?.[0] ?? path));
    if (marked.size === 0) return this.otherProblems;
    const lines = [`${count(marked.size, "mailbox needs", "mailboxes need")} fixing.`];
    if (this.fieldErrors.mailboxes) lines.push(this.fieldErrors.mailboxes);
    return lines;
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

  private noteOf(m: EditorMap): string {
    const many = m.mailboxes.length === 0 ? "no mailbox" : count(m.mailboxes.length, "mailbox", "mailboxes");
    return m.placed ? `${many} · placed by hand` : many;
  }

  private summary(): string[] {
    const d = this.draft!;
    const saved = this.find(d.map);
    const lines: string[] = [];
    if (d.mailboxes.length === 0) lines.push(`Saved like this, ${d.map} has no mailbox: no one can send or read mail there.`);
    else lines.push(`${d.map} has ${count(d.mailboxes.length, "mailbox", "mailboxes")}. Mail is used within reach of one.`);
    if (saved?.placed) lines.push("They were placed by hand. Delete gives the map back to its inns, which place one in front of each inn door.");
    else lines.push("Its inns place them now, one in front of each inn door. Saving gives the map a list of its own, and the inns place none any more.");
    lines.push(this.isHere(d.map)
      ? "You are on this map: the mailboxes are drawn in the game as they are here, in a frame. Drag one to move it."
      : "You are not on this map, so its mailboxes cannot be dragged. Set X and Y, or go there and open it again.");
    return lines;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const wanted = this.data.query;
    const rows: ListRow[] = [];
    for (const m of this.data.maps) {
      const tags = [];
      if (this.isHere(m.map)) tags.push(tag("You are here", "you", "pin"));
      rows.push({
        id: m.map, name: m.map, note: this.noteOf(m), selected: lower(m.map) === lower(this.draft?.map),
        thumb: thumb(null, { fallback: "map" }), tags,
        actions: m.placed ? [{ icon: "trash" as const, label: `Delete the mailboxes placed by hand on ${m.map}`, danger: true, onClick: () => void this.deleteEntry(m.map) }] : [],
        onOpen: () => void this.select(m.map),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No maps match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "No map", text: "Search for a map by its name." },
      foot: this.data.truncated > 0
        ? `${count(this.data.truncated, "more map matches", "more maps match")}. Narrow the search to see them.`
        : wanted ? "" : "The map you are on, and the maps you visited last. Search to find any other map.",
    });
  }

  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    const missing = this.data.ready ? null : { tone: "danger" as const, icon: "alert" as const, text: "The mailbox_spots table could not be made when the game server started, so nothing can be saved. The server log says why." };
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setBanner(missing);
      return;
    }
    const saved = this.find(d.map);
    shell.setRecord({ title: d.map, note: this.isHere(d.map) ? "Mailboxes · the map you are on" : "Mailboxes", thumb: thumb(null, { size: "lg", fallback: "map" }) });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending?.kind === "delete" ? "deleting" : this.refused ? "error" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? this.pending.kind : null,
      canSave: this.data.ready, canDelete: !!saved?.placed,
      why: { delete: "Its inns place its mailboxes: there is no list of its own to delete" },
      deleteTip: "Delete the mailboxes placed by hand: the inns place them again",
    });
    shell.setBanner(missing ?? (this.isHere(d.map) ? null : { tone: "info", icon: "info", text: "You are not on this map, so its mailboxes cannot be dragged in the game. X and Y can still be set here." }));
  }

  private renderForm(): void {
    this.chrome();
    this.summaryEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const first = this.data.maps[0];
      const box = this.shell.idle("Pick a map from the list on the left, or search for any map by its name.", null);
      if (first) box.appendChild(button(`Open ${first.map}`, () => void this.select(first.map), { icon: "map", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}`, { aside: true });
    this.renderMailboxes(main);

    const { body } = card(aside, "In plain words", "What this map's mailboxes are in the game");
    this.summaryEl = el("div", "tl-summary");
    body.appendChild(this.summaryEl);
    this.paintLive();
  }

  /** The mailboxes: Add mailbox at the top, then a card each, the newest (the highest number) first. */
  private renderMailboxes(main: HTMLElement): void {
    const d = this.draft!;
    const here = this.isHere(d.map);

    const add = button("Add mailbox", () => {
      if (here) {
        this.shell.send({ type: "whereAmI", purpose: "add" });
        return;
      }
      const last = d.mailboxes[d.mailboxes.length - 1];
      d.mailboxes.push(last && Number.isFinite(last.x) && Number.isFinite(last.y) ? { x: Number(last.x) + STEP, y: Number(last.y) } : { x: 0, y: 0 });
      this.picked = d.mailboxes.length - 1;
      this.changed();
    }, { icon: "plus", add: true });
    main.appendChild(add);
    if (here) {
      main.appendChild(el("p", "tl-why", "Add mailbox puts it beside you in the game."));
    }

    if (d.mailboxes.length === 0) {
      const none = el("section", "tl-card");
      empty(none, "pin", "No mailbox", "Saved like this, the map has none. Add one above.");
      main.appendChild(none);
    }

    for (let index = d.mailboxes.length - 1; index >= 0; index--) {
      const spot = d.mailboxes[index];
      const at = `mailboxes.${index}`;
      const part = card(main, `Mailbox ${index + 1}`, here ? "Drag it in the game, or set where it stands" : "Where it stands, in px from the map's top left");
      part.root.dataset.mailbox = String(index);
      if (index === this.picked) part.tools.append(tag("Picked", "you"));
      if (here) {
        part.tools.append(iconButton("pin", `Bring mailbox ${index + 1} to me`, () => this.shell.send({ type: "whereAmI", purpose: "bring", index }), { size: 15 }));
      }
      part.tools.append(iconButton("trash", `Remove mailbox ${index + 1}`, () => {
        d.mailboxes.splice(index, 1);
        if (this.picked === index) this.picked = null;
        else if (this.picked !== null && this.picked > index) this.picked--;
        // positions changed, so the problems reported by position no longer line up
        for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("mailboxes")) delete this.fieldErrors[path];
        this.changed();
      }, { danger: true, size: 15 }));
      const wrong = this.fieldErrors[at];
      if (wrong) part.body.appendChild(this.entryError(wrong));
      const grid = el("div", "tl-fields tl-fields-2");
      part.body.appendChild(grid);
      for (const axis of ["x", "y"] as const) {
        grid.appendChild(this.field({ key: axis, label: axis.toUpperCase(), type: "number", min: 0, max: this.data.coordinateMax, step: 1, unit: "px" }, `${at}.${axis}`, spot));
      }
    }
  }

  private entryError(message: string): HTMLElement {
    const line = el("p", "tl-field-error");
    line.setAttribute("role", "alert");
    line.append(icon("alert", 13), el("span", "", message));
    return line;
  }

  private paintLive(): void {
    if (!this.draft || !this.summaryEl) return;
    this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  // ------------------------------------------------------------------ fields

  private field(field: Field, path: string, target: object): HTMLElement {
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
    const entry = /^mailboxes\.\d+/.exec(path)?.[0];
    if (entry) {
      delete this.fieldErrors[entry];
      this.picked = Number(entry.split(".")[1]);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
    this.renderList();
    // typed in: shown in the game at once, as when it is dragged
    this.sendPreview();
  }

  /** A mailbox was added, removed or moved here: drawn again, here and in the game. */
  private changed(): void {
    this.dirty = true;
    this.refused = false;
    this.renderList();
    this.renderForm();
    this.sendPreview();
  }

  // ----------------------------------------------------------------- opening

  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.draft.map);
  }

  private open(draft: EditorMap, dirty: boolean): void {
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.picked = null;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
    this.sendPreview();
  }

  private async select(map: string): Promise<void> {
    if (lower(map) === lower(this.draft?.map) || !(await this.mayLeave())) return;
    const record = this.find(map);
    if (record) this.open(clone(record), false);
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
    this.beginRequest("save", "MAILBOX_EDITOR_SAVE", { map: d.map, mailboxes: d.mailboxes.map((s) => ({ x: s.x, y: s.y })) }, d.map);
  }

  private async deleteEntry(map: string | null): Promise<void> {
    const record = map ? this.find(map) : undefined;
    if (!record?.placed || this.pending) return;
    const agreed = await this.shell.confirmDelete(`the mailboxes of ${record.map}`, [
      "This cannot be undone.",
      "The mailboxes placed by hand are taken away, and the map's inns place one in front of each inn door again. A map without an inn has none.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "MAILBOX_EDITOR_DELETE", { map: record.map }, record.map);
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

new MailboxEditorBridge();
