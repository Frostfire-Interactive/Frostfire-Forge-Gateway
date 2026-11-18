import { expect, test } from "bun:test";
import { hiddenOf, shownConnections } from "../gateway/onlinecount";

// USER REQUEST 2026-11-14: stealthed admins are left out of the count the realm list shows.

test("the shown count leaves out the hidden players", () => {
  expect(shownConnections({ activeConnections: 10, hiddenConnections: 2 })).toBe(8);
  expect(shownConnections({ activeConnections: 3 })).toBe(3);
});

test("the shown count is never below zero", () => {
  expect(shownConnections({ activeConnections: 1, hiddenConnections: 4 })).toBe(0);
  expect(shownConnections({ activeConnections: 0, hiddenConnections: 0 })).toBe(0);
});

test("a heartbeat's hidden count is a whole number, 0 when missing or odd", () => {
  expect([hiddenOf(2), hiddenOf(undefined), hiddenOf(null), hiddenOf("3"), hiddenOf(-1), hiddenOf(NaN), hiddenOf(2.7)]).toEqual([2, 0, 0, 0, 0, 0, 2]);
});
