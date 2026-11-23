// Where the hotbar goes so that it never covers the chat box on a narrow screen, as plain numbers (no DOM), so it can be tested.

/** A box on the screen, in CSS pixels from the top left of the viewport. */
export interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface HotbarPlacement {
  /** How far right of where the stylesheet puts it the hotbar is moved (px). */
  shiftX: number;
  /** How far up from where the stylesheet puts it the chat box is moved (px). */
  liftChat: number;
}

/** Room kept between the moved hotbar and the right edge of the screen. */
export const HOTBAR_SCREEN_MARGIN = 10;
/** Room kept between the chat box and the hotbar under it, when the chat has to rise above it. */
export const CHAT_HOTBAR_GAP = 10;

/**
 * The hotbar is centered at the bottom and the chat box sits in the bottom left corner. Where they do not meet, nothing
 * moves (a wide screen looks as the stylesheet draws it). Where they would, the hotbar slides right until it starts
 * where the chat box ends, as long as it then still fits on the screen; on a screen too narrow for the two side by
 * side, the hotbar stays centered and the chat box rises until it ends above the hotbar.
 *
 * `chat` and `hotbar` are where the stylesheet puts them (before any move made here); null when one is not shown.
 */
export function placeHotbar(
  viewportWidth: number,
  chat: ScreenBox | null,
  hotbar: ScreenBox | null,
  margin: number = HOTBAR_SCREEN_MARGIN,
  gap: number = CHAT_HOTBAR_GAP,
): HotbarPlacement {
  const none = { shiftX: 0, liftChat: 0 };
  if (!chat || !hotbar) return none;
  const meetAcross = hotbar.left < chat.right && hotbar.right > chat.left;
  const meetUpDown = hotbar.top < chat.bottom && hotbar.bottom > chat.top;
  if (!meetAcross || !meetUpDown) return none;

  const shiftX = chat.right - hotbar.left;
  if (hotbar.right + shiftX <= viewportWidth - margin) return { shiftX, liftChat: 0 };
  return { shiftX: 0, liftChat: chat.bottom - hotbar.top + gap };
}
