/** While the local player walks on into a portal, and then until the next map's world is cleared (under the fade), what
 *  leaves the world (players despawned, NPCs unloaded) is kept back: the map being left stays as it was until it goes. */
export class LeaveHold<T> {
  private held: T[] = [];
  private changing = false;
  /** True when `item` is kept back: a walk into a portal still has `walkInLeftMs` to go, or a map change is under way. */
  hold(item: T, walkInLeftMs: number): boolean {
    if (!this.changing && walkInLeftMs <= 0) return false;
    this.held.push(item);
    return true;
  }
  /** LOAD_MAP came: kept until the world is cleared. */
  mapChanging(): void {
    this.changing = true;
  }
  /** The walk in ended: with no map change under way, what was kept is let go of, to apply now. */
  walkEnded(): T[] {
    return this.changing ? [] : this.release();
  }
  /** The world was cleared: what was kept, to apply now. */
  release(): T[] {
    this.changing = false;
    const out = this.held;
    this.held = [];
    return out;
  }
}

export type Leave = { player: unknown } | { npcs: unknown[] };
export const leaveHold = new LeaveHold<Leave>();
