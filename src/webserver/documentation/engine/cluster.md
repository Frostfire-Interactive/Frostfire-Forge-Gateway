---
title: Cluster Mode
description: Several game server nodes sharing one world: blocks and owners, the coordinator, the balancer, mirrors, crossing a border, node links, the environment variables and how to run a cluster.
order: 35
---

In cluster mode several engine processes, called nodes, serve one world. The map is cut into square blocks and every block has one owner node. A player walks across the whole map and the client is moved from node to node without a loading screen. This page explains the parts, what happens at a border, how nodes join and leave, and how to switch cluster mode on.

With `CLUSTER=false`, the default, the engine runs as a single process and none of this applies.

## The parts

| Part | What it is | Where it lives |
|------|------------|----------------|
| Node | One engine process (`src/socket/server.ts`) with `CLUSTER=true`. It owns blocks and runs the players, creatures and loot in them. | `src/cluster/index.ts` |
| Coordinator | A separate process that gives blocks to nodes, takes over the blocks of a node that stopped and plans moves between nodes. One leads, any others stand by. | `src/cluster/coordinator.ts`, `coordinator-main.ts` |
| Redis | The shared store: block tables, the list of live nodes with their load, the directory of online players, id counters, snapshots and the bus the processes talk over. | `src/cluster/redisstore.ts` |
| Node links | A direct connection between each pair of neighbouring nodes, for mirrors, handoffs and calls. | `src/cluster/links.ts`, `wtlinks.ts` |
| Balancer | The part of the coordinator that moves blocks from busy nodes to quiet ones. | `src/cluster/rebalance.ts`, `blockmove.ts` |
| Owner routing | The Gateway sends a login to the node that owns the player's saved position. | [Cluster nodes and block owners](#/gateway/game-servers/cluster-nodes-and-block-owners) |

All nodes of one cluster share a region (`REGION_ID`), one database, one Redis, one Gateway and one asset server. Players see the region as a single realm.

## Blocks and owners

