// Mail, as in World of Warcraft. Mailboxes stand in front of inns: the server
// says where on the map the player is on (MAILBOXES), and they are drawn among
// the characters, back to front. At one, E or a click opens the mail window:
// the player's mail (MAIL_INBOX), and a page to write a mail with items and
// coins attached. The server holds the mail and makes every change; it sends
// the mail again after each one, and the player's bags and coins with it.
//
// The recipient field only suggests names from the player's friends list, and
// Reply fills it in only for a friend: any other name is typed.
import { config } from "../web/global.js";
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { itemFrame } from "./itemframe.js";
import { setupItemTooltip, hideItemTooltip } from "./tooltip.js";
import { openInventory, stopMovement } from "./input.js";
import { coinHtml } from "./coins.js";
import { spareOf } from "./trade.js";
import { teleportsHome, isSoulbound } from "./consumables.js";
import { canvasDpr, worldToScreen } from "./worldzoom.js";

const cache = Cache.getInstance();

interface Coins { gold: number; silver: number; copper: number }
interface MailItem { name: string; quantity: number; quality?: string; icon?: string | null; iconUrl?: string; [field: string]: unknown }
interface Mail {
  id: number;
  sender: string;
  subject: string;
  body: string;
  items: MailItem[];
  coins: Coins;
  sentAt: number;
  expiresAt: number;
  read: boolean;
  returned: boolean;
}
interface Inbox { mail: Mail[]; postage: number; itemsMax: number; subjectMax: number; bodyMax: number }
interface Mailbox { id: string; x: number; y: number }
type Tab = "inbox" | "send";

/** How far (px) from a mailbox the player may stand to open it: the server's reach. */
const USE_RADIUS = 120;
/** How far the player may walk from every mailbox before the window closes: a little past where the server stops. */
const CLOSE_RADIUS = 160;
/** The mailbox picture's size (px), standing on its foot: mailbox.png is 32 by 64. */
const BOX_SIZE = 32;
const BOX_HEIGHT = 64;
const COIN_LIMITS: Coins = { gold: 9999999, silver: 99, copper: 99 };
const COIN_KINDS: Array<keyof Coins> = ["gold", "silver", "copper"];
const DAY_MS = 86_400_000;

/** A phone or a tablet: no mouse, so no right-click and no hover. */
const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

/** The mailboxes of the map the player is on, and the picture they are drawn with. */
let boxes: { map: string; list: Mailbox[]; picture: HTMLImageElement | null } = { map: "", list: [], picture: null };
let inbox: Inbox | null = null;
let popup: HTMLDivElement | null = null;
let tab: Tab = "inbox";
/** The mail being read, by id: null for the list. */
let reading: number | null = null;
/** How many mails are unread, as the server last said. */
let unread = 0;
let sending = false;
/** The mail being written, kept while the window is drawn again. */
let draft = { to: "", subject: "", body: "", items: [] as Array<{ name: string; quantity: number }>, coins: { gold: 0, silver: 0, copper: 0 } as Coins };

const shown = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const whole = (value: unknown, most: number) => Math.min(most, Math.max(0, Math.floor(Number(value) || 0)));
const worth = (coins: Coins) => (Number(coins.gold) || 0) * 10000 + (Number(coins.silver) || 0) * 100 + (Number(coins.copper) || 0);
const iconOf = (item: MailItem) => item.iconUrl || (item.icon ? `${config.ASSET_SERVER_URL}/icon?name=${encodeURIComponent(item.icon)}` : null);
const mapName = (map: unknown) => String(map ?? "").replace(".json", "").toLowerCase();

function me(): any {
  return Array.from(cache.players).find((player: any) => player.id === cachedPlayerId);
}

/** The names on the player's friends list. */
function friends(): string[] {
  const list = me()?.friends;
  return Array.isArray(list) ? list.map(String) : [];
}

const isFriend = (name: string) => friends().some((friend) => friend.toLowerCase() === name.toLowerCase());

/** Whether the mail window is open. */
export function isMailOpen(): boolean {
  return inbox !== null;
}

