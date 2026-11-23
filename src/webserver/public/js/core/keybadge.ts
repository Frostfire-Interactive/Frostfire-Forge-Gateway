import { codeLabel, getKey, type ActionId } from "./keybinds.js";

export type BadgeStyle = {
  /** The circle's radius at the normal zoom, in CSS pixels. */
  radius: number;
  /** The letter's size at the normal zoom, in CSS pixels. */
  font: number;
  fill: string;
  ring: string;
  ringWidth: number;
  text: string;
  /** The blur of a dark shadow round the letter, 0 for none. */
  shadow: number;
  /** How far the letter is moved down to look centred, in CSS pixels. */
  nudge: number;
};

/** White ring and letter: the NPC, corpse, chest, mailbox and gathering badges. */
export const PLAIN_BADGE: BadgeStyle = {
  radius: 10, font: 11, fill: "rgba(0, 0, 0, 0.6)", ring: "#FFFFFF", ringWidth: 1.5, text: "#FFFFFF", shadow: 3, nudge: 0.5,
};
/** Larger, a softer ring: the loot badge. */
export const LOOT_BADGE: BadgeStyle = {
  radius: 14, font: 12, fill: "rgba(0, 0, 0, 0.65)", ring: "rgba(255, 255, 255, 0.6)", ringWidth: 2, text: "#FFFFFF", shadow: 0, nudge: 0,
};

/** The key an action is bound to, as a badge shows it. */
export function badgeLabel(action: ActionId): string {
  return codeLabel(getKey(action));
}

export function badgeBox(radius: number, scale: number, textWidth: number): { halfWidth: number; halfHeight: number } {
  const r = radius * scale;
  return { halfWidth: Math.max(r, textWidth / 2 + r * 0.6), halfHeight: r };
}

/** The length round a pill `halfWidth` by `halfHeight` (a circle when the two are the same). */
export function pillPerimeter(halfWidth: number, halfHeight: number): number {
  return 4 * Math.max(0, halfWidth - halfHeight) + 2 * Math.PI * halfHeight;
}

/** A pill round (x, y), from the top centre clockwise, so a ring drawn part way along it starts at the top. */
function pillPath(ctx: CanvasRenderingContext2D, x: number, y: number, halfWidth: number, halfHeight: number): void {
  const reach = Math.max(0, halfWidth - halfHeight);
  ctx.beginPath();
  ctx.moveTo(x, y - halfHeight);
  ctx.lineTo(x + reach, y - halfHeight);
  ctx.arc(x + reach, y, halfHeight, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x - reach, y + halfHeight);
  ctx.arc(x - reach, y, halfHeight, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

export function drawKeyBadge(
  ctx: CanvasRenderingContext2D, x: number, y: number, action: ActionId, scale: number, style: BadgeStyle, progress = 0,
): void {
  const label = badgeLabel(action);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.font = `bold ${style.font * scale}px 'Comic Relief', sans-serif`;
  const { halfWidth, halfHeight } = badgeBox(style.radius, scale, ctx.measureText(label).width);

  if (progress > 0) {
    const gap = 4 * scale;
    pillPath(ctx, x, y, halfWidth + gap, halfHeight + gap);
    const length = pillPerimeter(halfWidth + gap, halfHeight + gap);
    ctx.setLineDash([length * Math.min(1, progress), length]);
    ctx.strokeStyle = "#FFD700";
    ctx.lineWidth = 3 * scale;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  pillPath(ctx, x, y, halfWidth, halfHeight);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.strokeStyle = style.ring;
  ctx.lineWidth = style.ringWidth * scale;
  ctx.stroke();

  ctx.fillStyle = style.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (style.shadow > 0) {
    ctx.shadowColor = "rgba(0, 0, 0, 1)";
    ctx.shadowBlur = style.shadow * scale;
  }
  ctx.fillText(label, x, y + style.nudge * scale);
  ctx.restore();
}
