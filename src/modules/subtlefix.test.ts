import { expect, test, mock } from "bun:test";
import { sampleTime, pushSample, pushPredicted, pushEcho, getLateness, interpolationDelay, renderTime, lastRenderTime, renderHeadroom, getClockOffset, positionAt, seedSamples, needsPositionSample, resetMovementClock, resetClockEpoch, setServerTickRate } from "../webserver/public/js/core/movementsmoothing";
import { advanceSelf, gapDirection, applyEase, startEase, gapSampleTime, gapStepMs, stepWalkMs, planHandoffDone, hasAnchor, HandoffSettle, HandoffPace, planPaceArm, planStopPace, HANDOFF_PACE_RAMP_PER_MS, HANDOFF_PACE_LEAD_PX, HANDOFF_PACE_WINDOW_MS, HANDOFF_PACE_STALL_MS, HANDOFF_PACE_WAIT_MS, KeptWalkDating, keptWalkShift, HANDOFF_SNAP_PX, HANDOFF_KEEP_PX, HANDOFF_KEEP_WALK_PX, HANDOFF_KEEP_LEAD_MS, SETTLE_MS, KEPT_SHIFT_MAX_MS, KEPT_HEADROOM_SLACK_MS, KEPT_LEAD_SHIFT_MAX_MS, KEPT_CATCHUP_SPEED, KEPT_CATCHUP_LEAD_MAX_MS, keptWalkCover, clearHeld, HOLD_MAX_MS, releaseHeld, madeUpPoint, HANDOFF_CATCH_UP_MAX_MS, atMountSpeed } from "../webserver/public/js/core/handoffwalk";

// The walk across a node border, driven through the real smoothing and handoff-walk code (no DOM): the player walks
// right at 180 px/s, the old node's last echo comes `lastEchoAgo` ms before the SWITCH, HANDOFF_DONE comes
// `doneAfterSwitch` ms after it, and the new node's first echo 4 ms after that. "old" is the client before the fix:
// predicted steps dated last.t + 0.01, and at DONE the position and samples are rewritten and a 120 ms ease started.
// "new" dates the predicted steps with gapSampleTime and keeps position and samples at DONE (planHandoffDone).
type Variant = "old" | "new";

// `lag` is how much later than the old node's echoes the new node's arrive beyond the least-delayed one (clock offset or
// jitter): they are dated that much older, which the running lateness then learns. Capped so the first stays after the old node's last.
function cross(variant: Variant, lastEchoAgo: number, doneAfterSwitch: number, frameMs: number, lag = 0) {
  resetMovementClock();
  setServerTickRate(30);
  const TICK = 1000 / 30, LAT = 2;
  const S = 1000;
  const lastEchoArrive = S - lastEchoAgo;
  const lastEchoK = 60;
  const X0 = 1000 + lastEchoK * 6;
  const player: any = { position: { x: 1000, y: 0 }, serverPosition: { x: 1000, y: 0 }, renderPosition: { x: 1000, y: 0 }, moveSamples: [], mounted: false };
  const reference: { t: number; x: number; y: number }[] = []; // the echoes alone: where the server says the player is
  const events: { t: number; fn: () => void }[] = [];
  const echo = (x: number, arrive: number, extra = 0) => events.push({ t: arrive, fn: () => {
    const t = sampleTime(arrive - LAT - extra, arrive);
    if (!(variant === "new" ? pushEcho : pushSample)(player.moveSamples, x, 0, t)) return;
    pushSample(reference, x, 0, t);
    player.position.x = x;
    player.serverPosition.x = x;
  } });
  for (let k = 0; k <= lastEchoK; k++) echo(1000 + k * 6, lastEchoArrive - (lastEchoK - k) * TICK);
  const D = S + doneAfterSwitch;
  let gap = false;
  events.push({ t: S, fn: () => { gap = true; } });
  events.push({ t: D, fn: () => {
    const predicting = gap;
    const shown = { x: player.renderPosition.x, y: 0 };
    gap = false;
    player.serverPosition.x = X0;
    if (variant === "new" && planHandoffDone(predicting, true, player, { x: X0, y: 0 }) === "keep") {
      player.handoffWalk = undefined;
      return;
    }
    player.position.x = X0;
    player.renderPosition.x = X0;
    player.moveSamples = seedSamples(X0, 0, D);
    startEase(player, shown, { x: X0, y: 0 }, D);
  } });
  // The new node steps no sooner than one tick after the old one did (the server timeline keeps its tick), and 4 ms after DONE at the earliest.
  const E1 = Math.max(D + 4, lastEchoArrive + TICK);
  const extra = Math.max(0, Math.min(lag, E1 - lastEchoArrive - LAT - 1));
  for (let k = 1; k < 40; k++) echo(X0 + k * 6, E1 + (k - 1) * TICK, extra);
  events.sort((a, b) => a.t - b.t);

  let ei = 0;
  let prev = player.renderPosition.x;
  const out: { rel: number; x: number; step: number; err: number }[] = [];
  for (let now = 0; now < 1700; now += frameMs) {
    while (ei < events.length && events[ei].t <= now) events[ei++].fn();
    if (gap) advanceSelf(player, "right", frameMs, null);
    const samples = player.moveSamples;
    const last = samples[samples.length - 1];
    if (!last || last.x !== player.position.x) {
      if (variant === "new" && gap && last) pushPredicted(samples, player.position.x, 0, gapSampleTime(now, last.t, getLateness()));
      else pushSample(samples, player.position.x, 0, !last ? now : last.t + 0.01);
    }
    const at = renderTime(now);
    const smoothed = positionAt(samples, at)!;
    const p = player.handoffEase ? applyEase(player, smoothed, now) : smoothed;
    player.renderPosition.x = p.x;
    out.push({ rel: now - S, x: p.x, step: p.x - prev, err: Math.abs(p.x - positionAt(reference, at)!.x) });
    prev = p.x;
  }
  const steadyRows = out.filter((o) => o.rel < -50 && o.rel > -250);
  const steady = steadyRows.reduce((a, o) => a + o.step, 0) / steadyRows.length;
  const after = out.filter((o) => o.rel >= -20 && o.rel <= 600);
  let run = 0, freezeMs = 0;
  for (const o of after) {
    run = o.step < 0.01 ? run + frameMs : 0;
    freezeMs = Math.max(freezeMs, run);
  }
  return {
    steady,
    maxStepPx: Math.max(...after.map((o) => o.step)),
    freezeMs,
    maxRatio: Math.max(...after.map((o) => o.step)) / steady,
    minStep: Math.min(...after.map((o) => o.step)),
    errAfter500: Math.max(...out.filter((o) => o.rel >= 500 && o.rel <= 600).map((o) => o.err)),
  };
}

const GAPS = [5, 15, 25, 35, 50];
const DONES = [16, 39];
const RATES = [1000 / 60, 1000 / 145];

// At 60 Hz the crossing stays within 1.35 x the steady step. At 145 Hz one frame is 7 ms, short enough to show the
// 2.6 px of REAL server time lost at the node switch: the new node steps a tick after the old one, the walk was predicted
// from the SWITCH, so its first step lands that far ahead of the prediction. That is the server's own timeline, not a
// dating error, so the 145 Hz bound is 2.3 x (up to 5.2 x before the fix) and the draw never steps back.
const SPIKE_LIMIT: Record<string, number> = { "16.7": 1.35, "6.9": 2.3 };

test("after the fix a border crossing has no back-step, no spike beyond the limit, and no drift, at every gap, DONE time and frame rate", () => {
  for (const frame of RATES) for (const ago of GAPS) for (const done of DONES) {
    const r = cross("new", ago, done, frame);
    const label = `frame=${frame.toFixed(1)} lastEchoAgo=${ago} done=+${done}`;
    expect({ label, ok: r.maxRatio <= SPIKE_LIMIT[frame.toFixed(1)] }).toEqual({ label, ok: true });
    expect({ label, ok: r.minStep >= 0 }).toEqual({ label, ok: true });
    // No drift left: 500 ms on, the draw is where the server's echoes alone would put it.
    expect(r.errAfter500).toBeLessThan(0.5);
  }
});

test("with the new node's echoes dated 5, 20 or 60 ms older (lateness): no freeze, no jump over one server step, no back-step, no drift", () => {
  for (const lag of [5, 20, 60]) for (const frame of RATES) for (const ago of GAPS) for (const done of DONES) {
    const r = cross("new", ago, done, frame, lag);
    const label = `lag=${lag} frame=${frame.toFixed(1)} lastEchoAgo=${ago} done=+${done}`;
    expect({ label, ok: r.minStep >= 0 }).toEqual({ label, ok: true });
    expect({ label, ok: r.maxStepPx <= 8 }).toEqual({ label, ok: true }); // a server step is 6 px
    expect({ label, ok: r.freezeMs <= 34 }).toEqual({ label, ok: true }); // two frames at 60 Hz
    expect(r.errAfter500).toBeLessThan(0.5);
  }
});

test("the client before the fix fails the 60 Hz check (spike or back-step) at some gaps and the 145 Hz check at most", () => {
  const failures = (frame: number) => {
    let n = 0;
    for (const ago of GAPS) for (const done of DONES) {
      const r = cross("old", ago, done, frame);
      if (r.maxRatio > SPIKE_LIMIT[frame.toFixed(1)] || r.minStep < 0) n++;
    }
    return n;
  };
  expect(failures(RATES[0])).toBeGreaterThanOrEqual(3);
  expect(failures(RATES[1])).toBeGreaterThanOrEqual(5);
});

test("gapSampleTime dates a predicted step at now - lateness, never before the newest sample", () => {
  expect(gapSampleTime(5000, 4000, 2)).toBe(4998);
  expect(gapSampleTime(5000, 4000, 20)).toBe(4980);
  expect(gapSampleTime(5000, 4000, 0)).toBe(5000);
  expect(gapSampleTime(5000, 4999, 20)).toBeCloseTo(4999.01, 6);
  expect(gapSampleTime(5000, 5100, 2)).toBeCloseTo(5100.01, 6);
});

test("the running lateness is what the gap dating reads", () => {
  resetMovementClock();
  expect(getLateness()).toBe(0);
  sampleTime(1000, 1002); // offset 2
  sampleTime(2000, 2022); // 20 ms later than the least-delayed
  expect(getLateness()).toBeCloseTo(20, 1);
  resetMovementClock();
});

test("pushEcho replaces predicted steps newer than the echo and never drops it for them", () => {
  const samples = seedSamples(100, 0, 5000);
  pushSample(samples, 106, 0, 5100);
  pushPredicted(samples, 109, 0, 5110);
  pushPredicted(samples, 112, 0, 5120);
  // pushSample alone would drop an echo dated 5105 behind predicted steps up to 5120 (and the handler would not apply it).
  expect(pushSample(samples.map((m) => ({ ...m })), 112, 0, 5105)).toBe(false);
  expect(pushEcho(samples, 112, 0, 5105)).toBe(true);
  expect(samples.map((m) => m.t).slice(-2)).toEqual([5100, 5105]);
  expect(samples.every((m) => !m.predicted)).toBe(true);
  // A real step older than a real one is still dropped (a stale datagram).
  expect(pushEcho(samples, 90, 0, 5050)).toBe(false);
});

test("pushPredicted keeps the newest server sample however long the gap: the oldest predicted one goes instead", () => {
  setServerTickRate(60);
  const samples = seedSamples(100, 0, 5000);
  pushSample(samples, 103, 0, 5016);
  // A gap walk begun at HANDOFF_BEGIN runs 300 ms: 43 frames at 144 Hz, far more than the list holds.
  for (let k = 1; k <= 43; k++) pushPredicted(samples, 103 + k * 1.25, 0, 5016 + k * 6.94);
  expect(hasAnchor(samples)).toBe(true);
  expect(samples[0]).toEqual({ t: 5016, x: 103, y: 0 });
  // The list is no longer than before, and the newest predicted samples are the ones kept, in order.
  expect(samples.length).toBe(16);
  expect(samples[samples.length - 1].x).toBeCloseTo(103 + 43 * 1.25);
  for (let i = 2; i < samples.length; i++) expect(samples[i].t).toBeGreaterThan(samples[i - 1].t);
  // A teleport-sized predicted step still starts the list over: no anchor is kept across a snap.
  pushPredicted(samples, 103 + 43 * 1.25 + 200, 0, 5400);
  expect(samples.length).toBe(1);
  expect(hasAnchor(samples)).toBe(false);
  setServerTickRate(30);
});

// The settle fallback of a kept walk, with a fake clock for the timer.
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; at: number }>();
  let id = 0, time = 0;
  return {
    schedule: (fn: () => void, ms: number) => { pending.set(++id, { fn, at: time + ms }); return id; },
    clear: (h: unknown) => { pending.delete(h as number); },
    advance: (ms: number) => {
      time += ms;
      for (const [k, v] of [...pending]) if (v.at <= time) { pending.delete(k); v.fn(); }
    },
    count: () => pending.size,
    now: () => time,
  };
}
const selfAt = (pos: number, server: number): any => ({ position: { x: pos, y: 0 }, serverPosition: { x: server, y: 0 }, renderPosition: { x: pos, y: 0 } });

test("settle: after SETTLE_MS with no echo the node's point is taken by an ease from the drawn spot, not a jump", () => {
  const t = fakeTimers();
  const settle = new HandoffSettle(t.schedule, t.clear, t.now);
  const self = selfAt(1007, 1000);
  settle.arm(self, 1000, 0);
  expect(settle.pending).toBe(true);
  t.advance(SETTLE_MS - 1);
  expect(self.position.x).toBe(1007);
  t.advance(1);
  expect(settle.pending).toBe(false);
  expect(self.position.x).toBe(1000);
  // The drawn offset starts at the old error and falls away.
  expect(self.handoffEase).toEqual({ x: 7, y: 0, at: SETTLE_MS });
  expect(applyEase(self, { x: 1000, y: 0 }, SETTLE_MS).x).toBe(1007);
  expect(applyEase(self, { x: 1000, y: 0 }, SETTLE_MS + 120).x).toBeLessThan(1004);
});

test("settle: every cancel path stops it (new switch, socket close, new gap, a real echo)", () => {
  // The socket calls cancel() from switchNode (a new switch, which also starts the new gap), handleSocketClose,
  // stopSwitching and the local player's MOVEXY echo: each is one cancel() on the same object. The calls themselves are
  // wiring and not exercised here.
  for (const path of ["new switch", "socket close", "new gap", "real echo"]) {
    const t = fakeTimers();
    const settle = new HandoffSettle(t.schedule, t.clear, t.now);
    const self = selfAt(1007, 1000);
    settle.arm(self, 1000, 0);
    settle.cancel();
    expect({ path, pending: settle.pending, timers: t.count() }).toEqual({ path, pending: false, timers: 0 });
    t.advance(SETTLE_MS * 2);
    expect({ path, x: self.position.x }).toEqual({ path, x: 1007 });
  }
});

test("settle: a second handoff within 500 ms is not pulled back to the first node's point", () => {
  const t = fakeTimers();
  const settle = new HandoffSettle(t.schedule, t.clear, t.now);
  const self = selfAt(1007, 1000);
  settle.arm(self, 1000, 0); // first DONE, kept
  t.advance(200);
  settle.cancel(); // second SWITCH (switchNode)
  self.position.x = 1100; // second gap: no echo, the client walks the player on
  self.renderPosition.x = 1100;
  t.advance(SETTLE_MS * 2);
  expect(self.position.x).toBe(1100);
  expect(self.handoffEase).toBeUndefined();
  // arming again replaces an older timer
  settle.arm(self, 1000, 0);
  settle.arm(self, 1000, 0);
  expect(t.count()).toBe(1);
});

test("settle: nothing happens when an echo already moved the server point", () => {
  const t = fakeTimers();
  const settle = new HandoffSettle(t.schedule, t.clear, t.now);
  const a = selfAt(1007, 1000);
  settle.arm(a, 1000, 0);
  a.serverPosition.x = 1010;
  a.position.x = 1010;
  t.advance(SETTLE_MS);
  expect(a.position.x).toBe(1010);
  expect(a.handoffEase).toBeUndefined();
});

test("planHandoffDone keeps the walk only when predicting, still moving and within HANDOFF_KEEP_PX", () => {
  const server = { x: 500, y: 300 };
  expect(HANDOFF_KEEP_PX).toBeLessThan(HANDOFF_SNAP_PX);
  const at = (x: number) => ({ position: { x, y: 300 }, lastDirection: "right" });
  expect(planHandoffDone(true, true, at(500 + HANDOFF_KEEP_PX), server)).toBe("keep");
  // Above it the old ease runs (reseed), and above HANDOFF_SNAP_PX startEase snaps.
  expect(planHandoffDone(true, true, at(500 + HANDOFF_KEEP_PX + 1), server)).toBe("reseed");
  expect(planHandoffDone(true, true, at(500 + HANDOFF_SNAP_PX), server)).toBe("reseed");
  expect(planHandoffDone(false, true, at(508), server)).toBe("reseed");
  expect(planHandoffDone(true, false, at(508), server)).toBe("reseed");
  expect(planHandoffDone(true, true, null, server)).toBe("reseed");
});

// The live creep: a 59 ms gap left the walked head 14 px past the point the node stood the player at, past HANDOFF_KEEP_WALK_PX,
// so the walk was reseeded and drawn at 0.65 times the walk until the node's echoes, which made the gap up, passed it.
test("madeUpPoint moves HANDOFF_DONE's point on along the walk by the catch-up, so a long gap keeps the walk", () => {
  const server = { x: 110484, y: 93000 };
  const head = { position: { x: 110470, y: 93000 }, lastDirection: "left" };
  expect(planHandoffDone(true, true, head, server)).toBe("reseed");
  // 67 ms made up: 12 px along the walk.
  const target = madeUpPoint(server, "left", 67, false);
  expect(target.x).toBeCloseTo(110484 - 0.18 * 67, 6);
  expect(target.y).toBe(93000);
  expect(planHandoffDone(true, true, head, target)).toBe("keep");
  // Diagonal: each axis steps the walk; mounted, at the mount's speed.
  expect(madeUpPoint(server, "upright", 10, false)).toEqual({ x: 110484 + 1.8, y: 93000 - 1.8 });
  expect(madeUpPoint(server, "right", 10, true).x).toBeCloseTo(110484 + 1.8 * 1.35, 6);
  // No catch-up, an older engine, no walk, or nonsense: the point as it is; a long one is cut to HANDOFF_CATCH_UP_MAX_MS.
  for (const ms of [0, undefined, -5, "x", Number.NaN]) expect(madeUpPoint(server, "left", ms, false)).toBe(server);
  expect(madeUpPoint(server, null, 67, false)).toBe(server);
  expect(madeUpPoint(server, "left", 60_000, false).x).toBeCloseTo(110484 - 0.18 * HANDOFF_CATCH_UP_MAX_MS, 6);
});

test("socket.ts weighs the kept walk at HANDOFF_DONE against the point the catch-up moves on to", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("const target = madeUpPoint({ x, y }, doneWalk(data?.walk), data?.catchUpMs, atMountSpeed(self));");
  expect(src).toContain("planHandoffDone(predicting, moving, self, target, hasAnchor(self.moveSamples)) === \"keep\"");
});

// The live stand: the walk was reseeded because the drawn point (one playback delay behind the walked head, about 8 px
// at 180 px/s) was measured against the node's point, 8.1 px apart, over HANDOFF_KEEP_PX. The head decides.
test("planHandoffDone decides from the walked head, not the drawn point a playback delay behind it", () => {
  const server = { x: 500, y: 300 };
  // Walked 3 px past the node's point in the gap; drawn 8.5 px behind the head (5.5 px behind the point, then 8.5 px).
  for (const drawnBehind of [8, 8.5, 9, 11.5]) {
    const walking = { position: { x: 503, y: 300 }, renderPosition: { x: 503 - drawnBehind, y: 300 } };
    expect({ drawnBehind, plan: planHandoffDone(true, true, walking, server) }).toEqual({ drawnBehind, plan: "keep" });
  }
  // A head at the node's point with the draw 8.1 px behind (the live case).
  const live = { position: { x: 500, y: 300 }, renderPosition: { x: 491.9, y: 300 } };
  expect(planHandoffDone(true, true, live, server)).toBe("keep");
  // A real error (the head far from the node's point) still reseeds, wherever the draw is.
  const off = { position: { x: 500 + HANDOFF_KEEP_PX + 4, y: 300 }, renderPosition: { x: 500, y: 300 } };
  expect(planHandoffDone(true, true, off, server)).toBe("reseed");
  const offDiagonal = { position: { x: 507, y: 307 }, renderPosition: { x: 500, y: 300 } };
  expect(planHandoffDone(true, true, offDiagonal, server)).toBe("reseed");
  // The node's point ahead of the head by more than HANDOFF_KEEP_LEAD_MS of walk (a step of a slow tick never received):
  // reseed, though within HANDOFF_KEEP_PX. Behind the head, or ahead within the lead, keeps.
  const lead = HANDOFF_KEEP_LEAD_MS * 0.18;
  expect(planHandoffDone(true, true, { position: { x: 500 - lead - 1, y: 300 }, lastDirection: "right" }, server)).toBe("reseed");
  expect(planHandoffDone(true, true, { position: { x: 500 - lead + 0.5, y: 300 }, lastDirection: "right" }, server)).toBe("keep");
  expect(planHandoffDone(true, true, { position: { x: 500 + 7, y: 300 }, lastDirection: "right" }, server)).toBe("keep");
  expect(planHandoffDone(true, true, { position: { x: 500 + lead + 1, y: 300 }, lastDirection: "left" }, server)).toBe("reseed");
  // Mounted, the walk is 1.35 x as fast: the same px is less time.
  expect(planHandoffDone(true, true, { position: { x: 500 - lead - 1, y: 300 }, lastDirection: "right", mounted: true }, server)).toBe("keep");
  // Diagonal: both axes count.
  expect(planHandoffDone(true, true, { position: { x: 497, y: 297 }, lastDirection: "downright" }, server)).toBe("keep");
  expect(planHandoffDone(true, true, { position: { x: 496, y: 296 }, lastDirection: "downright" }, server)).toBe("reseed");
  // Standing still (no key, no stick) reseeds, even at the point.
  const still = { position: { x: 500, y: 300 }, renderPosition: { x: 500, y: 300 } };
  expect(planHandoffDone(true, false, still, server)).toBe("reseed");
});

