import { expect, test } from "bun:test";
import { doneSend, doneWalk } from "../webserver/public/js/core/resumesend";

// HANDOFF_DONE names the walk: the direction the new node walks the player in, or null. doneSend decides from it exactly;
// without it (an older engine) the facing rule stays (stickstep.test.ts).

const NONE = { send: null, lastSent: null, keyResumed: null };
const key = (keyDirection: string) => ({ keyPressed: true, keyDirection, stick: "" });
const stick = (s: string) => ({ keyPressed: false, keyDirection: "", stick: s });
const nothing = { keyPressed: false, keyDirection: "", stick: "" };
// What the SWITCH and the facing say is of no matter once the walk is named: every combination must give the same answer.
const around = [
  { atSwitch: "", facing: "", walkedAtSwitch: false },
  { atSwitch: "right", facing: "right", walkedAtSwitch: true },
  { atSwitch: "up", facing: "left", walkedAtSwitch: true },
  { atSwitch: "", facing: "down", walkedAtSwitch: true },
  { atSwitch: "left", facing: "", walkedAtSwitch: false },
];
const decide = (input: { keyPressed: boolean; keyDirection: string; stick: string }, walk: string | null) =>
  around.map((a) => doneSend({ ...a, ...input, walk }));
const allEqual = (results: unknown[]) => results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]));

test("walk equal to the held direction: nothing is sent, and the direction counts as sent", () => {
  const k = decide(key("right"), "right");
  expect(allEqual(k)).toBe(true);
  expect(k[0]).toEqual({ send: null, lastSent: null, keyResumed: "RIGHT" });
  const s = decide(stick("DOWNLEFT"), "downleft");
  expect(allEqual(s)).toBe(true);
  expect(s[0]).toEqual({ send: null, lastSent: "DOWNLEFT", keyResumed: null });
  // Case does not matter on either side.
  expect(doneSend({ ...around[0], ...key("Right"), walk: "right" }).keyResumed).toBe("RIGHT");
  expect(doneSend({ ...around[0], ...stick("RIGHT"), walk: "right" }).send).toBeNull();
});

test("walk null while a direction is held: it is sent (a stick at once, a key by the renderer's next frame)", () => {
  const s = decide(stick("RIGHT"), null);
  expect(allEqual(s)).toBe(true);
  expect(s[0]).toEqual({ send: "RIGHT", lastSent: "RIGHT", keyResumed: null });
  const k = decide(key("right"), null);
  expect(allEqual(k)).toBe(true);
  expect(k[0]).toEqual(NONE);
});

test("walk another direction than the held one: it is sent", () => {
  const s = decide(stick("LEFT"), "right");
  expect(allEqual(s)).toBe(true);
  expect(s[0]).toEqual({ send: "LEFT", lastSent: "LEFT", keyResumed: null });
  const k = decide(key("up"), "upleft");
  expect(allEqual(k)).toBe(true);
  expect(k[0]).toEqual(NONE);
});

test("nothing held: no direction is sent; a walk the node has is stopped, none is left alone", () => {
  const stopped = decide(nothing, null);
  expect(allEqual(stopped)).toBe(true);
  expect(stopped[0]).toEqual(NONE);
  const walked = decide(nothing, "right");
  expect(allEqual(walked)).toBe(true);
  expect(walked[0]).toEqual({ send: "ABORT", lastSent: null, keyResumed: null });
});

test("walk absent: the facing rule of before decides (an older engine)", () => {
  // Same as stickstep.test.ts: held the way the node resumed and faces, nothing is sent.
  expect(doneSend({ atSwitch: "right", ...stick("RIGHT"), facing: "right", walkedAtSwitch: true })).toEqual({ send: null, lastSent: "RIGHT", keyResumed: null });
  expect(doneSend({ atSwitch: "left", ...key("left"), facing: "left", walkedAtSwitch: true })).toEqual({ send: null, lastSent: null, keyResumed: "LEFT" });
  // Facing differs: sent. Explicit undefined is absent.
  expect(doneSend({ atSwitch: "right", ...stick("RIGHT"), facing: "up", walkedAtSwitch: true }).send).toBe("RIGHT");
  expect(doneSend({ atSwitch: "right", ...stick("RIGHT"), facing: "right", walkedAtSwitch: true, walk: undefined }).send).toBeNull();
  expect(doneSend({ atSwitch: "right", ...nothing, facing: "right", walkedAtSwitch: true }).send).toBe("ABORT");
  expect(doneSend({ atSwitch: "", ...nothing, facing: "right", walkedAtSwitch: false })).toEqual(NONE);
});

test("the cast case: facing X, walk Y, held X is sent (the facing rule alone would skip it)", () => {
  // Cast toward the right, walking up; the player holds right (the key pressed again just before the SWITCH, lost in the drain).
  const held = { atSwitch: "right", facing: "right", walkedAtSwitch: true };
  expect(doneSend({ ...held, ...stick("RIGHT") }).send).toBeNull();
  expect(doneSend({ ...held, ...stick("RIGHT"), walk: "up" })).toEqual({ send: "RIGHT", lastSent: "RIGHT", keyResumed: null });
  expect(doneSend({ ...held, ...key("right") }).keyResumed).toBe("RIGHT");
  expect(doneSend({ ...held, ...key("right"), walk: "up" })).toEqual(NONE);
  // The player stopped and pressed the key again just before the SWITCH, the node stands them: walk null, held X.
  expect(doneSend({ ...held, ...stick("RIGHT"), walk: null }).send).toBe("RIGHT");
});

test("doneWalk: a direction in lower case, null for none, undefined when the packet does not say", () => {
  expect(doneWalk("Right")).toBe("right");
  expect(doneWalk("downleft")).toBe("downleft");
  expect(doneWalk(null)).toBeNull();
  expect(doneWalk(undefined)).toBeUndefined();
  expect(doneWalk("abort")).toBeUndefined();
  expect(doneWalk("")).toBeUndefined();
  expect(doneWalk(3)).toBeUndefined();
});

test("socket.ts: HANDOFF_DONE gives doneSend the walk the packet names", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const from = src.indexOf("const send = doneSend({");
  const call = src.slice(from, src.indexOf("});", from));
  expect(call).toContain("walk: doneWalk(data?.walk),");
  expect(src).toContain('import { doneFacing, doneSend, doneWalk, walkAtSwitch } from "./resumesend.ts";');
});

// W-M2: the held direction and the named walk are compared in lower case on both sides.
test("walk named in capitals: the held direction is still recognised as already walked", () => {
  expect(doneSend({ ...around[0], ...stick("RIGHT"), walk: "RIGHT" }).send).toBeNull();
  expect(doneSend({ ...around[0], ...key("right"), walk: "RIGHT" }).keyResumed).toBe("RIGHT");
});
