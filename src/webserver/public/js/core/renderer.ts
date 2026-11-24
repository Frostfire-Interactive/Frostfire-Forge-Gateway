import { getIsLoaded, getMovementAllowed, getHandoffGap, getWalkAtSwitch, getGapReports, gapWalkStarted, noteGapFrame, finishGapWalk, gapFrameMs, handoffPace, cachedPlayerId, sendRequest } from "./socket.js";
import { advanceSelf, applyEase, atMountSpeed, blockedAt, gapDirection, gapSampleTime, gapStepMs, releaseHeld, stepWalkMs } from "./handoffwalk.js";
import { getIsKeyPressed, getStickDirection, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache.ts";
import { getParticleSprite, particleBrightness, particlePool, renderNpcInteractBadge, tickNpcGossip } from "./npc.js";
import { queueGlow } from "./glowqueue.js";
import { getNearestNpcId, canInteractWith } from "./quest.js";
import { stepCreatures, drawCreature, drawFloatingTexts, creatureFeetY, parseCreatureTarget, creaturePositionFor, creatures, FEET_FRACTION, targetArrowFor } from "./creature.js";
import { drawTargetArrow, TARGET_ARROWS, ARROW_GAP, spriteArtTop } from "./targetmarker.js";
import { backToFront, PLAYER_FEET, type Standing } from "./depthorder.js";
import { updateUnitFrames } from "./targetframe.js";
import { dropDistantTarget } from "./creatureinput.js";
import { updateSourceParticle } from "./sourceparticles.js";
import { renderCreatureEditorOverlays, renderThreatPanel } from "./creaturedebug.js";
import { renderGatherHint, renderGatherPreviewArea, standingGatherNodes } from "./gathering.js";
import { renderFishing } from "./fishing.js";
import { renderFootprints } from "./footprints.js";
import { drawStoneShadows, standingStones } from "./summonstones.js";
import { drawStanding, renderDungeonPortalGround, setPortalWalkers, standingDungeonPortals, type PortalWalker } from "./portalfx.js";
import { stopAfterMapLoad } from "./mapstop.js";
import { hotbarCover } from "./hotbarcover.js";
import { heldThroughWarp, portalRects, steerWaitPose, steerWalkInPose, steerWalkOutPose, transit, type PortalRect } from "./portaltransit.js";
import { renderCorpseLootHint, updateCreatureLootProximity } from "./creatureloot.js";
let weatherType = null as string | null;
let currentWeatherData = null as any; // Store full weather object for wind speed
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar, updateAbsorptionBar } from "./ui.js";
import { updateWeatherCanvas, weather, updateWeatherSound } from './weather.ts';
import { stepTornadoes, standingTornadoes, drawTornadoesOverCovers } from './tornado.ts';
/** How often (ms) the rain and wind sounds are brought in line with the weather. */
const WEATHER_SOUND_EVERY = 100;
import { updateNpcSounds, soundCenterRadius } from './npcsounds.ts';
import { getShadowParams, SHADOW_MAX_OFFSET } from './shadows.js';
import { renderMapPass, setShadowMaxOffset } from './glmap/index.js';
import {
  renderMapPass as renderMapPassMobile,
  setShadowMaxOffset as setShadowMaxOffsetMobile,
  setMapVisible as setMapVisibleMobile,
} from './glmap-mobile/index.js';
import { MOBILE_RENDERER } from './renderpath.js';
import { renderLoot, renderLootInteractionHint } from './loot.js';
import { renderSkeletons } from './skeletons.js';
import { isSelfDead, isReleaseHidden, tickDeathOffer, tickReleaseCinematic, tickCorpseMarker, tickDeathWisps, tickGraveyardOffer } from './death.js';
import { renderLightMap } from './lightmap.js';
import { applyWorldTransform, stepWorldZoom, worldOffset, viewWidth, viewHeight, userZoom, worldToScreen, worldZoom } from './worldzoom.js';
import { updateTileSounds } from './tilesounds.js';
import { tickCutscene, cutsceneCamera, cutsceneHidesPlayer, cutsceneHidesCreatures, cutsceneHidesHud, drawCutsceneLayer } from './cutscene.js';
import { captureFrame, setFrameDrawer } from './cutscenecapture.js';
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
import { animationManager } from "./animationStateManager.js";
import { updateLayeredAnimation, changeLayeredAnimation, warmPoses } from "./layeredAnimation.js";
import { gapPose } from "./gappose.js";
import { renderTime, pushSample, pushPredicted, getLateness, positionAt, needsPositionSample, type MoveSample } from "./movementsmoothing.js";
const times = [] as number[];
let lastFpsUpdate = 0;
let lastDirection = "";
let cameraX: number = 0, cameraY: number = 0, lastFrameTime: number = 0;
let smoothMapX: number = 0, smoothMapY: number = 0;
let cameraInitialized: boolean = false;
// Free-pan editor camera state (used only while the tile editor is active).
let editorCameraX: number = 0, editorCameraY: number = 0;
let editorCameraInitialized: boolean = false;

// Chunk load time tracking for fade-in effect
const chunkLoadTimes = new Map<string, number>();
const CHUNK_FADE_DURATION = 0.5; // Fade duration in seconds

// Tileset lookup cache for fast tile->tileset resolution

import { canvas, ctx, ghostCanvas, ghostCtx, aboveCanvas, aboveCtx, castbarCanvas, castbarCtx, debugLayerCanvas, debugLayerCtx, fpsSlider, healthBar, staminaBar, collisionDebugCheckbox, chunkOutlineDebugCheckbox, collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, astarDebugCheckbox, shadowsDebugCheckbox, loadedChunksText, clusterNodesDebugCheckbox } from "./ui.js";
import { drawClusterNodes } from "./clusternodes.ts";

// Frame pacing: the measured display refresh interval (ms), from rAF deltas.
let rafInterval = 1000 / 60;
let lastRafTime = 0;
let rafsSinceRender = 0;

// Typing-indicator <img> elements on document.body, mapped to their player.
const typingBubbles = new Map<HTMLImageElement, any>();
/** The typing GIF's own size, px: it is drawn this many world pixels square. */
const TYPING_BUBBLE_SIZE = 48;

function updateRemotePlayerInterpolation(player: any, deltaSeconds: number) {
  if (!player || !player.lastServerUpdate) return;
  if (player.id === cachedPlayerId) return;

  const dx = player.serverPosition.x - player.position.x;
  const dy = player.serverPosition.y - player.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const threshold = 5;
  const lerpFactor = 0.2 * deltaSeconds * 60;
  if (distance > threshold) {
    player.position.x = Math.round(player.position.x + dx * lerpFactor);
    player.position.y = Math.round(player.position.y + dy * lerpFactor);
  }
}

// The map's portal rectangles, made again when its portals change (portaltransit.ts).
let transitPortals: { raw: unknown; map: string; rects: PortalRect[] } | null = null;
// The local player's trips through a portal seen so far: each one holds the keys held through it (HeldKeys).
let heldWarps = 0;

/** Shows this frame's players to the portal transit tracker (who goes into a portal and who comes out of one), and
 *  poses those walking out of one. */
function observeTransit(players: any[], now: number): void {
  const map = String(window.mapData?.name ?? "");
  const raw = (window.mapData as any)?.dungeonPortals;
  if (!transitPortals || transitPortals.raw !== raw || transitPortals.map !== map) transitPortals = { raw, map, rects: portalRects(raw, map) };
  const seen = [];
  for (const p of players) {
    const at = p?.position ?? p?.renderPosition, drawn = p?.renderPosition ?? p?.position;
    if (p?.id == null || !at || !drawn) continue;
    seen.push({ id: String(p.id), x: at.x, y: at.y, dx: drawn.x, dy: drawn.y, ref: p, fast: atMountSpeed(p) });
  }
  transit.observe({ map, now, localId: cachedPlayerId ? String(cachedPlayerId) : null, portals: transitPortals.rects, players: seen });
  for (const p of seen) {
    const walk = transit.walkOutOf(p.id);
    if (walk && now >= walk.at) steerWalkOutPose(p.ref, walk, now, changeLayeredAnimation);
  }
}

/** Draws a player as if they stood at (x, y): on a walk into or out of a portal (portaltransit.ts). */
function showAt(p: any, x: number, y: number, into: CanvasRenderingContext2D, currentPlayer: any): void {
  const was = p.renderPosition;
  p.renderPosition = { x, y };
  try { p.show(into, currentPlayer); } finally { p.renderPosition = was; }
}

function smoothPlayerRenderPositions(players: any[], now: number) {
  const at = renderTime(now);
  for (const player of players) {
    if (!player?.position) continue;
    const samples: MoveSample[] = player.moveSamples ??= [];
    const last = samples[samples.length - 1];
    if (needsPositionSample(last, player.position, now)) {
      if (last && player.id === cachedPlayerId && getHandoffGap()) {
        pushPredicted(samples, player.position.x, player.position.y, gapSampleTime(now, last.t, getLateness(), stepWalkMs(last, player.position.x, player.position.y, atMountSpeed(player))));
      } else if (last?.held && player.id === cachedPlayerId) {
        // A held spot timed out: the real position is behind it, reached at the walking speed, not as a step back.
        releaseHeld(samples, player.position.x, player.position.y, at, atMountSpeed(player));
      } else {
        pushSample(samples, player.position.x, player.position.y, last ? last.t + 0.01 : now);
      }
    }
    const smoothed = positionAt(samples, at)!;
    // The local player's difference to the new node's position after a handoff is eased out (handoffwalk.ts).
    const eased = player.handoffEase && player.id === cachedPlayerId ? applyEase(player, smoothed, now) : smoothed;
    // For a second after a handoff in which the client walked the player, the draw is played at the walking pace (handoffwalk.ts HandoffPace).
    const p = player.id === cachedPlayerId ? handoffPace.stepFor(eased, now, pressedKeys, getStickDirection(), atMountSpeed(player), (x, y) => blockedAt(window.mapData, x, y)) : eased;
    if (!player.renderPosition) {
      player.renderPosition = { x: p.x, y: p.y };
    } else {
      player.renderPosition.x = p.x;
      player.renderPosition.y = p.y;
    }
  }
}

declare global {
  interface Window {
    mapData?: any;
  }
}

const loadedChunksSet = new Set<string>();
const pendingChunks = new Set<string>();
// Chunks asked for that came back with none (off the map, or nothing there).
const noChunk = new Set<string>();
let pendingRequest: boolean = false;

function clearChunkTracking() {
  loadedChunksSet.clear();
  pendingChunks.clear();
  noChunk.clear();
  chunkLoadTimes.clear();
  frameVisibleChunksCache = null;
}

function deleteChunkTracking(chunkKey: string) {
  loadedChunksSet.delete(chunkKey);
  chunkLoadTimes.delete(chunkKey);
}

let bottomCover = 0, bottomCoverOf = "", bottomCoverAt = 0;
function coveredBottom(): number {
  const of = `${window.innerWidth}x${window.innerHeight}|${document.body.className}`;
  const now = performance.now();
  if (of === bottomCoverOf && now - bottomCoverAt < 1000) return bottomCover;
  bottomCoverOf = of;
  bottomCoverAt = now;
  bottomCover = hotbarCover(document.getElementById("hotbar")?.getBoundingClientRect(), window.innerHeight);
  return bottomCover;
}

function updateCamera(currentPlayer: any, deltaTime: number, focus?: { x: number; y: number }) {
  if (!getIsLoaded()) return;

  const tileEditor = (window as any).tileEditor;
  if (tileEditor?.isActive && window.mapData) {
    if ((window as any).__resetEditorCamera) {
      const arriveX = Number(window.mapData.spawnX), arriveY = Number(window.mapData.spawnY);
      editorCameraX = Number.isFinite(arriveX) && arriveX !== 0 ? arriveX : cameraX;
      editorCameraY = Number.isFinite(arriveY) && arriveY !== 0 ? arriveY : cameraY;
      editorCameraInitialized = true;
      (window as any).__resetEditorCamera = false;
    } else if (!editorCameraInitialized) {
      editorCameraX = cameraX;
      editorCameraY = cameraY;
      editorCameraInitialized = true;
    }
    cameraX = editorCameraX;
    cameraY = editorCameraY;
    smoothMapX = cameraX;
    smoothMapY = cameraY;

    updateNpcSounds(cameraX, cameraY); // (heard from the editor's camera while the map is edited)
    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType, currentWeatherData);
    }
    return;
  }
  editorCameraInitialized = false;

  const shot = cutsceneCamera();
  if (shot && window.mapData) {
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    const mapHeight = window.mapData.height * window.mapData.tileheight;
    const halfViewportWidth = viewWidth() / 2;
    const halfViewportHeight = viewHeight() / 2;
    cameraX = Math.max(halfViewportWidth, Math.min(mapWidth - halfViewportWidth, shot.x));
    cameraY = mapHeight < halfViewportHeight * 2 ? mapHeight / 2 : Math.max(halfViewportHeight, Math.min(mapHeight - halfViewportHeight, shot.y));
    smoothMapX = cameraX;
    smoothMapY = cameraY;

    updateNpcSounds(cameraX, cameraY);
    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType, currentWeatherData);
    }
    return;
  }

  if (currentPlayer && window.mapData) {
    // (on a walk through a portal, where the walk draws them: portaltransit.ts cameraAt)
    const targetX = (focus ?? currentPlayer.renderPosition).x;
    const targetY = (focus ?? currentPlayer.renderPosition).y;

    cameraX = targetX;
    cameraY = targetY;

    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    const mapHeight = window.mapData.height * window.mapData.tileheight;
    // the world in view at the player's zoom (worldzoom.ts), so a map's edge still stops the camera when zoomed in
    const halfViewportWidth = viewWidth() / 2;
    const halfViewportHeight = viewHeight() / 2;

    cameraX = Math.max(halfViewportWidth, Math.min(mapWidth - halfViewportWidth, cameraX));
    const cover = coveredBottom() / userZoom();
    cameraY = mapHeight < halfViewportHeight * 2 - cover
      ? mapHeight / 2 + cover / 2
      : Math.max(halfViewportHeight, Math.min(mapHeight - halfViewportHeight + cover, cameraY));

    smoothMapX = cameraX;
    smoothMapY = cameraY;

    updateNpcSounds(targetX, targetY); // (heard from the player, not the camera: a map's edge stops the camera)
    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY, targetX, targetY);
      weather(weatherType, currentWeatherData);
    }
  }
}

