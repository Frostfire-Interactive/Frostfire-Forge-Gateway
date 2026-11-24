import { expect, test } from "bun:test";
import { switchLayers } from "../webserver/public/js/core/layerswitch";

// A pose change reaches every layer of a character (body, head, armour) together. Applied one layer at a time, as each
// layer's frames came ready, the body walked down while the head still played the last pose, or every layer ran its
// walk from a different start: the walk down after a portal drew mixed, out-of-step frames.

type Layer = { frames: string[]; currentFrame: number; lastFrameTime: number };
const layer = (frames: string[]): Layer => ({ frames, currentFrame: 2, lastFrameTime: 5 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

test("every layer switches at once, from the same start, when the last one's frames are ready", async () => {
  const body = layer(["idle"]), head = layer(["idle"]);
  const slow = deferred<string[] | null>();
  const done = switchLayers(
    [body, head],
    l => (l === body ? Promise.resolve(["walk-body"]) : slow.promise),
    () => true,
    () => 100
  );
  await Promise.resolve();
  await Promise.resolve();
  // the body's frames are ready, the head's are not: nothing is switched yet
  expect(body.frames).toEqual(["idle"]);
  slow.resolve(["walk-head"]);
  await done;
  expect(body.frames).toEqual(["walk-body"]);
  expect(head.frames).toEqual(["walk-head"]);
  expect([body.currentFrame, head.currentFrame]).toEqual([0, 0]);
  expect([body.lastFrameTime, head.lastFrameTime]).toEqual([100, 100]);
});

test("a change overtaken by a newer one switches no layer", async () => {
  const body = layer(["idle"]), head = layer(["idle"]);
  let current = true;
  const slow = deferred<string[] | null>();
  const done = switchLayers([body, head], l => (l === body ? Promise.resolve(["old-body"]) : slow.promise), () => current, () => 100);
  current = false;
  slow.resolve(["old-head"]);
  await done;
  expect(body.frames).toEqual(["idle"]);
  expect(head.frames).toEqual(["idle"]);
});

test("a layer with no such animation keeps its frames", async () => {
  const body = layer(["idle"]), mount = layer(["saddle"]);
  await switchLayers([body, mount], l => Promise.resolve(l === body ? ["walk"] : null), () => true, () => 100);
  expect(body.frames).toEqual(["walk"]);
  expect(mount.frames).toEqual(["saddle"]);
  expect(mount.currentFrame).toBe(2);
});

// A pose given in the frame it is drawn (the walk into a portal, a moment after the warp faced the player down) is
// drawn in that frame: frames already built switch at once, not after the frame has drawn the last pose's frames.
test("frames already built switch every layer at once, before the change returns", () => {
  const body = layer(["idle"]), head = layer(["idle"]);
  void switchLayers([body, head], l => (l === body ? ["walk-body"] : ["walk-head"]), () => true, () => 100);
  expect(body.frames).toEqual(["walk-body"]);
  expect(head.frames).toEqual(["walk-head"]);
  expect([body.lastFrameTime, head.lastFrameTime]).toEqual([100, 100]);
});
