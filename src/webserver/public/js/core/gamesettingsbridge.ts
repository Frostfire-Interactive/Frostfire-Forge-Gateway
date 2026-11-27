import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type Field } from "./toolfields.js";
import { button, card, count, el, shown, tag, toast } from "./toolkit.js";
import { PreviewTracker, patchPlan, patchedInput, metaNote } from "./gamesettingslogic.js";

interface Setting {
  key: string;
  section: string;
  label: string;
  help: string;
  kind: "number" | "formula";
  default: number | string;
  min?: number;
  max?: number;
  integer?: boolean;
  /** What is in force now. */
  value: number | string;
  /** A row is saved: the value is not the default's by default. */
  overridden: boolean;
  /** Why the server does not use the saved row, when it does not. */
  refused?: string;
  updatedBy?: string;
  updatedAt?: number;
}
interface EditorData { sections: string[]; settings: Setting[]; maxLevel: number }
interface Preview { ok: boolean; error?: string; rows: Array<[number, number]>; value?: string }

const SAVE = "GAME_SETTINGS_EDITOR_SAVE";
const RESET = "GAME_SETTINGS_EDITOR_RESET";
const PREVIEW = "GAME_SETTINGS_EDITOR_PREVIEW";
const PREVIEW_WAIT_MS = 300;
const FORMULA_MAX = 200;

const lower = (s: unknown): string => String(s ?? "").trim().toLowerCase();

