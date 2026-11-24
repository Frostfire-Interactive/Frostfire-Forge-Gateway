import { expect, test } from "bun:test";
// worldzoom.ts reads the page: a bare stand-in is enough for the zoom's ease.
const page = globalThis as any;
const realWindow = page.window, realDocument = page.document, realStorage = page.localStorage;
const handlers: Record<string, (event: any) => void> = {};
page.window = {
  innerWidth: 1600, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  addEventListener: (type: string, fn: (event: any) => void) => { handlers[type] = fn; },
};
page.document = { getElementById: () => null };
page.localStorage = { getItem: () => null, setItem() {} };
const zoom = await import("../webserver/public/js/core/worldzoom");

// The camera is placed for the zoom the frame is drawn at. Placed for the last frame's zoom while the zoom eases, a
// small map's edge swings past where it stops (under the hotbar) and back.

test("the zoom stepped before the camera is the zoom the frame is drawn at", () => {
  try {
    const ctx = { setTransform() {} } as any;
    zoom.installWorldZoom();
    zoom.applyWorldTransform(ctx, 1000);
    // one level in, as Ctrl + plus asks
    handlers.keydown!({ ctrlKey: true, key: "+", preventDefault() {} });
    zoom.stepWorldZoom(1016);
    const placedFor = zoom.userZoom();
    expect(placedFor).toBeGreaterThan(1);
    zoom.applyWorldTransform(ctx, 1016);
    expect(zoom.userZoom()).toBe(placedFor);
    // while the zoom eases nothing is put on a whole pixel: a map's edge kept in place (above the hotbar) would flick
    // between two rows of pixels each frame
    expect(zoom.snapWorld(10.3)).toBe(10.3);
    let t = 1016;
    while (zoom.userZoom() !== 2 && t < 5000) zoom.stepWorldZoom((t += 16));
    expect(zoom.userZoom()).toBe(2);
    expect(zoom.snapWorld(10.3)).toBe(10.5);
  } finally {
    page.window = realWindow;
    page.document = realDocument;
    page.localStorage = realStorage;
  }
});
