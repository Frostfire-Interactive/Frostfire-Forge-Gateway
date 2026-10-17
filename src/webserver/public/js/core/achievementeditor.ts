// Game-window half of the achievement editor (/achievements): owns the popup window and relays its messages to the
// server, as gatheringeditor.ts does. The popup is achievementeditorbridge.ts.
import { sendRequest } from "./socket.js";
import { config } from "../web/global.js";

const EDITOR_WIDTH = 1040;

/**
 * The game server sends the icon list's pictures as asset paths ("/icon?name=..."), not URLs: it reaches the asset
 * server on an internal address the browser cannot resolve. Prefix them with the asset server this client was
 * configured with, as the item editor does (itemeditor.ts). Only the pick lists' `image` fields are touched, never
 * what an admin typed.
 */
function withIconUrls(data: any): any {
  const options = data?.options;
  if (!options || typeof options !== "object") return data;
  const fixed: Record<string, unknown> = {};
  for (const [list, entries] of Object.entries(options)) {
    fixed[list] = Array.isArray(entries)
      ? entries.map((o: any) => (typeof o?.image === "string" && o.image.startsWith("/") ? { ...o, image: `${config.ASSET_SERVER_URL}${o.image}` } : o))
      : entries;
  }
  return { ...data, options: fixed };
}
const EDITOR_HEIGHT = 780;

class AchievementEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;

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
    const url = window.location.origin + "/achievement-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, area.availWidth - width - 24);
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
    this.editorWindow = window.open(url, "AchievementEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    sendRequest({ type: "ACHIEVEMENT_EDITOR_LIST", data: {} });
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

  onData(raw: any): void {
    const data = withIconUrls(raw);
    this.lastData = data;
    this.toEditor({ type: "data", data });
  }

  onResult(raw: any): void {
    const data = raw?.data ? { ...raw, data: withIconUrls(raw.data) } : raw;
    if (data?.data) this.lastData = data.data;
    this.toEditor({ type: "result", ...data });
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    // Only this editor's own popup is listened to (every editor's popup posts to this window).
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        if (this.lastData) this.editorWindow?.postMessage({ type: "data", data: this.lastData }, "*");
        for (const queued of this.queue.splice(0)) {
          if (queued.type !== "data") this.editorWindow?.postMessage(queued, "*");
        }
        break;
      case "request":
        // Only achievement editor packets leave from here; the server checks permission again on every one.
        if (typeof msg.packet === "string" && msg.packet.startsWith("ACHIEVEMENT_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data && typeof msg.data === "object" ? msg.data : {} });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const achievementEditor = new AchievementEditor();
export default achievementEditor;
