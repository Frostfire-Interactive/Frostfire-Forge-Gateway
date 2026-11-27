import { sendRequest } from "./socket.js";

const EDITOR_WIDTH = 1040;
const EDITOR_HEIGHT = 720;

class GameSettingsEditor {
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
    const url = window.location.origin + "/game-settings";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    // Centred, as the item editor is, and a few steps down and right of it, so one does not open exactly over the other.
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2) + 48);
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2) + 48);
    this.editorWindow = window.open(url, "GameSettingsEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    sendRequest({ type: "GAME_SETTINGS_EDITOR_LIST", data: {} });
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

  onData(data: any): void {
    this.lastData = data;
    this.toEditor({ type: "data", data });
  }

  onResult(data: any): void {
    // A preview answer holds a table, not the settings: only an answer that holds the settings is kept for a window that opens late.
    if (data?.action !== "GAME_SETTINGS_EDITOR_PREVIEW" && Array.isArray(data?.data?.settings)) this.lastData = data.data;
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
        // Only game settings editor packets leave from here; the server checks permission again on every one.
        if (typeof msg.packet === "string" && msg.packet.startsWith("GAME_SETTINGS_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data && typeof msg.data === "object" ? msg.data : {} });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const gameSettingsEditor = new GameSettingsEditor();
export default gameSettingsEditor;
