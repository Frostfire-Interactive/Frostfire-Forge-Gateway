import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BlockRoutes, MAX_BLOCKS, MAX_BODY_BYTES, MAX_REGIONS, MAX_REGION_BYTES, MAX_TOTAL_BYTES, REPORT_ALPHABET, decodeOwner, handleBlocks, handleRoute, liveNodesOf, parseBlocksReport, readCapped, tableCost,
  type RouteTable,
} from "../gateway/blockroute";
import { HerdSpread, ROUTE_TIMEOUT_MS, fetchGatewayRoute, pickRegionNode, savedPointOf, type PickDeps } from "../webserver/regionpick";

// The gateway side of "a login goes straight to the node that owns the saved point": the owner table the nodes
// report (POST /blocks), the lookup (GET /route) and the webserver's pick.

const KEY = "test-key";
const isValidAuthKey = (key: unknown) => key === KEY;

// The same report the engine's test (cluster-ownerroute.test.ts) builds from a table: 3 x 2 blocks, row by row.
//   row 0: node-1 node-2 (none)    row 1: node-2 node-1 node-1
const FIXTURE = { map: "overworld", epoch: 7, blockPx: 4096, blocksX: 3, blocksY: 2, nodes: ["node-1", "node-2"], owners: "01.100" };

const report = (over: Record<string, unknown> = {}) => ({ id: "node-1", authKey: KEY, ...FIXTURE, ...over });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://gateway.test/blocks", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });

function blocksDeps(servers: Record<string, { regionId?: string }> = { "node-1": { regionId: "eu" }, "node-2": { regionId: "eu" }, plain: {} }) {
  const routes = new BlockRoutes();
  return { routes, deps: { routes, isValidAuthKey, server: (id: string) => servers[id] } };
}

// The engine's rule (BlockTable.ownerOf with a map extent), from the owners keyed "bx,by".
function referenceOwner(owners: Record<string, string>, blocksX: number, blocksY: number, blockPx: number, x: number, y: number): string | null {
  const block = (px: number, count: number) => Math.min(Number.isFinite(px) ? Math.max(0, Math.floor(px / blockPx)) : 0, count - 1);
  return owners[`${block(x, blocksX)},${block(y, blocksY)}`] ?? null;
}

// Builds the layout as documented, independently of the decoder.
function encode(owners: Record<string, string>, blocksX: number, blocksY: number): { nodes: string[]; owners: string } {
  const nodes: string[] = [];
  let line = "";
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const id = owners[`${bx},${by}`];
      if (!id) { line += "."; continue; }
      if (!nodes.includes(id)) nodes.push(id);
      line += REPORT_ALPHABET[nodes.indexOf(id)];
    }
  }
  return { nodes, owners: line };
}

const table = (over: Partial<RouteTable> = {}): RouteTable => ({ epoch: 1, blockPx: 4096, blocksX: 3, blocksY: 2, nodes: ["node-1", "node-2"], owners: "01.100", ...over });

// ---- the encoding ----------------------------------------------------------------------------------------------

test("the fixture parses and decodes block by block, with the far-edge clamp", () => {
  const parsed = parseBlocksReport(FIXTURE);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.map).toBe("overworld");
  const at = (x: number, y: number) => decodeOwner(parsed.table, x, y);
  expect(at(0, 0)).toBe("node-1");
  expect(at(4096, 0)).toBe("node-2");
  expect(at(8192, 0)).toBeNull();
  expect(at(0, 4096)).toBe("node-2");
  expect(at(5000, 5000)).toBe("node-1");
  // On and past the far edge: the last block (here the unowned one in row 0, the owned one in row 1).
  expect(at(12288, 0)).toBeNull();
  expect(at(99999, 4096)).toBe("node-1");
  expect(at(0, 8192)).toBe("node-2");
  // Negative and non-finite positions belong to block 0.
  expect(at(-10, -10)).toBe("node-1");
  expect(at(NaN, Infinity)).toBe("node-1");
});

test("a decoded owner equals the engine's ownerOf for random tables and points, edges included", () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let round = 0; round < 60; round++) {
    const blocksX = 1 + Math.floor(random() * 12);
    const blocksY = 1 + Math.floor(random() * 12);
    const blockPx = [1, 64, 4096, 5000][Math.floor(random() * 4)]!;
    const nodeCount = 1 + Math.floor(random() * 6);
    const owners: Record<string, string> = {};
    for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) if (random() < 0.85) owners[`${bx},${by}`] = `node-${Math.floor(random() * nodeCount) + 1}`;
    const wire = encode(owners, blocksX, blocksY);
    const parsed = parseBlocksReport({ map: "m", epoch: 1 + round, blockPx, blocksX, blocksY, ...wire });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const width = blocksX * blockPx;
    const height = blocksY * blockPx;
    const points: Array<[number, number]> = [
      [0, 0], [width, height], [width - 1, height - 1], [width + blockPx * 5, height + blockPx * 5], [-1, -blockPx], [NaN, 3], [Infinity, -Infinity],
      [width, 0], [0, height],
    ];
    for (let i = 0; i < 40; i++) points.push([Math.floor(random() * (width + 2 * blockPx)) - blockPx, Math.floor(random() * (height + 2 * blockPx)) - blockPx]);
    for (const [x, y] of points) {
      expect(decodeOwner(parsed.table, x, y)).toBe(referenceOwner(owners, blocksX, blocksY, blockPx, x, y));
    }
  }
});

