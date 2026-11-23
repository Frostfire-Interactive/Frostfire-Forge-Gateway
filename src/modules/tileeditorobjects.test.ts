import { expect, test } from "bun:test";
import { applyObjectMutation, hitTestOrder, keyLoadedObjects, labelKey, recordPropertyEdit, UnsavedMarks, type ObjectMutation } from "../webserver/public/js/core/tileeditorobjects";

const source = await Bun.file(new URL("../webserver/public/js/core/tileeditor.ts", import.meta.url)).text();
const renderer = await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text();
/** The body of a method of the TileEditor class, from its signature to the next method at the same indent. */
const method = (signature: string): string => {
  const start = source.indexOf(`  ${signature}`);
  if (start < 0) throw new Error(`no ${signature}`);
  const next = source.slice(start + 1).search(/\n  (private|public) /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
};

const PORTAL = { rect: true, graveyard: false };
const WARP = { rect: true, graveyard: false };
const CHEST = { rect: false, graveyard: false };

test("loaded objects with no name or a repeated name are kept under a free auto name", () => {
  const out = keyLoadedObjects("Chest", [{ name: "Chest_1" }, { name: "" }, { name: "Chest_1" }, {}, null]);
  expect(out.map(([name]) => name)).toEqual(["Chest_1", "Chest_2", "Chest_3", "Chest_4"]);
});

test("auto names given on load do not mark the layer unsaved", () => {
  const convert = method("private convertMapObjectsToEditorFormat(");
  expect(convert).toContain("keyLoadedObjects(");
  expect(convert).not.toContain("unsavedLayers.add");
  expect(source).not.toContain("private keyLoadedObjects(");
});

test("a save clears only the layers it carried that were not changed again before the answer", () => {
  const marks = new UnsavedMarks();
  marks.add("Chests").add("Warps");
  const sent = marks.snapshot();
  marks.add("Warps").add("Zones");
  marks.settle(sent);
  expect([...marks]).toEqual(["Warps", "Zones"]);
});

test("a save that fails keeps every mark", () => {
  const marks = new UnsavedMarks();
  marks.add("Chests");
  marks.snapshot();
  expect(marks.has("Chests")).toBe(true);
  expect(marks.size).toBe(1);
});

test("the editor clears the unsaved marks and the edits only on the server's answer that the save worked", () => {
  const save = method("private save(");
  expect(save).not.toContain("unsavedLayers.clear()");
  expect(save).not.toContain("this.undoStack = []");
  expect(save).toContain("saveId");
  const answer = method("public mapSaveResult(");
  expect(answer).toContain("settle(");
  expect(answer).toMatch(/ok/);
});

test("a refused save does not start the save cooldown", () => {
  const save = method("private save(");
  const cooldown = save.indexOf("this.lastSaveTime = now");
  const lastRefusal = save.lastIndexOf("return;");
  expect(cooldown).toBeGreaterThan(lastRefusal);
});

test("labels of objects with one name on two layers have their own keys", () => {
  expect(labelKey("Graveyards", "Spot")).not.toBe(labelKey("Chests", "Spot"));
  expect(source).toContain("this.labelCoords.set(labelKey(type, name)");
  expect(source).not.toMatch(/labelCoords\.(get|delete)\((name|mutation\.name)\)/);
});

test("graveyards and warps are drawn as selected only when their own layer is selected", () => {
  expect(renderer).not.toContain("tileEditor && tileEditor.getSelectedObjectName?.() === name;");
  expect(renderer).toContain("isEditorSelected(tileEditor, 'Graveyards', name)");
  expect(renderer).toContain("isEditorSelected(tileEditor, 'Warps', name)");
});

test("redo of a created object brings it back as it was when it was undone", () => {
  const store: Record<string, any> = { Chest_1: { lootTableId: 0, resetMinutes: 30, position: { x: 5, y: 6 }, layer: null } };
  const create: ObjectMutation = { type: "chest", name: "Chest_1", oldState: null, newState: { x: 5, y: 6 }, data: structuredClone(store.Chest_1) };
  store.Chest_1.lootTableId = 7;
  store.Chest_1.resetMinutes = 90;
  expect(applyObjectMutation(store, create, "undo", CHEST)).toEqual({ kind: "removed" });
  expect(store.Chest_1).toBeUndefined();
  expect(applyObjectMutation(store, create, "redo", CHEST)).toEqual({ kind: "restored" });
  expect(store.Chest_1).toEqual({ lootTableId: 7, resetMinutes: 90, position: { x: 5, y: 6 }, layer: null });
});

test("undoing a warp delete keeps its destination", () => {
  const store: Record<string, any> = { Warp_1: { map: "town", x: 100, y: 200, position: { x: 5, y: 6 }, size: { width: 32, height: 32 } } };
  const remove: ObjectMutation = { type: "warp", name: "Warp_1", oldState: { x: 5, y: 6, width: 32, height: 32 }, newState: null, data: structuredClone(store.Warp_1) };
  delete store.Warp_1;
  applyObjectMutation(store, remove, "undo", WARP);
  expect(store.Warp_1).toEqual({ map: "town", x: 100, y: 200, position: { x: 5, y: 6 }, size: { width: 32, height: 32 } });
  // a warp created then undone and redone keeps what it was given in between
  const created: Record<string, any> = { Warp_2: { map: "", x: "", y: "", position: { x: 1, y: 1 }, size: { width: 32, height: 32 } } };
  const create: ObjectMutation = { type: "warp", name: "Warp_2", oldState: null, newState: { x: 1, y: 1, width: 32, height: 32 } };
  created.Warp_2.map = "cave";
  applyObjectMutation(created, create, "undo", WARP);
  applyObjectMutation(created, create, "redo", WARP);
  expect(created.Warp_2.map).toBe("cave");
});

test("the editor keeps every deleted object whole for undo and uses the shared undo of object edits", () => {
  const del = method("private deleteSelectedObject(");
  expect(del).not.toContain("PICKER_LAYERS.has(type)) mutation.data");
  expect(del).toContain("data: structuredClone(objectData)");
  expect(method("private applyObjectMutation(")).toContain("applyMutationToStore(");
});

test("a move or resize puts the position and size back, and a portal's size with it", () => {
  const store: Record<string, any> = { P: { dungeonId: 1, position: { x: 0, y: 0 }, size: { width: 32, height: 32 } } };
  const move: ObjectMutation = { type: "portal", name: "P", oldState: { x: 0, y: 0, width: 32, height: 32 }, newState: { x: 10, y: 20, width: 64, height: 48 } };
  applyObjectMutation(store, move, "redo", PORTAL);
  expect(store.P).toEqual({ dungeonId: 1, position: { x: 10, y: 20 }, size: { width: 64, height: 48 } });
  applyObjectMutation(store, move, "undo", PORTAL);
  expect(store.P.position).toEqual({ x: 0, y: 0 });
});

test("a right-click skips hidden layers and tests a small object before a rectangle around it", () => {
  const layers = [
    { type: "Graveyards", rect: false }, { type: "Warps", rect: true }, { type: "DungeonPortals", rect: true }, { type: "Chests", rect: false },
  ];
  const all = () => true;
  expect(hitTestOrder(layers, null, all)).toEqual(["Graveyards", "Chests", "Warps", "DungeonPortals"]);
  expect(hitTestOrder(layers, "Warps", all)).toEqual(["Warps", "Graveyards", "Chests", "DungeonPortals"]);
  expect(hitTestOrder(layers, "Warps", (t) => t !== "DungeonPortals")).toEqual(["Warps", "Graveyards", "Chests"]);
  expect(method("private onMapContextMenu(")).toContain("hitTestOrder(");
});

test("typing a number digit by digit is one undo step", () => {
  const stack: any[] = [];
  let open = recordPropertyEdit(stack, null, "resetMinutes", 30, 1);
  open = recordPropertyEdit(stack, open, "resetMinutes", 1, 12);
  open = recordPropertyEdit(stack, open, "resetMinutes", 12, 120);
  expect(stack).toEqual([{ type: "edit", key: "resetMinutes", oldValue: 30, newValue: 120 }]);
  // typed back to where it began: nothing to undo
  recordPropertyEdit(stack, open, "resetMinutes", 120, 30);
  expect(stack).toEqual([]);
  // a new typing after the field was left is a new step
  const first = recordPropertyEdit(stack, null, "resetMinutes", 30, 45);
  recordPropertyEdit(stack, null, "resetMinutes", 45, 50);
  expect(stack).toHaveLength(2);
  expect(stack[0]).toBe(first);
  expect(method("private renderPickerProperties(")).toContain("recordPropertyEdit(");
});
