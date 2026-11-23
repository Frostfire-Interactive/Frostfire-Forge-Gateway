import { EditorShell } from "./tooleditor.js";
import { toast } from "./toolkit.js";
import { TOOL_KINDS, type ToolHost, type ToolPart } from "./dungeontoolparts.js";
import { DungeonPart } from "./dungeoneditorbridge.js";
import { PortalPart } from "./portaleditorbridge.js";
import { StonePart } from "./stoneeditorbridge.js";

// The Dungeon Tool's window (/dungeon-editor): one shell with the tabs Dungeons, Portals and Summoning stones. Each tab is
// a part (dungeoneditorbridge.ts, portaleditorbridge.ts, stoneeditorbridge.ts) that keeps its own records and draws on the
// shell while it is in view. The game window (dungeontool.ts) sends each part's answers tagged with its tab.

class DungeonToolBridge implements ToolHost {
  kind: string = TOOL_KINDS[0]!.id;
  /** Left with "Save" on the way to another tab: that tab, once the save is confirmed. */
  private afterSave: string | null = null;

  private shell = new EditorShell({
    tool: "Dungeon Tool",
    kinds: TOOL_KINDS,
    onKind: (id) => void this.requestKind(id),
    // a tab that waits or was refused can be left for another
    kindsStayOpen: true,
    liveSearch: true,
    onSearch: (query) => this.part.search(query),
    onNew: () => this.part.create(),
    onSave: () => this.part.save(),
    onDuplicate: () => this.part.duplicate?.(),
    onDelete: () => this.part.remove(),
  });

  private parts: Record<string, ToolPart> = {
    dungeons: new DungeonPart(this.shell, this),
    portals: new PortalPart(this.shell, this),
    stones: new StonePart(this.shell, this),
  };

  constructor() {
    this.shell.setKind(this.kind);
    this.shell.waiting(() => this.part.ask());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private get part(): ToolPart {
    return this.parts[this.kind]!;
  }

  private onMessage(msg: any): void {
    const part = typeof msg.tool === "string" ? this.parts[msg.tool] : undefined;
    if (!part || (msg.type !== "data" && msg.type !== "result" && msg.type !== "updated")) return;
    part.onMessage({ kind: msg.type, data: msg.data });
  }

  // ------------------------------------------------------------------ host

  counted(): void {
    this.shell.setCounts(Object.fromEntries(Object.entries(this.parts).map(([id, part]) => [id, part.count()])));
  }

  settled(kind: string, ok: boolean): void {
    const next = this.afterSave;
    this.afterSave = null;
    if (ok && next && kind === this.kind) this.switchKind(next);
  }

  // ------------------------------------------------------------------ tabs

  private async requestKind(id: string): Promise<void> {
    if (id === this.kind || !this.parts[id]) return;
    const part = this.part;
    const name = part.unsaved();
    if (name === null) return this.switchKind(id);
    if (part.busy()) return void toast("Still saving. Try again in a moment.", "warning");
    const choice = await this.shell.leave(name);
    // What was open may have been saved or closed while the question was up.
    if (choice === "stay" || this.part !== part) return;
    if (choice === "discard" || part.unsaved() === null) {
      if (choice === "discard") part.discard();
      return this.switchKind(id);
    }
    if (part.busy()) return void toast("Still saving. Try again in a moment.", "warning");
    // Leave only once the server confirms; a failed save stays put.
    this.afterSave = id;
    part.save();
    // Nothing was sent (the form has problems): stay, with them shown.
    if (!part.busy()) this.afterSave = null;
  }

  private switchKind(id: string): void {
    this.kind = id;
    this.shell.setKind(id);
    this.shell.clearQuery();
    this.shell.setProblems([]);
    this.counted();
    this.part.activate();
  }
}

new DungeonToolBridge();
