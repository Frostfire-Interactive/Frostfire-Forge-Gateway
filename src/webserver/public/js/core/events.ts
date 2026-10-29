import { sendRequest, getIsLoaded, getMovementAllowed, cachedPlayerId, itemsByName, showNotification } from "./socket.js";
import { teleportsHome } from "./consumables.js";
import { isSelfDead, isSelfActionLocked } from "./death.js";
import Cache from "./cache.js";
// (no longer used here, but kept: the modules start in the order they are imported, and ui.ts is in a cycle that
// breaks with any other order: "Cannot read properties of undefined (reading 'addEventListener')")
import "./renderer.js";
const cache = Cache.getInstance();
import { chatInput, pauseMenu, optionsMenu, fpsSlider, musicSlider, effectsSlider, ambienceSlider, weatherSlider, mutedCheckbox, autoLootCheckbox, canvas, ctx, friendsList } from "./ui.js";
import { showItemTooltip, hideItemTooltip } from "./tooltip.js";
import { getUserHasInteracted, setUserHasInteracted, setControllerConnected, getLastSentDirection, setLastSentDirection, setStickDirection,
    getLastTypingPacket, setLastTypingPacket, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys, movementKeys,
    pressedKeys,
    setIsKeyPressed,
    getIsKeyPressed,
    getIsMoving,
    handleKeyPress,
    keyHandlers,
    COOLDOWN_DURATION,
    cooldowns,
    stopMovement,
    setIsMoving} from "./input.js";
import { friendsListSearch } from "./friends.js";
import { createContextMenu, createPartyContextMenu, createGuildContextMenu, createFriendContextMenu, createIgnoredContextMenu } from "./actions.js";
import { isTrading, offerItem } from "./trade.js";
import { isVendorOpen, sellItem } from "./vendor.js";
import { isMailOpen, attachItem, openNearestMailbox, mailboxAt } from "./mail.js";
import { gather, gatherNearest, gatherNodeAt } from "./gathering.js";
import { fishingClick, installFishingInput } from "./fishing.js";
import { lootNearestCorpse } from "./creatureloot.js";
import { playerAt } from "./playerpick.js";
import { closeRadialMenu } from "./mobileui.js";
import "./creatureinput.js";
import "./skeletons.js";
import { applyWorldTransform, installWorldZoom, screenToWorld } from "./worldzoom.js";

/** Extra world pixels around an NPC that still count as a tap on it (touch only). */
const TOUCH_TARGET_SLOP = 24;
let typingTimer: number | null = null;

// Loot pickup state
let lootKeyDownTime: number | null = null;
let lootHolding = false;
export let lootPickupProgress = 0;
let nearestLootId: string | null = null;
const LOOT_HOLD_DURATION = 1500;
const LOOT_HOLD_DELAY = 250;
const LOOT_PROGRESS_DURATION = LOOT_HOLD_DURATION - LOOT_HOLD_DELAY;
const LOOT_PICKUP_RADIUS = 100;

let chestKeyDownTime: number | null = null;
let chestHolding = false;
export let chestInteractionProgress = 0;
let nearestChestId: string | null = null;
const CHEST_HOLD_DURATION = 1500;
const CHEST_HOLD_DELAY = 250;
const CHEST_PROGRESS_DURATION = CHEST_HOLD_DURATION - CHEST_HOLD_DELAY;
const CHEST_INTERACTION_RADIUS = 120;

export function updateLootPickup(playerX: number, playerY: number, playerMap: string): void {
  const cache = Cache.getInstance();
  const lootItems = cache.loot || [];
  const normalizedMap = (playerMap || "").replace(".json", "").toLowerCase();
  const localUsername = Array.from(cache.players).find(p => p.id === cachedPlayerId)?.username;

  let nearestId: string | null = null;
  let nearestDist = Infinity;

  for (const loot of lootItems) {
    // Loot with no owner is anyone's to take.
    if (loot.ownerId && String(loot.ownerId) !== String(localUsername)) continue;
    const lootMap = (loot.map || "").replace(".json", "").toLowerCase();
    if (lootMap !== normalizedMap) continue;
    const dx = playerX - loot.x;
    const dy = playerY - loot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < nearestDist && dist <= LOOT_PICKUP_RADIUS) {
      nearestDist = dist;
      nearestId = loot.id;
    }
  }

  nearestLootId = nearestId;

  if (!nearestLootId || !lootKeyDownTime) {
    if (lootHolding || lootKeyDownTime) {
      lootKeyDownTime = null;
      lootHolding = false;
      lootPickupProgress = 0;
      (window as any)._lootPickupProgress = 0;
    }
    return;
  }

  const elapsed = performance.now() - lootKeyDownTime;

  if (!lootHolding && elapsed > LOOT_HOLD_DELAY) {
    lootHolding = true;
  }

  if (lootHolding) {
    lootPickupProgress = Math.min((elapsed - LOOT_HOLD_DELAY) / LOOT_PROGRESS_DURATION, 1);
    (window as any)._lootPickupProgress = lootPickupProgress;

    if (lootPickupProgress >= 1) {
      lootKeyDownTime = null;
      lootHolding = false;
      lootPickupProgress = 0;
      (window as any)._lootPickupProgress = 0;
      sendRequest({ type: "BATCH_PICKUP_LOOT", data: {} });
    }
  }
}