// The gamepad/touch stick (upper case, input.ts) walks the player through the handoff gap like the keys do.
test("gapDirection: a stick alone gives its lower-case direction, keys win over it, none gives nothing", () => {
  expect(gapDirection(new Set<string>(), "DOWNRIGHT")).toBe("downright");
  expect(gapDirection(new Set(["KeyW"]), "DOWNRIGHT")).toBe("up");
  expect(gapDirection(new Set<string>(), "")).toBe("");
  const player: any = { position: { x: 100, y: 100 }, mounted: false };
  expect(advanceSelf(player, gapDirection(new Set<string>(), "DOWNRIGHT"), 100, null)).toBe(true);
  expect(player.position.x).toBeGreaterThan(100);
  expect(player.position.y).toBeGreaterThan(100);
  const still: any = { position: { x: 100, y: 100 }, mounted: false };
  expect(advanceSelf(still, gapDirection(new Set<string>(), ""), 100, null)).toBe(false);
});

test("a stick held through a gap ends in keep at HANDOFF_DONE, as a held key does", () => {
  const walk = (direction: string) => {
    const p: any = { position: { x: 1000, y: 500 }, mounted: false };
    for (let ms = 0; ms < 300; ms += 1000 / 60) advanceSelf(p, direction, 1000 / 60, null);
    return p;
  };
  const key = walk(gapDirection(new Set(["KeyD"]), ""));
  const stick = walk(gapDirection(new Set<string>(), "RIGHT"));
  expect(stick.position).toEqual(key.position);
  // The new node is a step behind the walked head: within HANDOFF_KEEP_PX the walk is kept.
  const server = { x: stick.position.x - 6, y: 500 };
  expect(planHandoffDone(true, true, stick, server)).toBe("keep");
  // Without the stick in the walk (the bug) the player stands still, far from the node: reseed and a visible slide.
  const stood = walk(gapDirection(new Set<string>(), "").toString());
  expect(planHandoffDone(true, true, stood, server)).toBe("reseed");
});

// The F2 overlay: the module reads two elements from ui.ts; a fake box and text stand in for them.
const box = { checked: true, addEventListener() {} };
const text = { innerText: "" };
mock.module("../webserver/public/js/core/ui.js", () => ({ clusterNodesDebugCheckbox: box, clusterNodesText: text }));
mock.module("../webserver/public/js/core/ui.ts", () => ({ clusterNodesDebugCheckbox: box, clusterNodesText: text }));

function fakeCtx() {
  const fills: number[] = [];
  const noop = () => {};
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === "fillRect" ? () => fills.push(1) : k === "createPattern" ? () => null : noop), set: () => true });
  return { ctx, fills };
}
const answerFor = (map: string) => ({
  cluster: true, self: "node-a", map, blockPx: 100, blocksX: 2, blocksY: 1, nodes: ["node-a", "node-b"], cells: [0, 1], moving: [], here: { bx: 0, by: 0, owner: 0 },
});
const view = { left: 0, top: 0, right: 200, bottom: 100 };

test("overlay: pauseClusterRefresh(true) keeps the grid and says switching, pauseClusterRefresh() clears it", async () => {
  const nodes = await import("../webserver/public/js/core/clusternodes");
  nodes.applyClusterDebug(answerFor("main.json"));
  let d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "main", 200, 100);
  const drawn = d.fills.length;
  expect(drawn).toBeGreaterThan(0);

  nodes.pauseClusterRefresh(true);
  expect(text.innerText).toBe("Cluster: switching node");
  d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "main", 200, 100);
  expect(d.fills.length).toBe(drawn);

  // The next answer replaces the grid and the status.
  nodes.applyClusterDebug(answerFor("main.json"));
  expect(text.innerText).toContain("connected to node-a");

  nodes.pauseClusterRefresh();
  expect(text.innerText).toBe("Cluster: waiting for the server");
  d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "main", 200, 100);
  expect(d.fills.length).toBe(0);
});

test("overlay: a kept grid is still not drawn on another map, and an answer for another map is skipped", async () => {
  const nodes = await import("../webserver/public/js/core/clusternodes");
  nodes.applyClusterDebug(answerFor("main.json"));
  nodes.pauseClusterRefresh(true);
  let d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "cave", 200, 100);
  expect(d.fills.length).toBe(0);
  nodes.applyClusterDebug(answerFor("cave.json"));
  d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "main", 200, 100);
  expect(d.fills.length).toBe(0);
  d = fakeCtx();
  nodes.drawClusterNodes(d.ctx, view, 1, "cave", 200, 100);
  expect(d.fills.length).toBeGreaterThan(0);
});

// Nodes of a cluster do not share a clock: the new node's send times differ from the old one's by about 1.5 s (live:
// the offset moved 1462 ms at a crossing). The offset estimator keeps the smallest offset seen, so a node whose times
// lag it reads as that much lateness, which decays by 0.5% an echo and holds the draw delay at its 250 ms cap, past the
// span of the kept samples (16 x 17 ms): the draw then falls off the oldest sample and follows the raw echoes.
function clockSwitchRun(skews: number[], reset: boolean, frameMs: number) {
  resetMovementClock();
  setServerTickRate(57);
  const TICK = 1000 / 57;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const samples: any[] = [];
  const events: { t: number; fn: () => void }[] = [];
  let x = 0, T = 500, skewNow = 0;
  const marks: { at: number; lateness: number; delay: number }[] = [];
  const phases: { a: number; b: number }[] = [];
  for (let c = 0; c <= skews.length; c++) {
    if (c > 0) {
      const skew = skews[c - 1];
      const start = T;
      events.push({ t: start, fn: () => { skewNow = skew; if (reset) resetClockEpoch(); } });
      T += 40; // the node resumes a short while after the switch
    }
    const end = T + 3000;
    for (let t = T; t < end; t += TICK) {
      x += 3;
      const arrive = t + rnd() * 5, xx = x;
      events.push({ t: arrive, fn: () => pushEcho(samples, xx, 0, sampleTime(t - 2 - skewNow, arrive)) });
    }
    if (c > 0) phases.push({ a: T + 300, b: T + 3000 });
    T = end;
  }
  events.sort((a, b) => a.t - b.t);
  let ei = 0, prev = 0;
  const steps: { now: number; step: number }[] = [];
  for (let now = 0; now < T; now += frameMs) {
    while (ei < events.length && events[ei].t <= now) events[ei++].fn();
    const at = renderTime(now);
    const p = positionAt(samples, at);
    if (!p) continue;
    steps.push({ now, step: p.x - prev });
    prev = p.x;
    for (const ph of phases) if (Math.abs(now - ph.a) < frameMs / 2 || Math.abs(now - (ph.a + 2000)) < frameMs / 2) marks.push({ at: now, lateness: getLateness(), delay: now - at });
  }
  const zeroFrames = phases.map((ph) => steps.filter((s) => s.now >= ph.a && s.now <= ph.b && s.step < 0.05).length);
  return { marks, zeroFrames };
}

test("a node clock offset of 1.5 s at the switch: lateness and delay go back to the fresh level within 300 ms, no raw-echo steps", () => {
  const skews = [1500, -1500, 1500, -1500]; // four crossings, both directions
  for (const frame of RATES) {
    const fixed = clockSwitchRun(skews, true, frame);
    for (const m of fixed.marks) {
      expect(m.lateness).toBeLessThan(15);
      expect(m.delay).toBeLessThan(80);
    }
    expect(fixed.zeroFrames.every((n) => n === 0)).toBe(true);
  }
});

test("without the clock reset the same switch leaves the lateness at the skew and the delay at the cap (the live inflation)", () => {
  const broken = clockSwitchRun([1500, -1500, 1500, -1500], false, RATES[1]);
  expect(Math.max(...broken.marks.map((m) => m.lateness))).toBeGreaterThan(500);
  expect(Math.max(...broken.marks.map((m) => m.delay))).toBeGreaterThanOrEqual(240);
});

test("from a delay held at the 250 ms cap, the reset brings the delay back to the fresh level in about 1.6 s at 10% slew", () => {
  resetMovementClock();
  setServerTickRate(57);
  // 4 s on a node whose times lag the offset by 1500 ms: lateness 1500, delay at the cap.
  let t = 0;
  const samples: any[] = [];
  const lag = (arrive: number, skew: number) => sampleTime(arrive - 2 - skew, arrive);
  sampleTime(-2, 0); // the offset learned on the old node
  for (; t < 4000; t += 1000 / 57) pushEcho(samples, Math.round(t), 0, lag(t, 1500));
  let now = 4000;
  for (; now < 6000; now += 7) renderTime(now);
  const inflated = interpolationDelay();
  expect(inflated).toBe(250);
  resetClockEpoch();
  const resetAt = now;
  let recoveredAt = -1;
  for (let k = 0; k < 400; k++, now += 7) {
    const arrive = now;
    if (k % 2 === 0) pushEcho(samples, Math.round(now), 0, lag(arrive, 1500));
    const at = renderTime(now);
    if (recoveredAt < 0 && now - at <= 90) recoveredAt = now - resetAt;
  }
  // 250 -> 90 at 0.1 ms per ms = 1600 ms; the target itself is back at the minimum at once.
  expect(interpolationDelay()).toBe(45);
  expect(recoveredAt).toBeGreaterThan(1400);
  expect(recoveredAt).toBeLessThan(1800);
});

/** The movement keys that hold `direction` (the inverse of heldDirection). */
function keysFor(direction: string): Set<string> {
  const keys = new Set<string>();
  if (direction.includes("up")) keys.add("KeyW");
  if (direction.includes("down")) keys.add("KeyS");
  if (direction.includes("left")) keys.add("KeyA");
  if (direction.includes("right")) keys.add("KeyD");
  return keys;
}

// The frames just after HANDOFF_DONE on the keep path, as socket.ts runs it (live: 60 Hz node, 3 px a tick, 144 Hz
// screen). The server stands the player from the SWITCH until the new node resumes the walk; the client walks on, so
// the new node's first echo is a point the predicted samples already passed, dated later. `fix` dates the echoes with
// KeptWalkDating (armed at a kept DONE); without it they are dated as they come and the draw stands at the newest
// predicted sample until they pass it. `held` false is a crossing standing still: no gap walk, the reseed path.
function keepCross(o: { dir: string; ago: number; done: number; phase: number; startFrame: number; fix: boolean; held?: boolean; hz?: number; jitter?: number; ahead?: number; byDrawn?: boolean; frameHz?: number; gaps?: number[]; stall?: { from: number; until: number }; echoes?: number; oldGap?: boolean; oldPlan?: boolean; pace?: boolean; stick?: boolean; keyUp?: number; release?: number; mounted?: boolean; turn?: { after: number; dir: string; keyBefore: number }; endMs?: number; walkedOn?: boolean; lastLate?: number; dropLate?: boolean; echoAhead?: number }) {
  const held = o.held !== false;
  const frameMs = 1000 / (o.frameHz ?? 144);
  resetMovementClock();
  const hz = o.hz ?? 60;
  setServerTickRate(hz);
  // 180 px/s at any tick rate (the engine scales the 6 px/30 Hz step); `jitter` ms of arrival spread, spread evenly.
  const TICK = 1000 / hz, STEP = (180 * (o.mounted ? 1.35 : 1)) / hz, LAT = 1, SKEW = 1500;
  const late = (k: number) => (o.jitter ?? 0) * ((k * 0.618034) % 1);
  const ux = o.dir.includes("left") ? -1 : o.dir.includes("right") ? 1 : 0;
  const uy = o.dir.includes("up") ? -1 : o.dir.includes("down") ? 1 : 0;
  const S = 1000, K = 60, B = 5000;
  const lastArrive = S - o.ago;
  const at0 = (k: number) => ({ x: B + ux * k * STEP, y: B + uy * k * STEP });
  const player: any = { position: at0(0), serverPosition: at0(0), renderPosition: at0(0), moveSamples: [], mounted: o.mounted === true };
  const dating = new KeptWalkDating();
  const pacer = new HandoffPace();
  const reference: { t: number; x: number; y: number }[] = []; // the echoes dated as they come: where the server says the player is
  const events: { t: number; fn: () => void }[] = [];
  const echo = (p: { x: number; y: number }, arrive: number, skew: number, fresh: boolean, direction?: string) => events.push({ t: arrive, fn: () => {
    // `dropLate`: an old node's echo that comes after HANDOFF_BEGIN is dropped (socket.ts MOVEXY): the gap walk already made it up.
    if (o.dropLate && gap && !fresh) return;
    const raw = sampleTime(arrive - LAT - skew, arrive);
    const t = o.fix && fresh ? dating.date(player.moveSamples, p.x, p.y, raw, arrive, { renderAt: lastRenderTime(), headroom: renderHeadroom(), offset: getClockOffset() }, player.lastDirection, o.mounted === true) : raw;
    const pt = o.fix && fresh ? dating.point(p.x, p.y) : p;
    if (!pushEcho(player.moveSamples, pt.x, pt.y, t)) return;
    if ((pt as any).held) Object.assign(player.moveSamples[player.moveSamples.length - 1], { held: true, heldUntil: (pt as any).until });
    pushSample(reference, p.x, p.y, raw);
    player.position.x = p.x; player.position.y = p.y;
    if (direction) player.lastDirection = direction;
    player.serverPosition.x = p.x; player.serverPosition.y = p.y;
  } });
  // A crossing standing still: the walk stopped well before the SWITCH.
  const lastK = held ? K : K - 20;
  for (let k = 0; k <= lastK; k++) {
    const sent = lastArrive - (K - k) * TICK;
    // `lastLate`: the last echo comes that long after the gap starts (a datagram behind HANDOFF_BEGIN on the stream).
    if (k === lastK && o.lastLate !== undefined) echo(at0(k), S + o.lastLate, S + o.lastLate - sent, false);
    else echo(at0(k), sent + late(k), late(k), false);
  }
  const D = S + o.done;
  // The new node's point: where the server stood the player through the gap, `ahead` steps past the last echo the client
  // got (steps sent by the old node but lost to the switch).
  const ahead = held ? o.ahead ?? 0 : 0;
  const point = at0(lastK + ahead);
  let gap = false;
  let plan = "";
  let headGap = NaN, shownGap = NaN;
  events.push({ t: S, fn: () => { gap = true; } });
  events.push({ t: D, fn: () => {
    const predicting = gap;
    gap = false;
    resetClockEpoch();
    const shown = { x: player.renderPosition.x, y: player.renderPosition.y };
    headGap = Math.hypot(player.position.x - point.x, player.position.y - point.y);
    shownGap = Math.hypot(shown.x - point.x, shown.y - point.y);
    // byDrawn: the choice as it was made before round 2 (the drawn point, a playback delay behind the head, within
    // HANDOFF_KEEP_PX of the node's point).
    plan = o.byDrawn
      ? (predicting && held && shownGap <= HANDOFF_KEEP_PX ? "keep" : "reseed")
      : o.oldPlan && Math.hypot(player.position.x - point.x, player.position.y - point.y) > HANDOFF_KEEP_PX ? "reseed" : planHandoffDone(predicting, held, player, point, hasAnchor(player.moveSamples));
    player.serverPosition.x = point.x; player.serverPosition.y = point.y;
    const arm = planPaceArm(predicting, held, shown);
    if (o.pace && arm) pacer.arm(D, arm);
    if (plan === "keep") {
      player.handoffWalk = undefined;
      dating.arm(D);
      return;
    }
    dating.cancel();
    player.position.x = point.x; player.position.y = point.y;
    player.renderPosition.x = point.x; player.renderPosition.y = point.y;
    player.moveSamples = seedSamples(point.x, point.y, D);
    if (predicting) startEase(player, shown, point, D);
  } });
  // The new node resumes the walk from the handoff point; its first step comes `phase` ms after DONE.
  // `gaps`: the send gaps of the first echoes after DONE (the live burst: the 2nd and 3rd echoes 4-6 ms apart), then the tick.
  let sendAt = D + o.phase;
  // `echoAhead`: the steps the first echo makes up, counted when it is sent (the point's `ahead` is counted at DONE).
  let cur = at0(K + (held ? o.echoAhead ?? ahead : 0));
  for (let k = 1; held && k < (o.echoes ?? 60); k++) {
    if (k > 1) sendAt += o.gaps?.[k - 2] ?? TICK;
    // `stall`: the echoes sent from `from` to `until` ms after DONE arrive together at `until` (a hiccup on the link).
    const stalled = o.stall !== undefined && sendAt - D >= o.stall.from && sendAt - D < o.stall.until;
    const arrive = stalled ? D + o.stall!.until + k * 0.01 : sendAt + late(K + k);
    // A turn: the node steps the new way from the first echo sent after `turn.after` ms past DONE.
    const way = o.turn && sendAt - D >= o.turn.after ? o.turn.dir : o.dir;
    cur = { x: cur.x + (way.includes("left") ? -1 : way.includes("right") ? 1 : 0) * STEP, y: cur.y + (way.includes("up") ? -1 : way.includes("down") ? 1 : 0) * STEP };
    echo(cur, arrive, SKEW + (arrive - sendAt), true, o.turn ? way : undefined);
  }
  events.sort((a, b) => a.t - b.t);

  // Progress along the walk: on a diagonal the x axis steps the same px a frame as a straight walk.
  const along = (p: { x: number; y: number }) => (ux !== 0 ? p.x * ux : p.y * uy);
  let ei = 0;
  let prev = along(player.renderPosition);
  const out: { held: boolean; rel: number; at: number; step: number; err: number; pos: { x: number; y: number } }[] = [];
  let released = false;
  for (let now = o.startFrame; now < (o.endMs ?? 2000); now += frameMs) {
    while (ei < events.length && events[ei].t <= now) events[ei++].fn();
    if (gap) advanceSelf(player, held ? o.dir : "", o.oldGap ? frameMs : gapStepMs(frameMs, player.handoffWalk !== undefined, now, player.moveSamples[player.moveSamples.length - 1], getLateness(), o.walkedOn === true), null);
    const samples = player.moveSamples;
    const last = samples[samples.length - 1];
    const at = renderTime(now);
    if (needsPositionSample(last, player.position, now)) {
      if (gap && last) pushPredicted(samples, player.position.x, player.position.y, gapSampleTime(now, last.t, getLateness(), o.oldGap ? 0 : stepWalkMs(last, player.position.x, player.position.y, o.mounted === true)));
      else if (last?.held) releaseHeld(samples, player.position.x, player.position.y, at, o.mounted === true);
      else pushSample(samples, player.position.x, player.position.y, !last ? now : last.t + 0.01);
    }
    const smoothed = positionAt(samples, at)!;
    const eased = player.handoffEase ? applyEase(player, smoothed, now) : smoothed;
    if (o.release !== undefined && !released && now - D >= o.release) { released = true; pacer.release(); }
    // The key held now: the turn's key from `keyBefore` ms before the node steps the new way, none after keyUp.
    const keyDir = o.keyUp !== undefined && now - D >= o.keyUp ? "" : !held ? "" : o.turn && now - D >= o.turn.after - o.turn.keyBefore ? o.turn.dir : o.dir;
    const p = pacer.stepFor(eased, now, o.stick ? new Set<string>() : keysFor(keyDir), o.stick ? keyDir.toUpperCase() : "", o.mounted === true);
    player.renderPosition.x = p.x; player.renderPosition.y = p.y;
    const ref = positionAt(reference, at)!;
    out.push({ held: !!(last && last.held), rel: now - S, at: at - S, step: along(p) - prev, err: Math.hypot(p.x - ref.x, p.y - ref.y), pos: { x: p.x, y: p.y } });
    prev = along(p);
  }
  // From the frame the draw is past the SWITCH (before it are the old node's samples and the gap's first step, the
  // start of the walk, not this hold) to 300 ms after DONE.
  const window = out.filter((r) => r.at > 8 && r.rel <= o.done + 300);
  let stalls = 0;
  for (let i = 1; i < window.length; i++) if (window[i].step < 0.05 && window[i - 1].step < 0.05) stalls++;
  return {
    plan,
    heldFrames: out.filter((w) => w.held).length,
    headGap,
    shownGap,
    window, all: out,
    stalls,
    maxStep: Math.max(...window.map((r) => r.step)),
    minStep: Math.min(...window.map((r) => r.step)),
    errLate: Math.max(...out.filter((r) => r.rel >= o.done + 600 && r.rel <= o.done + 800).map((r) => r.err)),
    final: out[out.length - 1].pos,
    point,
  };
}

/** 180 px/s at 144 Hz. */
const STEADY_144 = 180 / 144;
const KEEP_DIRS = ["right", "left", "downright"];
const KEEP_PHASES = [2, 5, 8, 11, 14, 1000 / 60];
const KEEP_DONES = [16, 19, 22];
const KEEP_STARTS = [0.3, 2, 4, 6];

test("keep path, 60 Hz node, 144 Hz: no two frames in a row on the same point, no frame under 0.25 x or over 1.5 x steady, none backward, no drift", () => {
  for (const ahead of [0, 1]) for (const dir of KEEP_DIRS) for (const done of KEEP_DONES) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const r = keepCross({ dir, ago: 6, done, phase, startFrame, fix: true, ahead });
    const label = `ahead=${ahead} dir=${dir} done=+${done} phase=${phase.toFixed(1)} start=${startFrame}`;
    expect({ label, plan: r.plan }).toEqual({ label, plan: "keep" });
    expect({ label, stalls: r.stalls }).toEqual({ label, stalls: 0 });
    expect({ label, ok: r.maxStep <= 1.5 * STEADY_144 }).toEqual({ label, ok: true });
    expect({ label, ok: r.minStep >= 0.25 * STEADY_144 }).toEqual({ label, ok: true });
    // The shift is gone well before this: the draw is where the echoes dated as they come put it.
    expect({ label, ok: r.errLate < 0.5 }).toEqual({ label, ok: true });
  }
});