test("a report is refused for each field that is wrong, and nothing of it is kept", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["no map", { map: "" }],
    ["map not a string", { map: 5 }],
    ["map with a control character", { map: "a\nb" }],
    ["map too long", { map: "m".repeat(129) }],
    ["only .json", { map: ".json" }],
    ["negative epoch", { epoch: -1 }],
    ["fractional epoch", { epoch: 1.5 }],
    ["epoch not a number", { epoch: "7" }],
    ["block size 0", { blockPx: 0 }],
    ["block size huge", { blockPx: 2 ** 40 }],
    ["blocksX 0", { blocksX: 0, owners: "" }],
    ["blocksX fractional", { blocksX: 1.5 }],
    ["more blocks than the limit", { blocksX: 257, blocksY: 257, owners: "." }],
    ["owners shorter", { owners: "01.10" }],
    ["owners longer", { owners: "01.1000" }],
    ["owners not a string", { owners: ["0", "1"] }],
    ["owner index past the nodes", { owners: "01.12." }],
    ["owner character outside the alphabet", { owners: "01.1-0" }],
    ["nodes not an array", { nodes: "node-1" }],
    ["a node name empty", { nodes: ["node-1", ""] }],
    ["a node name not a string", { nodes: ["node-1", 2] }],
    ["a node twice", { nodes: ["node-1", "node-1"] }],
    ["more nodes than the alphabet", { nodes: Array.from({ length: 63 }, (_, i) => `n${i}`) }],
  ];
  for (const [name, over] of bad) {
    const parsed = parseBlocksReport({ ...FIXTURE, ...over });
    expect([name, parsed.ok]).toEqual([name, false]);
  }
  for (const body of [null, undefined, 5, "x", [], [FIXTURE]]) expect(parseBlocksReport(body).ok).toBe(false);
  // The limit itself is fine, one more is not.
  expect(parseBlocksReport({ ...FIXTURE, blocksX: 256, blocksY: 256, owners: ".".repeat(MAX_BLOCKS) }).ok).toBe(true);
  expect(parseBlocksReport({ ...FIXTURE, blocksX: 256, blocksY: 257, owners: ".".repeat(256 * 257) }).ok).toBe(false);
});

// ---- POST /blocks ----------------------------------------------------------------------------------------------

test("/blocks refuses a bad key, a missing key and an unknown or non-cluster server, and stores nothing", async () => {
  const { routes, deps } = blocksDeps();
  expect((await handleBlocks(deps, post(report({ authKey: "wrong" })))).status).toBe(401);
  expect((await handleBlocks(deps, post({ ...report(), authKey: undefined }))).status).toBe(401);
  expect((await handleBlocks(deps, post(report({ authKey: 5 })))).status).toBe(401);
  expect((await handleBlocks(deps, post(report({ id: "ghost" })))).status).toBe(404);
  expect((await handleBlocks(deps, post(report({ id: "plain" })))).status).toBe(400);
  expect(routes.regionIds()).toEqual([]);
  const ok = await handleBlocks(deps, post(report()));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ success: true, stored: true });
  expect(routes.ownerOf("eu", "overworld", 4096, 0)).toBe("node-2");
});

test("/blocks keeps the table of the highest epoch per map and region", async () => {
  const { routes, deps } = blocksDeps();
  await handleBlocks(deps, post(report({ epoch: 5, owners: "000000" })));
  // A lower epoch (a node that is behind) does not replace it.
  const stale = await handleBlocks(deps, post(report({ id: "node-2", epoch: 4, owners: "111111" })));
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual({ success: true, stored: false });
  expect(routes.tableOf("eu", "overworld")?.epoch).toBe(5);
  expect(routes.ownerOf("eu", "overworld", 0, 0)).toBe("node-1");
  // A higher one does, and the same epoch is the same table.
  await handleBlocks(deps, post(report({ epoch: 6, owners: "111111" })));
  expect(routes.ownerOf("eu", "overworld", 0, 0)).toBe("node-2");
  await handleBlocks(deps, post(report({ epoch: 6, owners: "111111" })));
  expect(routes.tableOf("eu", "overworld")?.epoch).toBe(6);
  // Another map and another region are separate.
  await handleBlocks(deps, post(report({ map: "cave.json", epoch: 1, owners: "000000" })));
  expect(routes.tableOf("eu", "cave")?.epoch).toBe(1);
  expect(routes.ownerOf("us", "overworld", 0, 0)).toBeNull();
});

test("/blocks refuses malformed and oversized bodies", async () => {
  const { routes, deps } = blocksDeps();
  expect((await handleBlocks(deps, post("{not json"))).status).toBe(400);
  expect((await handleBlocks(deps, post("null"))).status).toBe(401);
  expect((await handleBlocks(deps, post(report({ owners: "01" })))).status).toBe(400);
  expect((await handleBlocks(deps, post(report({ blocksX: 1e9 })))).status).toBe(400);
  // Too large by its declared length, and too large with no length declared (a chunked body).
  expect((await handleBlocks(deps, post(report({ pad: "x".repeat(MAX_BODY_BYTES) })))).status).toBe(413);
  const streamed = new Request("http://gateway.test/blocks", {
    method: "POST",
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES + 1))); controller.close(); } }),
    duplex: "half",
  } as RequestInit);
  expect(await readCapped(streamed, MAX_BODY_BYTES)).toBeNull();
  expect(routes.regionIds()).toEqual([]);
  // The biggest allowed table goes through.
  const biggest = await handleBlocks(deps, post(report({ blocksX: 256, blocksY: 256, owners: ".".repeat(MAX_BLOCKS) })));
  expect(biggest.status).toBe(200);
});

// The Mystika world: 794 maps with a block table, 790 of them houses of one block each, and the overworld, the
// underworld and the test world of 40 x 40 blocks. The store must hold every one of them, and far more.
const MEASURED_MAPS = 794;

