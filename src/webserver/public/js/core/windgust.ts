// The gusts of the wind and the look of each wind streak, as plain numbers (no drawing), so they can be tested.

/** Period (s), weight and phase of the slow waves that add up to the wind's strength. Their periods share no common beat, so the pattern does not visibly repeat. */
const GUST_WAVES: ReadonlyArray<readonly [number, number, number]> = [
  [13.7, 0.55, 1.7],
  [7.3, 0.3, 0.4],
  [4.1, 0.15, 2.6],
];
/** Where the summed waves (-1 to 1) start to count as a gust, and how far above that a gust is at its full strength. */
const GUST_FLOOR = -0.25, GUST_SPAN = 0.95;

const smoothstep = (x: number): number => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

/**
 * How hard the wind gusts at `seconds`, 0 (a lull) to 1 (the peak of a gust).
 * It rises and falls over one to a few seconds, about two fifths of the time is a lull, and the gaps between gusts are uneven.
 */
export function windGust(seconds: number): number {
  let s = 0;
  for (let i = 0; i < GUST_WAVES.length; i++) {
    const w = GUST_WAVES[i];
    s += w[1] * Math.sin((Math.PI * 2 * seconds) / w[0] + w[2]);
  }
  return smoothstep((s - GUST_FLOOR) / GUST_SPAN);
}

/** The wind speed with its gust, mph: the base speed in a lull, half as much again at the peak of a gust (the same scale as `calculateWindSpeed`). */
export function gustedWindSpeed(mph: number, gust: number): number {
  return mph + mph * gust * 0.5;
}

/** How many wind streaks start per second: none in still air, more as the wind and the gust rise, and only a few in a lull. */
export function streakRate(mph: number, gust: number): number {
  if (!(mph > 0)) return 0;
  return Math.min(4, (0.2 + 0.08 * mph) * (0.3 + 1.4 * gust));
}

/** How fast a streak travels along its path, px per second. */
export function streakSpeed(mph: number, gust: number): number {
  return Math.min(900, 260 + Math.max(0, gustedWindSpeed(mph, gust)) * 18);
}

/**
 * How visible a streak is at `progress` (0 when it starts, 1 when it has gone): it fades in over the first fifth
 * and out over the last third, so it never pops in or out.
 */
export function streakLife(progress: number): number {
  if (!(progress > 0) || progress >= 1) return 0;
  return Math.min(smoothstep(progress / 0.2), smoothstep((1 - progress) / 0.35));
}

export interface StreakTraits {
  /** Turn away from the wind's direction, radians. */
  lean: number;
  /** Length of the path the streak travels, px. */
  length: number;
  /** Length of the visible line, px. */
  trail: number;
  /** This streak's own share of the wind's pace. */
  pace: number;
  /** Half the width of the line at its widest, px. */
  halfWidth: number;
  /** Opacity at the middle of its life. */
  alpha: number;
  /** Height of the path's wave, px. */
  amp: number;
  /** Whether the path curls once on its way. */
  curl: boolean;
}

/** An empty set of traits for `rollStreakTraits` to fill. */
export function newStreakTraits(): StreakTraits {
  return { lean: 0, length: 0, trail: 0, pace: 1, halfWidth: 1, alpha: 0, amp: 0, curl: false };
}

/**
 * Fills `out` with the look of a new streak, from `rand` (0 to 1). Each streak differs a little in angle, length, pace,
 * width and opacity; most are faint. In a gust they are longer, brighter and curl more often.
 */
export function rollStreakTraits(out: StreakTraits, gust: number, rand: () => number = Math.random): StreakTraits {
  const g = gust < 0 ? 0 : gust > 1 ? 1 : gust;
  out.lean = (rand() - 0.5) * 0.24;
  out.length = 280 + rand() * 280;
  out.trail = (100 + rand() * 110) * (0.85 + 0.35 * g);
  out.pace = 0.8 + rand() * 0.4;
  out.halfWidth = 0.7 + rand() * 0.9;
  out.alpha = (0.3 + Math.pow(rand(), 1.6) * 0.45) * (0.75 + 0.35 * g);
  out.amp = 3 + rand() * 10;
  out.curl = rand() < 0.25 + 0.25 * g;
  return out;
}