class GameSettingsBridge {
  private data: EditorData = { sections: [], settings: [], maxLevel: 0 };
  private ready = false;
  private section: string | null = null;
  private opened = 0;
  private query = "";
  /** What each field holds now, by key: the saved value, or what is typed and not yet saved. */
  private draft: Record<string, number | string | null> = {};
  private refused = false;
  private fieldErrors: Record<string, string> = {};
  private otherProblems: string[] = [];
  /** The save or reset waiting for the server. A save of a section is one request at a time, in order. */
  private pending: { kind: "save" | "reset"; packet: string; key: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private saved: string[] = [];

  private previews: Record<string, Preview> = {};
  private previewBoxes: Record<string, HTMLElement> = {};
  private previewWraps: Record<string, HTMLElement> = {};
  private previewTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** One request in flight per key; answers for text that is no longer the latest are dropped. */
  private tracker = new PreviewTracker();
  /** The text a preview was last asked for, per key, so the same text is not asked for twice. */
  private previewAsked: Record<string, string> = {};

  private shell = new EditorShell({
    tool: "Game Settings", noun: "section", icon: "gauge", liveSearch: true,
    onSearch: (query) => { this.query = query; this.renderList(); },
    onSave: () => this.save(),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private askForList(): void {
    this.shell.send({ type: "request", packet: "GAME_SETTINGS_EDITOR_LIST", data: {} });
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "data": {
        const before = this.data.settings.map((s) => ({ key: s.key, section: s.section }));
        const wasReady = this.ready;
        const kept = this.adopt(msg.data);
        this.renderList();
        const plan = patchPlan(before, this.data.settings, kept);
        // A reload on a form already open puts the new values in place, so the field being typed in keeps its focus.
        if (wasReady && this.section !== null && !plan.rebuild && this.patchForm(plan.patch, plan.refresh)) break;
        this.renderForm();
        break;
      }
      case "result": {
        if (msg.action === PREVIEW) {
          this.onPreview(msg);
          return;
        }
        const mine = !!this.pending && msg.action === this.pending.packet;
        if (!mine) {
          if (msg.data) this.adopt(msg.data);
          this.renderList();
          if (this.ready) this.renderForm();
          return;
        }
        const { kind, key } = this.pending!;
        this.endRequest();
        this.onWriteResult(kind, key, msg);
        this.renderList();
        break;
      }
      case "updated":
        toast(`${shown(msg.by)} changed the game settings. The list shows them as they are now; what you typed is kept.`);
        this.askForList();
        break;
    }
  }

  // ------------------------------------------------------------------- data

  private settingsOf(section: string | null): Setting[] {
    return section === null ? [] : this.data.settings.filter((s) => s.section === section);
  }

  private find(key: string): Setting | undefined {
    return this.data.settings.find((s) => s.key === key);
  }

  /** What the field would hold if it were not changed: the value in force. */
  private same(s: Setting, value: unknown): boolean {
    if (s.kind === "formula") return String(value ?? "").trim() === String(s.value);
    return value !== null && value !== undefined && value !== "" && Number(value) === Number(s.value);
  }

  private changed(s: Setting): boolean {
    return !this.same(s, this.draft[s.key]);
  }

  private changedIn(section: string | null): Setting[] {
    return this.settingsOf(section).filter((s) => this.changed(s));
  }

  private adopt(data: any): Set<string> {
    const none = new Set<string>();
    if (!data || typeof data !== "object" || !Array.isArray(data.settings)) return none;
    // What was typed and not saved stays; every other field shows what the server holds now.
    const kept = new Set(this.data.settings.filter((s) => this.changed(s)).map((s) => s.key));
    this.data = { sections: Array.isArray(data.sections) ? data.sections : [], settings: data.settings, maxLevel: Number(data.maxLevel) || 0 };
    for (const s of this.data.settings) {
      if (!kept.has(s.key) || !(s.key in this.draft)) this.draft[s.key] = s.value;
    }
    // The answers the server gave before may no longer hold (a level cap changes the curve's rows).
    this.previews = {};
    this.previewAsked = {};
    this.tracker.reset();
    if (!this.ready) this.section = this.data.sections[0] ?? null;
    else if (this.section !== null && !this.data.sections.includes(this.section)) this.section = this.data.sections[0] ?? null;
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.sections.length);
    return kept;
  }

  // ------------------------------------------------------------------ rules

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(settings: Setting[]): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const s of settings) {
      const value = this.draft[s.key];
      if (s.kind === "formula") {
        const text = String(value ?? "").trim();
        if (!text) errors[s.key] = "Enter a formula.";
        else if (text.length > FORMULA_MAX) errors[s.key] = `A formula is ${FORMULA_MAX} characters at most.`;
        continue;
      }
      if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) errors[s.key] = "Enter a number.";
      else if (s.integer && !Number.isInteger(Number(value))) errors[s.key] = "This is a whole number.";
      else if (s.min !== undefined && Number(value) < s.min) errors[s.key] = `The lowest is ${s.min}.`;
      // The level cap's top depends on the XP curve in force, which only the server works out.
      else if (s.key !== "maxLevel" && s.max !== undefined && Number(value) > s.max) errors[s.key] = `The highest is ${s.max}.`;
    }
    return errors;
  }

  private problemLines(): string[] {
    const wrong = Object.keys(this.fieldErrors).length;
    return wrong > 0 ? [`${count(wrong, "setting needs", "settings need")} fixing.`, ...this.otherProblems] : this.otherProblems;
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
    for (const name of this.data.sections.filter((n) => !this.query || lower(n).includes(lower(this.query)))) {
      const all = this.settingsOf(name);
      const edited = this.changedIn(name).length;
      const custom = all.filter((s) => s.overridden).length;
      rows.push({
        id: name, name, selected: name === this.section,
        note: custom ? `${count(all.length, "setting")}, ${custom} changed` : count(all.length, "setting"),
        tags: edited ? [tag("Unsaved", "warning")] : [],
        onOpen: () => this.select(name),
      });
    }
    this.shell.setList({
      rows,
      empty: { icon: "search", title: "No section has that name", text: "Check the spelling." },
      foot: "A setting that was never saved holds the game's own value.",
    });
  }

  private chrome(): void {
    const { shell } = this;
    if (this.section === null) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      return;
    }
    shell.setRecord({ title: this.section, note: "Game settings" });
    const dirty = this.changedIn(this.section).length > 0;
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.pending ? "loading" : this.refused ? "error" : dirty ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({ open: true, dirty, busy: this.pending?.kind === "save" ? "save" : this.pending ? "other" : null });
  }

  private renderForm(): void {
    this.chrome();
    if (!this.ready) return;
    if (this.section === null) {
      this.shell.idle("Pick a section from the list on the left.");
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main } = this.shell.page(`${this.opened}`);
    this.previewBoxes = {};
    this.previewWraps = {};
    const settings = this.settingsOf(this.section);
    const body = card(main, this.section, `${count(settings.length, "setting")}. Changes apply as each setting says.`).body;
    const grid = el("div", "tl-fields tl-fields-2");
    body.appendChild(grid);
    for (const s of settings) grid.appendChild(this.fieldOf(s));
    // A formula is shown at once at the levels it will be used at.
    for (const s of settings) if (s.kind === "formula") this.askPreview(s, false);
  }

  private fieldOf(s: Setting): HTMLElement {
    const field: Field = s.kind === "formula"
      ? { key: s.key, label: s.label, type: "text", maxLength: FORMULA_MAX, wide: true, hint: s.help }
      : { key: s.key, label: s.label, type: "number", min: s.min, max: s.key === "maxLevel" ? undefined : s.max, step: s.integer ? 1 : 0.01, hint: s.help };
    const wrap = this.fields.renderField({ ...field, path: s.key }, this.draft, () => this.touched(s, wrap), { error: this.fieldErrors[s.key], disabled: !!this.pending });
    wrap.appendChild(this.metaLine(s));
    if (s.kind === "formula") {
      const box = el("div");
      this.previewBoxes[s.key] = box;
      this.previewWraps[s.key] = wrap;
      this.paintPreview(s.key);
      wrap.appendChild(box);
    }
    return wrap;
  }

  /** "Default: X" and the button that puts the default back. */
  private metaLine(s: Setting): HTMLElement {
    const line = el("div", "tl-field-hint tl-inline gs-meta");
    line.appendChild(el("span", "", `Default: ${s.default}`));
    const reset = button("Reset", () => this.reset(s), { small: true, kind: "quiet", icon: "undo", tip: s.overridden ? "Put the default back" : "It already holds the default" });
    reset.disabled = !s.overridden || !!this.pending;
    line.appendChild(reset);
    if (s.overridden && s.updatedBy) line.appendChild(el("span", "tl-muted", `Set by ${s.updatedBy}`));
    // A row is saved but the server does not use it: say why (text only, never markup).
    const note = metaNote(s);
    if (note) line.appendChild(el("span", "tl-muted", note));
    return line;
  }

  /**
   * Puts the values the server holds into the open form without rebuilding it. `keys` have no unsaved edits, so each
   * takes the server's value, the focused one too (focus and caret stay). `edited` keep their typed text but get a new
   * meta line and preview. False when it cannot.
   */
  private patchForm(keys: string[], edited: string[] = []): boolean {
    const wrapOf = (key: string) => document.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`);
    const wraps = [...keys, ...edited].map(wrapOf);
    if (wraps.some((w) => !w)) return false;
    for (const key of keys) {
      const s = this.find(key);
      const wrap = wrapOf(key);
      if (!s || !wrap) continue;
      this.draft[key] = s.value;
      const input = wrap.querySelector<HTMLInputElement>("input");
      if (input) {
        const focused = input === document.activeElement;
        let start: number | null = null;
        let end: number | null = null;
        try { start = input.selectionStart; end = input.selectionEnd; } catch { /* a number input has no selection */ }
        const next = patchedInput(String(s.value), { value: input.value, start, end, focused });
        if (input.value !== next.value) input.value = next.value;
        if (focused && next.start !== null && next.end !== null) {
          try { input.setSelectionRange(next.start, next.end); } catch { /* a number input has no selection */ }
        }
      }
      wrap.querySelector(".gs-meta")?.replaceWith(this.metaLine(s));
      if (s.kind === "formula") this.askPreview(s, false);
    }
    for (const key of edited) {
      const s = this.find(key);
      const wrap = wrapOf(key);
      if (!s || !wrap) continue;
      wrap.querySelector(".gs-meta")?.replaceWith(this.metaLine(s));
      if (s.kind === "formula") this.askPreview(s, true);
    }
    this.chrome();
    return true;
  }

  private touched(s: Setting, wrap: HTMLElement): void {
    this.refused = false;
    if (this.fieldErrors[s.key]) {
      delete this.fieldErrors[s.key];
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.renderList();
    if (s.kind === "formula") {
      // The table follows the typing, a moment after the last key.
      clearTimeout(this.previewTimers[s.key]);
      this.previewTimers[s.key] = setTimeout(() => this.askPreview(s, true), PREVIEW_WAIT_MS);
    }
  }

  // ----------------------------------------------------------------- preview

  private askPreview(s: Setting, force: boolean): void {
    const text = String(this.draft[s.key] ?? "").trim();
    if (!text || text.length > FORMULA_MAX) {
      delete this.previews[s.key];
      this.paintPreview(s.key);
      return;
    }
    if (!force && this.previews[s.key] && this.previewAsked[s.key] === text) return;
    if (this.tracker.asking(s.key, text)) return;
    this.previewAsked[s.key] = text;
    const send = this.tracker.want(s.key, text);
    if (send !== null) this.sendPreview(s.key, send);
  }

  private sendPreview(key: string, value: string): void {
    this.shell.send({ type: "request", packet: PREVIEW, data: { key, value } });
  }

  private onPreview(msg: any): void {
    const key = typeof msg.name === "string" ? msg.name : "";
    if (!key) return;
    // Only the answer to the latest text counts: an older one is dropped and the latest is asked for.
    const { apply, next } = this.tracker.answer(key, String(msg.data?.value ?? ""));
    if (next !== null) this.sendPreview(key, next);
    if (!apply) return;
    const data = msg.data;
    const rows = Array.isArray(data?.rows) ? (data.rows as Array<[number, number]>) : [];
    const error = msg.ok === false ? String(data?.error ?? msg.errors?.[0] ?? "The server could not check it.") : undefined;
    this.previews[key] = { ok: msg.ok !== false, error, rows };
    this.paintPreview(key);
  }

  private paintPreview(key: string): void {
    const box = this.previewBoxes[key];
    if (!box) return;
    const wrap = this.previewWraps[key];
    const result = this.previews[key];
    // A problem found here shows under the field; one the server found on save stays until the text is changed.
    if (result && !result.ok && result.error) setFieldError(wrap, result.error);
    else if (wrap && !this.fieldErrors[key]) setFieldError(wrap, null);
    box.replaceChildren();
    if (!result || !result.ok || result.rows.length === 0) return;
    const scroll = el("div", "tl-table-scroll");
    scroll.style.maxHeight = "220px";
    const table = el("table", "tl-table tl-table-plain");
    const head = el("tr");
    head.append(el("th", "", "Level"), el("th", "", "Value"));
    const thead = el("thead");
    thead.appendChild(head);
    const tbody = el("tbody");
    for (const [level, value] of result.rows) {
      const row = el("tr");
      row.append(el("td", "", String(level)), el("td", "", value.toLocaleString()));
      tbody.appendChild(row);
    }
    table.append(thead, tbody);
    scroll.appendChild(table);
    box.appendChild(scroll);
  }

  // ----------------------------------------------------------------- opening

  private select(name: string): void {
    if (name === this.section) return;
    this.section = name;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  // ----------------------------------------------------------------- actions

  /** The changed settings of the open section, one SAVE each, in order, until the server refuses one. */
  private save(): void {
    if (this.section === null || this.pending) return;
    const todo = this.changedIn(this.section);
    if (todo.length === 0) return;
    this.fieldErrors = this.validate(todo);
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    this.refused = false;
    this.clearProblems();
    this.queue = todo.map((s) => s.key);
    this.saved = [];
    this.sendNext();
  }

  private sendNext(): void {
    const key = this.queue.shift();
    if (!key) return;
    const value = this.draft[key];
    const s = this.find(key);
    this.beginRequest("save", SAVE, key, { key, value: s?.kind === "formula" ? String(value ?? "").trim() : Number(value) });
  }

  private reset(s: Setting): void {
    if (this.pending || !s.overridden) return;
    this.queue = [];
    this.saved = [];
    this.beginRequest("reset", RESET, s.key, { key: s.key });
  }

  private onWriteResult(kind: "save" | "reset", key: string, msg: any): void {
    const s = (): Setting | undefined => this.find(key);
    if (!msg.ok) {
      this.queue = [];
      this.adopt(msg.data);
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? { ...msg.fields } : {};
      const lines: string[] = Array.isArray(msg.errors) && msg.errors.length ? msg.errors : ["The server refused the save."];
      // What the server said about a field shows under that field; the rest at the top.
      const spoken = new Set(Object.values(this.fieldErrors));
      const rest = lines.filter((l) => !spoken.has(l));
      if (this.saved.length) rest.push(`Saved before that: ${this.saved.join(", ")}.`);
      this.showProblems(rest);
      return;
    }
    this.adopt(msg.data);
    // The field now shows what the server holds, whatever was typed in it.
    const now = s();
    if (now) this.draft[key] = now.value;
    delete this.previews[key];
    if (kind === "reset") {
      this.refused = false;
      this.clearProblems();
      toast(`${now?.label ?? "The setting"} is back to its default.`);
      this.renderForm();
      return;
    }
    this.saved.push(now?.label ?? key);
    if (this.queue.length > 0) {
      this.sendNext();
      return;
    }
    this.refused = false;
    this.clearProblems();
    toast(this.saved.length === 1 ? `Saved ${this.saved[0]}.` : `Saved ${count(this.saved.length, "setting")}.`);
    this.saved = [];
    this.renderForm();
  }

  private beginRequest(kind: "save" | "reset", packet: string, key: string, data: any): void {
    this.pending = { kind, packet, key };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright: don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.key !== key || this.pending?.packet !== packet) return;
      this.endRequest();
      this.queue = [];
      this.refused = true;
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

new GameSettingsBridge();
