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

export function poseMark(player: any, sheetRevision?: unknown): number {
  if (player && !(typeof sheetRevision === "number" && Number.isFinite(sheetRevision))) player._poseRev = 0;
  return player?._poseMark || 0;
}

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
