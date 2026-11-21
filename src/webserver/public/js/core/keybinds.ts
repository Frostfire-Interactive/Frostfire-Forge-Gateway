export type ActionGroup = "Windows" | "Spells" | "World" | "Movement" | "Game";

// `admin`: the engine does it only for admins, so the Hotkeys screen shows it only to them.
type ActionDef = { id: string; label: string; group: ActionGroup; defaultCode: string; fixed?: true; admin?: true };

const defs = [
  { id: "inventory", label: "Inventory", group: "Windows", defaultCode: "KeyB" },
  { id: "spellbook", label: "Spellbook", group: "Windows", defaultCode: "KeyP" },
  { id: "stats", label: "Character", group: "Windows", defaultCode: "KeyC" },
  { id: "friends", label: "Friends", group: "Windows", defaultCode: "KeyO" },
  { id: "guild", label: "Guild", group: "Windows", defaultCode: "KeyG" },
  { id: "collectables", label: "Collectables", group: "Windows", defaultCode: "KeyK" },
  { id: "achievements", label: "Achievements", group: "Windows", defaultCode: "KeyY" },
  { id: "questlog", label: "Quest Log", group: "Windows", defaultCode: "KeyL" },
  { id: "worldmap", label: "World Map", group: "Windows", defaultCode: "KeyM" },
  { id: "hotbar1", label: "Hotbar 1", group: "Spells", defaultCode: "Digit1" },
  { id: "hotbar2", label: "Hotbar 2", group: "Spells", defaultCode: "Digit2" },
  { id: "hotbar3", label: "Hotbar 3", group: "Spells", defaultCode: "Digit3" },
  { id: "hotbar4", label: "Hotbar 4", group: "Spells", defaultCode: "Digit4" },
  { id: "hotbar5", label: "Hotbar 5", group: "Spells", defaultCode: "Digit5" },
  { id: "hotbar6", label: "Hotbar 6", group: "Spells", defaultCode: "Digit6" },
  { id: "hotbar7", label: "Hotbar 7", group: "Spells", defaultCode: "Digit7" },
  { id: "hotbar8", label: "Hotbar 8", group: "Spells", defaultCode: "Digit8" },
  { id: "hotbar9", label: "Hotbar 9", group: "Spells", defaultCode: "Digit9" },
  { id: "hotbar10", label: "Hotbar 10", group: "Spells", defaultCode: "Digit0" },
  { id: "interact", label: "Interact / Loot", group: "World", defaultCode: "KeyE" },
  { id: "openChest", label: "Open Chest", group: "World", defaultCode: "KeyF" },
  { id: "targetClosest", label: "Target Closest", group: "World", defaultCode: "Tab" },
  { id: "mount", label: "Mount", group: "World", defaultCode: "KeyQ" },
  { id: "stealth", label: "Stealth", group: "World", defaultCode: "KeyX", admin: true },
  { id: "noclip", label: "No-clip", group: "World", defaultCode: "KeyZ", admin: true },
  { id: "moveUp", label: "Move Up", group: "Movement", defaultCode: "KeyW" },
  { id: "moveLeft", label: "Move Left", group: "Movement", defaultCode: "KeyA" },
  { id: "moveDown", label: "Move Down", group: "Movement", defaultCode: "KeyS" },
  { id: "moveRight", label: "Move Right", group: "Movement", defaultCode: "KeyD" },
  { id: "debug", label: "Debug Overlay", group: "Game", defaultCode: "F2" },
  // Escape and Enter are in every window's own handling (close, send), so they stay where they are.
  { id: "pause", label: "Close / Pause Menu", group: "Game", defaultCode: "Escape", fixed: true },
  { id: "chat", label: "Chat", group: "Game", defaultCode: "Enter", fixed: true },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof defs)[number]["id"];
export type Bindings = Record<ActionId, string>;
export type Action = { id: ActionId; label: string; group: ActionGroup; defaultCode: string; fixed: boolean; admin: boolean };

export const ACTIONS: readonly Action[] = defs.map((d) => ({ ...d, fixed: "fixed" in d, admin: "admin" in d })) as Action[];

/** The actions the Hotkeys screen lists for a player: all of them for an admin, all but the admin ones otherwise. */
export function actionsShown(isAdmin: boolean): readonly Action[] {
  return isAdmin ? ACTIONS : ACTIONS.filter((a) => !a.admin);
}
const byId = new Map<string, Action>(ACTIONS.map((a) => [a.id, a]));

