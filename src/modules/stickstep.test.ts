import { expect, test } from "bun:test";
import { doneSend, doneFacing, walkAtSwitch, RESUME_ECHO_MS } from "../webserver/public/js/core/resumesend";
import { heldDirection } from "../webserver/public/js/core/handoffwalk";

// What the client sent at HANDOFF_DONE before the walk was known to be resumed (socket.ts): a stick at once, a key let go
// in the gap as ABORT if a walk was under way at the SWITCH, a held key left to the renderer's next frame.
function before(keyPressed: boolean, stick: string, walkedAtSwitch: boolean) {
  if (!keyPressed && stick) return { send: stick, lastSent: stick, keyResumed: null };
  if (walkedAtSwitch && !keyPressed) return { send: "ABORT", lastSent: null, keyResumed: null };
  return { send: null, lastSent: null, keyResumed: null };
}

const NONE = { send: null, lastSent: null, keyResumed: null };

test("doneSend: a stick held the way the node resumed sends nothing and counts as sent", () => {
  const s = doneSend({ atSwitch: "right", keyPressed: false, keyDirection: "", stick: "RIGHT", facing: "right", walkedAtSwitch: false });
  expect(s).toEqual({ send: null, lastSent: "RIGHT", keyResumed: null });
  const diagonal = doneSend({ atSwitch: "downleft", keyPressed: false, keyDirection: "", stick: "DOWNLEFT", facing: "downleft", walkedAtSwitch: true });
  expect(diagonal).toEqual({ send: null, lastSent: "DOWNLEFT", keyResumed: null });
});

test("doneSend: a key held the way the node resumed is told to the renderer as sent (upper case), nothing is sent", () => {
  const s = doneSend({ atSwitch: "left", keyPressed: true, keyDirection: "left", stick: "", facing: "left", walkedAtSwitch: true });
  expect(s).toEqual({ send: null, lastSent: null, keyResumed: "LEFT" });
  // A stick held with the key: the key wins, as in the renderer.
  expect(doneSend({ atSwitch: "up", keyPressed: true, keyDirection: "up", stick: "DOWN", facing: "up", walkedAtSwitch: true }).keyResumed).toBe("UP");
});

test("doneSend: a different direction, a stood player, an unsent direction and a let-go key or stick send what was sent before", () => {
  // A stick pushed another way in the gap.
  expect(doneSend({ atSwitch: "right", keyPressed: false, keyDirection: "", stick: "LEFT", facing: "right", walkedAtSwitch: true }))
    .toEqual({ send: "LEFT", lastSent: "LEFT", keyResumed: null });
  // A key pressed another way in the gap: the renderer sends it (nothing marked as sent).
  expect(doneSend({ atSwitch: "right", keyPressed: true, keyDirection: "up", stick: "", facing: "right", walkedAtSwitch: true })).toEqual(NONE);
  // Stood at the SWITCH (no walk known), a stick or key pressed in the gap.
  expect(doneSend({ atSwitch: "", keyPressed: false, keyDirection: "", stick: "RIGHT", facing: "right", walkedAtSwitch: false }))
    .toEqual({ send: "RIGHT", lastSent: "RIGHT", keyResumed: null });
  expect(doneSend({ atSwitch: "", keyPressed: true, keyDirection: "right", stick: "", facing: "right", walkedAtSwitch: false })).toEqual(NONE);
  // The node faces another way than the player held at the SWITCH (a held direction not yet sent, or a cast): not known.
  expect(doneSend({ atSwitch: "right", keyPressed: false, keyDirection: "", stick: "RIGHT", facing: "up", walkedAtSwitch: true }).send).toBe("RIGHT");
  expect(doneSend({ atSwitch: "right", keyPressed: true, keyDirection: "right", stick: "", facing: "down", walkedAtSwitch: true }).keyResumed).toBeNull();
  // No facing in the packet.
  expect(doneSend({ atSwitch: "right", keyPressed: false, keyDirection: "", stick: "RIGHT", facing: "", walkedAtSwitch: true }).send).toBe("RIGHT");
  // A key let go in the gap after a walk: the node is told; after standing, nothing.
  expect(doneSend({ atSwitch: "right", keyPressed: false, keyDirection: "", stick: "", facing: "right", walkedAtSwitch: true })).toEqual({ send: "ABORT", lastSent: null, keyResumed: null });
  expect(doneSend({ atSwitch: "", keyPressed: false, keyDirection: "", stick: "", facing: "right", walkedAtSwitch: false })).toEqual(NONE);
});

