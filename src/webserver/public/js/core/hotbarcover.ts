/** How much of the screen's bottom the hotbar covers, in screen pixels: the camera keeps a map's bottom edge above it.
 *  A hotbar that is not shown has no size; never more than half the screen, whatever is measured. */
export function hotbarCover(bar: { top: number; height: number } | undefined, screenHeight: number): number {
  if (!bar || bar.height <= 0 || bar.top >= screenHeight) return 0;
  return Math.max(0, Math.min(screenHeight / 2, screenHeight - bar.top));
}
