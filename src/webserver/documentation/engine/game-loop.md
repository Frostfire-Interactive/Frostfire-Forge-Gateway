---
title: Game Loop
description: The 30 Hz movement loop, the tick events and their intervals, the three worker pools and the startup sequence of the server.
order: 40
---

The engine has no single "update everything" loop. Movement runs on a 30 Hz loop that only touches players who are moving, a handful of timers emit tick events for everything else, and heavy work is pushed to worker threads. This page describes each of those and the order in which `src/socket/server.ts` starts them.

## The movement loop

`src/services/gameloop.ts` exports one `gameLoop` object. It ticks every `1000 / 30` milliseconds. Each tick first runs the tick hooks (the tornado pull is one), then steps the movers. When nobody is moving, the hooks are all it does.

```ts title="src/services/gameloop.ts"
private readonly FRAME_TIME = 1000 / 30;

start(): void {
  if (this.loopInterval) return;
  this.loopInterval = setInterval(() => this.tick(), this.FRAME_TIME);
}

private async tick(): Promise<void> {
  for (const hook of this.tickHooks) {
    try {
      await hook();
    } catch (error) {
      log.error(`A game loop hook failed: ${error}`);
    }
  }
  if (this.movingPlayers.size === 0) return;

  const tickPromises: Promise<void>[] = [];
  for (const [playerId, playerState] of this.movingPlayers.entries()) {
    if (playerState.running) continue;
    tickPromises.push(this.processPlayer(playerId, playerState));
  }

  if (tickPromises.length > 0) {
    await Promise.all(tickPromises);
  }
}
```

A player enters the loop when they start walking and leaves it when they stop.

| Method | Purpose |
|--------|---------|
| `start()` / `stop()` | Start or stop the interval |
| `addTickHook(hook)` | Run a function at the start of every tick, before the movers step, whether or not anyone is moving |
| `registerMovingPlayer(playerId, moveCallback)` | Add a mover, or replace the callback of one that is already moving |
| `unregisterMovingPlayer(playerId)` | Remove a mover |
| `isPlayerMoving(playerId)` | Whether the player is in the loop |
| `getAOIUpdateCounter(playerId)` | Ticks processed for this mover, used to space out AOI updates |
| `getStats()` | `{ movingPlayers, isRunning }` |

### One step

When a `MOVEXY` packet with a direction arrives, `receiver.ts` builds a `movePlayer` callback for that player and registers it:

```ts title="src/socket/receiver.ts"
gameLoop.registerMovingPlayer(currentPlayer.id, movePlayer);

if (!wasAlreadyMoving) {
  await movePlayer();
}
```

On each tick the loop calls the callback of every mover. One call:

1. Moves the player one step, checking collision and warps.
2. At a steady pace while the player moves, recalculates the player's area of interest if they moved far enough. See [AOI and layers](#/engine/aoi-and-layers).
3. Sends the player their own new position as a datagram.
4. Queues the position for the next movement batch, which tells everyone else.

Three rules keep the loop healthy:

- A mover whose previous step has not finished (`running`) is skipped for that tick, so slow steps never pile up.
- A step only runs when at least one frame time has passed for that player.
- If a callback throws, the player is removed from the loop.

`MOVEXY` with the data `abort` stops the player and unregisters them. A disconnect does the same.

