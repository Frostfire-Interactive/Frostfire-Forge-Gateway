import { expect, test } from "bun:test";
import { GapLog, MAX_GAP_SEGMENTS, HANDOFF_CATCH_UP_MAX_MS, gapStepMs, beginPoint } from "../webserver/public/js/core/handoffwalk";

// The gap report a resumed handoff sends with AUTH (socket.ts sendLogin): what the client walked from the old node's
// last echo on, which the new node walks the same way before HANDOFF_DONE (the engine's arrival.ts gapPlanOf).

test("a walk held through the gap reports no ended stretch: the node goes on in the direction held", () => {
  const log = new GapLog();
  expect(log.started).toBe(false);
  expect(log.report()).toBeNull();
  log.frame("right", 40, 1000, 960);
  expect(log.started).toBe(true);
  for (let now = 1016; now <= 1160; now += 16) log.frame("right", 16, now, 960);
  expect(log.report()).toEqual({ segments: [], held: "right" });
});

test("a key let go in the gap reports the walk up to it; the stand after it goes on at the node", () => {
  const log = new GapLog();
  log.frame("right", 40, 1000, 960);
  log.frame("right", 16, 1016, 960);
  log.frame("right", 16, 1032, 960);
  log.frame("right", 16, 1048, 960);
  log.frame("", 0, 1064, 960);
  log.frame("", 0, 1080, 960);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 88 }], held: "" });
});

test("a turn reports the walk before it; the new direction goes on", () => {
  const log = new GapLog();
  log.frame("right", 40, 1000, 960);
  log.frame("right", 16, 1016, 960);
  log.frame("down", 16, 1032, 960);
  log.frame("down", 16, 1048, 960);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 56 }], held: "down" });
});

test("a key let go and pressed again reports the stand between, counted from the last echo", () => {
  const log = new GapLog();
  // Let go before the first frame: the time since the echo was stood.
  log.frame("", 0, 1000, 960);
  log.frame("", 0, 1016, 960);
  log.frame("right", 16, 1032, 960);
  log.frame("right", 16, 1048, 960);
  expect(log.report()).toEqual({ segments: [{ walk: "", ms: 56 }], held: "right" });
});

test("frames the gap walk skipped (the chat focused) count as stood", () => {
  const log = new GapLog();
  log.frame("right", 16, 1016, 1000);
  log.frame("right", 16, 1100, 1000);
  log.frame("", 0, 1116, 1000);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 16 }, { walk: "", ms: 68 }, { walk: "right", ms: 16 }], held: "" });
});

test("the first frame counts from the echo, no further back than the node makes up; without one from its own walk", () => {
  const old = new GapLog();
  old.frame("", 0, 2000, 900);
  old.frame("up", 16, 2016, 900);
  expect(old.report()).toEqual({ segments: [{ walk: "", ms: HANDOFF_CATCH_UP_MAX_MS }], held: "up" });
  const none = new GapLog();
  none.frame("left", 16, 2000, null);
  none.frame("", 0, 2016, null);
  expect(none.report()).toEqual({ segments: [{ walk: "left", ms: 16 }], held: "" });
});

test("a first step walked longer than the frame took moves the end on, so the next frame adds only its own walk", () => {
  const log = new GapLog();
  log.frame("right", 60, 1000, 980);
  log.frame("right", 16, 1016, 980);
  log.frame("", 0, 1100, 980);
  // 60 + 16 walked; the stand runs from where that ended (1056) to 1100.
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 76 }], held: "" });
});

test("stretches are rounded on the running total, so their sum is the gap's length to the ms", () => {
  const log = new GapLog();
  log.frame("right", 10.4, 1010.4, 1000);
  log.frame("", 0, 1020.8, 1000);
  log.frame("right", 10.4, 1031.2, 1000);
  log.frame("down", 10.4, 1041.6, 1000);
  const report = log.report()!;
  expect(report.segments).toEqual([{ walk: "right", ms: 10 }, { walk: "", ms: 11 }, { walk: "right", ms: 10 }]);
  expect(report.held).toBe("down");
});