export const DEFAULT_BINDINGS: Readonly<Bindings> = Object.freeze(
  Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaultCode])) as Bindings
);

const BINDABLE =
  /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal)|Arrow(?:Up|Down|Left|Right)|Space|Tab|F2|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|Delete|Home|End|PageUp|PageDown)$/;

export function isBindableCode(code: string): boolean {
  return typeof code === "string" && BINDABLE.test(code);
}

/** The action a key triggers, or null. */
export function actionForCode(bindings: Readonly<Bindings>, code: string): ActionId | null {
  for (const a of ACTIONS) if (bindings[a.id] === code) return a.id;
  return null;
}

export type RebindResult =
  | { ok: true; bindings: Bindings; swapped: ActionId | null }
  | { ok: false; reason: string };

export function rebind(bindings: Readonly<Bindings>, action: ActionId, code: string): RebindResult {
  const def = byId.get(action);
  if (!def) return { ok: false, reason: "Unknown action." };
  if (def.fixed) return { ok: false, reason: `${def.label} cannot be changed.` };
  if (!isBindableCode(code)) return { ok: false, reason: `${codeLabel(code) || "That key"} cannot be used.` };
  const next: Bindings = { ...bindings };
  const holder = actionForCode(bindings, code);
  if (holder === action) return { ok: true, bindings: next, swapped: null };
  if (holder) {
    if (byId.get(holder)!.fixed) return { ok: false, reason: `${codeLabel(code)} is reserved.` };
    next[holder] = bindings[action];
  }
  next[action] = code;
  return { ok: true, bindings: next, swapped: holder };
}

/** The bindings as saved: only the actions whose key is not the default. */
export function serializeBindings(bindings: Readonly<Bindings>): string {
  const out: Record<string, string> = {};
  for (const a of ACTIONS) if (!a.fixed && bindings[a.id] !== a.defaultCode) out[a.id] = bindings[a.id];
  return JSON.stringify(out);
}

export function parseBindings(raw: string | null | undefined): Bindings {
  const bindings: Bindings = { ...DEFAULT_BINDINGS };
  if (!raw) return bindings;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return bindings;
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return bindings;
  for (const [id, code] of Object.entries(saved as Record<string, unknown>)) {
    const def = byId.get(id);
    if (!def || def.fixed || typeof code !== "string" || !isBindableCode(code)) continue;
    bindings[def.id] = code;
  }
  if (new Set(Object.values(bindings)).size !== ACTIONS.length) return { ...DEFAULT_BINDINGS };
  return bindings;
}

/** A key as a player writes it ("KeyB" is B). */
export function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  if (code.startsWith("Numpad")) {
    const n = code.slice(6);
    const sym: Record<string, string> = { Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Decimal: "." };
    return `Num ${sym[n] ?? n}`;
  }
  const names: Record<string, string> = {
    Escape: "Esc", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", PageUp: "Page Up", PageDown: "Page Down",
  };
  return names[code] ?? code;
}

// ---------------------------------------------------------------------------------------------------- live bindings

const STORAGE_KEY = "keybinds";

function readStorage(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage blocked: the bindings last until the page is closed
  }
}

let current: Bindings = parseBindings(readStorage());
const listeners = new Set<() => void>();

function commit(next: Bindings) {
  current = next;
  const saved = serializeBindings(next);
  writeStorage(saved === "{}" ? null : saved);
  for (const fn of listeners) fn();
}

/** The key an action has now. */
export function getKey(action: ActionId): string {
  return current[action];
}

/** The action a key triggers now, or null. */
export function actionFor(code: string): ActionId | null {
  return actionForCode(current, code);
}

/** The key an action had before anything was rebound: the name its handler and the movement code know it by. */
export function defaultCodeOf(action: ActionId): string {
  return DEFAULT_BINDINGS[action];
}

/** Rebinds and saves. */
export function setKey(action: ActionId, code: string): RebindResult {
  const r = rebind(current, action, code);
  if (r.ok && r.bindings[action] !== current[action]) commit(r.bindings);
  return r;
}

export function resetBindings() {
  commit({ ...DEFAULT_BINDINGS });
}

/** Called after every change (the screen redraws; the hotbar labels follow). */
export function onBindingsChange(fn: () => void) {
  listeners.add(fn);
}
