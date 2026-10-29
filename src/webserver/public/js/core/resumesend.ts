// What the client sends at HANDOFF_DONE (cells phase 7, the catch-up step on a crossing).
//
// The new node resumes the walk the player had at the SWITCH on its own (engine arrival: it steps the player in the
// direction its mover had, from the committed point). A MOVEXY the client then sends in that same direction is not
// news to it, but it restarts the node's mover (the older mover sees a newer move number and stops, a new one is
// registered), which moves the next step by up to a tick: the echoes come unevenly and the draw shows one slow frame and
// one fast one. So when the walk is known to be resumed in the direction the player holds, nothing is sent and the
// client's last sent direction is set to it, as if it had been sent. In every other case what is sent is what was sent
// before: a different direction, a player who stood at the SWITCH, a key or stick let go in the gap.
//
// This file has no DOM and no socket, so the engine's tests run it.

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

/**
 * The direction the player was walking at the SWITCH, lower case, or "" when that is not known for sure: the keys or the
 * stick are held, and the node moved the player a moment ago (`lastEchoAt`, performance.now() of the last own echo). A
 * direction held but not yet sent (the node walks the old one: it names that as the facing at DONE) or a player who has
 * just stopped (no echo) is not a known walk; doneSend compares the direction with the facing as well.
 */
export function walkAtSwitch(keys: { has(code: string): boolean }, stick: string, lastEchoAt: number | null | undefined, now: number): string {
  if (typeof lastEchoAt !== "number" || !(lastEchoAt > 0) || now - lastEchoAt > RESUME_ECHO_MS || now < lastEchoAt) return "";
  return gapDirection(keys, stick);
}

/**
 * The walk HANDOFF_DONE names: the direction the new node walks the player in as it sends DONE, lower case, or null when
 * it does not walk the player. undefined when the packet has no walk (an older engine), or names something that is
 * neither null nor one of the eight directions; doneSend then decides from the facing.
 */
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

/**
 * The send at HANDOFF_DONE. The walk is known to be resumed when the player was walking at the SWITCH in a direction
 * (walkAtSwitch), the node names that direction as the facing, and the player holds it now. Then a stick sends nothing
 * (its last sent is still set) and a key is marked as sent for the renderer. Else, as before: a stick is sent at once, a
 * key is left to the renderer's next frame, and a key let go in the gap is aborted if a walk was under way at the SWITCH.
 *
 * Where HANDOFF_DONE names the walk (`walk` is a direction or null), that decides, whatever the facing or the walk at the
 * SWITCH: the direction held is not sent only when the node already walks it; a direction held while the node walks
 * another way or none is sent (a key by the renderer's next frame); a key or stick let go is told to the node only
 * while it walks the player.
 */
export function doneSend(s: DoneInput): DoneSend {
  const named = s.walk !== undefined;
  const resumed = (direction: string) => named
    ? s.walk != null && direction.toLowerCase() === s.walk.toLowerCase()
    : s.atSwitch !== "" && s.facing === s.atSwitch && direction.toLowerCase() === s.facing;
  if (s.keyPressed) return { send: null, lastSent: null, keyResumed: resumed(s.keyDirection) ? s.keyDirection.toUpperCase() : null };
  if (s.stick) return { send: resumed(s.stick) ? null : s.stick, lastSent: s.stick, keyResumed: null };
  return { send: (named ? s.walk !== null : s.walkedAtSwitch) ? "ABORT" : null, lastSent: null, keyResumed: null };
}