A map is cut into blocks of `BLOCK_SIZE_PX` pixels (a key in `src/config/aoi.json`, with its default in [Configuration](#/engine/configuration/aoijson)). A block is named by its grid position, such as `2,1`. Each block has exactly one owner at a time, recorded in a block table per map with an epoch that rises on every change.

```json title="One entry of a block table"
{ "nodeId": "node-2", "epoch": 7, "since": 1767225600000 }
```

The table is kept in Redis under `cells:blocks:<map>`. Every node keeps a copy in memory so that "who owns this point" is a lookup (`ownerOf` in `src/cluster/blocks.ts`). A node reads the table again when it hears a `blocks-changed` message on the bus, and on a regular timer as a safety net.

Layers are counted per block (see [AOI and layers](#/engine/aoi-and-layers/blocks-and-layers)). Layer numbers above 1 come from one counter per map in Redis (`src/cluster/layerseq.ts`), so two nodes never use the same layer name for different crowds. Ids of players, creatures, loot and other world objects come from blocks of ids that each node takes from one counter, so an object keeps its id when it moves to another node (`src/cluster/ids.ts`).

### Giving out blocks

Nodes publish the size of every map they load, and the coordinator lays the blocks out:

- A map with no table is split among the live nodes. The blocks are walked in a snake and cut into runs of equal weight, one run per node, so every node gets one connected area. The split is the same for the same set of nodes (`src/cluster/split.ts`).
- A block with no owner goes to the live node that owns most of its four neighbours, then to the node with fewer players.
- A node that joins a running cluster owns nothing at first. The balancer gives it a block from the busiest node, and it grows from there.

`CLUSTER_EXPECTED_NODES` and `CLUSTER_SETTLE_MS` make the coordinator wait before the first split, so the first node up does not take every block. See [Environment variables](#/engine/cluster/environment-variables).

### Telling the Gateway

A node reports each map's table to the Gateway with `POST /blocks` when it changes (`src/cluster/blockreport.ts`, `src/modules/gateway-client.ts`). The Gateway uses it to answer which node a position belongs to. The request format and `GET /route` are documented under [Cluster nodes and block owners](#/gateway/game-servers/cluster-nodes-and-block-owners).

## The coordinator

The coordinator is one process per region. Several can run: they compete for a lock in Redis (`cells:coordinator`, which has a short lifetime and is renewed while the coordinator runs). The one that holds it leads. If it stops, a standby takes the lock within the lifetime and carries on. The nodes keep working with the tables they hold in the meantime.

The leader runs a pass on a short timer. In each pass it:

1. Reads which nodes are alive and their load reports.
2. Splits any map that has no table, and gives out blocks that have no owner.
3. Takes over the blocks of a node that stopped (see [A node stops or restarts](#/engine/cluster/a-node-stops-or-restarts)).
4. On a regular timer, plans moves between nodes (the balancer).

Every table it writes is written against the epoch it read, so a coordinator that lost the lock cannot overwrite the new leader's table.

## The balancer

Each node sends a load report with its heartbeat. The load of a block is its players, plus a smaller weight for each awake creature, plus a weight for each player a player can see. The last term makes a crowd weigh more than the same number of players spread out.

On a regular timer the coordinator looks for a node whose load is clearly above the average. That node gives one block on its edge to its least loaded neighbour across that edge. Rules that keep the cluster calm:

- Only a block the owner has held for a while moves.
- The receiver must still be below the sender afterwards, so a block does not swing back and forth.
- A node is in one move at a time and rests after it.
- A node reports how long its event loop was held up. A node that is behind is left out of moves as a receiver, and, when it is far behind, as a sender.
- A node that owns no block receives one from the busiest node even when the cluster is quiet.

A move is carried out by the old owner (`src/cluster/blockmove.ts`). It collects everything tied to the block: the creature spawn slots and their creatures, ground loot, chests, death skeletons and tornadoes. It sends them to the new owner in one call. When the new owner has taken them in, the coordinator writes the new owner into the table. Players standing in the block then cross to the new owner the same way they cross a border.

## Node links

Each pair of neighbouring nodes keeps one link: a WebTransport session on the node's `NODE_LINK_PORT` (UDP), apart from the port players use. The node with the smaller id dials. A link starts with a signed hello that proves the dialler knows `CLUSTER_LINK_SECRET`, and the dialler pins the other node's certificate hash, which every node publishes in Redis. Links use the engine's own TLS certificate, the same one as the game port, so no extra certificate is needed. Nodes ping each other regularly and drop a link that has been silent for a short while. The dialler then redials.

The links carry two kinds of traffic:

- Control messages, which go first: calls and their answers, and the link's own hello and ping.
- Bulk messages: mirror updates and area events. Positions of mirrored entities travel as datagrams.

| Message | Direction | Purpose |
|---------|-----------|---------|
| `LINK_HELLO`, `LINK_OK`, `LINK_PING` | Both | Open the link and keep it alive |
| `CALL`, `ANSWER`, `CAST` | Both | A request with an answer, the answer, and a message with none |
| `GHOST_SPAWN`, `GHOST_STATE`, `GHOST_DESPAWN`, `GHOST_MOVE`, `GHOST_HANDOVER` | Owner to neighbour | Create, update, move and remove [mirrors](#/engine/cluster/mirrors) |
| `AOI_EVENT` | Node to neighbour | Something seen by everyone near a point, such as a line of say chat |
| `HANDOFF`, `HANDOFF_COMMIT`, `HANDOFF_ABORT` | Old node to new node | [Moving a player](#/engine/cluster/crossing-a-border) |
| `CREATURE_HANDOFF`, `CREATURE_HANDOFF_COMMIT`, `CREATURE_HANDOFF_ABORT` | Old node to new node | Moving a creature that walked into another node's block |
| `BLOCK_MOVE`, `BLOCK_MOVE_PROBE`, `BLOCK_MOVE_HELD` | Old owner to new owner | Moving a block |

The cluster bus is a Redis channel per region. Its messages are signed with a key derived from `CLUSTER_LINK_SECRET`: `blocks-changed`, `node-dead`, `block-move` and the messages that reach a player on any node. Records in Redis that carry authority, such as block tables, snapshots and move orders, are sealed with another key derived from the same secret. Only nodes and coordinators hold it.

## Mirrors

A player near a border must see the players, creatures and objects on the other side. Each node keeps read-only copies, called mirrors, of what its neighbours own near the border.

- The owner looks at its entities on a short timer. An entity within the AOI exit radius (the view radius times `EXIT_HYSTERESIS`) of a block that another node owns is sent to that node as a mirror.
- The kinds that are mirrored are players, creatures, ground loot, chests, gathering nodes, skeletons, ground zones and tornadoes.
- The owner sends `GHOST_SPAWN` when the entity comes within reach, `GHOST_STATE` when what it shows changes (health, effects, stealth), `GHOST_MOVE` datagrams as it moves, and `GHOST_DESPAWN` when it leaves.
- Mirrors are kept apart from the node's own entities. A mirrored player is not in `playerCache`, so it is not saved, not counted as online and not regenerated by this node. Only the owner can move, change or remove it.
- The AOI treats a mirror like a local entity, so a client sees across a border exactly as it sees inside a block. See [AOI and layers](#/engine/aoi-and-layers).

### Working across a border

Because both sides hold the other as a mirror, ordinary play works over a border:

| Feature | How it works |
|---------|--------------|
| Spells on players | The caster's node rolls the hit and sends it to the target's node, which runs every check that protects the target and applies it (`src/cluster/playerhits.ts`) |
| Over time effects | The effect ticks on the target's node and kill credit goes to the caster's node (`src/cluster/dotcredit.ts`) |
| Say chat and area events | `AOI_EVENT` reaches players on neighbouring nodes within the radius |
| Whispers, party and guild messages | Delivered to the player on whichever node holds them (`src/cluster/deliver.ts`) |
| Invitations | Kept in Redis until answered, so the player who answers can be on another node (`src/cluster/invitations.ts`) |
| Trade | The trade runs on the node of the player who asked, and the other node relays (`src/cluster/tradelink.ts`) |
| Loot, corpses, chests and gathering nodes | The owner takes the items off and the player's node writes them. The hand-over is parked in Redis until someone writes it, so it is written once (`src/cluster/grants.ts`) |
| Creatures | A creature that walks into another node's block moves to that node and keeps its id (`src/cluster/creaturehandoff.ts`) |

Writes to one player's rows are serialised across the cluster by a lock per player in Redis (`src/cluster/playerlock.ts`), and a save only changes a row while the node holds the player's owner epoch.

## Crossing a border

The player keeps walking. The client is told which node is next, opens a session there ahead of time, and switches to it when the old node has handed the player over.

1. **Prepare.** While a player walks toward a block owned by another node, and the border is close ahead, the server sends `HANDOFF_PREPARE` with the next node's address. The client opens a session there and leaves it idle. If the player turns away or stops, the server sends `HANDOFF_ABORT` and the client closes that session.
2. **Pick.** A watch runs on a short timer. A player is handed off when they stand a little way inside a block that another node owns, and this node owns none of the points around them. A player on the line does not go back and forth, and a player is not handed straight back to the node they came from, unless they stand well inside its block.
3. **Ask.** The old node signs a ticket for the new node and asks it, over the link, to take the player. The request carries a snapshot (below). The new node parks the snapshot as an arrival under the ticket token and answers yes or no. The player keeps walking meanwhile.
4. **Stop.** On a yes, the old node drops the player's further moves, waits for packets already in flight to finish and takes the player's cluster lock.
5. **Give up the player.** In one synchronous step the old node takes the final snapshot, hands the player's mirrors over to the new node, removes the player and keeps a mirror of them, and starts forwarding messages for them to the new node. It saves the player and sends `SWITCH` with the ticket. The ticket is signed for the new node, is short-lived and can be used once.
6. **Switch.** The client receives `SWITCH`, closes the old session and uses the session it opened in step 1 (or opens one). It sends the ticket in `AUTH_CONNECT`. The game keeps running on screen: the player stays where they are drawn and keeps walking.
7. **Land.** The new node finds the arrival for the ticket and logs the player in from it without loading the map again. It sends `HANDOFF_DONE` with the map, position, facing direction and `walk`, the direction it walks the player in (`null` when it does not). The client holds its own direction against `walk` and sends its move again only when they differ. If the player was walking, they walk on from the committed position. The client has already shown the nearby creatures and players, so the new node sends only what differs.

The snapshot carries the player's id, name, map, position and direction, the creatures and players the client already shows, and the state that belongs to the player: active effects and damage over time, barriers, stuns and slows, spell cooldowns and lockout, death state and corpse, sickness, PvP flag and last attack, mount, the shared consumable cooldown and the direction of the walk (`handoffState` in `src/socket/server.ts`, `src/socket/arrival.ts`). The new node checks every part of it against its own rules.

The player is live on one node at a time. If a step fails before the old node gives the player up, the player stays where they are and the handoff is tried again shortly.

A node that cannot resume the client's world sends `LOAD_MAP` instead of `HANDOFF_DONE`, and the client loads the map as for a normal login.

A warp or teleport to a point that another node owns uses the same path with a full map load. The old node drains and hands the player off first, and the new node sends `LOAD_MAP`.

The packets are listed in [Packet types](#/engine/packet-types/types-the-server-sends-that-are-not-in-the-registry).

## Logging in where another node owns the spot

A player logs in on any node. After the login worker has read the account and the node has worked out the spawn point (the saved position, the corpse for a dead player, the world's spawn for a new character), the node looks up who owns the block of that point (`routeLogin` in `src/cluster/route.ts`).

- If this node owns the block, the login continues here.
- If another live node owns it, this node signs a ticket for that node, clears the session it had marked, sends `SWITCH` and closes the connection. The client connects to the other node with the ticket (`switchLoginIfElsewhere` in `src/socket/receiver.ts`).
- If no one owns the block, or its owner is not live, the login continues here.

A login that arrived by `SWITCH` is never switched again. The Gateway already picks the owner of the saved position when it issues the connection token, so this redirect only runs when the Gateway did not know the position or the tables changed in between.

After a crash, a login reads the player's last snapshot. Every node writes a snapshot of each player it owns (map, position, health and stamina) to Redis on a regular timer, and the login plays from whichever is newer, the snapshot or the saved row (`src/cluster/snapshots.ts`, `src/cluster/recovery.ts`).

## A node stops or restarts

Every node announces itself in Redis when it starts and sends a heartbeat regularly. A node whose heartbeat stays missing for a short while is not alive.

### Stopping a node

On `SIGINT` or `SIGTERM` a node:

1. Starts no new handoff and waits for the ones running, so their saves finish.
2. Unregisters from the Gateway and closes its listeners.
3. Leaves the cluster: it drops its mirrors and links, clears its entries from the player directory and stops beating.

Its players' connections close and their clients reconnect. The Gateway issues a token for the node that owns the player's saved position.

The coordinator sees that the node is missing in more than one pass in a row and for a short while. It then:

1. Writes a tombstone for the node's run in Redis.
2. Waits for the node's lease to lapse if it beat meanwhile.
3. Clears the node's players from the directory, so they can log in elsewhere at once.
4. Sends `node-dead` on the bus.
5. Settles the node's open move orders.
6. Gives each of the node's blocks to the live node that owns most of its neighbours.

The other nodes drop the mirrors they held of the dead node. They respawn the creatures it held that came from their own spawn slots, and remove the creatures it had sent them.

### A node that stalled

A node that was only stalled, not stopped, finds its tombstone on its next heartbeat. It stops acting as an owner at once, closes its players' sessions, waits briefly for their saves and exits, so a supervisor such as Docker can start a new run.

### Starting a node again

A node that starts again under the same id announces a new run. The coordinator tells the other nodes that the old run ended (`node-dead` with `restarted: true`), and they drop what they held of it. A node that returns before the coordinator took its blocks keeps the blocks the table names for its id. A node whose blocks were already taken over starts with none and receives blocks from the balancer.

## Environment variables

Cluster mode adds these variables to the ones in [Configuration](#/engine/configuration). A node refuses to start when a required one is missing or invalid. Secrets are named here and never given a value. Replace `change-me` in the example with your own value.

| Name | Default | Purpose |
|------|---------|---------|
| `CLUSTER` | `false` | `true` turns cluster mode on |
| `NODE_ID` | Required | This node's name: 1 to 64 letters, digits, `_` or `-`. Unique in the region. Also the id the Gateway knows the node by. |
| `REGION_ID` | Required | The region the node belongs to, with the same characters. Every node and coordinator of one world uses the same value. |
| `CACHE` | Required: `redis` | The nodes share one copy of the player rows through Redis. See [Caching](#/engine/caching). |
| `REDIS_URL` | Required | `redis://:<password>@host:6379` or a `rediss://` URL. The password is required unless the URL uses TLS, and a placeholder password is refused. |
| `REDIS_PASSWORD` | none | The password of the Redis container started by the compose files in `src/docker/`. It must match the password in `REDIS_URL`. |
| `CLUSTER_LINK_SECRET` | Required | At least 32 random characters, the same on every node and coordinator. Signs node links, the bus and sealed Redis records. Do not give it to the Gateway or the asset server. |
| `GATEWAY_GAME_SERVER_SECRET` | Required in a cluster | The secret that signs connection tickets, the same on the Gateway and every node. Nodes also sign `SWITCH` tickets with it. |
| `GATEWAY_URL`, `GATEWAY_AUTH_KEY` | as in [Configuration](#/engine/configuration/environment-variables) | Every node registers with the Gateway under its `NODE_ID` and sends `regionId` with it |
| `SERVER_ID` | `server-<random hex>` | Give each node its own value. Whitelist rows and asset server calls are keyed by it. |
| `SERVER_HOST` | `localhost` | The address the Gateway uses to reach this node |
| `PUBLIC_HOST` | `SERVER_HOST` | The address players dial |
| `WEBSRV_PORTSSL`, `WEBSRV_INTERNAL_PORT` | `3000`, `3002` | The game port and the internal port. Nodes on one machine need their own values. |
| `NODE_LINK_PORT` | The game port plus 1 | UDP port of the link listener, 0 to 65535. `0` turns links off. |
| `NODE_LINK_HOST` | `SERVER_HOST`, else `127.0.0.1` | The address neighbours dial to reach this node's links. `localhost` is dialled as `127.0.0.1`. |
| `NODE_LINK_BIND_HOST` | Required unless `NODE_LINK_PORT=0` | The interface the link listener binds. Set it to the private address of the node, so links are reachable from the other nodes only. `0.0.0.0` is accepted when you set it on purpose, as in a container on a private network. |
| `CLUSTER_EXPECTED_NODES` | none | Coordinator only. A map with no table is split once this many nodes are alive, or after `CLUSTER_SETTLE_MS`. Unset, a new map is split at once. |
| `CLUSTER_SETTLE_MS` | `60000` with `CLUSTER_EXPECTED_NODES` | Coordinator only. How long after the first node is alive the split waits. |

The coordinator reads `REDIS_URL`, `REDIS_PASSWORD`, `REGION_ID`, `CLUSTER_LINK_SECRET` and the two settings above. It needs no database.

```env title=".env.production for one node"
CLUSTER=true
CACHE=redis
REDIS_URL=redis://:<redis password>@10.0.0.5:6379
CLUSTER_LINK_SECRET=<at least 32 random characters>
GATEWAY_GAME_SERVER_SECRET=change-me
GATEWAY_AUTH_KEY=change-me

NODE_ID=node-1
REGION_ID=main
SERVER_ID=main-node-1
SERVER_HOST=10.0.0.11
PUBLIC_HOST=game1.example.com

NODE_LINK_PORT=3001
NODE_LINK_HOST=10.0.0.11
NODE_LINK_BIND_HOST=10.0.0.11
```

Every other node uses the same file with its own `NODE_ID`, `SERVER_ID`, hosts and ports.

`BLOCK_SIZE_PX` is a key in `src/config/aoi.json`. Use the same value on every node and coordinator, since the block grid is derived from it.

## Running a cluster

### Start every part by hand

1. Start Redis with a password.
2. Start the Gateway and the asset server.
3. Start a coordinator for the region: `bun coordinator:production`. Start a second one for a standby.
4. Start each node with `bun production`, from its own checkout or container with its own `.env.production`. The script always loads `.env.production`, so two nodes cannot share one file.

Start the coordinator before the nodes. It splits the maps when nodes appear, and with `CLUSTER_EXPECTED_NODES` it waits until that many are alive.

### One command on one machine

`bun cluster <nodes>` starts a whole cluster on the machine it runs on, from the engine repository.

```bash title="Run a cluster locally"
bun cluster 3
bun cluster 4 --coordinators 2
```

It needs `REDIS_URL` (with a password) and `CLUSTER_LINK_SECRET` in `.env.production`, and a running Gateway. Stop a single engine that runs from the same repository first, since the nodes replace it. The command:

1. Starts the Redis container from `src/docker/docker-compose.redis.yml` when `REDIS_URL` points at port 6379 on this machine, and waits until it is healthy. Any other Redis is used as it is.
2. Runs `src/utility/cluster-local.ts`, which clears the cluster keys (`cells:*`) in Redis so each run starts from a fresh split.
3. Starts the coordinators, then the nodes one after another, each as `node-<n>` in the region `local` (or your `REGION_ID`), with `SERVER_ID` set to `<region>-node-<n>`. Node `n` uses the base game, internal and link ports plus `10 * n`.
4. Prefixes the output of every process with its name.

`Ctrl+C` saves and stops every node. Redis keeps running. Stop it with `docker compose -f src/docker/docker-compose.redis.yml down`. `bun cluster-local <nodes>` does the same without starting Redis.

### Docker

`src/docker/docker-compose.cluster.yml` runs a complete test cluster, separate from your development setup: Redis, a MySQL database, the asset server, the Gateway, one coordinator and three nodes (`node-1` to `node-3`, host ports 3101 to 3103). It builds the Gateway and asset server images from the sibling repositories.

Copy `src/docker/cluster.env.example` to `src/docker/cluster.env` and give every secret in it a fresh random value. Pass the file to every command:

```bash title="Run the cluster stack"
docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env up -d --build
docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env logs -f
docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env down
```

Open `http://localhost:18081` in Chrome or Edge, choose **Continue as guest** and pick the realm. Run `down` between runs: Redis keeps the block tables for as long as its container exists. `down -v` also deletes the test database.

To add a standby coordinator, run `up -d --scale coordinator=2`. Stop the leader (its log line says it leads) and the standby takes the lock.

## The Cluster Nodes overlay

Press **F2** in the game and tick **Cluster Nodes** to draw the block grid over the map. It is available to every logged-in player.

- Each block is tinted by its owner, with the owner's short id and the block coordinates in its middle.
- A solid line marks a border between two owners and a dotted line marks a block boundary inside one owner.
- Hatched blocks have no owner. Orange blocks are being moved to another node.
- The status line shows the node you are connected to and the owner of the block you stand in, or `Cluster: off` when the server runs without cluster mode.

The client asks with `CLUSTER_DEBUG` on a regular timer while the box is ticked, and the node answers with `CLUSTER_DEBUG_DATA`. The answer is built from the block table the node already holds (`src/cluster/nodedebug.ts`). It names no host, port, secret or player.

## Packets

The client sees four packets that belong to cluster mode, besides the overlay's pair. All of them are described in [Packet types](#/engine/packet-types).

| Packet | Sent | Content |
|--------|------|---------|
| `HANDOFF_PREPARE` | While a player walks toward a border | `{ nodeId, publicHost, port, wtPort, useSSL }` of the next node. No ticket. |
| `HANDOFF_ABORT` | The handoff will not happen soon | `null`. The client closes the session it opened. |
| `SWITCH` | A login or a player belongs to another node | The node's address and a signed `ticket`. For a handoff it also has `handoff: true` and `resume`, which tells the client to keep its world until `HANDOFF_DONE`. |
| `HANDOFF_DONE` | The new node took the player over with the client's world | `{ map, x, y, direction, walk }` |
| `CLUSTER_DEBUG`, `CLUSTER_DEBUG_DATA` | The overlay | The block grid |

The pose datagram that carries other players' animation changes also reaches players across a border. See [Pose datagrams](#/engine/packet-types/pose-datagrams).

## Related pages

- [Cluster nodes and block owners](#/gateway/game-servers/cluster-nodes-and-block-owners): `POST /blocks`, `GET /route` and how the Gateway picks a node for a token
- [AOI and layers](#/engine/aoi-and-layers): how an entity decides who sees it
- [Networking](#/engine/networking): the client connection, tickets and `AUTH_CONNECT`
- [Caching](#/engine/caching): the Redis cache every node shares
- [Configuration](#/engine/configuration): every other environment variable