export function updateChestInteraction(playerX: number, playerY: number, playerMap: string): void {
  const cache = Cache.getInstance();
  const chests = cache.lootChests || [];
  const nmap = (playerMap || "").replace(".json", "").toLowerCase();
  let nearestId: string | null = null, nearestDist = Infinity;
  for (const c of chests) {
    if ((c.map || "").replace(".json", "").toLowerCase() !== nmap) continue;
    const d = Math.sqrt((playerX - c.x) ** 2 + (playerY - c.y) ** 2);
    if (d < nearestDist && d <= CHEST_INTERACTION_RADIUS) { nearestDist = d; nearestId = c.id; }
  }
  nearestChestId = nearestId;
  if (!nearestChestId || !chestKeyDownTime) {
    if (chestHolding || chestKeyDownTime) { chestKeyDownTime = null; chestHolding = false; chestInteractionProgress = 0; (window as any).chestInteractionProgress = 0; }
    return;
  }
  const elapsed = performance.now() - chestKeyDownTime;
  if (!chestHolding && elapsed > CHEST_HOLD_DELAY) { chestHolding = true; }
  if (chestHolding) {
    chestInteractionProgress = Math.min((elapsed - CHEST_HOLD_DELAY) / CHEST_PROGRESS_DURATION, 1);
    (window as any).chestInteractionProgress = chestInteractionProgress;
    if (chestInteractionProgress >= 1) {
      chestKeyDownTime = null; chestHolding = false; chestInteractionProgress = 0; (window as any).chestInteractionProgress = 0;
      sendRequest({ type: "OPEN_LOOT_CHEST", data: { chestId: nearestChestId } });
    }
  }
}

(window as any).updateLootPickup = updateLootPickup;
(window as any).updateChestInteraction = updateChestInteraction;
(window as any).chestInteractionProgress = 0;

const getActualViewportHeight = () => {
  if (window.visualViewport) {
    return window.visualViewport.height;
  }
  return window.innerHeight;
};

document.documentElement.style.setProperty('--viewport-height', `${getActualViewportHeight()}px`);

const userInteractionListener = () => {
  if (!getUserHasInteracted()) {
    setUserHasInteracted(true);
    document.removeEventListener("mousedown", userInteractionListener);
    document.removeEventListener("keydown", userInteractionListener);
    document.removeEventListener("touchstart", userInteractionListener);
  }
};

document.addEventListener("mousedown", userInteractionListener);
document.addEventListener("keydown", userInteractionListener);
document.addEventListener("touchstart", userInteractionListener);
window.addEventListener("gamepadconnected", () => {
  setControllerConnected(true);
});
window.addEventListener("gamepaddisconnected", () => {
  setControllerConnected(false);
});

window.addEventListener("gamepadjoystick", (e: CustomEventInit) => {
  // Where the stick points is kept even when the move is held back, for a node handoff to resume (socket.ts).
  const heldX = e.detail.x, heldY = e.detail.y;
  const stickAngle = Math.atan2(heldY, heldX) * (180 / Math.PI);
  const stickHeld = !(Math.abs(heldX) < 0.5 && Math.abs(heldY) < 0.5);
  setStickDirection(!stickHeld ? "" : stickAngle >= -30 && stickAngle < 30 ? "RIGHT" : stickAngle >= 30 && stickAngle < 60 ? "DOWNRIGHT"
    : stickAngle >= 60 && stickAngle < 120 ? "DOWN" : stickAngle >= 120 && stickAngle < 150 ? "DOWNLEFT" : stickAngle >= 150 || stickAngle < -150 ? "LEFT"
    : stickAngle >= -150 && stickAngle < -120 ? "UPLEFT" : stickAngle >= -120 && stickAngle < -60 ? "UP" : "UPRIGHT");
  if (!getIsLoaded() || !getMovementAllowed()) {
    // A map is loading (a warp): the server has stopped the player, and nothing is sent to it until the map is in.
    // What was last sent no longer holds, and is forgotten: a direction is only sent when it differs from the last,
    // so a stick held the same way through the warp, or let go during it and pushed the same way again, sent nothing
    // and the player stood still. USER REPORT 2026-10-07: "When warping on mobile, the whole screen becomes
    // un-interactable".
    setLastSentDirection("");
    return;
  }
  if (isSelfDead()) return;
  if (pauseMenu.style.display == "block") return;

  const x = e.detail.x;
  const y = e.detail.y;

  const deadzone = 0.5;
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) {
    if (getLastSentDirection() !== "ABORT") {
      sendRequest({
        type: "MOVEXY",
            data: "ABORT",
      });
      setLastSentDirection("ABORT");
    }
    return;
  }

  const angle = Math.atan2(y, x) * (180 / Math.PI);

  // Cardinal-biased sectors: LEFT/RIGHT/UP/DOWN each span 60deg (+/-30deg around
  // the axis), diagonals 30deg. An even 45deg split made "walk straight" hard on
  // a phone.
  let direction = "";
  if (angle >= -30 && angle < 30) {
    direction = "RIGHT";
  } else if (angle >= 30 && angle < 60) {
    direction = "DOWNRIGHT";
  } else if (angle >= 60 && angle < 120) {
    direction = "DOWN";
  } else if (angle >= 120 && angle < 150) {
    direction = "DOWNLEFT";
  } else if (angle >= 150 || angle < -150) {
    direction = "LEFT";
  } else if (angle >= -150 && angle < -120) {
    direction = "UPLEFT";
  } else if (angle >= -120 && angle < -60) {
    direction = "UP";
  } else if (angle >= -60 && angle < -30) {
    direction = "UPRIGHT";
  }

  if (direction && direction !== getLastSentDirection()) {
    if (pauseMenu.style.display == "block") return;
    sendRequest({
      type: "MOVEXY",
          data: direction,
    });
    setLastSentDirection(direction);
  }
});

chatInput.addEventListener("input", () => {

  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  if (getLastTypingPacket() + 1000 < performance.now()) {
    sendRequest({
      type: "TYPING",
      data: null,
    });
    setLastTypingPacket(performance.now());
  }

  typingTimer = window.setTimeout(() => {
    if (chatInput.value.length > 0) {
      sendRequest({
        type: "TYPING",
        data: null,
      });
      setLastTypingPacket(performance.now());
    }
  }, 1000);
});