test("a region holds every map a world reports, four times the real count, and /route answers the overworld's owner", async () => {
  const { routes, deps } = blocksDeps();
  // The overworld is 40 x 40 blocks: the left half belongs to node-1, the right half to node-2.
  const owners = Array.from({ length: 1600 }, (_, i) => (i % 40 < 20 ? "0" : "1")).join("");
  const maps = MEASURED_MAPS * 4;
  for (let i = 0; i < maps - 1; i++) {
    expect((await handleBlocks(deps, post(report({ map: `house_${i}_${i * 7}`, blocksX: 1, blocksY: 1, nodes: ["node-1"], owners: "0" })))).status).toBe(200);
  }
  const big = await handleBlocks(deps, post(report({ map: "overworld", blocksX: 40, blocksY: 40, owners })));
  expect(big.status).toBe(200);
  expect(await big.json()).toEqual({ success: true, stored: true });
  for (const map of ["house_0_0", `house_${maps - 2}_${(maps - 2) * 7}`, "overworld"]) expect(routes.tableOf("eu", map)).toBeDefined();
  const asked = async (x: number) => (await handleRoute({ routes, isValidAuthKey, liveNodes: () => new Set(["node-1", "node-2"]) }, new Request(`http://gateway.test/route?realm=eu&map=overworld&x=${x}&y=100`, { headers: { "x-gateway-key": KEY } })).json()).nodeId;
  expect(await asked(100)).toBe("node-1");
  expect(await asked(30 * 4096)).toBe("node-2");
  // The real data takes a small part of the region's budget.
  expect(routes.bytesOf("eu")).toBeLessThan(MAX_REGION_BYTES / 2);
  expect(routes.totalBytes()).toBe(routes.bytesOf("eu"));
});

// Tables of the largest size, all sharing one string, so the test costs no memory and the budget is reached in a few hundred maps.
const FULL = ".".repeat(MAX_BLOCKS);
const biggest = (over: Partial<RouteTable> = {}): RouteTable => table({ blocksX: 256, blocksY: 256, owners: FULL, ...over });

test("a region at its budget refuses a new map and a growing update; an update that keeps its size or shrinks always goes in", () => {
  const routes = new BlockRoutes();
  routes.accept("eu", "small", table());
  let held = 1;
  while (routes.accept("eu", `big-${held}`, biggest()) === "stored") held++;
  expect(held).toBeGreaterThan(100);
  // The rest of the budget goes to one-block maps, so less than one of them is left.
  for (let i = 0; routes.accept("eu", `filler-${i}`, table()) === "stored"; i++);
  expect(routes.bytesOf("eu")).toBeLessThanOrEqual(MAX_REGION_BYTES);
  expect(routes.bytesOf("eu")).toBeGreaterThan(MAX_REGION_BYTES - tableCost("filler-0000", table()));
  const bytes = routes.bytesOf("eu");
  // A new map is refused.
  expect(routes.accept("eu", "one-more", table())).toBe("full");
  expect(routes.tableOf("eu", "one-more")).toBeUndefined();
  // A held map is updated when the table keeps its size: a newer epoch, the same one, other owners.
  expect(routes.accept("eu", "big-1", biggest({ epoch: 2 }))).toBe("stored");
  expect(routes.accept("eu", "big-1", biggest({ epoch: 2, owners: "0".repeat(MAX_BLOCKS) }))).toBe("stored");
  expect(routes.tableOf("eu", "big-1")?.owners[0]).toBe("0");
  expect(routes.accept("eu", "small", table({ epoch: 5, owners: "111111" }))).toBe("stored");
  expect(routes.tableOf("eu", "small")?.epoch).toBe(5);
  expect(routes.bytesOf("eu")).toBe(bytes);
  // A table that grows is refused, and the old one is still served.
  const before = routes.tableOf("eu", "small");
  expect(routes.accept("eu", "small", biggest({ epoch: 6 }))).toBe("full");
  expect(routes.tableOf("eu", "small")).toBe(before);
  expect(routes.ownerOf("eu", "small", 0, 0)).toBe("node-2");
  expect(routes.bytesOf("eu")).toBe(bytes);
  // An older epoch is still stale, not full.
  expect(routes.accept("eu", "big-1", biggest({ epoch: 1 }))).toBe("stale");
  // A smaller table is taken (it frees room), and the room is a new map's, or the growth of another table.
  expect(routes.accept("eu", "big-2", table({ epoch: 9 }))).toBe("stored");
  expect(routes.bytesOf("eu")).toBeLessThan(bytes);
  expect(routes.accept("eu", "shrunk", biggest())).toBe("full");
  expect(routes.accept("eu", "small", table({ epoch: 7, blocksX: 3, blocksY: 40, owners: "0".repeat(120) }))).toBe("stored");
  expect(routes.accept("eu", "shrunk", table())).toBe("stored");
  // Another region has a budget of its own.
  expect(routes.accept("us", "first", biggest())).toBe("stored");
});

test("a held map grows while it fits the budget, and not past it", () => {
  const routes = new BlockRoutes();
  routes.accept("eu", "map", table());
  // Growing in steps: every step that fits is taken.
  for (const blocks of [100, 1000, 20000, MAX_BLOCKS]) {
    expect(routes.accept("eu", "map", table({ epoch: blocks, blocksX: blocks, blocksY: 1, owners: "0".repeat(blocks) }))).toBe("stored");
    expect(routes.bytesOf("eu")).toBe(tableCost("map", routes.tableOf("eu", "map")!));
  }
  // Fill the region with big maps, then grow the first of the others past what is left.
  routes.accept("eu", "tiny", table());
  while (routes.accept("eu", `big-${routes.regionIds().length}-${routes.bytesOf("eu")}`, biggest()) === "stored");
  const left = MAX_REGION_BYTES - routes.bytesOf("eu");
  expect(left).toBeLessThan(tableCost("x", biggest()));
  // Growth by more than what is left is refused, growth by exactly what is left fits.
  const grown = (extra: number) => table({ epoch: 3, blocksX: 6 + extra, blocksY: 1, owners: "0".repeat(6 + extra) });
  expect(routes.accept("eu", "tiny", grown(left + 1))).toBe("full");
  expect(routes.accept("eu", "tiny", grown(left))).toBe("stored");
  expect(routes.bytesOf("eu")).toBe(MAX_REGION_BYTES);
  expect(routes.accept("eu", "tiny", grown(left + 1))).toBe("full");
  expect(routes.accept("eu", "tiny", grown(left))).toBe("stored");
});

