// Which node of a cluster region owns which block of each map, as the game servers report it (POST /blocks) and as
// the webserver asks for it (GET /route). Nothing here changes who owns a block: it only answers where a login is
// best sent first, and the game server's own check stays the authority.
//
// The layout is the engine's (src/cluster/blockreport.ts in the Frostfire Forge repo): per map the table's epoch, its
// size in blocks and one character per block, row by row (by * blocksX + bx), naming the owner as an index into `nodes`.

export const REPORT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const NO_OWNER = ".";
/** A report names at most this many nodes (one alphabet character each). */
export const MAX_NODES = REPORT_ALPHABET.length;
/** The most blocks a map's table may hold. */
export const MAX_BLOCKS = 65536;
/** The longest map name or node id. */
export const MAX_NAME = 128;
/** The largest block size, in pixels, a report may state. */
export const MAX_BLOCK_PX = 1048576;
/** A report body may be this large (the biggest table is MAX_BLOCKS characters plus a little). */
export const MAX_BODY_BYTES = 131072;
/**
 * What the store may hold. The keys come from game servers, but a mistaken one must not grow without end, so the
 * tables are bounded by memory, not by how many maps there are: a world has hundreds of small maps (one block each).
 * A table is counted at its characters plus a fixed amount per map and per node name (see `tableCost`).
 */
export const MAP_OVERHEAD_BYTES = 1024;
export const NODE_OVERHEAD_BYTES = 32;
/** The most one region's tables may add up to. */
export const MAX_REGION_BYTES = 16 * 1024 * 1024;
/** The most all regions' tables may add up to, and the most regions held. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_REGIONS = 256;

export interface RouteTable {
  epoch: number;
  blockPx: number;
  blocksX: number;
  blocksY: number;
  nodes: string[];
  owners: string;
}

export type ParsedReport = { ok: true; map: string; table: RouteTable } | { ok: false; error: string };

const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL.test(value);
const count = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** A map's name as the block tables key it: without ".json". */
export const bareMap = (map: string): string => (map.endsWith(".json") ? map.slice(0, -5) : map);

/** Checks one map's report. Nothing in it is trusted: sizes, characters and names are all checked before anything is kept. */
export function parseBlocksReport(body: unknown): ParsedReport {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Invalid report" };
  const report = body as Record<string, unknown>;
  if (!text(report.map, MAX_NAME)) return { ok: false, error: "Invalid map" };
  const map = bareMap(report.map);
  if (map === "") return { ok: false, error: "Invalid map" };
  if (!count(report.epoch, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "Invalid epoch" };
  if (!count(report.blockPx, 1, MAX_BLOCK_PX)) return { ok: false, error: "Invalid block size" };
  if (!count(report.blocksX, 1, MAX_BLOCKS) || !count(report.blocksY, 1, MAX_BLOCKS) || report.blocksX * report.blocksY > MAX_BLOCKS) {
    return { ok: false, error: "Invalid map size" };
  }
  const nodes = report.nodes;
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES) return { ok: false, error: "Invalid nodes" };
  for (const node of nodes) if (!text(node, MAX_NAME)) return { ok: false, error: "Invalid nodes" };
  if (new Set(nodes).size !== nodes.length) return { ok: false, error: "Invalid nodes" };
  const owners = report.owners;
  if (typeof owners !== "string" || owners.length !== report.blocksX * report.blocksY) return { ok: false, error: "Invalid owners" };
  for (let i = 0; i < owners.length; i++) {
    const char = owners[i];
    if (char !== NO_OWNER && !(REPORT_ALPHABET.indexOf(char) !== -1 && REPORT_ALPHABET.indexOf(char) < nodes.length)) {
      return { ok: false, error: "Invalid owners" };
    }
  }
  return {
    ok: true,
    map,
    table: { epoch: report.epoch, blockPx: report.blockPx, blocksX: report.blocksX, blocksY: report.blocksY, nodes: [...(nodes as string[])], owners }
  };
}

