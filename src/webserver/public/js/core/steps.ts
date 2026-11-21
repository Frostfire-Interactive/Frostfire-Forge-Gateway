/** how far a walker goes between two steps (px), and the least time between them (ms: a fast mount does not rattle) */
export const STEP_PX = 44, STEP_MIN_MS = 190;
/** standing still this long ends the walk: the next walk starts with a step right away */
export const STOP_MS = 180;

/** One walker's steps: fed their position every frame, it says on which frames they take one. */
export class Stepper {
  private last: { x: number; y: number; map: string } | null = null;
  private walked = 0;
  private lastMoveAt = 0;
  private lastStepAt = 0;

  /** Forget the walk (a walker who cannot walk now: dead, carried, gone): the next move starts afresh. */
  reset(): void {
    this.last = null;
  }

  step(x: number, y: number, map: string, now: number): boolean {
    const moved = this.last && this.last.map === map ? Math.max(Math.abs(x - this.last.x), Math.abs(y - this.last.y)) : 0;
    this.last = { x, y, map };
    if (moved <= 0.01 || moved > STEP_PX) return false;
    // after a stop the first step comes at once
    if (now - this.lastMoveAt > STOP_MS) this.walked = STEP_PX;
    this.lastMoveAt = now;
    this.walked += moved;
    if (this.walked < STEP_PX || now - this.lastStepAt < STEP_MIN_MS) return false;
    this.walked = 0;
    this.lastStepAt = now;
    return true;
  }
}
