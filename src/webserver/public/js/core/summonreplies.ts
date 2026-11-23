// What the client sends for a summoning stone (invites.ts shows the popups). No DOM here, so the tests can run it.

/** The server keeps a summon prompt open for a minute (PROMPT_MS there); unanswered, the popup declines 1 s before that. */
export const SUMMON_PROMPT_ANSWER_MS = 60_000 - 1_000;

/** A touch of a stone, with the party member to summon: the server starts the summoner's 30 s wait for a helper. */
export function summonTouch(stone: string, target: string | null): { type: "SUMMON_STONE_TOUCH"; data: { name: string; target?: string } } {
  return { type: "SUMMON_STONE_TOUCH", data: target ? { name: stone, target } : { name: stone } };
}

/** Who a touch summons: the party member whose frame was clicked, else the player targeted in the world. */
export function summonTargetOf(partyTarget: string | null, players: Iterable<{ username?: unknown; targeted?: boolean }>): string | null {
  if (partyTarget) return partyTarget;
  for (const p of players) if (p?.targeted && p.username) return String(p.username).toLowerCase();
  return null;
}

/** The answer to the summon prompt, as the other invitations are answered. */
export function summonPromptReply(inv: { authorization: string; originator: string }, accept: boolean): {
  type: "INVITATION_RESPONSE";
  data: { authorization: string; originator: string; action: "SUMMON_STONE"; response: "ACCEPT" | "DECLINE" };
} {
  return {
    type: "INVITATION_RESPONSE",
    data: { authorization: inv.authorization, originator: inv.originator, action: "SUMMON_STONE", response: accept ? "ACCEPT" : "DECLINE" },
  };
}
