import { expect, test } from "bun:test";
import { advanceSelf, applyEase, EASE_TIME_CONSTANT_MS, HANDOFF_SNAP_PX, heldDirection, startEase } from "../webserver/public/js/core/handoffwalk";

// The client half of the cluster handoff: the walk drawn while the gap lasts, the ease of the difference to the new
// node's position, the next node's session opened ahead of the SWITCH, and the cluster overlay's pause. The engine's
// half is its own src/tests/cluster-handofffix2.test.ts; each repo tests itself.

const text = async (name: string) => (await Bun.file(new URL(`../webserver/public/js/core/${name}`, import.meta.url)).text()).split(String.fromCharCode(13)).join("");

/** A map of 32 px tiles in 32-tile chunks whose collision layer is set where `wall` says (global tile coordinates). */
function mapWith(wall: (tx: number, ty: number) => boolean): any {
  const loadedChunks = new Map<string, any>();
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const data = new Array(32 * 32).fill(0);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (wall(cx * 32 + x, cy * 32 + y)) data[y * 32 + x] = 5;
      loadedChunks.set(`${cx}-${cy}`, { width: 32, layers: [{ name: "Ground", data: new Array(32 * 32).fill(1) }, { name: "Collision", data }] });
    }
  }
  return { tilewidth: 32, tileheight: 32, chunkSize: 32, loadedChunks };
}

test("the client walks the player at the engine's speed along the held keys, and not into a wall", () => {
  expect(heldDirection(new Set(["KeyW", "KeyD"]))).toBe("upright");
  expect(heldDirection(new Set(["KeyS"]))).toBe("down");
  expect(heldDirection(new Set())).toBe("");
  const open = mapWith(() => false);
  const player: any = { position: { x: 100, y: 100 }, mounted: false };
  // 0.5 s at 180 px a second is 90 px, in whatever frames it comes.
  for (let i = 0; i < 30; i++) advanceSelf(player, "right", 1000 / 60, open);
  expect(player.position.x).toBe(190);
  expect(player.position.y).toBe(100);
  expect(player.lastDirection).toBe("right");
  // Mounted: 1.35 times.
  const mounted: any = { position: { x: 0, y: 0 }, mounted: true };
  advanceSelf(mounted, "down", 1000, open);
  expect(mounted.position.y).toBe(243);
  // A wall tile at x = 300..331: the player stops in front of it (their box is 24 wide).
  const walled = mapWith((tx) => tx === 9);
  const blocked: any = { position: { x: 250, y: 100 } };
  for (let i = 0; i < 120; i++) advanceSelf(blocked, "right", 1000 / 60, walled);
  expect(blocked.position.x).toBeLessThan(300);
  expect(blocked.position.x).toBeGreaterThan(270);
  // A diagonal into it slides along the open axis.
  const slide: any = { position: { x: 250, y: 100 } };
  for (let i = 0; i < 60; i++) advanceSelf(slide, "downright", 1000 / 60, walled);
  expect(slide.position.y).toBeGreaterThan(150);
  expect(slide.position.x).toBeLessThan(300);
  // A chunk the client does not hold is not a wall.
  const hole: any = { position: { x: 100, y: 100 } };
  advanceSelf(hole, "right", 500, { ...open, loadedChunks: new Map() });
  expect(hole.position.x).toBe(190);
  // No direction, no step.
  const still: any = { position: { x: 5, y: 5 } };
  expect(advanceSelf(still, "", 100, open)).toBe(false);
});

test("the difference to the new node's position is eased out, and snapped when it is large", () => {
  const player: any = { position: { x: 0, y: 0 } };
  // 40 px ahead: eased.
  expect(startEase(player, { x: 140, y: 100 }, { x: 100, y: 100 }, 1000)).toBe(true);
  const first = applyEase(player, { x: 100, y: 100 }, 1000);
  expect(first.x).toBe(140);
  const later = applyEase(player, { x: 100, y: 100 }, 1000 + EASE_TIME_CONSTANT_MS);
  // One time constant: a third of the error is left.
  expect(later.x).toBeCloseTo(100 + 40 / Math.E, 1);
  const done = applyEase(player, { x: 100, y: 100 }, 1000 + 20 * EASE_TIME_CONSTANT_MS);
  expect(done).toEqual({ x: 100, y: 100 });
  expect(player.handoffEase).toBeUndefined();
  // Above the snap size (the movement smoothing's teleport size): taken at once.
  expect(HANDOFF_SNAP_PX).toBe(100);
  expect(startEase(player, { x: 301, y: 100 }, { x: 100, y: 100 }, 2000)).toBe(false);
  expect(applyEase(player, { x: 100, y: 100 }, 2000)).toEqual({ x: 100, y: 100 });
  // No error, nothing to ease.
  expect(startEase(player, { x: 100, y: 100 }, { x: 100, y: 100 }, 2000)).toBe(false);
});

