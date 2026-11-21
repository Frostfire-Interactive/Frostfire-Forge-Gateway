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

export function gapPose(current: unknown, held: string): string | null {
  const shown = plainPose(current);
  if (!shown) return null;
  if (held && !DIRECTIONS.includes(held)) return null;
  const pose = held ? `walk_${held}` : `idle_${shown.direction}`;
  return pose === current ? null : pose;
}

export function keepGapPose(current: unknown, incoming: string): string {
  return plainPose(current) && plainPose(incoming) ? (current as string) : incoming;
}
