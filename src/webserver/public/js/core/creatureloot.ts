// Corpse loot window for server-authoritative creatures; all taking is
// validated server-side.
//
// A corpse with loot is opened with E beside it (an E badge shows over it) or a
// left click on it. The window lists what is on the corpse, and a click on a row
// takes that one thing. With Auto loot on (the settings menu) everything is
// taken at once and the window is never shown. Each item taken shows a
// notification with its name in its quality's colour.
import { sendRequest, cachedPlayerId } from "./socket.js";
import { itemFrame, qualityOf } from "./itemframe.js";
import Cache from "./cache.js";
import { creatures, type CreatureView } from "./creature.js";
import { canvasDpr, worldToScreen } from "./worldzoom.js";
import { autoLootCheckbox } from "./ui.js";
import { showNotification } from "./notifications.js";
import { setupItemTooltip, hideItemTooltip } from "./tooltip.js";
import { coinHtml } from "./coins.js";

/** Name colours, as the vendor window has them: readable on the window's paper and on a notification. */
const QUALITY_COLORS: Record<string, string> = {
  common: "#FFF1DA", uncommon: "#1eff00", rare: "#4d9bff", epic: "#c06bff", legendary: "#ff8000",
};

/** px: how close a corpse must be for E to loot it, a little inside the engine's LOOT_RANGE_PX (120). */
const LOOT_REACH = 110;

let activePopup: HTMLElement | null = null;
/** The corpse the open window shows. */
let activeCreatureId: number | null = null;

const autoLoot = () => !!autoLootCheckbox?.checked;

/**
 * Loot a corpse: with Auto loot, take everything at once; otherwise ask for
 * what is on it, which opens the window.
 */
export function lootCorpse(creatureId: number): void {
  if (autoLoot()) sendRequest({ type: "CREATURE_LOOT_TAKE", data: { id: creatureId } });
  else sendRequest({ type: "CREATURE_LOOT", data: { id: creatureId } });
}

function me(): any {
  const cache = Cache.getInstance();
  return Array.from(cache.players as Iterable<any>).find((p: any) => p.id === cachedPlayerId);
}

