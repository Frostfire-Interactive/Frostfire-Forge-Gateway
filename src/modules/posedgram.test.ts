import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POSE_DATAGRAM_HEADER, applyPoseDatagram, applyPoseUpdate, decodePoseDatagram, poseMark, reapplyPose, sheetPoseState } from "../webserver/public/js/core/posepacket";

// Viewer pose changes by datagram, the client half: [u8 0x05][u16 count] then per pose [u32 id][u32 revision][u8 n][state].
// A pose is applied only for a player the client knows and only if its revision is newer than the one shown; a stream
// pose (an older engine, or a connection without datagrams) and a full sheet are reliable and reset the baseline.
// The server half is the engine's src/tests/posedgram.test.ts.

const encoder = new TextEncoder();

/** A datagram as the engine's pose_codec.ts lays it out. */
function datagram(...poses: Array<[id: number, revision: number, state: string]>): Uint8Array {
  const records = poses.map(([id, revision, state]) => {
    const text = encoder.encode(state);
    const record = new Uint8Array(9 + text.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, id, true);
    view.setUint32(4, revision, true);
    record[8] = text.length;
    record.set(text, 9);
    return record;
  });
  const size = 3 + records.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  out[0] = 0x05;
  new DataView(out.buffer).setUint16(1, records.length, true);
  let at = 3;
  for (const r of records) { out.set(r, at); at += r.length; }
  return out;
}

/** A drawn player with a layered animation; `changes` records what changeLayeredAnimation was asked for. */
function player(id: string, state = "walk_down") {
  return { id, lastDirection: "down", layeredAnimation: { currentAnimationName: state } as any, animation: {} as any };
}
function world(...ids: string[]) {
  const players = ids.map((id) => player(id));
  const changes: Array<[string, string]> = [];
  const change = async (animation: any, name: string) => {
    changes.push([players.find((p) => p.layeredAnimation === animation)?.id ?? "other", name]);
    animation.currentAnimationName = name;
  };
  return { players, changes, change, pending: new Map<any, any>() };
}