test("the bytes counted follow the maps held: replaced, smaller, stale and dropped", () => {
  const routes = new BlockRoutes();
  const one = tableCost("a", table());
  routes.accept("eu", "a", table());
  expect(routes.bytesOf("eu")).toBe(one);
  routes.accept("eu", "a", table({ epoch: 2 }));
  expect(routes.bytesOf("eu")).toBe(one);
  routes.accept("eu", "a", biggest({ epoch: 3 }));
  expect(routes.bytesOf("eu")).toBe(tableCost("a", biggest()));
  routes.accept("eu", "a", table({ epoch: 1 }));
  expect(routes.bytesOf("eu")).toBe(tableCost("a", biggest()));
  routes.accept("eu", "a", table({ epoch: 4 }));
  expect(routes.bytesOf("eu")).toBe(one);
  routes.accept("us", "a", table());
  expect(routes.totalBytes()).toBe(2 * one);
  expect(routes.dropRegion("eu")).toBe(true);
  expect(routes.totalBytes()).toBe(one);
  expect(routes.bytesOf("eu")).toBe(0);
  expect(routes.dropRegion("eu")).toBe(false);
  expect(routes.totalBytes()).toBe(one);
});

test("the store as a whole is bounded: by the regions it holds and by the bytes of all of them", () => {
  const routes = new BlockRoutes();
  for (let i = 0; i < MAX_REGIONS; i++) expect(routes.accept(`region-${i}`, "m", table())).toBe("stored");
  expect(routes.accept("one-too-many", "m", table())).toBe("full");
  expect(routes.regionIds().length).toBe(MAX_REGIONS);
  // A region held takes more maps and replaces its own.
  expect(routes.accept("region-0", "n", table())).toBe("stored");
  expect(routes.accept("region-0", "m", table({ epoch: 2 }))).toBe("stored");
  for (let i = 0; i < MAX_REGIONS; i++) routes.dropRegion(`region-${i}`);
  expect(routes.totalBytes()).toBe(0);

  // The total: regions are filled to their budget, one after another, until the store has no room for a new region.
  let regions = 0;
  while (routes.accept(`r-${regions}`, "big-0", biggest()) === "stored") {
    for (let i = 1; routes.accept(`r-${regions}`, `big-${i}`, biggest()) === "stored"; i++);
    regions++;
  }
  expect(regions).toBeGreaterThanOrEqual(MAX_TOTAL_BYTES / MAX_REGION_BYTES);
  expect(regions).toBeLessThan(MAX_REGIONS);
  expect(routes.totalBytes()).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  expect(routes.totalBytes() + tableCost("m", biggest())).toBeGreaterThan(MAX_TOTAL_BYTES);
  // The region that was refused for the total has room of its own, and a full store takes no new map, but replaces the ones it holds.
  expect(routes.bytesOf(`r-${regions}`)).toBeLessThan(MAX_REGION_BYTES);
  expect(routes.accept("r-0", "new-big", biggest())).toBe("full");
  expect(routes.accept("r-0", "big-0", biggest({ epoch: 2 }))).toBe("stored");
  // Dropping a region makes room again.
  routes.dropRegion("r-1");
  expect(routes.accept("another-region", "m", biggest())).toBe("stored");
});

/** A store whose total is used up by other regions while region "grow" holds one small map "m" and has room of its own. */
function storeAtTotal() {
  const servers = { "node-1": { regionId: "grow" } };
  const { routes, deps } = blocksDeps(servers);
  routes.accept("grow", "m", table());
  for (let r = 0; routes.accept(`r-${r}`, "big-0", biggest()) === "stored"; r++) {
    for (let i = 1; routes.accept(`r-${r}`, `big-${i}`, biggest()) === "stored"; i++);
  }
  // What is left of the total is filled with one-block maps, so less than one of them fits.
  for (let i = 0; routes.accept("fillers", `filler-${i}`, table()) === "stored"; i++);
  return { routes, deps };
}

test("a held table that grows past the store's total is refused and the old one is kept; a same-size update still goes in", () => {
  const { routes } = storeAtTotal();
  expect(routes.totalBytes() + tableCost("m", biggest())).toBeGreaterThan(MAX_TOTAL_BYTES);
  // The region has room of its own: only the total refuses.
  expect(routes.bytesOf("grow") + tableCost("m", biggest())).toBeLessThan(MAX_REGION_BYTES);
  const before = routes.tableOf("grow", "m");
  const bytes = routes.totalBytes();
  expect(routes.accept("grow", "m", biggest({ epoch: 5 }))).toBe("full");
  expect(routes.tableOf("grow", "m")).toBe(before);
  expect(routes.totalBytes()).toBe(bytes);
  expect(routes.accept("grow", "m", table({ epoch: 6, owners: "111111" }))).toBe("stored");
  expect(routes.tableOf("grow", "m")?.epoch).toBe(6);
  expect(routes.totalBytes()).toBe(bytes);
});

test("a refused growth answers 400 with an error that does not talk of another map", async () => {
  const { routes, deps } = storeAtTotal();
  const before = routes.tableOf("grow", "m");
  const res = await handleBlocks(deps, post(report({ map: "m", epoch: 5, blocksX: 256, blocksY: 256, nodes: ["node-1"], owners: FULL })));
  expect(res.status).toBe(400);
  const error = (await res.json()).error as string;
  expect(error).toContain("No room");
  expect(error).not.toContain("another");
  expect(routes.tableOf("grow", "m")).toBe(before);
});