// The live stand (round 2): the node's point one 60 Hz step past the last echo the client got. The drawn point, one
// playback delay behind the head, is then 6-11 px from it, around HANDOFF_KEEP_PX, so a choice made from it reseeds
// some crossings and keeps others; the walked head is within 3 px in all of them.
test("live state at 60 Hz: the head keeps every crossing the drawn point would have reseeded, and they draw clean", () => {
  let drawnReseeds = 0, total = 0;
  for (const jitter of [0, 4, 8]) for (const dir of KEEP_DIRS) for (const done of KEEP_DONES) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 6, done, phase, startFrame, fix: true, ahead: 1, jitter };
    const r = keepCross(run);
    const label = `jitter=${jitter} dir=${dir} done=+${done} phase=${phase.toFixed(1)} start=${startFrame}`;
    expect({ label, plan: r.plan, head: r.headGap <= 3 }).toEqual({ label, plan: "keep", head: true });
    const a = afterDone(r, done);
    expect({ label, stalls: a.stalls, ok: a.min >= 0.25 * STEADY_144 && a.max <= 1.5 * STEADY_144, err: r.errLate < 0.5 })
      .toEqual({ label, stalls: 0, ok: true, err: true });
    total++;
    if (keepCross({ ...run, byDrawn: true }).plan === "reseed") drawnReseeds++;
  }
  // The flip the live probe saw: the drawn point reseeds a good part of the crossings, at random.
  expect(drawnReseeds).toBeGreaterThan(total / 4);
  expect(drawnReseeds).toBeLessThan(total);
});

test("keep path without the dating: the draw stands at the newest predicted sample, or steps back, in most of those crossings", () => {
  let failed = 0, stood = 0, total = 0;
  for (const dir of KEEP_DIRS) for (const done of KEEP_DONES) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const r = keepCross({ dir, ago: 6, done, phase, startFrame, fix: false });
    total++;
    if (r.stalls > 0 || r.minStep < 0) failed++;
    if (r.stalls > 0) stood++;
  }
  // 161 of the 216 stand or step back; 76 stand two frames or more (the live count was about half the crossings).
  expect(failed).toBeGreaterThan(total / 2);
  expect(stood).toBeGreaterThan(total / 4);
});

// Live (cluster test stack, 2026-10-29): the new node's catch-up step came 5 ms before a tick, which the resumed walk sits out
// (registered under half a tick before it), and the next tick ran 10 ms late: the second echo was sent 32 ms after the
// first, the third 7 ms after that. The second echo, dated as sent, drew one step in 32 ms: three frames at 0.6-0.7 x.
test("kept crossing, the new node's second step 1.5 ticks plus a late tick after its first: no frame under 0.85 x", () => {
  const bad: string[] = [];
  for (const frameHz of [72, 144]) for (const gaps of [[32, 7], [35, 4], [28, 11]]) for (const phase of [2, 5, 8]) for (const done of KEEP_DONES) for (const startFrame of KEEP_STARTS) {
    const r = keepCross({ dir: "left", ago: 6, done, phase, startFrame, fix: true, ahead: 1, frameHz, gaps, pace: true });
    const steady = 180 / frameHz;
    const a = afterDone(r, done);
    const label = `frame=${frameHz} gaps=${gaps} phase=${phase} done=+${done} start=${startFrame}`;
    if (r.plan !== "keep" || a.min < 0.85 * steady || a.max > 1.5 * steady || r.errLate >= 0.5) bad.push(`${label} plan=${r.plan} min=${(a.min / steady).toFixed(2)} max=${(a.max / steady).toFixed(2)} err=${r.errLate.toFixed(2)}`);
  }
  expect(bad).toEqual([]);
});

// The checks a held walk's frames must pass after HANDOFF_DONE: the steps drawn wholly at or after DONE's time (before
// it are the gap's own predicted samples, rounded to whole px, which this does not change).
function afterDone(r: ReturnType<typeof keepCross>, done: number) {
  const w = r.window.filter((x, i, all) => i > 0 && all[i - 1].at >= done);
  let stalls = 0;
  for (let i = 1; i < w.length; i++) if (w[i].step < 0.05 && w[i - 1].step < 0.05) stalls++;
  return { stalls, min: Math.min(...w.map((x) => x.step)), max: Math.max(...w.map((x) => x.step)) };
}

// ---- The walk begun at HANDOFF_BEGIN
//
// The old node stops stepping the player at the drain, then takes the lock, releases, saves and only then sends the
// SWITCH. Live on the test stack (node-3 to node-2): drained +35, saved +143, SWITCH at 193 ms. `S` in keepCross is the
// start of the gap walk: the SWITCH before HANDOFF_BEGIN (the last echo `ago` = the whole drain and save before it), the
// BEGIN now (the last echo a tick or less before it, DONE the drain, save and switch after it).

/**
 * The steps the new node makes up past the old node's last one (arrival.ts, round(idle / tick) - 1 on top of the first),
 * as `point` and `echoAhead` of keepCross: DONE's catchUpMs is counted when DONE is sent, the first echo's when the MOVEXY
 * runs right after it (`phase` later).
 */
function engineAhead(o: { done: number; phase: number; ago: number; hz?: number }): { ahead: number; echoAhead: number } {
  const tick = 1000 / (o.hz ?? 60);
  const steps = (ms: number) => Math.max(0, Math.round((ms + o.ago + 1) / tick) - 1);
  return { ahead: steps(o.done), echoAhead: steps(o.done + o.phase) };
}

/** The longest the draw stands (two frames or more under 0.05 px apart) between `from` ms of the gap start and `to`, in ms. */
function longestStand(r: ReturnType<typeof keepCross>, from: number, to: number): number {
  const w = r.all.filter((x) => x.rel >= from && x.rel <= to);
  let longest = 0, start: number | null = null;
  for (let i = 1; i < w.length; i++) {
    if (Math.abs(w[i].step) < 0.05) {
      start ??= w[i - 1].rel;
      longest = Math.max(longest, w[i].rel - start);
    } else start = null;
  }
  return longest;
}

/** The slowest and fastest frame, in steady frames, between `from` ms of the gap start and `to`. */
function frameRange(r: ReturnType<typeof keepCross>, from: number, to: number): { min: number; max: number } {
  const w = r.all.filter((x) => x.rel >= from && x.rel <= to);
  return { min: Math.min(...w.map((x) => x.step)) / STEADY_144, max: Math.max(...w.map((x) => x.step)) / STEADY_144 };
}

test("the blip: a gap walk started at the SWITCH, 150 ms after the last echo, stands the draw and reseeds at DONE", () => {
  for (const dir of KEEP_DIRS) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 150, done: 20, phase, startFrame, fix: true };
    const r = keepCross({ ...run, ...engineAhead(run) });
    const label = `dir=${dir} phase=${phase.toFixed(1)} start=${startFrame}`;
    // The draw reaches the last echo a playback delay after it came and stands there until the SWITCH.
    expect({ label, stood: longestStand(r, -200, 0) >= 80 }).toEqual({ label, stood: true });
    // The head starts from the last echo at the SWITCH: 150 ms of walk behind the node's point.
    expect({ label, plan: r.plan }).toEqual({ label, plan: "reseed" });
  }
});

test("the walk begun at HANDOFF_BEGIN: a drain, save and switch of 60 to 300 ms after it is kept, with no stand and every frame within 0.6-1.4 x steady", () => {
  for (const jitter of [0, 4, 8]) for (const ago of [2, 9, 16]) for (const done of [60, 120, 200, 300]) for (const dir of KEEP_DIRS) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago, done, phase, startFrame, fix: true, jitter, walkedOn: true };
    const r = keepCross({ ...run, ...engineAhead(run), endMs: 1000 + done + 600 });
    const label = `jitter=${jitter} ago=${ago} done=+${done} dir=${dir} phase=${phase.toFixed(1)} start=${startFrame}`;
    expect({ label, plan: r.plan }).toEqual({ label, plan: "keep" });
    expect({ label, stand: longestStand(r, -100, done + 300) }).toEqual({ label, stand: 0 });
    const range = frameRange(r, -100, done + 300);
    expect({ label, ok: range.min >= 0.6 && range.max <= 1.4, range }).toEqual({ label, ok: true, range });
  }
});

// The old node's last step went out as a datagram before HANDOFF_BEGIN, which is on the stream: it can come after it.
test("the old node's echo that comes after HANDOFF_BEGIN is dropped: kept, no stand, every frame within 0.6-1.4 x steady", () => {
  for (const lastLate of [1, 4, 8, 12, 20, 30, 45]) for (const done of [60, 200]) for (const dir of KEEP_DIRS) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 0, done, phase, startFrame, fix: true, walkedOn: true, lastLate, dropLate: true };
    // The walk starts from the echo before it, a tick earlier; the node's point counts from the late one.
    const r = keepCross({ ...run, ...engineAhead({ ...run, ago: 2 }), endMs: 1000 + done + 600 });
    const label = `late=${lastLate} done=+${done} dir=${dir} phase=${phase.toFixed(1)} start=${startFrame}`;
    expect({ label, plan: r.plan }).toEqual({ label, plan: "keep" });
    expect({ label, stand: longestStand(r, -100, done + 300) }).toEqual({ label, stand: 0 });
    const range = frameRange(r, -100, done + 300);
    expect({ label, ok: range.min >= 0.6 && range.max <= 1.4, range }).toEqual({ label, ok: true, range });
  }
});

test("socket.ts starts the gap walk at HANDOFF_BEGIN, goes on with it at the SWITCH, ends it at HANDOFF_STAY and drops the old node's echoes meanwhile", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const body = (head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  expect(src).toMatch(/case "HANDOFF_BEGIN": \{[^}]*beginHandoffGap\(data\);/);
  expect(src).toMatch(/case "HANDOFF_STAY": \{[^}]*stayAfterHandoffBegin\(data\);/);
  // The walk begins as the SWITCH began it (the direction walked now, a fresh echo), and moves wait for the next node.
  const begin = body("function beginHandoffGap(data: any) {");
  expect(begin).toContain("if (switchInProgress || isReconnecting) return;");
  expect(begin).toContain("cancelKeptWalk();");
  expect(begin).toContain("startHandoffGap(true, data?.report === true, data?.gapUpdates === true);");
  expect(begin).toContain("handoffBegun = true;");
  expect(begin).toContain("movementAllowed = false;");
  const start = body("function startHandoffGap(resume: boolean, report: boolean, updates: boolean) {");
  expect(start).toContain("walkDirectionAtSwitch = walkAtSwitch(pressedKeys, getStickDirection(), own?.lastServerUpdate, performance.now());");
  expect(start).toContain("own.handoffWalk = undefined;");
  // A new gap's report starts empty, its updates are numbered from AUTH's again, and none is waited for.
  expect(start).toContain("gapReports = report;\n  gapUpdates = report && updates;\n  gapLog.reset();\n  gapSeq = 0;\n  gapSentHeld = null;");
  expect(start).toContain("gapDoneWait = null;\n  ownEchoesFrom = 0;");
  // At the SWITCH a begun walk keeps its start, its direction and its walked time.
  const sw = body("async function switchNode(data: any) {");
  expect(sw).toContain("if (handoffBegun) handoffGap = handoffGap && data?.resume === true;\n    else startHandoffGap(data?.resume === true, data?.report === true, data?.gapUpdates === true);\n    handoffBegun = false;");
  expect(body("function endHandoffGap() {")).toContain("handoffBegun = false;");
  // Kept by the old node: the node's point is taken, the walked difference eased out, and moves are sent again.
  const stay = body("function stayAfterHandoffBegin(at: any) {");
  expect(stay).toContain("if (!handoffBegun || switchInProgress) return;");
  expect(stay).toContain("self.moveSamples = seedSamples(x, y, performance.now());");
  expect(stay).toContain("if (predicting && shown) startEase(self, shown, { x, y }, performance.now());");
  expect(stay).toContain("movementAllowed = true;");
  // The local player's echo is dropped while begun, before it is dated or pushed.
  const move = body('case "MOVEXY": {');
  const drop = move.indexOf("if (playerId == cachedPlayerId && handoffBegun) break;");
  expect(drop).toBeGreaterThan(-1);
  expect(drop).toBeLessThan(move.indexOf("keptWalkDating.date("));
});

test("taken as it comes, an echo 30 ms after HANDOFF_BEGIN sets the walked head back: crossings reseed", () => {
  let reseeds = 0;
  for (const dir of KEEP_DIRS) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 0, done: 60, phase, startFrame, fix: true, walkedOn: true, lastLate: 30 };
    if (keepCross({ ...run, ...engineAhead({ ...run, ago: 2 }), endMs: 1660 }).plan === "reseed") reseeds++;
  }
  expect(reseeds).toBeGreaterThan(0);
});

// Every tick rate a node may run at for this walk (60, 30, 20 Hz: 3, 6, 9 px a tick) and arrival spread 0, 4 or 8 ms,
// the new node's first step from a few ms to one tick after DONE. One assertion for every case: each check (no two
// frames in a row on one point, none under 0.25 x, none over 1.5 x, none backward) is met, or it is already failed
// without the dating and the dating is no worse on it (a stand longer than the render headroom, which the dating leaves:
// KEPT_HEADROOM_SLACK_MS). `ahead`: the node's point is 0 or 1 step past the last echo the client got (the live state
// is 1 at 60 Hz); a lead over HANDOFF_KEEP_LEAD_MS is reseeded, in both runs.
test("keep path at 60, 30 and 20 Hz with 0, 4 and 8 ms arrival spread: each check met, or no worse than without the dating; no drift", () => {
  const counts: Record<string, { cases: number; fixed: number; baseFailed: number }> = {};
  for (const hz of [60, 30, 20]) for (const jitter of [0, 4, 8]) for (const ahead of [0, 1]) {
    const tick = 1000 / hz;
    const c = (counts[`${hz}/${jitter}/${ahead}`] = { cases: 0, fixed: 0, baseFailed: 0 });
    for (const dir of KEEP_DIRS) for (const done of KEEP_DONES) for (const f of [0.12, 0.3, 0.48, 0.66, 0.84, 1]) for (const startFrame of KEEP_STARTS) {
      const run = { dir, ago: 6, done, phase: f * tick, startFrame, hz, jitter, ahead };
      const fixed = keepCross({ ...run, fix: true });
      const a = afterDone(fixed, done);
      const b = afterDone(keepCross({ ...run, fix: false }), done);
      const label = `hz=${hz} jitter=${jitter} ahead=${ahead} dir=${dir} done=+${done} phase=${f}T start=${startFrame}`;
      const checks = {
        stand: a.stalls === 0 || a.stalls <= b.stalls,
        slow: a.min >= 0.25 * STEADY_144 || a.min >= b.min - 1e-9,
        fast: a.max <= 1.5 * STEADY_144 || a.max <= b.max + 1e-9,
        back: a.min >= 0 || a.min >= b.min - 1e-9,
      };
      expect({ label, ...checks }).toEqual({ label, stand: true, slow: true, fast: true, back: true });
      expect({ label, ok: fixed.errLate < 0.5 }).toEqual({ label, ok: true });
      const meets = (m: typeof a) => m.stalls === 0 && m.min >= 0.25 * STEADY_144 && m.max <= 1.5 * STEADY_144;
      c.cases++;
      if (!meets(b)) c.baseFailed++;
      if (!meets(b) && meets(a)) c.fixed++;
    }
  }
  // At 60 Hz the dating mends almost every crossing that stands (all of them without spread).
  expect(counts["60/0/0"].fixed).toBe(counts["60/0/0"].baseFailed);
  expect(counts["60/4/0"].fixed).toBeGreaterThan(counts["60/4/0"].baseFailed * 0.8);
  expect(counts["60/8/0"].fixed).toBeGreaterThan(counts["60/8/0"].baseFailed * 0.4);
});

test("a crossing standing still (reseed path) draws exactly the same with and without the dating, and ends on the node's point", () => {
  for (const done of KEEP_DONES) for (const startFrame of KEEP_STARTS) {
    const a = keepCross({ dir: "right", ago: 6, done, phase: 5, startFrame, fix: true, held: false });
    const b = keepCross({ dir: "right", ago: 6, done, phase: 5, startFrame, fix: false, held: false });
    expect(a.plan).toBe("reseed");
    expect(a.window.map((r) => r.pos)).toEqual(b.window.map((r) => r.pos));
    expect(a.final).toEqual(a.point);
  }
});

test("keptWalkShift: dates a trailing echo where the predicted walk reaches it; 0 when not behind, none predicted, drawn past, or over the cap", () => {
  const base = () => [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
    { t: 24, x: 104, y: 0, predicted: true },
  ];
  // 103 is reached at 17: an echo of 103 dated 40 is 23 ms behind.
  expect(keptWalkShift(base(), 103, 0, 40, 0, 100, "right", false)).toBeCloseTo(23, 6);
  // Inside a segment: 102 is half way from 101 (10) to 103 (17).
  expect(keptWalkShift(base(), 102, 0, 40, 0, 100, "right", false)).toBeCloseTo(40 - 13.5, 6);
  // Past the newest predicted sample: extrapolated at 0.18 px/ms, 106 is reached 2 / 0.18 ms after 24.
  expect(keptWalkShift(base(), 106, 0, 40, 0, 100, "right", false)).toBeCloseTo(40 - (24 + 2 / 0.18), 6);
  // Ahead (dated before the walk reaches it): dated later, where the walk reaches it, up to KEPT_LEAD_SHIFT_MAX_MS.
  expect(keptWalkShift(base(), 106, 0, 30, 0, 100, "right", false)).toBeCloseTo(30 - (24 + 2 / 0.18), 6);
  expect(keptWalkShift(base(), 106, 0, 30, 0, 0, "right", false)).toBeCloseTo(30 - (24 + 2 / 0.18), 6);
  const far = 104 + KEPT_LEAD_SHIFT_MAX_MS * 0.18;
  expect(keptWalkShift(base(), far - 0.1, 0, 24, 0, 100, "right", false)).toBeLessThan(-KEPT_LEAD_SHIFT_MAX_MS + 1);
  expect(keptWalkShift(base(), far + 0.1, 0, 24, 0, 100, "right", false)).toBe(0);
  // Not past the sample before the predicted run, or no predicted run at all.
  expect(keptWalkShift(base(), 100, 0, 40, 0, 100, "right", false)).toBe(0);
  expect(keptWalkShift(base().map((s) => ({ ...s, predicted: false })), 103, 0, 40, 0, 100, "right", false)).toBe(0);
  // The draw is already past 17: dating 103 there would step back.
  expect(keptWalkShift(base(), 103, 0, 40, 18, 100, "right", false)).toBe(0);
  expect(keptWalkShift(base(), 103, 0, 40, 17, 100, "right", false)).toBeCloseTo(23, 6);
  // Over the render headroom plus KEPT_HEADROOM_SLACK_MS: not used (not clamped).
  expect(keptWalkShift(base(), 103, 0, 40, 0, 23 - KEPT_HEADROOM_SLACK_MS - 0.5, "right", false)).toBe(0);
  expect(keptWalkShift(base(), 103, 0, 40, 0, 23 - KEPT_HEADROOM_SLACK_MS + 0.5, "right", false)).toBeCloseTo(23, 6);
  // Over the cap, and no direction.
  expect(keptWalkShift(base(), 103, 0, 17 + KEPT_SHIFT_MAX_MS + 1, 0, 100, "right", false)).toBe(0);
  expect(keptWalkShift(base(), 103, 0, 40, 0, 100, "", false)).toBe(0);
  // Walking left reads the axis the other way.
  const left = base().map((s) => ({ ...s, x: 200 - s.x }));
  expect(keptWalkShift(left, 97, 0, 40, 0, 100, "left", false)).toBeCloseTo(23, 6);
});

const CLOCK = { renderAt: 0, headroom: 100, offset: null };

test("KeptWalkDating: unarmed it never moves a time (no cluster, reseed, cancel); armed, the shift falls away at 10% of the time that passes", () => {
  const samples = [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
  ];
  const idle = new KeptWalkDating();
  for (let k = 0; k < 10; k++) expect(idle.date(samples, 103 + k, 0, 40 + k * 17, 40 + k * 17, CLOCK, "right", false)).toBe(40 + k * 17);
  const cancelled = new KeptWalkDating();
  cancelled.arm(40);
  cancelled.cancel();
  expect(cancelled.date(samples, 103, 0, 40, 40, CLOCK, "right", false)).toBe(40);
  const d = new KeptWalkDating();
  d.arm(40);
  expect(d.date(samples, 103, 0, 40, 40, CLOCK, "right", false)).toBeCloseTo(17, 6); // shift 23
  // One tick later (3 px at 180 px/s): 10% of it less.
  expect(d.date(samples, 106, 0, 40 + 1000 / 60, 40 + 1000 / 60, CLOCK, "right", false)).toBeCloseTo(40 + 1000 / 60 - (23 - 1000 / 600), 6);
  // Gone 240 ms later.
  expect(d.date(samples, 140, 0, 300, 300, CLOCK, "right", false)).toBe(300);
  expect(d.date(samples, 143, 0, 300 + 1000 / 60, 300 + 1000 / 60, CLOCK, "right", false)).toBe(300 + 1000 / 60);
});

test("KeptWalkDating: an echo later than SETTLE_MS after the arming is dated as it comes", () => {
  const samples = [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
  ];
  const late = new KeptWalkDating();
  late.arm(40 - SETTLE_MS - 1);
  expect(late.date(samples, 103, 0, 40, 40, CLOCK, "right", false)).toBe(40);
  expect(late.date(samples, 106, 0, 57, 57, CLOCK, "right", false)).toBe(57);
  const inTime = new KeptWalkDating();
  inTime.arm(40 - SETTLE_MS);
  expect(inTime.date(samples, 103, 0, 40, 40, CLOCK, "right", false)).toBeCloseTo(17, 6);
});

