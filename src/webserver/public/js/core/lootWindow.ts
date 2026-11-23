import { sendRequest } from "./socket.js";
import { itemFrame, qualityOf } from "./itemframe.js";
import { setupItemTooltip, hideItemTooltip } from "./tooltip.js";

let activePopup: HTMLElement | null = null;

function closePopup(): void {
  if (activePopup) hideItemTooltip();
  activePopup?.remove();
  activePopup = null;
}

// Escape closes the window, seen first so the pause menu is not opened under it.
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.code !== "Escape" || !activePopup) return;
  event.stopPropagation();
  closePopup();
}, true);

/** A chest's loot, in the corpse loot window (same markup and styles): a click on a row takes that item. */
export function showLootChestPopup(chestId: string, items: any[]): void {
  closePopup();
  document.getElementById("creature-loot-popup")?.remove();
  if (items.length === 0) return;

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
  closeButton.addEventListener("click", closePopup);

  const list = document.createElement("div");
  list.className = "creature-loot-list ui";
  for (const item of items) {
    const quality = qualityOf(item.quality);
    const name = String(item.itemName ?? "");
    const quantity = Number(item.quantity) || 1;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "creature-loot-row ui";
    row.title = `Take ${name}`;
    row.addEventListener("click", () => {
      hideItemTooltip();
      sendRequest({ type: "TAKE_CHEST_ITEMS", data: { chestId, indices: [Number(item.index)] } });
      row.remove();
      if (!list.childElementCount) closePopup();
    });
    const label = document.createElement("span");
    // The tooltip's name colours (legendary is the rainbow), as the corpse loot window has them.
    label.className = `creature-loot-name item-link-${quality} ui`;
    label.textContent = name;
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