// ---- the region's table and its nodes going away -------------------------------------------------------------------

test("a region's table goes when its last node goes, and stays while a node of the region is left", () => {
  const routes = new BlockRoutes();
  routes.accept("eu", "overworld", table());
  routes.accept("us", "overworld", table());
  // node-1 of eu is removed; node-2 of eu is still registered.
  expect(routes.dropRegionIfEmpty("eu", [{ regionId: "eu" }, { regionId: "us" }])).toBe(false);
  expect(routes.ownerOf("eu", "overworld", 0, 0)).toBe("node-1");
  // The last one is removed: only us is left.
  expect(routes.dropRegionIfEmpty("eu", [{ regionId: "us" }])).toBe(true);
  expect(routes.ownerOf("eu", "overworld", 0, 0)).toBeNull();
  expect(routes.ownerOf("us", "overworld", 0, 0)).toBe("node-1");
  // A server with no region (not a cluster node) drops nothing.
  expect(routes.dropRegionIfEmpty(undefined, [])).toBe(false);
});

test("a node that registers into a region with no live node starts its tables again; one with a live neighbour keeps them", () => {
  const routes = new BlockRoutes();
  routes.accept("eu", "overworld", table({ epoch: 900 }));
  const now = 1_000_000;
  const others = [{ id: "node-2", regionId: "eu", lastHeartbeat: now - 200_000 }, { id: "node-9", regionId: "us", lastHeartbeat: now }];
  // node-2's last heartbeat is older than the timeout: the run the table came from is over.
  expect(routes.dropRegionIfAlone("eu", "node-1", others, now, 90_000)).toBe(true);
  expect(routes.ownerOf("eu", "overworld", 0, 0)).toBeNull();
  routes.accept("eu", "overworld", table({ epoch: 900 }));
  expect(routes.dropRegionIfAlone("eu", "node-1", [{ id: "node-2", regionId: "eu", lastHeartbeat: now - 1000 }], now, 90_000)).toBe(false);
  // Its own earlier entry does not count as a neighbour.
  expect(routes.dropRegionIfAlone("eu", "node-1", [{ id: "node-1", regionId: "eu", lastHeartbeat: now }], now, 90_000)).toBe(true);
});

// ---- GET /route ----------------------------------------------------------------------------------------------------

function routeDeps(live: string[] = ["node-1", "node-2"]) {
  const routes = new BlockRoutes();
  const parsed = parseBlocksReport(FIXTURE);
  if (!parsed.ok) throw new Error("fixture");
  routes.accept("eu", parsed.map, parsed.table);
  return { routes, deps: { routes, isValidAuthKey, liveNodes: (region: string) => new Set(region === "eu" ? live : []) } };
}
const ask = (deps: ReturnType<typeof routeDeps>["deps"], query: string, key: string | null = KEY) =>
  handleRoute(deps, new Request(`http://gateway.test/route?${query}`, key === null ? undefined : { headers: { "x-gateway-key": key } }));

test("/route answers the owner the report names, including far-edge and negative points", async () => {
  const { deps } = routeDeps();
  const owner = async (map: string, x: number, y: number) => (await ask(deps, `realm=eu&map=${map}&x=${x}&y=${y}`).json()).nodeId;
  expect(await owner("overworld", 100, 100)).toBe("node-1");
  expect(await owner("overworld.json", 4100, 100)).toBe("node-2");
  expect(await owner("overworld", 8200, 100)).toBeNull();
  expect(await owner("overworld", 50000, 5000)).toBe("node-1");
  expect(await owner("overworld", -5, -5)).toBe("node-1");
  expect(await owner("overworld", 0, 99999)).toBe("node-2");
});

test("/route names nothing for an unknown map or realm, an unowned block, or an owner that is not alive", async () => {
  const { deps } = routeDeps(["node-2"]);
  const owner = async (query: string) => (await ask(deps, query).json()).nodeId;
  expect(await owner("realm=eu&map=overworld&x=100&y=100")).toBeNull();
  expect(await owner("realm=eu&map=overworld&x=4100&y=100")).toBe("node-2");
  expect(await owner("realm=eu&map=cave&x=100&y=100")).toBeNull();
  expect(await owner("realm=us&map=overworld&x=100&y=100")).toBeNull();
  expect(await owner("realm=eu&map=overworld&x=8200&y=100")).toBeNull();
});

test("/route needs the key and well-formed parameters", () => {
  const { deps } = routeDeps();
  expect(ask(deps, "realm=eu&map=overworld&x=1&y=1", null).status).toBe(401);
  expect(ask(deps, "realm=eu&map=overworld&x=1&y=1", "wrong").status).toBe(401);
  expect(ask(deps, "realm=eu&map=overworld&x=1&y=1").status).toBe(200);
  for (const query of ["map=overworld&x=1&y=1", "realm=eu&x=1&y=1", "realm=eu&map=overworld&y=1", "realm=eu&map=overworld&x=a&y=1", "realm=eu&map=overworld&x=1&y=", `realm=eu&map=${"m".repeat(200)}&x=1&y=1`]) {
    expect([query, ask(deps, query).status]).toEqual([query, 400]);
  }
});

// ---- the pick ----------------------------------------------------------------------------------------------------

type Node = { id: string; nodeId: string; regionId: string; status: string; activeConnections: number; lastHeartbeat?: number };
const node = (n: number, connections: number, over: Partial<Node> = {}): Node =>
  ({ id: `node-${n}`, nodeId: `node-${n}`, regionId: "eu", status: "online", activeConnections: connections, lastHeartbeat: 1000, ...over });