/**
 * The owner of the block a position is in; what the engine's BlockTable.ownerOf says for the same table. A position
 * on or past the far edge is in the last block, a negative or non-finite one in block 0. Null for an unowned block.
 */
export function decodeOwner(table: RouteTable, x: number, y: number): string | null {
  const block = (px: number, size: number) => Math.min(Number.isFinite(px) ? Math.max(0, Math.floor(px / table.blockPx)) : 0, size - 1);
  const char = table.owners[block(y, table.blocksY) * table.blocksX + block(x, table.blocksX)];
  if (char === undefined || char === NO_OWNER) return null;
  return table.nodes[REPORT_ALPHABET.indexOf(char)] ?? null;
}

/** What a map's table takes in memory, near enough: its characters, its name and node names, and a fixed amount for each map and node. */
export function tableCost(map: string, table: RouteTable): number {
  let cost = MAP_OVERHEAD_BYTES + map.length + table.owners.length;
  for (const node of table.nodes) cost += node.length + NODE_OVERHEAD_BYTES;
  return cost;
}

export type Accepted = "stored" | "stale" | "full";

interface Region {
  maps: Map<string, RouteTable>;
  /** The sum of `tableCost` over the maps. */
  bytes: number;
}

/** Per region, per map, the table of the highest epoch reported. */
export class BlockRoutes {
  private regions = new Map<string, Region>();
  private total = 0;

  /**
   * Keeps the table unless the one held is of a higher epoch. The same epoch replaces (it is the same table). A table
   * that takes more than it replaces (a new map counts as all of it) is refused ("full") when it would take the region
   * or the store over its budget; one that keeps its size or shrinks always goes in, so a map held is updated whatever
   * the state of the budget.
   */
  accept(regionId: string, map: string, table: RouteTable): Accepted {
    const region = this.regions.get(regionId);
    const held = region?.maps.get(map);
    if (held && held.epoch > table.epoch) return "stale";
    const cost = tableCost(map, table);
    const freed = held ? tableCost(map, held) : 0;
    const growth = cost - freed;
    if (!region && this.regions.size >= MAX_REGIONS) return "full";
    if (growth > 0 && ((region?.bytes ?? 0) + growth > MAX_REGION_BYTES || this.total + growth > MAX_TOTAL_BYTES)) return "full";
    const into = region ?? { maps: new Map<string, RouteTable>(), bytes: 0 };
    if (!region) this.regions.set(regionId, into);
    into.maps.set(map, table);
    into.bytes += growth;
    this.total += growth;
    return "stored";
  }

  /** The table of a map, for the tests and the dashboard. */
  tableOf(regionId: string, map: string): RouteTable | undefined {
    return this.regions.get(regionId)?.maps.get(bareMap(map));
  }

  regionIds(): string[] {
    return [...this.regions.keys()];
  }

  /** What a region's tables take (see `tableCost`), 0 for a region not held. */
  bytesOf(regionId: string): number {
    return this.regions.get(regionId)?.bytes ?? 0;
  }

  /** What all regions' tables take. */
  totalBytes(): number {
    return this.total;
  }

  /** The node that owns the block a position is in, or null (no table for the map, or no owner). The caller checks the node is live. */
  ownerOf(regionId: string, map: string, x: number, y: number): string | null {
    const table = this.regions.get(regionId)?.maps.get(bareMap(map));
    return table ? decodeOwner(table, x, y) : null;
  }

  dropRegion(regionId: string): boolean {
    const region = this.regions.get(regionId);
    if (!region) return false;
    this.total -= region.bytes;
    return this.regions.delete(regionId);
  }

  /** A region with no server left keeps no table: `servers` is what is registered after the removal. */
  dropRegionIfEmpty(regionId: string | undefined, servers: Iterable<{ regionId?: string }>): boolean {
    if (!regionId) return false;
    for (const server of servers) if (server.regionId === regionId) return false;
    return this.dropRegion(regionId);
  }