test("a gap with more stretches than the node reads is not reported", () => {
  const log = new GapLog();
  let now = 1000;
  for (let i = 0; i < MAX_GAP_SEGMENTS; i++) log.frame(i % 2 ? "right" : "left", 16, (now += 16), 1000);
  expect(log.report()).not.toBeNull();
  log.frame("up", 16, (now += 16), 1000);
  expect(log.report()).toBeNull();
  log.reset();
  expect(log.started).toBe(false);
  log.frame("up", 16, 2016, 2000);
  expect(log.report()).toEqual({ segments: [], held: "up" });
});

test("with the gap reported, the first step walks the time since the echo in a turned direction too, and a later press its frame", () => {
  // The renderer's walkedOn where the node walks the report: any direction held.
  expect(gapStepMs(16, false, 1040, { t: 1000 }, 0, true)).toBe(40);
  // After a frame stood (GapLog.started), a press walks its own frame, not the time stood.
  expect(gapStepMs(16, true, 1100, { t: 1000 }, 0, true)).toBe(16);
});

test("a change of key after AUTH's report is sent as a HANDOFF_GAP with the whole gap so far, numbered on", () => {
  // The renderer notes every frame; the report socket.ts sends at a change is GapLog's at that frame.
  const log = new GapLog();
  log.frame("right", 40, 1000, 960);
  log.frame("right", 16, 1016, 960);
  // AUTH went here with { segments: [], held: "right" }; the key is let go two frames later.
  log.frame("right", 16, 1032, 960);
  log.frame("", 0, 1048, 960);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 72 }], held: "" });
  // Pressed again in another direction: the next report has both stretches, and the stand ended too.
  log.frame("", 0, 1064, 960);
  log.frame("up", 16, 1080, 960);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 72 }, { walk: "", ms: 32 }], held: "up" });
});

test("a key let go after the gap walk's last frame, as HANDOFF_DONE comes, is reported as a stand since that frame", () => {
  const log = new GapLog();
  log.frame("right", 40, 1000, 960);
  log.frame("right", 16, 1016, 960);
  // Let go at 1022; HANDOFF_DONE at 1026 notes it (socket.ts noteGapChange): the draw stood after the frame at 1016.
  log.frame("", 0, 1026, null);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 56 }], held: "" });
  // Turned instead: the same stand, and the new direction goes on from it.
  const turned = new GapLog();
  turned.frame("right", 40, 1000, 960);
  turned.frame("right", 16, 1016, 960);
  turned.frame("down", 0, 1026, null);
  expect(turned.report()).toEqual({ segments: [{ walk: "right", ms: 56 }, { walk: "", ms: 10 }], held: "down" });
});

test("a turn or a key let go first walks the walk going on to the end of its tick, so the node steps it whole and ends where the draw does", () => {
  const T = 1000 / 60;
  const log = new GapLog();
  // Nothing walked yet, or standing: nothing to finish.
  expect(log.stepLeft(T)).toBeNull();
  log.frame("right", 40, 1000, 960);
  log.frame("right", 16, 1016, 960);
  // 56 ms walked is 3.36 ticks: the node walks 3 steps (1.08 px short of the draw) or, finished, 4.
  const left = log.stepLeft(T)!;
  expect(left.walk).toBe("right");
  expect(left.ms).toBeCloseTo(4 * T - 56, 6);
  log.finish(left.ms);
  expect(log.stepLeft(T)).toBeNull();
  // Let go at 1026: the finished walk ended at 1026.67, so no stand is noted before it; the report is 4 ticks to the ms.
  log.frame("", 0, 1026, null);
  expect(log.report()).toEqual({ segments: [{ walk: "right", ms: 67 }], held: "" });
  expect(log.stepLeft(T)).toBeNull();
  // Turned instead: the same finished walk, and the new direction goes on from its end.
  const turned = new GapLog();
  turned.frame("right", 40, 1000, 960);
  turned.frame("right", 16, 1016, 960);
  turned.finish(turned.stepLeft(T)!.ms);
  turned.frame("down", 16, 1032, null);
  expect(turned.report()).toEqual({ segments: [{ walk: "right", ms: 67 }], held: "down" });
  // A walk already whole is left as it is.
  const whole = new GapLog();
  whole.frame("right", 2 * T, 1000, 1000 - 2 * T);
  expect(whole.stepLeft(T)).toBeNull();
  // A finish with nothing going on does nothing.
  const stood = new GapLog();
  stood.frame("", 0, 1000, 960);
  stood.finish(10);
  expect(stood.report()).toEqual({ segments: [], held: "" });
});

