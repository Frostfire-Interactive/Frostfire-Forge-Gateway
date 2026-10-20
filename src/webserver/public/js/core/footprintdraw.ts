// How a footprint is drawn, apart from where it is laid: the game (footprints.ts) and the map editor's preview of the
// Footprints tab (tileeditorbridge.ts) draw the very same prints. No imports: the editor window loads it on its own.
//
// Pixel art, as the rest of the game is (USER FEEDBACK 2026-10-20: "This is a pixel art game, why are you making the
// footprints resemble real life"): each style is a few pixels drawn by hand, laid on whole world pixels, never turned
// by a fraction or smoothed. A print faces the nearest of the eight ways: the four straight ones turn one mask by quarter
// turns, the four diagonals another, drawn for walking down and right (USER FEEDBACK 2026-10-20: "Diagonal footprints
// just show up as cardinal directions"). A left foot is the right one mirrored across the line walked.

export type PrintStyle = "boot" | "bare" | "hole";

/**
 * A print to draw: where (world px), walked which way (radians: 0 walks toward +x), its style and its colour, and which
 * foot made it (`side`: 1 the right, -1 the left).
 */
export interface PrintShape { x: number; y: number; angle: number; style: PrintStyle; color: string; side?: number }

/**
 * The prints of a right foot walking right (+x): heel at the left, toes at the right, the foot's inner side on the top
 * row. "#" is a pixel pressed deep (the full darkness), "+" one pressed lighter, "." none.
 */
const MASKS: Record<PrintStyle, string[]> = {
  // (USER FEEDBACK 2026-10-20: "too small", twice: now two thirds of a tile long and five pixels wide)
  // a heel, a gap, and the sole with its tread
  boot: [
    ".##...#####.",
    "###..#+#+#+#",
    "###..#+#+#+#",
    "###..#+#+#+#",
    ".##...#####.",
  ],
  // the heel and the ball of the foot, joined along the outer side; no toes (USER FEEDBACK 2026-10-20: "bare feet don't
  // need toes")
  bare: [
    "......#####.",
    ".###..######",
    "####..######",
    "############",
    ".#########..",
  ],
  // a hole: deep, darkest along its upper edge, where it is in its own shadow
  hole: [
    "..#####..",
    ".#######.",
    "+++++++++",
    "+++++++++",
    ".+++++++.",
    "..+++++..",
  ],
};

/**
 * The prints of a right foot walking down and right (+x, +y), heel at the top left, toes at the bottom right, the
 * foot's inner side toward the top right. A hole has none: it is not turned.
 */
const DIAGONAL_MASKS: Record<"boot" | "bare", string[]> = {
  // as long and as wide across the line walked as the straight prints are
  boot: [
    ".##.......",
    "####......",
    "####......",
    ".##..#....",
    "....##+#..",
    "...##+###.",
    "....+##+##",
    "....##+#+#",
    ".....##+##",
    "......###.",
  ],
  bare: [
    ".###......",
    "####......",
    "####......",
    ".######...",
    "...#######",
    "....######",
    ".....#####",
    ".....#####",
    ".......##.",
  ],
};

type Pixels = Array<[number, number, number]>;

/** A mask as pixel offsets from its middle, with how deep each is. */
function pixelsOf(rows: string[]): Pixels {
  const cx = Math.floor((rows[0]!.length - 1) / 2), cy = Math.floor((rows.length - 1) / 2);
  const pixels: Pixels = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const depth = row[x] === "#" ? 1 : row[x] === "+" ? 0.6 : 0;
      if (depth) pixels.push([x - cx, y - cy, depth]);
    }
  });
  return pixels;
}

/** Every mask as pixels: worked out once. */
const PIXELS = Object.fromEntries((Object.keys(MASKS) as PrintStyle[]).map((style) => [style, pixelsOf(MASKS[style])])) as Record<PrintStyle, Pixels>;
const DIAGONAL_PIXELS = { boot: pixelsOf(DIAGONAL_MASKS.boot), bare: pixelsOf(DIAGONAL_MASKS.bare) };

/** One print, on whole world pixels, facing the nearest of the eight ways it could have been walked. */
export function drawPrint(ctx: CanvasRenderingContext2D, print: PrintShape, alpha: number): void {
  // which eighth of a turn: 0 right, 1 down and right, 2 down, ... 7 up and right
  const eighth = ((Math.round(print.angle / (Math.PI / 4)) % 8) + 8) % 8;
  // the deep holes are not turned: the light falls from above whichever way the walker went
  const hole = print.style === "hole";
  const diagonal = !hole && eighth % 2 === 1;
  const turns = hole ? 0 : diagonal ? (eighth - 1) / 2 : eighth / 2;
  const mirror = !hole && (print.side ?? 1) < 0;
  const pixels = diagonal ? DIAGONAL_PIXELS[print.style as "boot" | "bare"] : PIXELS[print.style];
  const ox = Math.round(print.x), oy = Math.round(print.y);
  ctx.save();
  ctx.fillStyle = print.color;
  for (const [px0, py0, depth] of pixels) {
    // a left foot: mirrored across the line walked (across x for a straight mask, across the diagonal for a diagonal one)
    const [px, py] = !mirror ? [px0, py0] : diagonal ? [py0, px0] : [px0, -py0];
    // a quarter turn at a time: from walking right to down, left, up; from walking down and right to down and left, ...
    const [dx, dy] = turns === 0 ? [px, py] : turns === 1 ? [-py, px] : turns === 2 ? [-px, -py] : [py, -px];
    ctx.globalAlpha = alpha * depth;
    ctx.fillRect(ox + dx, oy + dy, 1, 1);
  }
  ctx.restore();
}
