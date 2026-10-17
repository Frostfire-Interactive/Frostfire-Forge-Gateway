// Item links in chat. Shift + left click on an item (anywhere an element carries
// data-item-name) writes [Item Name] at the caret. The engine turns each real [Item Name] of a relayed line into a
// link (data.links), shown here as a coloured span; clicking it opens the item tooltip, clicking it again or
// anywhere else closes it. Achievements link the same way: Shift + left click on an element that carries
// data-achievement-name (a row of the achievements window) writes [Achievement Name]; the engine sends it as a link of
// kind "achievement", shown in green, and clicking it opens the reader's own achievements window at that achievement.

type TooltipModule = typeof import("./tooltip.js");

const QUALITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);

let tooltipModule: TooltipModule | null = null;
let openLink: HTMLElement | null = null;

function chatInputEl(): HTMLInputElement | null {
  return document.getElementById("chat-input") as HTMLInputElement | null;
}

/** What a typed achievement link is coloured by, in place of a rarity. */
const ACHIEVEMENT = "achievement";

/** The links put into the chat box since it was last empty: "[name]" -> rarity (or "achievement"), for the coloured copy. */
const typedLinks = new Map<string, string>();

/** Writes [name] at the caret of the chat input (replacing any selection) and keeps focus there. */
export function insertItemLink(name: string, quality = "common"): void {
  const input = chatInputEl();
  if (!input || !name) return;
  const token = `[${name}]`;
  typedLinks.set(token, quality === ACHIEVEMENT || QUALITIES.has(quality) ? quality : "common");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(token, start, end, "end");
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Writes [name] of an achievement at the caret of the chat input, as insertItemLink does for an item. */
export function insertAchievementLink(name: string): void {
  insertItemLink(name, ACHIEVEMENT);
}

function holderAt(target: EventTarget | null): HTMLElement | null {
  return (target as Element | null)?.closest?.("[data-item-name], [data-achievement-name]") as HTMLElement | null;
}

function linkNameAt(target: EventTarget | null): string {
  const holder = holderAt(target);
  return holder?.dataset.itemName || holder?.dataset.achievementName || "";
}

/**
 * The rarity of a clicked item: its data-item-quality when set, else a rarity class on the element or inside it (bag
 * slots carry one), else the item as the client holds it (socket.ts itemsByName), else common.
 */
function qualityAt(holder: HTMLElement, name: string): string {
  const set = holder.dataset.itemQuality?.toLowerCase();
  if (set && QUALITIES.has(set)) return set;
  for (const node of [holder, ...Array.from(holder.querySelectorAll("*"))]) {
    for (const quality of QUALITIES) if (node.classList.contains(quality)) return quality;
  }
  const held = (window as any).itemsByName?.get?.(name) ?? (window as any).itemsByName?.get?.(name.toLowerCase());
  const known = String(held?.quality ?? "").toLowerCase();
  return QUALITIES.has(known) ? known : "common";
}

/** Another text field has the keyboard (a search box, a mail being written): a Shift click there selects text. */
function typingElsewhere(input: HTMLInputElement): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === input || active === document.body) return false;
  return active instanceof HTMLTextAreaElement || active.isContentEditable
    || (active instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(active.type));
}

/**
 * Shift + left click on an item links it: the chat box opens (it takes the keyboard, as Enter opens it) if it was not
 * open, and [name] goes in at the caret, or at the end when the box was just opened. USER REQUEST 2026-10-17:
 * "Shift clicking an item should auto open chat and link it and focus the chat".
 */
function shiftClickInsert(e: MouseEvent): boolean {
  if (!e.shiftKey || e.button !== 0) return false;
  const input = chatInputEl();
  if (!input || typingElsewhere(input)) return false;
  const holder = holderAt(e.target);
  const itemName = holder?.dataset.itemName ?? "";
  const achievementName = itemName ? "" : (holder?.dataset.achievementName ?? "");
  const name = itemName || achievementName;
  if (!holder || !name) return false;
  e.preventDefault();
  e.stopPropagation();
  if (document.activeElement !== input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  insertItemLink(name, achievementName ? ACHIEVEMENT : qualityAt(holder, name));
  return true;
}

// ------------------------------------------------------------------------------------------------ the chat box
// An <input> shows one colour, so while it holds links its text is made see-through (the caret stays) and a copy is
// laid over it, matching its font, padding and size, with each link in its rarity colour. The copy scrolls with it.

let mirror: HTMLDivElement | null = null;
let mirrorText: HTMLSpanElement | null = null;
let mirrorQueued = false;

/**
 * The chat box's own text shadow, read while it is not see-through: once it holds links its shadow is turned off
 * (#chat-input.has-links), so the copy cannot read it from the box then.
 */
let boxShadow: string | null = null;

const COPIED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "textAlign",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "boxSizing", "lineHeight", "width", "height",
] as const;

function placeMirror(input: HTMLInputElement): HTMLDivElement {
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.id = "chat-input-mirror";
    mirror.className = "ui";
    mirror.setAttribute("aria-hidden", "true");
    mirrorText = document.createElement("span");
    mirror.appendChild(mirrorText);
  }
  // beside the input, wherever it lives now (the phone chat moves it)
  if (mirror.parentElement !== input.parentElement || mirror.nextSibling !== input) input.before(mirror);
  const style = getComputedStyle(input);
  for (const prop of COPIED_STYLES) (mirror.style as any)[prop] = style[prop];
  if (!input.classList.contains("has-links")) boxShadow = style.textShadow;
  mirror.style.textShadow = boxShadow ?? "1px 1px 1px rgba(0, 0, 0, 0.8)";
  mirror.style.borderStyle = "solid";
  mirror.style.borderColor = "transparent";
  mirror.style.left = `${input.offsetLeft}px`;
  mirror.style.top = `${input.offsetTop}px`;
  mirror.style.zIndex = String((Number(style.zIndex) || 0) + 1);
  return mirror;
}

