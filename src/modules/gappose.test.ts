import { expect, test } from "bun:test";
import { gapPose, keepGapPose } from "../webserver/public/js/core/gappose";

// The local player's pose in a handoff gap (gappose.ts): the client walks the player and poses them as the new node will
// once it walks the gap report (walk in the direction held, else stand facing the last walk), so a turn or a key let go
// in the gap shows at once, not when the new node's pose comes.

test("a key held on through the gap keeps the walk", () => {
  expect(gapPose("walk_right", "right")).toBeNull();
});

test("a key let go in the gap stands the player facing the way they walked", () => {
  expect(gapPose("walk_right", "")).toBe("idle_right");
  expect(gapPose("walk_downleft", "")).toBe("idle_downleft");
  expect(gapPose("idle_right", "")).toBeNull();
});

test("a turn in the gap walks the new way", () => {
  expect(gapPose("walk_right", "down")).toBe("walk_down");
  expect(gapPose("walk_right", "downright")).toBe("walk_downright");
});

test("a key pressed in the gap walks a standing player", () => {
  expect(gapPose("idle_left", "left")).toBe("walk_left");
  expect(gapPose("idle_left", "up")).toBe("walk_up");
});

test("a pose that is not a walk or a stand is the node's: a cast, an unknown direction, none", () => {
  expect(gapPose("cast_walk_right", "")).toBeNull();
  expect(gapPose("cast_idle_right", "down")).toBeNull();
  expect(gapPose("walk_sideways", "")).toBeNull();
  expect(gapPose(undefined, "right")).toBeNull();
  expect(gapPose(null, "")).toBeNull();
  expect(gapPose("walk_right", "sideways")).toBeNull();
});

test("a node's walk or stand in the gap leaves the one the client shows", () => {
  // The new node posed an older gap report (a key let go on the way): it poses the newest once it walked it.
  expect(keepGapPose("idle_right", "walk_right")).toBe("idle_right");
  expect(keepGapPose("walk_down", "walk_right")).toBe("walk_down");
  expect(keepGapPose("walk_down", "idle_down")).toBe("walk_down");
});

test("any other pose from the node is shown", () => {
  expect(keepGapPose("walk_right", "cast_walk_right")).toBe("cast_walk_right");
  expect(keepGapPose("cast_idle_right", "idle_right")).toBe("idle_right");
  expect(keepGapPose(undefined, "walk_right")).toBe("walk_right");
});