window.addEventListener("keydown", async (e) => {
  // Handle Ctrl+S globally to prevent player movement and spam
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    e.stopPropagation();

    // Only trigger save if tile editor is active
    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive) {
      // Delegate to tile editor's save method which properly handles all data
      tileEditor.saveMap();
    }
    return;
  }

  if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
    setContextMenuKeyTriggered(true);
  }

  if (blacklistedKeys.has(e.code)) {

    if (e.code === "Tab" && !getContextMenuKeyTriggered()) {
      const target = Array.from(cache.players).find(player => player.targeted);
      if (target) {
        target.targeted = false;
      }

      sendRequest({ type: "TARGETCLOSEST", data: null });
      e.preventDefault();
      return;
    }

    e.preventDefault();
    return;
  }
  if (!getIsLoaded() || (pauseMenu.style.display === "block" && e.code !== "Escape")) return;

  const activeElement = document.activeElement;
  const isTypingInInput = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    (activeElement as HTMLElement).contentEditable === 'true'
  );
  if (isTypingInInput && !["Enter", "Escape"].includes(e.code)) return;

  // Ignore OS key auto-repeat for everything except movement: holding an
  // action key must not re-fire its handler. (Placed after the input guard
  // so chat typing still repeats normally.)
  if (e.repeat && !movementKeys.has(e.code)) return;

  if (e.code === "KeyE") {
    if (e.repeat) return;
    // Corpses and ghosts cannot pick up loot.
    if (isSelfActionLocked()) return;
    const cache = Cache.getInstance();
    const lootItems = cache.loot || [];
    const localUsername = Array.from(cache.players).find(p => p.id === cachedPlayerId)?.username;
    let nearOwned = false;
    for (const loot of lootItems) {
      if (loot.ownerId && String(loot.ownerId) !== String(localUsername)) continue;
      nearOwned = true;
      break;
    }
    if (nearOwned) {
      lootKeyDownTime = performance.now();
      lootHolding = false;
      lootPickupProgress = 0;
      (window as any)._lootPickupProgress = 0;
    }
    return;
  }

  if (e.code === "KeyF") {
    if (e.repeat) return;
    // Corpses and ghosts cannot open chests.
    if (isSelfActionLocked()) return;
    const cache = Cache.getInstance();
    if ((cache.lootChests || []).length > 0) {
      chestKeyDownTime = performance.now();
      chestHolding = false;
      chestInteractionProgress = 0;
    }
    return;
  }

  if (movementKeys.has(e.code)) {
    pressedKeys.add(e.code);
    if (!getIsKeyPressed()) {
      setIsKeyPressed(true);
      if (!getIsMoving()) {
        handleKeyPress();
      }
    }
  }

  const now = Date.now();
  const handler = keyHandlers[e.code as keyof typeof keyHandlers];
  if (!handler) return;

  if (cooldowns[e.code] && now - cooldowns[e.code] < COOLDOWN_DURATION) return;

  cooldowns[e.code] = now;

  try {
    await handler();
    closeRadialMenu();
  } catch (err) {
    console.error(`Error handling key ${e.code}:`, err);
  }
});

window.addEventListener("keyup", (e) => {  const activeElement = document.activeElement;
  const isTypingInInput = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    (activeElement as HTMLElement).contentEditable === 'true'
  );
  if (isTypingInInput) return;

  if (e.code === "KeyE") {
    if (lootKeyDownTime) {
      if (!lootHolding && nearestLootId) {
        sendRequest({ type: "PICKUP_LOOT", data: { id: nearestLootId } });
      }
      lootKeyDownTime = null;
      lootHolding = false;
      lootPickupProgress = 0;
      (window as any)._lootPickupProgress = 0;
      return;
    }
    // No loot pickup armed: E loots the corpse beside the player, or talks to the nearest NPC instead, or opens the
    // mailbox the player stands at.
    if (isSelfActionLocked()) return;
    if (lootNearestCorpse()) return;
    import("./quest.js").then((m) => {
      // then the mailbox the player stands at, then the nearest gathering node in reach
      if (!m.tryInteractNpc() && !openNearestMailbox()) gatherNearest();
    });
    return;
  }

  if (e.code === "KeyF") {
    if (chestKeyDownTime) {
      if (!chestHolding && nearestChestId) {
        sendRequest({ type: "OPEN_LOOT_CHEST", data: { chestId: nearestChestId } });
      }
      chestKeyDownTime = null;
      chestHolding = false;
      chestInteractionProgress = 0;
    }
    return;
  }

  if (movementKeys.has(e.code)) {
    pressedKeys.delete(e.code);
    if (pressedKeys.size === 0) {
      setIsKeyPressed(false);
    }
  }
});

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
const isIPhone = /iPhone/.test(navigator.userAgent);
const isIPad = /iPad/.test(navigator.userAgent);

function updateOrientationClass() {
  const isLandscape = window.innerWidth > window.innerHeight;
  const viewportHeight = window.innerHeight;

  document.body.classList.remove('portrait-mode', 'landscape-mode', 'ios-device', 'iphone-device', 'ipad-device', 'mobile-landscape', 'small-landscape', 'tiny-landscape');

  if (isIOS) {
    document.body.classList.add('ios-device');
  }

  if (isIPhone) {
    document.body.classList.add('iphone-device');
  }

  if (isIPad) {
    document.body.classList.add('ipad-device');
  }

  if (isLandscape) {
    document.body.classList.add('landscape-mode');

    if (viewportHeight <= 600) {
      document.body.classList.add('mobile-landscape');

      if (viewportHeight <= 450) {
        document.body.classList.add('small-landscape');

        if (viewportHeight <= 380) {
          document.body.classList.add('tiny-landscape');
        }
      }
    }
  } else {
    document.body.classList.add('portrait-mode');
  }
}

