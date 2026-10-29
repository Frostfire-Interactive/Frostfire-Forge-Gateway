---
title: AOI and Layers
description: How the engine decides who sees whom: area of interest, the spatial grid, blocks and layers, automatic condensing, party layer sync and every aoi.json setting.
order: 30
---

A player only receives updates about players close to them. This page explains the area of interest (AOI) system that decides who is "close", the blocks and layers that split a busy map into instances, and the settings in `src/config/aoi.json`.

## The pieces

| File | What it holds |
|------|---------------|
| `src/socket/aoi.ts` | AOI state per player, enter and exit logic, the visible player cap, AOI broadcasts, party layer sync, layer condensing |
| `src/services/layermanager.ts` | `layerManager`: which layer each player is on, and how many players of each layer stand in each block |
| `src/services/spatialgrid.ts` | `spatialGrid`: players bucketed into square cells per map |
| `src/services/mapindex.ts` | `mapIndex`: which players are on which map |
| `src/services/aoiReverseIndex.ts` | The reverse lookup: who can see a given player |
| `src/cluster/layerseq.ts` | Cluster mode: layer numbers that are the same on every node |
| `src/config/aoi.json` | Tuning values |

## Area of interest

Each online player carries an `aoi` object, created at login by `initializePlayerAOI`:

```ts title="src/socket/aoi.ts"
player.aoi = {
  playersInAOI: new Set<string>(),
  gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
  gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
  aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
  lastAOIUpdatePosition: { x: pos.x, y: pos.y },
  updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
  mapChangeSequence: 0,
  layerId: layerId,
  revision: 0,
};
```

