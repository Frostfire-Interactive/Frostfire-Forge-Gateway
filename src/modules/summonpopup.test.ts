import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUMMON_PROMPT_ANSWER_MS, summonPromptReply, summonTargetOf, summonTouch } from "../webserver/public/js/core/summonreplies";

describe("summon replies", () => {
  test("a touch sends the stone and the party member targeted", () => {
    expect(summonTouch("S", "cat")).toEqual({ type: "SUMMON_STONE_TOUCH", data: { name: "S", target: "cat" } });
    expect(summonTouch("S", null)).toEqual({ type: "SUMMON_STONE_TOUCH", data: { name: "S" } });
  });

  test("the target is the party frame clicked, else the player targeted in the world", () => {
    const players = [{ username: "Dog", targeted: false }, { username: "Cat", targeted: true }];
    expect(summonTargetOf("owl", players)).toBe("owl");
    expect(summonTargetOf(null, players)).toBe("cat");
    expect(summonTargetOf(null, [{ username: "Dog", targeted: false }])).toBeNull();
  });

  test("the prompt answers as a SUMMON_STONE invitation", () => {
    expect(summonPromptReply({ authorization: "a1", originator: "o1" }, true).data).toEqual({ authorization: "a1", originator: "o1", action: "SUMMON_STONE", response: "ACCEPT" });
    expect(summonPromptReply({ authorization: "a1", originator: "o1" }, false).data.response).toBe("DECLINE");
  });

  test("an unanswered prompt is declined 1 s before the server drops it", () => {
    expect(SUMMON_PROMPT_ANSWER_MS).toBe(59_000);
  });

  // The engine's file is read when the two repos sit side by side.
  const enginePath = resolve(import.meta.dir, "../../../Frostfire-Forge/src/systems/summonsession.ts");
  test.skipIf(!existsSync(enginePath))("the decline is 1 s inside the engine's PROMPT_MS", () => {
    const m = /export const PROMPT_MS = ([\d_]+);/.exec(readFileSync(enginePath, "utf8"));
    expect(m).not.toBeNull();
    expect(SUMMON_PROMPT_ANSWER_MS).toBe(Number(m![1]!.replace(/_/g, "")) - 1_000);
  });
});