test("HANDOFF_BEGIN's point is taken as the old node's last echo when its datagram did not come before the frame", () => {
  // The client has the step before the last (110672); the node stopped at 110675, a 3 px step of a 60 Hz tick later.
  const point = beginPoint({ x: 110672, y: 93000, t: 5000 }, { x: 110675, y: 93000 }, false)!;
  expect(point.x).toBe(110675);
  expect(point.y).toBe(93000);
  expect(point.t).toBeCloseTo(5000 + 3 / 0.18, 6);
  // The datagram came first: nothing to take.
  expect(beginPoint({ x: 110675, y: 93000, t: 5000 }, { x: 110675, y: 93000 }, false)).toBeNull();
  // An engine that does not send the point, a predicted newest sample, none, or a jump: nothing either.
  expect(beginPoint({ x: 110672, y: 93000, t: 5000 }, { report: true }, false)).toBeNull();
  expect(beginPoint({ x: 110672, y: 93000, t: 5000, predicted: true }, { x: 110675, y: 93000 }, false)).toBeNull();
  expect(beginPoint(undefined, { x: 110675, y: 93000 }, false)).toBeNull();
  expect(beginPoint({ x: 110000, y: 93000, t: 5000 }, { x: 110675, y: 93000 }, false)).toBeNull();
  // Rounded as the node rounds; mounted it is the mounted walk's time.
  const mounted = beginPoint({ x: 110672, y: 93000, t: 5000 }, { x: 110676.2, y: 93000 }, true)!;
  expect(mounted.x).toBe(110676);
  expect(mounted.t).toBeCloseTo(5000 + 4 / (0.18 * 1.35), 6);
});

