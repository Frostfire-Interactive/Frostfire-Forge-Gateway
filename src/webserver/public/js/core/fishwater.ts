// The water round fishing lines, simulated (USER REQUEST 2026-10-20: "Make the water ripples super realistic", then
// "Even more realistic"). Rings drawn by hand only look like waves; here the surface is a height field that obeys the
// wave equation, so what a real pond does happens by itself: a splash sends out a train of crests that spread and
// slow and fade, waves from two places cross and interfere, a moving bobber leaves a wake, and the shore throws waves
// back where they meet it.
//
// A field is a grid of GRID x GRID cells, CELL px wide and CELL * SQUASH px tall (the water is seen at a slant: a ring
// on it is wider than it is tall). Each cell holds the water's height there. Cells that are not water (the shore, an
// island) are walls: their height stays 0, which reflects the waves. Which cells are water is asked pixel by pixel
// (fishing.ts isWaterPixel), so the waves run up to the rocks a shore tile draws, not to the tile's edge. Near the
// field's edge the waves are damped away, and drawn fading out, so the field's own border is never seen. A field is made where the water is first touched and
// covers a stretch of water round it; a touch outside every field makes another one. A field with nothing moving on it
// for a while is let go.
//
// It is drawn from the slope of the surface, lit from the upper left: a slope facing the light is lit (the sky caught on
// it), one facing away a little darker than the water. Softly (USER FEEDBACK 2026-10-20: at full strength it looked "way
// too 3D", but flat crest lines alone lost the realism): about half the contrast, and the dark side fainter than the
// lit one. Flat water, still or not, draws nothing: the tiles show through.

/** Cells across a field, their width (px), and how much flatter than wide the water is seen. */
const GRID = 240, CELL = 1.5, SQUASH = 0.6;
/** Steps of the simulation each second: with one cell a step, waves travel CELL * SIM_HZ px/s. */
const SIM_HZ = 40;
/** How much of its height a wave keeps each step, and the least kept at the field's edge (over EDGE cells). */
const DAMP = 0.978, EDGE_DAMP = 0.86, EDGE = 14;
/**
 * How many cells in from the field's edge the waves are drawn fading in (USER REPORT 2026-10-20: a ring that reached
 * the edge of the field was cut off): a field's edge is never seen.
 */
const FADE = 36;
/**
 * The light: from the upper left. How strongly a slope shows, the most a lit cell may show (0 to 255), and for a shaded
 * cell, how much weaker than a lit one it is and the most it may show.
 */
const LIGHT_X = -0.55, LIGHT_Y = -0.83, GAIN = 15, LIT_MAX = 95, SHADE = 0.45, SHADE_MAX = 40;
/** A field with less movement than this for QUIET_S is let go (when nothing keeps it). */
const QUIET = 0.5, QUIET_S = 2;
/** At most this many fields at once: the oldest goes first. */
const FIELDS_MAX = 6;

const WIDTH = GRID * CELL, HEIGHT = GRID * CELL * SQUASH;

class WaterField {
  readonly x0: number;
  readonly y0: number;
  private cur = new Float32Array(GRID * GRID);
  private prev = new Float32Array(GRID * GRID);
  private wall = new Uint8Array(GRID * GRID);
  private keep = new Float32Array(GRID * GRID);
  private fade = new Float32Array(GRID * GRID);
  private canvas = document.createElement("canvas");
  private image: ImageData;
  /** How much moved on the last step, and how long it has been quiet (s). */
  energy = 0;
  quiet = 0;
  /** s of simulation not yet stepped. */
  private owed = 0;

