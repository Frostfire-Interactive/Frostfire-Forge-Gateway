import { expect, test } from "bun:test";
import { frameCanvas } from "../webserver/public/js/core/layercanvas";

// A layer's frame is drawn from a canvas made once for it. A pose's name changes a moment before its frames do (the
// walk out of a portal names walk_down in the frame it draws): kept by name, the last pose's picture (facing up) was
// kept as the new pose's frame and shown on the walk out. Kept by the frame itself, each frame shows its own picture.

const made = () => {
  const list: string[] = [];
  return { list, make: (label: string) => () => { list.push(label); return { label }; } };
};

test("the frame drawn while the pose's name has changed but not its frames is not kept as the new pose's frame", () => {
  const { make } = made();
  const idleUp0 = {}, walkDown0 = {};
  // drawn once under the new name with the old frame (idle_up), then with the new frame (walk_down)
  const first = frameCanvas(idleUp0, false, make("idle_up"));
  const next = frameCanvas(walkDown0, false, make("walk_down"));
  expect(first).toEqual({ label: "idle_up" });
  expect(next).toEqual({ label: "walk_down" });
});

test("a frame's canvas is made once, and once more for the ghost tint", () => {
  const { list, make } = made();
  const frame = {};
  const a = frameCanvas(frame, false, make("live"));
  const b = frameCanvas(frame, false, make("live"));
  const c = frameCanvas(frame, true, make("ghost"));
  expect(a).toBe(b);
  expect(c).not.toBe(a);
  expect(list).toEqual(["live", "ghost"]);
});