test("the gap walk finishes the walk going on at a change of key, in the frame and at HANDOFF_DONE, and starts from BEGIN's point", async () => {
  const strip = (s: string) => s.split(String.fromCharCode(13)).join("");
  const socket = strip(await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text());
  const renderer = strip(await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text());
  const body = (src: string, head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  const finish = body(socket, "function finishGapWalk(");
  expect(finish).toContain("if (!gapReports) return null;");
  expect(finish).toContain("const left = gapLog.stepLeft(getTickMs());");
  expect(finish).toContain("if (!left || left.walk === direction) return null;");
  expect(finish).toContain("gapLog.finish(left.ms);");
  // The renderer finishes before the frame is noted (and its report sent), and walks the finish before the frame's step.
  const frame = renderer.slice(renderer.indexOf("const finished = finishGapWalk(direction);"), renderer.indexOf("smoothPlayerRenderPositions(playersArray, now);"));
  expect(frame).toContain("if (finished) advanceSelf(currentPlayer, finished.walk, finished.ms, window.mapData);");
  expect(frame.indexOf("finishGapWalk(direction)")).toBeLessThan(frame.indexOf("noteGapFrame("));
  expect(frame.indexOf("advanceSelf(currentPlayer, finished.walk")).toBeLessThan(frame.indexOf("advanceSelf(currentPlayer, direction, walkMs"));
  // ... and the keys held walk only what is left of the frame after the finish's time.
  expect(frame).toContain("const walkMs = gapFrameMs(stepMs);");
  expect(frame).toContain("noteGapFrame(direction, direction ? walkMs : 0, now,");
  expect(finish).toContain("gapFinishedAheadMs += left.ms;");
  const ahead = body(socket, "function gapFrameMs(");
  expect(ahead).toContain("const taken = Math.min(Math.max(0, ms), gapFinishedAheadMs);");
  expect(body(socket, "function startHandoffGap(")).toContain("gapFinishedAheadMs = 0;");
  // At HANDOFF_DONE a change no frame saw is finished the same way.
  const change = body(socket, "function noteGapChange() {");
  expect(change).toContain("if (direction === gapSentHeld) return;");
  expect(change).toContain("const finished = finishGapWalk(direction);");
  expect(change).toContain("if (finished && own) advanceSelf(own, finished.walk, finished.ms, window.mapData);");
  expect(change).toContain("noteGapFrame(direction, 0, performance.now(), null);");
  // BEGIN's point is pushed as the newest echo after the gap starts, and the player is placed there.
  const begin = body(socket, "function beginHandoffGap(");
  expect(begin.indexOf("startHandoffGap(")).toBeLessThan(begin.indexOf("beginPoint("));
  expect(begin).toContain("if (point && pushEcho(own.moveSamples, point.x, point.y, point.t)) {");
});

test("socket.ts sends each change of key after AUTH, waits at HANDOFF_DONE for the answer to the newest, and drops the echoes of the replaced walk", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const body = (head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  // Every frame is noted; a change from the direction last reported is sent at once, only to an engine that takes it.
  const note = body("function noteGapFrame(");
  expect(note).toContain("gapLog.frame(direction, walkMs, now, from);");
  expect(note).toContain("if (gapSentHeld === null || direction === gapSentHeld) return;");
  expect(note).toContain('sendRequest({ type: "HANDOFF_GAP", data: { seq: gapSeq, ...report } });');
  const login = body("function sendLogin(");
  // Before the gap walk's first frame (the SWITCH right after BEGIN) the keys held now are reported, with nothing ended.
  expect(login).toContain("(gapLog.started ? gapLog.report() : { segments: [], held: gapDirection(pressedKeys, getStickDirection()) })");
  expect(login).toContain("gapSeq = 0;");
  expect(login).toContain("if (gap && gapUpdates) gapSentHeld = gap.held;");
  // HANDOFF_DONE settles at once unless the node walked an older report than the newest sent.
  const done = src.slice(src.indexOf('case "HANDOFF_DONE"'), src.indexOf('case "HANDOFF_GAP_DONE"'));
  // A change of key no frame saw is sent first, so the newest report is the keys as they are at HANDOFF_DONE.
  const change = body("function noteGapChange() {");
  expect(change).toContain("if (gapSentHeld === null || !getHandoffGap()) return;");
  expect(change).toContain("if (direction === gapSentHeld) return;");
  expect(change).toContain("noteGapFrame(direction, 0, performance.now(), null);");
  expect(done.indexOf("noteGapChange();")).toBeGreaterThan(-1);
  expect(done.indexOf("noteGapChange();")).toBeLessThan(done.indexOf("waitGapDone(data);"));
  expect(done).toContain("if (gapSeq > 0 && typeof data?.gapSeq === \"number\" && data.gapSeq < gapSeq && getHandoffGap()) waitGapDone(data);");
  expect(done).toContain("else settleHandoff(data);");
  expect(done).not.toContain("resetClockEpoch();");
  // The answer to the newest settles where the node has the player; an older one is kept for the fallback.
  const answer = src.slice(src.indexOf('case "HANDOFF_GAP_DONE"'), src.indexOf('case "LOAD_PLAYERS"'));
  expect(answer).toContain("ownEchoesFrom = Math.max(ownEchoesFrom, data.t);");
  expect(answer).toContain("gapDoneWait.data = done;");
  expect(answer).toContain("if (Number(data?.seq) >= gapSeq) settleHandoff(done);");
  expect(body("function waitGapDone(")).toContain("GAP_DONE_WAIT_MS");
  const settle = body("function settleHandoff(");
  expect(settle).toContain("endHandoffGap();\n  // The new node's clock reads differently from the old one's: its send times are learned afresh (movementsmoothing.ts).\n  resetClockEpoch();");
  expect(settle).toContain("const moving = getIsKeyPressed() || !!getStickDirection();");
  expect(settle).toContain("movementAllowed = true;");
  expect(body("function endHandoffGap() {")).toContain("gapDoneWait = null;");
  // The local player's echoes are dropped while waiting, and those sent before the answer, before they are dated or pushed.
  const move = body('case "MOVEXY": {');
  const drop = move.indexOf("if (playerId == cachedPlayerId && (gapDoneWait || (sentAt !== null && sentAt < ownEchoesFrom))) break;");
  expect(drop).toBeGreaterThan(-1);
  expect(drop).toBeLessThan(move.indexOf("keptWalkDating.date("));
});
