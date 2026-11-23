import Cache from "./cache.js";
import { handleCommand } from "./chat.js";
import { cachedPlayerId } from "./socket.js";
import { commandFor, staffToolGroups } from "./stafftools.js";
import { clampPanel, defaultPanelPosition, parsePanelState, serializePanelState, type PanelPoint, type PanelState } from "./stafftoolbarpos.js";
import { icon } from "./toolicons.js";
import { hideItemTooltip, setupTextTooltip } from "./tooltip.js";

const BAR_ID = "staff-toolbar";
/** Where the panel was put and whether it is minimized, kept per browser. */
const STORAGE_KEY = "staffToolbar";

let state: PanelState = { position: null, minimized: false };
let resizeListening = false;

function ownUsername(): string | null {
  const self: any = Array.from(Cache.getInstance().players as Iterable<any>).find((player) => player.id === cachedPlayerId);
  return self?.username ?? null;
}

function loadState(): PanelState {
  try {
    return parsePanelState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { position: null, minimized: false };
  }
}

function saveState(): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializePanelState(state));
  } catch {
    // No storage (private window, blocked site data): the panel still works, it is just not remembered.
  }
}

function viewSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function panelSize(bar: HTMLElement) {
  return { width: bar.offsetWidth, height: bar.offsetHeight };
}

/** Puts the panel where it was left, or by the right edge if it never was, kept inside the window. */
function place(bar: HTMLElement, point: PanelPoint | null): PanelPoint {
  const size = panelSize(bar);
  const at = point ? clampPanel(point, size, viewSize()) : defaultPanelPosition(size, viewSize());
  bar.style.left = `${at.x}px`;
  bar.style.top = `${at.y}px`;
  return at;
}

function setMinimized(bar: HTMLElement, toggle: HTMLButtonElement, minimized: boolean): void {
  bar.classList.toggle("minimized", minimized);
  // (a minus sign, U+2212: as wide as the plus)
  toggle.textContent = minimized ? "+" : String.fromCharCode(0x2212);
  toggle.setAttribute("aria-label", minimized ? "Expand staff tools" : "Minimize staff tools");
  toggle.setAttribute("aria-expanded", String(!minimized));
}

/** The panel is dragged by its header, the top of its frame. */
function makeDraggable(bar: HTMLElement, handle: HTMLElement): void {
  let drag: { pointerId: number; startX: number; startY: number; from: PanelPoint; moved: boolean } | null = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: { x: bar.offsetLeft, y: bar.offsetTop },
      moved: false,
    };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    place(bar, { x: drag.from.x + dx, y: drag.from.y + dy });
  });
  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      state.position = { x: bar.offsetLeft, y: bar.offsetTop };
      saveState();
    }
    drag = null;
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/**
 * The staff panel: a button for each tool the server says this player may open (STAFF_TOOLS), in a panel that can be
 * dragged by its header and minimized to it. A button sends the tool's chat command, so it opens, or closes, as typing
 * the command does, and the server checks it as it does then.
 */
export function showStaffTools(ids: unknown): void {
  const old = document.getElementById(BAR_ID);
  // a tooltip shown for one of its buttons goes with it
  if (old) { hideItemTooltip(); old.remove(); }
  const groups = staffToolGroups(ids);
  if (!groups.length) return;
  state = loadState();

  const bar = document.createElement("nav");
  bar.id = BAR_ID;
  // (.ui: a click on it is not a click on the world under it)
  bar.className = "ui";
  bar.setAttribute("aria-label", "Staff tools");

  // The top of the frame: what the panel is dragged by, and all that is left of it when minimized.
  const header = document.createElement("div");
  header.className = "staff-toolbar-header";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "panel-close staff-toolbar-minimize ui";
  setupTextTooltip(toggle, () => ({ name: bar.classList.contains("minimized") ? "Expand" : "Minimize" }));
  toggle.addEventListener("click", () => {
    toggle.blur();
    state.minimized = !bar.classList.contains("minimized");
    setMinimized(bar, toggle, state.minimized);
    place(bar, state.position);
    saveState();
  });
  bar.append(header, toggle);

  const tools = document.createElement("div");
  tools.className = "staff-toolbar-tools";
  groups.forEach((group, index) => {
    if (index > 0) {
      const line = document.createElement("div");
      line.className = "staff-toolbar-divider";
      tools.appendChild(line);
    }
    for (const tool of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "staff-toolbar-button";
      button.dataset.tool = tool.id;
      button.setAttribute("aria-label", tool.name);
      // the game's tooltip: the tool's name, and the chat command the button sends
      setupTextTooltip(button, () => ({ name: tool.name, type: commandFor(tool, ownUsername()) }));
      button.appendChild(icon(tool.icon, 26));
      button.addEventListener("click", () => {
        // Not left focused: Space and Enter belong to the game again.
        button.blur();
        void handleCommand(commandFor(tool, ownUsername()));
      });
      tools.appendChild(button);
    }
  });
  bar.appendChild(tools);

  setMinimized(bar, toggle, state.minimized);
  makeDraggable(bar, header);
  document.body.appendChild(bar);
  place(bar, state.position);

  if (!resizeListening) {
    resizeListening = true;
    // A smaller window brings the panel back inside it; the place it was left is kept for when the window grows again.
    window.addEventListener("resize", () => {
      const shown = document.getElementById(BAR_ID);
      if (shown) place(shown, state.position);
    });
  }
}