// ----------------------------------------------------------------- mailboxes

/** Where the mailboxes of a map stand (MAILBOXES). */
export function setMailboxes(data: { map: string; mailboxes: Mailbox[]; iconUrl?: string }) {
  if (!data || !Array.isArray(data.mailboxes)) return;
  let picture = boxes.picture;
  if (data.iconUrl && picture?.dataset.url !== data.iconUrl) {
    picture = new Image();
    picture.dataset.url = data.iconUrl;
    picture.src = data.iconUrl;
  }
  boxes = { map: mapName(data.map), list: data.mailboxes, picture };
  // A new map: the envelope is put back if the minimap was rebuilt.
  showMailIndicator();
}

/** The mailboxes of a map: none until the server has said where they are. */
function mailboxesOf(map: unknown): Mailbox[] {
  return boxes.map === mapName(map) ? boxes.list : [];
}

/** The mailbox nearest a point, within `radius`. */
function nearest(map: unknown, x: number, y: number, radius: number): Mailbox | null {
  let found: Mailbox | null = null;
  let best = Infinity;
  for (const box of mailboxesOf(map)) {
    const distance = Math.hypot(box.x - x, box.y - y);
    if (distance <= radius && distance < best) {
      best = distance;
      found = box;
    }
  }
  return found;
}

/** Where the player stands. The map is the one loaded: a player held here does not say which map it is on. */
function playerSpot(): { map: string; x: number; y: number } | null {
  const player = me();
  if (!player) return null;
  return {
    map: String((window as any).mapData?.name ?? ""),
    x: Number(player.position?.x ?? player.renderPosition?.x),
    y: Number(player.position?.y ?? player.renderPosition?.y),
  };
}

/** Whether the player stands at a mailbox. */
export function nearMailbox(): boolean {
  const at = playerSpot();
  return !!at && nearest(at.map, at.x, at.y, USE_RADIUS) !== null;
}

/** Opens the mail window of the mailbox the player stands at. False when there is none in reach. */
export function openNearestMailbox(): boolean {
  if (!nearMailbox()) return false;
  sendRequest({ type: "MAIL_OPEN", data: null });
  return true;
}

/** The mailbox drawn under a point of the world (a click), if any. */
export function mailboxAt(worldX: number, worldY: number, slop = 0): Mailbox | null {
  const at = playerSpot();
  if (!at) return null;
  const half = BOX_SIZE / 2 + slop;
  return mailboxesOf(at.map).find((box) => worldX >= box.x - half && worldX <= box.x + half && worldY >= box.y - BOX_HEIGHT - slop && worldY <= box.y + slop) ?? null;
}

/** The mailboxes of a map, each to be drawn among the characters at its foot. */
(window as any).mailboxesHere = (map: unknown): Mailbox[] => mailboxesOf(map);

