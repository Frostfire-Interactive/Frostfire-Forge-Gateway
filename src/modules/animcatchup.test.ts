import { afterEach, describe, expect, test } from "bun:test";
import { updateLayeredAnimation } from "../webserver/public/js/core/layeredAnimation.ts";

const realNow = performance.now.bind(performance);
let clock = 0;
performance.now = () => clock;
afterEach(() => { clock = 0; });

function anim(frameCount: number, delay: number, startAt: number): any {
  const frames = Array.from({ length: frameCount }, () => ({ delay }));
  return { layers: { body: { frames, currentFrame: 0, lastFrameTime: startAt } } };
}

describe("layered animation after a hidden tab", () => {
  test("a long pause does not leave a backlog that plays fast afterwards", () => {
    const a = anim(4, 100, 1000);
    clock = 1000 + 60_000;
    updateLayeredAnimation(a, 0.016);
    const after = a.layers.body.currentFrame;
    for (let i = 0; i < 5; i++) { clock += 16; updateLayeredAnimation(a, 0.016); }
    expect(a.layers.body.currentFrame).toBe(after);
  });

  test("normal playback keeps one frame per delay", () => {
    const a = anim(4, 100, 1000);
    for (clock = 1000; clock <= 1000 + 350; clock += 16) updateLayeredAnimation(a, 0.016);
    expect(a.layers.body.currentFrame).toBe(3);
  });

  test("a slow frame rate still lands on the right frame", () => {
    const a = anim(8, 50, 1000);
    clock = 1000 + 175;
    updateLayeredAnimation(a, 0.175);
    expect(a.layers.body.currentFrame).toBe(3);
  });
});

process.on("exit", () => { performance.now = realNow; });