function updateViewportMetrics() {
  const actualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

  // Don't update viewport height if tile editor is active (it would break NPC dialog positioning)
  const tileEditor = (window as any).tileEditor;
  if (!tileEditor?.isActive) {
    document.documentElement.style.setProperty('--viewport-height', `${actualHeight}px`);
  }

  if (document.getElementById("context-menu")) {
    document.getElementById("context-menu")!.remove();
  }

  updateOrientationClass();
}

// Re-assigning canvas.width/height wipes the backing store and resets the
// context transform the renderer relies on. Guard against no-op resizes so the
// game canvas isn't blanked for a frame on every iOS viewport event (which
// flickers once WebKit stops promoting the canvas to its own compositing layer).
function resizeGameCanvas() {
  const rawDpr = window.devicePixelRatio || 1;
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const dpr = isTouchDevice ? Math.min(rawDpr, 2) : rawDpr;

  const bodyStyle = getComputedStyle(document.body);
  const displayWidth = parseFloat(bodyStyle.width) || window.innerWidth;
  const displayHeight = parseFloat(bodyStyle.height) || window.innerHeight;

  const targetWidth = Math.round(displayWidth * dpr);
  const targetHeight = Math.round(displayHeight * dpr);

  if (canvas.width === targetWidth && canvas.height === targetHeight) {
    return;
  }

  const prevWidth = canvas.width;
  const prevHeight = canvas.height;

  // Snapshot the current frame before resizing. Reassigning canvas.width/height
  // clears the backing store, so without this the canvas's black CSS background
  // shows through for a frame before the render loop repaints - seen as black
  // flicker while dragging to resize on PC.
  let snapshot: HTMLCanvasElement | null = null;
  if (ctx && prevWidth > 0 && prevHeight > 0) {
    snapshot = document.createElement("canvas");
    snapshot.width = prevWidth;
    snapshot.height = prevHeight;
    snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
  }

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  canvas.style.width = displayWidth + "px";
  canvas.style.height = displayHeight + "px";

  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Bridge the one-frame gap with the previous frame stretched to the new size
    // until the next animation frame redraws everything crisply.
    if (snapshot) {
      ctx.drawImage(snapshot, 0, 0, prevWidth, prevHeight, 0, 0, targetWidth, targetHeight);
    }

    // device pixels, the touch screens' 0.85 and the player's zoom (worldzoom.ts); set again every frame
    applyWorldTransform(ctx);

  }
}

function handleViewportResize() {
  updateViewportMetrics();
  resizeGameCanvas();
}

window.addEventListener("resize", handleViewportResize);
window.visualViewport?.addEventListener("resize", handleViewportResize);

// Scroll never changes the canvas size, so only refresh lightweight metrics.
// Touching canvas.width here would blank the canvas on every iOS scroll tick.
window.visualViewport?.addEventListener("scroll", updateViewportMetrics);

window.addEventListener("orientationchange", () => {

  setTimeout(() => {
    updateOrientationClass();
  }, 100);
});

// The game's page is never meant to be scrolled: everything on it is placed on the screen itself. A phone's browser
// can still leave it moved: coming back to this tab from another (a tool window) with the phone turned the other
// way, the page is laid out for the old way up and what is seen of it is shifted, so the joystick, the buttons and
// the hotbar all stood too high, until the phone was turned upright and back (USER REPORT 2026-10-07: "the whole
// touch interface gets moved upwards after closing the control panel or player attributes while in portrait mode").
// So whenever the page is shown again, is given the keyboard's attention again or is turned, it is put back where it
// belongs and measured again: at once, and a few times after, because the browser is still settling its own bars
// and the turn's animation when it tells of it.
function settleViewport() {
  const active = document.activeElement;
  // (a field with the keyboard up is where the browser moved the page to on purpose: left alone)
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  const moved = window.scrollX !== 0 || window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0 || (window.visualViewport?.offsetLeft ?? 0) !== 0;
  if (moved && !typing) window.scrollTo(0, 0);
  if (!(window as any).tileEditor?.isActive) {
    document.documentElement.style.setProperty('--viewport-height', `${getActualViewportHeight()}px`);
  }
  updateOrientationClass();
  resizeGameCanvas();
}

function settleViewportSoon() {
  for (const delay of [0, 120, 400, 900]) setTimeout(settleViewport, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") settleViewportSoon();
});
window.addEventListener("pageshow", settleViewportSoon);
window.addEventListener("focus", settleViewportSoon);
window.addEventListener("orientationchange", settleViewportSoon);
// (and when the browser moves what is seen of the page by itself)
window.visualViewport?.addEventListener("scroll", settleViewport);

updateOrientationClass();

window.addEventListener("blur", () => {
  setIsKeyPressed(false);
  pressedKeys.clear();
});

document
  .getElementById("pause-menu-action-back")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("pause-menu-action-options")
  ?.addEventListener("click", () => {

    pauseMenu.style.display = "none";
    optionsMenu.style.display = "block";
  });

document
  .getElementById("pause-menu-action-profile")
  ?.addEventListener("click", () => {
    window.open("/manage-profile", "_blank");
  });

document
  .getElementById("pause-menu-action-exit")
  ?.addEventListener("click", () => {
    sendRequest({
      type: "LOGOUT",
          data: null,
    });
    window.location.href = "/";
  });

document
  .getElementById("pause-menu-close")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("options-menu-close")
  ?.addEventListener("click", () => {
    optionsMenu.style.display = "none";
  });

