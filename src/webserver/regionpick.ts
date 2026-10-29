// Which node of a cluster region a connection token is bound to (webserver /api/gateway/connection-token).
//
// The player's saved point decides: the node that owns the block it is in is asked first, so the first connection
// already goes to the node the game server would pass the login to. The hint only chooses the node the first
// connection goes to. It spawns nothing and changes no ownership, and the game server still checks the spawn point
// itself and sends the login on when the hint was wrong. Any doubt falls back to the least-loaded online node.

/** Where a login would spawn, as far as the account row says. */
export interface SavedPoint {
  map: string;
  x: number;
  y: number;
}

/** How long the route lookup may take before the pick goes on without it. */
export const ROUTE_TIMEOUT_MS = 300;

const bare = (map: string) => (map.endsWith(".json") ? map.slice(0, -5) : map);

/**
 * The point the game server would spawn this account at (its receiver's spawn rule), or null when the row cannot say:
 * no row, no map (the default map's spawn is the game server's to work out), or a position with a 0 or missing
 * coordinate (the game server puts that on the map's spawn or centre). A dead player resumes at the corpse.
 */
export function savedPointOf(row: any): SavedPoint | null {
  if (!row || typeof row !== "object") return null;
  const corpseMap = typeof row.corpse_map === "string" ? row.corpse_map.trim() : "";
  if ((Number(row.is_dead) || 0) === 1 && corpseMap) {
    return { map: bare(corpseMap), x: Number(row.corpse_x) || 0, y: Number(row.corpse_y) || 0 };
  }
  const map = typeof row.map === "string" ? row.map.trim() : "";
  if (!map || typeof row.position !== "string") return null;
  const [px, py] = row.position.split(",");
  const x = Number(px || 0);
  const y = Number(py || 0);
  if (!x || !y) return null;
  return { map: bare(map), x, y };
}

export interface RouteFetch {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The gateway's internal base URL. */
  base: string;
  /** The key game servers use with the gateway (GATEWAY_AUTH_KEY). */
  key: string | undefined;
}

/**
 * The gateway's /route: the id of the node that owns the point, or null. The key goes in the `x-gateway-key` header and
 * never in the URL (URLs are logged); without a key nothing is asked. A non-2xx answer is an error.
 */
export async function fetchGatewayRoute(deps: RouteFetch, realm: string, point: SavedPoint, signal: AbortSignal): Promise<string | null> {
  if (!deps.key) return null;
  const query = new URLSearchParams({ realm, map: point.map, x: String(point.x), y: String(point.y) });
  const response = await deps.fetch(`${deps.base}/route?${query}`, { method: "GET", headers: { "x-gateway-key": deps.key }, signal });
  if (!response.ok) throw new Error(`Gateway returned status ${response.status}`);
  const data = await response.json();
  return typeof data?.nodeId === "string" ? data.nodeId : null;
}

/** A pick not yet seen in a heartbeat is not forgotten for longer than this (the fallback when a node's heartbeat time is not known). */
export const HERD_WINDOW_MS = 10_000;

/**
 * Logins sent to a node since its last heartbeat. The player count the gateway holds is refreshed once per heartbeat
 * (5 s), so a burst of picks would all see the same least-loaded node: each pick counts as one more connection on that
 * node until the next heartbeat arrives.
 */
export class HerdSpread {
  private picks = new Map<string, { beat: unknown; at: number; count: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Picks counted for the node, none once a newer heartbeat has arrived. */
  extra(node: { nodeId: string; lastHeartbeat?: number }): number {
    const held = this.picks.get(node.nodeId);
    if (!held) return 0;
    if (held.beat !== node.lastHeartbeat || this.now() - held.at > HERD_WINDOW_MS) {
      this.picks.delete(node.nodeId);
      return 0;
    }
    return held.count;
  }

  /** One more login is on its way to the node. */
  chose(node: { nodeId: string; lastHeartbeat?: number }): void {
    this.extra(node);
    const held = this.picks.get(node.nodeId);
    if (held) held.count++;
    else this.picks.set(node.nodeId, { beat: node.lastHeartbeat, at: this.now(), count: 1 });
  }

  /** Forgets nodes that are no longer listed (the table cannot outgrow the cluster). */
  keepOnly(nodeIds: Iterable<string>): void {
    const keep = new Set(nodeIds);
    for (const id of this.picks.keys()) if (!keep.has(id)) this.picks.delete(id);
  }

  size(): number {
    return this.picks.size;
  }
}

export interface PickDeps {
  /** The gateway's /status. */
  fetchStatus(): Promise<any>;
  /** The gateway's /route: the id of the node that owns the point, or null. Gets a signal to stop when the pick has stopped waiting. */
  fetchRoute(realm: string, point: SavedPoint, signal: AbortSignal): Promise<string | null>;
  herd: HerdSpread;
  routeTimeoutMs?: number;
  warn?(message: string): void;
}

/** The owner of the saved point, or null on any error or when it takes longer than `ms`. */
async function ownerHint(deps: PickDeps, realm: string, point: SavedPoint, ms: number): Promise<string | null> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve(null);
      }, ms);
    });
    const asked = deps.fetchRoute(realm, point, stop.signal).catch(() => null);
    return await Promise.race([asked, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When `realm` names a cluster region: the node its ticket is bound to. The online node that owns the saved point when
 * there is one, else the online node with the fewest connections (counting the logins sent since its last heartbeat).
 * null for any other realm (the ticket is not bound); "unavailable" for a region with no online node.
 */
export async function pickRegionNode(realm: string | null, saved: SavedPoint | null, deps: PickDeps): Promise<any | null | "unavailable"> {
  if (!realm) return null;
  let data: any;
  try {
    data = await deps.fetchStatus();
  } catch (error: any) {
    // Not knowing the regions leaves the ticket as it is without a cluster.
    deps.warn?.(`Could not read the gateway's regions for a connection token: ${error.message}`);
    return null;
  }
  const regions = Array.isArray(data?.regions) ? data.regions : [];
  if (!regions.some((region: any) => region.id === realm)) return null;

  const online = (data.servers || []).filter((server: any) => server.regionId === realm && server.status === "online" && server.nodeId);
  if (online.length === 0) return "unavailable";
  deps.herd.keepOnly(online.map((node: any) => node.nodeId));

  let chosen: any;
  // With one online node the pick is that node either way, so the gateway is not asked who owns the point.
  if (saved && online.length > 1) {
    const owner = await ownerHint(deps, realm, saved, deps.routeTimeoutMs ?? ROUTE_TIMEOUT_MS);
    // Only a node the gateway lists as online counts: an owner that went away is not sent anyone.
    if (owner) chosen = online.find((node: any) => node.nodeId === owner);
  }
  chosen ??= online.reduce((best: any, node: any) =>
    node.activeConnections + deps.herd.extra(node) < best.activeConnections + deps.herd.extra(best) ? node : best);
  deps.herd.chose(chosen);
  return chosen;
}
