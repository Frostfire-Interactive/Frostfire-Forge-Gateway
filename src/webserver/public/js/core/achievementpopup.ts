// The popup for an achievement just earned (ACHIEVEMENT_EARNED from the engine's systems/achievements): at the top centre
// of the screen, over the game, without taking the clicks around it (only its card takes them). It fades out after
// 5 s, or at once from its X. Several earned together are shown one after another. Design: engine repo,
// docs/superpowers/specs/2026-10-17-achievements-design.md.

/** What the server sends of an achievement just earned. */
export interface Earned {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  rewardItem: string | null;
  rewardQuantity: number;
  rewardMount: string | null;
  /** The item did not fit in the bags and was mailed. */
  mailed: boolean;
}

/** How long a popup stays before it fades (ms). */
const SHOWN_MS = 5000;
/** How long the fade takes (ms): the transition of `.achievement-popup-card` in game.css. */
const FADE_MS = 400;

const waiting: Earned[] = [];
let current: { node: HTMLDivElement; timer: number; leaving: boolean } | null = null;

/** The reward in words: "Reward: 3 x Copper Ore, mount Unicorn", a mailed item marked "(sent to your mailbox)". "" for none. */
export function rewardText(reward: { rewardItem: string | null; rewardQuantity: number; rewardMount: string | null; mailed?: boolean }): string {
  const parts: string[] = [];
  if (reward.rewardItem) parts.push(`${Math.max(1, Number(reward.rewardQuantity) || 1)} x ${reward.rewardItem}${reward.mailed ? " (sent to your mailbox)" : ""}`);
  if (reward.rewardMount) parts.push(`mount ${reward.rewardMount}`);
  return parts.length > 0 ? `Reward: ${parts.join(", ")}` : "";
}

function host(): HTMLElement {
  let node = document.getElementById("achievement-popup");
  if (!node) {
    node = document.createElement("div");
    node.id = "achievement-popup";
    node.className = "ui";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
  }
  return node;
}

function line(className: string, text: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = `${className} ui`;
  node.textContent = text;
  return node;
}

function show(earned: Earned): void {
  const card = document.createElement("div");
  card.className = "achievement-popup-card ui";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "panel-close ui";
  close.setAttribute("aria-label", "Close");
  close.textContent = "✕";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    leave();
  });
  // A press on it is not a click on the world behind.
  for (const type of ["mousedown", "touchstart"]) close.addEventListener(type, (event) => event.stopPropagation(), { passive: true });

  const icon = document.createElement("div");
  icon.className = "achievement-popup-icon ui";
  if (earned.icon) {
    const image = document.createElement("img");
    image.src = earned.icon;
    image.alt = "";
    image.draggable = false;
    icon.appendChild(image);
  }

  const text = document.createElement("div");
  text.className = "achievement-popup-text ui";
  text.append(line("achievement-popup-heading", "Achievement earned"), line("achievement-popup-name", earned.name));
  if (earned.description) text.appendChild(line("achievement-popup-description", earned.description));
  const reward = rewardText(earned);
  if (reward) text.appendChild(line("achievement-popup-reward", reward));

  card.append(close, icon, text);
  host().appendChild(card);
  // on the next frame, so the fade in runs
  requestAnimationFrame(() => card.classList.add("shown"));
  current = { node: card, timer: window.setTimeout(leave, SHOWN_MS), leaving: false };
}

/** The popup shown fades and goes; the next one waiting comes after it. */
function leave(): void {
  if (!current || current.leaving) return;
  current.leaving = true;
  window.clearTimeout(current.timer);
  const node = current.node;
  node.classList.remove("shown");
  window.setTimeout(() => {
    node.remove();
    current = null;
    next();
  }, FADE_MS);
}

function next(): void {
  if (current) return;
  const earned = waiting.shift();
  if (earned) show(earned);
}

/** Shows an achievement just earned, after any shown or waiting. */
export function showEarned(earned: Earned): void {
  waiting.push(earned);
  next();
}