describe("the pose datagram", () => {
  test("decodes the entries, in order, with the id as the stream names it", () => {
    const bytes = datagram([7, 3, "walk_down"], [4294967295, 4294967295, "mount_unicorn_idle_upleft"], [1, 0, "x"]);
    expect(bytes[0]).toBe(POSE_DATAGRAM_HEADER);
    expect(decodePoseDatagram(bytes)).toEqual([["7", 3, "walk_down"], ["4294967295", 4294967295, "mount_unicorn_idle_upleft"], ["1", 0, "x"]]);
  });

  test("anything cut short, empty or not a pose datagram decodes to nothing and never throws", () => {
    const whole = datagram([7, 3, "walk_down"], [8, 4, "idle_up"]);
    expect(decodePoseDatagram(whole.subarray(0, whole.length - 1)).length).toBe(1);
    expect(decodePoseDatagram(whole.subarray(0, 5))).toEqual([]);
    expect(decodePoseDatagram(new Uint8Array([0x05]))).toEqual([]);
    expect(decodePoseDatagram(new Uint8Array(0))).toEqual([]);
    expect(decodePoseDatagram(new Uint8Array([0x01, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual([]);
    expect(decodePoseDatagram(null as any)).toEqual([]);
    // A count larger than the bytes present is cut to the whole records there are.
    const liar = whole.slice();
    liar[1] = 200;
    expect(decodePoseDatagram(liar).length).toBe(2);
    // A view into a larger buffer (a datagram read out of a pooled one) decodes as the bytes alone.
    const pool = new Uint8Array(80);
    pool.set(whole, 11);
    expect(decodePoseDatagram(pool.subarray(11, 11 + whole.length))).toEqual(decodePoseDatagram(whole));
  });
});

describe("a datagram pose is applied through the stream pose's code path", () => {
  test("a newer revision for a known player gives the same result as the stream packet", async () => {
    const stream = world("7");
    expect(await applyPoseUpdate(stream.players, stream.pending, "7", "idle_left", stream.change)).toBe(true);
    const viaDatagram = world("7");
    await applyPoseDatagram(datagram([7, 5, "idle_left"]), viaDatagram.players, viaDatagram.pending, viaDatagram.change);
    for (const w of [stream, viaDatagram]) {
      const p: any = w.players[0];
      expect(w.changes).toEqual([["7", "idle_left"]]);
      expect(p.layeredAnimation.currentAnimationName).toBe("idle_left");
      expect(p._poseState).toBe("idle_left");
      expect(p.lastDirection).toBe("left");
      expect(p.animation).toBeNull();
      expect(p._poseMark).toBeGreaterThan(0);
    }
    expect((viaDatagram.players[0] as any)._poseRev).toBe(5);
    // The stream packet is reliable: the baseline is 0.
    expect((stream.players[0] as any)._poseRev).toBe(0);
  });

  test("socket.ts has one pose code path: both the stream packet and the datagram go through applyPoseUpdate", () => {
    const source = readFileSync(join(import.meta.dir, "..", "webserver", "public", "js", "core", "socket.ts"), "utf8").replace(/\r\n/g, "\n");
    const stream = source.slice(source.indexOf('case "SPRITE_SHEET_POSE": {'), source.indexOf('case "SPRITE_SHEET_POSE_DATAGRAM": {'));
    expect(stream).toContain("applyPoseUpdate(cache.players, cache.pendingPlayers, data?.id, data?.animationState, changeLayeredAnimation, data?.poseRev, true)");
    expect(stream).not.toContain("revision");
    const dgram = source.slice(source.indexOf('case "SPRITE_SHEET_POSE_DATAGRAM": {'), source.indexOf('case "SPRITE_SHEET_ANIMATION": {'));
    expect(dgram).toContain("applyPoseDatagram(data, cache.players, cache.pendingPlayers, changeLayeredAnimation)");
    // The datagram header is routed to it, ahead of the JSON branch.
    expect(source).toContain("FIRST_BYTE === POSE_DATAGRAM_HEADER");
    expect(source).toContain('type: "SPRITE_SHEET_POSE_DATAGRAM"');
    // Nothing else applies a pose to a player.
    expect(/(^|[^A-Za-z])applyPose\(/.test(source)).toBe(false);
  });

  test("mounts, casting and equipment poses (the longer state names) are applied as given", async () => {
    const w = world("7");
    for (const [i, state] of ["cast_walk_downright", "mount_unicorn_idle_up", "walk_upleft"].entries()) {
      await applyPoseDatagram(datagram([7, i + 1, state]), w.players, w.pending, w.change);
    }
    expect(w.changes.map((c) => c[1])).toEqual(["cast_walk_downright", "mount_unicorn_idle_up", "walk_upleft"]);
    expect((w.players[0] as any).lastDirection).toBe("upleft");
  });
});

describe("what is ignored", () => {
  test("an older or equal revision changes nothing", async () => {
    const w = world("7");
    await applyPoseDatagram(datagram([7, 5, "idle_left"]), w.players, w.pending, w.change);
    w.changes.length = 0;
    const p: any = w.players[0];
    const mark = p._poseMark;
    for (const revision of [5, 4, 1, 0]) {
      expect(await applyPoseDatagram(datagram([7, revision, "walk_up"]), w.players, w.pending, w.change)).toEqual([false]);
    }
    expect(w.changes).toEqual([]);
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_left");
    expect(p._poseState).toBe("idle_left");
    expect(p._poseMark).toBe(mark);
    expect(p._poseRev).toBe(5);
    // Newer: applied.
    expect(await applyPoseDatagram(datagram([7, 6, "walk_up"]), w.players, w.pending, w.change)).toEqual([true]);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_up");
  });

  test("a player the client does not know is ignored, and no revision is kept for them", async () => {
    const w = world("7");
    expect(await applyPoseDatagram(datagram([99, 5, "idle_left"]), w.players, w.pending, w.change)).toEqual([false]);
    expect(w.changes).toEqual([]);
    expect(await applyPoseDatagram(datagram([99, 5, "idle_left"]), null, null, w.change)).toEqual([false]);
    // They are known once drawn: the same revision is then new to the client.
    const late = player("99");
    expect(await applyPoseDatagram(datagram([99, 5, "idle_left"]), [...w.players, late], w.pending, w.change)).toEqual([true]);
  });

  test("a player still waiting for their sheets is posed, as the stream packet poses them", async () => {
    const w = world();
    const waiting: any = { id: "8", lastDirection: "down", layeredAnimation: null };
    w.pending.set("8", waiting);
    expect(await applyPoseDatagram(datagram([8, 2, "walk_right"]), w.players, w.pending, w.change)).toEqual([true]);
    expect(waiting._poseState).toBe("walk_right");
    expect(waiting._poseRev).toBe(2);
  });

  test("an empty state is ignored as the stream packet ignores it, and a bad datagram does nothing", async () => {
    const w = world("7");
    expect(await applyPoseDatagram(datagram([7, 3, ""]), w.players, w.pending, w.change)).toEqual([true]);
    expect(w.changes).toEqual([]);
    expect((w.players[0] as any)._poseState).toBeUndefined();
    expect(await applyPoseDatagram(new Uint8Array([0x05, 9, 9]), w.players, w.pending, w.change)).toEqual([]);
  });
});

describe("stream poses and full sheets", () => {
  test("a stream pose is still applied, whatever the revision shown, and takes the baseline back to 0", async () => {
    const w = world("7");
    await applyPoseDatagram(datagram([7, 40, "walk_up"]), w.players, w.pending, w.change);
    expect(await applyPoseUpdate(w.players, w.pending, "7", "idle_down", w.change)).toBe(true);
    expect((w.players[0] as any).layeredAnimation.currentAnimationName).toBe("idle_down");
    expect((w.players[0] as any)._poseRev).toBe(0);
    // A server whose revision restarted (a login after a crash) is not shut out.
    expect(await applyPoseDatagram(datagram([7, 1, "walk_left"]), w.players, w.pending, w.change)).toEqual([true]);
    expect((w.players[0] as any).layeredAnimation.currentAnimationName).toBe("walk_left");
  });

  test("a full sheet (poseMark is taken before it builds) is the new baseline too", async () => {
    const w = world("7");
    await applyPoseDatagram(datagram([7, 40, "walk_up"]), w.players, w.pending, w.change);
    const mark = poseMark(w.players[0]);
    expect((w.players[0] as any)._poseRev).toBe(0);
    expect(await applyPoseDatagram(datagram([7, 2, "idle_right"]), w.players, w.pending, w.change)).toEqual([true]);
    // The datagram that came while the sheet was built is newer than the sheet's state: reapplied after it.
    (w.players[0] as any).layeredAnimation.currentAnimationName = "walk_up";
    await reapplyPose(w.players[0], mark, w.change);
    expect((w.players[0] as any).layeredAnimation.currentAnimationName).toBe("idle_right");
    expect(poseMark(null)).toBe(0);
  });
});

describe("a late stream copy of an older change", () => {
  test("a late stream sheet with an older revision does not replace the newer datagram pose, but its look still applies", async () => {
    const w = world("7");
    const p: any = w.players[0];
    // Change N+1 (revision 6, idle_up) arrived by datagram first.
    await applyPoseDatagram(datagram([7, 6, "idle_up"]), w.players, w.pending, w.change);
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_up");
    // Then the sheet of change N (revision 5, walk_up, a new weapon) arrives on the stream. It is handled as socket.ts does:
    // poseMark with the sheet's revision, then the state the sheet shows; the look fields are applied from the sheet.
    const sheet = { id: "7", poseRev: 5, animationState: "walk_up", armorWeaponSprite: { name: "sword" } };
    const mark = poseMark(p, sheet.poseRev);
    const state = sheetPoseState(p, sheet.poseRev, sheet.animationState);
    expect(state).toBe("idle_up");
    expect(p._poseRev).toBe(6);
    // The sheet's look is applied with the pose shown (as socket.ts does with data.armorWeaponSprite): the pose is not walk_up.
    p.look = sheet.armorWeaponSprite.name;
    if (p.layeredAnimation.currentAnimationName !== state) await w.change(p.layeredAnimation, state);
    await reapplyPose(p, mark, w.change);
    expect(p.look).toBe("sword");
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_up");
    expect(w.changes.map((c) => c[1])).toEqual(["idle_up"]);
    // The repeat of 6 is equal: nothing to repair, nothing changes.
    expect(await applyPoseDatagram(datagram([7, 6, "idle_up"]), w.players, w.pending, w.change)).toEqual([false]);
  });

  test("a sheet with a newer or equal revision shows its own pose and the shown revision is the higher of the two", () => {
    const p: any = { _poseRev: 4, _poseState: "walk_left" };
    expect(sheetPoseState(p, 4, "idle_left")).toBe("idle_left");
    expect(p._poseRev).toBe(4);
    expect(sheetPoseState(p, 9, "walk_down")).toBe("walk_down");
    expect(p._poseRev).toBe(9);
    // An older one after that: the pose shown stays, the revision stays.
    p._poseState = "walk_down";
    expect(sheetPoseState(p, 7, "idle_left")).toBe("walk_down");
    expect(p._poseRev).toBe(9);
    // poseMark with a revision does not take the baseline back to 0.
    poseMark(p, 7);
    expect(p._poseRev).toBe(9);
  });

  test("a sheet with no revision (the spawn path, the relay, an older engine) is a baseline: it applies and the revision goes back to 0", () => {
    const p: any = { _poseRev: 40, _poseState: "walk_up" };
    poseMark(p, undefined);
    expect(p._poseRev).toBe(0);
    expect(sheetPoseState(p, undefined, "idle_down")).toBe("idle_down");
    expect(p._poseRev).toBe(0);
    for (const bad of [null, "5", NaN]) {
      p._poseRev = 40;
      poseMark(p, bad);
      expect(p._poseRev).toBe(0);
      expect(sheetPoseState(p, bad, "idle_down")).toBe("idle_down");
    }
  });

  test("a stream pose with an older revision is not shown, an equal or newer one is", async () => {
    const w = world("7");
    const p: any = w.players[0];
    await applyPoseDatagram(datagram([7, 6, "idle_up"]), w.players, w.pending, w.change);
    w.changes.length = 0;
    expect(await applyPoseUpdate(w.players, w.pending, "7", "walk_up", w.change, 5, true)).toBe(false);
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_up");
    expect(p._poseRev).toBe(6);
    expect(await applyPoseUpdate(w.players, w.pending, "7", "walk_left", w.change, 6, true)).toBe(true);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_left");
    expect(await applyPoseUpdate(w.players, w.pending, "7", "idle_left", w.change, 8, true)).toBe(true);
    expect(p._poseRev).toBe(8);
    // A datagram needs a strictly newer one.
    expect(await applyPoseUpdate(w.players, w.pending, "7", "walk_down", w.change, 8)).toBe(false);
  });

  test("a recreated player entity accepts a lower revision: the revision belongs to the object, not the id", async () => {
    const w = world("7");
    await applyPoseDatagram(datagram([7, 40, "walk_up"]), w.players, w.pending, w.change);
    expect((w.players[0] as any)._poseRev).toBe(40);
    // The player left the view and entered it again (or the server restarted its counter): a new object for the same id.
    const rebuilt = player("7", "idle_down");
    const players = [rebuilt];
    const changes: string[] = [];
    const change = async (animation: any, name: string) => { changes.push(name); animation.currentAnimationName = name; };
    expect(rebuilt as any).not.toHaveProperty("_poseRev");
    expect(await applyPoseDatagram(datagram([7, 1, "walk_left"]), players, w.pending, change)).toEqual([true]);
    expect(changes).toEqual(["walk_left"]);
    expect((rebuilt as any)._poseRev).toBe(1);
    // And a sheet with a low revision is not held back by the old object's number either.
    const another = player("8", "idle_down");
    expect(sheetPoseState(another, 2, "walk_down")).toBe("walk_down");
  });

  test("a stream pose with no revision still applies, whatever the revision shown", async () => {
    const w = world("7");
    await applyPoseDatagram(datagram([7, 40, "walk_up"]), w.players, w.pending, w.change);
    w.changes.length = 0;
    expect(await applyPoseUpdate(w.players, w.pending, "7", "idle_down", w.change, undefined, true)).toBe(true);
    expect(w.changes).toEqual([["7", "idle_down"]]);
    expect((w.players[0] as any)._poseRev).toBe(0);
  });

  test("socket.ts hands the revisions of the stream copies to these functions, and the datagram path is the other one", () => {
    const source = readFileSync(join(import.meta.dir, "..", "webserver", "public", "js", "core", "socket.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain("changeLayeredAnimation, data?.poseRev, true)");
    expect(source).toContain("const poseSeen = poseMark(player, data.poseRev);");
    expect(source).toContain("let animationState = sheetPoseState(player, data.poseRev, data.animationState || 'idle');");
    expect(source).toContain("const poseSeen = poseMark(targetPlayer, animationData.poseRev);");
    expect(source).toContain("sheetPoseState(targetPlayer, animationData.poseRev, animationData.animationState || 'idle')");
    // The sheet's layers are still read from the sheet, not from the shown pose.
    expect(source).toContain("player.layeredAnimation.layers.armor_weapon.spriteSheet = data.armorWeaponSprite;");
  });
});

describe("reordering is safe", () => {
  const STATES = ["walk_down", "idle_down", "walk_left", "idle_left", "walk_up"];
  const send = (revisions: number[]) => revisions.map((r) => datagram([7, r, STATES[r - 1]]));

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
  }

  test("every order of five revisions ends on the newest pose", async () => {
    for (const order of permutations([1, 2, 3, 4, 5])) {
      const w = world("7");
      for (const d of send(order)) await applyPoseDatagram(d, w.players, w.pending, w.change);
      expect((w.players[0] as any).layeredAnimation.currentAnimationName).toBe("walk_up");
      expect((w.players[0] as any)._poseRev).toBe(5);
    }
  });

  test("repeats and duplicates, in any order, do not move the pose off the newest", async () => {
    const w = world("7");
    const log = [3, 3, 5, 4, 5, 2, 3, 1, 5, 5, 4];
    for (const d of send(log)) await applyPoseDatagram(d, w.players, w.pending, w.change);
    expect((w.players[0] as any).layeredAnimation.currentAnimationName).toBe("walk_up");
    // Each pose was applied at most once, and only forward in revision.
    const names = w.changes.map((c) => c[1]);
    expect(names).toEqual(["walk_left", "walk_up"]);
  });

  test("two poses of one datagram, or of two datagrams handled before the first animation change ends, keep their order", async () => {
    const w = world("7");
    const slow: Array<() => void> = [];
    const changes: string[] = [];
    const change = (animation: any, name: string) => new Promise<void>((resolve) => {
      slow.push(() => { animation.currentAnimationName = name; changes.push(name); resolve(); });
    });
    // The newer datagram first, held up; the older one then arrives and is refused at once, without waiting.
    const newer = applyPoseDatagram(datagram([7, 3, "idle_up"]), w.players, w.pending, change);
    const older = await applyPoseDatagram(datagram([7, 2, "walk_up"]), w.players, w.pending, change);
    expect(older).toEqual([false]);
    slow.forEach((f) => f());
    await newer;
    expect(changes).toEqual(["idle_up"]);
    // Both poses of one datagram: the revision is taken for each when the datagram is handled, the second one is not shut out by the first.
    const w2 = world("7", "8");
    await applyPoseDatagram(datagram([7, 1, "idle_up"], [8, 1, "idle_down"], [7, 2, "walk_up"]), w2.players, w2.pending, w2.change);
    expect(w2.players.map((p) => p.layeredAnimation.currentAnimationName)).toEqual(["walk_up", "idle_down"]);
  });

  test("applyPoseDatagram takes the revisions before it awaits anything, so the datagram loop is not held up", () => {
    const w = world("7");
    let finished = false;
    const change = () => new Promise<void>(() => {});
    const done = applyPoseDatagram(datagram([7, 9, "idle_up"]), w.players, w.pending, change).then(() => { finished = true; });
    // Synchronous part done: revision and pose state recorded; the animation change is still pending.
    expect((w.players[0] as any)._poseRev).toBe(9);
    expect((w.players[0] as any)._poseState).toBe("idle_up");
    expect(finished).toBe(false);
    void done;
  });
});
