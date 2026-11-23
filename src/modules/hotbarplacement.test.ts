import { describe, expect, test } from "bun:test";
import { placeHotbar, type ScreenBox } from "../webserver/public/js/core/hotbarplacement.ts";

// The desktop stylesheet: the chat box 520 x 360 at left 10 / bottom 10, the hotbar 500 x 152 centered at bottom 25.
const HEIGHT = 900;
const chat: ScreenBox = { left: 10, right: 530, top: HEIGHT - 370, bottom: HEIGHT - 10 };
const hotbarAt = (width: number): ScreenBox => ({ left: width / 2 - 250, right: width / 2 + 250, top: HEIGHT - 177, bottom: HEIGHT - 25 });

const overlaps = (a: ScreenBox, b: ScreenBox) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function placed(width: number) {
  const hotbar = hotbarAt(width);
  const place = placeHotbar(width, chat, hotbar);
  const movedHotbar = { ...hotbar, left: hotbar.left + place.shiftX, right: hotbar.right + place.shiftX };
  const movedChat = { ...chat, top: chat.top - place.liftChat, bottom: chat.bottom - place.liftChat };
  return { place, movedHotbar, movedChat };
}

describe("hotbar placement beside the chat box", () => {
  test("a wide screen keeps the centered hotbar where it is", () => {
    for (const width of [1560, 1600, 1920, 2560]) expect(placeHotbar(width, chat, hotbarAt(width))).toEqual({ shiftX: 0, liftChat: 0 });
  });

  test("below 1560 px the hotbar slides right to start where the chat box ends", () => {
    const { place, movedHotbar } = placed(1280);
    expect(place).toEqual({ shiftX: 140, liftChat: 0 });
    expect(movedHotbar.left).toBe(530);
    expect(movedHotbar.right).toBe(1030);
  });

  test("the slid hotbar stays on the screen, down to 1040 px", () => {
    expect(placed(1040).place).toEqual({ shiftX: 260, liftChat: 0 });
    expect(placed(1040).movedHotbar.right).toBe(1030);
  });

  test("narrower than that the hotbar stays centered and the chat box rises above it", () => {
    const { place, movedChat, movedHotbar } = placed(1000);
    expect(place).toEqual({ shiftX: 0, liftChat: 177 });
    expect(movedChat.bottom).toBe(movedHotbar.top - 10);
  });

  test("at no width do the two overlap", () => {
    for (let width = 320; width <= 2600; width += 7) {
      const { movedChat, movedHotbar } = placed(width);
      expect(overlaps(movedChat, movedHotbar)).toBe(false);
    }
  });

  test("a scaled-down layout is handled from the boxes alone", () => {
    // The 0.65 chat and 0.75 hotbar of a short landscape window, 900 px wide.
    const small: ScreenBox = { left: 25, right: 25 + 520 * 0.65, top: HEIGHT - 25 - 360 * 0.65, bottom: HEIGHT - 25 };
    const bar: ScreenBox = { left: 450 - 187.5, right: 450 + 187.5, top: HEIGHT - 5 - 152 * 0.75, bottom: HEIGHT - 5 };
    const place = placeHotbar(900, small, bar);
    expect(place.liftChat).toBe(0);
    expect(bar.left + place.shiftX).toBe(small.right);
  });

  test("nothing moves when either one is not shown", () => {
    expect(placeHotbar(800, null, hotbarAt(800))).toEqual({ shiftX: 0, liftChat: 0 });
    expect(placeHotbar(800, chat, null)).toEqual({ shiftX: 0, liftChat: 0 });
  });
});
