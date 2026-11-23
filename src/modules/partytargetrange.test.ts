import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFarPartyTarget, inPartyOf, selectedPlayerOf, setFarPartyTarget, setFarPartyTargetAnim, setPartyTarget, updateFarPartyTargetStats } from "../webserver/public/js/core/partytarget";

describe("a party member stays targetable at any distance", () => {
  test("a member of the player's party, in any case", () => {
    const self = { username: "ann", party: ["Ann", "Bob"] };
    expect(inPartyOf(self, "bob")).toBe(true);
    expect(inPartyOf(self, "BOB")).toBe(true);
  });

  test("anyone else, or no party, is not", () => {
    expect(inPartyOf({ party: ["ann", "bob"] }, "cat")).toBe(false);
    expect(inPartyOf({ party: null }, "bob")).toBe(false);
    expect(inPartyOf({}, "bob")).toBe(false);
    expect(inPartyOf({ party: ["ann"] }, undefined)).toBe(false);
  });
});

describe("the server's player selection", () => {
  test("a selection names the player picked", () => {
    expect(selectedPlayerOf({ id: "p2", username: "bob", stats: {} })).toBe("p2");
  });

  test("a clear (the selector's own id with data null) selects no one", () => {
    expect(selectedPlayerOf({ id: "me", data: null })).toBeNull();
    expect(selectedPlayerOf(null)).toBeNull();
    expect(selectedPlayerOf({})).toBeNull();
  });
});

describe("a party member targeted who is not loaded nearby", () => {
  // The party frames' highlight reads the page: no frames here, whatever another test left as `document`.
  const g = globalThis as any;
  let was: unknown;
  beforeEach(() => { was = g.document; g.document = { querySelectorAll: () => [] }; });
  afterEach(() => { setPartyTarget(null); g.document = was; });

  test("is shown while they are the party target, with their stats kept up to date", () => {
    setPartyTarget("ann");
    setFarPartyTarget({ id: "a", username: "Ann", stats: { health: 50, total_max_health: 100 } });
    expect(getFarPartyTarget()?.id).toBe("a");
    updateFarPartyTargetStats("ANN", 70, 100, 20, 40);
    expect(getFarPartyTarget()?.stats).toMatchObject({ health: 70, total_max_health: 100, stamina: 20, total_max_stamina: 40 });
  });

  test("goes when the party target changes or is cleared", () => {
    setPartyTarget("ann");
    setFarPartyTarget({ id: "a", username: "ann", stats: {} });
    setPartyTarget("bob");
    expect(getFarPartyTarget()).toBeNull();
    setPartyTarget(null);
    expect(getFarPartyTarget()).toBeNull();
  });

  test("gets the portrait's animation built for them, not one built for an earlier target", () => {
    const anim = { layers: {} };
    setPartyTarget("ann");
    setFarPartyTarget({ id: "a", username: "ann", stats: {} });
    setFarPartyTargetAnim("b", { layers: { other: true } });
    expect((getFarPartyTarget() as any)?.layeredAnimation).toBeUndefined();
    setFarPartyTargetAnim("a", anim);
    expect((getFarPartyTarget() as any)?.layeredAnimation).toBe(anim);
  });
});