  /**
   * A node registering into a region none of whose other nodes is alive starts it again: the tables held are from a
   * run that is over, and a cluster whose store was wiped counts epochs from 1, below the ones held.
   */
  dropRegionIfAlone(regionId: string | undefined, selfId: string, servers: Iterable<{ id: string; regionId?: string; lastHeartbeat: number }>, now: number, timeoutMs: number): boolean {
    if (!regionId) return false;
    for (const server of servers) {
      if (server.regionId === regionId && server.id !== selfId && now - server.lastHeartbeat <= timeoutMs) return false;
    }
    return this.dropRegion(regionId);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The body as text, or null when it is larger than `max` bytes. Stops reading at the limit. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface BlocksDeps {
  routes: BlockRoutes;
  isValidAuthKey(key: unknown): boolean;
  /** The registered game server of that id. */
  server(id: string): { regionId?: string } | undefined;
}

/** POST /blocks: one map's block owners from a registered cluster node. Same key as /heartbeat, in the body. */
export async function handleBlocks(deps: BlocksDeps, req: Request): Promise<Response> {
  let body: any;
  try {
    const raw = await readCapped(req, MAX_BODY_BYTES);
    if (raw === null) return json(413, { error: "Report too large" });
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  if (typeof body !== "object" || body === null || !deps.isValidAuthKey(body.authKey)) {
    return json(401, { error: "Invalid authentication key" });
  }
  // The key proves a game server; the id says which one, and so which region the report is for.
  const server = typeof body.id === "string" ? deps.server(body.id) : undefined;
  if (!server) return json(404, { error: "Server not found" });
  if (!server.regionId) return json(400, { error: "Not a cluster node" });
  const parsed = parseBlocksReport(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const result = deps.routes.accept(server.regionId, parsed.map, parsed.table);
  if (result === "full") return json(400, { error: "No room for this map" });
  return json(200, { success: true, stored: result === "stored" });
}

/** The ids of a region's nodes that are alive: a node id and a heartbeat inside the timeout. The only nodes /route may name. */
export function liveNodesOf(servers: Iterable<{ regionId?: string; nodeId?: string; lastHeartbeat: number }>, regionId: string, now: number, timeoutMs: number): Set<string> {
  const live = new Set<string>();
  for (const server of servers) {
    if (server.regionId === regionId && server.nodeId && now - server.lastHeartbeat < timeoutMs) live.add(server.nodeId);
  }
  return live;
}

export interface RouteDeps {
  routes: BlockRoutes;
  isValidAuthKey(key: unknown): boolean;
  /** The ids of the region's nodes that are alive (a heartbeat within the timeout). */
  liveNodes(regionId: string): ReadonlySet<string>;
}

/**
 * GET /route?realm=&map=&x=&y=: the node that owns that point, `{ nodeId }`, or `{ nodeId: null }` when there is no
 * table, no owner, or the owner is not alive. For the webserver, which sends the key in `x-gateway-key`: it is never
 * in the URL.
 */
export function handleRoute(deps: RouteDeps, req: Request): Response {
  if (!deps.isValidAuthKey(req.headers.get("x-gateway-key"))) return json(401, { error: "Invalid authentication key" });
  const params = new URL(req.url).searchParams;
  const realm = params.get("realm");
  const map = params.get("map");
  const xs = params.get("x");
  const ys = params.get("y");
  const x = xs === null || xs === "" ? NaN : Number(xs);
  const y = ys === null || ys === "" ? NaN : Number(ys);
  if (!realm || realm.length > MAX_NAME || !map || map.length > MAX_NAME || !Number.isFinite(x) || !Number.isFinite(y)) {
    return json(400, { error: "Invalid route request" });
  }
  const owner = deps.routes.ownerOf(realm, map, x, y);
  return json(200, { nodeId: owner !== null && deps.liveNodes(realm).has(owner) ? owner : null });
}
