import type { EditorShell } from "./tooleditor.js";
import type { ToolHost } from "./dungeontoolparts.js";

// What the three tabs of the Dungeon Tool (dungeontoolbridge.ts) share: asking for the list, a refused or unanswered tab,
// a save or delete sent and waited for, and the problems shown over the form. Each tab keeps its own records, form and
// words for what it saved. No DOM here, so the tests can drive it on a shell of their own.

/** The parts of the shell this needs. */
export type PartShell = Pick<EditorShell, "send" | "waiting" | "refused" | "arrived" | "setProblems" | "setBanner" | "setRecord" | "setState" | "setActions">;
/** A toast: toolkit's, passed in. */
export type Say = (text: string, tone?: "error" | "warning") => void;

/** How long a save or delete waits for the server before it is taken as unanswered. */
export const REQUEST_WAIT_MS = 15000;

export abstract class ToolPartBase<S extends PartShell = PartShell> {
  abstract readonly kind: string;
  /** The packet that asks for the tab's list. */
  protected abstract readonly listPacket: string;
  /** What is open, or null. */
  protected abstract draft: object | null;
  protected requestWaitMs = REQUEST_WAIT_MS;

  /** The list has come at least once. */
  protected ready = false;
  /** Why the server would not list this tab's records for this admin, shown while the tab is in view. */
  protected refusal: string[] | null = null;
  /** The save or delete waiting for the server. */
  protected pending: { kind: "save" | "delete"; packet: string; name: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last save of what is open was refused, or not answered. */
  protected refused = false;
  protected fieldErrors: Record<string, string> = {};
  protected otherProblems: string[] = [];
  /** Counts the records opened, so each keeps its own scroll. */
  protected opened = 0;

  constructor(protected shell: S, protected host: ToolHost, protected say: Say) {}

  /** Its tab is the one in view: only then does it draw on the window. */
  protected get active(): boolean {
    return this.host.kind === this.kind;
  }

  /** Takes in the server's data (`follow`: what is open follows it). */
  protected abstract adopt(data: any, follow?: boolean): void;
  protected abstract onSaveResult(msg: any): void;
  protected abstract onDeleteResult(msg: any, name: string): void;
  protected abstract renderList(): void;
  protected abstract renderForm(): void;
  /** The banner, record header and buttons, for what is open. */
  protected abstract chrome(): void;

  // ---------------------------------------------------------------- the tab

  /** Its tab is now in view. Until its list is there it shows nothing of the tab before it. */
  activate(): void {
    if (this.refusal || !this.ready) this.blankChrome();
    if (this.refusal) return this.shell.refused(this.refusal, () => this.retry());
    if (!this.ready) {
      this.shell.waiting(() => this.askForList());
      return this.askForList();
    }
    this.shell.arrived();
    this.renderList();
    this.renderForm();
  }

  busy(): boolean {
    return !!this.pending;
  }

  ask(): void {
    this.askForList();
  }

  protected askForList(): void {
    this.shell.send({ type: "request", packet: this.listPacket, data: null });
  }

  private retry(): void {
    this.refusal = null;
    this.askForList();
  }

  private blankChrome(): void {
    this.shell.setBanner(null);
    this.shell.setRecord(null);
    this.shell.setState(null);
    this.shell.setActions({ open: false });
  }

  /** The key a page is drawn under: the shell keeps a page's scroll while the key stays the same. */
  protected pageKey(): string {
    return `${this.kind}:${this.opened}`;
  }

  /** The list came: the tab may be searched and added to. */
  protected landed(): void {
    this.ready = true;
    this.refusal = null;
    if (this.active) this.shell.arrived();
    this.host.counted();
  }

  // --------------------------------------------------------------- messages

  onMessage({ kind, data: msg }: { kind: "data" | "result" | "updated"; data: any }): void {
    if (kind === "data") {
      this.adopt(msg);
      this.renderList();
      this.renderForm();
    } else if (kind === "result") {
      if (!msg || typeof msg !== "object") return;
      const mine = !!this.pending && (!msg.action || msg.action === this.pending.packet);
      if (!mine) {
        if (msg.data) this.adopt(msg.data);
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        this.renderList();
        if (this.ready) this.renderForm();
        return;
      }
      const { kind: asked, name } = this.pending!;
      this.endRequest();
      if (asked === "save") this.onSaveResult(msg);
      else this.onDeleteResult(msg, name);
      this.renderList();
    } else if (kind === "updated") this.onUpdated(msg);
  }

  /** Another editor changed this tab's records. */
  protected onUpdated(_msg: any): void {}

  /** A refusal not answering this tab's own request: of the list before it came, or of something else. */
  private report(lines: string[]): void {
    if (!this.ready) {
      this.refusal = lines;
      if (this.active) this.shell.refused(lines, () => this.retry());
    } else if (this.draft) {
      this.otherProblems = lines;
      if (this.active) this.shell.setProblems(this.problemLines());
    } else this.say(lines.join("\n"), "error");
  }

  // --------------------------------------------------------------- requests

  protected beginRequest(kind: "save" | "delete", packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      this.say("The server did not answer in time, so nothing was confirmed.", "error");
      if (kind === "save") this.host.settled(this.kind, false);
      this.askForList();
    }, this.requestWaitMs);
    this.shell.send({ type: "request", packet, data });
    this.chrome();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.chrome();
  }

  // --------------------------------------------------------------- problems

  protected problemLines(): string[] {
    const fields = Object.keys(this.fieldErrors).length;
    if (fields === 0) return this.otherProblems;
    return [`${fields} ${fields === 1 ? "field needs" : "fields need"} fixing.`];
  }

  protected clearProblems(): void {
    this.fieldErrors = {};
    this.otherProblems = [];
    if (this.active) this.shell.setProblems([]);
  }

  protected showProblems(serverErrors: string[] = []): void {
    this.otherProblems = serverErrors;
    if (this.active) this.shell.setProblems(this.problemLines());
    this.renderForm();
  }
}
