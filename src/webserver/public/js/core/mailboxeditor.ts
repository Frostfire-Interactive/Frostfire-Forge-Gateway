// Mailbox editor (/mailbox): where the mailboxes of the map the admin is on stand. A map left alone has
// them in front of its inns; once one is added, moved or removed, the map keeps its own list, and Reset
// gives it back to the inns. The window lists them; with a mouse a mailbox is dragged where it should
// stand, and on any screen one is picked (in the list, or by a click or a tap on it) and moved to where
// the admin stands. Every change sends the whole list (MAILBOX_EDITOR_SAVE); the server answers with the
// list as it then stands (MAILBOX_EDITOR_DATA) and sends everyone on the map where they are (MAILBOXES).
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { mailboxAt, setMailboxes } from "./mail.js";
import { screenToWorld } from "./worldzoom.js";
import { PLAYER_FEET } from "./depthorder.js";

const cache = Cache.getInstance();

interface Mailbox { id: string; x: number; y: number }
interface EditorData { map: string; mailboxes: Mailbox[]; placed: boolean; max: number; message?: string }

/** How far beside the admin (px) a mailbox is put by Add here and Move here, so it does not stand on them. */
const BESIDE = 40;
/** A phone or a tablet: no mouse to drag with. */
const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

let popup: HTMLDivElement | null = null;
let data: EditorData | null = null;
/** The picked mailbox, by id. */
let picked: string | null = null;
/** A mailbox being dragged with the mouse: its id, and how far from its foot it was taken. */
let dragging: { box: Mailbox; dx: number; dy: number; moved: boolean } | null = null;
/** The click that ends a press on a mailbox is the editor's, not the world's. */
let swallowClick = false;
let waiting = false;
let status = "";

const mapName = (map: unknown) => String(map ?? "").replace(".json", "").toLowerCase();

/** The mailboxes as drawn: the list the map was last sent (MAILBOXES), which a drag moves. */
function shown(): Mailbox[] {
  return (window as any).mailboxesHere?.(String((window as any).mapData?.name ?? "")) ?? [];
}

/** Where the admin stands: the anchor of their character, and their feet. */
function standing(): { x: number; y: number } | null {
  const me: any = Array.from(cache.players).find((player: any) => player.id === cachedPlayerId);
  const x = Number(me?.position?.x ?? me?.renderPosition?.x);
  const y = Number(me?.position?.y ?? me?.renderPosition?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Sends the whole list of the map's mailboxes. */
function save(spots: Array<{ x: number; y: number }>) {
  if (!data || waiting) return;
  waiting = true;
  status = "Saving...";
  render();
  sendRequest({ type: "MAILBOX_EDITOR_SAVE", data: { map: data.map, mailboxes: spots.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })) } });
}

const spotsOf = (list: Mailbox[]) => list.map(({ x, y }) => ({ x, y }));

function addHere() {
  const at = standing();
  if (!at || !data) return;
  if (shown().length >= data.max) {
    status = `A map has at most ${data.max} mailboxes.`;
    render();
    return;
  }
  const spot = { x: Math.round(at.x + BESIDE), y: Math.round(at.y + PLAYER_FEET) };
  picked = `${data.map}:${spot.x}:${spot.y}`;
  save([...spotsOf(shown()), spot]);
}

function moveHere() {
  const at = standing();
  if (!at || !data || !picked) return;
  const spot = { x: Math.round(at.x + BESIDE), y: Math.round(at.y + PLAYER_FEET) };
  const list = shown().map((box) => (box.id === picked ? spot : { x: box.x, y: box.y }));
  picked = `${data.map}:${spot.x}:${spot.y}`;
  save(list);
}

function remove() {
  if (!picked) return;
  const list = shown().filter((box) => box.id !== picked);
  picked = null;
  save(spotsOf(list));
}

function reset() {
  if (!data || waiting) return;
  waiting = true;
  picked = null;
  status = "Resetting...";
  render();
  sendRequest({ type: "MAILBOX_EDITOR_RESET", data: { map: data.map } });
}

function button(label: string, kind: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const made = document.createElement("button");
  made.type = "button";
  made.className = `mailbox-editor-button ${kind}`.trim();
  made.innerText = label;
  made.disabled = disabled || waiting;
  made.addEventListener("click", onClick);
  return made;
}

function render() {
  if (!popup) return;
  const list = shown();
  if (picked && !list.some((box) => box.id === picked)) picked = null;

  const where = popup.querySelector(".mailbox-editor-where") as HTMLElement;
  where.innerText = !data
    ? "Loading..."
    : `${data.map}: ${data.placed ? "placed by hand" : "in front of the inns"}`;

  const rows = popup.querySelector(".mailbox-editor-list") as HTMLElement;
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "mailbox-editor-empty";
    empty.innerText = "No mailboxes on this map.";
    rows.replaceChildren(empty);
  } else {
    rows.replaceChildren(...list.map((box, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mailbox-editor-row" + (box.id === picked ? " picked" : "");
      row.setAttribute("aria-pressed", String(box.id === picked));
      const name = document.createElement("span");
      name.innerText = `Mailbox ${index + 1}`;
      const at = document.createElement("span");
      at.className = "mailbox-editor-at";
      at.innerText = `${box.x}, ${box.y}`;
      row.append(name, at);
      row.addEventListener("click", () => {
        picked = box.id === picked ? null : box.id;
        render();
      });
      return row;
    }));
  }

  const actions = popup.querySelector(".mailbox-editor-actions") as HTMLElement;
  actions.replaceChildren(
    button("Add here", "primary", addHere, !data),
    button("Move here", "", moveHere, !picked),
    button("Delete", "danger", remove, !picked),
    button("Reset", "", reset, !data?.placed),
  );
  (popup.querySelector(".mailbox-editor-status") as HTMLElement).innerText = status;
}