test("KeptWalkDating: a drop of the clock offset after the first echo is taken into the shift, not dated earlier at once", () => {
  const samples = [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
  ];
  const d = new KeptWalkDating();
  d.arm(40);
  // The first echo came 6 ms later than the next: the new clock was learned from it, offset 100.
  expect(d.date(samples, 103, 0, 40, 40, { ...CLOCK, offset: 100 }, "right", false)).toBeCloseTo(17, 6);
  // The next echo lowers the offset to 94: sampleTime dates it 6 ms earlier than the first one's clock would. Taken
  // into the shift (23 - 6, less 1 ms of fall-away), it lands one tick after the first, not 6 ms short of one.
  const next = d.date(samples, 106, 0, 50.67, 56.67, { ...CLOCK, offset: 94 }, "right", false);
  expect(next).toBeCloseTo(50.67 - (23 - 6 - 1.667), 2);
  expect(next - 17).toBeGreaterThan(16);
});

// The kept walk's newest predicted sample is 103 at 17; an echo of 113 sent at 25 (10 px ahead) is dated 72.6, where the
// walk reaches it (47.6 ms later).
const aheadSamples = () => [
  { t: 0, x: 100, y: 0 },
  { t: 10, x: 101, y: 0, predicted: true },
  { t: 17, x: 103, y: 0, predicted: true },
];

test("KeptWalkDating: a stalled echo during a later dating is dated after the last one, drawn and kept (the player stops on it)", () => {
  const samples: { t: number; x: number; y: number; predicted?: boolean }[] = aheadSamples();
  const d = new KeptWalkDating();
  d.arm(25);
  const first = d.date(samples, 113, 0, 25, 25, CLOCK, "right", false);
  expect(first).toBeCloseTo(17 + 10 / 0.18, 6);
  expect(pushEcho(samples, 113, 0, first)).toBe(true);
  // The next echo is sent one tick later but arrives 250 ms later (a stalled stream), and is the last one: the player
  // stopped there. Falling by the arrival gap (25 ms) it would be dated 64.2, before 72.6, and dropped by pushEcho.
  const tick = 1000 / 60;
  const second = d.date(samples, 116, 0, 25 + tick, 25 + 250, CLOCK, "right", false);
  expect(second).toBeGreaterThan(first);
  // At the source: the shift fell by 10% of the tick it was sent after (not of the 250 ms), so it is a tick less that.
  expect(second - first).toBeCloseTo(tick * 0.9, 6);
  expect(pushEcho(samples, 116, 0, second)).toBe(true);
  expect(samples[samples.length - 1]).toEqual({ t: second, x: 116, y: 0 });
  expect(positionAt(samples, second + 1000)).toEqual({ x: 116, y: 0 });
  // Whatever the gaps, every dated time is later than the one before.
  const e = new KeptWalkDating();
  e.arm(25);
  let last = e.date(aheadSamples(), 113, 0, 25, 25, CLOCK, "right", false);
  let t = 25, now = 25;
  for (const [sentGap, arriveGap, offset] of [[tick, 400, null], [tick, 1, null], [0, 0, null], [tick, 300, 90], [tick, 200, 60], [1, 500, 60]] as const) {
    t += sentGap;
    now += arriveGap;
    const dated = e.date(aheadSamples(), 116, 0, t, now, { ...CLOCK, offset }, "right", false);
    expect({ t, dated, later: dated > last }).toEqual({ t, dated, later: true });
    last = dated;
  }
});

test("KeptWalkDating: a later dating is never more than KEPT_LEAD_SHIFT_MAX_MS after the arrival, an offset drop included", () => {
  // The first echo came 15 ms late (offset 100 learned from it), 58 ms short of where the walk reaches it.
  const x = 103 + 0.18 * (25 + 58 - 17);
  const d = new KeptWalkDating();
  d.arm(25);
  const first = d.date(aheadSamples(), x, 0, 25, 25, { ...CLOCK, offset: 100 }, "right", false);
  expect(first - 25).toBeCloseTo(58, 6);
  // The next comes on time: offset 85, so its time is 15 ms earlier than the first one's clock would give. The drop
  // added to the shift would date it 71 ms after its arrival.
  const t = 25 + 1000 / 60 - 15;
  const next = d.date(aheadSamples(), x + 3, 0, t, t, { ...CLOCK, offset: 85 }, "right", false);
  // Not at the cap and a 4.5 x burst (3 px in the 3.7 ms left to it): past it only as far as playing no faster than the catch-up speed needs.
  expect(next - t).toBeLessThanOrEqual(KEPT_LEAD_SHIFT_MAX_MS + (3 / 0.18) / KEPT_CATCHUP_SPEED + 1e-9);
  expect(3 / (next - first)).toBeLessThanOrEqual(0.18 * KEPT_CATCHUP_SPEED + 1e-9);
  expect(next).toBeGreaterThan(first);
});

test("planHandoffDone without a known direction: the distance is taken as the lead", () => {
  const server = { x: 500, y: 300 };
  const lead = HANDOFF_KEEP_LEAD_MS * 0.18;
  expect(planHandoffDone(true, true, { position: { x: 500 - lead + 0.5, y: 300 } }, server)).toBe("keep");
  expect(planHandoffDone(true, true, { position: { x: 500 - lead - 1, y: 300 } }, server)).toBe("reseed");
  // Either side: ahead or behind is not known.
  expect(planHandoffDone(true, true, { position: { x: 500 + lead + 1, y: 300 } }, server)).toBe("reseed");
  expect(planHandoffDone(true, true, { position: { x: 500, y: 300 }, lastDirection: "" }, server)).toBe("keep");
  expect(planHandoffDone(true, true, { position: { x: 500 - lead - 1, y: 300 }, mounted: true }, server)).toBe("keep");
});

test("socket.ts: LOAD_MAP cancels the kept-walk dating, HANDOFF_DONE arms it with the time and decides from the head", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("endHandoffGap();\n        cancelKeptWalk();\n        printHandoffMarks();");
  expect(src).toContain("keptWalkDating.arm(performance.now());");
  // The choice is made from the walked head (the player record), not from the drawn point.
  expect(src).toContain("planHandoffDone(predicting, moving, self, target, hasAnchor(self.moveSamples))");
});

// The node's point behind the walked head (stick/key step, finding B): the client walked the gap and the head is 5, 7 or 8
// px (28, 39 or 42 ms of walk) ahead of where the server stood the player, inside HANDOFF_KEEP_PX. The first echo is
// inside the predicted run, dated later than the walk reached its point by more than the render headroom allows
// (keptWalkShift gave up), so the samples after its point stayed and the draw ran on to them, then back to the echo.
const BEHIND_DONES = [28, 39, 42];
const BEHIND_DIRS = ["right", "left"];

test("kept crossing with the node's point 5, 7 or 8 px behind the head, 60 Hz: no back-step, no stand, no frame over 1.5 x steady, with 0, 4 and 8 ms spread", () => {
  let kept = 0, total = 0;
  for (const jitter of [0, 4, 8]) for (const dir of BEHIND_DIRS) for (const done of BEHIND_DONES) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const r = keepCross({ dir, ago: 6, done, phase, startFrame, fix: true, jitter });
    total++;
    const label = `jitter=${jitter} dir=${dir} done=+${done} phase=${phase.toFixed(1)} start=${startFrame}`;
    const a = afterDone(r, done);
    // (A head just over HANDOFF_KEEP_PX from the point after the frames' rounding is reseeded: not this path.)
    if (r.plan !== "keep") continue;
    kept++;
    expect({ label, back: a.min >= -1e-9, stalls: a.stalls, fast: a.max <= 1.5 * STEADY_144, slow: a.min >= 0.25 * STEADY_144, drift: r.errLate < 0.5 })
      .toEqual({ label, back: true, stalls: 0, fast: true, slow: true, drift: true });
  }
  expect(kept).toBeGreaterThan(total * 0.8);
});

test("kept crossing with the node's point behind the head at 60, 30 and 20 Hz: no back-step, none over 1.5 x steady; with spread no worse than without the fix", () => {
  const bad: string[] = [];
  for (const hz of [60, 30, 20]) for (const jitter of [0, 4, 8]) for (const dir of BEHIND_DIRS) for (const done of BEHIND_DONES) for (const f of [0.12, 0.3, 0.48, 0.66, 0.84, 1]) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 6, done, phase: f * (1000 / hz), startFrame, hz, jitter };
    const r = keepCross({ ...run, fix: true });
    if (r.plan !== "keep") continue;
    const a = afterDone(r, done);
    const b = afterDone(keepCross({ ...run, fix: false }), done);
    const label = `hz=${hz} jitter=${jitter} dir=${dir} done=+${done} phase=${f}T start=${startFrame}`;
    // A back-step never, with or without spread (a draw past the first echoes' point waits at its spot: KeptWalkDating
    // point). A step over 1.5 x steady never, or no worse than without the dating (the base's seam at 30/20 Hz).
    const back = a.min >= -1e-9;
    const fast = a.max <= 1.5 * STEADY_144 || a.max <= b.max + 1e-9;
    const stand = a.stalls <= b.stalls;
    if (!back || !fast || !stand || !(r.errLate < 0.5)) bad.push(`${label} back=${a.min.toFixed(2)}/${b.min.toFixed(2)} max=${(a.max / STEADY_144).toFixed(2)}/${(b.max / STEADY_144).toFixed(2)} stalls=${a.stalls}/${b.stalls} err=${r.errLate.toFixed(2)}`);
  }
  expect(bad).toEqual([]);
});

test("kept crossing with the node's point behind the head, without the cover: the draw steps back in most of them (60 Hz)", () => {
  // keptWalkCover off: the shift the headroom cannot cover is not used and the samples after the echo's point stay.
  let back = 0, total = 0;
  for (const dir of BEHIND_DIRS) for (const done of BEHIND_DONES) for (const phase of KEEP_PHASES) for (const startFrame of KEEP_STARTS) {
    const run = { dir, ago: 6, done, phase, startFrame };
    total++;
    if (afterDone(keepCross({ ...run, fix: false }), done).min < -1e-9) back++;
  }
  expect(back).toBeGreaterThan(total / 2);
});

test("keptWalkCover: a first echo inside the predicted run that keptWalkShift cannot cover is dated at the headroom's shift and the samples after its point go", () => {
  const run = () => [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
    { t: 24, x: 105, y: 0, predicted: true },
    { t: 31, x: 107, y: 0, predicted: true },
  ];
  // 103 is reached at 17; sent at 60 it is 43 ms behind. Headroom 10 allows 14: dated 46, the samples 105 and 107 go.
  const headroom = 10;
  expect(keptWalkShift(run(), 103, 0, 60, 0, headroom, "right", false)).toBe(0);
  const samples = run();
  expect(keptWalkCover(samples, 103, 0, 60, 0, headroom, "right", false)).toBeCloseTo(headroom + KEPT_HEADROOM_SLACK_MS, 6);
  expect(samples.map((s) => s.x)).toEqual([100, 101, 103]);
  expect(pushEcho(samples, 103, 0, 60 - (headroom + KEPT_HEADROOM_SLACK_MS))).toBe(true);
  // The draw is on the way: positions never go back along the list, and the drawn spot is the same before and after.
  const drawn = run();
  const before = positionAt(drawn, 15)!;
  keptWalkCover(drawn, 103, 0, 60, 15, headroom, "right", false);
  expect(positionAt(drawn, 15)).toEqual(before);
  pushEcho(drawn, 103, 0, 46);
  for (let i = 1; i < drawn.length; i++) expect(drawn[i].x).toBeGreaterThanOrEqual(drawn[i - 1].x);
  // The draw already past where the walk reached the point (at 17, drawn at 20): the drawn spot is kept as a sample, so the
  // draw does not jump, and what is after the point goes.
  const past = run();
  const there = positionAt(past, 20)!;
  keptWalkCover(past, 103, 0, 60, 20, headroom, "right", false);
  expect(past.filter((s) => s.t === 20 && s.predicted).length).toBe(1);
  expect(positionAt(past, 20)).toEqual(there);
  expect(past.filter((s) => s.t !== 20).some((s) => s.x > 103)).toBe(false);
  // Walking left.
  const left = run().map((s) => ({ ...s, x: 200 - s.x }));
  keptWalkCover(left, 97, 0, 60, 0, headroom, "left", false);
  expect(left.map((s) => s.x)).toEqual([100, 99, 97]);
  // Nothing changes when the shift is covered, the point is past the newest sample, there is no run or no direction.
  for (const [x, t, hr, dir, tail] of [[103, 40, 100, "right", true], [110, 60, 10, "right", true], [103, 60, 10, "", true], [103, 60, 10, "right", false]] as const) {
    const s = run().map((q) => ({ ...q, predicted: tail ? q.predicted : false }));
    const copy = JSON.stringify(s);
    expect(keptWalkCover(s, x, 0, t, 0, hr, dir, false)).toBe(0);
    expect(JSON.stringify(s)).toBe(copy);
  }
});

test("KeptWalkDating: a first echo behind the walked head is dated at the headroom's shift, then the next ones fall away from it", () => {
  const run = () => [
    { t: 0, x: 100, y: 0 },
    { t: 10, x: 101, y: 0, predicted: true },
    { t: 17, x: 103, y: 0, predicted: true },
    { t: 24, x: 105, y: 0, predicted: true },
  ];
  const clock = { renderAt: 0, headroom: 10, offset: null };
  const d = new KeptWalkDating();
  d.arm(60);
  const samples = run();
  const first = d.date(samples, 103, 0, 60, 60, clock, "right", false);
  expect(first).toBeCloseTo(60 - (10 + KEPT_HEADROOM_SLACK_MS), 6);
  expect(pushEcho(samples, 103, 0, first)).toBe(true);
  expect(samples.some((s) => s.x > 103)).toBe(false);
  const tick = 1000 / 60;
  const second = d.date(samples, 106, 0, 60 + tick, 60 + tick, clock, "right", false);
  // An earlier dating falls away by a tenth of the time that passes: the draw plays 10% slow meanwhile.
  expect(second - first).toBeCloseTo(tick * 1.1, 6);
  // Unarmed (no cluster, reseed): the same call changes nothing.
  const idle = run();
  expect(new KeptWalkDating().date(idle, 103, 0, 60, 60, clock, "right", false)).toBe(60);
  expect(idle).toEqual(run());
});

test("keptWalkCover: the draw already past the echo's point with the shift within the bound still removes the samples after the point", () => {
  // Predicted run every 14 ms at 0.18 px/ms to t=100; the walk reached 113.5 at 75; the echo is dated 105 (shift 30, bound
  // 32.3 at 60 Hz) and the last frame drew at 80, past the point: keptWalkShift gives up, the samples used to stay.
  const run = () => {
    const out: { t: number; x: number; y: number; predicted?: boolean }[] = [{ t: 0, x: 100, y: 0 }];
    for (let t = 14; t <= 98; t += 14) out.push({ t, x: 100 + 0.18 * t, y: 0, predicted: true });
    out.push({ t: 100, x: 118, y: 0, predicted: true });
    return out;
  };
  const headroom = 1000 / 60 > 0 ? 45 - 1000 / 60 : 0;
  expect(keptWalkShift(run(), 113.5, 0, 105, 80, headroom, "right", false)).toBe(0);
  const samples = run();
  const drawn = positionAt(samples, 80)!;
  const shift = keptWalkCover(samples, 113.5, 0, 105, 80, headroom, "right", false);
  expect(shift).toBeGreaterThan(0);
  expect(shift).toBeLessThanOrEqual(headroom + KEPT_HEADROOM_SLACK_MS);
  expect(samples.filter((s) => s.x > 113.5 && s.t !== 80)).toEqual([]);
  expect(positionAt(samples, 80)).toEqual(drawn);
  // Through KeptWalkDating: the echo is pushed after the removed samples, none of the old ones is ahead of it.
  const d = new KeptWalkDating();
  d.arm(105);
  const again = run();
  const at = d.date(again, 113.5, 0, 105, 105, { renderAt: 80, headroom, offset: null }, "right", false);
  expect(at).toBeGreaterThan(80);
  expect(pushEcho(again, 113.5, 0, at)).toBe(true);
  expect(again.filter((s) => s.x > 113.5 && s.t !== 80)).toEqual([]);
});

test("KeptWalkDating: a draw past the first echoes' point waits at its spot (never back), then walks to the first echo past it, no faster than the walk", () => {
  // The reviewer's case: the walk reached 113.5 at 75, the draw is at 80 (x 114.4), echoes come at 0.18 px/ms steps of 3 px.
  const run = () => {
    const out: { t: number; x: number; y: number; predicted?: boolean; held?: boolean }[] = [{ t: 0, x: 100, y: 0 }];
    for (let t = 14; t <= 98; t += 14) out.push({ t, x: 100 + 0.18 * t, y: 0, predicted: true });
    return out;
  };
  const clock = { renderAt: 80, headroom: 45 - 1000 / 60, offset: null };
  const samples = run();
  const spot = positionAt(samples, 80)!;
  const d = new KeptWalkDating();
  d.arm(105);
  const dates: number[] = [];
  const push = (x: number, t: number) => {
    const at = d.date(samples, x, 0, t, t, clock, "right", false);
    const pt = d.point(x, 0);
    expect(pushEcho(samples, pt.x, pt.y, at)).toBe(true);
    if (pt.held) Object.assign(samples[samples.length - 1], { held: true, heldUntil: pt.until });
    dates.push(at);
    return pt;
  };
  // 113.5 and 116.5 are behind the spot (114.4... and 116.2 is not: the spot is 114.4): the first is held, the next is past it.
  const first = push(113.5, 105);
  expect({ x: first.x, y: first.y, held: first.held }).toEqual({ x: spot.x, y: 0, held: true });
  const second = push(113.5 + 3, 105 + 1000 / 60);
  expect(second.held).toBe(false);
  push(113.5 + 6, 105 + 2000 / 60);
  // Dates strictly increase, positions never go back along the list, and no step is faster than the walk (0.18 px/ms).
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i].t).toBeGreaterThan(samples[i - 1].t);
    expect(samples[i].x).toBeGreaterThanOrEqual(samples[i - 1].x - 1e-9);
    if (samples[i].t - samples[i - 1].t > 1) expect((samples[i].x - samples[i - 1].x) / (samples[i].t - samples[i - 1].t)).toBeLessThanOrEqual(0.18 + 1e-6);
  }
  expect(dates[0]).toBeGreaterThan(80);
  // The shift still falls away: far later the echoes are dated as they come.
  expect(d.date(samples, 200, 0, 900, 900, clock, "right", false)).toBe(900);
  expect(d.point(200, 0)).toEqual({ x: 200, y: 0, held: false, until: 0 });
});

// The hold's end (round 3): the spot is let go on a stop, a turn, a teleport, a timeout, a cancel, whatever the echoes do.
function holding() {
  const samples: { t: number; x: number; y: number; predicted?: boolean; held?: boolean; heldUntil?: number }[] = [{ t: 0, x: 100, y: 0 }];
  for (let t = 14; t <= 98; t += 14) samples.push({ t, x: 100 + 0.18 * t, y: 0, predicted: true });
  const clock = { renderAt: 80, headroom: 45 - 1000 / 60, offset: null };
  const d = new KeptWalkDating();
  d.arm(105);
  const push = (x: number, t: number, direction = "right") => {
    const at = d.date(samples, x, 0, t, t, clock, direction, false);
    const pt = d.point(x, 0);
    expect(pushEcho(samples, pt.x, pt.y, at)).toBe(true);
    if (pt.held) Object.assign(samples[samples.length - 1], { held: true, heldUntil: pt.until });
    return { at, pt };
  };
  return { samples, d, push };
}

test("the hold: a held echo then silence (key let go): the renderer takes the real position after HOLD_MAX_MS, the draw reaches the server's x", () => {
  const { samples, push } = holding();
  const first = push(113.5, 105);
  expect(first.pt.held).toBe(true);
  const last = samples[samples.length - 1];
  expect(last.held).toBe(true);
  expect(last.heldUntil).toBeCloseTo(105 + HOLD_MAX_MS, 6);
  const server = { x: 113.5, y: 0 };
  // Inside the window the held spot stays; after it the position is a step (the rule the renderer calls).
  expect(needsPositionSample(last, server, 105 + HOLD_MAX_MS - 1)).toBe(false);
  expect(needsPositionSample(last, server, 105 + HOLD_MAX_MS + 1)).toBe(true);
  // The renderer then pushes it after the last sample, as it does for any position set outside a packet: the draw ends there.
  pushSample(samples, server.x, server.y, last.t + 0.01);
  expect(positionAt(samples, last.t + 1000)).toEqual(server);
  // Without the expiry (a held flag with no deadline) the position would never be taken.
  expect(needsPositionSample({ ...last, heldUntil: undefined }, server, 1e9)).toBe(true);
  expect(needsPositionSample({ ...last, held: false }, server, 105)).toBe(true);
  expect(needsPositionSample(undefined, server, 0)).toBe(true);
  expect(needsPositionSample({ t: 1, x: 5, y: 0 }, { x: 5, y: 0 }, 0)).toBe(false);
});

test("the hold: a stop, a turn, a teleport or a late echo ends it and the echo goes in as it is, the spots let go", () => {
  for (const [label, x, direction, t] of [
    ["stop (not further than the echo before)", 113.5, "right", 105 + 17],
    ["turn", 112, "left", 105 + 17],
    ["teleport", 400, "right", 105 + 17],
    ["late (past HOLD_MAX_MS)", 114, "right", 105 + HOLD_MAX_MS + 5],
  ] as const) {
    const { samples, d, push } = holding();
    push(113.5, 105);
    if (label.startsWith("late")) push(113.9 - 0.2, 105 + 10);
    expect(samples.some((s) => s.held)).toBe(true);
    const next = push(x, t, direction);
    expect({ label, held: next.pt.held, x: next.pt.x }).toEqual({ label, held: false, x });
    expect({ label, left: samples.filter((s) => s.held).length }).toEqual({ label, left: 0 });
    // And it is plain dating from now on: the next echo is not replaced either.
    expect(d.point(x + 1, 0).held).toBe(false);
  }
});