/** The nearest corpse in reach with loot for this player: the one E loots. */
export function nearestLootableCorpse(): CreatureView | null {
  const p = me();
  const x = Number(p?.position?.x);
  const y = Number(p?.position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best: CreatureView | null = null;
  let bestDistance = LOOT_REACH;
  for (const c of creatures.values()) {
    if (c.state !== "dead" || !c.lootable) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/** E: loots the nearest corpse in reach. False when there is none. */
export function lootNearestCorpse(): boolean {
  const corpse = nearestLootableCorpse();
  if (!corpse) return false;
  lootCorpse(corpse.id);
  return true;
}

const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

/**
 * The E badge over the corpse E would loot, in screen space, as a mailbox's and a
 * gathering node's are (mail.ts renderMailboxHint). Not while its window is open,
 * and not on a touch screen (a tap loots). Whether one was drawn: E loots before
 * it talks, opens a mailbox or gathers, so their badges stay hidden then.
 */
export function renderCorpseLootHint(ctx: CanvasRenderingContext2D): boolean {
  const corpse = nearestLootableCorpse();
  if (!corpse) return false;
  if (TOUCH || activeCreatureId === corpse.id) return true;
  const dpr = canvasDpr();
  const spot = worldToScreen(corpse.renderX, corpse.renderY - 52);
  const x = spot.x * dpr;
  const y = spot.y * dpr;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fill();
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
  return true;
}

/** An item taken from a corpse: "You receive loot:" and its name in its quality's colour. */
export function showLootReceived(data: any): void {
  showItemReceived("You receive loot: ", String(data?.itemName ?? ""), Number(data?.quantity) || 1, data?.quality);
}

/** An item that came into the bags, after `lead` ("You receive loot: "): its name in its quality's colour. A fish caught uses it too (fishing.ts). */
export function showItemReceived(lead: string, name: string, quantity: number, rawQuality: unknown): void {
  if (!name) return;
  const quality = qualityOf(rawQuality);
  showNotification(`${lead}${name}${quantity > 1 ? ` x${quantity}` : ""}`, true, false, (body) => {
    const item = document.createElement("span");
    item.textContent = name;
    item.style.color = QUALITY_COLORS[quality];
    item.style.fontWeight = "bold";
    body.replaceChildren(lead, item, quantity > 1 ? ` x${quantity}` : "");
  });
}

function close(): void {
  if (activePopup) hideItemTooltip();
  activePopup?.remove();
  activePopup = null;
  activeCreatureId = null;
}

/** px: walking further than this from the corpse closes its window, a little past where the server stops letting it be looted (120). */
const CLOSE_RADIUS = 140;

/** Walking away from the corpse closes its window, as it does a vendor's or a mailbox's (renderer.ts, every frame). */
export function updateCreatureLootProximity(playerX: number, playerY: number): void {
  if (activeCreatureId === null) return;
  const corpse = creatures.get(activeCreatureId);
  if (!corpse || Math.hypot(corpse.x - playerX, corpse.y - playerY) > CLOSE_RADIUS) close();
}

/** Close the window when it shows this corpse: it was emptied or is gone. */
export function closeCreatureLoot(creatureId: number): void {
  if (activeCreatureId === creatureId) close();
}

// Escape closes the window. Seen first, so the game's own Escape (the pause menu) is not opened under it.
function onKey(event: KeyboardEvent): void {
  if (event.code !== "Escape" || !activePopup) return;
  event.stopPropagation();
  close();
}
document.addEventListener("keydown", onKey, true);

/** One thing on the corpse, as a row: a click takes it. */
function lootRow(label: string, onTake: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "creature-loot-row ui";
  row.title = `Take ${label}`;
  row.addEventListener("click", () => {
    hideItemTooltip();
    onTake();
  });
  return row;
}

/**
 * What is on a corpse, when it is opened and again after each take: the window
 * shows what is left, and closes once nothing is. A click on a row takes that
 * one thing. With Auto loot on it is only kept up to date when it was already
 * open; otherwise it is not shown.
 */
export function showCreatureLoot(creatureId: number, items: any[], copper: number): void {
  const wasOpen = activeCreatureId === creatureId;
  close();
  if (items.length === 0 && copper <= 0) return;
  if (autoLoot() && !wasOpen) return;
  activeCreatureId = creatureId;
  // The server answers each take with what is left, which draws this window again or closes it.
  const take = (indices: number[]) => sendRequest({ type: "CREATURE_LOOT_TAKE", data: { id: creatureId, indices } });

  const popup = document.createElement("div");
  popup.id = "creature-loot-popup";
  popup.className = "ui";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Loot");

  const heading = document.createElement("h2");
  heading.textContent = "Loot";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "menu-close-button ui";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "✕";
  closeButton.addEventListener("click", close);

  const list = document.createElement("div");
  list.className = "creature-loot-list ui";
  if (copper > 0) {
    // Money: taken with nothing else (an empty list of items).
    const row = lootRow("the money", () => take([]));
    const coins = document.createElement("span");
    coins.className = "creature-loot-coins ui";
    coins.innerHTML = coinHtml(copper);
    row.appendChild(coins);
    list.appendChild(row);
  }
  for (const item of items) {
    const quality = qualityOf(item.quality);
    const name = String(item.itemName ?? "");
    const quantity = Number(item.quantity) || 1;
    const row = lootRow(name, () => take([Number(item.index)]));
    const label = document.createElement("span");
    label.className = "creature-loot-name ui";
    label.textContent = name;
    label.style.color = QUALITY_COLORS[quality];
    row.append(itemFrame(String(item.iconUrl || "") || null, quality, 32, name), label);
    if (quantity > 1) {
      const count = document.createElement("span");
      count.className = "creature-loot-count ui";
      count.textContent = `x${quantity}`;
      row.appendChild(count);
    }
    setupItemTooltip(row, () => ({ ...((window as any).itemsByName?.get?.(name) ?? {}), name, quality, iconUrl: item.iconUrl }));
    list.appendChild(row);
  }

  popup.append(closeButton, heading, list);
  document.body.appendChild(popup);
  activePopup = popup;
}