fpsSlider.addEventListener("input", () => {
  document.getElementById(
    "limit-fps-label"
  )!.innerText = `FPS: (${Number(fpsSlider.value) >= 240 ? "240+" : fpsSlider.value})`;
});

musicSlider.addEventListener("input", () => {
  document.getElementById(
    "music-volume-label"
  )!.innerText = `Music: (${musicSlider.value})`;
});

effectsSlider.addEventListener("input", () => {
  document.getElementById(
    "effects-volume-label"
  )!.innerText = `Effects: (${effectsSlider.value})`;
});

ambienceSlider.addEventListener("input", () => {
  document.getElementById(
    "ambience-volume-label"
  )!.innerText = `Ambience: (${ambienceSlider.value})`;
});

weatherSlider.addEventListener("input", () => {
  document.getElementById(
    "weather-volume-label"
  )!.innerText = `Weather: (${weatherSlider.value})`;
});

[fpsSlider, musicSlider, effectsSlider, ambienceSlider, weatherSlider, mutedCheckbox, autoLootCheckbox].forEach(element => {
  element.addEventListener("change", () => {
    sendRequest({
      type: "CLIENTCONFIG",
          data: {
            fps: parseInt(fpsSlider.value),
            music_volume: parseInt(musicSlider.value) || 0,
            effects_volume: parseInt(effectsSlider.value) || 0,
            ambience_volume: parseInt(ambienceSlider.value) || 0,
            weather_volume: parseInt(weatherSlider.value) || 0,
            muted: mutedCheckbox.checked,
            auto_loot: autoLootCheckbox.checked,
          } as ConfigData,
    });
  });
});

// On a touch screen there is no right-click, which is how an item in the bags is offered in a trade or sold to a
// vendor (the contextmenu handler below). Two taps on the item do the same there. Heard before the bag slot's own
// two-tap handler (which equips or uses the item) and kept from it: while a trade or a vendor is open, the item goes
// to them.
let lastBagTap: { slot: Element; at: number } | null = null;
document.addEventListener("touchend", (event) => {
  const bagSlot = (event.target as HTMLElement | null)?.closest?.("#inventory .slot") as HTMLElement | null;
  const name = bagSlot?.dataset.itemName;
  if (!bagSlot || !name || (!isTrading() && !isVendorOpen() && !isMailOpen())) {
    lastBagTap = null;
    return;
  }
  // (a finger that dragged the item, to move it in the bags, is not a tap)
  if ((window as any).__touchDragActive) return;
  const now = Date.now();
  const second = lastBagTap !== null && lastBagTap.slot === bagSlot && now - lastBagTap.at < 300;
  lastBagTap = second ? null : { slot: bagSlot, at: now };
  if (!second) return;
  event.preventDefault();
  event.stopPropagation();
  if (isTrading()) offerItem(name);
  else if (isVendorOpen()) sellItem(name);
  else attachItem(name);
}, { capture: true });

