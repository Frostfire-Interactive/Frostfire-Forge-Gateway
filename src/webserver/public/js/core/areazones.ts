// The named zones of the map the player is on (drawn in the map editor, sent with the map and again on a save): the
// zone's text shows at the top of the screen on entering it, and its music fades in. Looked at every LOOK_MS, from
// the player's position in tiles. Which zone and which music: zonelogic.ts.
import { setZoneMusic, updateZoneMusic } from "./audio.js";
import { cutsceneActive } from "./cutscene.js";
import { cachedPlayerId } from "./socket.js";
import Cache from "./cache.ts";
import { bannerStep, musicAt, zoneAt, zonesList, type BannerState } from "./zonelogic.js";

const LOOK_MS = 250, BANNER_SHOW_MS = 4000;
const banner: BannerState = { current: null, leftAt: new Map() };
let fresh = true, started = false, hideTimer: ReturnType<typeof setTimeout> | null = null;

function bannerElement(): HTMLElement {
  let el = document.getElementById("zone-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "zone-banner";
    el.className = "ui";
    document.body.appendChild(el);
  }
  return el;
}

function showBanner(text: string): void {
  const el = bannerElement();
  el.textContent = text;
  el.classList.add("shown");
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove("shown"), BANNER_SHOW_MS);
}

/** The player's position in tiles, or null while there is no player or no map. */
function playerTile(): { x: number; y: number } | null {
  const map = (window as any).mapData;
  if (!map) return null;
  const players = Cache.getInstance().players;
  let self: any = null;
  for (const p of players as any) if (p?.id === cachedPlayerId) { self = p; break; }
  const at = self?.renderPosition ?? self?.position;
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return { x: at.x / (map.tilewidth || 16), y: at.y / (map.tileheight || 16) };
}

function look(): void {
  const zones = zonesList((window as any).mapData?.zones);
  const at = playerTile();
  if (at) {
    const text = bannerStep(banner, zoneAt(zones, at.x, at.y), performance.now(), { fresh });
    fresh = false;
    if (text) showBanner(text);
    setZoneMusic(musicAt(zones, at.x, at.y));
  }
  updateZoneMusic(cutsceneActive());
}

/**
 * The map's zones are in (window.mapData.zones): a new map (`fresh`) shows the zone the player stands in even when it
 * has the same name as the last; new zones of the same map (a save) only show a zone the player then walks into.
 */
export function zonesLoaded(opts: { fresh: boolean }): void {
  if (opts.fresh) fresh = true;
  startAreaZones();
  look();
}

export function startAreaZones(): void {
  if (started) return;
  started = true;
  setInterval(look, LOOK_MS);
}