function picker(servers: Node[], opts: { owner?: string | null | "throw" | "hang"; regions?: string[] } = {}) {
  const calls = { status: 0, route: 0, aborted: false };
  const deps: PickDeps = {
    herd: new HerdSpread(),
    routeTimeoutMs: 30,
    async fetchStatus() {
      calls.status++;
      return { servers, ...((opts.regions ?? ["eu"]).length ? { regions: (opts.regions ?? ["eu"]).map((id) => ({ id })) } : {}) };
    },
    fetchRoute(_realm, _point, signal) {
      calls.route++;
      if (opts.owner === "throw") return Promise.reject(new Error("route down"));
      if (opts.owner === "hang") return new Promise(() => { signal.addEventListener("abort", () => { calls.aborted = true; }); });
      return Promise.resolve(opts.owner ?? null);
    },
  };
  return { calls, deps, pick: (realm: string | null, saved: Parameters<typeof pickRegionNode>[1]) => pickRegionNode(realm, saved, deps) };
}
const POINT = { map: "overworld", x: 100, y: 100 };

test("an online owner of the saved point is the node the ticket is bound to, even when it is the busiest", async () => {
  const { pick, calls } = picker([node(1, 5), node(2, 900), node(3, 40)], { owner: "node-2" });
  const picked = await pick("eu", POINT);
  expect(picked.nodeId).toBe("node-2");
  expect(calls.route).toBe(1);
});

test("an owner that is offline or full, or not listed, falls back to the least-loaded online node", async () => {
  for (const status of ["offline", "full"]) {
    const { pick } = picker([node(1, 50), node(2, 0, { status }), node(3, 20)], { owner: "node-2" });
    expect((await pick("eu", POINT)).nodeId).toBe("node-3");
  }
  const { pick } = picker([node(1, 50), node(3, 20)], { owner: "node-9" });
  expect((await pick("eu", POINT)).nodeId).toBe("node-3");
});

test("no saved point, an unknown map, a route error or a route that hangs all give today's least-loaded pick", async () => {
  const servers = () => [node(1, 50), node(2, 10), node(3, 20)];
  const noRow = picker(servers(), { owner: "node-1" });
  expect((await noRow.pick("eu", null)).nodeId).toBe("node-2");
  expect(noRow.calls.route).toBe(0);
  const unknownMap = picker(servers(), { owner: null });
  expect((await unknownMap.pick("eu", POINT)).nodeId).toBe("node-2");
  expect((await picker(servers(), { owner: "throw" }).pick("eu", POINT)).nodeId).toBe("node-2");
  const hang = picker(servers(), { owner: "hang" });
  const started = Date.now();
  expect((await hang.pick("eu", POINT)).nodeId).toBe("node-2");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(hang.calls.aborted).toBe(true);
  // The default wait is short.
  expect(ROUTE_TIMEOUT_MS).toBe(300);
});

test("without routeTimeoutMs a hanging route is given up after the default wait and the least-loaded node is picked", async () => {
  const hang = picker([node(1, 50), node(2, 10), node(3, 20)], { owner: "hang" });
  delete hang.deps.routeTimeoutMs;
  const started = Date.now();
  expect((await hang.pick("eu", POINT)).nodeId).toBe("node-2");
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(ROUTE_TIMEOUT_MS - 50);
  expect(waited).toBeLessThan(2000);
  expect(hang.calls.aborted).toBe(true);
});

test("one online node is the pick without asking the gateway who owns the saved point", async () => {
  const { pick, calls } = picker([node(1, 50), node(2, 0, { status: "offline" })], { owner: "node-2" });
  expect((await pick("eu", POINT)).nodeId).toBe("node-1");
  expect(calls.route).toBe(0);
});

test("a realm that is not a cluster region gets no bound node and no route call; no realm, an unreadable gateway and an empty region are as before", async () => {
  const plain = picker([{ ...node(1, 0), regionId: "" }], { regions: [] });
  expect(await plain.pick("realm-one", POINT)).toBeNull();
  expect(plain.calls.route).toBe(0);
  const other = picker([node(1, 0)], { owner: "node-1" });
  expect(await other.pick("us", POINT)).toBeNull();
  expect(other.calls.route).toBe(0);
  expect(await other.pick(null, POINT)).toBeNull();
  const broken = picker([node(1, 0)]);
  broken.deps.fetchStatus = async () => { throw new Error("gateway down"); };
  const warnings: string[] = [];
  broken.deps.warn = (message) => warnings.push(message);
  expect(await broken.pick("eu", POINT)).toBeNull();
  expect(warnings.length).toBe(1);
  const empty = picker([node(1, 0, { status: "offline" })], { owner: "node-1" });
  expect(await empty.pick("eu", POINT)).toBe("unavailable");
  expect(empty.calls.route).toBe(0);
});

test("a burst of picks with no owner spreads over the nodes until the next heartbeat", async () => {
  const servers = [node(1, 10), node(2, 10), node(3, 10)];
  const { pick, deps } = picker(servers);
  const burst = async () => { const ids: string[] = []; for (let i = 0; i < 7; i++) ids.push((await pick("eu", null)).nodeId); return ids; };
  // Every node reports 10, so the picks go round: without the local count all seven would go to node-1.
  expect(await burst()).toEqual(["node-1", "node-2", "node-3", "node-1", "node-2", "node-3", "node-1"]);
  // A node that had fewer connections is used until it catches up.
  const uneven = picker([node(1, 12), node(2, 10), node(3, 10)]);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await uneven.pick("eu", null)).nodeId);
  expect(ids).toEqual(["node-2", "node-3", "node-2", "node-3", "node-1"]);
  // The next heartbeat of a node replaces the local count with the one it reports.
  servers[0]!.lastHeartbeat = 2000;
  servers[0]!.activeConnections = 10;
  expect(deps.herd.extra(servers[0]!)).toBe(0);
  expect((await pick("eu", null)).nodeId).toBe("node-1");
  expect(deps.herd.extra(servers[0]!)).toBe(1);
});