test("the hold: cancel() and clearHeld() let go of the held spots (LOAD_MAP, a switch, a closed socket)", () => {
  const { samples, d, push } = holding();
  push(113.5, 105);
  expect(samples[samples.length - 1].held).toBe(true);
  d.cancel();
  expect(d.point(1, 2)).toEqual({ x: 1, y: 2, held: false, until: 0 });
  clearHeld(samples);
  expect(samples.some((s) => s.held || s.heldUntil !== undefined)).toBe(false);
  // Cancelled, the next echo is dated as it comes and not replaced.
  const at = d.date(samples, 113.5, 0, 200, 200, { renderAt: 80, headroom: 28, offset: null }, "right", false);
  expect(at).toBe(200);
  expect(d.point(113.5, 0).held).toBe(false);
});

test("renderer.ts calls needsPositionSample for the position step, socket.ts leaves the settle armed on a held echo and cancels through cancelKeptWalk", async () => {
  const text = async (name: string) => (await Bun.file(new URL("../webserver/public/js/core/" + name, import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(await text("renderer.ts")).toContain("if (needsPositionSample(last, player.position, now)) {");
  const src = await text("socket.ts");
  expect(src).toContain("if (playerId == cachedPlayerId && !drawnPoint.held) handoffSettle.cancel();");
  expect(src).toContain("clearHeld(own?.moveSamples);");
  expect(src.split("keptWalkDating.cancel()").length - 1).toBe(1);
});

// The live burst (60 Hz node, 3 px a step): the new node resumes the walk with its own mover, so its first echoes are not
// on the tick cadence: the 2nd and 3rd are sent 4-6 ms apart (the 1st-2nd gap is a long one). Dated by send time, 3 px
// plays in 4-7 ms and one frame steps 1.7-1.9 x the steady step. The dating holds each echo to the walking time after the
// one before it (less the slew), so the draw never plays a segment faster than the walk.
const BURST_GAPS = [[16.7, 4], [21, 6], [25, 10], [14, 5], [30, 4]];

test("kept crossing with a short gap between the 2nd and 3rd echo: no frame above 1.5 x the steady step at 144 and 72 Hz, none backward, none stood", () => {
  let cases = 0;
  for (const frameHz of [144, 72]) for (const [g1, g2] of BURST_GAPS) for (const dir of KEEP_DIRS) for (const done of KEEP_DONES) for (const phase of [2, 8, 14]) for (const startFrame of KEEP_STARTS) for (const jitter of [0, 3]) {
    const r = keepCross({ dir, ago: 6, done, phase, startFrame, fix: true, ahead: 1, frameHz, gaps: [g1, g2], jitter });
    const a = afterDone(r, done);
    const label = `frame=${frameHz} gaps=${g1}/${g2} dir=${dir} done=+${done} phase=${phase} start=${startFrame} jitter=${jitter}`;
    expect({ label, plan: r.plan }).toEqual({ label, plan: "keep" });
    expect({ label, stalls: a.stalls, back: a.min >= 0, fast: a.max <= 1.5 * (180 / frameHz), err: r.errLate < 0.5 })
      .toEqual({ label, stalls: 0, back: true, fast: true, err: true });
    cases++;
  }
  expect(cases).toBe(2 * 5 * 3 * 3 * 3 * 4 * 2);
});

test("KeptWalkDating: two echoes 5 ms apart for 3 px are dated the walking time (less the slew) apart; later ones fall back to the send times", () => {
  const dating = new KeptWalkDating();
  const samples: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
  dating.arm(1000);
  const clock = { renderAt: 0, headroom: 100, offset: null };
  const send = [1000, 1021, 1026, 1043, 1060, 1076, 1093, 1110, 1126];
  const dated: number[] = [];
  send.forEach((t, k) => { dated.push(dating.date(samples, 110 + 3 * k, 0, t, t + 1, clock, "right", false)); });
  // 3 px at 180 px/s is 16.67 ms; the floor is 90% of it.
  expect(dated[2] - dated[1]).toBeCloseTo(15, 6);
  // The lateness this added falls away: every gap is at least the floor, none shorter than the walk less the slew, and the
  // dated time ends within a ms of the send time's own shift.
  for (let k = 1; k < dated.length; k++) expect(dated[k] - dated[k - 1]).toBeGreaterThanOrEqual(15 - 1e-9);
  expect(dated[dated.length - 1] - dated[3]).toBeLessThan(send[8] - send[3] + 1e-9 + 0.1 * (send[8] - send[3]));
  // Mounted walks 1.35 x as fast: the floor is shorter. A diagonal moves the same px on both axes: twice the progress.
  const m = new KeptWalkDating();
  m.arm(1000);
  const ms: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
  m.date(ms, 110, 0, 1000, 1001, clock, "right", true);
  const a = m.date(ms, 113, 0, 1021, 1022, clock, "right", true);
  const b = m.date(ms, 116, 0, 1026, 1027, clock, "right", true);
  expect(b - a).toBeCloseTo((3 / (0.18 * 1.35)) * 0.9, 6);
  const d = new KeptWalkDating();
  d.arm(1000);
  const ds: any[] = [{ t: 0, x: 100, y: 100 }, { t: 40, x: 110, y: 110, predicted: true }];
  d.date(ds, 110, 110, 1000, 1001, clock, "downright", false);
  const da = d.date(ds, 113, 113, 1021, 1022, clock, "downright", false);
  const db = d.date(ds, 116, 116, 1026, 1027, clock, "downright", false);
  expect(db - da).toBeCloseTo(((6 / (0.18 * 2)) * 0.9), 6);
});

test("KeptWalkDating: the floor is only in the window after a kept DONE (SETTLE_MS), never unarmed or after a cancel, and never past the arrival cap", () => {
  const clock = { renderAt: 0, headroom: 100, offset: null };
  const run = (arm: boolean, cancel: boolean, at: number) => {
    const dating = new KeptWalkDating();
    const s: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
    if (arm) dating.arm(1000);
    dating.date(s, 110, 0, at, at + 1, clock, "right", false);
    if (cancel) dating.cancel();
    dating.date(s, 113, 0, at + 21, at + 22, clock, "right", false);
    return dating.date(s, 116, 0, at + 26, at + 27, clock, "right", false) - (at + 26);
  };
  expect(run(false, false, 1000)).toBe(0);
  expect(run(true, true, 1000)).toBe(0);
  expect(run(true, false, 1000)).toBeGreaterThan(5);
  // The first echo after SETTLE_MS is not the walk's continuation: dated as it comes, no floor.
  expect(run(true, false, 1000 + SETTLE_MS + 10)).toBe(0);
  // Never more than KEPT_CATCHUP_LEAD_MAX_MS after an arrival (KEPT_LEAD_SHIFT_MAX_MS but for a catch-up).
  const cap = new KeptWalkDating();
  const cs: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
  cap.arm(1000);
  cap.date(cs, 110, 0, 1000, 1001, clock, "right", false);
  const far = cap.date(cs, 200, 0, 1005, 1006, clock, "right", false);
  expect(far).toBeLessThanOrEqual(1006 + KEPT_CATCHUP_LEAD_MAX_MS + 1e-9);
});

// The jump after a hold (the 12.4 px frame, live): a draw past the first echo's point stands at a spot (KeptWalkDating
// hold) dated at the draw's time when the hold began. When the link stalls (the echoes of 30-110 ms come together) the
// hold ends with the next echo ahead of the spot, and the chord from the spot, dated that long ago, had the draw part way
// along it at once. The spot now leaves at the draw's time (never earlier), and the echo is dated no earlier than the
// walking time after it. 60 Hz node whose first echo comes late (a hold needs the draw past it), node's point 3 px behind the head.
test("kept crossing with a hold and a stall of the link of 30 to 90 ms: the draw leaves the held spot at the walk's pace, no jump above the plain stall's", () => {
  let held = 0, cases = 0;
  for (const frameHz of [72, 144]) for (const dir of ["right", "left"]) for (const done of [39, 42, 48]) for (const startFrame of [0.3, 4]) for (const jitter of [0, 8]) for (const len of [30, 60, 90]) {
    const run = { dir, ago: 6, done, phase: 1000 / 30, startFrame, hz: 60, jitter, ahead: 0, frameHz, stall: { from: 45, until: 45 + len } };
    const r = keepCross({ ...run, fix: true });
    const a = afterDone(r, done);
    const b = afterDone(keepCross({ ...run, fix: false }), done);
    const steady = 180 / frameHz;
    const label = `frame=${frameHz} dir=${dir} done=+${done} start=${startFrame} jitter=${jitter} stall=${len}`;
    cases++;
    if (r.plan !== "keep" || r.heldFrames === 0) continue;
    held++;
    // 16 px of walk (90 ms) cannot be played in one frame, but at 3.5 x steady at most (the walk's own pace is 1 x), and a
    // 60 ms stall (11 px) within 1.5 x: the draw leaves the spot when the walk would, not part way along.
    expect({ label, back: a.min >= -1e-9, ok: a.max <= (len <= 60 ? 1.5 : 3.5) * steady && a.max <= b.max + 1e-9 })
      .toEqual({ label, back: true, ok: true });
  }
  expect(cases).toBe(2 * 2 * 3 * 2 * 2 * 3);
  expect(held).toBeGreaterThanOrEqual(12);
});

test("KeptWalkDating: a held spot's chord leaves at the draw's time when the hold ends with the echo ahead of it (stall, timeout), at the walking pace, a teleport is not stretched", () => {
  const clock = { renderAt: 300, headroom: 28, offset: null };
  const setup = () => {
    const { samples, d, push } = holding();
    const first = push(113.5, 105);
    expect(first.pt.held).toBe(true);
    return { samples, d, push };
  };
  // The echo comes 250 ms later (a stall), 18 px on: 8 px past the keep radius from the spot, ahead of it. Dated at its
  // send time it would be 150 ms before the draw; the spot (at 105 in the list) is not left at 105.
  const { samples, d } = setup();
  const spot = samples[samples.length - 1];
  const at = d.date(samples, 131.5, 0, 355, 355, clock, "right", false);
  const pt = d.point(131.5, 0);
  expect(pt.held).toBe(false);
  expect(pushEcho(samples, pt.x, pt.y, at)).toBe(true);
  expect(samples.some((s) => s.held)).toBe(false);
  // A sample of the spot at the draw's time (300) or later: the chord does not start behind the draw.
  const left = samples.filter((s) => s.x === spot.x && s.t >= clock.renderAt);
  expect(left.length).toBeGreaterThan(0);
  const echo = samples[samples.length - 1];
  const from = left[left.length - 1];
  expect(from.t).toBeGreaterThanOrEqual(clock.renderAt);
  // And the chord is no faster than the walk plus the slew (0.18 / 0.9 px/ms, as the first-echo shift falls away), within the cap.
  const chord = (echo.x - from.x) / (echo.t - from.t);
  expect(chord).toBeLessThanOrEqual(0.18 / 0.9 + 1e-9);
  expect(echo.t).toBeLessThanOrEqual(355 + KEPT_LEAD_SHIFT_MAX_MS + 1e-9);
  // The draw at the render time is where the spot was, not part way along the chord.
  expect(positionAt(samples, clock.renderAt)!.x).toBeCloseTo(spot.x, 6);
  // A teleport ends the hold as before: dated as it comes, not held to a walking time.
  const t = setup();
  expect(t.d.date(t.samples, 400, 0, 355, 355, clock, "right", false)).toBe(355);
});

// Fix round 1 (burst review I-2): a hold that ends by heldUntil (the key was let go, no echo past the spot) used to push the
// real position at last.t + 0.01, an instant step back of the overshoot (3-8 px). It is now reached at the walking speed.
test("a hold that times out by heldUntil with a 3-8 px overshoot: no back-step faster than the walk, none forward, at 144 and 72 Hz", () => {
  for (const frameHz of [144, 72]) for (const overshoot of [3, 5, 8]) for (const mounted of [false, true]) {
    const walk = (0.18 * (mounted ? 1.35 : 1));
    const frameMs = 1000 / frameHz;
    const spotX = 200, posX = spotX - overshoot;
    const samples: any[] = [{ t: 0, x: 150, y: 0 }, { t: 100, x: spotX, y: 0, held: true, heldUntil: 300 }];
    let prev = positionAt(samples, 100)!.x;
    let worstBack = 0, worstFwd = 0;
    for (let now = 150; now < 600; now += frameMs) {
      const last = samples[samples.length - 1];
      if (needsPositionSample(last, { x: posX, y: 0 }, now)) {
        if (last.held) releaseHeld(samples, posX, 0, now - 45, mounted);
        else pushSample(samples, posX, 0, last.t + 0.01);
      }
      const x = positionAt(samples, now - 45)!.x;
      worstBack = Math.max(worstBack, prev - x);
      worstFwd = Math.max(worstFwd, x - prev);
      prev = x;
    }
    const label = `frame=${frameHz} overshoot=${overshoot} mounted=${mounted}`;
    expect({ label, back: worstBack <= walk * frameMs * 1.05 + 1e-6, fwd: worstFwd <= 1e-9, end: prev }).toEqual({ label, back: true, fwd: true, end: posX });
  }
});

test("renderer.ts takes the position of a timed-out held spot through releaseHeld", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("releaseHeld(samples, player.position.x, player.position.y, at, atMountSpeed(player));");
});

// Fix round 2: a warp onto a timed-out held spot is not an overshoot to ease (the eased date would be seconds ahead and
// refuse the echoes after it): it goes in as before and snaps.
test("a warp far beyond HANDOFF_KEEP_PX onto a timed-out held spot snaps at once, and the next echoes are accepted and drawn", () => {
  for (const jump of [HANDOFF_KEEP_PX + 1, 50, 99, 500, 5000]) {
    const samples: any[] = [{ t: 0, x: 150, y: 0 }, { t: 100, x: 200, y: 0, held: true, heldUntil: 300 }];
    const target = 200 + jump;
    releaseHeld(samples, target, 0, 400, false);
    const label = `jump=${jump}`;
    // The newest sample is at the old path's time, not seconds on.
    expect({ label, ok: samples[samples.length - 1].t < 101 }).toEqual({ label, ok: true });
    expect({ label, x: positionAt(samples, 400)!.x }).toEqual({ label, x: target });
    // Echoes dated now are accepted and the draw reaches them.
    expect({ label, ok: pushEcho(samples, target + 3, 0, 410) }).toEqual({ label, ok: true });
    expect({ label, x: positionAt(samples, 420)!.x }).toEqual({ label, x: target + 3 });
  }
});

// Resid: what was left after the burst fix. The live echo pattern after a kept DONE (60 Hz node, 3 px a step): the first echo
// 1-23 ms after the last gap step, the 2nd 18-21 ms after it, the 3rd 4-6 or 13-16 ms after that, then the tick. Frames of
// 1.36-1.53 x the walk came 1-2 frames after DONE (the gap walk's first step: a whole frame of walk from the last echo,
// which the player left up to a tick before, dated at the frame's time: a 3 px chord in 6 ms) followed by 0.5-0.75 x
// (a late 2nd echo played at the slew's pace, the 5 ms one floored) and ~150 ms of 0.9 x.
const LIVE_GAPS = [[18, 5], [21, 4], [19, 6], [18, 14], [20, 16], [21, 13]];
const sinceDone = (r: ReturnType<typeof keepCross>, done: number, ms: number) => r.all.filter((x) => x.rel >= done && x.rel <= done + ms);

test("kept crossing with the live echo pattern, 72 and 144 Hz: no frame above 1.25 x the steady step or below 0.6 x in the 300 ms after DONE", () => {
  let cases = 0;
  for (const frameHz of [72, 144]) for (const dir of KEEP_DIRS) for (const done of [16, 19, 22, 28, 39]) for (const [g1, g2] of LIVE_GAPS) for (const phase of [2, 8, 14]) for (const startFrame of [0.3, 2, 4, 9]) {
    const r = keepCross({ dir, ago: 6, done, phase, startFrame, fix: true, ahead: 1, frameHz, gaps: [g1, g2] });
    const steps = sinceDone(r, done, 300).map((x) => x.step / (180 / frameHz));
    const label = `frame=${frameHz} dir=${dir} done=+${done} gaps=${g1}/${g2} phase=${phase} start=${startFrame}`;
    expect({ label, plan: r.plan }).toEqual({ label, plan: "keep" });
    expect({ label, ok: Math.max(...steps) <= 1.25 && Math.min(...steps) >= 0.6 }).toEqual({ label, ok: true });
    cases++;
  }
  expect(cases).toBe(2 * 3 * 5 * 6 * 3 * 4);
});

test("KeptWalkDating with the live echo pattern: no segment is played slower than 0.9 x or faster than 1.11 x the walk", () => {
  // Per segment of the dated list: 3 px between two echoes (dated times from KeptWalkDating, after the first).
  for (const [g1, g2] of LIVE_GAPS) for (const first of [2, 8, 14, 20]) {
    const dating = new KeptWalkDating();
    const samples: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
    dating.arm(1000);
    const clock = { renderAt: 0, headroom: 28, offset: null };
    const send = [1000 + first, 1000 + first + g1, 1000 + first + g1 + g2];
    for (let k = 3; k < 12; k++) send.push(send[k - 1] + 1000 / 60);
    const dated = send.map((t, k) => dating.date(samples, 112 + 3 * k, 0, t, t + 1, clock, "right", false));
    const label = `gaps=${g1}/${g2} first=${first}`;
    for (let k = 1; k < dated.length; k++) {
      const gap = dated[k] - dated[k - 1];
      expect({ label, k, ok: gap >= 15 - 1e-9 && gap <= 3 / 0.18 / 0.9 + 1e-9 }).toEqual({ label, k, ok: true });
    }
  }
});

test("gapSampleTime dates a predicted step no earlier than its walking time after the newest sample; gapStepMs walks the first step the time since the echo", () => {
  // 3 px at 180 px/s is 16.7 ms: at the frame's time (13 ms after the echo) it would play at 1.28 x.
  expect(gapSampleTime(1013, 1000, 0, stepWalkMs({ x: 100, y: 0 }, 103, 0, false))).toBeCloseTo(1000 + 3 / 0.18, 6);
  expect(gapSampleTime(1030, 1000, 0, stepWalkMs({ x: 100, y: 0 }, 103, 0, false))).toBe(1030);
  expect(gapSampleTime(1013, 1000, 2, 0)).toBe(1011);
  expect(stepWalkMs({ x: 0, y: 0 }, 3, 3, false)).toBeCloseTo(3 / 0.18, 6);
  expect(stepWalkMs({ x: 0, y: 0 }, 3, 0, true)).toBeCloseTo(3 / (0.18 * 1.35), 6);
  // The first step of the gap walks from the last echo's time (1 ms of lateness), the next ones a frame; nothing old is walked.
  expect(gapStepMs(6.9, false, 1010, { t: 1000 }, 1)).toBeCloseTo(9, 6);
  expect(gapStepMs(6.9, true, 1010, { t: 1000 }, 1)).toBe(6.9);
  expect(gapStepMs(6.9, false, 1010, { t: 1000, predicted: true }, 1)).toBe(6.9);
  expect(gapStepMs(6.9, false, 1500, { t: 1000 }, 1)).toBe(6.9);
  expect(gapStepMs(6.9, false, 1010, undefined, 1)).toBe(6.9);
});

// The live dip: the old node drained a tick before the switch, the echo was 36.6 ms old at the first gap frame, and the
// step was cut to two frames (27.8 ms): the gap walk fell 1.6 px short and was drawn at 0.74 times the walk for 3 frames.
test("gapStepMs walks all the time since the echo when the walk at the switch is still held, as the new node makes it up", () => {
  expect(gapStepMs(13.9, false, 1040, { t: 1000 }, 3.4, true)).toBeCloseTo(36.6, 6);
  expect(gapStepMs(13.9, false, 1040, { t: 1000 }, 3.4)).toBeCloseTo(27.8, 6);
  // Live (cluster test stack, 2026-10-29): the old node's last step was 62 ms old at the first gap frame. Walked for a
  // frame only, the gap walk fell 9 px short, drew at 0.2-0.3 x for 5 frames and the head missed the node's point (a reseed).
  // Held, the walk goes on for all of it, up to the most the new node makes up (HANDOFF_CATCH_UP_MAX_MS).
  expect(gapStepMs(13.9, false, 1062, { t: 1000 }, 0, true)).toBeCloseTo(62, 6);
  expect(gapStepMs(13.9, false, 1100, { t: 1000 }, 3.4, true)).toBeCloseTo(96.6, 6);
  expect(gapStepMs(13.9, false, 1000 + HANDOFF_CATCH_UP_MAX_MS + 1, { t: 1000 }, 0, true)).toBe(13.9);
  // Not held, older than MAX_FIRST_STEP_MS: a frame. A step started later, or the walk's own steps: a frame, held or not.
  expect(gapStepMs(13.9, false, 1100, { t: 1000 }, 3.4)).toBe(13.9);
  expect(gapStepMs(13.9, true, 1040, { t: 1000 }, 3.4, true)).toBe(13.9);
  expect(gapStepMs(13.9, false, 1040, { t: 1000, predicted: true }, 3.4, true)).toBe(13.9);
});

test("renderer.ts dates the gap walk's steps by their walking time and walks the first one from the last echo", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("gapSampleTime(now, last.t, getLateness(), stepWalkMs(last, player.position.x, player.position.y, atMountSpeed(player)))");
  expect(src).toContain("const walkedOn = direction !== \"\" && (reports || direction === getWalkAtSwitch());");
  expect(src).toContain("const started = currentPlayer.handoffWalk !== undefined || (reports && gapWalkStarted());");
  expect(src).toContain("gapStepMs(deltaTime * 1000, started, now, newest, getLateness(), walkedOn)");
  // Each frame goes into the report from the time the first step is measured from.
  expect(src).toContain("noteGapFrame(direction, direction ? walkMs : 0, now, newest && !newest.predicted ? newest.t + Math.max(0, getLateness()) : null);");
});

test("socket.ts dates a ghost's echoes at the mounted speed, as the engine steps a ghost", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  expect(src).toContain("player.lastDirection, atMountSpeed(player))");
});

