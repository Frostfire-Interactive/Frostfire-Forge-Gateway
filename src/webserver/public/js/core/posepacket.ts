// SPRITE_SHEET_POSE: the server's short form of SPRITE_SHEET_ANIMATION for a pose change on sheets this client already
// holds for the player ({ id, animationState }). The server sends the full packet whenever the sheets are new or have
// changed, so a pose for a player with no layered animation here is dropped: the full packet is on its way or follows.
//
// The same pose also arrives as a binary datagram with the animated player's pose revision (the server's
// socket/pose_codec.ts has the same layout), at the change and again 100 and 400 ms after it:
//   [u8 0x05][u16 count, little endian] then per pose: [u32 id][u32 revision][u8 n][n bytes, the state in UTF-8]
// A datagram can be late, repeated or out of order, so it is applied only if its revision is newer than the one the
// player shows (player._poseRev), and only for a player this client knows. The stream copies of a viewer's pose (the
// SPRITE_SHEET_POSE packet, and the SPRITE_SHEET_ANIMATION sent when the viewer did not hold the look) carry the same
// revision in `poseRev`: one that is older than the revision shown is late, so its pose is not shown (the rest of
// a sheet is applied), and the shown revision is the higher of the two. The revision is forgotten only when the player
// is built anew (a new object: spawn, entering the view, a landing). A stream pose or sheet with no `poseRev` (the
// spawn path, the relay of a neighbour node, an older engine) is a baseline: it applies and takes the revision back
// to 0, so a revision that restarted (a login after a crash) is never shut out. All go through applyPoseUpdate.

export const POSE_DATAGRAM_HEADER = 0x05;
const POSE_DATAGRAM_HEADER_BYTES = 3;
const POSE_RECORD_FIXED_BYTES = 9;

/** One pose of a datagram: the player's id (as the stream names it), the revision and the animation state. */
export type PoseDatagramEntry = [id: string, revision: number, state: string];

const stateDecoder = new TextDecoder();

/** The poses of a datagram; none for anything that is not a whole, well-formed one (never throws). */
export function decodePoseDatagram(bytes: Uint8Array): PoseDatagramEntry[] {
  const entries: PoseDatagramEntry[] = [];
  if (!bytes || bytes.length < POSE_DATAGRAM_HEADER_BYTES || bytes[0] !== POSE_DATAGRAM_HEADER) return entries;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(1, true);
  let at = POSE_DATAGRAM_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (at + POSE_RECORD_FIXED_BYTES > bytes.length) break;
    const n = bytes[at + 8];
    if (at + POSE_RECORD_FIXED_BYTES + n > bytes.length) break;
    entries.push([
      String(view.getUint32(at, true)),
      view.getUint32(at + 4, true),
      stateDecoder.decode(bytes.subarray(at + POSE_RECORD_FIXED_BYTES, at + POSE_RECORD_FIXED_BYTES + n)),
    ]);
    at += POSE_RECORD_FIXED_BYTES + n;
  }
  return entries;
}

let poseCount = 0;

/** The player to pose: a drawn one, else one still waiting for its sheets. */
export function findPosePlayer(players: Iterable<any> | null | undefined, pending: Map<any, any> | null | undefined, id: any): any | null {
  if (players) {
    for (const p of players) {
      if (p && p.id === id) return p;
    }
  }
  return (pending && pending.get(id)) || null;
}

/**
 * Switches the player's animation to `animationState` on the sheets it holds. Never throws. The pose is noted on the
 * player (poseMark) so a full SPRITE_SHEET_ANIMATION still being built for them does not overwrite it afterwards
 * (reapplyPose). The state is read as the full packet reads it: with no direction, the player's last one.
 */
export async function applyPose(
  player: any,
  animationState: unknown,
  changeLayeredAnimation: (animation: any, name: string) => Promise<void>
): Promise<void> {
  try {
    if (!player || typeof animationState !== "string" || animationState.length === 0) return;
    let state = animationState;
    if (state.includes("_")) {
      player.lastDirection = state.split("_")[1];
    } else {
      state = `${state}_${player.lastDirection}`;
    }
    player._poseState = state;
    player._poseMark = ++poseCount;
    const animation = player.layeredAnimation;
    if (!animation) return;
    player.animation = null;
    if (animation.currentAnimationName !== state) await changeLayeredAnimation(animation, state);
  } catch (error) {
    console.error("Error applying pose:", error);
  }
}

