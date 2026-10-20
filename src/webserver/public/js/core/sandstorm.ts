/**
 * USER REQUEST 2026-10-16 ("a new weather called sandstorm that only happens when the player is in the desert biome.
 * It should tint the screen and look identical to a real life sandstorm"; "if it's windy with the weather_api, a
 * sandstorm should occur at different levels of harshness"): the sandstorm, drawn on the weather canvas when the
 * weather is "sandstorm" (or a tornado's storm) and the player stands in one of the map's desert zones
 * (window.mapData.deserts, outlines in tiles, sent with a world). Outside a desert, or on a map with none, the sky is
 * clear. It is a zone storm (zonestorm.ts, which draws it), with the look below.
 *
 * What a real one looks like, from back to front:
 * - the light itself turns orange: a full-screen tint under the weather canvas, multiplied over the scene;
 * - the air is thick with dust, lighter and flatter than the ground: an even haze, denser away from the player, so
 *   only what is near is seen clearly;
 * - the dust rolls past in billows, browner than the sand, so a billow is seen rolling over the ground, the thickest
 *   the darkest;
 * - dust blows by in round motes, soft at the edge, in three tones, the nearest the largest and quickest (USER
 *   REQUEST 2026-10-16: "The sand particles should be circles, not lines. It should look like dust"; then "Make the
 *   particles a little smaller").
 *
 * How harsh it is comes from the wind speed: the seeded sandstorm blows at 35, a dry reading of the real weather at
 * SANDSTORM_WIND (1, any wind, systems/weatherapi.ts in the engine) or more.
 *
 * The rest of its history, kept in zonestorm.ts's code since 2026-10-19 (the blizzard is drawn the same way):
 * - USER REPORT 2026-10-16 ("Why do the sand particle bob like they are in water? That's unrealistic"): a mote was
 *   swung across the wind on a sine, the same beat over and over. Air does not beat: a mote is pushed by turbulence, a
 *   random walk of its speed along the wind that is pulled back toward none (an Ornstein-Uhlenbeck process).
 * - USER REPORT 2026-10-16 ("they are too visible when there is barely any sand being blown"): how many motes, and how
 *   solid, both follow the harshness (6 mph about 5% of them at half strength, 15 mph about 25%, 35 mph about 90%).
 * - USER REPORT 2026-10-17 ("the particles should only ever move left or right, not up or down because it makes it
 *   look like snow"): the sand blows left with a wind to the left, and right with any other; its turbulence speeds and
 *   slows it along the wind, never up or down (`swirl` false, `fall` 0).
 * - USER REPORT 2026-10-17 ("Sandstorm when weather_api is selected flickers"): the clouds were placed by the camera's
 *   place in the world plus how far they had drifted, past what the graphics card keeps exactly on the 10240-tile
 *   world; each place is now taken within one repeat of their pattern, and a gust is eased in and out.
 */
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
