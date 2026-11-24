import { expect, test } from "bun:test";
import { LeaveHold } from "../webserver/public/js/core/leavehold";

// Walking into a portal, the players and NPCs of the map being left stay until that map goes (under the fade): the
// server's despawns for them come while the walk in is still drawn.

test("nothing is kept back while no portal is walked into", () => {
  const hold = new LeaveHold<string>();
  expect(hold.hold("a", 0)).toBe(false);
  expect(hold.release()).toEqual([]);
});

test("a despawn during the walk in is kept until the map is cleared", () => {
  const hold = new LeaveHold<string>();
  expect(hold.hold("a", 300)).toBe(true);
  hold.mapChanging();
  // the walk ends, the map change is still under way: still kept
  expect(hold.walkEnded()).toEqual([]);
  expect(hold.hold("b", 0)).toBe(true);
  expect(hold.release()).toEqual(["a", "b"]);
  expect(hold.hold("c", 0)).toBe(false);
});

test("a walk in that ends with no map change lets go of what it kept", () => {
  const hold = new LeaveHold<string>();
  hold.hold("a", 300);
  expect(hold.walkEnded()).toEqual(["a"]);
  expect(hold.release()).toEqual([]);
});