// The live mounted crossing: the player mounted with Q, the client's `mounted` stayed false (only the spawn set it), so
// the gap walked at foot speed (0.75 of the mount's) and the pace after DONE was capped at 1.11 of foot speed (0.83 of
// the mount's) while the node stepped at the mount's speed: the drawn player fell behind until it stopped or snapped.
test("atMountSpeed: the engine steps a mounted player and a ghost at the mounted speed", () => {
  expect(atMountSpeed({ mounted: true })).toBe(true);
  expect(atMountSpeed({ isGhost: true })).toBe(true);
  expect(atMountSpeed({ mounted: true, isGhost: true })).toBe(true);
  expect(atMountSpeed({ mounted: false, isGhost: false })).toBe(false);
  expect(atMountSpeed({})).toBe(false);
  expect(atMountSpeed(null)).toBe(false);
  expect(atMountSpeed(undefined)).toBe(false);
});

test("advanceSelf and planHandoffDone walk a ghost at the mounted speed", () => {
  const ghost: any = { position: { x: 1000, y: 500 }, isGhost: true };
  const mounted: any = { position: { x: 1000, y: 500 }, mounted: true };
  const foot: any = { position: { x: 1000, y: 500 } };
  for (const p of [ghost, mounted, foot]) advanceSelf(p, "right", 100, null);
  expect(ghost.handoffWalk.x).toBeCloseTo(1000 + 18 * 1.35, 6);
  expect(ghost.handoffWalk.x).toBe(mounted.handoffWalk.x);
  expect(foot.handoffWalk.x).toBeCloseTo(1018, 6);
  // A node point the foot walk reaches later than HANDOFF_KEEP_LEAD_MS, the mounted walk sooner.
  const lead = 0.18 * HANDOFF_KEEP_LEAD_MS * 1.2;
  const server = { x: 1000 + lead, y: 500 };
  expect(planHandoffDone(true, true, { position: { x: 1000, y: 500 }, lastDirection: "right" }, server)).toBe("reseed");
  expect(planHandoffDone(true, true, { position: { x: 1000, y: 500 }, lastDirection: "right", isGhost: true }, server)).toBe("keep");
});

test("socket.ts takes the mounted state from the mount sheet of each pose, where the engine names it", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const at = src.indexOf("case \"SPRITE_SHEET_ANIMATION\": {");
  const handler = src.slice(at, src.indexOf("case \"BATCH_SPRITE_SHEET_ANIMATION\": {", at));
  // Set before the sheets load (they await): the next frame walks at the speed the node now steps.
  const set = handler.indexOf("player.mounted = !!data.mountSprite;");
  expect(set).toBeGreaterThan(0);
  expect(set).toBeLessThan(handler.indexOf("await import('./layeredAnimation.js')"));
  // A pose that comes before the player does is kept with its mounted state and applied with it.
  expect(handler).toContain("mounted: !!data.mountSprite,");
  expect(src).toContain("if (typeof anim.mounted === \"boolean\") player.mounted = anim.mounted;");
});