`playersInAOI` is the set of player ids this player can currently see. Two players see each other when they are on the same map, on the same layer, and within `aoiRadius` pixels of each other. Blocks do not shape this circle: a block only decides which layer a player is placed on (see [Blocks and layers](#/engine/aoi-and-layers/blocks-and-layers)).

### When the AOI is recalculated

Recalculating on every step would be wasteful, so two conditions must both hold while a player walks:

1. The game loop says an AOI update is due for the player. It becomes due at a steady pace while the player moves (`gameLoop.isAOIUpdateDue`), whatever the tick rate.
2. The player has moved more than `UPDATE_THRESHOLD` pixels since the last recalculation (`shouldUpdateAOI`).

```ts title="src/socket/handlers/movement.ts"
if (gameLoop.isAOIUpdateDue(currentPlayer.id) && shouldUpdateAOI(currentPlayer)) {
  await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
}
```

Map changes and layer changes recalculate straight away, without waiting for the game loop.

### Entering and leaving

`updatePlayerAOI` compares the new set of nearby players with the old one.

| Change | Result |
|--------|--------|
| A player came within the radius | Both sides get a spawn queued for the other, and each is added to the other's `playersInAOI` |
| A player went beyond the radius times `EXIT_HYSTERESIS` | Both sides get a despawn (reason `distance`) |
| A player is between the radius and the radius times `EXIT_HYSTERESIS` | Nothing: they stay visible |

The band between the two is the exit hysteresis. Without it, two players walking along the edge of each other's radius would spawn and despawn over and over.

Spawns and despawns are not sent one by one. They are collected in batch queues and flushed together on a short timer, despawns first, so a player is removed before the same player is added again.

### How many players a viewer sees

`MAX_VISIBLE_PLAYERS` is the most players one viewer is sent. When the players in range are more than that, `capVisible` picks who stays:

1. Priority players always stay: the viewer's party members, the player they have selected, and a player who attacked them a moment ago (`isPriorityFor`).
2. The nearest of the rest fill the remaining places. Players the viewer is not shown, because of stealth or vanish, rank after everyone they are shown, so they never take a place from a visible player.
3. Players already in the set rank as if they were `EXIT_HYSTERESIS` times nearer, so two players trading places by a few pixels do not swap on every update.

When a viewer's set is full and a player walks up who is clearly nearer than the farthest non-priority member, that member is despawned for the viewer and the newcomer takes the place (`evictFarthestFor`). This also works for a viewer who stands still and runs no AOI update of their own.

### Who is hidden

Being in range is not always enough. A player in stealth or vanished is only spawned for viewers who are admins, who are in the same party, or who are linked to them through a `forceVisibleTo` set (`canSee`).

### Sending to an AOI

Most gameplay packets go to "everyone who can see this player". The helpers in `aoi.ts`:

| Function | Sends to |
|----------|----------|
| `broadcastToAOI(sourcePlayer, packetData, includeSelf = true)` | The source's `playersInAOI` on the reliable stream. For a hidden source, only admins and party members. |
| `broadcastToAOIBestEffort(sourcePlayer, packetData, includeSelf = true)` | The same players, as datagrams. Only for packets where the newest one wins. |
| `broadcastToAOIBestEffortAtPosition(x, y, map, packetData, layerId?)` | Every player on the map whose own radius covers the point, optionally on one layer |
| `findPlayersWithTargetInAOI(targetId)` | Returns the players who can see `targetId`, using the reverse index |

```ts title="Sending to everyone who can see a player"
import { broadcastToAOI } from "@engine/socket/aoi";
import { packetManager } from "@engine/socket/packet_manager";

broadcastToAOI(player, packetManager.notify({ message: "A cold wind blows" }));
```

### The reverse index

`playersInAOI` answers "who can this player see". Regeneration and similar updates need the opposite question, "who can see this player". Scanning all players for that is quadratic, so `aoiReverseIndex.ts` keeps a second map from a viewed player to its viewers. Every change to a `playersInAOI` set in `aoi.ts` is mirrored there (`addViewer`, `removeViewer`, `replaceVisibleSet`).

:::warning
If you ever change a `playersInAOI` set outside `aoi.ts`, the reverse index goes out of step. Use the functions in `aoi.ts`.
:::

## The spatial grid

`spatialGrid` divides every map into square cells and remembers which players stand in each cell, keyed as `map:cellX:cellY`. A radius query only looks at the cells the circle touches.

```ts title="src/services/spatialgrid.ts"
private getCellKey(x: number, y: number, map: string): string {
  const cellX = Math.floor(x / this.cellSize);
  const cellY = Math.floor(y / this.cellSize);
  return `${map}:${cellX}:${cellY}`;
}
```

| Method | Purpose |
|--------|---------|
| `addPlayer(playerId, x, y, map)` | Put a player into their cell |
| `updatePlayer(playerId, x, y, map)` | Move them. Returns `true` when the cell changed. |
| `removePlayer(playerId)` | Take them out |
| `getPlayersInRadius(x, y, radius, map)` | Ids of everyone in the cells that the circle touches (candidates, not yet distance checked) |
| `getPlayersInCell(x, y, map)` | Ids in one cell |

The grid is kept up to date when `USE_SPATIAL_GRID` is `true`: on login, on every movement tick, on every AOI recalculation and on map changes.

Two details are worth knowing:

- Player to player visibility queries the grid for the candidates around the player, so the cost follows the local crowd and not the size of the map or of a layer. The grid does not know about layers: candidates on other layers are dropped with one lookup of their layer before anything else is read about them (`filterPlayersByDistance`). The query adds a small margin around the radius, because a player's cell is only refreshed when they move, and the exact distance check uses their live position.
- The creature system queries the grid too, to find players near a creature for aggro, with a margin for the same reason.

:::note Cell size
The shared grid is created with a cell size of its own (`new SpatialGrid(...)` in `spatialgrid.ts`). `GRID_CELL_SIZE` in `aoi.json` sets the `gridX` and `gridY` values stored on each player's `aoi` object, not the size of the shared grid's cells. Keep it at its default so both agree.
:::

## Blocks and layers

### Blocks

A block is a square of a map, `BLOCK_SIZE_PX` pixels on a side, named by its grid coordinates (`blockOf` in `layermanager.ts`): the block of a point is its x and y divided by the block size, rounded down. Every position on a map is in exactly one block.

Blocks are how layers are counted. The layer manager keeps, for every layer, how many of its players stand in each block. The same grid cuts the map up in cluster mode, where each block has one owner node. See [Blocks and owners](#/engine/cluster/blocks-and-owners).

### Layers

A layer is an instance of a map. Players on different layers of the same map never see each other, which keeps a crowded spot playable. Because layers are counted per block, a big map splits only where one area is crowded: a layer that is full in one block still has room in every other block.

Layer ids look like `overworld:layer_1`, `overworld:layer_2` and so on. Layer 1 is the base layer of every map. The higher layers are overflow layers (`isBaseLayer`). A layer that becomes empty is deleted.

### Placing a player

`layerManager` places a player on a layer:

```ts title="src/services/layermanager.ts"
assignPlayerToLayer(playerId: string, mapName: string, x: number, y: number, preferredLayerId?: string): string
```

1. The player is removed from their current layer.
2. The block of `x`, `y` is worked out.
3. If a preferred layer is given, exists on that map and has room in that block, the player joins it.
4. Otherwise the player joins the lowest-numbered layer of that map that has room in that block.
5. If no layer has room in the block, a new layer is created.

A layer has room in a block while fewer than `MAX_PLAYERS_PER_LAYER` of its players stand there. Placing the player is what checks this: at login, on a map change, and on a summon or teleport.

Joining the lowest layer with room means players settle into the low layers, and the high ones empty out and disappear.

### Walking between blocks

`updatePlayerAOI` keeps the block counts right as a player walks (`updatePlayerBlock`). A player on an overflow layer, who was placed there because their block was crowded, moves down to the lowest lower-numbered layer that has room in the block they walk into. Party members who share the player's layer keep them where they are, because party sync keeps a party together. A player is never moved to a higher-numbered layer by walking.

When a player moves to another layer, they are despawned for everyone on the old layer, and their AOI is rebuilt from the new layer.

Changing map places the player on a layer of the new map the same way as at login (`handleMapChangeAOI`). The player is despawned for everyone on the old map first.

| Method | Returns |
|--------|---------|
| `getPlayerLayer(playerId)` | The player's layer id, or `null` |
| `getPlayersInLayer(layerId)` | Player ids on that layer |
| `getPlayersInSameLayer(playerId)` | Player ids sharing the player's layer |
| `getLayersForMap(mapName)` | Every layer of a map with its player count |
| `getLayerInfo(layerId)` | One layer, or `null` |
| `countInBlock(layerId, block)` | How many of the layer's players stand in the block |
| `lowerLayerWithRoom(playerId)` | The lowest lower-numbered layer with room in the player's block, or `null` |
| `getStats()` | Total layers, total players and layers per map |

```ts title="Reading layer information"
import layerManager from "@engine/services/layermanager";

const layerId = layerManager.getPlayerLayer(player.id);
const neighbours = layerId ? layerManager.getPlayersInLayer(layerId) : [];
```

Movement batches are grouped by layer too: each layer's movers are flushed together, and a layer with many receivers is encoded on a movement worker thread. See [Networking](#/engine/networking/datagrams-and-movement-batching).

### Layers in a cluster

In cluster mode every node runs its own `layerManager` for the players it owns. Layer 1 is the base layer of the map on every node. The numbers of the layers above it come from one counter per map in Redis (`LayerNumbers` in `src/cluster/layerseq.ts`), so two nodes never use the same layer name for different crowds. Each node keeps a few numbers reserved ahead, so opening a layer is a local step.

A player mirrored from a neighbouring node keeps the layer its owner gave it, and a viewer sees a mirror only when both are on the same layer (`playerLayer` in `src/cluster/mirrors.ts`). That is how a crowd keeps its layer across a border. See [Mirrors](#/engine/cluster/mirrors) and [Cluster](#/engine/cluster).

## Party layer sync

Party members should be able to see each other, so the engine tries to keep a party on one layer.

### At login

`initializePlayerAOI` looks for online party members on the same map:

- The party leader joins the layer where most of their party already is, if it has room in the block they log in at.
- Any other member joins the leader's layer, if the leader is online on that map and the layer has room in the block they log in at.
- Otherwise the player gets a normal layer.

### When the party changes

The party handlers in `src/socket/handlers/social.ts` call `syncPartyLayers` after a change such as a member joining, and the player editor does the same.

```ts title="src/socket/aoi.ts"
export async function syncPartyLayers(
  partyLeaderUsername: string,
  partyMemberUsernames: string[],
  playerCache: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void>
```

It moves every online member on the leader's map to the leader's layer, one by one, when the leader's layer has room in the block that member stands in (`syncPartyToLeaderLayer`). Each moved member is despawned for the players on their old layer, gets their AOI recalculated on the new one, and receives the players there together with their current animations.

### On a timer

`startAutoPartyLayerSync` runs on a timer. It walks every party and calls `syncPartyLayers` for any party that has a member on the leader's map but on a different layer. This catches members who arrived on the map after the party was formed, and members the leader's layer had no room for in their block at the time.

## Auto condensing

Players leave, and a map can end up with overflow layers holding a few players each. `startAutoLayerCondensation` runs `condenseLayers` on a timer.

A pass works per player and per block:

1. The overflow layers (every layer above layer 1) are taken from the lowest number up.
2. Each player on one of them looks for the lowest layer of their map that has room in the block where they stand (`lowerLayerWithRoom`). It is never a higher-numbered layer, and the size of a layer as a whole plays no part, since one layer of a big map spreads over many blocks.
3. A player who finds one moves there. They are despawned for their old neighbours, their AOI is recalculated, and the new neighbours are sent to them.

The block counts are live, so a player moved earlier in the pass counts, and a player of a higher layer can take the place a lower layer's player just left.

Both timers are started once, from `server.ts`:

```ts title="src/socket/server.ts"
await creatures.init();
await gathering.init();
await fishing.init();
await achievements.init();
startAutoPartyLayerSync(sendAnimationTo);
startAutoLayerCondensation(sendAnimationTo);
```

## aoi.json settings

`src/config/aoi.json` is written by `bun create-config`. On later runs missing keys are added and `USE_SPATIAL_GRID` is set back to `true`. The file is imported as a module, so changes need a restart. The defaults are in the [Configuration](#/engine/configuration/aoijson) reference.

| Key | What it does |
|-----|--------------|
| `DEFAULT_RADIUS` | View distance in pixels. Players within this distance on the same layer see each other. Also used for position based broadcasts. |
| `UPDATE_THRESHOLD` | Pixels a player must move before their AOI is recalculated |
| `GRID_CELL_SIZE` | Divisor for the `gridX` and `gridY` values on a player's `aoi` object |
| `USE_SPATIAL_GRID` | Keeps `spatialGrid` up to date. Forced to `true` by `create-config`, because the AOI and creature aggro depend on it. When it is `false` the AOI falls back to scanning the players on the map. |
| `MAX_PLAYERS_PER_LAYER` | How many players of one layer may stand in one block. It is checked when a player is placed on a layer. When every layer of the map is full in the block, a new layer is created. |
| `BLOCK_SIZE_PX` | Side of a block in pixels. Sets the squares that layer capacity is counted in. In cluster mode it also sets the block grid, so use the same value on every node and coordinator. |
| `MAX_VISIBLE_PLAYERS` | The most players one viewer is sent. Priority players first, then the nearest. See [How many players a viewer sees](#/engine/aoi-and-layers/how-many-players-a-viewer-sees). |
| `NEAR_TIER_DISTANCE` | Distance in pixels inside which a mover is sent to a receiver on every movement update (`src/socket/movement_batch.ts`) |
| `FAR_UPDATE_EVERY` | How often a mover beyond `NEAR_TIER_DISTANCE` is sent, counted in ticks of the base tick rate. The client interpolates between the updates. `1` sends every mover at the full rate. |
| `EXIT_HYSTERESIS` | Multiplier on the radius before a visible player is dropped. Also the margin that keeps players already in a set ahead of newcomers when the set is full. |
| `SPATIAL_GRID_THRESHOLD` | Reserved |
| `DEBUG` | Reserved |

:::tip Choosing values
A larger `DEFAULT_RADIUS` means more players per AOI and more spawn and movement traffic. A larger `MAX_PLAYERS_PER_LAYER` keeps more of a crowd together on one layer in each block, and a smaller one opens overflow layers sooner. `MAX_VISIBLE_PLAYERS` is the knob that bounds what one client has to draw, whatever the crowd. `MAX_PLAYERS_PER_LAYER` and `MAX_VISIBLE_PLAYERS` are generated with the same default.
:::

## Related pages

- [Cluster](#/engine/cluster): blocks, owner nodes and mirrors across a border
- [Networking](#/engine/networking): how spawns, despawns and movement reach the client
- [Game loop](#/engine/game-loop): the tick that drives movement and the AOI updates
- [Configuration](#/engine/configuration/aoijson): the defaults of every aoi.json key
- [Benchmarking](#/engine/benchmarking): measuring the effect of these settings under load