/** Draws one mailbox, in world coordinates: a shadow, and the picture standing on its foot. */
(window as any).drawMailbox = (ctx: CanvasRenderingContext2D, box: Mailbox) => {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(box.x, box.y - 2, BOX_SIZE * 0.4, 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fill();
  const picture = boxes.picture;
  if (picture?.complete && picture.naturalWidth > 0) ctx.drawImage(picture, box.x - BOX_SIZE / 2, box.y - BOX_HEIGHT, BOX_SIZE, BOX_HEIGHT);
  // While the mailbox editor is open (mailboxeditor.ts): a frame round each, gold round the picked one.
  const mark = (window as any).mailboxEditorMark?.(box);
  if (mark) {
    ctx.setLineDash(mark === "picked" ? [] : [4, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = mark === "picked" ? "#ffd700" : "rgba(255, 241, 218, 0.8)";
    ctx.strokeRect(box.x - BOX_SIZE / 2 - 3, box.y - BOX_HEIGHT - 3, BOX_SIZE + 6, BOX_HEIGHT + 6);
  }
  ctx.restore();
};

/** The E badge over the mailbox the player stands at, in screen space. Not while the window is open, nor when E talks to an NPC instead. */
(window as any).renderMailboxHint = (ctx: CanvasRenderingContext2D, npcNear: boolean) => {
  if (inbox || npcNear || TOUCH) return;
  const at = playerSpot();
  const box = at ? nearest(at.map, at.x, at.y, USE_RADIUS) : null;
  if (!box) return;
  const dpr = canvasDpr();
  const spot = worldToScreen(box.x, box.y - BOX_HEIGHT - 14);
  const x = spot.x * dpr;
  const y = spot.y * dpr;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fill();
  // White, as an NPC's E badge is (npc.ts renderNpcInteractBadge).
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold ${11 * dpr}px 'Comic Relief', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 1)";
  ctx.shadowBlur = 3 * dpr;
  ctx.fillText("E", x, y + 0.5 * dpr);
  ctx.restore();
};

// Walking away from every mailbox closes the window. Past the radius the server refuses anyway.
(window as any).updateMailProximity = (playerX: number, playerY: number) => {
  if (!inbox) return;
  const at = playerSpot();
  if (!at || !nearest(at.map, playerX, playerY, CLOSE_RADIUS)) closeMail();
};

// ---------------------------------------------------------------- the window

// Keys typed in the window's fields are the window's: the game does not walk, cast or open the chat on them.
// Escape leaves the field being typed in, or closes the window. Seen first, so the pause menu is not opened under it.
function onKey(event: KeyboardEvent) {
  if (!popup) return;
  const focused = document.activeElement as HTMLElement | null;
  const typing = !!focused && popup.contains(focused) && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA");
  // The friend list under the To field takes its keys first: the arrows, Enter to pick, Escape to put it away.
  if (typing && suggestionKeys?.(event)) {
    event.stopPropagation();
    return;
  }
  if (event.code === "Escape") {
    event.stopPropagation();
    if (typing) focused!.blur();
    else closeMail();
    return;
  }
  if (!typing) return;
  event.stopPropagation();
  // Enter in a one-line field goes on to the next one.
  if (event.key === "Enter" && focused!.tagName === "INPUT") {
    event.preventDefault();
    const fields = Array.from(popup.querySelectorAll<HTMLElement>(".mail-send input, .mail-send textarea"));
    fields[fields.indexOf(focused!) + 1]?.focus();
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const made = document.createElement("button");
  made.type = "button";
  made.className = className;
  made.innerText = label;
  made.addEventListener("click", onClick);
  return made;
}

/** How long a mail has left, in words. */
function timeLeft(mail: Mail): string {
  const left = Math.max(0, mail.expiresAt - Date.now());
  const days = Math.floor(left / DAY_MS);
  if (days >= 1) return `${days} d`;
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  return `${hours} h`;
}

const hasAttachments = (mail: Mail) => mail.items.length > 0 || worth(mail.coins) > 0;

function setStatus(text: string) {
  const status = popup?.querySelector(".mail-status") as HTMLElement | null;
  if (status) status.innerText = text;
}

function renderTabs() {
  if (!popup || !inbox) return;
  const tabs = popup.querySelector(".mail-tabs") as HTMLElement;
  tabs.replaceChildren(...(["inbox", "send"] as Tab[]).map((which) => {
    const pick = button(which === "inbox" ? `Inbox${unread > 0 ? ` (${unread})` : ""}` : "Send Mail", "mail-tab", () => {
      if (tab === which && reading === null) return;
      tab = which;
      reading = null;
      setStatus("");
      render();
    });
    pick.setAttribute("role", "tab");
    pick.setAttribute("aria-selected", String(tab === which));
    return pick;
  }));
}

/** The sender of reward mail from the achievements (engine systems/achievements). Stored as returned so it cannot be sent back, but it was never returned. */
const REWARD_SENDER = "Achievement Rewards";

/** Whether to label the mail "(returned)": a returned mail, except the achievement rewards. */
function returnedMark(mail: Mail): boolean {
  return mail.returned && mail.sender !== REWARD_SENDER;
}

/** One mail in the list: who sent it, its subject, what is attached and how long it has left. */
function rowFor(mail: Mail): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `mail-row${mail.read ? "" : " unread"}`;
  const first = mail.items[0];
  row.appendChild(first ? itemFrame(iconOf(first), first.quality, 32, first.name) : envelope());

  const text = document.createElement("span");
  text.className = "mail-row-text";
  const from = document.createElement("span");
  from.className = "mail-from";
  from.innerText = returnedMark(mail) ? `${mail.sender} (returned)` : mail.sender;
  const subject = document.createElement("span");
  subject.className = "mail-subject";
  subject.innerText = mail.subject;
  text.append(from, subject);

  const left = document.createElement("span");
  left.className = "mail-left";
  left.innerText = timeLeft(mail);
  if (worth(mail.coins) > 0) {
    const coins = document.createElement("span");
    coins.className = "mail-row-coins";
    coins.innerHTML = coinHtml(worth(mail.coins));
    row.append(text, coins, left);
  } else {
    row.append(text, left);
  }
  row.addEventListener("click", () => openMail(mail));
  return row;
}

function envelope(): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = "mail-envelope";
  mark.innerText = "✉";
  return mark;
}

function openMail(mail: Mail) {
  reading = mail.id;
  if (!mail.read) {
    mail.read = true;
    sendRequest({ type: "MAIL_READ", data: { mailId: mail.id } });
  }
  setStatus("");
  render();
}

function inboxPage(): HTMLElement {
  const list = document.createElement("div");
  list.className = "mail-list";
  if (!inbox || inbox.mail.length === 0) {
    const none = document.createElement("p");
    none.className = "mail-none";
    none.innerText = "No mail.";
    list.appendChild(none);
    return list;
  }
  list.append(...inbox.mail.map(rowFor));
  return list;
}

/** What is attached to a mail being read: each item is taken with a click, and so are the coins. */
function attachmentsOf(mail: Mail): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "mail-slots";
  mail.items.forEach((item, index) => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "mail-slot filled";
    slot.title = "Take";
    slot.dataset.itemName = item.name;
    slot.appendChild(itemFrame(iconOf(item), item.quality, 40, item.name));
    if (item.quantity > 1) {
      const count = document.createElement("span");
      count.className = "mail-count";
      count.innerText = String(item.quantity);
      slot.appendChild(count);
    }
    setupItemTooltip(slot, () => ({ ...item, iconUrl: iconOf(item) }));
    slot.addEventListener("click", () => {
      hideItemTooltip();
      sendRequest({ type: "MAIL_TAKE", data: { mailId: mail.id, part: index } });
    });
    grid.appendChild(slot);
  });
  if (worth(mail.coins) > 0) {
    const coins = document.createElement("button");
    coins.type = "button";
    coins.className = "mail-coins-take";
    coins.title = "Take";
    coins.innerHTML = coinHtml(worth(mail.coins));
    coins.addEventListener("click", () => sendRequest({ type: "MAIL_TAKE", data: { mailId: mail.id, part: "coins" } }));
    grid.appendChild(coins);
  }
  return grid;
}

