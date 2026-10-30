// The local player's pose in a handoff gap. The client walks the player on from HANDOFF_BEGIN until the new node has
// them (renderer.ts), but the pose came only from the nodes: a key let go in the gap walked the player on the spot, and
// a turn kept the old facing, until the new node's pose came after HANDOFF_DONE. The new node walks the gap as
// reported and poses the player as it ends: walking in the direction held, else standing facing the last walk. The
// client poses them so as it walks them, and the new node's same pose changes nothing.

const DIRECTIONS = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"];

/** "walk_right" as its direction, for a walk or a stand in one of the eight directions; null for any other pose. */
function plainPose(name: unknown): { action: string; direction: string } | null {
  if (typeof name !== "string") return null;
  const at = name.indexOf("_");
  const action = name.slice(0, at);
  const direction = name.slice(at + 1);
  if (action !== "walk" && action !== "idle") return null;
  return DIRECTIONS.includes(direction) ? { action, direction } : null;
}

/**
 * The pose the gap walk shows with `held` held (gapDirection, "" for none), null to leave `current` as it is: a held
 * key walks that way, none stands the player facing the way they walked. A pose that is not a walk or a stand (a cast)
 * is the node's.
 */
export function gapPose(current: unknown, held: string): string | null {
  const shown = plainPose(current);
  if (!shown) return null;
  if (held && !DIRECTIONS.includes(held)) return null;
  const pose = held ? `walk_${held}` : `idle_${shown.direction}`;
  return pose === current ? null : pose;
}

/**
 * The pose to show for a node's `incoming` one in the gap: a walk or a stand is of a gap report older than the keys held
 * (the new node poses the newest again once it walked it), so the one the client shows stays. Any other is shown.
 */
export function keepGapPose(current: unknown, incoming: string): string {
  return plainPose(current) && plainPose(incoming) ? (current as string) : incoming;
}
