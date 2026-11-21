import { sendRequest } from "./socket.js";
import { config } from "../web/global.js";

function withAssetUrls<T>(value: T): T {
  if (typeof value === "string") {
    return (value.startsWith("/") ? `${config.ASSET_SERVER_URL}${value}` : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(withAssetUrls) as unknown as T;
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, entry] of Object.entries(value)) out[key] = withAssetUrls(entry);
    return out;
  }
  return value;
}

const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;

class SpellEditor {
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
    const url = window.location.origin + "/spell-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2)) + 20;
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2)) + 20;
    this.editorWindow = window.open(url, "SpellEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    sendRequest({ type: "SPELL_EDITOR_LIST", data: null });
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
    this.lastData = { ...data, icons: withAssetUrls(data?.icons ?? []), assetServerUrl: config.ASSET_SERVER_URL };
    this.toEditor({ type: "data", data: this.lastData });
  }

  onResults(data: any): void {
    // Spells carry icon names, not paths: nothing to prefix.
    this.toEditor({ type: "results", data });
  }

  onResult(data: any): void {
    this.toEditor({ type: "result", ...data });
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.editorWindow?.postMessage(queued, "*");
        if (this.lastData) this.toEditor({ type: "data", data: this.lastData });
        break;
      case "request":
        if (typeof msg.packet === "string" && msg.packet.startsWith("SPELL_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const spellEditor = new SpellEditor();
export default spellEditor;
