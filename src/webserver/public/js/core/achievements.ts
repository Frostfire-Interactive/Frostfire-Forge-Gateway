// The achievements window (key Y): every achievement there is, earned ones with the date they were earned, the
// others with a progress bar. The list is asked for (ACHIEVEMENTS_LIST) each time the window opens, and again after
// one is earned while it is open. It closes only by its X or by its key (and Esc), never by a click outside it.
// Design: engine repo, docs/superpowers/specs/2026-10-17-achievements-design.md.
import { sendRequest } from "./socket.js";
import { rewardText, showEarned, type Earned } from "./achievementpopup.js";

/** One achievement as the server lists it for this player. */
export interface AchievementView {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  type: string;
  count: number;
  progress: number;
  completedAt: number | null;
  rewardItem: string | null;
  rewardQuantity: number;
  rewardMount: string | null;
}

const panel = () => document.getElementById("achievements-container") as HTMLDivElement | null;
const listBox = () => document.getElementById("achievements-list") as HTMLDivElement | null;

let held: AchievementView[] = [];
/** The server has answered at least once. */
let loaded = false;
/** An achievement to scroll to and mark once the list asked for arrives (a chat link was clicked). */
let focusId: number | null = null;
/** How long the achievement a chat link points at stays marked. */
const FOCUS_MS = 2000;

export function isAchievementsOpen(): boolean {
  return panel()?.style.display === "flex";
}

export function openAchievements(): void {
  const node = panel();
  if (!node) return;
  node.style.display = "flex";
  node.classList.add("open");
  render();
  sendRequest({ type: "ACHIEVEMENTS_LIST", data: null });
}

export function closeAchievements(): void {
  const node = panel();
  if (!node) return;
  node.style.display = "none";
  node.classList.remove("open");
}

/** The key: opens it when closed, closes it when open. Whether it is open now. */
export function toggleAchievements(): boolean {
  if (isAchievementsOpen()) closeAchievements();
  else openAchievements();
  return isAchievementsOpen();
}

/** ACHIEVEMENTS: the list as the server has it. */
export function onAchievements(data: any): void {
  held = Array.isArray(data?.achievements) ? data.achievements : [];
  loaded = true;
  render();
  if (focusId !== null) {
    const id = focusId;
    focusId = null;
    reveal(id);
  }
}

/**
 * A link to an achievement in chat ("<name> has completed [<achievement>]") was clicked: the reader's own window
 * opens (as Y opens it, the other windows closing) and scrolls to that achievement with the reader's own progress,
 * marked for a moment. It is found once the fresh list arrives.
 */
export function focusAchievement(id: number): void {
  if (!Number.isFinite(id)) return;
  const open = (window as any).openAchievementsWindow as (() => void) | undefined;
  if (isAchievementsOpen()) {
    reveal(id);
    return;
  }
  focusId = id;
  if (open) open();
  else openAchievements();
}

/** Scrolls the list to an achievement and marks it for FOCUS_MS. Nothing when it is not listed (switched off). */
function reveal(id: number): void {
  const target = listBox()?.querySelector<HTMLElement>(`[data-achievement-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("focused");
  setTimeout(() => target.classList.remove("focused"), FOCUS_MS);
}

/** How long after the last earn of a burst the list is asked for again: one request, under the server's limit. */
const REFRESH_DELAY_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** ACHIEVEMENT_EARNED: the popup, and the list again when the window is open (once, after a burst). */
export function onEarned(data: any): void {
  if (!data || typeof data.name !== "string") return;
  showEarned(data as Earned);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (isAchievementsOpen()) sendRequest({ type: "ACHIEVEMENTS_LIST", data: null });
  }, REFRESH_DELAY_MS);
}

function div(className: string, text = ""): HTMLDivElement {
  const node = document.createElement("div");
  node.className = `${className} ui`;
  if (text) node.textContent = text;
  return node;
}

function row(a: AchievementView): HTMLDivElement {
  const item = div(a.completedAt ? "achievement-row earned" : "achievement-row");
  item.dataset.achievementId = String(a.id);
  item.dataset.achievementName = a.name;
  const icon = div("achievement-icon");
  if (a.icon) {
    const image = document.createElement("img");
    image.src = a.icon;
    image.alt = "";
    image.draggable = false;
    icon.appendChild(image);
  }
  const body = div("achievement-body");
  body.appendChild(div("achievement-name", a.name));
  if (a.description) body.appendChild(div("achievement-description", a.description));
  if (a.completedAt) {
    body.appendChild(div("achievement-earned", `Earned ${new Date(Number(a.completedAt)).toLocaleDateString()}`));
  } else {
    const count = Math.max(1, Number(a.count) || 1);
    const progress = Math.min(Math.max(0, Number(a.progress) || 0), count);
    const bar = div("achievement-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(count));
    bar.setAttribute("aria-valuenow", String(progress));
    const fill = div("achievement-bar-fill");
    fill.style.width = `${Math.round((progress / count) * 100)}%`;
    bar.append(fill, div("achievement-bar-text", `${progress} / ${count}`));
    body.appendChild(bar);
  }
  const reward = rewardText(a);
  if (reward) body.appendChild(div("achievement-reward", reward));
  item.append(icon, body);
  return item;
}

function render(): void {
  const box = listBox();
  if (!box) return;
  box.replaceChildren();
  if (!loaded) return;
  if (held.length === 0) {
    box.appendChild(div("achievements-empty", "No achievements yet."));
    return;
  }
  // the server's order (by id): the list does not jump about as one is earned
  for (const a of held) box.appendChild(row(a));
}
