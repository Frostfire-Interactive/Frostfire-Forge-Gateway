// Game-window half of the gathering editor (/gathering): owns the popup window and relays its messages to the server,
// as mailboxeditor.ts does, and draws the popup's density preview in the world (gathering.ts). USER REQUEST
// 2026-10-17: "Able to configure spawn rate and preview how dense it will look".
//
// The popup asks for a preview of the area as typed; the server answers where nodes would stand
// (GATHERING_EDITOR_PREVIEW_SPOTS), and they are drawn half transparent with the area's circle until the popup
// clears it, saves, or closes.
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { setGatherPreview } from "./gathering.js";

const cache = Cache.getInstance();

const EDITOR_WIDTH = 980;
const EDITOR_HEIGHT = 760;

const here = () => String((window as any).mapData?.name ?? "").replace(".json", "");

class GatheringEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;
  private lastMap = "";
  /** The area a preview was asked for: drawn with the spots once they come. */
  private previewArea: { x: number; y: number; radius: number; size: number; icon: string | null } | null = null;

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
    const url = window.location.origin + "/gathering-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, area.availWidth - width - 24);
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
    this.editorWindow = window.open(url, "GatheringEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    this.lastMap = here();
    sendRequest({ type: "GATHERING_EDITOR_LIST", data: {} });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
      // another map: its areas are listed instead
      else if (here() !== this.lastMap) {
        this.lastMap = here();
        this.clearPreview();
        this.toEditor({ type: "mapChanged" });
      }
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
    this.clearPreview();
  }

  private toEditor(msg: any): void {
    if (!this.editorWindow || this.editorWindow.closed) return;
    if (!this.bridgeReady) {
      this.queue.push(msg);
      return;
    }
    this.editorWindow.postMessage(msg, "*");
  }

  private clearPreview(): void {
    this.previewArea = null;
    setGatherPreview(null);
  }

  // -------------------------------------------------------- server messages

  onData(data: any): void {
    this.lastData = data;
    this.toEditor({ type: "data", data });
  }

  onPreview(data: any): void {
    const area = this.previewArea;
    if (!area || !Array.isArray(data?.spots)) return;
    setGatherPreview({ map: here(), ...area, spots: data.spots });
    this.toEditor({ type: "preview", count: data.spots.length, wanted: Number(data.wanted) || 0, note: data.note ?? null });
  }

  onResult(data: any): void {
    if (data?.data) this.lastData = data.data;
    // a refused preview is answered as a result
    if (data?.action === "GATHERING_EDITOR_PREVIEW" || (data?.ok && data?.action === "GATHERING_EDITOR_SAVE")) this.clearPreview();
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
        // Only gathering editor packets leave from here; the server re-checks permission on every one.
        if (typeof msg.packet === "string" && msg.packet.startsWith("GATHERING_EDITOR_")) {
          if (msg.packet === "GATHERING_EDITOR_PREVIEW") {
            const d = msg.data ?? {};
            this.previewArea = { x: Number(d.x), y: Number(d.y), radius: Number(d.radius), size: Number(d.size) || 32, icon: typeof msg.icon === "string" ? msg.icon : null };
          }
          sendRequest({ type: msg.packet, data: msg.data && typeof msg.data === "object" ? msg.data : {} });
        }
        break;
      case "clearPreview":
        this.clearPreview();
        break;
      case "whereAmI": {
        const me: any = Array.from(cache.players as Iterable<any>).find((p: any) => p.id === cachedPlayerId);
        const x = Number(me?.position?.x ?? me?.renderPosition?.x);
        const y = Number(me?.position?.y ?? me?.renderPosition?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) this.toEditor({ type: "standing", map: here(), x: Math.round(x), y: Math.round(y) });
        break;
      }
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const gatheringEditor = new GatheringEditor();
export default gatheringEditor;
