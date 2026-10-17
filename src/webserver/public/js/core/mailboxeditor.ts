// Game-window half of the mailbox editor (/mailbox): owns the popup window and relays its messages to the
// server, as classeditor.ts does, and holds the editor's tools in the world, as npceditor.ts does. USER REQUEST
// 2026-10-17: "Rebuild the mailbox editor on the standard editor pattern, like the NPC editor".
//
// The popup says which map it has open and its mailboxes as they are being edited ("preview"): while that is
// the map the admin is on, they are drawn where the popup has them, each in a frame, and a mailbox is dragged
// with the mouse to move it (the popup is told where it is, "moved"; nothing is saved until Save). A click or a
// tap on a mailbox picks it in the popup ("pick"). The mailboxes as the server holds them (MAILBOXES) are drawn
// again when the popup shows another map, or closes.
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { mailboxAt, setMailboxes } from "./mail.js";
import { eventToWorld } from "./worldzoom.js";
import { PLAYER_FEET } from "./depthorder.js";
import { recentVisits } from "./visitedmaps.js";

const cache = Cache.getInstance();

/** Mailboxes are placed and dragged in the game window, so the editor opens against the right edge of the screen, as the NPC editor does. */
const EDITOR_WIDTH = 1040;
const EDITOR_HEIGHT = 760;
/** How far beside the admin (px) a mailbox is put by "Bring to me" and "Add mailbox", so it does not stand on them. */
const BESIDE = 40;
/** How far (px) the mouse moves before a press on a mailbox is a drag and not a click. */
const DRAG_START = 4;

interface Spot { x: number; y: number }
interface Preview { map: string; mailboxes: Spot[]; picked: number | null }

const mapName = (map: unknown) => String(map ?? "").replace(".json", "").toLowerCase();
const here = () => String((window as any).mapData?.name ?? "");
const withIds = (map: string, spots: Spot[]) => spots.map(({ x, y }) => ({ id: `${map}:${x}:${y}`, x, y }));

class MailboxEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;

  /** What the popup has open, when it is a map. */
  private preview: Preview | null = null;
  /** The mailboxes of the map the admin is on, as the server last sent them (MAILBOXES). */
  private held: { map: string; mailboxes: Array<{ id: string; x: number; y: number }> } | null = null;
  private dragging: { index: number; box: { x: number; y: number }; dx: number; dy: number; startX: number; startY: number; started: boolean } | null = null;
  /** The click that ends a press on a mailbox is the editor's, not the world's. */
  private swallowClick = false;

  private boundMouseDown = (e: MouseEvent) => this.onMouseDown(e);
  private boundMouseMove = (e: MouseEvent) => this.onMouseMove(e);
  private boundMouseUp = (e: MouseEvent) => this.onMouseUp(e);
  private boundClick = (e: MouseEvent) => this.onClick(e);

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    // The game page is going away (refresh, close, navigation): take the
    // popup with it, since the reloaded page has no link back to it.
    window.addEventListener("pagehide", () => {
      try {
        if (this.editorWindow && !this.editorWindow.closed) this.editorWindow.close();
      } catch {
        // Window already gone.
      }
    });
    (window as any).mailboxEditorMark = (box: unknown) => this.markOf(box);
    (window as any).mailboxEditorTap = (worldX: number, worldY: number, slop: number) => this.tap(worldX, worldY, slop);
    (window as any).mailboxEditorRefresh = (data: any) => this.onMailboxes(data);
  }

  toggle(): void {
    if (this.isActive) this.close();
    else this.open();
  }

  private open(): void {
    this.isActive = true;
    const url = window.location.origin + "/mailbox-editor";
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, area.availWidth - width - 24);
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
    this.editorWindow = window.open(url, "MailboxEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    // the mailboxes as the server holds them, drawn again once the popup has another map open: copies, a drag moves what is drawn
    if (!this.held || mapName(this.held.map) !== mapName(here())) this.held = { map: here(), mailboxes: this.drawnBoxes().map((box) => ({ ...box })) };
    sendRequest({ type: "MAILBOX_EDITOR_LIST", data: { recent: recentVisits() } });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
    }, 500);
    document.addEventListener("mousedown", this.boundMouseDown, true);
    document.addEventListener("mousemove", this.boundMouseMove, true);
    document.addEventListener("mouseup", this.boundMouseUp, true);
    document.addEventListener("click", this.boundClick, true);
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
    document.removeEventListener("mousedown", this.boundMouseDown, true);
    document.removeEventListener("mousemove", this.boundMouseMove, true);
    document.removeEventListener("mouseup", this.boundMouseUp, true);
    document.removeEventListener("click", this.boundClick, true);
    this.stopDrag();
    this.showPreview(null);
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
    // Every answer to a change carries the maps as they then stand.
    if (data?.data) this.lastData = data.data;
    this.toEditor({ type: "result", ...data });
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  /** The mailboxes of the map the admin is on were sent (MAILBOXES): another map, or a change. */
  private onMailboxes(data: any): void {
    if (!data || !Array.isArray(data.mailboxes)) return;
    const moved = this.held !== null && mapName(this.held.map) !== mapName(data.map);
    this.held = { map: String(data.map), mailboxes: data.mailboxes };
    if (!this.isActive) return;
    // what the popup has open stays drawn as it has it
    this.showPreview(this.preview);
    // on another map, the popup asks for its list again, as it has it searched: the one the admin is on comes first
    if (moved) this.toEditor({ type: "mapChanged" });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    // Every editor's popup posts to this same window. Only this editor's own
    // popup is listened to, or each request of another editor would be sent
    // to the server a second time from here.
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        // What was sent before the popup could listen: the newest list stands for all of it, the rest follows.
        if (this.lastData) this.editorWindow?.postMessage({ type: "data", data: this.lastData }, "*");
        for (const queued of this.queue.splice(0)) {
          if (queued.type !== "data") this.editorWindow?.postMessage(queued, "*");
        }
        break;
      case "request":
        // Only mailbox editor packets leave from here; the server re-checks
        // permission on every one of them.
        if (typeof msg.packet === "string" && msg.packet.startsWith("MAILBOX_EDITOR_")) {
          // with the maps visited last, which the list shows while nothing is searched
          sendRequest({ type: msg.packet, data: { ...(msg.data && typeof msg.data === "object" ? msg.data : {}), recent: recentVisits() } });
        }
        break;
      case "preview":
        this.showPreview(msg.map ? { map: String(msg.map), mailboxes: Array.isArray(msg.mailboxes) ? msg.mailboxes : [], picked: Number.isInteger(msg.picked) ? msg.picked : null } : null);
        break;
      case "whereAmI": {
        // where "Bring to me" and "Add mailbox" put a mailbox: beside the admin, at their feet
        const spot = this.besideMe();
        if (spot) this.toEditor({ type: "standing", map: here(), ...spot, purpose: msg.purpose, index: msg.index });
        break;
      }
      case "editorClosed":
        this.close();
        break;
    }
  }

  // --------------------------------------------------------------- the world

  /** Draws the mailboxes of the map the admin is on: as the popup has them while it has that map open, else as the server holds them. */
  private showPreview(preview: Preview | null): void {
    this.preview = preview;
    const map = here();
    if (preview && mapName(preview.map) === mapName(map)) {
      // a drag in progress moves the picture itself: it is not put back under the mouse
      if (!this.dragging) setMailboxes({ map, mailboxes: withIds(map, preview.mailboxes) });
    } else if (this.held && mapName(this.held.map) === mapName(map)) {
      setMailboxes({ map, mailboxes: this.held.mailboxes });
    }
  }

  /** The popup has the map the admin is on open: its mailboxes can be dragged. */
  private editingHere(): boolean {
    return !!this.preview && mapName(this.preview.map) === mapName(here());
  }

  private drawnBoxes(): Array<{ id: string; x: number; y: number }> {
    return (window as any).mailboxesHere?.(here()) ?? [];
  }

  private drawn(): Array<{ x: number; y: number }> {
    return this.drawnBoxes();
  }

  /** Over the world, not over a window of the game. */
  private overWorld(e: MouseEvent): boolean {
    return !(e.target as HTMLElement | null)?.closest?.(".ui");
  }

  private besideMe(): Spot | null {
    const me: any = Array.from(cache.players as Iterable<any>).find((p: any) => p.id === cachedPlayerId);
    const x = Number(me?.position?.x ?? me?.renderPosition?.x);
    const y = Number(me?.position?.y ?? me?.renderPosition?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x + BESIDE), y: Math.round(y + PLAYER_FEET) } : null;
  }

  /** How a mailbox is drawn while the editor is open: in a frame, the picked one in gold. */
  private markOf(box: unknown): "on" | "picked" | null {
    if (!this.isActive) return null;
    const index = this.drawn().indexOf(box as any);
    return this.editingHere() && index === this.preview?.picked ? "picked" : "on";
  }

  /** A tap on a mailbox while the editor is open picks it in the popup (events.ts asks first): true when it did. */
  private tap(worldX: number, worldY: number, slop: number): boolean {
    if (!this.isActive) return false;
    const box = mailboxAt(worldX, worldY, slop);
    if (!box) return false;
    this.toEditor({ type: "pick", map: here(), index: this.drawn().indexOf(box) });
    return true;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !this.overWorld(e)) return;
    const at = eventToWorld(e);
    const box = mailboxAt(at.x, at.y);
    if (!box) return;
    // the world under it is not clicked: no target, no mail window
    e.preventDefault();
    e.stopPropagation();
    this.swallowClick = true;
    const index = this.drawn().indexOf(box);
    this.toEditor({ type: "pick", map: here(), index });
    // dragged only while the popup has this map open; the first press opens it there
    if (!this.editingHere()) return;
    this.dragging = { index, box, dx: at.x - box.x, dy: at.y - box.y, startX: at.x, startY: at.y, started: false };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging) {
      if (this.isActive && this.overWorld(e)) {
        const at = eventToWorld(e);
        document.body.style.cursor = mailboxAt(at.x, at.y) ? "grab" : "";
      }
      return;
    }
    const at = eventToWorld(e);
    const drag = this.dragging;
    if (!drag.started && Math.hypot(at.x - drag.startX, at.y - drag.startY) <= DRAG_START) return;
    drag.started = true;
    document.body.style.cursor = "grabbing";
    drag.box.x = Math.round(at.x - drag.dx);
    drag.box.y = Math.round(at.y - drag.dy);
    this.toEditor({ type: "moved", map: here(), index: drag.index, x: drag.box.x, y: drag.box.y, final: false });
  }

  private onMouseUp(_e: MouseEvent): void {
    const drag = this.dragging;
    if (!drag) return;
    this.stopDrag();
    if (drag.started) this.toEditor({ type: "moved", map: here(), index: drag.index, x: drag.box.x, y: drag.box.y, final: true });
  }

  private onClick(e: MouseEvent): void {
    if (!this.swallowClick) return;
    this.swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  private stopDrag(): void {
    this.dragging = null;
    document.body.style.cursor = "";
  }
}

const mailboxEditor = new MailboxEditor();
export default mailboxEditor;
