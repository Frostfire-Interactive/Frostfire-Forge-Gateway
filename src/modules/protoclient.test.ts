import { describe, expect, test } from "bun:test";
import { CREATURE_MOVE_HEADER, decodeCreatureMoves } from "../webserver/public/js/core/creaturemoves";
import { applyPose, findPosePlayer, poseMark, reapplyPose } from "../webserver/public/js/core/posepacket";

// The client's half of the protocol packet wave (the engine's half is its own src/tests/packet-proto.test.ts; each repo
// tests itself):
//   B. CREATURE_MOVE as a binary datagram: [u8 0x04][u16 count, little endian] then per creature 13 bytes
//      [u32 id][i32 x][i32 y][u8 flags], flags: bits 0-2 the direction, bit 3 moving.
//   A. SPRITE_SHEET_POSE: a pose change alone, for players whose sheets the client holds.

const DIRS = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];

/** A datagram laid out as the engine's socket/creature_move_codec.ts lays it out. */
function datagram(entries: Array<[number, number, number, string, 0 | 1]>): Uint8Array {
  const bytes = new Uint8Array(3 + 13 * entries.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x04;
  view.setUint16(1, entries.length, true);
  entries.forEach(([id, x, y, dir, moving], i) => {
    const at = 3 + 13 * i;
    view.setUint32(at, id, true);
    view.setInt32(at + 4, x, true);
    view.setInt32(at + 8, y, true);
    bytes[at + 12] = DIRS.indexOf(dir) | (moving ? 0x08 : 0);
  });
  return bytes;
}

// small deterministic generator
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

function randomEntry(): [number, number, number, string, 0 | 1] {
  const pick = int(0, 4);
  const id = pick === 0 ? 0 : pick === 1 ? 0xffffffff : int(0, 0xffffffff);
  const x = pick === 0 ? -0x80000000 : pick === 1 ? 0x7fffffff : int(-0x80000000, 0x7fffffff);
  const y = pick === 0 ? 0x7fffffff : pick === 1 ? -0x80000000 : int(-0x80000000, 0x7fffffff);
  return [id, x, y, DIRS[int(0, 7)], int(0, 1) as 0 | 1];
}

describe("binary CREATURE_MOVE datagram, the client's decoder", () => {
  test("a known datagram is read as the layout says", () => {
    expect(CREATURE_MOVE_HEADER).toBe(0x04);
    const bytes = new Uint8Array([
      0x04, 0x02, 0x00,
      7, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0x09,
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff, 0x7f, 0x07,
    ]);
    expect(decodeCreatureMoves(bytes)).toEqual([[7, 1, 2, "up", 1], [0xffffffff, -0x80000000, 0x7fffffff, "upright", 0]]);
  });

  test("random entries, extremes included, are read back unchanged, also as a view into a larger buffer", () => {
    for (let round = 0; round < 200; round++) {
      const entries = Array.from({ length: int(0, 60) }, randomEntry);
      const payload = datagram(entries);
      expect(decodeCreatureMoves(payload)).toEqual(entries);
      // as a view into a larger buffer (a datagram is not always at offset 0)
      const padded = new Uint8Array(payload.length + 7);
      padded.set(payload, 5);
      expect(decodeCreatureMoves(padded.subarray(5, 5 + payload.length))).toEqual(entries);
    }
  });

  test("a short, empty or foreign datagram decodes to nothing and never throws", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([4]), new Uint8Array([4, 9, 0, 1, 2]), new Uint8Array([1, 0, 0]), new Uint8Array([4, 255, 255])]) {
      expect(decodeCreatureMoves(bytes)).toEqual([]);
    }
    // A count larger than the bytes present is cut to the whole records there are.
    const one = datagram([[7, 1, 2, "up", 1]]);
    one[1] = 50;
    expect(decodeCreatureMoves(one)).toEqual([[7, 1, 2, "up", 1]]);
  });
});

describe("client pose handling", () => {
  const changes: string[] = [];
  const change = async (a: any, name: string) => { changes.push(name); a.currentAnimationName = name; };
  const mk = (extra: any = {}) => ({ id: "9", lastDirection: "down", layeredAnimation: { currentAnimationName: "idle_down" }, ...extra });

  test("a pose switches the animation on the held sheets and updates the direction", async () => {
    changes.length = 0;
    const p = mk();
    await applyPose(p, "walk_left", change);
    expect(changes).toEqual(["walk_left"]);
    expect(p.lastDirection).toBe("left");
    await applyPose(p, "walk_left", change);
    expect(changes).toEqual(["walk_left"]);
    await applyPose(p, "idle", change);
    expect(changes).toEqual(["walk_left", "idle_left"]);
  });

  test("a pose for a player with no sheets, or a bad packet, is ignored and never throws", async () => {
    changes.length = 0;
    await applyPose(mk({ layeredAnimation: null }), "walk_left", change);
    await applyPose(null, "walk_left", change);
    await applyPose(mk(), 5, change);
    await applyPose(mk(), "", change);
    await applyPose(mk(), "walk_up", async () => { throw new Error("boom"); });
    expect(changes).toEqual([]);
    expect(findPosePlayer(new Set([{ id: "1" }]), new Map([["2", { id: "2" }]]), "2")).toEqual({ id: "2" });
    expect(findPosePlayer(null, null, "2")).toBeNull();
  });

  test("a pose that arrives while a full sheet packet is building wins over the packet's older state", async () => {
    changes.length = 0;
    const p: any = mk();
    const mark = poseMark(p);
    await applyPose(p, "walk_up", change);
    // the full packet finishes with its own (older) state
    p.layeredAnimation = { currentAnimationName: "idle_down" };
    await reapplyPose(p, mark, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("walk_up");
    // nothing arrived meanwhile: left alone
    const mark2 = poseMark(p);
    p.layeredAnimation = { currentAnimationName: "idle_left" };
    await reapplyPose(p, mark2, change);
    expect(p.layeredAnimation.currentAnimationName).toBe("idle_left");
  });
});