test("an owner pick counts as a connection on that node too, and the herd table cannot outgrow the listed nodes", async () => {
  const servers = [node(1, 10), node(2, 10)];
  const { pick, deps } = picker(servers, { owner: "node-1" });
  await pick("eu", POINT);
  await pick("eu", POINT);
  expect(deps.herd.extra(servers[0]!)).toBe(2);
  // Picks without an owner now go to the node that has none counted.
  deps.fetchRoute = async () => null;
  expect((await pick("eu", POINT)).nodeId).toBe("node-2");
  servers.length = 0;
  servers.push(node(2, 10));
  await pick("eu", null);
  expect(deps.herd.size()).toBe(1);
});

test("the local count also expires with the clock when the gateway does not say when a node last beat", () => {
  let now = 0;
  const herd = new HerdSpread(() => now);
  const listed = { nodeId: "node-1" };
  herd.chose(listed);
  expect(herd.extra(listed)).toBe(1);
  now = 20_000;
  expect(herd.extra(listed)).toBe(0);
});

// ---- the saved point ---------------------------------------------------------------------------------------------

test("the saved point follows the game server's spawn rule", () => {
  expect(savedPointOf({ map: "overworld", position: "5000,300", is_dead: 0 })).toEqual({ map: "overworld", x: 5000, y: 300 });
  expect(savedPointOf({ map: "overworld.json", position: "5000.5,300", is_dead: 0 })).toEqual({ map: "overworld", x: 5000.5, y: 300 });
  // A corpse awaiting release: the player resumes at the corpse.
  expect(savedPointOf({ map: "overworld", position: "5000,300", is_dead: 1, corpse_map: "cave", corpse_x: 12, corpse_y: 0 })).toEqual({ map: "cave", x: 12, y: 0 });
  // Dead with no corpse, and a ghost (2): where it logged out.
  expect(savedPointOf({ map: "overworld", position: "5000,300", is_dead: 1, corpse_map: null })).toEqual({ map: "overworld", x: 5000, y: 300 });
  expect(savedPointOf({ map: "overworld", position: "5000,300", is_dead: 2, corpse_map: "cave", corpse_x: 1, corpse_y: 1 })).toEqual({ map: "overworld", x: 5000, y: 300 });
  // A corpse with the usual database types.
  expect(savedPointOf({ map: "overworld", position: "1,1", is_dead: "1", corpse_map: "cave", corpse_x: "70", corpse_y: "80" })).toEqual({ map: "cave", x: 70, y: 80 });
});

test("a row that cannot name the spawn point gives no point", () => {
  expect(savedPointOf(undefined)).toBeNull();
  expect(savedPointOf(null)).toBeNull();
  expect(savedPointOf({})).toBeNull();
  expect(savedPointOf({ map: "", position: "5,5" })).toBeNull();
  expect(savedPointOf({ map: "overworld", position: null })).toBeNull();
  // A new character (0,0), a missing or non-numeric coordinate: the game server puts those on the spawn or the centre.
  expect(savedPointOf({ map: "overworld", position: "0,0" })).toBeNull();
  expect(savedPointOf({ map: "overworld", position: "500," })).toBeNull();
  expect(savedPointOf({ map: "overworld", position: "abc,5" })).toBeNull();
  expect(savedPointOf({ map: "overworld", position: "" })).toBeNull();
});

// ---- the webserver's call to /route ------------------------------------------------------------------------------

const SECRET = "s3cret-gateway-key";
function routeFetch(answer: (url: string, init: RequestInit) => Promise<Response>, key: string | null = SECRET) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return { calls, deps: { base: "http://127.0.0.1:9998", key: key ?? undefined, fetch: (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(url, init); } } };
}
const answers = (body: unknown) => async () => new Response(JSON.stringify(body));

test("the route call sends the key in the x-gateway-key header and never in the URL", async () => {
  const { calls, deps } = routeFetch(answers({ nodeId: "node-2" }));
  expect(await fetchGatewayRoute(deps, "eu", { map: "overworld", x: 4100.5, y: 99 }, new AbortController().signal)).toBe("node-2");
  expect(calls.length).toBe(1);
  const url = new URL(calls[0]!.url);
  expect(url.origin + url.pathname).toBe("http://127.0.0.1:9998/route");
  expect(Object.fromEntries(url.searchParams)).toEqual({ realm: "eu", map: "overworld", x: "4100.5", y: "99" });
  expect(calls[0]!.url).not.toContain(SECRET);
  expect(calls[0]!.url.toLowerCase()).not.toContain("key");
  expect((calls[0]!.init.headers as Record<string, string>)["x-gateway-key"]).toBe(SECRET);
  expect(calls[0]!.init.method).toBe("GET");
  // The key is not in a body either.
  expect(calls[0]!.init.body).toBeUndefined();
});

test("without a key nothing is asked; a non-2xx answer is an error; a missing nodeId is no owner", async () => {
  const none = routeFetch(answers({ nodeId: "node-1" }), null);
  expect(await fetchGatewayRoute(none.deps, "eu", POINT, new AbortController().signal)).toBeNull();
  expect(await fetchGatewayRoute(routeFetch(answers({ nodeId: "node-1" }), "").deps, "eu", POINT, new AbortController().signal)).toBeNull();
  expect(none.calls.length).toBe(0);
  const refused = routeFetch(async () => new Response("{}", { status: 401 }));
  await expect(fetchGatewayRoute(refused.deps, "eu", POINT, new AbortController().signal)).rejects.toThrow("401");
  expect(await fetchGatewayRoute(routeFetch(answers({ nodeId: null })).deps, "eu", POINT, new AbortController().signal)).toBeNull();
  expect(await fetchGatewayRoute(routeFetch(answers({ nodeId: 5 })).deps, "eu", POINT, new AbortController().signal)).toBeNull();
});

