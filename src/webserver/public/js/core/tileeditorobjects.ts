// The map editor's object layers (graveyards, warps, dungeon portals, chests): the parts that need no page.

export type ObjectKind = 'graveyard' | 'warp' | 'chest' | 'portal';
export type ObjectState = { x?: number, y?: number, width?: number, height?: number };

export type ObjectMutation = {
  type: ObjectKind;
  name: string;
  oldState: ObjectState | null;
  newState: ObjectState | null;
  // the whole object as it was when it left the map, so bringing it back restores every field
  data?: any;
  // set on a rename
  newName?: string;
};

/**
 * The loaded objects of a layer under the names the editor keys them by. Every object is kept: one with no
 * name, or a name an earlier one has, gets the first free `${prefix}_N`. The names are only the editor's:
 * they are saved with the layer when it is next changed, and the server keeps its own list until then.
 */
export function keyLoadedObjects(prefix: string, list: unknown): [string, any][] {
  const items = (Array.isArray(list) ? list : []).filter((o: any) => o && typeof o === 'object');
  const taken = new Set<string>();
  const out: [string, any][] = [];
  const pending: any[] = [];
  for (const o of items) {
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name && !taken.has(name)) { taken.add(name); out.push([name, o]); }
    else pending.push(o);
  }
  let counter = 1;
  for (const o of pending) {
    while (taken.has(`${prefix}_${counter}`)) counter++;
    const name = `${prefix}_${counter}`;
    taken.add(name);
    out.push([name, o]);
  }
  return out;
}

/**
 * The layers with edits the server does not have yet. Each mark counts its edits, so a save answered after
 * more edits were made clears only the layers that were not changed again in the meantime.
 */
export class UnsavedMarks {
  private edits = new Map<string, number>();
  private count = 0;

  add(layer: string): this {
    this.edits.set(layer, ++this.count);
    return this;
  }

  has(layer: string): boolean {
    return this.edits.has(layer);
  }

  clear(): void {
    this.edits.clear();
  }

  get size(): number {
    return this.edits.size;
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.edits.keys();
  }

  /** The marks as they are when a save is sent. */
  snapshot(): Map<string, number> {
    return new Map(this.edits);
  }

  /** The server saved what `sent` held: those layers are clear unless they were changed after it was taken. */
  settle(sent: Map<string, number>): void {
    for (const [layer, edit] of sent) {
      if (this.edits.get(layer) === edit) this.edits.delete(layer);
    }
  }
}

/** The key of an object's label: its layer and its name, as names are unique only within a layer. */
export const labelKey = (type: string, name: string): string => `${type}\n${name}`;

/**
 * The object layers tested by a right-click, first to last: the selected layer, then the other visible ones,
 * points (graveyards, chests) before rectangles (warps, dungeon portals), so a small object inside a
 * rectangle can still be clicked. A hidden layer takes no clicks.
 */
export function hitTestOrder(layers: { type: string, rect: boolean }[], selected: string | null, visible: (type: string) => boolean): string[] {
  const shown = layers.filter((l) => visible(l.type));
  const rank = (l: { type: string, rect: boolean }) => (l.type === selected ? 0 : l.rect ? 2 : 1);
  return shown.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map(({ l }) => l.type);
}

/**
 * A property edit put on the undo stack. While `open` (the entry of the same typing) is on top of the stack, a
 * new value goes into it instead of a new entry, so a number typed digit by digit is one undo step. An entry
 * that comes back to where it started is taken off. Returns the entry the typing goes on with.
 */
export function recordPropertyEdit(stack: any[], open: any | null, key: string, oldValue: unknown, newValue: unknown): any | null {
  if (open && stack[stack.length - 1] === open && open.key === key) {
    open.newValue = newValue;
    if (Object.is(open.oldValue, newValue)) { stack.pop(); return null; }
    return open;
  }
  const entry = { type: 'edit', key, oldValue, newValue };
  stack.push(entry);
  return entry;
}

export type MutationOutcome = { kind: 'renamed', name: string } | { kind: 'removed' } | { kind: 'restored' } | { kind: 'moved' } | null;

/**
 * Undo or redo of an object edit on the layer's store: a rename, a delete, a create, or a move or resize.
 * An object taken off the map (undoing its creation, redoing its deletion) is kept whole in the mutation,
 * so bringing it back restores it as it was, its properties too.
 */
export function applyObjectMutation(store: Record<string, any>, mutation: ObjectMutation, way: 'undo' | 'redo', layer: { rect: boolean, graveyard: boolean }): MutationOutcome {
  const newName = mutation.newName;
  if (newName !== undefined) {
    const from = way === 'undo' ? newName : mutation.name;
    const to = way === 'undo' ? mutation.name : newName;
    const objectData = store[from];
    if (!objectData) return null;
    store[to] = objectData;
    delete store[from];
    return { kind: 'renamed', name: to };
  }

  const isDeletion = mutation.newState === null && mutation.oldState !== null;
  const isCreation = mutation.oldState === null && mutation.newState !== null;
  const removes = way === 'undo' ? isCreation : isDeletion;
  const restores = way === 'undo' ? isDeletion : isCreation;
  const state = way === 'undo' ? mutation.oldState : mutation.newState;

  if (removes) {
    if (store[mutation.name]) mutation.data = structuredClone(store[mutation.name]);
    delete store[mutation.name];
    return { kind: 'removed' };
  }
  if (restores && state) {
    store[mutation.name] = mutation.data
      ? structuredClone(mutation.data)
      : {
          position: { x: state.x, y: state.y },
          ...(layer.graveyard ? { x: state.x, y: state.y } : {}),
          ...(layer.rect ? { size: { width: state.width, height: state.height } } : {}),
        };
    return { kind: 'restored' };
  }
  if (!state) return null;
  const objectData = store[mutation.name];
  if (!objectData) return null;
  if (!objectData.position) objectData.position = {};
  if (state.x !== undefined) {
    objectData.position.x = state.x;
    if (layer.graveyard) objectData.x = state.x;
  }
  if (state.y !== undefined) {
    objectData.position.y = state.y;
    if (layer.graveyard) objectData.y = state.y;
  }
  if (layer.rect) {
    if (!objectData.size) objectData.size = {};
    if (state.width !== undefined) objectData.size.width = state.width;
    if (state.height !== undefined) objectData.size.height = state.height;
  }
  return { kind: 'moved' };
}