function readingPage(mail: Mail): HTMLElement {
  const page = document.createElement("div");
  page.className = "mail-read";

  const subject = document.createElement("h3");
  subject.innerText = mail.subject;
  const from = document.createElement("p");
  from.className = "mail-meta";
  from.innerText = `From ${mail.sender}${returnedMark(mail) ? " (returned)" : ""} · ${timeLeft(mail)} left`;
  const body = document.createElement("div");
  body.className = "mail-body";
  body.innerText = mail.body;
  page.append(subject, from, body);
  if (hasAttachments(mail)) page.appendChild(attachmentsOf(mail));

  const actions = document.createElement("div");
  actions.className = "mail-actions";
  actions.appendChild(button("Back", "mail-button", () => {
    reading = null;
    render();
  }));
  if (hasAttachments(mail)) {
    actions.appendChild(button("Take All", "mail-button primary", () => sendRequest({ type: "MAIL_TAKE", data: { mailId: mail.id, part: "all" } })));
  }
  // Reply fills in the recipient only for a friend: any other name is typed.
  if (!mail.returned && isFriend(mail.sender)) {
    actions.appendChild(button("Reply", "mail-button", () => {
      draft = { ...draft, to: mail.sender, subject: mail.subject.startsWith("Re: ") ? mail.subject : `Re: ${mail.subject}`.slice(0, inbox?.subjectMax ?? 64) };
      tab = "send";
      reading = null;
      render();
      (popup?.querySelector(".mail-send textarea") as HTMLElement | null)?.focus();
    }));
  }
  if (!mail.returned) {
    actions.appendChild(button("Return", "mail-button", () => sendRequest({ type: "MAIL_RETURN", data: { mailId: mail.id } })));
  }
  const remove = button("Delete", "mail-button danger", () => sendRequest({ type: "MAIL_DELETE", data: { mailId: mail.id } }));
  remove.disabled = hasAttachments(mail);
  actions.appendChild(remove);
  page.appendChild(actions);
  return page;
}

