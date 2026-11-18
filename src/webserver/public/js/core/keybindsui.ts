// The Hotkeys screen of the options menu: every action with a keyboard shortcut and its key. Click a key, press the new
// one. Escape leaves without changing. A key another action has is swapped with it (keybinds.ts).

import { ACTIONS, actionsShown, codeLabel, getKey, onBindingsChange, resetBindings, setKey, type Action, type ActionId } from "./keybinds.js";
import { cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";

const container = document.getElementById("options-menu-container");
const menu = document.getElementById("options-menu");
const title = document.getElementById("options-menu-title");
const openButton = document.getElementById("options-hotkeys-open");
const backButton = document.getElementById("options-hotkeys-back");
const resetButton = document.getElementById("options-hotkeys-reset");
const list = document.getElementById("options-hotkeys-list");
const message = document.getElementById("options-hotkeys-message");

const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OS"]);

const buttons = new Map<ActionId, HTMLButtonElement>();
const rows = new Map<ActionId, HTMLElement>();
const sections: HTMLElement[] = [];
let shown = new Set<ActionId>(actionsShown(false).map((action) => action.id));
let capturing: ActionId | null = null;

function say(text: string) {
  if (message) message.textContent = text;
}

function labelOf(action: Action): string {
  return codeLabel(getKey(action.id));
}

/** The hotbar's number badges show the key each slot has. */
function updateHotbarLabels() {
  const badges = document.querySelectorAll<HTMLElement>("#hotbar #grid .slot .hotbar-key");
  badges.forEach((badge, index) => {
    const action = ACTIONS.find((candidate) => candidate.id === `hotbar${index + 1}`);
    if (action) badge.textContent = labelOf(action);
  });
}

function refresh() {
  for (const action of ACTIONS) {
    const button = buttons.get(action.id);
    if (!button) continue;
    const active = capturing === action.id;
    button.classList.toggle("capturing", active);
    button.textContent = active ? "Press a key..." : labelOf(action);
  }
  updateHotbarLabels();
}

function stopCapture() {
  capturing = null;
  window.removeEventListener("keydown", onCaptureKey, true);
  refresh();
}

function startCapture(action: ActionId) {
  if (capturing === null) window.addEventListener("keydown", onCaptureKey, true);
  capturing = action;
  say("Press the new key, or Escape to cancel.");
  refresh();
}

/** Heard before every game key handler while a key is being chosen: nothing pressed then acts in the game. */
function onCaptureKey(event: KeyboardEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (capturing === null || MODIFIERS.has(event.code) || event.repeat) return;
  if (event.code === "Escape") {
    say("");
    stopCapture();
    return;
  }
  const action = capturing;
  const result = setKey(action, event.code);
  if (!result.ok) {
    say(result.reason);
    return;
  }
  const name = ACTIONS.find((candidate) => candidate.id === action)!.label;
  // A key swapped with an action this player is not shown (an admin one) is told as a plain move.
  if (result.swapped && shown.has(result.swapped)) {
    const other = ACTIONS.find((candidate) => candidate.id === result.swapped)!;
    say(`${codeLabel(event.code)} was ${other.label}: the two keys are swapped.`);
  } else {
    say(`${name} is now ${codeLabel(event.code)}.`);
  }
  stopCapture();
}

/** One section per group (its heading and rows), in a box the CSS lays out in columns. */
function build() {
  if (!list) return;
  const columns = document.createElement("div");
  columns.className = "hotkeys-columns ui";
  let section: HTMLElement | null = null;
  let group = "";
  for (const action of ACTIONS) {
    if (!section || action.group !== group) {
      group = action.group;
      section = document.createElement("div");
      section.className = "hotkeys-section ui";
      sections.push(section);
      const heading = document.createElement("div");
      heading.className = "hotkeys-group ui";
      heading.textContent = group;
      section.appendChild(heading);
      columns.appendChild(section);
    }
    const row = document.createElement("div");
    row.className = "hotkeys-row ui";
    const label = document.createElement("label");
    label.className = "ui";
    label.textContent = action.label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hotkeys-key ui";
    if (action.fixed) {
      button.classList.add("fixed");
      button.disabled = true;
      button.title = "This key cannot be changed.";
    } else {
      button.addEventListener("click", () => startCapture(action.id));
    }
    buttons.set(action.id, button);
    rows.set(action.id, row);
    row.append(label, button);
    section.appendChild(row);
  }
  list.appendChild(columns);
  refresh();
}

function isAdmin(): boolean {
  const self = Array.from(Cache.getInstance().players).find((player: any) => player.id === cachedPlayerId) as any;
  return !!self?.isAdmin;
}

/** Shows the rows this player may use: the admin keys only to admins. A group left with no rows is hidden too. */
function showRows() {
  shown = new Set(actionsShown(isAdmin()).map((action) => action.id));
  for (const [id, row] of rows) row.hidden = !shown.has(id);
  for (const section of sections) section.hidden = !section.querySelector(".hotkeys-row:not([hidden])");
}

function open() {
  showRows();
  if (title) title.textContent = "Hotkeys";
  menu?.classList.add("hotkeys-open");
}

function close() {
  if (capturing !== null) stopCapture();
  say("");
  if (title) title.textContent = "Settings";
  menu?.classList.remove("hotkeys-open");
}

if (menu && list) {
  build();
  onBindingsChange(refresh);
  openButton?.addEventListener("click", open);
  backButton?.addEventListener("click", close);
  resetButton?.addEventListener("click", () => {
    if (capturing !== null) stopCapture();
    resetBindings();
    say("All hotkeys are back to their defaults.");
  });
  // However the options menu is hidden (its X, Escape, the pause menu), the Hotkeys screen is left too, so the menu
  // opens on Settings next time.
  if (container) {
    new MutationObserver(() => {
      if (container.style.display !== "block" && menu.classList.contains("hotkeys-open")) close();
    }).observe(container, { attributes: true, attributeFilter: ["style"] });
  }
}
