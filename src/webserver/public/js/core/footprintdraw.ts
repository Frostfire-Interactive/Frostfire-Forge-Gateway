export type PrintStyle = "boot" | "bare" | "hole";

export interface PrintShape { x: number; y: number; angle: number; style: PrintStyle; color: string; side?: number }

const MASKS: Record<PrintStyle, string[]> = {
  boot: [
    ".##...#####.",
    "###..#+#+#+#",
    "###..#+#+#+#",
    "###..#+#+#+#",
    ".##...#####.",
  ],
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