// ------------------------------------------------------------------- writing

/** Puts one of an item from the bags on the mail being written. More of a stack is sent by raising its amount. */
export function attachItem(name: string) {
  if (!inbox) return;
  const held = (cache.inventory || []).find((item: any) => String(item.name).toLowerCase() === name.toLowerCase());
  if (!held || draft.items.some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
  // As the server refuses them: quest items, and the home item, which stays with its player.
  if (held.type === "quest" || teleportsHome(held)) {
    setStatus(`${held.name} cannot be mailed.`);
    return;
  }
  if (isSoulbound(held)) {
    setStatus(`${held.name} is soulbound and cannot be mailed.`);
    return;
  }
  if (spareOf(held.name) <= 0) {
    setStatus(`${held.name} is in use.`);
    return;
  }
  if (draft.items.length >= inbox.itemsMax) {
    setStatus(`A mail holds ${inbox.itemsMax} different items at most.`);
    return;
  }
  hideItemTooltip();
  draft.items = [...draft.items, { name: held.name, quantity: 1 }];
  if (tab !== "send" || reading !== null) {
    tab = "send";
    reading = null;
  }
  setStatus("");
  render();
}

function detachItem(name: string) {
  hideItemTooltip();
  draft.items = draft.items.filter((item) => item.name !== name);
  render();
}

function attachedSlot(attached: { name: string; quantity: number } | undefined): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "mail-slot";
  if (!attached) return slot;
  const item: MailItem = { ...(cache.inventory || []).find((held: any) => held.name === attached.name), ...attached };
  slot.classList.add("filled");
  slot.dataset.itemName = item.name;
  slot.appendChild(itemFrame(iconOf(item), item.quality, 40, item.name));
  setupItemTooltip(slot, () => ({ ...item, iconUrl: iconOf(item) }));

  const spare = Math.max(spareOf(attached.name), attached.quantity);
  if (spare > 1) {
    // A stack: its amount is a field, from one up to all that is spare of it.
    const amount = document.createElement("input");
    amount.type = "number";
    amount.className = "mail-amount";
    amount.min = "1";
    amount.max = String(spare);
    amount.value = String(attached.quantity);
    amount.title = `How many to send, of ${spare}`;
    amount.addEventListener("change", () => {
      const wanted = Math.min(spare, Math.max(1, Math.floor(Number(amount.value) || 1)));
      amount.value = String(wanted);
      attached.quantity = wanted;
      refreshPostage();
    });
    slot.appendChild(amount);
  }
  const remove = button("×", "mail-remove", () => detachItem(attached.name));
  remove.title = "Take back";
  remove.setAttribute("aria-label", `Take back ${attached.name}`);
  slot.appendChild(remove);
  slot.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    detachItem(attached.name);
  });
  return slot;
}