test("through the pick: a route call that errors, is refused, has no key or hangs gives the least-loaded node", async () => {
  const servers = [node(1, 50), node(2, 10), node(3, 20)];
  const pickWith = async (route: ReturnType<typeof routeFetch>, timeout = 30) => {
    const base = picker(servers).deps;
    const deps: PickDeps = { ...base, routeTimeoutMs: timeout, fetchRoute: (realm, point, signal) => fetchGatewayRoute(route.deps, realm, point, signal) };
    return (await pickRegionNode("eu", POINT, deps)).nodeId;
  };
  expect(await pickWith(routeFetch(answers({ nodeId: "node-3" })))).toBe("node-3");
  expect(await pickWith(routeFetch(async () => { throw new Error("connection refused"); }))).toBe("node-2");
  expect(await pickWith(routeFetch(async () => new Response("{}", { status: 500 })))).toBe("node-2");
  const keyless = routeFetch(answers({ nodeId: "node-3" }), null);
  expect(await pickWith(keyless)).toBe("node-2");
  expect(keyless.calls.length).toBe(0);
  let aborted = false;
  const hang = routeFetch((_url, init) => new Promise<Response>(() => { init.signal?.addEventListener("abort", () => { aborted = true; }); }));
  expect(await pickWith(hang)).toBe("node-2");
  expect(aborted).toBe(true);
});

// ---- the gateway's live nodes --------------------------------------------------------------------------------------

test("only a node of the region with a heartbeat inside the timeout is live", () => {
  const now = 1_000_000;
  const servers = [
    { regionId: "eu", nodeId: "node-1", lastHeartbeat: now - 1000 },
    { regionId: "eu", nodeId: "node-2", lastHeartbeat: now - 90_000 },
    { regionId: "eu", nodeId: "node-3", lastHeartbeat: now - 89_999 },
    { regionId: "us", nodeId: "node-4", lastHeartbeat: now },
    { regionId: "eu", lastHeartbeat: now },
    { nodeId: "node-6", lastHeartbeat: now },
  ];
  expect([...liveNodesOf(servers, "eu", now, 90_000)].sort()).toEqual(["node-1", "node-3"]);
  expect([...liveNodesOf(servers, "us", now, 90_000)]).toEqual(["node-4"]);
  expect([...liveNodesOf(servers, "asia", now, 90_000)]).toEqual([]);
});

// ---- the glue in the two server files ------------------------------------------------------------------------------
// The servers start listeners when loaded, so these read their source, as the engine's wiring checks do.

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** The text from `start` up to `until`. */
const between = (text: string, start: string, until: string) => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(until, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
};

test("the webserver's token route reads the saved point, passes it to the pick, and asks /route with the header key", () => {
  const web = source("../webserver/server.ts");
  // The wide account query, and the old one when it fails.
  const read = between(web, "let accountRow: any[];", "// The engine refuses this account");
  expect(read).toContain("SELECT email_verified, guest_mode, map, position, is_dead, corpse_map, corpse_x, corpse_y FROM accounts WHERE username = ?");
  expect(read).toMatch(/catch \{\s*accountRow = await query\("SELECT email_verified, guest_mode FROM accounts WHERE username = \?/);
  // The pick gets the point.
  expect(web).toMatch(/await pickRegionNode\([^\n]*savedPointOf\(accountRow\[0\]\)\)/);
  // The route call is the extracted one, with the shared key, and no URL with a route query is built here.
  const ask = between(web, "const askGatewayRoute", "const regionHerd");
  expect(ask).toContain("fetchGatewayRoute({ fetch: serverFetch, base: gatewayInternalUrl(), key: process.env.GATEWAY_AUTH_KEY }");
  expect(web).toContain("fetchRoute: askGatewayRoute");
  expect(web).not.toMatch(/\/route\?/);
  expect(web).toContain("herd: regionHerd");
});

test("the gateway wires /blocks and /route, drops a region's tables with its last node, and answers /route from live nodes", () => {
  const gw = source("../gateway/server.ts");
  expect(gw).toContain("const blockRoutes = new BlockRoutes();");
  expect(gw).toContain("liveNodesOf(gameServers.values(), regionId, Date.now(), config.serverTimeout)");
  expect(gw).toContain('url.pathname === "/blocks" && req.method === "POST"');
  expect(gw).toContain("handleBlocks({ routes: blockRoutes, isValidAuthKey, server: (id) => gameServers.get(id) }, req)");
  expect(gw).toContain('url.pathname === "/route" && req.method === "GET"');
  expect(gw).toContain("handleRoute({ routes: blockRoutes, isValidAuthKey, liveNodes: liveNodeIds }, req)");
  // Both routes are the gateway's own, not proxied to a game server.
  expect(gw).toMatch(/const gatewayRoutes = \[[^\]]*'\/blocks'[^\]]*\]/);
  expect(gw).toMatch(/const gatewayRoutes = \[[^\]]*'\/route'[^\]]*\]/);
  // The three places a region can lose its last node or start again.
  expect(between(gw, "function cleanupDeadServers", "function cleanupExpiredSessions")).toContain("blockRoutes.dropRegionIfEmpty(server.regionId, gameServers.values())");
  expect(between(gw, 'url.pathname === "/unregister"', 'url.pathname === "/api/session"')).toContain("blockRoutes.dropRegionIfEmpty(leaving?.regionId, gameServers.values())");
  const register = between(gw, 'url.pathname === "/register"', 'url.pathname === "/heartbeat"');
  expect(register).toContain("blockRoutes.dropRegionIfAlone(server.regionId, id, gameServers.values(), Date.now(), config.serverTimeout)");
  // The drop comes after the key check and before the server is stored.
  expect(register.indexOf("isValidAuthKey(authKey)")).toBeLessThan(register.indexOf("dropRegionIfAlone"));
  expect(register.indexOf("dropRegionIfAlone")).toBeLessThan(register.indexOf("gameServers.set(id, server)"));
});