function drawSoundRanges(context: CanvasRenderingContext2D) {
  const viewHalfW = viewWidth() / 2, viewHalfH = viewHeight() / 2;
  for (const npc of cache.npcs as any[]) {
    if (npc?.sound_npc !== true || !npc.position) continue;
    const x = npc.position.x, y = npc.position.y, radius = Math.max(0, Number(npc.sound_radius) || 0);
    if (Math.abs(x - cameraX) > viewHalfW + radius + 32 || Math.abs(y - cameraY) > viewHalfH + radius + 32) continue;
    const dim = npc.hidden ? 0.5 : 1;
    if (radius > 0) {
      const fade = context.createRadialGradient(x, y, 0, x, y, radius);
      fade.addColorStop(0, `rgba(168, 85, 247, ${0.38 * dim})`);
      fade.addColorStop(0.6, `rgba(168, 85, 247, ${0.16 * dim})`);
      fade.addColorStop(1, "rgba(168, 85, 247, 0)");
      context.fillStyle = fade;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = `rgba(192, 132, 252, ${0.55 * dim})`;
      context.lineWidth = 1.5;
      context.setLineDash([6, 6]);
      context.stroke();
      context.setLineDash([]);
      const center = soundCenterRadius(radius);
      context.fillStyle = `rgba(59, 130, 246, ${0.3 * dim})`;
      context.strokeStyle = `rgba(96, 165, 250, ${0.9 * dim})`;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(x, y, center, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.fillStyle = `rgba(192, 132, 252, ${dim})`;
    context.strokeStyle = "rgba(20, 0, 40, 0.9)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.font = "bold 13px monospace";
    context.textAlign = "center";
    context.shadowColor = "rgba(0, 0, 0, 0.8)";
    context.shadowBlur = 4;
    context.fillText(npc.id === null || npc.id === undefined ? "new" : `#${npc.id}`, x, y - 12);
    context.shadowColor = "transparent";
  }
}

// Pan the free-pan editor camera by a world-space delta.
export function panEditorCamera(dx: number, dy: number) {
  if (!window.mapData) return;
  const tw = window.mapData.tilewidth;
  const th = window.mapData.tileheight;
  const mapW = window.mapData.width * tw;
  const mapH = window.mapData.height * th;
  const pad = Math.max(window.innerWidth, window.innerHeight);

  editorCameraX += dx;
  editorCameraY += dy;
  // Clamp so camera cannot pan into negative-tile territory (left/up expansion disabled)
  const minX = window.innerWidth / 2;
  const minY = window.innerHeight / 2;
  const maxX = mapW + pad;
  const maxY = mapH + pad;
  if (editorCameraX < minX) editorCameraX = minX;
  if (editorCameraY < minY) editorCameraY = minY;
  if (editorCameraX > maxX) editorCameraX = maxX;
  if (editorCameraY > maxY) editorCameraY = maxY;
  editorCameraInitialized = true;
}

function getVisibleChunks(): Array<{x: number, y: number}> {
  return chunksAround(cameraX, cameraY);
}

// The chunks a view centred at (x, y) shows, with one chunk round them.
function chunksAround(x: number, y: number): Array<{x: number, y: number}> {
  if (!window.mapData) return [];

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const cameraLeft = x - viewportWidth / 2;
  const cameraTop = y - viewportHeight / 2;
  const cameraRight = x + viewportWidth / 2;
  const cameraBottom = y + viewportHeight / 2;

  const padding = chunkPixelSize;

  const minCX = window.mapData.minChunkX ?? 0;
  const minCY = window.mapData.minChunkY ?? 0;
  const startChunkX = Math.max(minCX, Math.floor((cameraLeft - padding) / chunkPixelSize));
  const startChunkY = Math.max(minCY, Math.floor((cameraTop - padding) / chunkPixelSize));
  const endChunkX = Math.min(window.mapData.chunksX - 1, Math.floor((cameraRight + padding) / chunkPixelSize));
  const endChunkY = Math.min(window.mapData.chunksY - 1, Math.floor((cameraBottom + padding) / chunkPixelSize));

  const visible: Array<{x: number, y: number}> = [];
  for (let cy = startChunkY; cy <= endChunkY; cy++) {
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
      visible.push({ x: cx, y: cy });
    }
  }
  return visible;
}

let frameVisibleChunksCache: Array<{x: number, y: number}> | null = null;
let frameVisibleChunksFrameId = -1;
let globalFrameId = 0;

function getVisibleChunksCached(): Array<{x: number, y: number}> {
  if (frameVisibleChunksCache && frameVisibleChunksFrameId === globalFrameId) {
    return frameVisibleChunksCache;
  }
  frameVisibleChunksCache = getVisibleChunks();
  frameVisibleChunksFrameId = globalFrameId;
  return frameVisibleChunksCache;
}

async function loadVisibleChunks() {
  if (!window.mapData) return;

  const visibleChunks = getVisibleChunksCached();
  const visibleKeys = new Set(visibleChunks.map(c => `${c.x}-${c.y}`));

  const unloadDistance = window.mapData.chunkSize * window.mapData.tilewidth * 2;
  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;

  const chunksToUnload: string[] = [];

  const editorActiveForUnload = (window as any).tileEditor?.isActive;
  if (!editorActiveForUnload) for (const chunkKey of loadedChunksSet) {
    if (!visibleKeys.has(chunkKey) && !landingKeys.has(chunkKey)) {

      const chunkData = window.mapData.loadedChunks.get(chunkKey);
      if (chunkData) {
        const chunkCenterX = (chunkData.chunkX + 0.5) * chunkPixelSize;
        const chunkCenterY = (chunkData.chunkY + 0.5) * chunkPixelSize;
        const distance = Math.hypot(chunkCenterX - cameraX, chunkCenterY - cameraY);

        if (distance > unloadDistance) {
          chunksToUnload.push(chunkKey);
        }
      }
    }
  }

  // The map renderer frees a chunk's GPU texture once it leaves loadedChunks.
  for (const chunkKey of chunksToUnload) {
    window.mapData.loadedChunks.delete(chunkKey);
    loadedChunksSet.delete(chunkKey);
    chunkLoadTimes.delete(chunkKey);

    const preloadCache = (window as any).__preloadedMaps?.[window.mapData.name]?.loadedChunks;
    if (preloadCache) {
      preloadCache.delete(chunkKey);
    }
  }

  requestChunks(visibleChunks, cameraX, cameraY);
}

// Asks for those of `chunks` not loaded or asked for yet, the nearest to (x, y) first so they arrive first.
function requestChunks(chunks: Array<{x: number, y: number}>, x: number, y: number): void {
  if (!window.mapData) return;
  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
  const chunksToLoad: Array<{x: number, y: number, key: string}> = [];

  for (const chunk of chunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;

    if (!loadedChunksSet.has(chunkKey) && !pendingChunks.has(chunkKey)) {
      chunksToLoad.push({ x: chunk.x, y: chunk.y, key: chunkKey });
      pendingChunks.add(chunkKey);
    }
  }

  if (chunksToLoad.length > 0) {
    const distanceToCamera = (c: { x: number; y: number }) =>
      Math.hypot((c.x + 0.5) * chunkPixelSize - x, (c.y + 0.5) * chunkPixelSize - y);
    chunksToLoad.sort((a, b) => distanceToCamera(a) - distanceToCamera(b));

    const loadPromises = chunksToLoad.map(chunk =>
      window.mapData.requestChunk(chunk.x, chunk.y)
        .then((chunkData: any) => {
          if (chunkData) {
            loadedChunksSet.add(chunk.key);
            noChunk.delete(chunk.key);
          } else {
            noChunk.add(chunk.key);
          }
        })
        .catch((error: any) => {
        })
        .finally(() => {
          pendingChunks.delete(chunk.key);
        })
    );

    Promise.all(loadPromises).catch(() => {});
  }
}

// The ground round where the local player lands from a portal on this map, far off: asked for while they wait in the
// portal they went into, kept while they wait, and shown at once (not faded in) when it is all there, as they walk out.
const landingKeys = new Set<string>();
function prepareLanding(now: number): void {
  const land = transit.landingSpot();
  landingKeys.clear();
  if (!land || !window.mapData) return;
  const chunks = chunksAround(land.x, land.y).filter((c) => !noChunk.has(`${c.x}-${c.y}`));
  for (const c of chunks) landingKeys.add(`${c.x}-${c.y}`);
  requestChunks(chunks, land.x, land.y);
  for (const key of landingKeys) if (!loadedChunksSet.has(key)) return;
  for (const key of landingKeys) chunkLoadTimes.set(key, -Infinity);
  landingKeys.clear();
  transit.landed(now);
}

let chunkLoadThrottle = 0;

function renderGraveyardsAndWarps(renderCtx: CanvasRenderingContext2D, offsetX: number, offsetY: number) {
  if (!window.mapData) return;

  const tilesize = 32;
  const tileEditor = (window as any).tileEditor;

  // Render graveyards as tombstones
  if (window.mapData.graveyards) {
    // Check if Graveyards are visible in the Objects panel
    const graveyardsVisible = !tileEditor || tileEditor.isObjectLayerVisible('Graveyards');

    Object.entries(window.mapData.graveyards).forEach(([name, data]: [string, any]) => {
      const x = data.position?.x || 0;
      const y = data.position?.y || 0;
      const isSelected = isEditorSelected(tileEditor, 'Graveyards', name);

      // Draw selection highlight first (behind everything)
      if (isSelected) {
        renderCtx.fillStyle = 'rgba(100, 200, 255, 0.3)';
        renderCtx.beginPath();
        renderCtx.arc(x, y, 25, 0, Math.PI * 2);
        renderCtx.fill();
      }

      // Apply opacity based on visibility toggle
      const opacity = graveyardsVisible ? 1.0 : 0;

      const width = 16;
      const height = 22;
      const cornerRadius = 2;

      // Set opacity based on layer visibility
      const prevAlpha = renderCtx.globalAlpha;
      renderCtx.globalAlpha = opacity;

      // Draw tombstone shadow
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      renderCtx.fillRect(x - width / 2 + 1, y - height / 2 + 1, width, height);

      // Draw main tombstone body (dark gray or highlighted)
      renderCtx.fillStyle = isSelected ? 'rgba(100, 100, 150, 0.9)' : 'rgba(60, 60, 70, 0.9)';
      renderCtx.strokeStyle = isSelected ? 'rgba(150, 150, 200, 1)' : 'rgba(80, 80, 90, 1)';
      renderCtx.lineWidth = isSelected ? 2.5 : 1.5;

      // Rounded rectangle for tombstone
      renderCtx.beginPath();
      renderCtx.moveTo(x - width / 2 + cornerRadius, y - height / 2);
      renderCtx.lineTo(x + width / 2 - cornerRadius, y - height / 2);
      renderCtx.quadraticCurveTo(x + width / 2, y - height / 2, x + width / 2, y - height / 2 + cornerRadius);
      renderCtx.lineTo(x + width / 2, y + height / 2 - 2);
      renderCtx.quadraticCurveTo(x + width / 2, y + height / 2, x + width / 2 - cornerRadius, y + height / 2);
      renderCtx.lineTo(x - width / 2 + cornerRadius, y + height / 2);
      renderCtx.quadraticCurveTo(x - width / 2, y + height / 2, x - width / 2, y + height / 2 - 2);
      renderCtx.lineTo(x - width / 2, y - height / 2 + cornerRadius);
      renderCtx.quadraticCurveTo(x - width / 2, y - height / 2, x - width / 2 + cornerRadius, y - height / 2);
      renderCtx.fill();
      renderCtx.stroke();

      // Draw lighter edge/highlight
      renderCtx.strokeStyle = 'rgba(120, 120, 130, 0.6)';
      renderCtx.lineWidth = 1;
      renderCtx.beginPath();
      renderCtx.moveTo(x - width / 2 + 2, y - height / 2 + 2);
      renderCtx.lineTo(x - width / 2 + 2, y + height / 2 - 2);
      renderCtx.stroke();

      // Draw cross on tombstone (centered)
      renderCtx.strokeStyle = 'rgba(200, 180, 140, 0.9)';
      renderCtx.lineWidth = 1.5;
      renderCtx.lineCap = 'round';

      // Vertical line of cross
      renderCtx.beginPath();
      renderCtx.moveTo(x, y - 4);
      renderCtx.lineTo(x, y + 2);
      renderCtx.stroke();

      // Horizontal line of cross
      renderCtx.beginPath();
      renderCtx.moveTo(x - 2.5, y - 1);
      renderCtx.lineTo(x + 2.5, y - 1);
      renderCtx.stroke();

      // Draw name label above tombstone with background
      renderCtx.save();
      renderCtx.font = 'bold 13px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.textBaseline = 'middle';

      const textMetrics = renderCtx.measureText(name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const labelX = x;
      const labelY = y - height / 2 - 12;

      // Draw background
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      renderCtx.fillRect(labelX - textWidth / 2 - 4, labelY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);

      // Draw text
      renderCtx.fillStyle = 'rgba(150, 220, 255, 1)';
      renderCtx.fillText(name, labelX, labelY);

      // Store label coordinates for click detection (convert world to screen coords)
      if (tileEditor) {
        const screenX = labelX + offsetX;
        const screenY = labelY + offsetY;
        tileEditor.setLabelCoords(name, 'Graveyards', screenX - textWidth / 2 - 4, screenY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
      }

      // Draw delete button at bottom right when selected
      if (isSelected) {
        const buttonSize = 16;
        const buttonX = x + width / 2 + 8;
        const buttonY = y + height / 2 + 8;

        renderCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
        renderCtx.fillRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(200, 50, 50, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.strokeRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.beginPath();
        renderCtx.moveTo(buttonX + 3, buttonY + 3);
        renderCtx.lineTo(buttonX + buttonSize - 3, buttonY + buttonSize - 3);
        renderCtx.moveTo(buttonX + buttonSize - 3, buttonY + 3);
        renderCtx.lineTo(buttonX + 3, buttonY + buttonSize - 3);
        renderCtx.stroke();

        // Store button coordinates for click detection
        if (tileEditor) {
          tileEditor.setDeleteButtonCoords('Graveyards', name, buttonX, buttonY, buttonSize);
        }
      }

      renderCtx.restore();
      // Restore opacity
      renderCtx.globalAlpha = prevAlpha;
    });
  }

  // Render warps as blue outlines
  if (window.mapData.warps) {
    // Check if Warps are visible in the Objects panel
    const warpsVisible = !tileEditor || tileEditor.isObjectLayerVisible('Warps');

    Object.entries(window.mapData.warps).forEach(([name, data]: [string, any]) => {
      const x = data.position?.x || 0;
      const y = data.position?.y || 0;
      const width = data.size?.width || tilesize;
      const height = data.size?.height || tilesize;
      const isSelected = isEditorSelected(tileEditor, 'Warps', name);

      // Draw selection highlight first (behind everything)
      if (isSelected) {
        renderCtx.fillStyle = 'rgba(100, 200, 255, 0.2)';
        renderCtx.fillRect(x - 5, y - 5, width + 10, height + 10);
      }

      // Apply opacity based on visibility toggle
      const opacity = warpsVisible ? 1.0 : 0;

      // Set opacity for rendering
      const prevAlpha = renderCtx.globalAlpha;
      renderCtx.globalAlpha = opacity;

      // Draw blue outline rectangle (position is top-left corner)
      renderCtx.strokeStyle = isSelected ? 'rgba(150, 220, 255, 1)' : 'rgba(0, 150, 255, 0.8)';
      renderCtx.lineWidth = isSelected ? 3 : 2;
      renderCtx.strokeRect(x, y, width, height);

      // Draw corner markers (dark blue)
      renderCtx.fillStyle = 'rgba(50, 100, 200, 1)';
      const markerSize = isSelected ? 6 : 4;
      const corners = [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height]
      ];
      corners.forEach(([cx, cy]) => {
        renderCtx.fillRect(cx - markerSize / 2, cy - markerSize / 2, markerSize, markerSize);
      });

      // Draw edge midpoint markers only when selected
      if (isSelected) {
        const edgeMarkerSize = 5;

        // Top edge midpoint (green)
        renderCtx.fillStyle = 'rgba(100, 255, 100, 1)';
        renderCtx.fillRect(x + width / 2 - edgeMarkerSize / 2, y - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Bottom edge midpoint (green)
        renderCtx.fillStyle = 'rgba(100, 255, 100, 1)';
        renderCtx.fillRect(x + width / 2 - edgeMarkerSize / 2, y + height - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Left edge midpoint (red)
        renderCtx.fillStyle = 'rgba(255, 100, 100, 1)';
        renderCtx.fillRect(x - edgeMarkerSize / 2, y + height / 2 - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Right edge midpoint (red)
        renderCtx.fillStyle = 'rgba(255, 100, 100, 1)';
        renderCtx.fillRect(x + width - edgeMarkerSize / 2, y + height / 2 - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);
      }

      // Draw name label above the warp with background
      renderCtx.save();
      renderCtx.font = 'bold 13px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.textBaseline = 'middle';

      const textMetrics = renderCtx.measureText(name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const labelX = x + width / 2;
      const labelY = y - 12;

      // Draw background
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      renderCtx.fillRect(labelX - textWidth / 2 - 4, labelY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);

      // Draw text
      renderCtx.fillStyle = 'rgba(100, 200, 255, 1)';
      renderCtx.fillText(name, labelX, labelY);

      // Store label coordinates for click detection (convert world to screen coords)
      if (tileEditor) {
        const screenX = labelX + offsetX;
        const screenY = labelY + offsetY;
        tileEditor.setLabelCoords(name, 'Warps', screenX - textWidth / 2 - 4, screenY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
      }

      // Draw delete button at bottom right when selected
      if (isSelected) {
        const buttonSize = 16;
        const buttonX = x + width + 4;
        const buttonY = y + height + 4;

        renderCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
        renderCtx.fillRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(200, 50, 50, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.strokeRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.beginPath();
        renderCtx.moveTo(buttonX + 3, buttonY + 3);
        renderCtx.lineTo(buttonX + buttonSize - 3, buttonY + buttonSize - 3);
        renderCtx.moveTo(buttonX + buttonSize - 3, buttonY + 3);
        renderCtx.lineTo(buttonX + 3, buttonY + buttonSize - 3);
        renderCtx.stroke();

        // Store button coordinates for click detection
        if (tileEditor) {
          tileEditor.setDeleteButtonCoords('Warps', name, buttonX, buttonY, buttonSize);
        }
      }

      renderCtx.restore();
      // Restore opacity
      renderCtx.globalAlpha = prevAlpha;
    });
  }

  renderDungeonPortals(renderCtx, offsetX, offsetY, tileEditor);
  renderMapChests(renderCtx, offsetX, offsetY, tileEditor);
}

function drawObjectLabel(renderCtx: CanvasRenderingContext2D, tileEditor: any, type: string, name: string, labelX: number, labelY: number, offsetX: number, offsetY: number, color: string) {
  renderCtx.font = 'bold 13px monospace';
  renderCtx.textAlign = 'center';
  renderCtx.textBaseline = 'middle';
  const textWidth = renderCtx.measureText(name).width;
  const textHeight = 16;
  renderCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  renderCtx.fillRect(labelX - textWidth / 2 - 4, labelY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
  renderCtx.fillStyle = color;
  renderCtx.fillText(name, labelX, labelY);
  if (tileEditor) {
    tileEditor.setLabelCoords(name, type, labelX + offsetX - textWidth / 2 - 4, labelY + offsetY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
  }
}

function drawObjectDeleteButton(renderCtx: CanvasRenderingContext2D, tileEditor: any, type: string, name: string, buttonX: number, buttonY: number) {
  const buttonSize = 16;
  renderCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
  renderCtx.fillRect(buttonX, buttonY, buttonSize, buttonSize);
  renderCtx.strokeStyle = 'rgba(200, 50, 50, 1)';
  renderCtx.lineWidth = 1.5;
  renderCtx.strokeRect(buttonX, buttonY, buttonSize, buttonSize);
  renderCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
  renderCtx.beginPath();
  renderCtx.moveTo(buttonX + 3, buttonY + 3);
  renderCtx.lineTo(buttonX + buttonSize - 3, buttonY + buttonSize - 3);
  renderCtx.moveTo(buttonX + buttonSize - 3, buttonY + 3);
  renderCtx.lineTo(buttonX + 3, buttonY + buttonSize - 3);
  renderCtx.stroke();
  if (tileEditor) tileEditor.setDeleteButtonCoords(type, name, buttonX, buttonY, buttonSize);
}

function isEditorSelected(tileEditor: any, type: string, name: string): boolean {
  return !!tileEditor && tileEditor.getSelectedObject?.() === type && tileEditor.getSelectedObjectName?.() === name;
}

// Dungeon portals: rectangles like warps, in purple
function renderDungeonPortals(renderCtx: CanvasRenderingContext2D, offsetX: number, offsetY: number, tileEditor: any) {
  const portals = window.mapData?.dungeonPortals;
  if (!portals || typeof portals !== 'object') return;
  const visible = !tileEditor || tileEditor.isObjectLayerVisible('DungeonPortals');
  Object.entries(portals).forEach(([key, data]: [string, any]) => {
    const name = Array.isArray(portals) ? String(data?.name ?? key) : key;
    const x = data?.position?.x || 0;
    const y = data?.position?.y || 0;
    const width = data?.size?.width || 32;
    const height = data?.size?.height || 32;
    const isSelected = isEditorSelected(tileEditor, 'DungeonPortals', name);
    const prevAlpha = renderCtx.globalAlpha;
    renderCtx.save();
    if (isSelected) {
      renderCtx.fillStyle = 'rgba(190, 130, 255, 0.2)';
      renderCtx.fillRect(x - 5, y - 5, width + 10, height + 10);
    }
    renderCtx.globalAlpha = visible ? 1.0 : 0;
    renderCtx.strokeStyle = isSelected ? 'rgba(220, 180, 255, 1)' : 'rgba(170, 90, 255, 0.8)';
    renderCtx.lineWidth = isSelected ? 3 : 2;
    renderCtx.strokeRect(x, y, width, height);
    renderCtx.fillStyle = 'rgba(110, 50, 180, 1)';
    const markerSize = isSelected ? 6 : 4;
    [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].forEach(([cx, cy]) => {
      renderCtx.fillRect(cx - markerSize / 2, cy - markerSize / 2, markerSize, markerSize);
    });
    if (isSelected) {
      const edge = 5;
      renderCtx.fillStyle = 'rgba(100, 255, 100, 1)';
      renderCtx.fillRect(x + width / 2 - edge / 2, y - edge / 2, edge, edge);
      renderCtx.fillRect(x + width / 2 - edge / 2, y + height - edge / 2, edge, edge);
      renderCtx.fillStyle = 'rgba(255, 100, 100, 1)';
      renderCtx.fillRect(x - edge / 2, y + height / 2 - edge / 2, edge, edge);
      renderCtx.fillRect(x + width - edge / 2, y + height / 2 - edge / 2, edge, edge);
    }
    drawObjectLabel(renderCtx, tileEditor, 'DungeonPortals', name, x + width / 2, y - 12, offsetX, offsetY, 'rgba(210, 170, 255, 1)');
    if (isSelected) drawObjectDeleteButton(renderCtx, tileEditor, 'DungeonPortals', name, x + width + 4, y + height + 4);
    renderCtx.restore();
    renderCtx.globalAlpha = prevAlpha;
  });
}

// Placed chests: a small chest drawn centred on its position, like a graveyard
function renderMapChests(renderCtx: CanvasRenderingContext2D, offsetX: number, offsetY: number, tileEditor: any) {
  const chests = window.mapData?.chests;
  if (!chests || typeof chests !== 'object') return;
  const visible = !tileEditor || tileEditor.isObjectLayerVisible('Chests');
  const width = 18;
  const height = 14;
  Object.entries(chests).forEach(([key, data]: [string, any]) => {
    const name = Array.isArray(chests) ? String(data?.name ?? key) : key;
    const x = data?.position?.x || 0;
    const y = data?.position?.y || 0;
    const isSelected = isEditorSelected(tileEditor, 'Chests', name);
    const prevAlpha = renderCtx.globalAlpha;
    renderCtx.save();
    if (isSelected) {
      renderCtx.fillStyle = 'rgba(100, 200, 255, 0.3)';
      renderCtx.beginPath();
      renderCtx.arc(x, y, 25, 0, Math.PI * 2);
      renderCtx.fill();
    }
    renderCtx.globalAlpha = visible ? 1.0 : 0;
    renderCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    renderCtx.fillRect(x - width / 2 + 1, y - height / 2 + 1, width, height);
    renderCtx.fillStyle = isSelected ? 'rgba(160, 110, 60, 0.95)' : 'rgba(120, 75, 35, 0.95)';
    renderCtx.strokeStyle = isSelected ? 'rgba(230, 200, 120, 1)' : 'rgba(70, 40, 15, 1)';
    renderCtx.lineWidth = isSelected ? 2.5 : 1.5;
    renderCtx.fillRect(x - width / 2, y - height / 2, width, height);
    renderCtx.strokeRect(x - width / 2, y - height / 2, width, height);
    renderCtx.strokeStyle = 'rgba(70, 40, 15, 1)';
    renderCtx.lineWidth = 1;
    renderCtx.beginPath();
    renderCtx.moveTo(x - width / 2, y - 2);
    renderCtx.lineTo(x + width / 2, y - 2);
    renderCtx.stroke();
    renderCtx.fillStyle = 'rgba(230, 190, 80, 1)';
    renderCtx.fillRect(x - 2, y - 4, 4, 5);
    drawObjectLabel(renderCtx, tileEditor, 'Chests', name, x, y - height / 2 - 12, offsetX, offsetY, 'rgba(240, 210, 140, 1)');
    if (isSelected) drawObjectDeleteButton(renderCtx, tileEditor, 'Chests', name, x + width / 2 + 8, y + height / 2 + 8);
    renderCtx.restore();
    renderCtx.globalAlpha = prevAlpha;
  });
}

function recordChunkLoadTime(chunkKey: string) {
  if (!chunkLoadTimes.has(chunkKey)) {
    chunkLoadTimes.set(chunkKey, performance.now() / 1000);
  }
}

function renderInfiniteZone() {
  if (!ctx || !window.mapData) return;

  const tw = window.mapData.tilewidth;
  const th = window.mapData.tileheight;
  const mapWidth = window.mapData.width * tw;
  const mapHeight = window.mapData.height * th;

  let mapCenterOffsetX = 0;
  let mapCenterOffsetY = 0;
  if (mapWidth < window.innerWidth) mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
  if (mapHeight < window.innerHeight) mapCenterOffsetY = (window.innerHeight - mapHeight) / 2;

  const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
  const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  ctx.save();

  ctx.beginPath();
  ctx.rect(0, 0, vw, vh);
  const izMinTileX = Math.max(0, window.mapData.minTileX ?? 0);
  const izMinTileY = Math.max(0, window.mapData.minTileY ?? 0);
  ctx.rect(offsetX + izMinTileX * tw, offsetY + izMinTileY * th, mapWidth - izMinTileX * tw, mapHeight - izMinTileY * th);
  ctx.clip('evenodd');

  // The canvas is already cleared to black; draw a faint tile grid over it.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const worldLeft = -offsetX;
  const worldTop = -offsetY;
  const startCol = Math.floor(worldLeft / tw);
  const endCol = Math.ceil((worldLeft + vw) / tw);
  const startRow = Math.floor(worldTop / th);
  const endRow = Math.ceil((worldTop + vh) / th);

  for (let c = startCol; c <= endCol; c++) {
    const sx = c * tw + offsetX;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, vh);
  }
  for (let r = startRow; r <= endRow; r++) {
    const sy = r * th + offsetY;
    ctx.moveTo(0, sy);
    ctx.lineTo(vw, sy);
  }
  ctx.stroke();

  ctx.restore();
}

if (MOBILE_RENDERER) {
  setShadowMaxOffsetMobile(SHADOW_MAX_OFFSET);
} else {
  setShadowMaxOffset(SHADOW_MAX_OFFSET);
}

function spriteOccluder(anim: any, staticImage: HTMLImageElement | null | undefined, cx: number, cy: number,
  scale: number): [number, number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let frameHeight = 0;
  const add = (width: number, height: number, ox: number, oy: number) => {
    const x = cx - (width * scale) / 2 + ox * scale;
    const y = cy - (height * scale) / 2 + oy * scale;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width * scale);
    maxY = Math.max(maxY, y + height * scale);
    frameHeight = Math.max(frameHeight, height * scale);
  };
  if (anim?.layers) {
    for (const layer of Object.values(anim.layers) as any[]) {
      if (!layer?.visible || !layer.frames?.length) continue;
      const frame = layer.frames[layer.currentFrame];
      if (frame?.width && frame?.height) add(frame.width, frame.height, frame.offset?.x || 0, frame.offset?.y || 0);
    }
  }
  if (minX === Infinity && staticImage?.naturalWidth) add(staticImage.width, staticImage.height, 0, 0);
  if (minX === Infinity) add(64, 64, 0, 0);
  return [minX, minY, maxX, maxY, cy + frameHeight * FEET_FRACTION];
}

function collectOccluders(): Array<[number, number, number, number, number]> {
  const margin = 256;
  const halfW = window.innerWidth / 2 + margin;
  const halfH = window.innerHeight / 2 + margin;
  const inView = (x: number, y: number) => Math.abs(x - cameraX) <= halfW && Math.abs(y - cameraY) <= halfH;
  const found: Array<{ box: [number, number, number, number, number]; d: number }> = [];
  const push = (box: [number, number, number, number, number], x: number, y: number) => {
    found.push({ box, d: (x - cameraX) ** 2 + (y - cameraY) ** 2 });
  };

  const players = cache.players instanceof Map ? cache.players.values() : cache.players;
  for (const p of players as Iterable<any>) {
    const x = p.renderPosition?.x ?? p.position?.x;
    const y = p.renderPosition?.y ?? p.position?.y;
    if (x === undefined || y === undefined || !inView(x, y)) continue;
    const box = spriteOccluder(p.layeredAnimation, null, x, y, 1);
    // The nameplate under the feet sorts with the player: covered by whatever covers them.
    const plate = p.nameplate;
    if (plate) {
      box[0] = Math.min(box[0], x - plate.left);
      box[2] = Math.max(box[2], x + plate.right);
      box[3] = Math.max(box[3], y + plate.bottom);
    }
    push(box, x, y);
  }
  for (const npc of cache.npcs as any[]) {
    const x = npc.position?.x;
    const y = npc.position?.y;
    if (npc.hidden || x === undefined || y === undefined || !inView(x, y)) continue;
    push(spriteOccluder(npc.layeredAnimation, npc.staticImage, x, y, 1), x, y);
  }
  for (const c of creatures.values()) {
    // Corpses lie flat on the ground.
    if (c.state === "dead" || !inView(c.renderX, c.renderY)) continue;
    push(spriteOccluder(c.anim, c.staticImage, c.renderX, c.renderY, c.scale > 0 ? c.scale : 1), c.renderX, c.renderY);
  }

  found.sort((a, b) => a.d - b.d);
  return found.map((f) => f.box);
}

function renderMap(phase: 'below' | 'above' = 'below', targetCtx: CanvasRenderingContext2D | null = ctx) {
  if (!targetCtx || !window.mapData) return;

  // Calculate map size in pixels
  const mapWidth = window.mapData.width * window.mapData.tilewidth;
  const mapHeight = window.mapData.height * window.mapData.tileheight;

  const { x: offsetX, y: offsetY } = worldOffset(smoothMapX, smoothMapY);

  const tileEditor = (window as any).tileEditor;
  const isEditorActive = !!tileEditor?.isActive;

  const clipMinX = (window.mapData.minTileX ?? 0) * window.mapData.tilewidth;
  const clipMinY = (window.mapData.minTileY ?? 0) * window.mapData.tileheight;

  let shadow: { offsetX: number; offsetY: number; alpha: number } | null = null;
  if (getWeatherType() !== "thunderstorm" && getWeatherType() !== "darkness") {
    const params = getShadowParams();
    if (params.alpha >= 0.005) shadow = params;
  }

  const nowSeconds = performance.now() / 1000;

  if (MOBILE_RENDERER) {
    // Mobile: glmap-mobile renders into its own page canvases (#map-below /
    // #map-above) placed under targetCtx's canvas instead of copying into it.
    renderMapPassMobile({
      phase,
      target: targetCtx,
      offsetX,
      offsetY,
      visibleChunks: getVisibleChunksCached(),
      cuts: window.mapData.layerCuts || [],
      clip: { minX: clipMinX, minY: clipMinY, maxX: mapWidth, maxY: mapHeight },
      shadow,
      chunkAlpha: (chunkKey: string) => {
        const loadTime = chunkLoadTimes.get(chunkKey);
        if (loadTime === undefined || isEditorActive) return 1;
        return Math.min((nowSeconds - loadTime) / CHUNK_FADE_DURATION, 1);
      },
      isLayerVisible: isEditorActive ? (name: string) => tileEditor.isLayerVisible(name) : null,
      occluders: collectOccluders(),
      now: performance.now(),
    });
    return;
  }

  renderMapPass({
    phase,
    target: targetCtx,
    offsetX,
    offsetY,
    visibleChunks: getVisibleChunksCached(),
    cuts: window.mapData.layerCuts || [],
    clip: { minX: clipMinX, minY: clipMinY, maxX: mapWidth, maxY: mapHeight },
    shadow,
    chunkAlpha: (chunkKey: string) => {
      // Fade-in based on chunk load time.
      const loadTime = chunkLoadTimes.get(chunkKey);
      if (loadTime === undefined || isEditorActive) return 1;
      return Math.min((nowSeconds - loadTime) / CHUNK_FADE_DURATION, 1);
    },
    isLayerVisible: isEditorActive ? (name: string) => tileEditor.isLayerVisible(name) : null,
    occluders: collectOccluders(),
    now: performance.now(),
  });
}

function renderGroundAoeZones(ctx: CanvasRenderingContext2D, deltaTime: number) {
  const now = performance.now();
  const mouseX = (window as any).mouseWorldX;
  const mouseY = (window as any).mouseWorldY;

  // Render ground targeting cursor
  if (cache.groundTargetingSpell) {
    const spellData = cache.spells[cache.groundTargetingSpell];
    const radius = (spellData && spellData.aoe_radius) || 100;
    const spellRange = (spellData && spellData.range) || 800;

    if (mouseX !== undefined && mouseY !== undefined && radius > 0) {
      const currentPlayer = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
      let outOfRange = false;
      if (currentPlayer && spellRange > 0) {
        const px = currentPlayer.position?.x ?? currentPlayer.renderPosition?.x ?? 0;
        const py = currentPlayer.position?.y ?? currentPlayer.renderPosition?.y ?? 0;
        const dist = Math.sqrt((mouseX - px) ** 2 + (mouseY - py) ** 2);
        outOfRange = dist > spellRange;
      }

      const pulse = 0.6 + 0.4 * Math.sin(now * 0.005);
      const isHeal = spellData?.damage < 0;

      ctx.save();
      ctx.lineWidth = 3;

      // Outer glow
      ctx.globalAlpha = 0.15 * pulse;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, radius + 8, 0, Math.PI * 2);
      if (outOfRange) {
        ctx.fillStyle = 'rgba(255, 40, 40, 0.15)';
        ctx.strokeStyle = 'rgba(255, 40, 40, 0.3)';
      } else if (isHeal) {
        ctx.fillStyle = 'rgba(80, 255, 80, 0.15)';
        ctx.strokeStyle = 'rgba(80, 255, 80, 0.3)';
      } else {
        ctx.fillStyle = 'rgba(255, 140, 20, 0.15)';
        ctx.strokeStyle = 'rgba(255, 140, 20, 0.3)';
      }
      ctx.fill();
      ctx.stroke();

      // Main circle fill
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, radius, 0, Math.PI * 2);
      if (outOfRange) {
        ctx.fillStyle = 'rgba(255, 30, 30, 0.25)';
      } else if (isHeal) {
        ctx.fillStyle = 'rgba(80, 255, 80, 0.2)';
      } else {
        ctx.fillStyle = 'rgba(255, 140, 20, 0.25)';
      }
      ctx.fill();

      // Main circle stroke
      ctx.globalAlpha = pulse * 0.9;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, radius, 0, Math.PI * 2);
      if (outOfRange) {
        ctx.strokeStyle = 'rgba(255, 40, 40, 0.9)';
      } else if (isHeal) {
        ctx.strokeStyle = 'rgba(80, 255, 80, 0.8)';
      } else {
        ctx.strokeStyle = 'rgba(255, 150, 30, 0.85)';
      }
      ctx.stroke();

      // Dashed range indicator when targeting
      ctx.globalAlpha = 0.2;
      ctx.setLineDash([6, 12]);
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, radius, 0, Math.PI * 2);
      if (outOfRange) {
        ctx.strokeStyle = 'rgba(255, 40, 40, 0.5)';
      } else {
        ctx.strokeStyle = 'rgba(255, 150, 30, 0.35)';
      }
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // Render casting previews (half-transparent)
  for (const casterId in cache.groundAoeCastingPreviews) {
    const preview = cache.groundAoeCastingPreviews[casterId];
    if (!preview || !preview.radius) continue;

    // Filled circle with half transparency (0.35)
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(preview.x, preview.y, preview.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220, 150, 40, 0.4)';
    ctx.fill();
    ctx.lineWidth = 2;
    const pulse = 0.6 + 0.2 * Math.sin(now * 0.004);
    ctx.strokeStyle = `rgba(220, 150, 40, ${pulse})`;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Render active ground AoE zones (full opacity)
  for (const zoneId in cache.activeGroundAoeZones) {
    const zone = cache.activeGroundAoeZones[zoneId];
    if (!zone || !zone.radius) continue;

    const elapsed = (now - zone.createdAt) / 1000;
    const remaining = Math.max(0, zone.duration - elapsed);
    const progress = zone.duration > 0 ? remaining / zone.duration : 1;

    const isHeal = zone.damageType === 'heal';
    const baseColor = isHeal ? [80, 220, 80] : [220, 80, 40];

    // Filled circle with edge fade
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.25)`;
    ctx.fill();

    // Gradient fill for depth
    const gradient = ctx.createRadialGradient(zone.x, zone.y, zone.radius * 0.3, zone.x, zone.y, zone.radius);
    gradient.addColorStop(0, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.05)`);
    gradient.addColorStop(0.6, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.15)`);
    gradient.addColorStop(1, `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.3)`);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Pulsing border
    const borderPulse = 0.6 + 0.4 * Math.sin(now * 0.003 + zoneId.charCodeAt(0));
    ctx.globalAlpha = borderPulse * (0.5 + 0.3 * progress);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, ${borderPulse})`;
    ctx.stroke();

    // Fade the zone as it expires (last 20% of duration)
    if (progress < 0.2) {
      ctx.globalAlpha = progress / 0.2;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, 0.1)`;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

let frameAsked = false;
let animationFrameAt = 0;
/** This long with no animation frame, and the browser has stopped giving them. */
const ANIMATION_FRAMES_GONE_MS = 150;

function askFrame() {
  if (frameAsked) return;
  frameAsked = true;
  requestAnimationFrame(() => {
    frameAsked = false;
    animationFrameAt = performance.now();
    animationLoop();
  });
}

/** The ground in view has come from the server. */
function viewLoaded(): boolean {
  const loaded = window.mapData?.loadedChunks;
  return !!loaded && getVisibleChunksCached().every(chunk => loaded.has(`${chunk.x}-${chunk.y}`));
}

function animationLoop() {
  if (!ctx) return;
  globalFrameId++;

  const fpsTarget = parseFloat(fpsSlider.value);
  const uncapped = fpsTarget >= 240;
  const frameDuration = 1000 / fpsTarget;
  const now = performance.now();
  let deltaTime = (now - lastFrameTime) / 1000;

  const maxDeltaTime = (frameDuration * 30) / 1000;
  if (deltaTime > maxDeltaTime) {
    deltaTime = maxDeltaTime;
  }

  // Learn the display's refresh interval from rAF itself.
  const rafDelta = now - lastRafTime;
  lastRafTime = now;
  if (rafDelta > 2 && rafDelta < 100) rafInterval += (rafDelta - rafInterval) * 0.05;

  if (!uncapped) {
    const stride = Math.max(1, Math.round(frameDuration / rafInterval));
    if (++rafsSinceRender < stride) {
      askFrame();
      return;
    }
  }
  rafsSinceRender = 0;

  lastFrameTime = now;

  const playersArray = Array.from(cache.players instanceof Map ? cache.players.values() : cache.players);
  const currentPlayer = playersArray.find(player => player.id === cachedPlayerId);
  if (!currentPlayer) {
    askFrame();
    return;
  }

  const px = currentPlayer.position?.x ?? currentPlayer.renderPosition?.x ?? 0;
  const py = currentPlayer.position?.y ?? currentPlayer.renderPosition?.y ?? 0;
  const playerMap = currentPlayer.map || currentPlayer.location?.map || "";
  (window as any).updateLootPickup?.(px, py, playerMap);
  (window as any).updateChestInteraction?.(px, py, playerMap);
  (window as any).updateNpcInteraction?.(px, py, playerMap);
  (window as any).updateQuestFrameProximity?.(px, py);
  (window as any).updateVendorProximity?.(px, py);
  (window as any).updateMailProximity?.(px, py);
  updateCreatureLootProximity(px, py);
  // footsteps: the sound of the tile under the player's feet, a step at a time while walking
  updateTileSounds(currentPlayer);

  for (const npc of cache.npcs) {
    if ((npc as any).layeredAnimation) {
      updateLayeredAnimation((npc as any).layeredAnimation, deltaTime);
    }
    // Gossip chains rotate dialog on player-chat timing.
    tickNpcGossip(npc);
  }

  if (cache.players instanceof Map) {
    animationManager.updateAllPlayers(cache.players, deltaTime, cachedPlayerId);
    cache.players.forEach((player: any) => {
      updateRemotePlayerInterpolation(player, deltaTime);
    });
  } else if (cache.players instanceof Set) {

    const playersMap = new Map<string, any>();
    for (const player of cache.players) {
      if (player && player.id) {
        playersMap.set(player.id, player);
        updateRemotePlayerInterpolation(player, deltaTime);
      }
    }
    animationManager.updateAllPlayers(playersMap, deltaTime, cachedPlayerId);
  }

  if (!cameraInitialized && window.mapData) {
    const initialX = window.mapData.spawnX || currentPlayer.position.x;
    const initialY = window.mapData.spawnY || currentPlayer.position.y;
    cameraX = initialX;
    cameraY = initialY;
    smoothMapX = initialX;
    smoothMapY = initialY;
    cameraInitialized = true;
  }

  if (currentPlayer && getHandoffGap() && !isSelfDead() && document.activeElement !== chatInput && document.activeElement !== friendsListSearch) {
    const walked = currentPlayer.moveSamples;
    const newest = walked?.[walked.length - 1];
    // The keys as held: a change after the gap report is sent to the new node, which walks it the same (socket.ts noteGapFrame).
    const direction = gapDirection(pressedKeys, getStickDirection());
    // A node that walks the reported gap takes the first step as walked, in any direction (gapStepMs).
    const reports = getGapReports();
    const walkedOn = direction !== "" && (reports || direction === getWalkAtSwitch());
    const started = currentPlayer.handoffWalk !== undefined || (reports && gapWalkStarted());
    const stepMs = gapStepMs(deltaTime * 1000, started, now, newest, getLateness(), walkedOn);
    // A turn or a key let go first walks the walk going on to the end of its tick, where the node ends it (socket.ts finishGapWalk).
    const finished = finishGapWalk(direction);
    if (finished) advanceSelf(currentPlayer, finished.walk, finished.ms, window.mapData);
    // The keys held walk only the part of the frame a finish did not already walk (socket.ts gapFrameMs).
    const walkMs = gapFrameMs(stepMs);
    // Counted from the last echo's time, the time gapStepMs measures the first step from.
    noteGapFrame(direction, direction ? walkMs : 0, now, newest && !newest.predicted ? newest.t + Math.max(0, getLateness()) : null);
    advanceSelf(currentPlayer, direction, walkMs, window.mapData);
    // Posed as the node will pose the walk it reports: a key let go stands the player, a turn faces the new way (gappose.ts).
    const pose = reports && currentPlayer.layeredAnimation ? gapPose(currentPlayer.layeredAnimation.currentAnimationName, direction) : null;
    if (pose) {
      currentPlayer.lastDirection = pose.slice(pose.indexOf("_") + 1);
      currentPlayer.animation = null;
      void changeLayeredAnimation(currentPlayer.layeredAnimation, pose);
    }
  }

  smoothPlayerRenderPositions(playersArray, now);

  // Who is going into or coming out of a portal: drawn walking on into it, or out of it (portaltransit.ts). Seen before
  // the camera, which keeps with the local player along such a walk.
  const transitNow = performance.now();
  observeTransit(playersArray, transitNow);
  prepareLanding(transitNow);

  tickCutscene(now);
  // (the zoom this frame is drawn at: the camera keeps a map's edges in place while the zoom eases)
  stepWorldZoom(now);
  updateCamera(currentPlayer, deltaTime * 60, currentPlayer?.renderPosition ? transit.cameraAt(transitNow, currentPlayer.renderPosition) : undefined);

  (window as any).cameraX = cameraX;
  (window as any).cameraY = cameraY;

  // The keys held through a portal do not walk until let go (portaltransit.ts HeldKeys): the far side is stood on,
  // facing down, not walked straight back up into the portal. Seen every frame, so a key let go is let go.
  if (transit.warps !== heldWarps) {
    heldWarps = transit.warps;
    heldThroughWarp.hold(pressedKeys, !!getStickDirection());
  }
  const walkKeys = heldThroughWarp.free(pressedKeys);

  if (!getMovementAllowed()) lastDirection = "";

  // Arriving on a new map stops a walk still going, unless a movement key or the stick is held (mapstop.ts).
  const moveKeyHeld = ["KeyW", "KeyA", "KeyS", "KeyD"].some((k) => pressedKeys.has(k));
  if (stopAfterMapLoad.due(getMovementAllowed(), moveKeyHeld, !!getStickDirection())) {
    sendRequest({ type: "MOVEXY", data: "ABORT" });
    setIsMoving(false);
    lastDirection = "";
  }

  if (getMovementAllowed() && getIsMoving() && getIsKeyPressed() && !isSelfDead()) {
    if (document.activeElement === chatInput || document.activeElement === friendsListSearch) {
      setIsMoving(false);
      lastDirection = "";
      return;
    }

    const keys = walkKeys;
    let dir = "";
    if (keys.has("KeyW") && keys.has("KeyA")) dir = "UPLEFT";
    else if (keys.has("KeyW") && keys.has("KeyD")) dir = "UPRIGHT";
    else if (keys.has("KeyS") && keys.has("KeyA")) dir = "DOWNLEFT";
    else if (keys.has("KeyS") && keys.has("KeyD")) dir = "DOWNRIGHT";
    else if (keys.has("KeyW")) dir = "UP";
    else if (keys.has("KeyS")) dir = "DOWN";
    else if (keys.has("KeyA")) dir = "LEFT";
    else if (keys.has("KeyD")) dir = "RIGHT";
    if (dir && dir !== lastDirection) {
      sendRequest({ type: "MOVEXY", data: dir });
      lastDirection = dir;
      stopAfterMapLoad.walked();
    }
  } else if (getIsMoving() && !getIsKeyPressed()) {
    if (lastDirection !== "") sendRequest({ type: "MOVEXY", data: "ABORT" });
    setIsMoving(false);
    lastDirection = "";
  }

  chunkLoadThrottle++;
  if (chunkLoadThrottle >= 5) {
    loadVisibleChunks();
    chunkLoadThrottle = 0;
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!MOBILE_RENDERER) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
  applyWorldTransform(ctx, now);
  ctx.imageSmoothingEnabled = false;

  const viewportLeft = cameraX - window.innerWidth / 2;
  const viewportTop = cameraY - window.innerHeight / 2;
  const viewportRight = cameraX + window.innerWidth / 2;
  const viewportBottom = cameraY + window.innerHeight / 2;
  const padding = 256;

  const isInView = (x: number, y: number) =>
    x >= viewportLeft - padding &&
    y >= viewportTop - padding &&
    x <= viewportRight + padding &&
    y <= viewportBottom + padding;

  const visiblePlayers = playersArray.filter(p => {
    const inView = isInView(p.position.x, p.position.y);
    if (!inView) return false;
    if (cutsceneHidesPlayer(p.id === cachedPlayerId)) return false;
    // Own corpse stays visible; everyone else's despawns (no admin bypass).
    if (p.id === cachedPlayerId) {
      if (isReleaseHidden()) return false;
      return true;
    }
    if (p.isDead) return false;
    // Ghosts pending teleport render only once their spawn confirm lands.
    if (p.isGhost && p.ghostTeleportPending) return false;
    if (p.isStealth) return currentPlayer.isAdmin;
    return true;
  });

  if (currentPlayer) {
    const { health, total_max_health, stamina, total_max_stamina, absorbtion } = currentPlayer.stats;
    const healthPercent = (health / total_max_health) * 100;
    const staminaPercent = (stamina / total_max_stamina) * 100;
    updateHealthBar(healthBar, healthPercent);
    updateStaminaBar(staminaBar, staminaPercent);
    updateAbsorptionBar(absorbtion || 0, total_max_health);
    // A target that has wandered (or been left) too far away is dropped.
    dropDistantTarget(currentPlayer);
    updateUnitFrames(currentPlayer);
  }

  const visibleNpcs = cache.npcs.filter(npc =>
    isInView(npc.position.x, npc.position.y)
  );

  // Collect particles by zIndex before rendering
  const particlesByLayer = new Map<number, Array<{
    particle: any;
    source: any;
    sourceType: 'npc' | 'effect';
  }>>();

  for (const npc of visibleNpcs) {
    if (npc.particles) {
      for (const particle of npc.particles) {
        if (particle.visible) {
          const zIndex = particle.zIndex || 0;
          if (!particlesByLayer.has(zIndex)) {
            particlesByLayer.set(zIndex, []);
          }
          particlesByLayer.get(zIndex)!.push({
            particle,
            source: npc,
            sourceType: 'npc'
          });
        }
      }
    }
  }

  for (const p of visiblePlayers) {
    const effects = p.activeEffects?.filter((e: any) => e.endTime > Date.now()) || [];
    const allParticles: any[] = [];
    for (const effect of effects) {
      if (Array.isArray(effect.particles)) {
        for (const pd of effect.particles) allParticles.push(pd);
      }
    }
    if (allParticles.length === 0) continue;

    if (!(p as any)._fxWrapper) {
      (p as any)._fxWrapper = {
        position: { x: 0, y: 0 },
        particleArrays: {} as Record<string, any[]>,
        lastEmitTime: {} as Record<string, number>,
        particles: [] as any[],
        updateParticle: updateSourceParticle,
      };
    }
    const wrap = (p as any)._fxWrapper;
    wrap.position.x = p.renderPosition.x;
    wrap.position.y = p.renderPosition.y;
    wrap.particles = allParticles;

    for (const particleDef of allParticles) {
      const zIndex = particleDef.zIndex || 3;
      if (!particlesByLayer.has(zIndex)) {
        particlesByLayer.set(zIndex, []);
      }
      particlesByLayer.get(zIndex)!.push({
        particle: particleDef,
        source: wrap,
        sourceType: 'effect',
      });
    }
  }

  // Mobile: the map surfaces are page canvases, so hide them in wireframe mode.
  if (MOBILE_RENDERER) setMapVisibleMobile(!wireframeDebugCheckbox.checked);
  if (!wireframeDebugCheckbox.checked) {
    if ((window as any).tileEditor?.isActive && window.mapData?.infinite) {
      renderInfiniteZone();
    }
    renderMap('below');
  }

  const { x: offsetX, y: offsetY } = worldOffset(smoothMapX, smoothMapY);
  // the canvas's base transform (dpr, and on touch devices the 0.85 zoom: events.ts resizeGameCanvas), for the light map
  const baseTransform = ctx.getTransform();
  ctx.save();
  ctx.translate(offsetX, offsetY);

  ctx.imageSmoothingEnabled = false;

  // Render particles with zIndex < 3 (lower layers) before NPCs
  if (!wireframeDebugCheckbox.checked) {
    const lowerZIndices = Array.from(particlesByLayer.keys())
      .filter(z => z < 3)
      .sort((a, b) => a - b);

    for (const zIdx of lowerZIndices) {
      const particlesAtLayer = particlesByLayer.get(zIdx);
      if (particlesAtLayer) {
        for (const { particle, source } of particlesAtLayer) {
          source.updateParticle(particle, source, ctx, deltaTime);
        }
      }
    }
  }

  renderGroundAoeZones(ctx, deltaTime);
  renderDungeonPortalGround(ctx, performance.now());

  renderSkeletons(ctx);
  // Footprints lie on the ground, under every character and under the water's waves (footprints.ts)
  renderFootprints(ctx, playersArray);
  renderFishing(ctx, deltaTime, playersArray);
    tickDeathOffer();
    tickReleaseCinematic();
    tickCorpseMarker();
    tickDeathWisps();
    tickGraveyardOffer();

  const npcEditor = (window as any).npcEditor;

  if (wireframeDebugCheckbox.checked) {

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 2;

    for (const p of visiblePlayers) {
      const width = 24;
      const height = 40;
      const x = p.position.x - width / 2;
      const y = p.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.username || 'Player', p.position.x, y - 5);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    }

    ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
    ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';

    for (const npc of visibleNpcs) {
      const width = 32;
      const height = 48;
      const x = npc.position.x - width / 2;
      const y = npc.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(npc.name || 'NPC', npc.position.x, y - 5);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
    }
  } else {

    if (ghostCanvas && ghostCtx) {
      if (ghostCanvas.width !== canvas.width || ghostCanvas.height !== canvas.height) {
        ghostCanvas.width = canvas.width;
        ghostCanvas.height = canvas.height;
        ghostCanvas.style.width = canvas.style.width;
        ghostCanvas.style.height = canvas.style.height;
      }
      ghostCtx.setTransform(1, 0, 0, 1, 0, 0);
      ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
      ghostCtx.setTransform(ctx.getTransform());
      ghostCtx.imageSmoothingEnabled = false;
    }

    // Chests lie on the ground, under everyone standing.
    (window as any).renderLootChests?.(ctx, cameraX, cameraY, cachedPlayerId);

    const targetedCreature = parseCreatureTarget(cache.targetId);
    const standing: Standing[] = [];
    // Those walking through a portal whose feet are past its plane: drawn in its opening, on its picture (portalfx.ts).
    const through: PortalWalker[] = [];
    const scene = ctx;
    for (const npc of visibleNpcs) {
      standing.push({
        feet: spriteOccluder((npc as any).layeredAnimation, (npc as any).staticImage, npc.position.x, npc.position.y, 1)[4],
        x: npc.position.x,
        draw: (into = scene) => npc.show(into),
      });
    }
    for (const p of visiblePlayers) {
      const ghost = p.isGhost && ghostCtx ? ghostCtx : null;
      // On a walk out of a portal they are drawn along it, and not at all until past its plane; gone into one, not here.
      const at = transit.drawnAt(String(p.id), transitNow, p.renderPosition);
      if (!at) continue;
      const out = transit.walkOutOf(String(p.id));
      if (out && at.y + PLAYER_FEET < out.foot) {
        through.push({ portal: out.portal, anim: p.layeredAnimation, x: at.x, y: at.y });
        continue;
      }
      const walked = at !== p.renderPosition;
      standing.push({
        feet: at.y + PLAYER_FEET,
        own: p.id === cachedPlayerId,
        x: at.x,
        draw: (into = scene) => walked ? showAt(p, at.x, at.y, ghost ?? into, currentPlayer) : p.show(ghost ?? into, currentPlayer),
      });
    }
    // Those walking on into a portal, each where that walk is now, in front of its arch until they pass its plane,
    // then in its opening, walking up into it. One who has left the world is still animated here.
    for (const gone of transit.walkersAt(transitNow)) {
      const p = gone.ref;
      if (!p?.show || !isInView(gone.x, gone.y)) continue;
      steerWalkInPose(p, gone.walk, changeLayeredAnimation);
      // The walk out's poses are built while the walk in goes on, to be drawn from its first step (layerswitch.ts).
      warmPoses(p.layeredAnimation, ["walk_down", "idle_down"]);
      if (p.layeredAnimation && !playersArray.includes(p)) updateLayeredAnimation(p.layeredAnimation, deltaTime);
      if (gone.y + PLAYER_FEET < gone.foot) {
        through.push({ portal: gone.portal, anim: p.layeredAnimation, x: gone.x, y: gone.y });
        continue;
      }
      const ghost = p.isGhost && ghostCtx ? ghostCtx : null;
      standing.push({
        feet: gone.y + PLAYER_FEET,
        own: p.id === cachedPlayerId,
        x: gone.x,
        draw: (into = scene) => showAt(p, gone.x, gone.y, ghost ?? into, currentPlayer),
      });
    }
    // The local player between their walk in and their walk out, standing on the portal's plane, never gone.
    const waiting = transit.waitingAt(transitNow);
    if (waiting?.ref?.show && isInView(waiting.x, waiting.y)) {
      const p = waiting.ref;
      steerWaitPose(p, waiting.key, waiting.pose, changeLayeredAnimation);
      if (p.layeredAnimation && !playersArray.includes(p)) updateLayeredAnimation(p.layeredAnimation, deltaTime);
      const ghost = p.isGhost && ghostCtx ? ghostCtx : null;
      standing.push({
        feet: waiting.y + PLAYER_FEET,
        own: true,
        x: waiting.x,
        draw: (into = scene) => showAt(p, waiting.x, waiting.y, ghost ?? into, currentPlayer),
      });
    }
    for (const c of stepCreatures(isInView)) {
      if (cutsceneHidesCreatures()) continue;
      if (c.state === "dead") drawCreature(scene, c, c.id === targetedCreature);
      else standing.push({ feet: creatureFeetY(c), x: c.renderX, draw: (into = scene) => drawCreature(into, c, c.id === targetedCreature) });
    }
    // Mailboxes stand among them, at their foot.
    for (const box of (window as any).mailboxesHere?.(String(window.mapData?.name ?? "")) ?? []) {
      standing.push({ feet: box.y, draw: (into = scene) => (window as any).drawMailbox?.(into, box) });
    }
    // Summoning stones stand among them, at their foot; the shadows they cast lie on the ground, under everyone standing.
    drawStoneShadows(scene);
    for (const stone of standingStones()) standing.push({ feet: stone.feet, prop: true, draw: (into = scene) => stone.draw(into) });
    // Gathering nodes stand among them too, with the gathering editor's preview spots.
    for (const node of standingGatherNodes()) standing.push({ feet: node.feet, draw: (into = scene) => node.draw(into) });
    // Dungeon portals stand among them, at their foot.
    setPortalWalkers(through, transit.travellers());
    for (const portal of standingDungeonPortals(scene, performance.now())) standing.push(portal);
    stepTornadoes(deltaTime, smoothMapX, smoothMapY);
    if (!MOBILE_RENDERER && aboveCtx) {
      for (const twister of standingTornadoes()) standing.push({ feet: twister.feet, draw: (into = scene) => twister.draw(into) });
    }
    for (const character of backToFront(standing)) drawStanding(scene, character);

    drawFloatingTexts(ctx, (playerId) => {
      const p = playersArray.find((pl: any) => pl.id === playerId);
      return p ? { x: p.renderPosition?.x ?? p.position.x, y: (p.renderPosition?.y ?? p.position.y) - 10 } : null;
    });

    renderCreatureEditorOverlays(ctx, String(window.mapData?.name ?? "").replace(".json", ""));
    renderGatherPreviewArea(ctx);

    renderLoot(ctx, cameraX, cameraY, canvas.width, canvas.height, cachedPlayerId);

    const now = performance.now();
    for (let i = cache.projectiles.length - 1; i >= 0; i--) {
      const projectile = cache.projectiles[i];
      const elapsed = now - projectile.startTime;
      const progress = Math.min(elapsed / projectile.duration, 1);

      let endX: number;
      let endY: number;

      if ((projectile as any).isThrown) {
        endX = projectile.targetPos ? projectile.targetPos.x : projectile.currentX;
        endY = projectile.targetPos ? projectile.targetPos.y : projectile.currentY;
      } else {
        // Target is a player or a creature; follow whichever is still there.
        const creaturePos = creaturePositionFor(projectile.targetPlayerId);
        const targetPlayer = creaturePos ? null : playersArray.find(p => p.id === projectile.targetPlayerId);
        const end = creaturePos ?? targetPlayer?.position;
        if (!end) {
          cache.projectiles.splice(i, 1);
          continue;
        }
        endX = end.x;
        endY = end.y;
      }

      projectile.currentX = projectile.startX + (endX - projectile.startX) * progress;
      projectile.currentY = projectile.startY + (endY - projectile.startY) * progress;

      let arcHeight = 0;
      let shadowX = projectile.currentX;
      let shadowY = projectile.currentY;
      if ((projectile as any).isThrown) {
        arcHeight = 80 * 4 * progress * (1 - progress);
        shadowX = projectile.startX + (endX - projectile.startX) * progress;
        shadowY = projectile.startY + (endY - projectile.startY) * progress;
        projectile.currentY = shadowY - arcHeight;
      }

      // --- Render shadow for thrown projectiles ---
      if ((projectile as any).isThrown && arcHeight > 0) {
        ctx.save();
        const shadowScale = 1 - (arcHeight / 80) * 0.5;
        const shadowAlpha = 0.1 + (arcHeight / 80) * 0.25;
        ctx.globalAlpha = shadowAlpha;
        ctx.beginPath();
        ctx.ellipse(shadowX, shadowY, 8 * shadowScale, 4 * shadowScale, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // --- Emit and update projectile trail particles ---
      const particles = projectile.particles as any[] | undefined;
      if (particles && particles.length > 0) {
        if (!projectile.particleArrays) projectile.particleArrays = {};
        const dtSec = Math.min(deltaTime, 0.1);

        if (!(projectile as any)._lastSpawnX) {
          (projectile as any)._lastSpawnX = projectile.startX;
          (projectile as any)._lastSpawnY = projectile.startY;
        }
        const lastSpawnX = (projectile as any)._lastSpawnX;
        const lastSpawnY = (projectile as any)._lastSpawnY;
        const dsx = projectile.currentX - lastSpawnX;
        const dsy = projectile.currentY - lastSpawnY;
        (projectile as any)._lastSpawnX = projectile.currentX;
        (projectile as any)._lastSpawnY = projectile.currentY;

        for (const particleDef of particles) {
          const name = particleDef.name || '';
          const amount = Math.max(Number(particleDef.amount) || 1, 1);
          const staggerTime = Math.max(Number(particleDef.staggertime) || 0, 0);

          for (let a = 0; a < amount; a++) {
            const t = amount > 1 ? a / (amount - 1) : 0.5;
            const spawnWX = lastSpawnX + dsx * t;
            const spawnWY = lastSpawnY + dsy * t;

            const p = particlePool.acquire();
            const life = (Number(particleDef.lifetime) || 1000) + staggerTime * a;
            p.currentLife = life;
            p.lifetime = life;
            p.size = Number(particleDef.size) || 5;
            p.color = particleDef.color || '#ffffff';
            p.opacity = Number(particleDef.opacity) || 1;
            p.gravity = particleDef.gravity ? { x: Number(particleDef.gravity.x || 0), y: Number(particleDef.gravity.y || 0) } : { x: 0, y: 0 };
            p.velocity = particleDef.velocity ? { x: Number(particleDef.velocity.x || 0), y: Number(particleDef.velocity.y || 0) } : { x: 0, y: 0 };
            // Spread applies around the spawn point
            const spreadX = (Math.random() - 0.5) * (Number(particleDef.spread?.x) || 0);
            const spreadY = (Math.random() - 0.5) * (Number(particleDef.spread?.y) || 0);
            p.worldX = spawnWX + spreadX;
            p.worldY = spawnWY + spreadY;
            p.glow_intensity = Number(particleDef.glow_intensity) || 0;

            if (!(projectile.particleArrays as Record<string, any[]>)[name]) {
              (projectile.particleArrays as Record<string, any[]>)[name] = [];
            }
            (projectile.particleArrays as Record<string, any[]>)[name].push(p);
          }
        }

        // Update and render existing particles (absolute world positions, trail)
        for (const name of Object.keys(projectile.particleArrays)) {
          const arr = (projectile.particleArrays as Record<string, any[]>)[name];
          const particleDef = particles.find((d: any) => d.name === name);
          if (!particleDef) continue;

          const gravX = Number(particleDef.gravity?.x || 0);
          const gravY = Number(particleDef.gravity?.y || 0);
  const baseColor = particleDef.color || 'white';
          const baseOpacity = Number(particleDef.opacity) || 1;
          const glowIntensity = Number(particleDef.glow_intensity) || 0;
          const particleSprite = getParticleSprite(baseColor, (Number(particleDef.size) || 5) / 2, glowIntensity, Number(particleDef.glow_radius) || 0, particleBrightness(particleDef), particleDef.image);
          // glowing: queued for the light layer to draw again above the ambience (glowqueue.ts) with the transform they were drawn with
          let glowMatrix: DOMMatrix | null = null;

          ctx.save();
          ctx.globalCompositeOperation = particleSprite.blend; // the dot adds its light; an image is drawn as it is
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

          for (let k = arr.length - 1; k >= 0; k--) {
            const pp = arr[k];
            pp.currentLife -= dtSec * 1000;
            if (pp.currentLife <= 0) {
              particlePool.release(pp);
              arr.splice(k, 1);
              continue;
            }

            // Apply gravity to velocity (wind/time-of-day intentionally skipped)
            pp.velocity.y += gravY * dtSec;
            pp.velocity.x += gravX * dtSec;

            // Move the absolute world position
            pp.worldX += pp.velocity.x * dtSec;
            pp.worldY += pp.velocity.y * dtSec;

            const lifeElapsed = pp.lifetime - pp.currentLife;
            const fadeInDur = pp.lifetime * 0.4;
            const fadeOutDur = pp.lifetime * 0.4;
            let alpha;
            if (lifeElapsed < fadeInDur) {
              alpha = (lifeElapsed / fadeInDur) * baseOpacity;
            } else if (pp.currentLife < fadeOutDur) {
              alpha = (pp.currentLife / fadeOutDur) * baseOpacity;
            } else {
              alpha = baseOpacity;
            }

            ctx.globalAlpha = alpha;
            const cx = pp.worldX * 1;
            const cy = pp.worldY * 1;
            ctx.drawImage(
              particleSprite.canvas,
              cx - particleSprite.half,
              cy - particleSprite.half,
              particleSprite.half * 2,
              particleSprite.half * 2
            );
            if (glowIntensity > 0) queueGlow(glowMatrix ??= ctx.getTransform(), particleSprite.canvas, cx - particleSprite.half, cy - particleSprite.half, particleSprite.half * 2, particleSprite.half * 2, alpha);
          }

          ctx.restore();
        }
      }

      if (isInView(projectile.currentX, projectile.currentY)) {
        ctx.save();

        const icon = cache.projectileIcons.get(projectile.spell);

        if (icon && icon.complete && icon.naturalWidth > 0) {
          const dx = endX - projectile.currentX;
          const dy = endY - projectile.currentY;
          const angle = Math.atan2(dy, dx) + Math.PI / 2;

          let iconSize = 24;
          ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
          ctx.shadowBlur = 8;

          ctx.translate(projectile.currentX, projectile.currentY);

          if ((projectile as any).isThrown) {
            const heightScale = 1 - (arcHeight / 80) * 0.3;
            iconSize = Math.max(16, 24 * heightScale);
            ctx.scale(heightScale, heightScale);
            const tumble = progress * Math.PI * 2;
            ctx.rotate(tumble);
          } else {
            ctx.rotate(angle);
          }

          ctx.drawImage(
            icon,
            -iconSize / 2,
            -iconSize / 2,
            iconSize,
            iconSize
          );
  }

  ctx.restore();
      }

      if (progress >= 1) {
        cache.projectiles.splice(i, 1);
      }
    }

  }

  ctx.restore();

  if (aboveCanvas && aboveCtx) {
    if (aboveCanvas.width !== canvas.width || aboveCanvas.height !== canvas.height) {
      aboveCanvas.width = canvas.width;
      aboveCanvas.height = canvas.height;
      aboveCanvas.style.width = canvas.style.width;
      aboveCanvas.style.height = canvas.style.height;
    }
    aboveCtx.setTransform(1, 0, 0, 1, 0, 0);
    aboveCtx.clearRect(0, 0, aboveCanvas.width, aboveCanvas.height);
    aboveCtx.setTransform(ctx.getTransform());
    aboveCtx.imageSmoothingEnabled = false;
  }

  // Other players' cast bars: cleared every frame and drawn in the world's place, above the light layer.
  if (castbarCanvas && castbarCtx) {
    if (castbarCanvas.width !== canvas.width || castbarCanvas.height !== canvas.height) {
      castbarCanvas.width = canvas.width;
      castbarCanvas.height = canvas.height;
      castbarCanvas.style.width = canvas.style.width;
      castbarCanvas.style.height = canvas.style.height;
    }
    castbarCtx.setTransform(1, 0, 0, 1, 0, 0);
    castbarCtx.clearRect(0, 0, castbarCanvas.width, castbarCanvas.height);
    castbarCtx.setTransform(ctx.getTransform());
    castbarCtx.imageSmoothingEnabled = false;
  }

  // The debug layer: cleared every frame and drawn in the world's place, like the layer above.
  if (debugLayerCanvas && debugLayerCtx) {
    if (debugLayerCanvas.width !== canvas.width || debugLayerCanvas.height !== canvas.height) {
      debugLayerCanvas.width = canvas.width;
      debugLayerCanvas.height = canvas.height;
      debugLayerCanvas.style.width = canvas.style.width;
      debugLayerCanvas.style.height = canvas.style.height;
    }
    debugLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    debugLayerCtx.clearRect(0, 0, debugLayerCanvas.width, debugLayerCanvas.height);
    debugLayerCtx.setTransform(ctx.getTransform());
    debugLayerCtx.imageSmoothingEnabled = false;
  }
  /** Where debug drawing goes: the debug layer, over the whole world (USER REQUEST 2026-10-16). */
  const dbg = debugLayerCtx || ctx;

  if (!wireframeDebugCheckbox.checked) {
    if (aboveCtx) {
      renderMap('above', aboveCtx);
    } else {
      renderMap('above');
    }
    {
      const coverCtx = aboveCtx || ctx;
      const at = worldOffset(smoothMapX, smoothMapY);
      coverCtx.save();
      coverCtx.translate(at.x, at.y);
      drawTornadoesOverCovers(coverCtx, !MOBILE_RENDERER && !!aboveCtx);
      coverCtx.restore();
    }

    // Render upper particles (zIndex >= 3) after upper map layers
    const upperCtx = aboveCtx || ctx;
    upperCtx.save();
    const upperOffsetX = worldOffset(smoothMapX, smoothMapY).x;
    const upperOffsetY = worldOffset(smoothMapX, smoothMapY).y;
    upperCtx.translate(upperOffsetX, upperOffsetY);

    // Get all zIndex values >= 3 and sort them
    const upperZIndices = Array.from(particlesByLayer.keys())
      .filter(z => z >= 3)
      .sort((a, b) => a - b);

    for (const zIdx of upperZIndices) {
      const particlesAtLayer = particlesByLayer.get(zIdx);
      if (particlesAtLayer) {
        for (const { particle, source } of particlesAtLayer) {
          source.updateParticle(particle, source, upperCtx, deltaTime);
        }

  }
  }

  upperCtx.restore();
    // Render graveyards and warps on top of all tile layers when tile editor is active
    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive) {
      dbg.save();
      const graveyardWarpOffsetX = worldOffset(smoothMapX, smoothMapY).x;
      const graveyardWarpOffsetY = worldOffset(smoothMapX, smoothMapY).y;
      dbg.translate(graveyardWarpOffsetX, graveyardWarpOffsetY);
      renderGraveyardsAndWarps(dbg, graveyardWarpOffsetX, graveyardWarpOffsetY);
      dbg.restore();
    }

    // Draw outline for hidden NPCs when NPC editor is active (z-index 15 - after upper particles)
    if (npcEditor?.isActive) {
      dbg.save();
      const npcOutlineOffsetX = worldOffset(smoothMapX, smoothMapY).x;
      const npcOutlineOffsetY = worldOffset(smoothMapX, smoothMapY).y;
      dbg.translate(npcOutlineOffsetX, npcOutlineOffsetY);

      drawSoundRanges(dbg);

      for (const npc of visibleNpcs) {
        if (npc.hidden) {
          dbg.strokeStyle = 'rgba(255, 80, 80, 0.7)';
          dbg.fillStyle = 'rgba(255, 80, 80, 0.1)';
          dbg.lineWidth = 1.5;
          dbg.setLineDash([]);
          // Draw centered square (16x16) - NPC visual center is at position + (16, 24)
          const squareSize = 16;
          const centerX = npc.position.x + 16;
          const centerY = npc.position.y + 24;
          dbg.fillRect(centerX - squareSize / 2, centerY - squareSize / 2, squareSize, squareSize);
          dbg.strokeRect(centerX - squareSize / 2, centerY - squareSize / 2, squareSize, squareSize);

          // Draw NPC ID above the square
          dbg.font = 'bold 13px monospace';
          dbg.textAlign = 'center';
          dbg.shadowColor = 'rgba(0, 0, 0, 0.8)';
          dbg.shadowBlur = 4;
          dbg.shadowOffsetX = 0;
          dbg.shadowOffsetY = 0;
          dbg.fillStyle = 'rgba(255, 100, 100, 1)';
          dbg.fillText(`#${npc.id}`, centerX, centerY - squareSize / 2 - 5);
          dbg.shadowColor = 'transparent';
        }
      }
      dbg.restore();
    }
  } else {

    ctx.save();
    const { x: offsetX, y: offsetY } = worldOffset(smoothMapX, smoothMapY);
    ctx.translate(offsetX, offsetY);

    if (window.mapData) {
      const visibleChunks = getVisibleChunksCached();
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;

      for (const chunk of visibleChunks) {
        const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
        const chunkWorldX = chunk.x * chunkPixelSize;
        const chunkWorldY = chunk.y * chunkPixelSize;

        for (let i = 0; i <= window.mapData.chunkSize; i++) {

          const lineX = chunkWorldX + (i * window.mapData.tilewidth);
          ctx.beginPath();
          ctx.moveTo(lineX, chunkWorldY);
          ctx.lineTo(lineX, chunkWorldY + chunkPixelSize);
          ctx.stroke();

          const lineY = chunkWorldY + (i * window.mapData.tileheight);
          ctx.beginPath();
          ctx.moveTo(chunkWorldX, lineY);
          ctx.lineTo(chunkWorldX + chunkPixelSize, lineY);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  dbg.save();
  dbg.translate(offsetX, offsetY);
  dbg.imageSmoothingEnabled = false;

  if (collisionDebugCheckbox.checked && (window as any).collisionTiles && window.mapData) {
    const collisionTiles = (window as any).collisionTiles as Array<{ x: number; y: number; time: number }>;
    const currentTime = Date.now();
    const maxAge = 3000;

    (window as any).collisionTiles = collisionTiles.filter(tile => currentTime - tile.time < maxAge);

    dbg.fillStyle = 'rgba(0, 100, 255, 0.5)';
    dbg.strokeStyle = 'rgba(0, 150, 255, 0.8)';
    dbg.lineWidth = 2;

    for (const tile of (window as any).collisionTiles) {
      const tileWorldX = tile.x * window.mapData.tilewidth;
      const tileWorldY = tile.y * window.mapData.tileheight;

      if (isInView(tileWorldX, tileWorldY)) {
        dbg.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
        dbg.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
      }
    }
  }

  if (chunkOutlineDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunksCached();

    dbg.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    dbg.lineWidth = 3;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      dbg.strokeRect(chunkWorldX, chunkWorldY, chunkPixelSize, chunkPixelSize);
    }
  }

  if (clusterNodesDebugCheckbox.checked && window.mapData) {
    // Which node owns which block of the map (any logged-in player, cluster mode): the world in view, as the zoom shows it.
    const zoom = worldZoom();
    const halfW = window.innerWidth / zoom / 2;
    const halfH = window.innerHeight / zoom / 2;
    drawClusterNodes(
      dbg,
      { left: smoothMapX - halfW, top: smoothMapY - halfH, right: smoothMapX + halfW, bottom: smoothMapY + halfH },
      zoom,
      String(window.mapData.name ?? ""),
      window.mapData.width * window.mapData.tilewidth,
      window.mapData.height * window.mapData.tileheight,
    );
  }

  if (collisionTilesDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunksCached();

    dbg.strokeStyle = 'rgba(255, 0, 0, 0.6)';
    dbg.fillStyle = 'rgba(255, 0, 0, 0.2)';
    dbg.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      const collisionLayer = chunkData.layers.find((layer: any) =>
        layer.name && layer.name.toLowerCase().includes('collision')
      );

      if (collisionLayer) {

        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = collisionLayer.data[y * chunkData.width + x];

            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              dbg.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              dbg.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  if (noPvpDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunksCached();

    dbg.strokeStyle = 'rgba(0, 255, 0, 0.6)';
    dbg.fillStyle = 'rgba(0, 255, 0, 0.2)';
    dbg.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      const noPvpLayer = chunkData.layers.find((layer: any) =>
        layer.name && (layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp'))
      );

      if (noPvpLayer) {

        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = noPvpLayer.data[y * chunkData.width + x];

            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              dbg.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              dbg.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  if (shadowsDebugCheckbox && shadowsDebugCheckbox.checked && window.mapData) {
    const shadowLayerNames = window.mapData.shadowLayerNames;
    if (!shadowLayerNames || shadowLayerNames.length === 0) { dbg.restore(); return; }

    // Camera-position cache key (recompute every tile-width of movement)
    const tw = window.mapData.tilewidth;
    const th = window.mapData.tileheight;
    const worldOX = -offsetX;
    const worldOY = -offsetY;
    const camKey = `${Math.floor(worldOX / tw)},${Math.floor(worldOY / th)}`;

    const silCacheRoot = '__shadowSilCache';
    const silCache = (window as any)[silCacheRoot] as Record<string, [number,number,number,number][]> || {};
    (window as any)[silCacheRoot] = silCache;

    let allEdges = silCache[camKey];
    if (!allEdges) {
      // --- Always-cached tileset lookup (built once) ---
      const tsKey = '__shadowTsAll';
      let tsAll = (window as any)[tsKey] as Map<number, { tileset: any; image: HTMLImageElement }> | undefined;
      if (!tsAll) {
        tsAll = new Map();
        for (let i = 0; i < window.mapData.tilesets.length; i++) {
          const ts = window.mapData.tilesets[i];
          const img = window.mapData.images[i];
          if (img && img.complete && img.naturalWidth > 0) {
            for (let gid = ts.firstgid; gid < ts.firstgid + ts.tilecount; gid++) {
              tsAll.set(gid, { tileset: ts, image: img });
            }
          }
        }
        (window as any)[tsKey] = tsAll;
      }

      // --- Offscreen silhouette canvas (viewport-sized) ---
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let silCanvas = (window as any).__shadowSilCanvas as HTMLCanvasElement | undefined;
      if (!silCanvas || silCanvas.width !== vw || silCanvas.height !== vh) {
        silCanvas = document.createElement('canvas');
        silCanvas.width = vw;
        silCanvas.height = vh;
        (window as any).__shadowSilCanvas = silCanvas;
      }
      const sctx = silCanvas.getContext('2d')!;
      sctx.clearRect(0, 0, vw, vh);
      sctx.imageSmoothingEnabled = false;
      sctx.save();
      sctx.translate(offsetX, offsetY);

      // Draw every shadow tile into the silhouette canvas
      const shadowNameSet = new Set(shadowLayerNames.map((n: string) => n.toLowerCase()));
      const visibleChunks = getVisibleChunksCached();

      for (const chunk of visibleChunks) {
        const chunkData = window.mapData.loadedChunks.get(`${chunk.x}-${chunk.y}`);
        if (!chunkData) continue;
        const layers = chunkData.layers.filter((l: any) =>
          l.name && shadowNameSet.has(l.name.toLowerCase())
        );
        if (layers.length === 0) continue;
        const bcx = chunk.x * window.mapData.chunkSize;
        const bcy = chunk.y * window.mapData.chunkSize;

        for (const sl of layers) {
          if (!sl.data) continue;
          for (let y = 0; y < chunkData.height; y++) {
            for (let x = 0; x < chunkData.width; x++) {
              const gid = sl.data[y * chunkData.width + x];
              if (gid === 0) continue;
              const info = tsAll.get(gid & 0x0FFFFFFF);
              if (!info) continue;
              const ts = info.tileset; const img = info.image;
              const li = (gid & 0x0FFFFFFF) - ts.firstgid;
              const tpr = Math.floor(ts.imagewidth / ts.tilewidth);
              const sx = (li % tpr) * ts.tilewidth;
              const sy = Math.floor(li / tpr) * ts.tileheight;
              const dx = (bcx + x) * tw;
              const dy = (bcy + y) * th;
              sctx.drawImage(img, sx, sy, ts.tilewidth, ts.tileheight, dx, dy, tw, th);
            }
          }
        }
      }
      sctx.restore();

      // Edge-detect: horizontal edges (bottom-facing) + vertical edges (right-facing)
      const imgData = sctx.getImageData(0, 0, vw, vh);
      const d = imgData.data;

      const hedges: [number,number,number,number][] = []; // horizontal runs
      const vedges: [number,number,number,number][] = []; // vertical runs

      // Bottom-facing edges: scan each row for a>=64 && below<64
      for (let py = 0; py < vh; py++) {
        let runStart = -1;
        for (let px = 0; px < vw; px++) {
          const a = d[(py * vw + px) * 4 + 3];
          const below = py + 1 < vh ? d[((py + 1) * vw + px) * 4 + 3] : 0;
          if (a >= 64 && below < 64) {
            if (runStart === -1) runStart = px;
          } else {
            if (runStart !== -1) { hedges.push([runStart - offsetX, py - offsetY, px - offsetX, py - offsetY]); runStart = -1; }
          }
        }
        if (runStart !== -1) hedges.push([runStart - offsetX, py - offsetY, vw - offsetX, py - offsetY]);
      }

      // Right-facing edges: scan each column for a>=64 && right<64
      for (let px = 0; px < vw; px++) {
        let runStart = -1;
        for (let py = 0; py < vh; py++) {
          const a = d[(py * vw + px) * 4 + 3];
          const right = px + 1 < vw ? d[(py * vw + (px + 1)) * 4 + 3] : 0;
          if (a >= 64 && right < 64) {
            if (runStart === -1) runStart = py;
          } else {
            if (runStart !== -1) { vedges.push([px - offsetX, runStart - offsetY, px - offsetX, py - offsetY]); runStart = -1; }
          }
        }
        if (runStart !== -1) vedges.push([px - offsetX, runStart - offsetY, px - offsetX, vh - offsetY]);
      }

      allEdges = hedges.concat(vedges);
      silCache[camKey] = allEdges;
    }

    // Draw cached edges (already in world-space, ctx is translated)
    if (allEdges.length > 0) {
      dbg.strokeStyle = 'rgba(255, 255, 0, 0.9)';
      dbg.lineWidth = 1.5;
      dbg.beginPath();
      for (const [x1, y1, x2, y2] of allEdges) {
        dbg.moveTo(x1, y1);
        dbg.lineTo(x2, y2);
      }
      dbg.stroke();
    }
  }

  if (astarDebugCheckbox && astarDebugCheckbox.checked) {
    // Request data every frame to keep it fresh
    sendRequest({ type: "GET_DEBUG_ASTAR", data: null });

    const debugData = (window as any).astarDebugData;

    if (!debugData || !debugData.nodes) {
      // No data yet
    } else {
      const nodes = debugData.nodes || [];

      if (nodes.length === 0) {
        // No nodes to display
      } else {
      // Find min/max f-score for color gradient
      let minF = Infinity;
      let maxF = -Infinity;

      for (const node of nodes) {
        if (node.f < minF) minF = node.f;
        if (node.f > maxF) maxF = node.f;
      }

      // Draw tiles based on f-score
      for (const node of nodes) {
        // Skip if node is not in view
        if (!isInView(node.x * 32, node.y * 32)) continue;

        // Calculate color based on f-score (blue = low/good, red = high/bad)
        const fNormalized = maxF === minF ? 0.5 : (node.f - minF) / (maxF - minF);
        const r = Math.round(fNormalized * 255);
        const g = 0;
        const b = Math.round((1 - fNormalized) * 255);

        // Draw tile with gradient color
        dbg.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
        dbg.fillRect(node.x * 32, node.y * 32, 32, 32);

        // Draw border
        dbg.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
        dbg.lineWidth = 1;
        dbg.strokeRect(node.x * 32, node.y * 32, 32, 32);

        // Optional: Draw f-score text for small number of nodes
        if (nodes.length < 50) {
          dbg.fillStyle = 'rgba(255, 255, 255, 0.8)';
          dbg.font = '10px Arial';
          dbg.textAlign = 'center';
          dbg.textBaseline = 'middle';
          const text = `${Math.round(node.f)}`;
          dbg.fillText(text, node.x * 32 + 16, node.y * 32 + 16);
        }
      }

      // Draw legend
      dbg.fillStyle = 'rgba(0, 0, 0, 0.8)';
      dbg.fillRect(10, 10, 200, 60);
      dbg.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      dbg.lineWidth = 2;
      dbg.strokeRect(10, 10, 200, 60);

      dbg.fillStyle = 'rgba(255, 255, 255, 0.8)';
      dbg.font = '12px Arial';
      dbg.textAlign = 'left';
      dbg.textBaseline = 'top';
      dbg.fillText('A* Debug:', 20, 20);
      dbg.fillText(`Nodes: ${nodes.length}`, 20, 35);
      dbg.fillText(`Blue=Low, Red=High`, 20, 50);
      }
    }
  }

  if (showGridCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunksCached();

    dbg.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    dbg.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      for (let x = 0; x <= window.mapData.chunkSize; x++) {
        const lineX = chunkWorldX + (x * window.mapData.tilewidth);
        dbg.beginPath();
        dbg.moveTo(lineX, chunkWorldY);
        dbg.lineTo(lineX, chunkWorldY + chunkPixelSize);
        dbg.stroke();
      }

      for (let y = 0; y <= window.mapData.chunkSize; y++) {
        const lineY = chunkWorldY + (y * window.mapData.tileheight);
        dbg.beginPath();
        dbg.moveTo(chunkWorldX, lineY);
        dbg.lineTo(chunkWorldX + chunkPixelSize, lineY);
        dbg.stroke();
      }
    }
  }

  dbg.restore();

  if ((window as any).tileEditor) {
    ctx.save();
    const { x: offsetX, y: offsetY } = worldOffset(smoothMapX, smoothMapY);
    ctx.translate(offsetX, offsetY);
    (window as any).tileEditor.renderPreview();
    ctx.restore();
  }

  if (!wireframeDebugCheckbox.checked) {
    ctx.save();
    const { x: offsetX, y: offsetY } = worldOffset(smoothMapX, smoothMapY);
    ctx.translate(offsetX, offsetY);
    ctx.imageSmoothingEnabled = false;

    const bubbleCtx = aboveCtx ?? ctx;
    if (bubbleCtx !== ctx) {
      bubbleCtx.save();
      bubbleCtx.translate(offsetX, offsetY);
      bubbleCtx.imageSmoothingEnabled = false;
    }
    for (const npc of visibleNpcs) {
      npc.dialogue(bubbleCtx);
    }
    for (const p of visiblePlayers) {
      p.showChat(bubbleCtx, currentPlayer);
    }
    if (bubbleCtx !== ctx) bubbleCtx.restore();

    const typingShown = new Set<HTMLImageElement>();
    for (const p of visiblePlayers) {
      if (p.typing) {
        if (!p._typingEl) {
          p._typingEl = document.createElement("img");
          p._typingEl.src = "data:image/gif;base64,R0lGODdhMAAwAHcAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJDgAAACwAAAAAMAAwAIIAAAAQDQ1cSkqHeHi8srLX19f88/MAAAAD/wi63P4wykmrvUDorQOmAectwmCcRqEO4/eEaMGGJZqqRN66C2wXuZwtBsxteIpAYZjKLZm3IGEgQAqeP5WKqSVsDYSq64q9aaFRgi089j7P6Jh6yPoInO/4sIzaUQREfHpxdRWAP4OJSwR+EIeJkCddjQ6PkYNdQJQNlkw1kThSmwwBUFtUoF05hRKle3CQql5sICZmOF+xQSoaFgFzqoJ6uwW9F7+SK8IpXFLGGAEDQQMDgotloVRiLgHdJW5ZRVor3aPQ0eBEUirdSK3S46F45u5J0eNSU/T1PffZ7Rv21fPWYcSVE6z4XTiIIqHCP9gEPlRABmGxib6qyaC2DT3jBHRTOnr8SGOkyZMBT/4xIUOix0cFXGI86EWkygb+nt3MIKAFwZ0kWMqcicIm0CRqqByFUHKp06dQJSQAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKyYK9geoNwjCgUQwWZzoBEYajYAkwfFLpuhZEHhKDPAMxmGXwsbFUq1xvJkCCcAOnsWA0EJec5jRHrXqtREFWeux+p1HxRlvFnW1UHE9NK77PhXw+R6DT7nd6fH0cAYCBgwQZa2SHUzgjixQCRFJ9bI56khNNUQRmLgECjiybnHw2oaOZBqacbjaXjXAskSYCeV9mXrkghLe9j2+fe1hZsCwGnyq7yYl+Y057fHpw05/GJ01OiQPVT9d50NpReqFX3yLUBeNMMSUdnnpyg+0/EEPE19n3Gvl8PYT0O3EhRhcSA3/gWoEwIbAbrhxKwHWQncRC3kaEuYhRPYk9jvhEfQRJ0uG7khooiWiIMsIqERFbLlj4aWRLD+JsXhSo4IVOiSoLxJSp4OXPkjX4EW0gcqnTp1B/JAAAIfkECQ4AAAAsAAAAADAAMACCAAAAEA0NXEpKh3h4vLKy19fX/PPzAAAAA/8Iutz+MMpJq70sBCE0tlzoKdpAnMQwfpBgFkXaaQIB3zHHPrWNowWDUBhD6XYL19DwCy6JKMIRKXgyb9Zh8dShZpmEr9Z2Cuyq35RYCyOYPwJnNib/3qRv0KBu5dsLIhdxfmtiOW6CWIWLQ3ggdHVSNYxWiBUBQHIzaEqUBgIWASYnWJtCA2iLQaChUWEGkq+ebaytJ55EdbR5l5O4OLk1vK2/Pj6AHMO9c0zNuWSuXWeyuTg/xkbKGL5XRdYqG22OSEk1d5mAbzTJ5A00oyioK+0U6yLDgfRnTir6cHX9/D1aUkCbQB4wTgE6eGlPgQEQazGUIOoEqomhNkjEyNEzX76OEZQ8NAgSQKqCJVsEsbExJQmHU0qyI6HRpckBTEjKHNLSJiYDF206qCm0qNGjDhIAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKSau9QOitA6YB5y3CYJxGoQ7j94RowYYlmqpE3roLbBe5nC0GzG14ikBhmMotmbcgYSBACp4/lYqpJWwNhKrrir1poVGCLTz2Ps/omHrI+gic7/iwjNpRBER8enF1FYA/g4lLBH4Qh4mQJ12NDo9MYXdgGnNoXUCUDZZDAgEwpD5QOFKgDAGpBaeAsZ1dOYUSrns4m5qZXKpebCAmZjhfkEVuGhYBc7WCekEqyxfNkivQKVxS1BgBA0EDA4KLZapUYi6lIeDHZnhaM6ze325ZUiqlSLjtWsBu8/Yl+eZPypSAAnsQPKdvA0KBpRyOuHLiVsILFFFYvPjHS9xDjgrIVIQFktk4GeLSlZxQb4rKlSxpwJxJ0yHNPyZkfFz5qMDOkhS9vLzZYGE3ohlIKTxKtIZPpBEeDYWaRA0VqhBkYt3KtauEBAAh+QQJDgAAACwAAAAAMAAwAIIAAAAQDQ1cSkqHeHi8srLX19f88/MAAAAD/wi63P4wysmCvYHqDcIwoFEMFmc6ARGGo2AJMHxS6boWRB4SgzwDMZhl8LGxVKtcbyZAgnADp7FgNBCXnOY0R616rURBVnrsfqdR8UZbxZ1tVBxPTSu+z4V8Pkeg0+53enx9HAGAgYMEGWtkh1M4I4sUAkRSfVqXjY8FkhNNUQRmLgECBqOlpnZTnZ58NqemLyA9bQasnm42mQa7cCyRJgJ5X2ZewyCEwcePb6F7WFm5LLxuxdOJfmNOe3x6cNyh0CdNTokD3k/gednjUXqjV+gi3QXsTDElHaB6coP2PxCGOAMnDqAGgXx6CDF44kKMLiQY/hC2IqJEZTduXZQgDEZivY2Fzo0IAzKkkn8lA5JCmbLlRXwuNVASYTFmBFQiNNpcQDEUS5se1v0EuVDBi6EbZ3LayTEEUpc1CjJtsHKq1atYfyQAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKSau9LAQhNLZc6CnaQJzEMH6QYBZF2mkCAd8xxz61jaMFg1AYQ+l2C9fQ8AsuiSjCESl4Mm/WYfHUoWaZhK/Wdgrsqt+UWAsjmD8CZzYm/96kb9CgbuXbCyIXcX5rYjlugliFi0N4IHR1UjUGkmGVYogVAUByM1WeBqBiAhYBJidYoKo0dqEXm1FCl7McYX05GLC2jER1bV2vk7y9ML01ea+7jJA+gBzIpWhPQdRsZFGOZ8pXOD8+UcBUu3fNMCobbdlICrXkqDDANM/rDTSnKAMz9K8bIfoMgfadcaJCIJw6BQ0+WlIAmsIIg4TsIfWQgilzA/JV1HRKOONGTf0+itwYcCTEAUwSmuShxeFKdkFsUHxZb48zmgDmkQhJU0lDnA6kzQRKIoxHogt4Il3KFGkCADs=";
          p._typingEl.style.position = "absolute";
          p._typingEl.style.pointerEvents = "none";
          p._typingEl.style.imageRendering = "pixelated";
          document.body.appendChild(p._typingEl);
          typingBubbles.set(p._typingEl, p);
        }
        // The GIF is a page element, not drawn on the canvas, so the world zoom does not reach it: size it here.
        const at = worldToScreen(p.renderPosition.x - 5, p.renderPosition.y - 58);
        const size = TYPING_BUBBLE_SIZE * worldZoom();
        p._typingEl.style.left = at.x + "px";
        p._typingEl.style.top = at.y + "px";
        p._typingEl.style.width = size + "px";
        p._typingEl.style.height = size + "px";
        p._typingEl.style.display = "block";
        typingShown.add(p._typingEl);
      }
    }
    for (const [el, owner] of typingBubbles) {
      if (typingShown.has(el)) continue;
      el.remove();
      typingBubbles.delete(el);
      if (owner._typingEl === el) owner._typingEl = null;
    }

    for (const p of visiblePlayers) {
      p.showDamageNumbers(ctx);
    }

    // Buff/debuff icons and the stun stars stand over the top tile layers too, the same way as the chat bubbles above.
    if (bubbleCtx !== ctx) {
      bubbleCtx.save();
      bubbleCtx.translate(offsetX, offsetY);
      bubbleCtx.imageSmoothingEnabled = false;
    }
    for (const p of visiblePlayers) {
      if (!p.targeted || !p.renderPosition) continue;
      const artTop = spriteArtTop(p.layeredAnimation ?? null, null, p.renderPosition.y) ?? p.renderPosition.y - 28;
      let tipY = artTop - ARROW_GAP;
      if (p.castingSpell) tipY = Math.min(tipY, p.renderPosition.y - 40);
      drawTargetArrow(bubbleCtx, p.renderPosition.x, tipY, TARGET_ARROWS.player);
    }
    const targetCreatureId = parseCreatureTarget(cache.targetId);
    const targetCreature = targetCreatureId === null ? undefined : creatures.get(targetCreatureId);
    const creatureArrow = targetCreature ? targetArrowFor(targetCreature) : null;
    if (creatureArrow) {
      bubbleCtx.save();
      bubbleCtx.globalAlpha = creatureArrow.alpha;
      drawTargetArrow(bubbleCtx, creatureArrow.x, creatureArrow.tipY, creatureArrow.palette);
      bubbleCtx.restore();
    }
    for (const p of visiblePlayers) {
      if (p.showDebuffs) {
        p.showDebuffs(bubbleCtx);
      }
      // Render stunned indicator above stunned players
      if (Array.isArray(p.activeEffects)) {
        const isStunned = p.activeEffects.some((e: any) => e.id?.startsWith && e.id.startsWith("stun:") && e.endTime > Date.now());
        if (isStunned) {
          const now = performance.now();
          const sx = p.renderPosition?.x ?? p.position.x;
          const frameH = 64;
          const sy = (p.renderPosition?.y ?? p.position.y) - frameH / 2 + 4;
          bubbleCtx.save();
          for (let i = 0; i < 3; i++) {
            const angle = (now * 0.002 + i * Math.PI * 2 / 3) % (Math.PI * 2);
            const radius = 10;
            const sx2 = sx + Math.cos(angle) * radius;
            const sy2 = sy + Math.sin(angle) * radius * 0.6;
            const starSize = 3 + Math.sin(now * 0.005 + i) * 1;
            bubbleCtx.fillStyle = '#ffd700';
            bubbleCtx.beginPath();
            bubbleCtx.arc(sx2, sy2, starSize, 0, Math.PI * 2);
            bubbleCtx.fill();
            bubbleCtx.strokeStyle = '#ff8c00';
            bubbleCtx.lineWidth = 1;
            bubbleCtx.stroke();
          }
          bubbleCtx.restore();
        }
      }
    }
    if (bubbleCtx !== ctx) bubbleCtx.restore();

    const barCtx = castbarCtx ?? ctx;
    if (barCtx !== ctx) {
      barCtx.save();
      barCtx.translate(offsetX, offsetY);
    }
    for (const p of visiblePlayers) {
      if (p.id !== cachedPlayerId) {
        p.showCastbar(barCtx);
      }
    }
    if (barCtx !== ctx) barCtx.restore();

    ctx.restore();
  }

  if (window.mapData && window.mapData.loadedChunks) {
    loadedChunksText.innerText = `Loaded Chunks: ${window.mapData.loadedChunks.size}`;
  }

  // Additive light map: glowing emitters brighten the darkened night scene.
  renderLightMap(canvas, baseTransform, offsetX, offsetY);

  if (times.length > 60) times.shift();
  times.push(now);

  if (now - lastFpsUpdate >= 1000 && times.length >= 2) {
    lastFpsUpdate = now;
    const fps = Math.round((times.length - 1) / ((times[times.length - 1] - times[0]) / 1000));
    const fpsEl = document.getElementById("fps-counter");
    if (fpsEl) fpsEl.textContent = `${fps} FPS`;
  }

  if (!(window as any).__firstFrameRendered && window.mapData) {
    (window as any).__firstFrameRendered = true;
  }

  // (the key hints go with the rest of the HUD while a scene hides it)
  if (!cutsceneHidesHud()) {
    renderLootInteractionHint(ctx, cameraX, cameraY, canvas.width, canvas.height, (window as any)._lootPickupProgress || 0, cachedPlayerId);

    (window as any).renderChestInteractionHint?.(ctx, cameraX, cameraY, canvas.width, canvas.height, (window as any).chestInteractionProgress || 0, cachedPlayerId);
    // E loots a corpse beside the player before anything else, so then only the corpse has the E badge.
    const corpseNear = renderCorpseLootHint(ctx);
    const talkTo = corpseNear ? null : getNearestNpcId();
    (window as any).renderMailboxHint?.(ctx, corpseNear || (talkTo !== null && canInteractWith(talkTo)));
    // and over the gathering node E would gather, when E does nothing else there
    renderGatherHint(ctx, corpseNear || (talkTo !== null && canInteractWith(talkTo)));

    renderNpcInteractBadge(ctx, cameraX, cameraY, canvas.width, canvas.height, talkTo);
  }

  // Screen-space editor panel (resets the transform itself).
  renderThreatPanel(ctx);

  drawCutsceneLayer();
  captureFrame(viewLoaded);

  askFrame();
}

setFrameDrawer(() => {
  if (performance.now() - animationFrameAt > ANIMATION_FRAMES_GONE_MS) animationLoop();
});
animationLoop();

function setDirection(dir: string) {
  lastDirection = dir;
}

function setCameraX(x: number) {
  cameraX = x;
}

function setCameraY(y: number) {
  cameraY = y;
}

function getCameraX() {
  return cameraX;
}

function getCameraY() {
  return cameraY;
}

(window as any).cameraX = cameraX;
(window as any).cameraY = cameraY;

function getWeatherType() {
  return weatherType;
}

function setWeatherType(type: string | null) {
  weatherType = type;
  updateWeatherSound(weatherType, currentWeatherData);
}

function setWeatherData(data: any) {
  currentWeatherData = data;
  updateWeatherSound(weatherType, currentWeatherData);
}

function getWeatherData() {
  return currentWeatherData;
}

setInterval(() => updateWeatherSound(weatherType, currentWeatherData), WEATHER_SOUND_EVERY);

function resetCameraInitialized() {
  cameraInitialized = false;
}

function initializeCamera(x: number, y: number) {
  if (!cameraInitialized) {
    cameraX = x;
    cameraY = y;
    smoothMapX = x;
    smoothMapY = y;
    cameraInitialized = true;
  }
}

function setPendingRequest(value: boolean) {
  pendingRequest = value;
}

function getPendingRequest(): boolean {
  return pendingRequest;
}

export {
  lastDirection,
  setDirection,
  canvas,
  setCameraX,
  setCameraY,
  getCameraX,
  getCameraY,
  setWeatherType,
  getWeatherType,
  setWeatherData,
  getWeatherData,
  initializeCamera,
  resetCameraInitialized,
  setPendingRequest,
  getPendingRequest,
  recordChunkLoadTime,
  clearChunkTracking,
  deleteChunkTracking
};