:::note
The loop moves players, it does not send movement to other players. That is done by a separate flush timer in `receiver.ts` whose interval adapts to load. See [Networking](#/engine/networking/the-flush).
:::

## Tick events

Everything that is not movement hangs off the event bus. `listener` is a Node `EventEmitter` exported from `src/modules/event_bus.ts` (and re-exported by `src/systems/events.ts` together with the `Events` name constants).

| Constant | Event name | Emitted | Interval |
|----------|-----------|---------|----------|
| `Events.AWAKE` | `onAwake` | Once, after the server registered with the gateway | once |
| `Events.START` | `onStart` | Once, right after `onAwake` | once |
| `Events.FIXED_UPDATE` | `onFixedUpdate` | `setInterval` in `server.ts` | 100 ms |
| `Events.SERVER_TICK` | `onServerTick` | `setInterval` in `server.ts` | 1000 ms |
| `Events.SAVE` | `onSave` | `setInterval` in `server.ts` | 60000 ms |
| `Events.UPDATE` | `onUpdate` | Never | none |

```ts title="src/socket/server.ts"
setInterval(() => {
  listener.emit(Events.FIXED_UPDATE);
}, 100);

setInterval(() => {
  listener.emit(Events.SAVE);
}, 60000);

setInterval(() => {
  listener.emit(Events.SERVER_TICK);
}, 1000);
```

:::warning onUpdate is not emitted
`Events.UPDATE` (`onUpdate`) is defined in `src/systems/events.ts`, but no code in the engine emits it. A listener on it never runs. Use `onFixedUpdate` for fast work and `onServerTick` for once a second work.
:::

Listening is the same for engine code and plugins:

```ts title="Listening to a tick"
import { listener, Events } from "@engine/systems/events";

listener.on(Events.SERVER_TICK, () => {
  // runs once a second
});
```

The gameplay events (`onPlayerDeath`, `onSpellCast` and the rest) are listed on the [Listener events](#/engine/listener-events) page.

### What the engine does on each tick

| Event | Built in work |
|-------|---------------|
| `onFixedUpdate` (100 ms) | Creature AI, movement and combat. Gathering node spawns. Tornadoes forming, dying and hurting players. Release of connections whose packet rate limit has expired. |
| `onServerTick` (1 s) | Removes players whose connection is gone. Regenerates stamina and, outside PvP, health, each by a share of the maximum, and sends the new values to the player and everyone who sees them. Drops the PvP flag a short while after a player's last attack. Reports the connection count to the gateway client. Refreshes creature spells and navigation grids. Checks "reach this point" quest objectives. Ends trades whose players may no longer trade. On a longer timer, reads the list of account names again. |
| `onServerTick`, every 60 s | Compares each player's connection id with `accounts.session_id` in the database. A player whose account was logged in elsewhere is told so and disconnected. Reads the subscription tables again. |
| `onSave` (60 s) | Writes stats and location of every online, non guest player to the database, and achievement progress |

Dead players and ghosts do not regenerate.

### Other timers

These are plain timers, not events:

| Timer | What it does | Where |
|-------|--------------|-------|
| Movement loop | Steps the moving players, 30 Hz (33.3 ms) | `gameloop.ts` |
| Movement batch flush | Sends the queued movement; its interval adapts to load | `receiver.ts` |
| Spawn and despawn flush | Sends the queued spawns and despawns, despawns first | `receiver.ts` |
| Connection count broadcast | Publishes the connection count to its topic, no more often than a short interval | `server.ts` |
| Packet rate limit window | Counts a connection's packets per window | `server.ts` |
| Stream queue health check | Looks for connections with a long stream queue | `server.ts` |
| Party layer sync | Brings party members onto the leader's layer | `aoi.ts` |
| Layer condensing | Moves players from overflow layers to lower ones | `aoi.ts` |
| Gateway heartbeat | Reports to the gateway every `gateway.heartbeatInterval` | `gateway-client.ts` |
| Lightning on thunderstorm worlds | Places a bolt near a random player, at random intervals | `receiver.ts` |
| Random weather change | Picks a new weather for worlds set to `random` | `receiver.ts` |
| Real weather reading | Reads the weather API every `WEATHER_API_MINUTES` | `weatherapi.ts` |
| Idle movement worker cleanup | Ends movement workers that have gone idle | `movement_worker_pool.ts` |

## Worker pools

Three kinds of work leave the main thread.

| Pool | File | Size | Setting |
|------|------|------|---------|
| Database | `src/controllers/sqldatabase.ts` | 8 by default | `DB_WORKER_POOL_SIZE` |
| Login | `src/socket/authentication_pool.ts` | 8 by default | `AUTH_POOL_SIZE` |
| Movement | `src/socket/movement_worker_pool.ts` | `max(2, min(8, CPU cores - 1))` | none |

A size that is not a positive whole number falls back to 8.

```ts title="src/controllers/sqldatabase.ts"
const MAX_DB_WORKER_POOL_SIZE = 64;
const parsedDbWorkerPoolSize = parseInt(process.env.DB_WORKER_POOL_SIZE || "", 10);
const WORKER_POOL_SIZE = Number.isInteger(parsedDbWorkerPoolSize) && parsedDbWorkerPoolSize > 0
  ? Math.min(parsedDbWorkerPoolSize, MAX_DB_WORKER_POOL_SIZE)
  : 8;
```

### Database workers

Every call to `query` is posted to one worker, chosen round robin. Each worker owns its own connection to the database. The pool is created when `sqldatabase.ts` is first imported, and the import waits until every worker reports ready (or fails). Details are on the [Database](#/engine/database/the-query-function) page.

### Login workers

A login reads many rows: the account, inventory, collectables, learned spells, party and guild. That work runs in `src/socket/authentication.ts` on a worker thread, so a wave of logins does not stall movement for everyone else.

Each worker is started with a copy of the items, maps, mounts and spells from `assetCache`. When the spell editor or item editor changes those lists, `refreshAuthSpells` or `refreshAuthItems` sends the new list to every worker.

```ts title="src/socket/receiver.ts"
const authWorker = await getAuthWorker();
authWorker.on("message", async (result: any) => {
  // result.authenticated, result.data, result.error
});
```

:::note
`receiver.ts` asks the pool for a worker once, when the module loads, and posts every `AUTH` packet to that worker. The login workers also import the game systems on their own threads. There the row caches are switched off (`Bun.isMainThread` is `false`), so a login always reads the database.
:::

### Movement workers

Building movement batches means working out, for every receiver, which movers they can see. For a layer with many receivers that work is sent to a movement worker (`src/socket/movement_worker.ts`). The worker keeps a mirror of each receiver's visible set, updated by diffs, and returns ready made binary batches that the main thread only has to send.

- Workers are created on demand, up to the pool size, and shared between layers. A layer always uses the same worker.
- A flush that does not finish in time is abandoned with a warning.
- A worker that has been idle for a while is terminated.
- With very many receivers in one flush, movers far from a receiver are only sent on some of the flushes.

## Startup sequence

Importing `src/socket/server.ts` starts the server: the file has top level `await` and side effects. This is the order.

### While modules load

The imports at the top of `server.ts` run first, and several of them do real work when loaded:

| Module | Work at import |
|--------|----------------|
| `utility/validate_config.ts` | Checks the environment and `settings.json`. Exits on a missing required value. Sets a random `SESSION_KEY` and `RSA_PASSPHRASE`. |
| `controllers/sqldatabase.ts` | Starts the database worker pool and waits for every worker to connect |
| `modules/assetloader.ts` | Loads worlds, items, mounts, spells, NPCs, creature data, particles and quests into `assetCache`. Then syncs maps and `.world` directories from the asset server and loads them. |
| `socket/receiver.ts` | Starts the login worker pool, the movement and spawn flush timers, the weather timers and the real weather reader |

### In server.ts itself

1. **Certificate.** `ensureLocalCertificate` creates or renews a local certificate if needed. The certificate and key are read. Missing, unreadable or expired: the server throws. See [Networking](#/engine/networking/tls-is-mandatory).
2. **Rate limit options** are read from `settings.json`, and the RSA key pair for chat encryption is generated.
3. **Cached tables.** Missing tables and columns (subscriptions, classes, mail, achievements and others) are added first. Then `await loadTables()` reads every table cache (parties, guilds and others) before any connection can ask for one. See [Caching](#/engine/caching).
4. **Whitelist.** If `WHITELIST=true`, the realm's usernames are loaded in the background.
5. **Sprites.** `await spriteDataCacheReady`.
6. **CORS origins** are parsed from `CORS_ALLOWED_ORIGINS`.
7. **Internal HTTP API** starts on `127.0.0.1:WEBSRV_INTERNAL_PORT`.
8. **Public HTTP proxy** starts on the game port (and the redirect server when SSL is on).
9. **WebTransport** starts on the UDP side of the game port. The server then connects to itself once, pinning its own certificate, to prove the listener accepts connections. A failure here stops startup.
10. **Gateway.** `await gatewayClient.registerWithRetry()` blocks until the gateway accepts the registration. Map checksums are then synced in the background.
11. **`onAwake` and `onStart`** are emitted. On `onAwake` the engine resets leftover account state and deletes guest data (`player.clear()`).
12. **Game systems.** `gameLoop.start()`, `await creatures.init()`, `await gathering.init()`, `await achievements.init()`, then the party layer sync and layer condensing timers.
13. **Plugins.** `loadPlugins`, `mergePluginSpellsIntoCache`, then `registerAllPlugins` with the `EngineAPI` object. A failure is logged as a warning and the server keeps running.
14. **Tick timers** for `onFixedUpdate`, `onSave` and `onServerTick` start.

```ts title="src/socket/server.ts"
await gatewayClient.registerWithRetry();

listener.emit(Events.AWAKE);
listener.emit(Events.START);

gameLoop.start();
await creatures.init();
await gathering.init();
await achievements.init();
startAutoPartyLayerSync(sendAnimationTo);
startAutoLayerCondensation(sendAnimationTo);

try {
  await loadPlugins(listener);
  await mergePluginSpellsIntoCache();
  // ... build the EngineAPI object ...
  const registered = await registerAllPlugins(engineApi, listener);
} catch (err) {
  log.warn(`Plugin loading skipped: ${err}`);
}
```

:::warning The gateway must be reachable
Step 10 never gives up. If the gateway is down, the engine keeps retrying with a growing delay and the game loop, plugins and ticks do not start until it succeeds. Start the gateway and the asset server first. See [Quick start](#/getting-started/quick-start).
:::

:::note Plugins load after onAwake and onStart
`server.ts` emits `onAwake` and `onStart` before it loads plugins. The [Plugins](#/engine/plugins) page explains the plugin lifecycle events.
:::

## Shutdown

`SIGINT` and `SIGTERM` call `gracefulShutdown`: the movement loop stops, the server unregisters from the gateway, the WebTransport server and the HTTP servers are stopped, achievement progress is written (waiting a limited time), and the process exits with code 0.

```ts title="src/socket/server.ts"
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
```

## Profiling the loop

Set `BENCHMARK_PROFILE=1` to print timing lines at regular intervals:

```text title="Example profile output"
[profile:gameloop] 150 ticks/5s, 0 overlaps, 42ms total, 3ms max, 12 movers, rss=310MB
```

| Field | Meaning |
|-------|---------|
| `ticks/5s` | Ticks that had at least one mover. The most is a tick for every interval of the loop. |
| `overlaps` | Ticks that fired while the previous one was still running. Above zero means the loop is falling behind. |
| `total` | Milliseconds spent inside ticks in the reporting window |
| `max` | The slowest single tick |
| `movers` | Players currently in the loop |
| `rss` | Process memory |

[Benchmarking](#/engine/benchmarking) shows how to put load on the server while you watch these numbers.
