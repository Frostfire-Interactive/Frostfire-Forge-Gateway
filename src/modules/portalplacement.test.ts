import { expect, test } from "bun:test";
// The editor's modules read the page when loaded: a bare stand-in is enough for the rules.
// Another test's partial document is hidden while they load, so the page's own start-up is skipped.
const page = globalThis as any;
const realWindow = page.window, realDocument = page.document;
page.window ??= { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} };
page.document = undefined;
const { PortalPart } = await import("../webserver/public/js/core/portaleditorbridge").finally(() => {
  page.window = realWindow;
  page.document = realDocument;
});

// "Place at my position" (and a new portal) puts the portal where the editor stands when it is placed, not where they
// stand when they press Save: an editor who walks to the destination to read its place, and saves there, keeps the
// portal where they placed it.

type Sent = { type: string; packet?: string; data?: any };

function part() {
  const sent: Sent[] = [];
  const shell = new Proxy({}, { get: (_t, key) => key === "send" ? (m: Sent) => void sent.push(m) : () => undefined });
  const host = new Proxy({}, { get: () => () => undefined });
  const p: any = new PortalPart(shell as any, host as any);
  // the form and list are drawn in the page; only the rules are tested here
  p.renderForm = () => undefined;
  p.renderList = () => undefined;
  p.chrome = () => undefined;
  p.showProblems = () => undefined;
  return { p, sent };
}

const data = (here: { x: number; y: number } | null) =>
  ({ map: "fields", portals: [], dungeons: {}, maps: [{ name: "fields", widthPx: 4000, heightPx: 4000 }], here, nameMax: 48, sizeMin: 8, sizeMax: 512 });

test("a placed portal stays where the editor stood when placing it, wherever they save from", () => {
  const { p, sent } = part();
  p.adopt(data({ x: 100, y: 100 }));
  const d = p.blank();
  p.open(d, null, true);
  // the place is asked for when placing: the list's position may be old
  expect(sent.some((m) => m.packet === "PORTAL_EDITOR_LIST")).toBe(true);
  p.adopt(data({ x: 300, y: 300 }));
  expect(d.position).toEqual({ x: 284, y: 284 });
  // later lists (the editor has walked to the destination) do not move it
  p.adopt(data({ x: 2000, y: 2000 }));
  expect(d.position).toEqual({ x: 284, y: 284 });
  d.destination = "teleport";
  d.target = { map: "fields", x: 2000, y: 2000 };
  p.save();
  const save = sent.find((m) => m.packet === "PORTAL_EDITOR_SAVE");
  expect(save?.data.position).toEqual({ x: 284, y: 284 });
  expect(save?.data.atMe).not.toBe(true);
  // the save is not answered here: its wait for the server ends with the test
  clearTimeout(p.pendingTimer);
});

test("Place at my position on an open portal is pinned the same way", () => {
  const { p, sent } = part();
  p.adopt(data({ x: 100, y: 100 }));
  const d = p.blank();
  p.open(d, null, true);
  p.adopt(data({ x: 100, y: 100 }));
  sent.length = 0;
  p.placeAtMe(d);
  expect(sent.some((m) => m.packet === "PORTAL_EDITOR_LIST")).toBe(true);
  p.adopt(data({ x: 600, y: 700 }));
  expect(d.position).toEqual({ x: 584, y: 684 });
  p.adopt(data({ x: 50, y: 50 }));
  expect(d.position).toEqual({ x: 584, y: 684 });
});

test("the destination's Place at my position sets the map and place to where the editor stands when clicking it", () => {
  const { p, sent } = part();
  p.adopt(data({ x: 100, y: 100 }));
  const d = p.blank();
  p.open(d, null, true);
  p.adopt(data({ x: 100, y: 100 }));
  d.destination = "teleport";
  sent.length = 0;
  p.arriveAtMe(d);
  expect(sent.some((m) => m.packet === "PORTAL_EDITOR_LIST")).toBe(true);
  p.adopt(data({ x: 1500, y: 1600 }));
  expect(d.target).toEqual({ map: "fields", x: 1500, y: 1600 });
  // the portal itself stays where it was placed
  expect(d.position).toEqual({ x: 84, y: 84 });
  // walking back to the portal to save does not move the destination
  p.adopt(data({ x: 100, y: 100 }));
  expect(d.target).toEqual({ map: "fields", x: 1500, y: 1600 });
});

test("an open portal stays open on another map and is saved on its own map", () => {
  const { p, sent } = part();
  p.adopt(data({ x: 100, y: 100 }));
  const d = p.blank();
  p.open(d, null, true);
  p.adopt(data({ x: 100, y: 100 }));
  d.name = "Gate";
  d.destination = "teleport";
  // the editor walks to the destination map
  p.adopt({ ...data({ x: 700, y: 900 }), map: "caves", maps: [{ name: "fields", widthPx: 4000, heightPx: 4000 }, { name: "caves", widthPx: 2000, heightPx: 2000 }] });
  expect(p.draft).toBe(d);
  expect(p.dirty).toBe(true);
  p.arriveAtMe(d);
  p.adopt({ ...data({ x: 800, y: 950 }), map: "caves", maps: [{ name: "fields", widthPx: 4000, heightPx: 4000 }, { name: "caves", widthPx: 2000, heightPx: 2000 }] });
  expect(d.target).toEqual({ map: "caves", x: 800, y: 950 });
  // the portal is not moved to where the editor stands on another map
  expect(d.position).toEqual({ x: 84, y: 84 });
  sent.length = 0;
  p.save();
  const save = sent.find((m) => m.packet === "PORTAL_EDITOR_SAVE");
  expect(save?.data.map).toBe("fields");
  expect(save?.data.position).toEqual({ x: 84, y: 84 });
  clearTimeout(p.pendingTimer);
});
