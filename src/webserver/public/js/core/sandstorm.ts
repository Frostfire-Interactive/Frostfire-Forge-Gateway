import { makeZoneStorm, type ZoneStormFrame } from "./zonestorm.ts";

export type SandstormFrame = ZoneStormFrame;

/** Draws the sandstorm for this frame. Returns how much of it is shown, 0 to 1. */
export const drawSandstorm = makeZoneStorm({
  zones: "deserts",
  tintId: "sandstorm-tint",
  tint: "rgb(224, 158, 88)",
  blend: "multiply",
  tintMax: 0.72,
  haze: "196, 142, 84",
  hazeMax: 0.4,
  edgeMax: 0.38,
  billow: (t) => [196 - t * 40, 138 - t * 36, 78 - t * 26],
  billowAlpha: 1,
  count: 1400,
  // A light, a middle and a dark tone: against sand, a grain is seen by being lighter or darker than it.
  tones: ["252, 232, 186", "226, 178, 112", "142, 94, 50"],
  far: [0.9, 1.9],
  near: [1.8, 4],
  // dust drifts and swirls, slower than the wind that carries it
  drift: 0.45,
  fall: 0,
  swirl: false,
});
