import { sendRequest } from "./socket.js";
import { packetKind, type ToolKind } from "./dungeontoolparts.js";

// The Dungeon Tool (/de, /dungeoneditor, /poe, /portaleditor): one window with the tabs Dungeons, Portals and Summoning
// stones. This is its game side: it opens the window, passes each part's requests to the server and its answers back.

// The class editor's size: narrower than 1240 and the summary beside the form drops under it.
const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;
/** The list each part asks for when the window opens. */
const LISTS: Record<ToolKind, string> = { dungeons: "DUNGEON_EDITOR_LIST", portals: "PORTAL_EDITOR_LIST", stones: "SUMMON_STONE_EDITOR_LIST" };

class DungeonTool {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: Partial<Record<ToolKind, any>> = {};

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    window.addEventListener("pagehide", () => {
      try {
        if (this.editorWindow && !this.editorWindow.closed) this.editorWindow.close();
      } catch {
        // Window already gone.
      }
    });
  }

  toggle(): void {
    if (this.isActive) this.close();
    else this.open();
  }

  private open(): void {
    this.isActive = true;
    const url = window.location.origin + "/dungeon-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2)) + 60;
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2)) + 60;
    this.editorWindow = window.open(url, "DungeonTool", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = {};
    // every tab's list, so each shows how many it has from the start
    for (const packet of Object.values(LISTS)) sendRequest({ type: packet, data: null });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
    }, 500);
  }

  close(): void {
    this.isActive = false;
    if (this.closeWatcher) {
      clearInterval(this.closeWatcher);
      this.closeWatcher = null;
    }
    try {
      this.editorWindow?.close();
    } catch {
      // Window already gone.
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.queue = [];
  }

  private toEditor(msg: any): void {
    if (!this.editorWindow || this.editorWindow.closed) return;
    if (!this.bridgeReady) {
      this.queue.push(msg);
      return;
    }
    this.editorWindow.postMessage(msg, "*");
  }

  // -------------------------------------------------------- server messages

  onData(kind: ToolKind, data: any): void {
    this.lastData[kind] = data;
    this.toEditor({ type: "data", tool: kind, data });
  }

  onResult(kind: ToolKind, data: any): void {
    // Every answer to a change carries the part's list as it then stands.
    if (data?.data) this.lastData[kind] = data.data;
    this.toEditor({ type: "result", tool: kind, data });
  }

  /** A dungeon was changed in another editor. */
  onUpdated(data: any): void {
    this.toEditor({ type: "updated", tool: "dungeons", data: { by: data?.by ?? "someone" } });
  }

  /** The player is on another map, or its portals or summoning stones changed: the lists of the map are asked for again. */
  onMapChanged(): void {
    if (!this.isActive) return;
    sendRequest({ type: LISTS.portals, data: null });
    sendRequest({ type: LISTS.stones, data: null });
  }

  /** A dungeon portal was saved or deleted, here or in another editor: the Dungeons tab's portals to pick from are asked for again. */
  onPortalsChanged(): void {
    if (!this.isActive) return;
    sendRequest({ type: LISTS.dungeons, data: null });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        // What was sent before the popup could listen: each part's newest list stands for all of it, the rest follows.
        for (const [kind, data] of Object.entries(this.lastData)) this.editorWindow?.postMessage({ type: "data", tool: kind, data }, "*");
        for (const queued of this.queue.splice(0)) {
          if (queued.type !== "data") this.editorWindow?.postMessage(queued, "*");
        }
        break;
      case "request":
        if (packetKind(msg.packet) !== null) sendRequest({ type: msg.packet, data: msg.data });
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const dungeonTool = new DungeonTool();
export default dungeonTool;