/** What the mail costs to send: postage for each item attached (or the one mail), and the coins attached. */
function refreshPostage() {
  const postage = popup?.querySelector(".mail-postage-amount") as HTMLElement | null;
  if (!postage || !inbox) return;
  const cost = inbox.postage * Math.max(1, draft.items.length);
  postage.innerHTML = coinHtml(cost);
  const send = popup?.querySelector(".mail-send-button") as HTMLButtonElement | null;
  const purse = worth(me()?.currency ?? { gold: 0, silver: 0, copper: 0 });
  const short = purse < cost + worth(draft.coins);
  postage.classList.toggle("short", short);
  if (send) {
    send.disabled = sending || short;
    send.title = short ? "You cannot afford that." : "";
  }
}

function field(label: string, input: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "mail-field";
  const name = document.createElement("span");
  name.innerText = label;
  row.append(name, input);
  input.addEventListener("focus", () => stopMovement());
  return row;
}

/** The keys of the friend list under the To field while it is shown: true when it took the key. */
let suggestionKeys: ((event: KeyboardEvent) => boolean) | null = null;

/**
 * The friends whose names begin with what is typed in `to`, in a list under it to pick from. Only friends are offered:
 * any other name is typed in full.
 */
function friendList(to: HTMLInputElement): HTMLDivElement {
  const list = document.createElement("div");
  list.className = "mail-suggest";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  let names: string[] = [];
  let picked = -1;

  const hide = () => {
    list.hidden = true;
    picked = -1;
    suggestionKeys = null;
  };
  const pick = (name: string) => {
    to.value = name;
    draft.to = name;
    hide();
    // On to the subject.
    (popup?.querySelectorAll<HTMLElement>(".mail-send input")[1])?.focus();
  };
  const show = () => {
    const typed = to.value.trim().toLowerCase();
    names = friends().map(shown).filter((name) => name.toLowerCase().startsWith(typed) && name.toLowerCase() !== typed).sort();
    if (names.length === 0) return hide();
    picked = Math.min(picked, names.length - 1);
    list.replaceChildren(...names.map((name, index) => {
      const row = document.createElement("div");
      row.className = `mail-suggest-row${index === picked ? " picked" : ""}`;
      row.setAttribute("role", "option");
      row.innerText = name;
      // A press on a name does not take the focus from the field, which would put the list away under it.
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => pick(name));
      return row;
    }));
    list.hidden = false;
    list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
    suggestionKeys = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        picked = event.key === "ArrowDown" ? (picked + 1) % names.length : (picked <= 0 ? names.length : picked) - 1;
        show();
        return true;
      }
      if (event.key === "Enter" && picked >= 0) {
        event.preventDefault();
        pick(names[picked]);
        return true;
      }
      if (event.key === "Escape") {
        hide();
        return true;
      }
      return false;
    };
  };
  to.addEventListener("focus", show);
  to.addEventListener("input", () => {
    picked = -1;
    show();
  });
  // A moment later, so a tap on a name is read before the list goes.
  to.addEventListener("blur", () => window.setTimeout(() => { if (document.activeElement !== to) hide(); }, 150));
  return list;
}