document.addEventListener("contextmenu", (event) => {
  if (!getIsLoaded()) return;

  if ((window as any).tileEditor?.isActive) return;
  if (getContextMenuKeyTriggered()) {
    event.preventDefault();
    setContextMenuKeyTriggered(false);
    return;
  }

  if ((event.target as HTMLElement)?.closest(".ui")) {

    const partyMember = (event.target as HTMLElement).closest(".party-member") as HTMLElement;
    if (partyMember) {
      const username = partyMember.dataset.username;
      if (username) {
        createPartyContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }

    const guildMember = (event.target as HTMLElement).closest(".guild-member") as HTMLElement;
    if (guildMember) {
      const username = guildMember.dataset.username;
      if (username) {
        const currentPlayer = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
        const isSelf = currentPlayer?.username?.toLowerCase() === username.toLowerCase();
        const isLeader = currentPlayer?.guild?.length > 0
          && currentPlayer?.guild?.[0]?.toLowerCase() === currentPlayer?.username?.toLowerCase();
        if (!isSelf && !isLeader) {
          event.preventDefault();
          return;
        }
        createGuildContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }

    const ignoredItem = (event.target as HTMLElement).closest(".ignored-item") as HTMLElement;
    if (ignoredItem) {
      if (ignoredItem.dataset.username) {
        createIgnoredContextMenu(event, ignoredItem.dataset.username);
      }
      event.preventDefault();
      return;
    }

    const friendItem = (event.target as HTMLElement).closest(".friend-item") as HTMLElement;
    if (friendItem) {
      const nameEl = friendItem.querySelector(".friend-name");
      if (nameEl?.textContent) {
        createFriendContextMenu(event, nameEl.textContent);
      }
      event.preventDefault();
      return;
    }

    // While trading, a right-click on an item in the bags puts it on this player's side of the trade.
    const bagSlot = (event.target as HTMLElement).closest("#inventory .slot") as HTMLElement;
    if (bagSlot?.dataset.itemName && isTrading()) {
      offerItem(bagSlot.dataset.itemName);
      event.preventDefault();
      return;
    }
    // At a vendor, the same right-click sells the item: all of it that is spare.
    if (bagSlot?.dataset.itemName && isVendorOpen()) {
      sellItem(bagSlot.dataset.itemName);
      event.preventDefault();
      return;
    }
    // At a mailbox, it attaches the item to the mail being written.
    if (bagSlot?.dataset.itemName && isMailOpen()) {
      attachItem(bagSlot.dataset.itemName);
      event.preventDefault();
      return;
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // the world under the cursor, at the world zoom (worldzoom.ts)
  const { x: worldX, y: worldY } = screenToWorld(screenX, screenY);

  // Corpses cannot be targeted. Ghosts can be targeted and interacted with,
  // except while their graveyard teleport is still pending (not rendered).
  const clickedPlayer = playerAt(worldX, worldY, (player) => !player.isDead && !(player.isGhost && player.ghostTeleportPending));

  if (clickedPlayer) {
    const id = clickedPlayer.id;

    createContextMenu(event, id);
    return;
  }

  const existingMenu = document.getElementById("context-menu");
  if (existingMenu) existingMenu.remove();

  sendRequest({
    type: "TELEPORTXY",
    data: { x: Math.floor(worldX), y: Math.floor(worldY) },
  });
});

// Long-press player on mobile to show context menu
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressStartX = 0;
let longPressStartY = 0;

canvas.addEventListener("touchstart", (e) => {
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  if (!isTouchDevice) return;
  if ((window as any).tileEditor?.isActive) return;
  if (e.touches.length !== 1) { longPressTimer && clearTimeout(longPressTimer); longPressTimer = null; return; }

  const touch = e.touches[0];
  longPressStartX = touch.clientX;
  longPressStartY = touch.clientY;

  longPressTimer = setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    const screenX = longPressStartX - rect.left;
    const screenY = longPressStartY - rect.top;

    const { x: worldX, y: worldY } = screenToWorld(screenX, screenY);

    const clickedPlayer = playerAt(worldX, worldY, (player) => !player.isDead && !(player.isGhost && player.ghostTeleportPending));

    if (clickedPlayer) {
      createContextMenu({ clientX: longPressStartX, clientY: longPressStartY } as MouseEvent, clickedPlayer.id);
    }

    longPressTimer = null;
  }, 500);
});

canvas.addEventListener("touchend", () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
});

canvas.addEventListener("touchmove", (e) => {
  if (!longPressTimer) return;
  const touch = e.touches[0];
  const dx = touch.clientX - longPressStartX;
  const dy = touch.clientY - longPressStartY;
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

// Single tap on a quest NPC (touch only) talks to them. The E badge is
// desktop-only, so touch gets tap-to-talk instead. Short and still only:
// drags, long-presses and UI taps fall through to their normal handlers.
let npcTapStartX = 0;
let npcTapStartY = 0;
let npcTapStartAt = 0;
let npcTapOnUi = false;
const NPC_TAP_MAX_MS = 300;
const NPC_TAP_MAX_MOVE_PX = 12;

canvas.addEventListener("touchstart", (e) => {
  if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  const touch = e.touches[0];
  if (!touch || e.touches.length !== 1) { npcTapOnUi = true; return; }
  npcTapStartX = touch.clientX;
  npcTapStartY = touch.clientY;
  npcTapStartAt = Date.now();
  npcTapOnUi = !!(e.target as HTMLElement)?.closest?.(".ui");
}, { passive: true });

canvas.addEventListener("touchend", (e) => {
  if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  if (npcTapOnUi) return;
  if (!getIsLoaded() || (window as any).tileEditor?.isActive) return;
  if (isSelfActionLocked()) return;
  const touch = (e as any).changedTouches?.[0];
  if (!touch || (e as any).changedTouches?.length !== 1) return;
  if (Date.now() - npcTapStartAt > NPC_TAP_MAX_MS) return;
  if (Math.abs(touch.clientX - npcTapStartX) > NPC_TAP_MAX_MOVE_PX) return;
  if (Math.abs(touch.clientY - npcTapStartY) > NPC_TAP_MAX_MOVE_PX) return;

  const rect = canvas.getBoundingClientRect();
  const screenX = touch.clientX - rect.left;
  const screenY = touch.clientY - rect.top;
  const { x: worldX, y: worldY } = screenToWorld(screenX, screenY);
  import("./quest.js").then((m) => {
    // A tap on a mailbox opens it, when it is not a tap on an NPC; the server says when it is too far.
    // While the mailbox editor is open, a tap on a mailbox picks it.
    if ((window as any).mailboxEditorTap?.(worldX, worldY, TOUCH_TARGET_SLOP)) return;
    if (m.tryTapInteractNpcAt(worldX, worldY)) return;
    // A tap on a gathering node gathers it; the server says when it is too far.
    const node = gatherNodeAt(worldX, worldY, TOUCH_TARGET_SLOP);
    if (node) gather(node);
    else if (mailboxAt(worldX, worldY, TOUCH_TARGET_SLOP)) sendRequest({ type: "MAIL_OPEN", data: null });
    // a tap on water casts a line there (or, with a fish on, was the reel)
    else fishingClick(worldX, worldY);
  });
});

// Double-tap on mobile for admin warp
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

canvas.addEventListener("touchend", (e) => {
  if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  if ((window as any).tileEditor?.isActive) return;

  const now = Date.now();
  const touch = (e as any).changedTouches?.[0];
  if (!touch) return;

  const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
  if (!currentPlayer?.isAdmin) return;

  if (now - lastTapTime < 300 &&
      Math.abs(touch.clientX - lastTapX) < 30 &&
      Math.abs(touch.clientY - lastTapY) < 30) {

    const rect = canvas.getBoundingClientRect();
    const screenX = touch.clientX - rect.left;
    const screenY = touch.clientY - rect.top;

    const { x: worldX, y: worldY } = screenToWorld(screenX, screenY);

    sendRequest({
      type: "TELEPORTXY",
      data: { x: Math.floor(worldX), y: Math.floor(worldY) },
    });

    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }
});

// Ctrl + wheel zooms the world in, never the UI (worldzoom.ts).
installWorldZoom();
// Holding the mouse button or a finger down reels a fish in (fishing.ts).
installFishingInput();

// Ctrl + W closes the tab. USER REQUEST 2026-10-15: "Prevent control + w because that closes the tab". The browser keeps
// that key for itself (Chrome and Firefox close the tab before the page is told), so no key handler can stop it.
// Instead, while Ctrl is held, leaving the page asks first ("Leave site?"): Ctrl + W, and Ctrl + R too, close or reload
// nothing unless that is confirmed. The game's own moves to another page are never made with Ctrl held, so they are
// not asked about. Where the browser does pass the key on, it is simply stopped.
let ctrlHeld = false;
const followCtrl = (event: KeyboardEvent | MouseEvent) => { ctrlHeld = event.ctrlKey; };
window.addEventListener("keydown", (event) => {
  ctrlHeld = event.ctrlKey || event.key === "Control";
  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w") event.preventDefault();
});
window.addEventListener("keyup", (event) => { ctrlHeld = event.ctrlKey && event.key !== "Control"; });
// a key let go while the question was up, or in another window, is not seen: the next key or mouse movement says
window.addEventListener("mousemove", followCtrl, { passive: true });
window.addEventListener("mousedown", followCtrl, { passive: true });
window.addEventListener("blur", () => { ctrlHeld = false; });
window.addEventListener("beforeunload", (event) => {
  if (!ctrlHeld) return;
  event.preventDefault();
  // older browsers show the question only when this is set
  event.returnValue = "";
});

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  const under = screenToWorld(screenX, screenY);
  (window as any).mouseWorldX = Math.floor(under.x);
  (window as any).mouseWorldY = Math.floor(under.y);

  const worldX = (window as any).mouseWorldX;
  const worldY = (window as any).mouseWorldY;
  const floatOffset = Math.round(Math.sin(performance.now() * 0.002) * 4);
  const lootItems = cache.loot || [];
  let hoveredLoot: any = null;

  for (const loot of lootItems) {
    const iconCenterX = loot.x;
    const iconCenterY = loot.y - 52 + floatOffset;
    const dx = worldX - iconCenterX;
    const dy = worldY - iconCenterY;
    if (dx * dx + dy * dy < 24 * 24) {
      hoveredLoot = loot;
      break;
    }
  }

  if (hoveredLoot) {
    const itemData = itemsByName.get(hoveredLoot.item) || { name: hoveredLoot.item, quality: hoveredLoot.quality };
    showItemTooltip(canvas, { ...itemData, quantity: hoveredLoot.quantity, quality: hoveredLoot.quality }, event.clientX, event.clientY, event.shiftKey);
    (window as any).__lootTooltipVisible = true;
  } else if ((window as any).__lootTooltipVisible) {
    hideItemTooltip();
    (window as any).__lootTooltipVisible = false;
  }
});

document.addEventListener("click", (event) => {

  if (!getIsLoaded()) return;

  if ((window as any).tileEditor?.isActive) return;
  if ((event.target as HTMLElement)?.closest(".ui")) return;


  const contextMenu = document.getElementById("context-menu");
  if (contextMenu && !contextMenu.contains(event.target as Node)) {
    contextMenu.remove();
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Shared projection (worldzoom.ts): the touch screens' 0.85 and the player's zoom.
  const { x: worldX, y: worldY } = screenToWorld(screenX, screenY);

  // A fingertip is far less precise than a cursor: widen the hit area on touch.
  const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const slop = isTouch ? TOUCH_TARGET_SLOP : 0;

  if (cache.groundTargetingSpell) {
    // Corpses and ghosts cannot cast.
    if (isSelfActionLocked()) {
      cache.groundTargetingSpell = null;
      document.body.style.cursor = '';
      return;
    }
    const spellName = cache.groundTargetingSpell;
    cache.groundTargetingSpell = null;
    document.body.style.cursor = '';

    const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
    if (currentPlayer) {
      const formattedSpellName = spellName.split('_').map((word: string) =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');
      currentPlayer.castingSpell = formattedSpellName;
      currentPlayer.castingStartTime = performance.now();
      currentPlayer.castingDuration = 2000;
      currentPlayer.castingInterrupted = false;
      currentPlayer.groundAoeTarget = { x: Math.floor(worldX), y: Math.floor(worldY) };
    }

    sendRequest({
      type: "HOTBAR",
      data: {
        spell: spellName,
        groundX: Math.floor(worldX),
        groundY: Math.floor(worldY),
      }
    });
    return;
  }

  // Clear previous target
  const prevPlayer = Array.from(cache.players).find(player => player.targeted);
  if (prevPlayer) {
    prevPlayer.targeted = false;
  }
  const prevNpc = cache.npcs.find((npc: any) => npc.id === cache.targetId);
  if (prevNpc) {
    cache.targetId = null;
  }

  // Check if clicked on NPC
  const clickedNpc = cache.npcs.find((npc: any) => {
    // A sound NPC is only heard: there is nothing to click.
    if (npc.sound_npc) return false;
    const npcX = npc.position.x;
    const npcY = npc.position.y;
    return (
      worldX >= npcX - 16 - slop && worldX <= npcX + 32 + slop &&
      worldY >= npcY - 24 - slop && worldY <= npcY + 48 + slop
    );
  });

  if (clickedNpc) {
    cache.targetId = clickedNpc.id;
    return;
  }

  // A click on a gathering node gathers it; the server says when it is too far. A tap is the touch handler's (below).
  const node = !isTouch ? gatherNodeAt(worldX, worldY, slop) : null;
  if (node) {
    if (!isSelfActionLocked()) gather(node);
    return;
  }

  // A click on a mailbox opens it; the server says when it is too far. A tap is the touch handler's (below).
  if (!isTouch && mailboxAt(worldX, worldY, slop)) {
    if (!isSelfActionLocked()) sendRequest({ type: "MAIL_OPEN", data: null });
    return;
  }

  // A click on water casts a line there; with a fish on, the press was the reel. The server says when it is too far.
  // A tap is the touch handler's (above).
  if (!isTouch && !isSelfActionLocked() && fishingClick(worldX, worldY)) return;

  // Players are picked server-side; `touch` asks for the wider touch area.
  sendRequest({
    type: "SELECTPLAYER",
    data: { x: Math.floor(worldX), y: Math.floor(worldY), touch: isTouch },
  });
});

chatInput.addEventListener("focus", () => {
  stopMovement();
});

friendsListSearch.addEventListener("focus", () => {
  stopMovement();
});

chatInput.addEventListener("blur", () => {
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  pressedKeys.clear();
  setIsKeyPressed(false);
  setIsMoving(false);
});

friendsListSearch.addEventListener("input", () => {
  const searchTerm = friendsListSearch.value.toLowerCase();
  const friendItems = Array.from(friendsList.querySelectorAll('.friend-item')) as HTMLElement[];
  if (!searchTerm) {

    friendItems.forEach(item => {
      item.style.display = 'block';
    });
    return;
  }

  friendItems.forEach(item => {
    const friendName = item.querySelector('.friend-name')?.textContent?.toLowerCase() || '';
    if (friendName.includes(searchTerm)) {
      item.style.display = 'block';
    } else {
      item.style.display = 'none';
    }
  });
});

// Party member click on mobile shows context menu
document.addEventListener("click", (e) => {
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  if (!isTouchDevice) return;

  const partyMember = (e.target as HTMLElement).closest(".party-member") as HTMLElement;
  if (partyMember) {
    const username = partyMember.dataset.username;
    if (username) {
      createPartyContextMenu(e as MouseEvent, username);
    }
    return;
  }

  // A tap on a guild member opens the member panel (ui.ts createGuildUI), which carries its actions: no menu here.
  if ((e.target as HTMLElement).closest(".guild-member")) return;

  const friendItem = (e.target as HTMLElement).closest(".friend-item") as HTMLElement;
  if (friendItem) {
    const nameEl = friendItem.querySelector(".friend-name");
    if (nameEl?.textContent) {
      createFriendContextMenu(e as MouseEvent, nameEl.textContent);
    }
    return;
  }
});

// A tap off a window does not close it: only its X or Close button does (and Escape, and its own key, on a keyboard).
// USER REQUEST 2026-10-16: "Keep all UI elements open when tapping off of them. Only allow the x or close buttons to
// close them from now on". Until then a tap outside the open panels closed them all on a touch screen.

// Allow dropping items from inventory/equipment onto the game world (canvas)
canvas.addEventListener("dragover", (e: DragEvent) => {
  if (e.dataTransfer?.types.includes("inventory-item-name") || e.dataTransfer?.types.includes("equipped-item-name")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
});

canvas.addEventListener("drop", (e: DragEvent) => {
  const itemName = e.dataTransfer?.getData("inventory-item-name")
    || e.dataTransfer?.getData("equipped-item-name");
  if (!itemName) return;

  e.preventDefault();
  const from = e.dataTransfer?.getData("equipped-item-name") ? "equipment" : "inventory";
  const slot = e.dataTransfer?.getData("equipped-item-slot") || null;

  const existing = document.getElementById("delete-item-popup");
  if (existing) existing.remove();

  const cache = Cache.getInstance();
  const lowerName = itemName.toLowerCase();
  const invItem = (cache.inventory || []).find((i: any) => i.name.toLowerCase() === lowerName);
  // The home item stays with its player: the server refuses too.
  if (teleportsHome(invItem)) {
    showNotification(`${invItem.name} cannot be destroyed.`, true, false);
    return;
  }
  const quality = invItem?.quality || "common";
  const qty = invItem?.quantity || 1;
  const requiresTyping = quality.toLowerCase() === "legendary" || quality.toLowerCase() === "epic";

  const QUALITY_COLORS: Record<string, string> = {
    common: '#9d9d9d', uncommon: '#1eff00', rare: '#0070dd',
    epic: '#a335ee', legendary: '#ff8000',
  };
  const qColor = QUALITY_COLORS[quality.toLowerCase()] || QUALITY_COLORS.common;

  const popup = document.createElement("div");
  popup.id = "delete-item-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Delete Item</h2>
    <p>Are you sure you want to destroy <strong style="color:${qColor}">${itemName}</strong>${qty > 1 ? ` (x${qty})` : ""}? This cannot be undone.</p>
    ${requiresTyping ? `<p style="color:#ff4444;font-size:0.75em;">Type <strong>delete</strong> below to confirm.</p>
    <input id="delete-confirm-input" type="text" placeholder="delete" autocomplete="off" />` : ""}
    <div class="button-container">
      <button id="confirm-delete-item">Delete</button>
      <button id="cancel-delete-item">Cancel</button>
    </div>
  `;
  document.body.appendChild(popup);

  const confirmBtn = document.getElementById("confirm-delete-item") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-delete-item") as HTMLButtonElement;
  const input = document.getElementById("delete-confirm-input") as HTMLInputElement;

  if (requiresTyping && confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = "0.5";
    input?.addEventListener("input", () => {
      const ok = input.value.trim().toLowerCase() === "delete";
      confirmBtn.disabled = !ok;
      confirmBtn.style.opacity = ok ? "1" : "0.5";
    });
  }

  confirmBtn?.addEventListener("click", () => {
    if (requiresTyping && input?.value.trim().toLowerCase() !== "delete") return;
    (window as any).sendRequest({ type: "DELETE_ITEM", data: { item: itemName, from, slot } });
    popup.remove();
  });

  cancelBtn?.addEventListener("click", () => {
    popup.remove();
  });

  popup.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape") popup.remove();
    if (ev.key === "Enter" && !confirmBtn.disabled) {
      confirmBtn.click();
    }
  });
});