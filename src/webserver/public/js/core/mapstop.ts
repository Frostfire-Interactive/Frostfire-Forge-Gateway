/** A map was just loaded: once the player may move again, a walk still going is stopped unless a movement key or the stick is held. */
export class StopAfterMapLoad {
  private owed = false;
  mapLoaded(): void {
    this.owed = true;
  }
  /** A direction was walked since: nothing is owed. */
  walked(): void {
    this.owed = false;
  }
  /** Each frame: true when ABORT is to be sent now. */
  due(allowed: boolean, keyHeld: boolean, stickHeld: boolean): boolean {
    if (!this.owed || !allowed || keyHeld || stickHeld) return false;
    this.owed = false;
    return true;
  }
}

export const stopAfterMapLoad = new StopAfterMapLoad();
