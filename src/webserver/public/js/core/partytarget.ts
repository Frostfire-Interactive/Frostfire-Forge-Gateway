// The party member targeted by a click on their party frame (or targeted in the world): their frame is highlighted, and
// a summoning stone touched summons them. Kept by username, so it holds while they are on another map.

let target: string | null = null;

/** Whether this name is in the player's party (any case). */
export function inPartyOf(self: any, username: unknown): boolean {
  const name = String(username ?? "").toLowerCase();
  return !!name && Array.isArray(self?.party) && self.party.some((m: unknown) => String(m).toLowerCase() === name);
}

/** The player a SELECTPLAYER packet selects, or null when it clears the selection: the server's clear is
 *  `{ id: <the selector's own id>, data: null }`, not a selection of the selector. */
export function selectedPlayerOf(data: any): string | null {
  if (!data || !data.id || data.data === null) return null;
  return String(data.id);
}

/** The party target picked on another map or out of sight: not among the loaded players, so the target frame shows it
 *  from what the server sent, while they stay the party target. */
type FarTarget = { id: string; username: string; stats: Record<string, unknown>; layeredAnimation?: unknown };
let far: FarTarget | null = null;

export function setFarPartyTarget(selected: { id: unknown; username: unknown; stats?: unknown } | null): void {
  far = selected ? { id: String(selected.id), username: String(selected.username ?? "").toLowerCase(), stats: { ...((selected.stats as any) ?? {}) } } : null;
}

/** Their sprites, built for the target frame's portrait: kept only while they are still the far target. */
export function setFarPartyTargetAnim(id: unknown, anim: unknown): void {
  if (far && far.id === String(id)) far.layeredAnimation = anim;
}

export function getFarPartyTarget(): FarTarget | null {
  return far && target === far.username ? far : null;
}

/** A party member's health and stamina changed: the far target's frame follows. */
export function updateFarPartyTargetStats(username: string, health: number, maxHealth: number, stamina: number, maxStamina: number): void {
  if (!far || far.username !== String(username).toLowerCase()) return;
  Object.assign(far.stats, { health, total_max_health: maxHealth, stamina, total_max_stamina: maxStamina });
}

export function getPartyTarget(): string | null {
  return target;
}

export function setPartyTarget(username: string | null): void {
  target = username ? username.toLowerCase() : null;
  showPartyTarget();
}

/** The highlight on the targeted member's frame; the party UI calls it again after it rebuilds the frames. */
export function showPartyTarget(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLElement>(".party-member").forEach((el) => {
    el.classList.toggle("targeted", target !== null && el.dataset.username === target);
  });
}

/** The party changed: a target who left it is dropped. */
export function keepPartyTarget(members: string[]): void {
  if (target !== null && !members.some((m) => String(m).toLowerCase() === target)) target = null;
  showPartyTarget();
}