function sendPage(): HTMLElement {
  const page = document.createElement("div");
  page.className = "mail-send";
  const limits = inbox!;

  // Only friends are suggested (friendList): the browser's own memory of typed names is turned off.
  const to = document.createElement("input");
  to.type = "text";
  to.className = "mail-to";
  to.autocomplete = "off";
  to.spellcheck = false;
  to.maxLength = 64;
  to.value = draft.to;
  to.addEventListener("input", () => { draft.to = to.value; });

  const subject = document.createElement("input");
  subject.type = "text";
  subject.autocomplete = "off";
  subject.maxLength = limits.subjectMax;
  subject.value = draft.subject;
  subject.addEventListener("input", () => { draft.subject = subject.value; });

  const body = document.createElement("textarea");
  body.maxLength = limits.bodyMax;
  body.rows = 4;
  body.value = draft.body;
  body.addEventListener("input", () => { draft.body = body.value; });

  const top = document.createElement("div");
  top.className = "mail-fields";
  const toField = field("To", to);
  toField.appendChild(friendList(to));
  top.append(toField, field("Subject", subject));

  const slots = document.createElement("div");
  slots.className = "mail-slots attach";
  for (let index = 0; index < limits.itemsMax; index++) slots.appendChild(attachedSlot(draft.items[index]));
  // Items are dragged here from the bags.
  slots.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("inventory-item-name")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    slots.classList.add("drop");
  });
  slots.addEventListener("dragleave", () => slots.classList.remove("drop"));
  slots.addEventListener("drop", (event) => {
    slots.classList.remove("drop");
    const name = event.dataTransfer?.getData("inventory-item-name");
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    attachItem(name);
  });

  const coins = document.createElement("div");
  coins.className = "mail-coins";
  for (const kind of COIN_KINDS) {
    const coin = document.createElement("label");
    coin.className = "currency-item";
    const icon = document.createElement("div");
    icon.className = `currency-icon currency-icon-${kind}`;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "mail-coin";
    input.dataset.coin = kind;
    input.min = "0";
    input.max = String(COIN_LIMITS[kind]);
    input.value = String(draft.coins[kind]);
    input.setAttribute("aria-label", `${shown(kind)} to send`);
    input.addEventListener("input", () => {
      draft.coins = { ...draft.coins, [kind]: whole(input.value, COIN_LIMITS[kind]) };
      refreshPostage();
    });
    input.addEventListener("change", () => { input.value = String(draft.coins[kind]); });
    input.addEventListener("focus", () => stopMovement());
    coin.append(icon, input);
    coins.appendChild(coin);
  }
  const postage = document.createElement("span");
  postage.className = "mail-postage";
  const postageLabel = document.createElement("span");
  postageLabel.innerText = "Postage";
  const postageAmount = document.createElement("span");
  postageAmount.className = "mail-postage-amount";
  postage.append(postageLabel, postageAmount);

  const bottom = document.createElement("div");
  bottom.className = "mail-send-bottom";
  bottom.append(coins, postage);

  // On a touch screen there is no right-click and nothing is dragged between windows: two taps on an item attach it (events.ts).
  const hint = document.createElement("p");
  hint.className = "mail-hint";
  hint.innerText = TOUCH ? "Double-tap an item in your bags to attach it." : "Drag items here from your bags, or right-click them.";

  page.append(top, field("Message", body), slots, hint, bottom);
  return page;
}

function sendDraft() {
  if (!inbox || sending) return;
  hideItemTooltip();
  sending = true;
  refreshPostage();
  setStatus("Sending...");
  sendRequest({
    type: "MAIL_SEND",
    data: { to: draft.to.trim(), subject: draft.subject, body: draft.body, items: draft.items, coins: draft.coins },
  });
}

/** What became of the mail sent (MAIL_SENT): on its way, and the page is emptied; or why not, and it is kept. */
export function mailSent(data: { ok: boolean; message: string }) {
  sending = false;
  if (data?.ok) {
    draft = { to: "", subject: "", body: "", items: [], coins: { gold: 0, silver: 0, copper: 0 } };
    if (popup && tab === "send") render();
  }
  setStatus(data?.message ?? "");
  refreshPostage();
}

// ------------------------------------------------------------------- drawing

function render() {
  if (!popup || !inbox) return;
  hideItemTooltip();
  renderTabs();
  const page = popup.querySelector(".mail-page") as HTMLElement;
  const open = reading !== null ? inbox.mail.find((mail) => mail.id === reading) : undefined;
  if (reading !== null && !open) reading = null;
  if (tab === "send") page.replaceChildren(sendPage());
  else page.replaceChildren(open ? readingPage(open) : inboxPage());
  // Send stands beside Close, where it is always in sight, also on a phone where the page scrolls.
  const footer = popup.querySelector(".button-container") as HTMLElement;
  footer.querySelector("#mail-send")?.remove();
  if (tab === "send") {
    const send = button("Send", "mail-send-button", sendDraft);
    send.id = "mail-send";
    footer.prepend(send);
  }
  refreshPostage();
}

