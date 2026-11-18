import { expect, test } from "bun:test";
import {
  ACTIONS, DEFAULT_BINDINGS, actionForCode, actionsShown, codeLabel, isBindableCode, parseBindings, rebind, serializeBindings,
} from "../webserver/public/js/core/keybinds";

// The hotkey rebinding screen (options menu, Hotkeys): every action with a keyboard shortcut and its key. The defaults
// are exactly the keys that were hard-coded before, so a player who rebinds nothing sees no change.

test("the defaults are the keys that were hard-coded", () => {
  expect(DEFAULT_BINDINGS.inventory).toBe("KeyB");
  expect(DEFAULT_BINDINGS.spellbook).toBe("KeyP");
  expect(DEFAULT_BINDINGS.friends).toBe("KeyO");
  expect(DEFAULT_BINDINGS.stats).toBe("KeyC");
  expect(DEFAULT_BINDINGS.stealth).toBe("KeyX");
  expect(DEFAULT_BINDINGS.noclip).toBe("KeyZ");
  expect(DEFAULT_BINDINGS.collectables).toBe("KeyK");
  expect(DEFAULT_BINDINGS.achievements).toBe("KeyY");
  expect(DEFAULT_BINDINGS.questlog).toBe("KeyL");
  expect(DEFAULT_BINDINGS.worldmap).toBe("KeyM");
  expect(DEFAULT_BINDINGS.guild).toBe("KeyG");
  expect(DEFAULT_BINDINGS.mount).toBe("KeyQ");
  expect(DEFAULT_BINDINGS.interact).toBe("KeyE");
  expect(DEFAULT_BINDINGS.openChest).toBe("KeyF");
  expect(DEFAULT_BINDINGS.targetClosest).toBe("Tab");
  expect(DEFAULT_BINDINGS.debug).toBe("F2");
  expect(DEFAULT_BINDINGS.moveUp).toBe("KeyW");
  expect(DEFAULT_BINDINGS.moveLeft).toBe("KeyA");
  expect(DEFAULT_BINDINGS.moveDown).toBe("KeyS");
  expect(DEFAULT_BINDINGS.moveRight).toBe("KeyD");
  expect(DEFAULT_BINDINGS.pause).toBe("Escape");
  expect(DEFAULT_BINDINGS.chat).toBe("Enter");
  for (let i = 1; i <= 10; i++) expect(DEFAULT_BINDINGS[`hotbar${i}` as keyof typeof DEFAULT_BINDINGS]).toBe(`Digit${i % 10}`);
});

test("no two actions share a default key", () => {
  const codes = ACTIONS.map((a) => a.defaultCode);
  expect(new Set(codes).size).toBe(codes.length);
});

test("an action is found by its key", () => {
  expect(actionForCode(DEFAULT_BINDINGS, "KeyB")).toBe("inventory");
  expect(actionForCode(DEFAULT_BINDINGS, "Digit0")).toBe("hotbar10");
  expect(actionForCode(DEFAULT_BINDINGS, "KeyJ")).toBeNull();
});

test("rebinding to a free key moves the action there", () => {
  const r = rebind(DEFAULT_BINDINGS, "inventory", "KeyJ");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.bindings.inventory).toBe("KeyJ");
  expect(r.swapped).toBeNull();
  expect(actionForCode(r.bindings, "KeyB")).toBeNull();
  expect(actionForCode(r.bindings, "KeyJ")).toBe("inventory");
});

test("rebinding to a key another action holds swaps the two", () => {
  const r = rebind(DEFAULT_BINDINGS, "inventory", "KeyP");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.bindings.inventory).toBe("KeyP");
  expect(r.bindings.spellbook).toBe("KeyB");
  expect(r.swapped).toBe("spellbook");
  expect(new Set(Object.values(r.bindings)).size).toBe(ACTIONS.length);
});

test("rebinding to the key it already has changes nothing", () => {
  const r = rebind(DEFAULT_BINDINGS, "inventory", "KeyB");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.bindings).toEqual(DEFAULT_BINDINGS);
  expect(r.swapped).toBeNull();
});

test("rebind does not change the bindings it was given", () => {
  const before = { ...DEFAULT_BINDINGS };
  rebind(DEFAULT_BINDINGS, "inventory", "KeyP");
  expect(DEFAULT_BINDINGS).toEqual(before);
});