function paintChatBox(): void {
  mirrorQueued = false;
  const input = chatInputEl();
  if (!input) return;
  const text = input.value;
  if (text === "") typedLinks.clear();
  const tokens = [...typedLinks.keys()].filter((token) => text.includes(token));
  if (tokens.length === 0) {
    input.classList.remove("has-links");
    if (mirror) mirror.style.display = "none";
    return;
  }
  const box = placeMirror(input);
  box.style.display = "flex";
  input.classList.add("has-links");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(tokens.sort((a, b) => b.length - a.length).map(escape).join("|"), "g");
  const parts: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(document.createTextNode(text.slice(last, at)));
    const span = document.createElement("span");
    const kind = typedLinks.get(match[0]) ?? "common";
    span.className = kind === ACHIEVEMENT ? "achievement-link" : `item-link item-link-${kind}`;
    span.textContent = match[0];
    parts.push(span);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
  mirrorText!.replaceChildren(...parts);
  box.scrollLeft = input.scrollLeft;
}

/** Repaints the coloured copy on the next frame (after the input has moved its caret and scroll). */
function queuePaint(): void {
  if (mirrorQueued) return;
  mirrorQueued = true;
  requestAnimationFrame(paintChatBox);
}

for (const type of ["input", "keydown", "keyup", "select", "focus", "blur", "mouseup", "scroll"]) {
  document.addEventListener(type, (e) => {
    if (e.target === chatInputEl()) queuePaint();
  }, true);
}
window.addEventListener("resize", queuePaint);

// The click (and double click) that follows a Shift click must not also act on the item: taking a mail attachment,
// choosing a quest reward, equipping a bag item.
let swallowClick = false;
document.addEventListener("mousedown", (e) => {
  // Every mousedown decides afresh: a mouseup that never came cannot leave the flag set for a later click.
  swallowClick = shiftClickInsert(e);
}, true);
document.addEventListener("mouseup", () => {
  if (swallowClick) setTimeout(() => { swallowClick = false; }, 0);
}, true);
document.addEventListener("click", (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener("dblclick", (e) => {
  if (!e.shiftKey) return;
  const input = chatInputEl();
  if (!input || typingElsewhere(input) || !linkNameAt(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

function closeLink(): void {
  if (!openLink) return;
  openLink = null;
  tooltipModule?.hideItemTooltip();
}

async function toggleLink(link: HTMLElement, data: any, x: number, y: number): Promise<void> {
  // Open only while its tooltip is still showing: a slot's hover can have replaced or hidden it since.
  const shown = document.getElementById("item-tooltip")?.style.display === "block";
  if (openLink === link && shown) {
    closeLink();
    return;
  }
  openLink = null;
  const mod = tooltipModule ?? (tooltipModule = await import("./tooltip.js"));
  openLink = link;
  mod.showItemTooltip(link, data, x, y, false, true);
}

// Anywhere else closes it. The link's own click is left to the link (it toggles).
document.addEventListener("click", (e) => {
  if (!openLink) return;
  if ((e.target as Element | null)?.closest?.(".item-link")) return;
  closeLink();
});
document.addEventListener("touchstart", (e) => {
  if (!openLink) return;
  if ((e.target as Element | null)?.closest?.(".item-link")) return;
  closeLink();
}, { passive: true });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLink();
});

function linkSpan(data: any): HTMLSpanElement {
  const quality = String(data.quality ?? "common").toLowerCase();
  const span = document.createElement("span");
  span.className = `item-link item-link-${QUALITIES.has(quality) ? quality : "common"}`;
  span.textContent = `[${data.name}]`;
  span.setAttribute("role", "link");
  span.tabIndex = 0;
  span.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleLink(span, data, e.clientX, e.clientY);
  });
  span.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    const rect = span.getBoundingClientRect();
    void toggleLink(span, data, rect.left, rect.bottom);
  });
  return span;
}

/** An achievement link: green, and a click (or Enter) opens the reader's own achievements window at it. No tooltip. */
function achievementSpan(data: any): HTMLSpanElement {
  const id = Number(data.id);
  const span = document.createElement("span");
  span.className = "achievement-link";
  span.textContent = `[${data.name}]`;
  span.setAttribute("role", "link");
  span.tabIndex = 0;
  const follow = () => { void import("./achievements.js").then((m) => m.focusAchievement(id)); };
  span.addEventListener("click", follow);
  span.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    follow();
  });
  return span;
}

/**
 * Appends text to container as text nodes and links as item-link spans (kind "item", or no kind) or achievement-link
 * spans (kind "achievement" with an id): every exact [name] of links[i] in the text becomes one. Everything else, brackets included, stays plain text (set as text, never as HTML).
 */
export function renderMessageParts(container: HTMLElement, text: string, links?: unknown): void {
  const known = new Map<string, any>();
  if (Array.isArray(links)) {
    for (const entry of links) {
      if (entry && typeof entry.name === "string" && entry.name !== "" && !known.has(`[${entry.name}]`)) {
        known.set(`[${entry.name}]`, entry);
      }
    }
  }
  const message = String(text ?? "");
  if (known.size === 0) {
    container.append(message);
    return;
  }
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = [...known.keys()].sort((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp(tokens.join("|"), "g");
  let last = 0;
  for (const match of message.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) container.append(message.slice(last, at));
    const entry = known.get(match[0]);
    container.appendChild(entry.kind === "achievement" && Number.isFinite(Number(entry.id)) ? achievementSpan(entry) : linkSpan(entry));
    last = at + match[0].length;
  }
  if (last < message.length) container.append(message.slice(last));
}