test("doneSend: where no walk is known it is exactly what the client sent before, for every key, stick and walk state", () => {
  const sticks = ["", "RIGHT", "LEFT", "UP", "DOWN", "UPLEFT", "DOWNRIGHT"];
  const keys = ["", "right", "left", "up", "downleft"];
  const facings = ["", "right", "left", "up", "down", "downleft", "x"];
  let cases = 0;
  for (const keyPressed of [false, true]) for (const stick of sticks) for (const walkedAtSwitch of [false, true]) for (const keyDirection of keys) for (const facing of facings) {
    const got = doneSend({ atSwitch: "", keyPressed, keyDirection, stick, facing, walkedAtSwitch });
    expect(got).toEqual(before(keyPressed, stick, walkedAtSwitch));
    cases++;
  }
  expect(cases).toBe(2 * 7 * 2 * 5 * 7);
});

test("doneSend: after a skip the last sent direction is the direction the node walks, for the next real change", () => {
  // The renderer sends a key when it differs from what it holds as sent, and aborts a released key when it holds one;
  // input.ts does the same for the stick. Marked as sent, a held direction is not sent again, a change and a release are.
  const rendererSends = (held: string, lastSent: string) => (held && held !== lastSent ? held : held === "" && lastSent !== "" ? "ABORT" : null);
  const skip = doneSend({ atSwitch: "right", keyPressed: true, keyDirection: "right", stick: "", facing: "right", walkedAtSwitch: true });
  expect(skip.keyResumed).toBe("RIGHT");
  expect(rendererSends("RIGHT", skip.keyResumed!)).toBeNull();
  expect(rendererSends("UP", skip.keyResumed!)).toBe("UP");
  expect(rendererSends("", skip.keyResumed!)).toBe("ABORT");
  const stick = doneSend({ atSwitch: "left", keyPressed: false, keyDirection: "", stick: "LEFT", facing: "left", walkedAtSwitch: true });
  expect(stick.lastSent).toBe("LEFT");
  expect(rendererSends("LEFT", stick.lastSent!)).toBeNull();
  expect(rendererSends("UPLEFT", stick.lastSent!)).toBe("UPLEFT");
  expect(rendererSends("", stick.lastSent!)).toBe("ABORT");
});

test("walkAtSwitch: the held direction counts only when the node moved the player a moment ago", () => {
  const keys = (...codes: string[]) => new Set(codes);
  const now = 10_000;
  expect(walkAtSwitch(keys("KeyD"), "", now - 16, now)).toBe("right");
  expect(walkAtSwitch(keys("KeyW", "KeyA"), "", now - RESUME_ECHO_MS, now)).toBe("upleft");
  expect(walkAtSwitch(keys(), "DOWNLEFT", now - 30, now)).toBe("downleft");
  // Keys win over the stick, as in the renderer.
  expect(walkAtSwitch(keys("KeyD"), "LEFT", now - 30, now)).toBe("right");
  // No echo lately: stood (or just pressed), no walk is known.
  expect(walkAtSwitch(keys("KeyD"), "", now - RESUME_ECHO_MS - 1, now)).toBe("");
  expect(walkAtSwitch(keys("KeyD"), "", null, now)).toBe("");
  expect(walkAtSwitch(keys("KeyD"), "", undefined, now)).toBe("");
  expect(walkAtSwitch(keys("KeyD"), "", 0, now)).toBe("");
  expect(walkAtSwitch(keys("KeyD"), "", now + 5, now)).toBe("");
  // Nothing held.
  expect(walkAtSwitch(keys(), "", now - 16, now)).toBe("");
  expect(heldDirection(keys("KeyD"))).toBe("right");
});

test("doneFacing: one of the eight directions, lower case, else none", () => {
  expect(doneFacing("Right")).toBe("right");
  expect(doneFacing("UPLEFT")).toBe("upleft");
  expect(doneFacing("")).toBe("");
  expect(doneFacing("abort")).toBe("");
  expect(doneFacing(undefined)).toBe("");
  expect(doneFacing(3)).toBe("");
});

test("socket.ts: HANDOFF_DONE sends what doneSend says and marks a skipped direction as sent; the SWITCH records the known walk", async () => {
  const text = async (name: string) => (await Bun.file(new URL(`../webserver/public/js/core/${name}`, import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const src = await text("socket.ts");
  expect(src).toContain("walkDirectionAtSwitch = walkAtSwitch(pressedKeys, getStickDirection(), own?.lastServerUpdate, performance.now());");
  expect(src).toContain("const send = doneSend({");
  expect(src).toContain("facing: doneFacing(data?.direction),");
  expect(src).toContain("if (send.send !== null) sendRequest({ type: \"MOVEXY\", data: send.send });");
  expect(src).toContain("if (send.lastSent !== null) setLastSentDirection(send.lastSent);");
  expect(src).toContain("if (send.keyResumed !== null) setDirection(send.keyResumed);");
  // The key path is the renderer's, unchanged: it sends a held key that differs from what it holds as sent, and aborts a
  // released one while it holds one, so the direction set at DONE is the base for the next change.
  const renderer = await text("renderer.ts");
  expect(renderer).toContain("if (dir && dir !== lastDirection) {");
  expect(renderer).toContain("if (lastDirection !== \"\") sendRequest({ type: \"MOVEXY\", data: \"ABORT\" });");
});