test("the handoff walk reads the mounted speed through atMountSpeed everywhere", async () => {
  const renderer = (await Bun.file(new URL("../webserver/public/js/core/renderer.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const socket = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  for (const src of [renderer, socket]) expect(src).not.toMatch(/(player|self)\.mounted === true/);
  expect(renderer).toContain("handoffPace.stepFor(eased, now, pressedKeys, getStickDirection(), atMountSpeed(player),");
});

// M-1 of the burst review: after a floored pair the lateness the floor added only ever shrinks.
test("KeptWalkDating: after a floored pair, the lateness (dated less sent) shrinks with every echo until it is gone", () => {
  const dating = new KeptWalkDating();
  const samples: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
  dating.arm(1000);
  const clock = { renderAt: 0, headroom: 28, offset: null };
  const tick = 1000 / 60;
  const send = [1000, 1000 + tick + 2, 1000 + tick + 2 + 5];
  for (let k = 3; k < 40; k++) send.push(send[k - 1] + tick);
  const late = send.map((t, k) => dating.date(samples, 110 + 3 * k, 0, t, t + 1, clock, "right", false) - t);
  // Floored: the 3rd echo is dated later than its send time by the 5 ms short of the walking time.
  expect(late[2]).toBeGreaterThan(late[1] + 5);
  for (let k = 3; k < late.length; k++) expect({ k, ok: late[k] <= late[k - 1] + 1e-9 }).toEqual({ k, ok: true });
  expect(late[late.length - 1]).toBeLessThan(late[2] / 2);
});

// Issue 3 (burst review I-1): the echoes of a stall of the link right after DONE came together; those past the 60 ms lead cap
// were dated 0.01 ms apart, a stand and then 7-18 px in one frame. Now the draw leaves the point it stands at, at the draw's
// time, and plays the catch-up at the walking time of each step less the slew; where that would pass the cap, no faster than
// KEPT_CATCHUP_SPEED, and never more than KEPT_CATCHUP_LEAD_MAX_MS after the arrival.
test("kept crossing with a stall of the link of 90 to 200 ms right after DONE: no frame above 1.5 x walking speed, none backward, the draw at the last echo within 200 ms", () => {
  let cases = 0, worst = 0, slowest = 0;
  for (const frameHz of [72, 144]) for (const len of [90, 110, 140, 200]) for (const from of [20, 40]) for (const startFrame of [0.3, 4]) for (const gaps of [[18, 5], [20, 14]]) for (const done of [19, 39]) {
    // The server stops at the last stalled echo, so the draw ends on a known point.
    const echoes = Math.ceil((from + len - 8) / (1000 / 60)) + 2;
    const r = keepCross({ dir: "right", ago: 6, done, phase: 8, startFrame, fix: true, ahead: 1, frameHz, gaps, stall: { from, until: from + len }, echoes });
    const arrive = done + from + len;
    const steady = 180 / frameHz;
    const after = r.all.filter((x) => x.rel >= arrive - 2);
    const label = `frame=${frameHz} stall=${from}+${len} start=${startFrame} gaps=${gaps} done=${done}`;
    worst = Math.max(worst, ...after.map((x) => x.step / steady));
    const reach = after.findIndex((x) => Math.abs(x.pos.x - r.final.x) < 0.01);
    slowest = Math.max(slowest, reach < 0 ? Infinity : after[reach].rel - arrive);
    expect({ label, plan: r.plan, back: Math.min(...after.map((x) => x.step)) >= -1e-9, fast: Math.max(...after.map((x) => x.step)) <= 1.5 * steady }).toEqual({ label, plan: "keep", back: true, fast: true });
    cases++;
  }
  expect(cases).toBe(2 * 4 * 2 * 2 * 2 * 2);
  // The bound: the newest echo is dated at most KEPT_CATCHUP_LEAD_MAX_MS after it arrives, so the draw (the playback delay behind) is on it
  // within 200 ms of the batch, 194 ms measured at the longest stall.
  expect(slowest).toBeLessThanOrEqual(200);
  expect(worst).toBeLessThanOrEqual(1.5);
});

test("KeptWalkDating: 14 echoes of a stall that arrive together are dated from the draw's time, then no faster than 1.5 x past the lead cap, never more than 200 ms after the arrival", () => {
  const dating = new KeptWalkDating();
  const samples: any[] = [{ t: 0, x: 100, y: 0 }, { t: 40, x: 110, y: 0, predicted: true }];
  dating.arm(1000);
  const tick = 1000 / 60;
  const first = dating.date(samples, 110, 0, 1000, 1000, { renderAt: 960, headroom: 28, offset: null }, "right", false);
  expect(pushEcho(samples, 110, 0, first)).toBe(true);
  // The link stalls: the next 14 echoes (sent one tick apart, 233 ms of walk) arrive together at 1300, the draw (at 1255) stands on the first.
  const clock = { renderAt: 1255, headroom: 28, offset: null };
  const dated: number[] = [first];
  for (let k = 1; k <= 14; k++) {
    const at = dating.date(samples, 110 + 3 * k, 0, 1000 + k * tick, 1300 + k * 0.01, clock, "right", false);
    expect(pushEcho(samples, 110 + 3 * k, 0, at)).toBe(true);
    dated.push(at);
  }
  // The chord leaves the first echo's point at the draw's time, not part way along (the draw at 1255 is on it).
  expect(positionAt(samples, 1255)!.x).toBeCloseTo(110, 6);
  for (let k = 1; k < dated.length; k++) {
    const gap = dated[k] - (k === 1 ? 1255 : dated[k - 1]);
    expect({ k, ok: 3 / gap <= 0.18 * KEPT_CATCHUP_SPEED + 1e-9 }).toEqual({ k, ok: true });
    expect({ k, ok: dated[k] <= 1300 + KEPT_CATCHUP_LEAD_MAX_MS }).toEqual({ k, ok: true });
  }
  // 60 ms past the arrival is what 1.11 x fills; the rest of the 14 echoes goes past it (as far as the catch-up speed needs).
  expect(dated.filter((d) => d > 1300 + KEPT_LEAD_SHIFT_MAX_MS).length).toBeGreaterThan(0);
  expect(dated[dated.length - 1]).toBeLessThanOrEqual(1300 + KEPT_CATCHUP_LEAD_MAX_MS);
  // And it ends on the newest echo's point.
  expect(positionAt(samples, dated[dated.length - 1] + 1)!.x).toBeCloseTo(152, 6);
});

// Issue 4 (burst review, minor): an echo that came while releaseHeld eases the draw back (at most 44 ms) was dated before the end
// of the ease, and pushEcho dropped it and with it the server's point (socket.ts then leaves the position as it was).
test("an echo that arrives during releaseHeld's ease takes the place of the end of the ease: kept, dated after the draw's time, no step back", () => {
  for (const frameHz of [144, 72]) for (const overshoot of [3, 5, 8]) for (const echoAhead of [2, 3, 6]) for (const dt of [4, 12, 25, 40]) {
    const walk = 0.18, frameMs = 1000 / frameHz;
    const spotX = 200, posX = spotX - overshoot;
    const samples: any[] = [{ t: 0, x: 150, y: 0 }, { t: 100, x: spotX, y: 0, held: true, heldUntil: 300 }];
    const dating = new KeptWalkDating();
    dating.arm(0);
    let prev = positionAt(samples, 100)!.x, worstBack = 0;
    let released = -1, got = false, pos = posX;
    for (let now = 150; now < 600; now += frameMs) {
      const render = now - 45;
      const last = samples[samples.length - 1];
      if (needsPositionSample(last, { x: pos, y: 0 }, now)) {
        if (last.held) { releaseHeld(samples, pos, 0, render, false); released = now; }
        else pushSample(samples, pos, 0, last.t + 0.01);
      }
      // The echo comes dt ms after the release (inside the ease), echoAhead px past the position (the walk goes on).
      if (released >= 0 && !got && now >= released + dt) {
        got = true;
        // Sent 35 ms before it arrived: dated (shifted, or a quick link) just ahead of the draw, before the end of the ease.
        const at = dating.date(samples, posX + echoAhead, 0, now - 35, now, { renderAt: render, headroom: 28, offset: null }, "right", false);
        const ok = pushEcho(samples, posX + echoAhead, 0, at);
        if (ok) pos = posX + echoAhead;
        expect({ frameHz, overshoot, echoAhead, dt, kept: ok }).toEqual({ frameHz, overshoot, echoAhead, dt, kept: true });
        // Dated after the draw's time.
        expect(at).toBeGreaterThan(render);
      }
      const x = positionAt(samples, render)!.x;
      worstBack = Math.max(worstBack, prev - x);
      prev = x;
    }
    const label = `frame=${frameHz} overshoot=${overshoot} ahead=${echoAhead} dt=${dt}`;
    expect({ label, got, back: worstBack <= walk * frameMs * 1.05 + 1e-6, end: prev }).toEqual({ label, got: true, back: true, end: posX + echoAhead });
  }
});

// Resid fix round 1.

// M-1 of the resid review: the first gap step walks the time since the last echo, but at most two frames (25 ms at least): a key
// let go and pressed again within 60 ms of the echo has not walked all that time, the head must not overshoot by 10.8 px.
test("gapStepMs: the first step is at most two frames (25 ms at least) long, a longer wait is one frame", () => {
  expect(gapStepMs(13.9, false, 1030, { t: 1000 }, 0)).toBeCloseTo(27.8, 6);
  expect(gapStepMs(13.9, false, 1055, { t: 1000 }, 0)).toBeCloseTo(27.8, 6);
  // 144 Hz: two frames are 13.9 ms, a 60 Hz node's last echo is up to 17 ms old: 25 ms are kept.
  expect(gapStepMs(6.9, false, 1017, { t: 1000 }, 0)).toBeCloseTo(17, 6);
  expect(gapStepMs(6.9, false, 1055, { t: 1000 }, 0)).toBeCloseTo(25, 6);
  expect(gapStepMs(6.9, false, 1061, { t: 1000 }, 0)).toBe(6.9);
});

// I-1 of the resid review: the gap walk's first step and dates changed for every crossing, those that end in reseed too. A
// crossing that walks through the gap and whose head is far from the node's point (planHandoffDone: more than HANDOFF_KEEP_PX)
// is reseeded. Guard: against the gap walk as it was (oldGap: a frame for the first step, dated at the frame's time), the ease
// starts from a shown spot no more than 1.5 px farther from the point, no frame steps back by more than the old gap did (the ease
// back to the node's point is the reseed's own), and the keep/reseed choice flips for few crossings.
test("a walking crossing that ends in reseed: the ease starts no worse than with the old gap walk, the keep/reseed boundary moved for few crossings", () => {
  let runs = 0, flips = 0, both = 0, shownWorst = 0, stepWorst = 0, newWorse = 0, newBack = 0, oldBack = 0;
  for (const hz of [60, 30]) for (const frameHz of [72, 144]) for (const done of [16, 28, 39, 42, 48]) for (const ahead of [-3, -2, -1, 0, 1, 2]) for (const phase of [8, 20]) for (const startFrame of [0.3, 4]) for (const dir of ["right", "downright"]) {
    const run = { dir, ago: 6, done, phase, startFrame, fix: true, ahead, frameHz, hz };
    const old = keepCross({ ...run, oldGap: true }), now = keepCross(run);
    runs++;
    if (old.plan !== now.plan) flips++;
    if (old.plan !== "reseed" || now.plan !== "reseed") continue;
    both++;
    const steady = 180 / frameHz;
    const minStep = (r: ReturnType<typeof keepCross>) => Math.min(...r.all.filter((x) => x.rel >= done).map((x) => x.step)) / steady;
    shownWorst = Math.max(shownWorst, now.shownGap - old.shownGap);
    stepWorst = Math.max(stepWorst, minStep(old) - minStep(now));
    if (now.shownGap > old.shownGap + 1e-6) newWorse++;
    if (minStep(now) < -1e-6) newBack++;
    if (minStep(old) < -1e-6) oldBack++;
  }
  expect(runs).toBe(2 * 2 * 5 * 6 * 2 * 2 * 2);
  expect(both).toBeGreaterThan(400);
  // Measured: the boundary moved for 20 of 960 (14 keep -> reseed, 6 reseed -> keep, all within 2 steps of HANDOFF_KEEP_PX),
  // the shown spot is up to 1.33 px farther in 38 crossings (the worst shown gap of all fell 28.3 -> 27.2 px), the ease back is 0.15 steady steps deeper at most.
  expect(flips).toBeLessThanOrEqual(40);
  expect(shownWorst).toBeLessThanOrEqual(1.5);
  expect(stepWorst).toBeLessThanOrEqual(0.2);
  expect(newBack).toBeLessThanOrEqual(oldBack);
});

// I-2 of the resid review: the 30 Hz hold + stall coverage. At 30 Hz a hold needs the first echo to be late (1.5 to 2 ticks after
// DONE): the gap walk no longer overshoots, so the 1-tick setup does not hold. Includes the echo that comes after releaseHeld's
// ease is over, dated before its end (the stall's raw times are in the past): it used to be dropped (4.6 px in one frame).
test("30 Hz node, late first echo, a hold and a stall of the link of 30 to 90 ms: the draw leaves the held spot at the walk's pace", () => {
  let held = 0, cases = 0, worst = 0, back = 0;
  for (const frameHz of [72, 144]) for (const dir of ["right", "left"]) for (const done of [28, 39, 42, 48]) for (const startFrame of [0.3, 4]) for (const jitter of [0, 8]) for (const phase of [50, 67]) for (const len of [30, 60, 90]) {
    const run = { dir, ago: 6, done, phase, startFrame, hz: 30, jitter, ahead: 0, frameHz, stall: { from: 80, until: 80 + len } };
    const r = keepCross({ ...run, fix: true });
    cases++;
    if (r.plan !== "keep" || r.heldFrames === 0) continue;
    held++;
    const a = afterDone(r, done);
    const steady = 180 / frameHz;
    const label = `frame=${frameHz} dir=${dir} done=+${done} start=${startFrame} jitter=${jitter} phase=${phase} stall=${len}`;
    // Backward only by the ease of releaseHeld (the walking pace), forward within 1.5 x.
    expect({ label, back: a.min >= -steady * 1.05, fast: a.max <= 1.5 * steady }).toEqual({ label, back: true, fast: true });
    worst = Math.max(worst, a.max / steady);
    if (a.min < -1e-9) back++;
  }
  expect(cases).toBe(2 * 2 * 4 * 2 * 2 * 2 * 3);
  expect(held).toBeGreaterThanOrEqual(60);
  expect(back).toBeGreaterThan(0);
  expect(worst).toBeLessThanOrEqual(1.5);
});

// I-3 of the resid review: the known-bad corner, pinned. The first echo about 20 ms after DONE, DONE 39-42 ms after the switch,
// 144 Hz frames, a 2nd echo 19-21 ms later: the draw reaches the walked head (the node's point, the same px) before the first
// echo is due and has nothing to play. The first echo is dated at most the render headroom plus KEPT_HEADROOM_SLACK_MS early
// (a longer shift stands later, when the 2nd echo is late: slack 0 gave 55 bad runs of 1152 instead of 22). One frame (7 ms) stands:
// the bound below is what it is today (0.08 x the steady step, 66 of 138 keep runs under 0.6 x at 20 ms, none above 1.15 x); a
// change that widens it fails here.
test("the known-bad corner (first echo 20 ms after DONE, 144 Hz, DONE 39-42): the worst frame stays inside today's bound", () => {
  let keep = 0, under = 0, lo = Infinity, hi = 0;
  for (const dir of KEEP_DIRS) for (const done of [39, 42]) for (const [g1, g2] of LIVE_GAPS) for (const startFrame of [0.3, 2, 4, 9]) {
    const r = keepCross({ dir, ago: 6, done, phase: 20, startFrame, fix: true, ahead: 1, frameHz: 144, gaps: [g1, g2] });
    if (r.plan !== "keep") continue;
    keep++;
    const steps = sinceDone(r, done, 300).map((x) => x.step / (180 / 144));
    lo = Math.min(lo, ...steps);
    hi = Math.max(hi, ...steps);
    if (Math.min(...steps) < 0.6) under++;
  }
  // 144 (138 before the walking bound HANDOFF_KEEP_WALK_PX): the six diagonal runs at DONE 42 (head 10.7 px) used to reseed; they keep and are inside the bounds below.
  expect(keep).toBe(144);
  expect(lo).toBeGreaterThanOrEqual(0.07);
  expect(hi).toBeLessThanOrEqual(1.15);
  expect(under).toBeLessThanOrEqual(70);
});

// Fix round 2 (resid re-review N-1): the ease join had no bound, so a standing player's ease mark stayed on the newest sample and
// a later warp was dated its walking time after the draw (500 px: 2.8 s ahead), refusing every echo until then.
test("a warp or a long wait after releaseHeld's ease is not joined to it: dated as it comes, the next echoes are accepted", () => {
  for (const jump of [HANDOFF_KEEP_PX + 1, 100, 500, 5000]) for (const wait of [400, 3000]) {
    const samples: any[] = [{ t: 0, x: 150, y: 0 }, { t: 100, x: 200, y: 0, held: true, heldUntil: 300 }];
    const dating = new KeptWalkDating();
    dating.arm(0);
    releaseHeld(samples, 196, 0, 350, false);
    expect(samples[samples.length - 1].eased).toBe(true);
    const now = 350 + wait;
    const at = dating.date(samples, 196 + jump, 0, now, now, { renderAt: now - 45, headroom: 28, offset: null }, "right", false);
    const label = `jump=${jump} wait=${wait}`;
    // Dated as it comes (about now), not walkMs after the draw (jump / 0.18 ms: 2.8 s for 500 px).
    expect({ label, ok: at <= now + 1 }).toEqual({ label, ok: true });
    expect({ label, kept: pushEcho(samples, 196 + jump, 0, at) }).toEqual({ label, kept: true });
    const next = dating.date(samples, 196 + jump + 3, 0, now + 16.7, now + 16.7, { renderAt: now - 45 + 16.7, headroom: 28, offset: null }, "right", false);
    expect({ label, kept: pushEcho(samples, 196 + jump + 3, 0, next) }).toEqual({ label, kept: true });
  }
});

// longgap: a crossing whose handoff took over 44 ms (SWITCH to HANDOFF_DONE) while the player walked. The walked head is then more
// than HANDOFF_KEEP_PX (8 px, 44 ms of walk) ahead of the node's point and planHandoffDone reseeded: the samples of the walk went,
// the draw stood at the point with the ease running back (about 0.1 px a frame, a back-step) until the first echo's chord, then
// played the burst of the 2nd and 3rd echoes (4-6 ms apart) raw: 1.3-2.9 x. On a 60 Hz or faster node the walk is kept up to
// HANDOFF_KEEP_WALK_PX, so the pacing, the cover and the hold take it as they take a shorter gap. What stays is a stand: the head is
// further ahead than the shift (the render headroom plus 4 ms) covers, so with the first echo late the draw reaches the head and has
// nothing to play (a frame or two at 0 x, never backward). `oldPlan` is the plan before: reseed over HANDOFF_KEEP_PX.
const LONG_DONES = [15, 20, 30, 37, 44, 50, 55, 60, 64, 66, 68, 70, 72, 74, 76, 78, 85, 90, 100, 105, 111, 120, 135, 150];
function longRun(o: { hz: number; frameHz: number; dir: string; done: number; ahead: number; pf: number; startFrame: number; gaps?: number[]; stop?: number; oldPlan?: boolean }) {
  const r = keepCross({ dir: o.dir, ago: 6, done: o.done, phase: o.pf * (1000 / o.hz), startFrame: o.startFrame, fix: true, ahead: o.ahead, frameHz: o.frameHz, hz: o.hz, gaps: o.gaps, oldPlan: o.oldPlan, ...(o.stop ? { echoes: o.stop } : {}) });
  const steady = 180 / o.frameHz;
  const steps = sinceDone(r, o.done, o.stop ? 900 : 300).map((x) => x.step / steady);
  let run = 0, standRun = 0;
  for (const s of steps) { run = s < 0.6 ? run + 1 : 0; standRun = Math.max(standRun, run); }
  return { plan: r.plan, min: Math.min(...steps), max: Math.max(...steps), standRun, retreat: steps.filter((s) => s < 0).reduce((a, b) => a + b, 0) };
}

// The sweep: 60, 30 and 20 Hz nodes, 72 and 144 Hz frames, straight and diagonal, SWITCH to DONE 15-150 ms, the node's point at the last
// echo or one step past it, the first echo early, middle or late, 3 frame phases, 2 live echo patterns at 60 Hz.
function longSweep(visit: (key: string, now: ReturnType<typeof longRun>, old: ReturnType<typeof longRun>) => void, stop = 0) {
  let cases = 0;
  for (const hz of [60, 30, 20]) for (const frameHz of [72, 144]) for (const dir of ["right", "downright"]) for (const done of LONG_DONES) for (const ahead of [0, 1]) for (const pf of [0.1, 0.5, 0.95]) for (const startFrame of [0.3, 4, 9]) for (const gaps of hz === 60 ? [[18, 5], [21, 13]] : [undefined]) {
    const run = { hz, frameHz, dir, done, ahead, pf, startFrame, gaps, stop };
    visit(`${hz}|${frameHz}|${dir}|${done}|${ahead}|${pf}|${startFrame}|${gaps}`, longRun(run), longRun({ ...run, oldPlan: true }));
    cases++;
  }
  return cases;
}

test("walking crossing, SWITCH to DONE 15-150 ms, 60/30/20 Hz node, 72/144 Hz frames, straight and diagonal: in no case a back-step, a larger step or a longer stand than reseeding", () => {
  let kept = 0, oldBack = 0, nowBack = 0, hi = 0;
  const cases = longSweep((key, now, old) => {
    if (now.plan === "keep" && old.plan === "reseed") kept++;
    if (old.min < -0.01) oldBack++;
    if (now.min < -0.01) nowBack++;
    hi = Math.max(hi, now.plan === "keep" && old.plan === "reseed" ? now.max : 0);
    // Back-step: not deeper than before (a stand or a rounding-size step is not one). Largest step: not above before, nor above 1.25 x.
    expect({ key, ok: now.min >= Math.min(old.min, 0) - 0.02 }).toEqual({ key, ok: true });
    expect({ key, ok: now.max <= Math.max(old.max, 1.15) + 0.05 || now.max <= old.max + 0.1 }).toEqual({ key, ok: true });
    expect({ key, stand: now.standRun <= old.standRun }).toEqual({ key, stand: true });
  });
  expect(cases).toBe(2 * 2 * LONG_DONES.length * 2 * 3 * 3 * 4);
  // Measured: 966 of the cases are kept that reseeded before (60 Hz node, head 8-13 px); the largest step of those is 1.11 x.
  expect(kept).toBeGreaterThan(900);
  expect(hi).toBeLessThanOrEqual(1.25);
  expect(nowBack).toBeLessThan(oldBack);
});

test("the same crossings with a stop 1 or 4 echoes after DONE: the retreat is at most the walking pace and no more than 1.5 steady steps longer than reseeding", () => {
  for (const stop of [2, 5]) {
    longSweep((key, now, old) => {
      expect({ key, stop, ok: now.min >= -1.05 }).toEqual({ key, stop, ok: true });
      expect({ key, stop, ok: now.retreat >= old.retreat - 1.5 }).toEqual({ key, stop, ok: true });
    }, stop);
  }
});

test("the longest walking bound: 14 px stands longer than the reseed at 70-85 ms, 13 px does not (60 Hz node, straight)", () => {
  expect(HANDOFF_KEEP_WALK_PX).toBe(13);
  // The bound is HANDOFF_KEEP_WALK_PX: a head 14 px ahead (78 ms) reseeds, so the stand is the reseed's own.
  const at = (px: number) => ({ position: { x: 500 + px, y: 300 }, lastDirection: "right" });
  setServerTickRate(60);
  expect(planHandoffDone(true, true, at(13), { x: 500, y: 300 })).toBe("keep");
  expect(planHandoffDone(true, true, at(14), { x: 500, y: 300 })).toBe("reseed");
  setServerTickRate(30);
  expect(planHandoffDone(true, true, at(9), { x: 500, y: 300 })).toBe("reseed");
  expect(planHandoffDone(true, true, at(HANDOFF_KEEP_PX), { x: 500, y: 300 })).toBe("keep");
  setServerTickRate(60);
  // Standing, or not predicting: reseed whatever the distance.
  expect(planHandoffDone(true, false, at(10), { x: 500, y: 300 })).toBe("reseed");
  expect(planHandoffDone(false, true, at(10), { x: 500, y: 300 })).toBe("reseed");
  setServerTickRate(30);
});

test("hasAnchor: a list of nothing but predicted samples (a gap longer than the list) is reseeded, as one with an echo is kept", () => {
  setServerTickRate(60);
  const at = { position: { x: 510, y: 300 }, lastDirection: "right" };
  expect(hasAnchor([{ predicted: true }, { predicted: true }])).toBe(false);
  expect(hasAnchor([{}, { predicted: true }])).toBe(true);
  expect(hasAnchor([])).toBe(false);
  expect(planHandoffDone(true, true, at, { x: 500, y: 300 }, hasAnchor([{ predicted: true }]))).toBe("reseed");
  expect(planHandoffDone(true, true, at, { x: 500, y: 300 }, hasAnchor([{}, { predicted: true }]))).toBe("keep");
  setServerTickRate(30);
});

// longhand: a walking crossing whose handoff took long (SWITCH to HANDOFF_DONE 37-150 ms). The node stood the player through the
// gap, the client walked the draw on, so the node's draw is behind it by the time the handoff took: a kept walk stands (the draw
// reaches the data it has, 2-4 frames at 0.00 x), a reseeded one steps back to the node's point and plays the first echoes in a
// burst (-0.2 x, then 1.4-1.7 x). HandoffPace plays the draw at the walking pace along the held direction (0.65 to 1.11 x) until the
// node's draw passes it. `pace: false` is the draw as it was (the snapshot's).
const PACE_DONES = [37, 45, 50, 60, 72, 75, 90, 110, 150];
function paceRun(o: { hz: number; frameHz: number; dir: string; done: number; ahead: number; phase: number; startFrame: number; gaps?: number[]; stick?: boolean; pace: boolean; keyUp?: number; echoes?: number; ms?: number; mounted?: boolean; release?: number; endMs?: number }) {
  const r = keepCross({ dir: o.dir, ago: 6, done: o.done, phase: o.phase, startFrame: o.startFrame, fix: true, ahead: o.ahead, frameHz: o.frameHz, hz: o.hz, gaps: o.gaps, pace: o.pace, stick: o.stick, keyUp: o.keyUp, echoes: o.echoes, mounted: o.mounted, release: o.release, endMs: o.endMs });
  const steady = (180 * (o.mounted ? 1.35 : 1)) / o.frameHz;
  const steps = sinceDone(r, o.done, o.ms ?? 300).map((x) => x.step / steady);
  let run = 0, standRun = 0;
  for (const s of steps) { run = s < 0.6 ? run + 1 : 0; standRun = Math.max(standRun, run); }
  return { plan: r.plan, min: Math.min(...steps), max: Math.max(...steps), standRun, under: steps.filter((s) => s < 0.6).length, retreat: steps.filter((s) => s < 0).reduce((a, b) => a + b, 0), final: r.final, errLate: r.errLate, all: r.all, steady, steps,
    // The draw against the echoes from 1.5 s after DONE on (while the node still walks): the pace is over and the lag gone.
    lateErr: Math.max(0, ...r.all.filter((x) => x.rel >= o.done + 1500).map((x) => x.err)) };
}

/** The sweep of the brief: 60 Hz node, 72 and 144 Hz frames, straight and diagonal, keys and stick, SWITCH to DONE 37-150 ms, the live echo patterns. */
function paceSweep(visit: (key: string, on: ReturnType<typeof paceRun>, off: ReturnType<typeof paceRun>) => void) {
  let cases = 0;
  for (const stick of [false, true]) for (const frameHz of [72, 144]) for (const dir of ["right", "downright"]) for (const done of PACE_DONES) for (const ahead of [0, 1]) for (const gaps of stick ? LIVE_GAPS.slice(0, 2) : LIVE_GAPS) for (const phase of stick ? [3, 13] : [3, 8, 13, 18, 22]) for (const startFrame of stick ? [0.3, 5] : [0.3, 4, 9]) {
    const run = { hz: 60, frameHz, dir, done, ahead, phase, startFrame, gaps, stick };
    visit(`stick=${stick} frame=${frameHz} dir=${dir} done=${done} ahead=${ahead} gaps=${gaps} phase=${phase} start=${startFrame}`, paceRun({ ...run, pace: true }), paceRun({ ...run, pace: false }));
    cases++;
  }
  return cases;
}

test("walking crossing, SWITCH to DONE 37-150 ms, 60 Hz node, 72/144 Hz, straight and diagonal, keys and stick, the live echo patterns: no back-step, no frame over 1.25 x or under 0.6 x in the 300 ms after DONE, on the node's position by 600 ms", () => {
  let reseed = 0, keep = 0, offBad = 0, offBack = 0, errLate = 0;
  const cases = paceSweep((key, on, off) => {
    expect({ key, ok: on.min >= 0.6 && on.max <= 1.25 }).toEqual({ key, ok: true });
    errLate = Math.max(errLate, on.errLate);
    if (on.plan === "reseed") reseed++; else keep++;
    if (off.min < 0.6 || off.max > 1.25) offBad++;
    if (off.min < -0.01) offBack++;
  });
  expect(cases).toBe(2 * 2 * 9 * 2 * 6 * 5 * 3 + 2 * 2 * 9 * 2 * 2 * 2 * 2);
  // Both paths are in the sweep, and the draw as it was fails most of it (kept: a stand; reseeded: a back-step and a burst).
  expect(keep).toBeGreaterThan(1000);
  expect(reseed).toBeGreaterThan(1000);
  expect(offBad).toBeGreaterThan(cases * 0.8);
  expect(offBack).toBeGreaterThan(cases * 0.3);
  // The draw is back on the node's timeline: within this of the echoes 600-800 ms after DONE (the creep and the catch-up are over).
  expect(errLate).toBeLessThan(1);
});

test("the two live signatures: 71.5 ms kept stands 2-3 frames, 73.2 ms reseeds with a back-step and a burst; with HandoffPace neither", () => {
  // 60 Hz node, 72 Hz frames, key right, the node's first echo 13 ms after DONE, the live echo pattern 18 then 5 ms.
  const live = { hz: 60, frameHz: 72, dir: "right", ahead: 0, phase: 13, gaps: [18, 5] };
  const kept = { ...live, done: 71.5, startFrame: 5 };
  const stand = paceRun({ ...kept, pace: false }), smooth = paceRun({ ...kept, pace: true });
  expect(stand.plan).toBe("keep");
  expect(stand.standRun).toBeGreaterThanOrEqual(2);
  expect(stand.min).toBeLessThan(0.1);
  expect(smooth.plan).toBe("keep");
  expect(smooth.min).toBeGreaterThanOrEqual(0.6);
  expect(smooth.max).toBeLessThanOrEqual(1.25);
  // The head is over HANDOFF_KEEP_WALK_PX (14 px): reseeded. A back-step then a burst before; neither now.
  const reseeded = { ...live, done: 73.2, startFrame: 0.3, phase: 8 };
  const burst = paceRun({ ...reseeded, pace: false }), calm = paceRun({ ...reseeded, pace: true });
  expect(burst.plan).toBe("reseed");
  expect(burst.min).toBeLessThan(-0.1);
  expect(burst.max).toBeGreaterThan(1.5);
  expect(calm.plan).toBe("reseed");
  expect(calm.min).toBeGreaterThanOrEqual(0.6);
  expect(calm.max).toBeLessThanOrEqual(1.25);
});

test("60, 30 and 20 Hz node, DONE 15-150 ms, kept and reseeded: in no case a back-step, a larger step or a longer stand than before, and none under 0.6 x or over 1.25 x", () => {
  let cases = 0, standBefore = 0;
  for (const hz of [60, 30, 20]) for (const frameHz of [72, 144]) for (const dir of ["right", "downright"]) for (const done of LONG_DONES) for (const ahead of [0, 1]) for (const pf of [0.1, 0.5, 0.95]) for (const startFrame of [0.3, 4, 9]) for (const gaps of hz === 60 ? [[18, 5], [21, 13]] : [undefined]) {
    const run = { hz, frameHz, dir, done, ahead, phase: pf * (1000 / hz), startFrame, gaps };
    const on = paceRun({ ...run, pace: true }), off = paceRun({ ...run, pace: false });
    const key = `${hz}|${frameHz}|${dir}|${done}|${ahead}|${pf}|${startFrame}|${gaps}`;
    expect({ key, ok: on.min >= Math.min(off.min, 0) - 0.02 && on.max <= Math.max(off.max, 1.15) + 0.05 && on.standRun <= off.standRun }).toEqual({ key, ok: true });
    expect({ key, ok: on.min >= 0.6 && on.max <= 1.25 }).toEqual({ key, ok: true });
    if (off.standRun > 0) standBefore++;
    cases++;
  }
  expect(cases).toBe(2 * 2 * LONG_DONES.length * 2 * 3 * 3 * 2 + 2 * 2 * 2 * LONG_DONES.length * 2 * 3 * 3);
  expect(standBefore).toBeGreaterThan(cases * 0.6);
});

test("gaps of 14-30 ms, the common case: nothing is worse than before; where the draw stood or dipped it no longer does", () => {
  let cases = 0, same = 0, fixed = 0;
  for (const hz of [60, 30, 20]) for (const frameHz of [72, 144]) for (const dir of ["right", "downright", "left", "up"]) for (const done of [14, 16, 18, 20, 22, 23, 26, 30]) for (const ahead of [0, 1]) for (const pf of [0.1, 0.3, 0.5, 0.7, 0.95]) for (const startFrame of [0.3, 4, 9]) for (const gaps of hz === 60 ? LIVE_GAPS : [undefined]) {
    const run = { hz, frameHz, dir, done, ahead, phase: pf * (1000 / hz), startFrame, gaps };
    const on = paceRun({ ...run, pace: true }), off = paceRun({ ...run, pace: false });
    const key = `${hz}|${frameHz}|${dir}|${done}|${ahead}|${pf}|${startFrame}|${gaps}`;
    // Smallest frame not lower, largest not higher (a clean draw is followed as it is; the pace never plays a frame over 1.11 x), no longer stand.
    expect({ key, min: on.min >= off.min - 1e-6, max: on.max <= Math.max(off.max, 1.11) + 1e-6, stand: on.standRun <= off.standRun, under: on.under <= off.under }).toEqual({ key, min: true, max: true, stand: true, under: true });
    cases++;
    if (off.min >= 0.6) { if (Math.abs(on.min - off.min) < 1e-6 && Math.abs(on.max - off.max) < 1e-6) same++; } else fixed++;
  }
  expect(cases).toBe(2 * 4 * 8 * 2 * 5 * 3 * (6 + 1 + 1));
  expect(fixed).toBeGreaterThan(500);
  expect(same).toBeGreaterThan(cases * 0.3);
});

// HandoffPace on its own: the node's draw is a path given by the test, the draw it returns is checked frame by frame.
const PACE_V = 0.18;
function drivePace(o: { target: (t: number) => { x: number; y: number }; dir: (t: number) => string; frameMs: number; ms: number; mounted?: boolean; release?: number; pace?: HandoffPace; blocked?: (x: number, y: number) => boolean }) {
  const pace = o.pace ?? new HandoffPace();
  if (!o.pace) pace.arm(0, o.target(0));
  const rows: { t: number; x: number; y: number; dx: number; dy: number; target: { x: number; y: number } }[] = [];
  let prev = o.target(0);
  for (let t = o.frameMs; t <= o.ms + 1e-9; t += o.frameMs) {
    if (o.release !== undefined && t >= o.release) pace.release();
    const target = o.target(t);
    const p = pace.step(target, t, o.dir(t), o.mounted === true, o.blocked);
    rows.push({ t, x: p.x, y: p.y, dx: p.x - prev.x, dy: p.y - prev.y, target });
    prev = p;
  }
  return { pace, rows };
}
/** The node's draw stands at x0 until `from` ms, then walks right from there at the walking speed. */
const standThenWalk = (x0: number, from: number) => (t: number) => ({ x: x0 + PACE_V * Math.max(0, t - from), y: 0 });

test("HandoffPace: unarmed it is the node's draw; a frame this long, or a position this far, is taken at once and ends it", () => {
  const idle = new HandoffPace();
  expect(idle.step({ x: 10, y: 20 }, 100, "right", false)).toEqual({ x: 10, y: 20 });
  expect(idle.active).toBe(false);
  for (const [gap, jump] of [[500, 0], [7, HANDOFF_SNAP_PX + 1]]) {
    const p = new HandoffPace();
    p.step({ x: 0, y: 0 }, 0, "right", false);
    p.arm(0, { x: 0, y: 0 });
    expect(p.step({ x: jump, y: 0 }, gap, "right", false)).toEqual({ x: jump, y: 0 });
    expect(p.active).toBe(false);
  }
});

test("HandoffPace: the node's draw stands 40 ms, then walks: the draw creeps at 0.65 x and more, then is on it, never under 0.6 x or over 1.11 x, never backward, the pace changes by at most the ramp", () => {
  for (const frameMs of [1000 / 144, 1000 / 72, 1000 / 60]) for (const stand of [10, 40, 90]) {
    const { rows, pace } = drivePace({ target: standThenWalk(100, stand), dir: () => "right", frameMs, ms: 700 });
    let prevRatio = 1;
    for (const r of rows) {
      const ratio = r.dx / (PACE_V * frameMs);
      const label = `frame=${frameMs.toFixed(1)} stand=${stand} t=${r.t.toFixed(0)}`;
      expect({ label, ok: ratio >= 0.6 && ratio <= 1.11 + 1e-9 }).toEqual({ label, ok: true });
      // A change of pace between frames is the ramp's at most, or the node's draw as it is (a stand to a walk is the node's).
      expect({ label, ok: Math.abs(ratio - prevRatio) <= HANDOFF_PACE_RAMP_PER_MS * frameMs + 1e-9 || Math.abs(r.x - r.target.x) < 1e-9 }).toEqual({ label, ok: true });
      prevRatio = ratio;
    }
    const last = rows[rows.length - 1];
    // On the node's draw well before 700 ms, and the ahead of it never over the lead (the creep stops there).
    expect(Math.abs(last.x - last.target.x)).toBeLessThan(1e-6);
    expect(Math.max(...rows.map((r) => r.x - r.target.x))).toBeLessThanOrEqual(HANDOFF_PACE_LEAD_PX + PACE_V * frameMs);
    expect(pace.active).toBe(true);
  }
});

test("HandoffPace: the node's draw steps back 3 px (the reseed's ease) or bursts 3 px in 5 ms: the draw never goes back, never over 1.11 x", () => {
  const back = (t: number) => ({ x: 100 - Math.min(3, t * 0.1) + PACE_V * Math.max(0, t - 60), y: 0 });
  const burst = (t: number) => ({ x: 100 + (t < 20 ? 0 : t < 25 ? 3 : 3) + PACE_V * Math.max(0, t - 40), y: 0 });
  for (const path of [back, burst]) for (const frameMs of [1000 / 144, 1000 / 72]) {
    const { rows } = drivePace({ target: path, dir: () => "right", frameMs, ms: 700 });
    for (const r of rows) expect({ t: r.t, ok: r.dx >= PACE_V * frameMs * 0.6 && r.dx <= PACE_V * frameMs * 1.11 + 1e-9 }).toEqual({ t: r.t, ok: true });
    expect(Math.abs(rows[rows.length - 1].x - rows[rows.length - 1].target.x)).toBeLessThan(1e-6);
  }
});

test("HandoffPace: a key let go, or release(): the draw waits for the node's last steps, then goes back at the walking pace per axis at most and ends on the node's draw", () => {
  for (const [name, release, dir] of [["key up", undefined, (t: number) => (t < 60 ? "right" : "")], ["release", 60, () => "right"]] as const) {
    const { rows, pace } = drivePace({ target: () => ({ x: 100, y: 0 }), dir, frameMs: 1000 / 144, ms: 600, release });
    for (const r of rows) expect({ name, t: r.t, ok: r.dx >= -PACE_V * (1000 / 144) - 1e-9 }).toEqual({ name, t: r.t, ok: true });
    // Creeping before the key goes up, no step back in the HANDOFF_PACE_WAIT_MS after it, then the way back.
    expect(Math.max(...rows.map((r) => r.x))).toBeGreaterThan(100.5);
    for (const r of rows.filter((r) => r.t > 60 && r.t <= 60 + HANDOFF_PACE_WAIT_MS - 10)) expect({ name, t: r.t, ok: r.dx >= -1e-9 }).toEqual({ name, t: r.t, ok: true });
    expect(rows[rows.length - 1].x).toBe(100);
    expect(pace.active).toBe(false);
  }
  // The node's draw still walking on when the key goes up (the server has not heard): it passes the draw, which never went back.
  const passing = drivePace({ target: (t) => ({ x: 100 + PACE_V * Math.max(0, t - 40), y: 0 }), dir: (t) => (t < 60 ? "right" : ""), frameMs: 1000 / 144, ms: 400 });
  for (const r of passing.rows) expect({ t: r.t, ok: r.dx >= -1e-9 }).toEqual({ t: r.t, ok: true });
  expect(Math.abs(passing.rows[passing.rows.length - 1].x - passing.rows[passing.rows.length - 1].target.x)).toBeLessThan(1e-6);
});

test("HandoffPace: a wall (the collision test) stops the creep at once; a player the node holds (key down, no echo) is crept to the lead for HANDOFF_PACE_STALL_MS, then goes back once", () => {
  // A wall at the node's position: nothing is crept, so nothing is walked back.
  const wall = drivePace({ target: () => ({ x: 100, y: 0 }), dir: () => "right", frameMs: 1000 / 72, ms: 2500, blocked: (x: number) => x > 100 });
  expect(Math.max(...wall.rows.map((r) => Math.abs(r.x - 100)))).toBe(0);
  // Held without a wall (a stun, a root): ahead of the node's draw by the lead at most, back at the walking pace after the stall.
  const held = drivePace({ target: () => ({ x: 100, y: 0 }), dir: () => "right", frameMs: 1000 / 72, ms: 2500 });
  const peak = Math.max(...held.rows.map((r) => r.x));
  expect(peak).toBeLessThanOrEqual(100 + HANDOFF_PACE_LEAD_PX);
  expect(peak).toBeGreaterThan(100 + HANDOFF_PACE_LEAD_PX - 1);
  const top = held.rows.findIndex((r) => r.x === peak);
  // Forward only up to the peak, back only after it, and the way back is over (the pace ended) well inside the window.
  for (const [i, r] of held.rows.entries()) expect({ t: r.t, ok: i <= top ? r.dx >= -1e-9 : r.dx <= 1e-9 && r.dx >= -PACE_V * (1000 / 72) - 1e-9 }).toEqual({ t: r.t, ok: true });
  expect(held.rows[held.rows.length - 1].x).toBe(100);
  expect(held.pace.active).toBe(false);
  expect(held.rows.find((r) => r.x === 100 && r.t > 100)!.t).toBeLessThan(HANDOFF_PACE_STALL_MS + HANDOFF_PACE_WAIT_MS + HANDOFF_PACE_LEAD_PX / PACE_V + 150);
  expect(HANDOFF_PACE_STALL_MS + HANDOFF_PACE_WAIT_MS + HANDOFF_PACE_LEAD_PX / PACE_V + 150).toBeLessThan(HANDOFF_PACE_WINDOW_MS);
});

test("HandoffPace for 3 s, after the window: a diagonal, a mounted and a released player are followed per axis, as the engine steps; a lag is caught up at 1.11 x and the pace ends", () => {
  for (const [name, axes, mounted, release] of [["diagonal", 1, false, undefined], ["mounted diagonal", 1, true, undefined], ["straight", 0, false, undefined], ["released mid-walk", 1, false, 400], ["mounted released", 1, true, 400]] as const) {
    const v = PACE_V * (mounted ? 1.35 : 1);
    const frameMs = 1000 / 72;
    // The node's draw walks on at the walking speed; the draw starts 12 px behind it on each axis (a lag to catch up), key held.
    const target = (t: number) => ({ x: 100 + v * t, y: 100 + axes * v * t });
    const pace = new HandoffPace();
    pace.arm(0, { x: target(0).x - 12, y: target(0).y - 12 * axes });
    const { rows } = drivePace({ target, dir: () => (axes ? "downright" : "right"), frameMs, ms: 3000, mounted, release, pace });
    for (const r of rows.slice(1)) {
      // Per axis never over 1.11 x, never backward; after the lag is gone the node's own pace (1.0 x per axis).
      expect({ name, t: r.t, ok: r.dx <= v * frameMs * 1.11 + 1e-9 && r.dx >= -1e-9 && (!axes || (r.dy <= v * frameMs * 1.11 + 1e-9 && r.dy >= -1e-9)) }).toEqual({ name, t: r.t, ok: true });
    }
    const late = rows.filter((r) => r.t > 1600);
    for (const r of late) expect({ name, t: r.t, ok: Math.abs(r.dx / (v * frameMs) - 1) < 0.02 && (!axes || Math.abs(r.dy / (v * frameMs) - 1) < 0.02) }).toEqual({ name, t: r.t, ok: true });
    const last = rows[rows.length - 1];
    expect({ name, lag: Math.hypot(last.x - last.target.x, last.y - last.target.y) < 1e-6, active: pace.active }).toEqual({ name, lag: true, active: false });
    // The lag (12 px a axis at 0.11 x) is caught up in 600-900 ms.
    expect({ name, ok: rows.findIndex((r) => Math.abs(r.x - r.target.x) < 1e-6) * frameMs < 1000 }).toEqual({ name, ok: true });
  }
});

test("HandoffPace: a diagonal and a mounted player creep at their own speed, a turn goes on without a step over 1.25 x or back", () => {
  const walk = (m: boolean) => PACE_V * (m ? 1.35 : 1);
  const a = drivePace({ target: () => ({ x: 100, y: 100 }), dir: () => "downright", frameMs: 1000 / 144, ms: 100 }).rows;
  const b = drivePace({ target: () => ({ x: 100, y: 100 }), dir: () => "right", frameMs: 1000 / 144, ms: 100, mounted: true }).rows;
  const c = drivePace({ target: () => ({ x: 100, y: 100 }), dir: () => "right", frameMs: 1000 / 144, ms: 100 }).rows;
  // 0.65 x of the speed on each axis of a diagonal; mounted, 1.35 x the speed.
  expect(a[a.length - 1].x - 100).toBeCloseTo(a[a.length - 1].y - 100, 6);
  expect(a[a.length - 1].x - 100).toBeCloseTo(c[c.length - 1].x - 100, 6);
  expect((b[b.length - 1].x - 100) / (c[c.length - 1].x - 100)).toBeCloseTo(walk(true) / walk(false), 1);
  // A turn: the node's draw walks right, then up from 100 ms; the key is up from 60 ms.
  const turn = (t: number) => ({ x: 100 + PACE_V * Math.min(t, 100), y: -PACE_V * Math.max(0, t - 100) });
  const { rows } = drivePace({ target: turn, dir: (t) => (t < 60 ? "right" : "up"), frameMs: 1000 / 144, ms: 500 });
  for (const r of rows) {
    expect({ t: r.t, ok: Math.hypot(r.dx, r.dy) <= PACE_V * (1000 / 144) * 1.11 + 1e-9 && r.dx >= -1e-9 && r.dy <= 1e-9 }).toEqual({ t: r.t, ok: true });
  }
  expect(Math.hypot(rows[rows.length - 1].x - rows[rows.length - 1].target.x, rows[rows.length - 1].y - rows[rows.length - 1].target.y)).toBeLessThan(1e-6);
});

test("a stop after DONE (the key up as the node's last echo, 1 or 4 echoes): the retreat is at most the walking pace, ends on the node's point, and is at most 1.5 steady steps longer than before", () => {
  let runs = 0, extraWorst = 0, deepest = 0, finalWorst = 0;
  for (const hz of [60, 30, 20]) for (const frameHz of [72, 144]) for (const dir of ["right", "downright"]) for (const done of [20, 44, 72, 90, 110, 150]) for (const ahead of [0, 1]) for (const pf of [0.1, 0.5, 0.95]) for (const startFrame of [0.3, 4, 9]) for (const n of [2, 5]) for (const lead of [10, 25, 50]) {
    const tick = 1000 / hz;
    const gaps = hz === 60 ? [18, 5] : undefined;
    let last = pf * tick;
    for (let k = 2; k < n; k++) last += gaps?.[k - 2] ?? tick;
    const run = { hz, frameHz, dir, done, ahead, phase: pf * tick, startFrame, gaps, echoes: n, keyUp: Math.max(0, last - lead), ms: 900 };
    const on = paceRun({ ...run, pace: true }), off = paceRun({ ...run, pace: false });
    const steady = 180 / frameHz;
    const lastX = 5000 + (dir.includes("right") ? 1 : 0) * (60 + ahead + n - 1) * (180 / hz);
    runs++;
    deepest = Math.min(deepest, on.min);
    extraWorst = Math.max(extraWorst, Math.abs(on.retreat) - Math.abs(off.retreat));
    finalWorst = Math.max(finalWorst, Math.abs(on.final.x - lastX));
    expect({ done, hz, frameHz, ok: on.min >= -1.05 }).toEqual({ done, hz, frameHz, ok: true });
    expect(steady).toBeGreaterThan(0);
  }
  expect(runs).toBe(3 * 2 * 2 * 6 * 2 * 3 * 3 * 2 * 3);
  // Measured: the walking pace at most (-1.00), 0.3 steady steps longer in the worst run (60/30 Hz), on average shorter; the node's point reached to the px.
  expect(deepest).toBeGreaterThanOrEqual(-1.05);
  expect(extraWorst).toBeLessThanOrEqual(1.5);
  expect(finalWorst).toBeLessThan(1);
});

test("a crossing standing still is drawn exactly as before, with HandoffPace in the frame loop", () => {
  for (const done of [20, 44, 80]) for (const startFrame of [0.3, 4]) {
    const a = keepCross({ dir: "right", ago: 6, done, phase: 5, startFrame, fix: true, held: false, pace: true });
    const b = keepCross({ dir: "right", ago: 6, done, phase: 5, startFrame, fix: true, held: false, pace: false });
    expect(a.all.map((x) => x.pos)).toEqual(b.all.map((x) => x.pos));
  }
});

// A turn after DONE (right, then up or down), with the echoes: the key turns `keyBefore` ms before the node steps the new way. Backward is
// against the old direction on x (the node stops going right) and against the new one on y, summed over the 900 ms after DONE.
function turnRun(o: { hz: number; frameHz: number; to: string; done: number; ahead: number; pf: number; startFrame: number; after: number; keyBefore: number; pace: boolean }) {
  const tick = 1000 / o.hz;
  const r = keepCross({ dir: "right", ago: 6, done: o.done, phase: o.pf * tick, startFrame: o.startFrame, fix: true, ahead: o.ahead, frameHz: o.frameHz, hz: o.hz, gaps: o.hz === 60 ? [18, 5] : undefined, pace: o.pace, turn: { after: o.after, dir: o.to, keyBefore: o.keyBefore }, endMs: 2200 });
  const steady = 180 / o.frameHz;
  const w = r.all.filter((x) => x.rel >= o.done && x.rel <= o.done + 900);
  const uy = o.to.includes("up") ? -1 : 1;
  let back = 0, hi = 0;
  for (let i = 1; i < w.length; i++) {
    const dx = w[i].pos.x - w[i - 1].pos.x, dy = w[i].pos.y - w[i - 1].pos.y;
    if (dx < 0) back -= dx;
    if (dy * uy < 0) back -= dy * uy;
    hi = Math.max(hi, Math.hypot(dx, dy) / steady);
  }
  return { back: back / steady, hi };
}

test("a turn after DONE (right, then up or down, the key 0 or 25 ms before the node turns): no step over 1.11 x; the way back is no longer than before, except in a few percent of the runs", () => {
  // Measured (steady steps longer than reseeding): 60 Hz mean -0.24, worst 1.8, 0.3% over 1.5; 30 Hz mean -0.10, worst 2.5, 1.3% over;
  // 20 Hz mean 0.08, worst 4.4, 4.9% over. The worst are reseeds of 90-110 ms (the draw crept to the 16 px lead before the key turned).
  const limits: Record<number, { over: number; worst: number }> = { 60: { over: 0.01, worst: 2.0 }, 30: { over: 0.02, worst: 2.7 }, 20: { over: 0.06, worst: 4.6 } };
  for (const hz of [60, 30, 20]) {
    let runs = 0, over = 0, worst = -9, sum = 0, hi = 0;
    for (const frameHz of [72, 144]) for (const to of ["up", "down"]) for (const done of [20, 44, 72, 90, 110]) for (const ahead of [0, 1]) for (const pf of [0.1, 0.5, 0.95]) for (const startFrame of [0.3, 4, 9]) for (const after of [20, 40, 70, 110]) for (const keyBefore of [0, 25]) {
      const run = { hz, frameHz, to, done, ahead, pf, startFrame, after, keyBefore };
      const on = turnRun({ ...run, pace: true }), off = turnRun({ ...run, pace: false });
      const extra = on.back - off.back;
      runs++; sum += extra; worst = Math.max(worst, extra); hi = Math.max(hi, on.hi);
      if (extra > 1.5) over++;
    }
    expect(runs).toBe(2 * 2 * 5 * 2 * 3 * 3 * 4 * 2);
    expect({ hz, hi: hi <= 1.11 + 1e-9 }).toEqual({ hz, hi: true });
    expect({ hz, mean: sum / runs <= 0.1 }).toEqual({ hz, mean: true });
    expect({ hz, over: over / runs <= limits[hz].over, worst: worst <= limits[hz].worst }).toEqual({ hz, over: true, worst: true });
  }
});

test("planPaceArm: armed only for a crossing the client walked and the player still moves, from where it is drawn", () => {
  const shown = { x: 10, y: 20 };
  expect(planPaceArm(true, true, shown)).toEqual({ x: 10, y: 20 });
  expect(planPaceArm(true, true, shown)).not.toBe(shown);
  expect(planPaceArm(false, true, shown)).toBeNull();
  expect(planPaceArm(true, false, shown)).toBeNull();
  expect(planPaceArm(true, true, null)).toBeNull();
});

test("a key let go in the gap: the draw goes on to the node's point at the walking pace and stops there, as a stop away from a border", () => {
  const shown = { x: 110696.9, y: 93000 };
  expect(planStopPace(true, false, shown)).toEqual(shown);
  expect(planStopPace(true, false, shown)).not.toBe(shown);
  expect(planStopPace(true, true, shown)).toBeNull();
  expect(planStopPace(false, false, shown)).toBeNull();
  expect(planStopPace(true, false, null)).toBeNull();
  // The node's point 5.1 px ahead of the draw (the walked head, a playback delay ahead): 60 Hz frames of 3 px, the walk's.
  const frame = 1000 / 60;
  for (const [dx, dy] of [[1, 0], [-1, 0], [1, 1], [0, -1]]) {
    const pace = new HandoffPace();
    const point = { x: shown.x + dx * 5.1, y: shown.y + dy * 5.1 };
    pace.step(point, 1000, "", false);
    pace.arm(1000, shown);
    pace.release();
    const drawn: { x: number; y: number }[] = [];
    for (let now = 1000 + frame; now < 1200; now += frame) drawn.push(pace.step(point, now, "", false));
    const steps = drawn.map((p, i) => Math.max(Math.abs(p.x - (i ? drawn[i - 1] : shown).x), Math.abs(p.y - (i ? drawn[i - 1] : shown).y)));
    // Two frames at the walking pace, the rest of a step, then on the point: never faster than the walk, never back.
    expect(steps.slice(0, 2).map((s) => +s.toFixed(2))).toEqual([3, 2.1]);
    expect(Math.max(...steps)).toBeLessThanOrEqual(3 + 1e-9);
    expect(drawn.slice(2).every((p) => p.x === point.x && p.y === point.y)).toBe(true);
    expect(pace.active).toBe(false);
  }
  // A key pressed again at once is not walked ahead of the node (released: nothing is governed), the draw follows its point.
  const pace = new HandoffPace();
  pace.step(shown, 1000, "", false);
  pace.arm(1000, shown);
  pace.release();
  expect(pace.step(shown, 1000 + frame, "right", false)).toEqual(shown);
});

// The wiring through keepCross (the frame loop of the renderer: pace.stepFor with the keys or the stick, mounted, the arming of planPaceArm
// at DONE, release()), for 3 s after DONE: the node walks on, the player holds the key (keys and stick, straight and diagonal, mounted), or
// is released at 1.2 s (a second switch).
test("3 s after DONE through the frame loop of the renderer: keys and stick, diagonal, mounted, a release: every frame within 0.9-1.11 x once the node's draw is followed, on the node's draw by 1.5 s", () => {
  let cases = 0, released = 0;
  for (const frameHz of [72, 144]) for (const dir of ["right", "downright"]) for (const stick of [false, true]) for (const mounted of [false, true]) for (const release of [undefined, 1200]) for (const done of [25, 60, 110]) for (const startFrame of [0.3, 6]) {
    const run = { hz: 60, frameHz, dir, done, ahead: 0, phase: 8, startFrame, gaps: [18, 5], stick, mounted, release, echoes: 260, endMs: 3600, ms: 3000, pace: true };
    const r = paceRun(run);
    const key = `frame=${frameHz} dir=${dir} stick=${stick} mounted=${mounted} release=${release} done=${done} start=${startFrame}`;
    expect({ key, min: r.min >= 0.6, max: r.max <= 1.25 }).toEqual({ key, min: true, max: true });
    // From 1.2 s after DONE the draw walks the node's walk: 1 step per frame (the echoes are linear), per axis.
    const late = r.all.filter((x) => x.rel >= done + 1200 && x.rel <= done + 3000).map((x) => x.step / r.steady);
    expect({ key, lo: Math.min(...late) >= 0.9, hi: Math.max(...late) <= 1.11 }).toEqual({ key, lo: true, hi: true });
    expect({ key, lag: r.lateErr < 1 }).toEqual({ key, lag: true });
    cases++;
    if (release !== undefined) released++;
  }
  expect(cases).toBe(2 * 2 * 2 * 2 * 2 * 3 * 2);
  expect(released).toBe(cases / 2);
});

test("renderer.ts and socket.ts call HandoffPace as the tests above drive it (backstop for the text of the calls)", async () => {
  const read = async (name: string) => (await Bun.file(new URL(`../webserver/public/js/core/${name}`, import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const renderer = await read("renderer.ts");
  const socket = await read("socket.ts");
  expect(renderer).toContain("player.id === cachedPlayerId ? handoffPace.stepFor(eased, now, pressedKeys, getStickDirection(), atMountSpeed(player), (x, y) => blockedAt(window.mapData, x, y)) : eased");
  expect(socket).toContain("const paceFrom = planPaceArm(predicting, moving, shown);\n    if (paceFrom) handoffPace.arm(performance.now(), paceFrom);");
  expect(socket).toContain("const stopFrom = planStopPace(predicting, moving, shown);\n    if (stopFrom) {\n      handoffPace.arm(performance.now(), stopFrom);\n      handoffPace.release();\n    }");
  // The stop is not eased as well (the ease would be the pace's target and crawl the last px).
  expect(socket).toContain("if (!keep && predicting && shown && !stopFrom) startEase(self, shown, { x, y }, performance.now());");
  expect(socket).toMatch(/function cancelKeptWalk\(\) \{\n  keptWalkDating\.cancel\(\);\n  handoffPace\.release\(\);/);
  // The arming comes after the keep/reseed branches (the reseed's cancelKeptWalk releases it).
  expect(socket.indexOf("handoffPace.arm(")).toBeGreaterThan(socket.indexOf("self.moveSamples = seedSamples(x, y, performance.now());"));
});

// S-M3: only a handoff (the player stays on the map) keeps the old node's grid drawn; any other switch clears it.
test("socket.ts: switchNode keeps the cluster grid only for a handoff", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const from = src.indexOf("async function switchNode(");
  const body = src.slice(from, src.indexOf("handoffSettle.cancel();", from));
  expect(body).toContain("const handoff = data?.handoff === true;");
  expect(body).toContain("pauseClusterRefresh(handoff);");
  expect(body).not.toContain("pauseClusterRefresh(true)");
});

// S3-m6: a resume announced with another connection id is a full login: the clock epoch restarts, as for LOAD_MAP.
test("socket.ts: a resume with another connection id resets the clock epoch before clearing handoffResume", async () => {
  const src = (await Bun.file(new URL("../webserver/public/js/core/socket.ts", import.meta.url)).text()).split(String.fromCharCode(13)).join("");
  const from = src.indexOf("if (handoffResume && connectionId === cachedPlayerIdBefore) {");
  expect(from).toBeGreaterThan(-1);
  const rest = src.slice(from);
  const elseFrom = rest.indexOf("} else {");
  const elseBody = rest.slice(elseFrom, rest.indexOf("\n        }", elseFrom));
  expect(elseBody).toContain("if (handoffResume) resetClockEpoch();");
  expect(elseBody.indexOf("resetClockEpoch()")).toBeLessThan(elseBody.indexOf("handoffResume = false;"));
});

// F-M5 / X2: allowed:false means no player may open the panel, so the overlay does not say "admins only".
test("clusternodes.ts: the not-allowed text does not claim an admin-only panel", async () => {
  const src = await Bun.file(new URL("../webserver/public/js/core/clusternodes.ts", import.meta.url)).text();
  expect(src).toContain('"Cluster: not available"');
  expect(src).not.toContain("admins only");
});