function build(): HTMLDivElement {
  const made = document.createElement("div");
  made.id = "mail-window";
  made.className = "ui";
  made.setAttribute("role", "dialog");
  made.setAttribute("aria-label", "Mailbox");

  const title = document.createElement("h2");
  title.innerText = "Mailbox";
  const tabs = document.createElement("div");
  tabs.className = "mail-tabs";
  tabs.setAttribute("role", "tablist");
  const page = document.createElement("div");
  page.className = "mail-page";
  const status = document.createElement("p");
  status.className = "mail-status";

  const close = document.createElement("button");
  close.id = "mail-close";
  close.type = "button";
  close.innerText = "Close";
  close.addEventListener("click", closeMail);
  const buttons = document.createElement("div");
  buttons.className = "button-container";
  buttons.appendChild(close);

  made.append(title, tabs, page, status, buttons);
  // A right-click on the window is not a right-click on the world under it.
  made.addEventListener("contextmenu", (event) => event.preventDefault());
  return made;
}

/** The player's mail (MAIL_INBOX): opens the window the first time, and the bags with it; else brings it up to date. */
export function showMail(data: Inbox) {
  if (!data || !Array.isArray(data.mail)) return;
  const opening = inbox === null;
  inbox = data;
  if (!popup) {
    popup = build();
    document.body.appendChild(popup);
    document.addEventListener("keydown", onKey, true);
  }
  if (opening) {
    tab = "inbox";
    reading = null;
    sending = false;
    openInventory();
  }
  // Typing on the send page is left alone: only the tab's count changes.
  if (tab === "send" && !opening) renderTabs();
  else render();
}

/** How many mails are unread (MAIL_NOTICE). New mail while the window is open is fetched. */
export function setUnreadMail(count: number) {
  const before = unread;
  unread = Math.max(0, Math.floor(Number(count) || 0));
  // More unread than the window shows: mail came while it was open.
  if (inbox && unread > before && unread > inbox.mail.filter((mail) => !mail.read).length) sendRequest({ type: "MAIL_OPEN", data: null });
  else if (inbox) renderTabs();
  showMailIndicator();
}

/** An envelope, drawn in the minimap frame's colours. */
const ENVELOPE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="2.5" y="5.5" width="19" height="13" rx="1.5" fill="#FFF1DA" stroke="#4a2c14" stroke-width="1.5"/>
  <path d="M3 6.5 L12 13 L21 6.5" fill="none" stroke="#4a2c14" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M3 18 L9.5 11.5 M21 18 L14.5 11.5" fill="none" stroke="#c8a27a" stroke-width="1.2"/>
</svg>`;

/** When the minimap was not there yet: looked for again shortly. */
let indicatorRetry = 0;

/**
 * The envelope on the minimap while there is unread mail, gone when there is none. It lives in the minimap's box, so
 * it moves and scales with it; when that box is not built yet (mail said at login), it is looked for again.
 */
function showMailIndicator() {
  window.clearTimeout(indicatorRetry);
  const shown = document.getElementById("mail-indicator");
  if (unread <= 0) {
    shown?.remove();
    return;
  }
  const minimap = document.getElementById("minimap-container");
  if (!minimap) {
    indicatorRetry = window.setTimeout(showMailIndicator, 500);
    return;
  }
  const mark = shown && shown.parentElement === minimap ? shown : document.createElement("div");
  if (mark !== shown) {
    shown?.remove();
    mark.id = "mail-indicator";
    mark.className = "ui";
    mark.setAttribute("role", "img");
    mark.innerHTML = ENVELOPE_SVG;
    minimap.appendChild(mark);
  }
  const label = unread === 1 ? "1 unread mail" : `${unread} unread mails`;
  mark.title = label;
  mark.setAttribute("aria-label", label);
}
/** The window goes: the player closed it, walked off, or the server said they are no longer at a mailbox (MAIL_CLOSED). */
export function closeMail() {
  document.removeEventListener("keydown", onKey, true);
  hideItemTooltip();
  popup?.remove();
  popup = null;
  inbox = null;
  reading = null;
  sending = false;
}

/** The player's coins changed while the window is open: what the mail costs is shown against them again. */
export function refreshMail() {
  if (inbox) refreshPostage();
}