/**
 * Applies a pose to the player `id`, if this client knows them (drawn, or waiting for their sheets); false when it
 * does not or when the pose is not newer. The one place a pose is applied: the SPRITE_SHEET_POSE stream packet and the
 * pose datagram (the revision of its entry) both come here, so animation, mounts, casting and the worn items' look
 * behave alike. With a revision the pose is applied only if it is newer than the one the player shows (a datagram),
 * or at least as new (`reliable`: the stream copy of the same pose), and the revision is recorded before anything is
 * awaited, so two datagrams handled one after the other cannot swap. Without a revision the pose is a baseline: it is
 * applied and the player's revision goes back to 0.
 */
export async function applyPoseUpdate(
  players: Iterable<any> | null | undefined,
  pending: Map<any, any> | null | undefined,
  id: any,
  animationState: unknown,
  changeLayeredAnimation: (animation: any, name: string) => Promise<void>,
  revision?: number,
  reliable = false
): Promise<boolean> {
  const target = findPosePlayer(players, pending, id);
  if (!target) return false;
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    target._poseRev = 0;
  } else {
    const shown = target._poseRev || 0;
    if (reliable ? revision < shown : revision <= shown) return false;
    target._poseRev = revision;
  }
  await applyPose(target, animationState, changeLayeredAnimation);
  return true;
}

/**
 * The poses of a datagram, applied in order. Their revisions are taken at once; the animations change in the
 * background, so a movement datagram behind this one is not held up by the sheets a pose has to rebuild.
 */
export function applyPoseDatagram(
  bytes: Uint8Array,
  players: Iterable<any> | null | undefined,
  pending: Map<any, any> | null | undefined,
  changeLayeredAnimation: (animation: any, name: string) => Promise<void>
): Promise<boolean[]> {
  const applied: Promise<boolean>[] = [];
  for (const [id, revision, state] of decodePoseDatagram(bytes)) {
    applied.push(applyPoseUpdate(players, pending, id, state, changeLayeredAnimation, revision).catch(() => false));
  }
  return Promise.all(applied);
}

/**
 * Taken before a full sheet packet starts building the player's animation. `sheetRevision` is the sheet's `poseRev`:
 * a sheet without one (the spawn path, the relay, an older engine) is a baseline and takes the shown revision back to 0;
 * one with it is compared by sheetPoseState.
 */
export function poseMark(player: any, sheetRevision?: unknown): number {
  if (player && !(typeof sheetRevision === "number" && Number.isFinite(sheetRevision))) player._poseRev = 0;
  return player?._poseMark || 0;
}

/**
 * The pose state a full sheet shows. A sheet with a `poseRev` older than the revision the player shows is late: a pose
 * datagram of a later change got here first, so the pose shown stays (the sheets, the look, are applied from the
 * sheet all the same). Otherwise the sheet's own state is shown and its revision is recorded. A sheet without a
 * `poseRev` shows its own state (poseMark has taken the baseline back to 0).
 */
export function sheetPoseState(player: any, sheetRevision: unknown, animationState: string): string {
  if (!player || typeof sheetRevision !== "number" || !Number.isFinite(sheetRevision)) return animationState;
  const shown = player._poseRev || 0;
  if (sheetRevision < shown && typeof player._poseState === "string" && player._poseState.length > 0) return player._poseState;
  player._poseRev = Math.max(shown, sheetRevision);
  return animationState;
}

/** After a full sheet packet built the player's animation: a pose that arrived meanwhile is newer than its state. */
export async function reapplyPose(
  player: any,
  mark: number,
  changeLayeredAnimation: (animation: any, name: string) => Promise<void>
): Promise<void> {
  try {
    if (!player || (player._poseMark || 0) === mark || typeof player._poseState !== "string") return;
    const animation = player.layeredAnimation;
    if (animation && animation.currentAnimationName !== player._poseState) {
      await changeLayeredAnimation(animation, player._poseState);
    }
  } catch (error) {
    console.error("Error applying pose:", error);
  }
}