test("Escape and Enter are fixed: they cannot be taken or moved", () => {
  expect(rebind(DEFAULT_BINDINGS, "inventory", "Escape").ok).toBe(false);
  expect(rebind(DEFAULT_BINDINGS, "inventory", "Enter").ok).toBe(false);
  expect(rebind(DEFAULT_BINDINGS, "pause", "KeyJ").ok).toBe(false);
  expect(rebind(DEFAULT_BINDINGS, "chat", "KeyJ").ok).toBe(false);
});

test("keys the browser or game keeps are refused", () => {
  for (const code of ["ControlLeft", "ShiftLeft", "AltLeft", "F1", "F5", "F12", "ContextMenu", "MetaLeft", ""]) {
    expect(isBindableCode(code)).toBe(false);
    expect(rebind(DEFAULT_BINDINGS, "inventory", code).ok).toBe(false);
  }
  for (const code of ["KeyJ", "Digit4", "F2", "Tab", "ArrowUp", "Space", "Numpad1", "Backquote"]) {
    expect(isBindableCode(code)).toBe(true);
  }
});

test("an unknown action is refused", () => {
  expect(rebind(DEFAULT_BINDINGS, "nope" as never, "KeyJ").ok).toBe(false);
});

test("only the changed keys are saved", () => {
  expect(JSON.parse(serializeBindings(DEFAULT_BINDINGS))).toEqual({});
  const r = rebind(DEFAULT_BINDINGS, "inventory", "KeyJ");
  if (!r.ok) throw new Error("rebind failed");
  expect(JSON.parse(serializeBindings(r.bindings))).toEqual({ inventory: "KeyJ" });
});

test("saved keys load back, and a swap survives the round trip", () => {
  const r = rebind(DEFAULT_BINDINGS, "inventory", "KeyP");
  if (!r.ok) throw new Error("rebind failed");
  expect(parseBindings(serializeBindings(r.bindings))).toEqual(r.bindings);
});

test("nothing saved, or a broken save, loads the defaults", () => {
  expect(parseBindings(null)).toEqual(DEFAULT_BINDINGS);
  expect(parseBindings("")).toEqual(DEFAULT_BINDINGS);
  expect(parseBindings("{not json")).toEqual(DEFAULT_BINDINGS);
  expect(parseBindings("[1,2]")).toEqual(DEFAULT_BINDINGS);
  expect(parseBindings("42")).toEqual(DEFAULT_BINDINGS);
});

test("bad entries in a save are skipped, the good ones kept", () => {
  const loaded = parseBindings(JSON.stringify({ inventory: "KeyJ", spellbook: 7, ghost: "KeyH", friends: "ControlLeft", pause: "KeyJ2" }));
  expect(loaded.inventory).toBe("KeyJ");
  expect(loaded.spellbook).toBe("KeyP");
  expect(loaded.friends).toBe("KeyO");
  expect(loaded.pause).toBe("Escape");
});

test("a save that gives two actions one key loads the defaults", () => {
  expect(parseBindings(JSON.stringify({ inventory: "KeyP" }))).toEqual(DEFAULT_BINDINGS);
  expect(parseBindings(JSON.stringify({ inventory: "KeyJ", spellbook: "KeyJ" }))).toEqual(DEFAULT_BINDINGS);
});

test("keys read as a player writes them", () => {
  expect(codeLabel("KeyB")).toBe("B");
  expect(codeLabel("Digit5")).toBe("5");
  expect(codeLabel("Tab")).toBe("Tab");
  expect(codeLabel("F2")).toBe("F2");
  expect(codeLabel("ArrowUp")).toBe("Up");
  expect(codeLabel("Numpad3")).toBe("Num 3");
  expect(codeLabel("Escape")).toBe("Esc");
  expect(codeLabel("Space")).toBe("Space");
  expect(codeLabel("Backquote")).toBe("`");
});

test("Stealth and No-clip are admin keys, shown only to admins", () => {
  expect(ACTIONS.filter((a) => a.admin).map((a) => a.id)).toEqual(["stealth", "noclip"]);
  const shown = (admin: boolean) => actionsShown(admin).map((a) => a.id);
  expect(shown(false)).not.toContain("stealth");
  expect(shown(false)).not.toContain("noclip");
  expect(shown(false)).toContain("mount");
  expect(shown(false).length).toBe(ACTIONS.length - 2);
  expect(shown(true)).toEqual(ACTIONS.map((a) => a.id));
});
