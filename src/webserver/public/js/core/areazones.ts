import { setZoneMusic, updateZoneMusic } from "./audio.js";
import { cutsceneActive } from "./cutscene.js";
import { cachedPlayerId } from "./socket.js";
import Cache from "./cache.ts";
import { bannerStep, musicAt, zoneAt, zonesList, type BannerState } from "./zonelogic.js";
import { clearBanner, showBanner as putBanner } from "./bannerview.js";

const LOOK_MS = 250, BANNER_SHOW_MS = 4000;
const banner: BannerState = { current: null };
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
  putBanner(el, text);
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

export function zonesLoaded(opts: { fresh: boolean }): void {
  if (opts.fresh) {
    fresh = true;
    // the old map's text goes with it
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    clearBanner(bannerElement());
  }
  startAreaZones();
  look();
}

export function startAreaZones(): void {
  if (started) return;
  started = true;
  setInterval(look, LOOK_MS);
}