  constructor(cx: number, cy: number, isWater: (x: number, y: number) => boolean) {
    this.x0 = Math.round(cx - WIDTH / 2);
    this.y0 = Math.round(cy - HEIGHT / 2);
    this.canvas.width = GRID;
    this.canvas.height = GRID;
    this.image = this.canvas.getContext("2d")!.createImageData(GRID, GRID);
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const [x, y] = this.world(i + 0.5, j + 0.5);
        this.wall[k] = isWater(x, y) ? 0 : 1;
        const fromEdge = Math.min(i, j, GRID - 1 - i, GRID - 1 - j);
        this.keep[k] = fromEdge >= EDGE ? DAMP : DAMP * (EDGE_DAMP + (1 - EDGE_DAMP) * (fromEdge / EDGE));
        const f = Math.min(1, fromEdge / FADE);
        this.fade[k] = f * f * (3 - 2 * f);
      }
    }
  }

  private world(i: number, j: number): [number, number] {
    return [this.x0 + i * CELL, this.y0 + j * CELL * SQUASH];
  }

  /** Whether a world point is inside this field, away from its faded edge (where a touch would be seen faint). */
  holds(x: number, y: number): boolean {
    const i = (x - this.x0) / CELL, j = (y - this.y0) / (CELL * SQUASH);
    return i >= FADE && j >= FADE && i < GRID - FADE && j < GRID - FADE;
  }

  /** Push the water down (`amount` > 0: something falls in) or up, over a round patch `radius` cells wide. */
  poke(x: number, y: number, amount: number, radius: number): void {
    const ci = (x - this.x0) / CELL, cj = (y - this.y0) / (CELL * SQUASH);
    const reach = Math.ceil(radius * 2);
    for (let j = Math.floor(cj) - reach; j <= Math.ceil(cj) + reach; j++) {
      for (let i = Math.floor(ci) - reach; i <= Math.ceil(ci) + reach; i++) {
        if (i < 1 || j < 1 || i >= GRID - 1 || j >= GRID - 1) continue;
        const k = j * GRID + i;
        if (this.wall[k]) continue;
        const d2 = ((i - ci) ** 2 + (j - cj) ** 2) / (radius * radius);
        this.cur[k] -= amount * Math.exp(-d2);
      }
    }
    this.quiet = 0;
  }

  /** Run the simulation on by `dt` s, in whole steps. */
  advance(dt: number): void {
    this.owed = Math.min(this.owed + dt, 4 / SIM_HZ);
    while (this.owed >= 1 / SIM_HZ) {
      this.owed -= 1 / SIM_HZ;
      this.step();
    }
    this.quiet = this.energy < QUIET ? this.quiet + dt : 0;
  }

  /** One step of the wave equation: each cell moves toward the mean of its four neighbours, and keeps its speed. */
  private step(): void {
    const c = this.cur, p = this.prev, wall = this.wall, keep = this.keep;
    let energy = 0;
    for (let j = 1; j < GRID - 1; j++) {
      let k = j * GRID + 1;
      for (let i = 1; i < GRID - 1; i++, k++) {
        if (wall[k]) {
          p[k] = 0;
          continue;
        }
        const next = ((c[k - 1]! + c[k + 1]! + c[k - GRID]! + c[k + GRID]!) * 0.5 - p[k]!) * keep[k]!;
        p[k] = next;
        energy += next < 0 ? -next : next;
      }
    }
    // the new heights were written over the old ones: swap
    this.prev = c;
    this.cur = p;
    this.energy = energy;
  }

  /** Draw the surface, lit by its slopes, onto `ctx` (world space). */
  draw(ctx: CanvasRenderingContext2D): void {
    const c = this.cur, wall = this.wall, fade = this.fade, data = this.image.data;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i, o = k * 4;
        if (wall[k] || i === 0 || j === 0 || i === GRID - 1 || j === GRID - 1) {
          data[o + 3] = 0;
          continue;
        }
        // the slope across and down, and how much of it faces the light
        const sx = c[k + 1]! - c[k - 1]!, sy = c[k + GRID]! - c[k - GRID]!;
        const lit = -(sx * LIGHT_X + sy * LIGHT_Y) * GAIN;
        if (lit >= 0) {
          data[o] = 236; data[o + 1] = 245; data[o + 2] = 255;
          data[o + 3] = (lit > LIT_MAX ? LIT_MAX : lit) * fade[k]!;
        } else {
          const shade = -lit * SHADE;
          data[o] = 6; data[o + 1] = 18; data[o + 2] = 32;
          data[o + 3] = (shade > SHADE_MAX ? SHADE_MAX : shade) * fade[k]!;
        }
      }
    }
    this.canvas.getContext("2d")!.putImageData(this.image, 0, 0);
    ctx.save();
    // smoothed: the cells are larger than the screen's pixels, and water has no edges between them
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, this.x0, this.y0, WIDTH, HEIGHT);
    ctx.restore();
  }
}

const fields: WaterField[] = [];

/**
 * Something touches the water at a world point (px): pushes it down by `amount` (a falling bobber: 20; a drop: 2)
 * over a patch `radius` cells wide. Makes a field there when no field covers it. `isWater` says which points are water.
 */
export function pokeWater(x: number, y: number, amount: number, radius: number, isWater: (x: number, y: number) => boolean): void {
  let field = fields.find((f) => f.holds(x, y));
  if (!field) {
    if (!isWater(x, y)) return;
    field = new WaterField(x, y, isWater);
    fields.push(field);
    if (fields.length > FIELDS_MAX) fields.shift();
  }
  field.poke(x, y, amount, radius);
}

/**
 * Run every field on by `dt` s and draw it. `busy` says whether a world point still has a line on it: a field with one
 * is kept however calm it is, any other is let go once it has been calm for QUIET_S.
 */
export function stepAndDrawWater(ctx: CanvasRenderingContext2D, dt: number, busy: (field: { holds(x: number, y: number): boolean }) => boolean): void {
  for (let n = fields.length - 1; n >= 0; n--) {
    const field = fields[n]!;
    field.advance(dt);
    if (field.quiet > QUIET_S && !busy(field)) {
      fields.splice(n, 1);
      continue;
    }
    if (field.energy > QUIET * 0.5) field.draw(ctx);
  }
}

/** Every field let go (a new map). */
export function clearWater(): void {
  fields.length = 0;
}

/** Whether any water is still being simulated (and so drawn). */
export function waterActive(): boolean {
  return fields.length > 0;
}
