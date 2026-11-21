import { gapDirection } from "./handoffwalk.ts";

/** An own echo (the node moved the player) no older than this at the SWITCH means the player was walking then (a tick is 16-50 ms). */
export const RESUME_ECHO_MS = 150;

/** The eight directions HANDOFF_DONE may name as the facing; anything else is no direction. */
const DIRECTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]);

/** The facing HANDOFF_DONE names, lower case, or "" when it is none of the eight. */
export function doneFacing(direction: unknown): string {
  const facing = typeof direction === "string" ? direction.toLowerCase() : "";
  return DIRECTIONS.has(facing) ? facing : "";
}

export function walkAtSwitch(keys: { has(code: string): boolean }, stick: string, lastEchoAt: number | null | undefined, now: number): string {
  if (typeof lastEchoAt !== "number" || !(lastEchoAt > 0) || now - lastEchoAt > RESUME_ECHO_MS || now < lastEchoAt) return "";
  return gapDirection(keys, stick);
}

export function doneWalk(walk: unknown): string | null | undefined {
  if (walk === null) return null;
  if (typeof walk !== "string") return undefined;
  const direction = walk.toLowerCase();
  return DIRECTIONS.has(direction) ? direction : undefined;
}

/** What HANDOFF_DONE reads of the client. */
export interface DoneInput {
  /** walkAtSwitch at the SWITCH. */
  atSwitch: string;
  /** A movement key is held now (the renderer sends it, so it is told what not to). */
  keyPressed: boolean;
  /** The direction the keys name now, lower case ("" for none). */
  keyDirection: string;
  /** The stick direction now, as input.ts keeps it (upper case, "" for none). */
  stick: string;
  /** The facing HANDOFF_DONE names (doneFacing). */
  facing: string;
  /** A walk was under way at the SWITCH (a key held or the player moving), whatever the direction. */
  walkedAtSwitch: boolean;
  /** The walk HANDOFF_DONE names (doneWalk): a direction, null for none, undefined when the packet does not say. */
  walk?: string | null;
}

/** What to do about it. */
export interface DoneSend {
  /** The MOVEXY data to send now, or null for none. */
  send: string | null;
  /** The direction to put into input.ts as the last sent (a stick), or null to leave it. */
  lastSent: string | null;
  /** The key direction (upper case, as the renderer keeps it) to put in as the renderer's last sent, or null to leave it. */
  keyResumed: string | null;
}

export function doneSend(s: DoneInput): DoneSend {
  const named = s.walk !== undefined;
  const resumed = (direction: string) => named
    ? s.walk != null && direction.toLowerCase() === s.walk.toLowerCase()
    : s.atSwitch !== "" && s.facing === s.atSwitch && direction.toLowerCase() === s.facing;
  if (s.keyPressed) return { send: null, lastSent: null, keyResumed: resumed(s.keyDirection) ? s.keyDirection.toUpperCase() : null };
  if (s.stick) return { send: resumed(s.stick) ? null : s.stick, lastSent: s.stick, keyResumed: null };
  return { send: (named ? s.walk !== null : s.walkedAtSwitch) ? "ABORT" : null, lastSent: null, keyResumed: null };
}
