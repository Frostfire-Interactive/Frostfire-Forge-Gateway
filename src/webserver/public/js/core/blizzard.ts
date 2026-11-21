import { makeZoneStorm } from "./zonestorm.ts";

/** Draws the blizzard for this frame. Returns how much of it is shown, 0 to 1. */
export const drawBlizzard = makeZoneStorm({
  zones: "snowfields",
  tintId: "blizzard-tint",
  tint: "rgb(138, 154, 182)",
  blend: "multiply",
  tintMax: 0.62,
  haze: "222, 230, 240",
  hazeMax: 0.22,
  edgeMax: 0.5,
  // whiter where thicker
  billow: (t) => [226 + t * 29, 232 + t * 23, 242 + t * 13],
  // (USER REPORT 2026-10-19: "The cloud like particles are too visible": less than half what they were)
  billowAlpha: 0.6,
  count: 1800,
  tones: ["255, 255, 255", "244, 249, 255", "222, 232, 246"],
  far: [0.9, 1.9],
  near: [2, 4],
  // snow goes with the wind more than dust does
  drift: 0.6,
  fall: 140,
  swirl: true,
});
