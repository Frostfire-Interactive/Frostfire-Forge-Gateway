/**
 * USER REQUEST 2026-10-19 ("Now make similar weather but for a blizzard in the snow biome"): the blizzard, drawn on the
 * weather canvas when the weather is "blizzard" (or a tornado's storm, or any wind of the real weather: the server
 * marks those `blizzard: true`) and the player stands in one of the map's snow zones (window.mapData.snowfields,
 * outlines in tiles, sent with a world). Outside them, or on a map with none, the sky is clear. A zone storm
 * (zonestorm.ts, which draws it, as it draws the sandstorm), with the look below.
 *
 * What a real one looks like, from back to front:
 * - the light goes dim and cold under the storm cloud: a slate blue multiplied over the scene (snow turns grey-blue,
 *   so what is white in the air shows against it);
 * - the air is full of snow: a pale haze, much thicker away from the player, so beyond a short way all goes white;
 * - snow lifted off the ground rolls past in white billows, driven along the wind, sinking as it falls;
 * - flakes in three whites driven almost flat along the wind, falling as much as the weather's precipitation says (a
 *   blizzard with nothing falling, snow blown off the ground, still blows), swirling up and down in the gusts, the
 *   nearest the largest and quickest.
 *
 * How harsh it is comes from the wind speed (a few mph a faint drift of snow, 15 a light storm, 35 a heavy one, 45 and
 * over a whiteout): the seeded blizzard blows at 35.
 */
import { makeZoneStorm, type ZoneStormFrame } from "./zonestorm.ts";

export type BlizzardFrame = ZoneStormFrame;

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