function build(): HTMLDivElement {
  const made = document.createElement("div");
  made.id = "mailbox-editor";
  made.className = "ui";
  made.setAttribute("role", "dialog");
  made.setAttribute("aria-label", "Mailboxes");

  const title = document.createElement("h2");
  title.innerText = "Mailboxes";
  const where = document.createElement("p");
  where.className = "mailbox-editor-where";
  const list = document.createElement("div");
  list.className = "mailbox-editor-list";
  const hint = document.createElement("p");
  hint.className = "mailbox-editor-hint";
  hint.innerText = TOUCH
    ? "Tap a mailbox to pick it. Move here puts it beside you."
    : "Drag a mailbox to move it, or pick one and use Move here.";
  const actions = document.createElement("div");
  actions.className = "mailbox-editor-actions";
  const line = document.createElement("p");
  line.className = "mailbox-editor-status";

  const close = document.createElement("button");
  close.id = "mailbox-editor-close";
  close.type = "button";
  close.innerText = "Close";
  close.addEventListener("click", closeEditor);
  const buttons = document.createElement("div");
  buttons.className = "button-container";
  buttons.appendChild(close);

  made.append(title, where, list, hint, actions, line, buttons);
  made.addEventListener("contextmenu", (event) => event.preventDefault());
  return made;
}

function openEditor() {
  if (popup) return;
  popup = build();
  document.body.appendChild(popup);
  data = null;
  picked = null;
  status = "";
  waiting = false;
  render();
  sendRequest({ type: "MAILBOX_EDITOR_LIST", data: null });
}

function closeEditor() {
  popup?.remove();
  popup = null;
  data = null;
  picked = null;
  dragging = null;
  document.body.style.cursor = "";
}

// ------------------------------------------------------------ in the world

const gameCanvas = () => document.getElementById("game") as HTMLCanvasElement | null;

/** World coordinates of a mouse event; null when `onCanvas` and it is not over the world. */
function worldOf(event: MouseEvent, onCanvas = true): { x: number; y: number } | null {
  const canvas = gameCanvas();
  if (!canvas || (onCanvas && event.target !== canvas)) return null;
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
}

// A press on a mailbox picks it and starts a drag; the world under it is not clicked.
document.addEventListener("mousedown", (event) => {
  if (!popup || !data || event.button !== 0) return;
  const at = worldOf(event);
  const box = at ? mailboxAt(at.x, at.y) : null;
  if (!at || !box) return;
  event.preventDefault();
  event.stopPropagation();
  picked = box.id;
  swallowClick = true;
  if (!waiting) dragging = { box, dx: at.x - box.x, dy: at.y - box.y, moved: false };
  document.body.style.cursor = "grabbing";
  render();
}, true);

document.addEventListener("mousemove", (event) => {
  if (!dragging) return;
  const at = worldOf(event, false);
  if (!at) return;
  // the picture moves with the mouse; it is saved where it is let go
  dragging.box.x = Math.round(at.x - dragging.dx);
  dragging.box.y = Math.round(at.y - dragging.dy);
  dragging.moved = true;
}, true);

document.addEventListener("mouseup", () => {
  if (!dragging) return;
  const { box, moved } = dragging;
  dragging = null;
  document.body.style.cursor = "";
  if (!moved || !data) return;
  picked = `${data.map}:${box.x}:${box.y}`;
  save(spotsOf(shown()));
}, true);

document.addEventListener("click", (event) => {
  if (!swallowClick) return;
  swallowClick = false;
  event.stopPropagation();
  event.preventDefault();
}, true);

/** A tap on a mailbox while the editor is open picks it (events.ts asks first): true when it did. */
(window as any).mailboxEditorTap = (worldX: number, worldY: number, slop: number): boolean => {
  if (!popup || !data) return false;
  const box = mailboxAt(worldX, worldY, slop);
  if (!box) return false;
  picked = box.id;
  render();
  return true;
};

/** How a mailbox is marked while the editor is open: every one, and the picked one more. */
(window as any).mailboxEditorMark = (box: Mailbox): "on" | "picked" | null =>
  !popup ? null : box.id === picked ? "picked" : "on";

/** The map's mailboxes were sent again (MAILBOXES): another map, or a change. */
(window as any).mailboxEditorRefresh = () => {
  if (!popup) return;
  if (data && mapName(data.map) !== mapName((window as any).mapData?.name)) picked = null;
  render();
  sendRequest({ type: "MAILBOX_EDITOR_LIST", data: null });
};

export default {
  toggle() {
    if (popup) closeEditor();
    else openEditor();
  },
  /** The mailboxes of the map, as the server holds them (MAILBOX_EDITOR_DATA). */
  onData(sent: EditorData) {
    if (!popup || !sent || !Array.isArray(sent.mailboxes)) return;
    data = sent;
    waiting = false;
    // drawn where the server holds them: a refused drag goes back
    if (mapName(sent.map) === mapName((window as any).mapData?.name)) setMailboxes({ map: sent.map, mailboxes: sent.mailboxes });
    status = sent.message ?? "";
    render();
  },
};