test("socket.ts: the client opens the next node's session on HANDOFF_PREPARE and keeps it for the SWITCH, one at a time, closed when unused", async () => {
  const client = await text("socket.ts");
  const renderer = await text("renderer.ts");
  // The packets are handled.
  expect(client).toContain('case "HANDOFF_PREPARE": {');
  expect(client).toContain('case "HANDOFF_ABORT": {');
  // The session and its stream are opened, and nothing is sent on it: the AUTH_CONNECT is sent by setupTransport at the SWITCH.
  const pre = client.slice(client.indexOf("function preOpenNode("), client.indexOf("async function transportForSwitch("));
  expect(pre).toContain("openGameTransport(server, marks)");
  expect(pre).toContain("createBidirectionalStream()");
  expect(pre).not.toContain("AUTH_CONNECT");
  expect(pre).not.toContain("sendRawFrame");
  // At most one: a different node closes the earlier one.
  expect(pre).toContain("closePreOpened(preOpened);");
  expect(client).toContain("const HANDOFF_PREOPEN_MS = 10_000;");
  // The SWITCH uses it only for the same node and while it is open, else opens as before.
  const use = client.slice(client.indexOf("async function transportForSwitch("), client.indexOf("// The times of one handoff on the client"));
  expect(use).toContain("handoff && !pre.closed && pre.key === nodeKey(server)");
  expect(use).toContain("openSwitchTransport(server, marks)");
  expect(client).toContain("await Promise.race([setupTransport(opened.stream), closedFirst]);");
  expect(client).toContain("const bidi = preStream ?? await socket.createBidirectionalStream();");
  // The certificate hash is kept per origin.
  expect(client).toContain("const certHashes = new Map<string, string>();");
  // The measurement line.
  expect(client).toContain("[handoff] client switch_rx->cert/wt_ready/auth_sent/handoff_done/first_pos ms:");
  // The walk is drawn while the gap lasts; movementAllowed still holds the sending.
  expect(renderer).toContain("advanceSelf(currentPlayer, gapDirection(pressedKeys, getStickDirection()), stepMs, window.mapData);");
  expect(client).toContain("handoffGap = data?.resume === true;");
  // A stick still held after HANDOFF_DONE sends its direction and never a stop; a repeat prepare does not extend the timer.
  const done = client.slice(client.indexOf('case "HANDOFF_DONE"'), client.indexOf('case "LOAD_PLAYERS"'));
  // (What is sent is decided by doneSend in resumesend.ts, which has its own tests; here the stick is handed to it,
  // what it names is sent as a MOVEXY, and HANDOFF_DONE sends no ABORT of its own.)
  expect(done).toContain("stick: getStickDirection(),");
  expect(done).toContain('if (send.send !== null) sendRequest({ type: "MOVEXY", data: send.send });');
  expect(done).not.toContain('data: "ABORT"');
  expect(pre.slice(0, pre.indexOf("closePreOpened(preOpened);"))).not.toContain("setTimeout");
});

test("socket.ts: the cluster overlay waits during a switch or a disconnect, forgets the old node's answer, and starts again at HANDOFF_DONE and LOAD_MAP", async () => {
  const overlay = await text("clusternodes.ts");
  const client = await text("socket.ts");
  expect(overlay).toContain("export function pauseClusterRefresh(keepGrid = false): void {");
  expect(overlay).toContain("timer = setInterval(() => { if (!paused) request?.(); }, REFRESH_MS);");
  expect(overlay.slice(overlay.indexOf("export function requestClusterRefresh")).slice(0, 200)).toContain("paused = false;");
  // Kept as it was: the data case, the requester, and the refresh lines.
  expect(client).toContain('case "CLUSTER_DEBUG_DATA": {');
  expect(client).toContain("setClusterDebugRequester(() => sendRequest({ type: \"CLUSTER_DEBUG\", data: {} }));");
  expect(client.match(/requestClusterRefresh\(\);/g)).toHaveLength(2);
  // Paused when the switch starts (a handoff keeps the grid drawn, any other switch clears it), the socket closes and switching stops.
  expect(client.slice(client.indexOf("async function switchNode("), client.indexOf("async function switchNode(") + 1200)).toContain("pauseClusterRefresh(handoff);");
  expect(client.slice(client.indexOf("async function handleSocketClose("), client.indexOf("async function handleSocketClose(") + 400)).toContain("pauseClusterRefresh();");
  expect(client.slice(client.indexOf("function stopSwitching("), client.indexOf("function stopSwitching(") + 200)).toContain("pauseClusterRefresh();");
});

test("socket.ts: the summary line of a crossing on the client is console.debug", async () => {
  const client = await text("socket.ts");
  const at = client.indexOf("`[handoff] client switch_rx->");
  expect(at).toBeGreaterThan(0);
  expect(client.slice(client.lastIndexOf("console.", at), at)).toStartWith("console.debug(");
});
