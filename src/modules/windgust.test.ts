import { expect, test } from "bun:test";
import {
  gustedWindSpeed, newStreakTraits, rollStreakTraits, streakLife, streakRate, streakSpeed, windGust,
} from "../webserver/public/js/core/windgust";

// Ten minutes of the gust curve, sampled at 60 frames a second.
const FPS = 60, SECONDS = 600;
const samples: number[] = [];
for (let i = 0; i < FPS * SECONDS; i++) samples.push(windGust(i / FPS));

test("the gust stays between 0 and 1", () => {
  for (const g of samples) {
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
  }
});

test("the wind has lulls and full gusts, and spends most of its time between", () => {
  const share = (f: (g: number) => boolean) => samples.filter(f).length / samples.length;
  expect(share(g => g < 0.05)).toBeGreaterThan(0.2);
  expect(share(g => g < 0.05)).toBeLessThan(0.5);
  expect(share(g => g > 0.8)).toBeGreaterThan(0.05);
  expect(share(g => g > 0.8)).toBeLessThan(0.3);
});

test("a gust rises and falls over about a second or more, not from one frame to the next", () => {
  // The shortest time from a lull (below 0.1) to a gust (above 0.9), and back.
  let lowAt = -1, highAt = -1, quickestRise = Infinity, quickestFall = Infinity;
  samples.forEach((g, i) => {
    const t = i / FPS;
    if (g < 0.1) { if (highAt >= 0) quickestFall = Math.min(quickestFall, t - highAt); highAt = -1; lowAt = t; }
    if (g > 0.9) { if (lowAt >= 0) quickestRise = Math.min(quickestRise, t - lowAt); lowAt = -1; highAt = t; }
  });
  expect(quickestRise).toBeGreaterThan(0.8);
  expect(quickestFall).toBeGreaterThan(0.8);
});

test("gusts come at uneven times", () => {
  // The starts of each gust (the curve passing 0.5 on its way up), in seconds.
  const starts: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0.5 && samples[i] >= 0.5) starts.push(i / FPS);
  expect(starts.length).toBeGreaterThan(SECONDS / 20);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const spread = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  expect(spread / mean).toBeGreaterThan(0.2);
  expect(Math.min(...gaps)).toBeGreaterThan(1);
});

test("the gust adds up to half the base wind speed and no more", () => {
  expect(gustedWindSpeed(20, 0)).toBe(20);
  expect(gustedWindSpeed(20, 1)).toBe(30);
  expect(gustedWindSpeed(0, 1)).toBe(0);
});

test("streaks come only in a wind, more often in a gust and in a stronger wind, and stay sparse", () => {
  expect(streakRate(0, 1)).toBe(0);
  expect(streakRate(-5, 1)).toBe(0);
  expect(streakRate(20, 1)).toBeGreaterThan(streakRate(20, 0) * 3);
  expect(streakRate(40, 0.5)).toBeGreaterThan(streakRate(10, 0.5));
  expect(streakRate(20, 0)).toBeGreaterThan(0);
  expect(streakRate(100, 1)).toBeLessThanOrEqual(4);
});

test("streaks run faster in a gust and in a stronger wind, up to a limit", () => {
  expect(streakSpeed(20, 1)).toBeGreaterThan(streakSpeed(20, 0));
  expect(streakSpeed(30, 0)).toBeGreaterThan(streakSpeed(10, 0));
  expect(streakSpeed(0, 0)).toBe(260);
  expect(streakSpeed(100, 1)).toBe(900);
});

test("a streak fades in at its start and out at its end, and is fully shown in between", () => {
  expect(streakLife(0)).toBe(0);
  expect(streakLife(1)).toBe(0);
  expect(streakLife(-0.1)).toBe(0);
  expect(streakLife(0.5)).toBe(1);
  expect(streakLife(0.02)).toBeLessThan(0.1);
  expect(streakLife(0.98)).toBeLessThan(0.1);
  let last = 0;
  for (let p = 0.01; p <= 0.2; p += 0.01) { expect(streakLife(p)).toBeGreaterThanOrEqual(last); last = streakLife(p); }
  last = 1;
  for (let p = 0.65; p < 1; p += 0.01) { expect(streakLife(p)).toBeLessThanOrEqual(last + 1e-12); last = streakLife(p); }
});

/** A seeded random number source, so the rolls repeat. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test("each streak differs a little in angle, length, pace, width and opacity, within bounds", () => {
  const rand = seeded(7), t = newStreakTraits();
  const seen = { lean: new Set<number>(), length: new Set<number>(), pace: new Set<number>(), halfWidth: new Set<number>(), alpha: new Set<number>() };
  let curls = 0;
  for (let i = 0; i < 500; i++) {
    rollStreakTraits(t, Math.random(), rand);
    expect(Math.abs(t.lean)).toBeLessThanOrEqual(0.12);
    expect(t.length).toBeGreaterThanOrEqual(280);
    expect(t.length).toBeLessThanOrEqual(560);
    expect(t.trail).toBeLessThan(t.length);
    expect(t.pace).toBeGreaterThanOrEqual(0.8);
    expect(t.pace).toBeLessThanOrEqual(1.2);
    expect(t.halfWidth).toBeGreaterThan(0.5);
    expect(t.halfWidth).toBeLessThan(2);
    expect(t.alpha).toBeGreaterThan(0);
    expect(t.alpha).toBeLessThanOrEqual(1);
    if (t.curl) curls++;
    seen.lean.add(t.lean); seen.length.add(t.length); seen.pace.add(t.pace); seen.halfWidth.add(t.halfWidth); seen.alpha.add(t.alpha);
  }
  for (const values of Object.values(seen)) expect(values.size).toBeGreaterThan(400);
  expect(curls).toBeGreaterThan(50);
  expect(curls).toBeLessThan(300);
});

test("most streaks are faint", () => {
  const rand = seeded(11), t = newStreakTraits();
  let faint = 0;
  for (let i = 0; i < 1000; i++) if (rollStreakTraits(t, 0.5, rand).alpha < 0.5) faint++;
  expect(faint).toBeGreaterThan(500);
});

test("in a gust streaks are longer and brighter", () => {
  const calm = newStreakTraits(), gusty = newStreakTraits();
  rollStreakTraits(calm, 0, seeded(3));
  rollStreakTraits(gusty, 1, seeded(3));
  expect(gusty.trail).toBeGreaterThan(calm.trail);
  expect(gusty.alpha).toBeGreaterThan(calm.alpha);
  expect(gusty.length).toBe(calm.length);
});

test("rolling the traits fills the object it is given", () => {
  const t = newStreakTraits();
  expect(rollStreakTraits(t, 0.3, seeded(1))).toBe(t);
});
