---
title: Game Servers and Realms
description: How game servers register with the gateway, heartbeats, realm selection, the whitelist flag, failover, connection tokens, and the gateway server HTTP API.
order: 50
---

The gateway server (`src/gateway/server.ts`) keeps an in-memory list of every running game server. Players see that list as realms. This page covers how a game server joins the list, how it stays on it, how a player ends up connected to one, and the HTTP API behind it all.

## The two shared values

Two values tie a game server to a gateway. Both must be identical on each side.

| Variable | Used for | Sent over the wire |
| --- | --- | --- |
| `GATEWAY_AUTH_KEY` | Proves a game server may register, send heartbeats and unregister. | Yes, in the JSON body of each call |
| `GATEWAY_GAME_SERVER_SECRET` | Signs the connection tokens players present to a game server. | No, only signatures made with it |

:::tabs
```env title="Gateway"
GATEWAY_PORT=9999
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me-too
```
```env title="Game server"
GATEWAY_URL=http://localhost:9999
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me-too
SERVER_ID=realm-one
SERVER_DESCRIPTION=The first realm
SERVER_HOST=localhost
PUBLIC_HOST=localhost
```
:::

The game server side of these settings is described in [Engine Configuration](#/engine/configuration).

:::danger Use TLS between hosts
`GATEWAY_AUTH_KEY` travels in the request body. If a game server reaches the gateway over the public internet, turn TLS on for the gateway port and point `GATEWAY_URL` at the HTTPS address. See [TLS](#/gateway/tls).
:::

## Registration

On startup a game server calls `POST /register` on the gateway and keeps retrying until it succeeds. The delay grows after each failed try.

```json title="POST /register"
{
  "id": "realm-one",
  "description": "The first realm",
  "host": "localhost",
  "publicHost": "play.example.com",
  "port": 3000,
  "wtPort": 3000,
  "wtEnabled": true,
  "useSSL": true,
  "maxConnections": 2000,
  "whitelisted": false,
  "pvp": false,
  "authKey": "change-me"
}
```

| Field | Meaning |
| --- | --- |
| `id` | The realm name. Players see it in the realm list. Required. From `SERVER_ID`. |
| `description` | Shown beside the realm when it is selected. From `SERVER_DESCRIPTION`. |
| `host` | Address the gateway uses to reach the game server. Required. From `SERVER_HOST`. |
| `publicHost` | Address browsers use to reach the game server. Defaults to `host`. From `PUBLIC_HOST`. |
| `port` | The game server's HTTP API port. Required. |
| `wtPort` | The WebTransport port. The engine sends the same number as `port`. |
| `wtEnabled` | Whether WebTransport is available. True when `wtPort` is a number. |
| `useSSL` | Whether the game server's HTTP API is served over TLS. |
| `maxConnections` | Player capacity. The gateway uses a default capacity when it is missing. |
| `whitelisted` | Whether the realm whitelist is on. |
| `pvp` | Whether PvP is on for the realm. The realm list shows a `PvP` badge from it. |
| `authKey` | Must equal the gateway's `GATEWAY_AUTH_KEY`. |

The gateway answers `{"success": true, "serverId": "realm-one"}`. A wrong key gets `401`, a missing `id`, `host` or `port` gets `400`.

Registering an id that already exists replaces the entry and keeps its player count. That is how a game server rejoins after the gateway restarted.

:::warning Give every realm its own SERVER_ID
Two game servers with the same id overwrite each other in the list. Without `SERVER_ID` the engine invents a random id at every start, which changes the realm name players see.
:::

## Heartbeats

After registering, the game server sends `POST /heartbeat` on a timer. The interval is a game server setting, `gateway.heartbeatInterval` (see [Configuration](#/engine/configuration)).

```json title="POST /heartbeat"
{
  "id": "realm-one",
  "activeConnections": 42,
  "cpuUsage": 12,
  "ramUsage": 310.5,
  "rtt": 4,
  "whitelisted": false,
  "authKey": "change-me"
}
```

The gateway records the time of the heartbeat, the player count, CPU percentage, memory in megabytes and the whitelist flag. It stores half of `rtt` (the round trip time of the previous heartbeat) as the realm's latency.

If the gateway does not know the id it answers `404`. The game server treats that, or any network error, as a lost connection and registers again with the same backoff as at startup.

Two gateway settings decide when a silent server is dropped:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEARTBEAT_INTERVAL` | `30000` | How often the gateway sweeps the list for dead servers. |
| `SERVER_TIMEOUT` | `90000` | Age of the last heartbeat after which a server counts as dead. |

A clean shutdown calls `POST /unregister`, which removes the realm at once.

## Cluster nodes and block owners

A realm can run as a cluster: several game server processes, called nodes, each owning part of the map. Each node registers under its own node id and adds `nodeId` and `regionId` to the `POST /register` body. The nodes of one region are one realm to players. How the nodes work together is described in [Cluster Mode](#/engine/cluster). `GET /status` lists the nodes with their `nodeId`, `regionId` and `lastHeartbeat` (the time of the node's last heartbeat, in milliseconds), and adds a `regions` list with one entry per region.

Every map is cut into square blocks, and each block belongs to one node. A node tells the gateway who owns what with `POST /blocks`, one call per map. It sends every map right after it registers, the map new characters start on first, so a restarted gateway learns the tables again, and it sends a map again when that map's table changes. Changes that come close together go out together, still one call per map. It does not send them with the heartbeat.

```json title="POST /blocks"
{
  "id": "node-1",
  "map": "overworld",
  "epoch": 7,
  "blockPx": 4096,
  "blocksX": 3,
  "blocksY": 2,
  "nodes": ["node-1", "node-2"],
  "owners": "01.100",
  "authKey": "change-me"
}
```

| Field | Meaning |
| --- | --- |
| `id` | The node's registration id. The report belongs to the region it registered with. |
| `map` | The map name without `.json`. |
| `epoch` | The version of the table. The gateway keeps the table with the highest epoch for each region and map, and ignores a lower one. |
| `blockPx` | The side of a block in pixels. |
| `blocksX`, `blocksY` | The size of the map in blocks. |
| `nodes` | The nodes that own blocks. |
| `owners` | One character per block, row by row (`blocksX` blocks of the first row, then the next). The character is the position of the owner in `nodes`, counted `0-9`, `a-z`, `A-Z`, or `.` for a block no node owns. |
| `authKey` | Must equal the gateway's `GATEWAY_AUTH_KEY`. |

The gateway answers `{"success": true, "stored": true}`, with `"stored": false` when it already holds a higher epoch. A wrong key gets `401`, an unknown `id` gets `404`, a node that registered without a region or a report that fails validation gets `400`, and a body that is too large gets `413`.

The tables are kept in memory only. When the last node of a region is removed (it stopped answering, or unregistered), the region's tables are dropped. A node that registers into a region none of whose other nodes is alive starts the region's tables again.

`GET /route?realm=<region>&map=<map>&x=<x>&y=<y>` answers `{"nodeId": "node-2"}`, the node that owns the block that position is in, or `{"nodeId": null}` when the gateway has no table for the map, no node owns the block, or the owner is not alive. A position on or past the far edge of the map is in the last block, a negative one in the first. The route needs the same `GATEWAY_AUTH_KEY` as the other calls, sent in an `x-gateway-key` header and never in the URL. The webserver is its only caller.

The answer is a hint. It never decides who owns a block. The webserver uses it to pick the node a player's connection token is bound to, see Connection tokens below, and the game server still checks the player's spawn point when the player logs in and passes the login on if the hint was wrong.

## Realm states

`GET /status` reports one of three states per realm. The same data reaches the browser through `GET /api/gateway/servers` on the website.

| State | Condition | In the realm list |
| --- | --- | --- |
| `online` | A heartbeat arrived within `SERVER_TIMEOUT` and there is room | Online, selectable |
| `full` | `activeConnections` has reached `maxConnections` | Full, still selectable |
| `offline` | No heartbeat within `SERVER_TIMEOUT` | Offline, greyed out and not selectable |

## Realm selection

After login the player lands on `/realm-selection`.

- The page loads the realm list and refreshes it on a timer while the tab is visible.
- Each card shows the realm id, `Players: active/max`, a state badge, a `whitelist` badge when the flag is set and a `PvP` badge when PvP is on.
- The latency shown is measured by the browser itself: it times a `GET /ping` request sent straight to each game server at `publicHost:port`.
- Selecting a card shows the realm description. "Enter Realm" stores the id in the browser's local storage as `selectedServerId` and opens `/game`, or `/character` first when the account has no character yet.

When the game client starts it:

1. Fetches a connection token from `GET /api/gateway/connection-token`.
2. Fetches the realm list and looks up the stored realm id.
3. Opens a WebTransport session to `https://<publicHost>:<wtPort>`.
4. If the stored realm is gone or the connection fails, it forgets the choice and connects to the first realm whose state is `online`.

:::note localhost becomes 127.0.0.1
The client rewrites a `publicHost` of `localhost` to `127.0.0.1` before connecting. The game server's local certificate must therefore be valid for `127.0.0.1`. The certificate the engine generates for development is.
:::

## Whitelist flag

A realm can be restricted to a list of accounts. The game server reports the state of that switch in `whitelisted` when it registers and again in every heartbeat. When an admin flips the whitelist at runtime, the game server sends an extra heartbeat immediately so the badge in the realm list updates without waiting for the timer.

The gateway only displays the flag. Whether a player may enter is decided by the game server. See [Realm Whitelist](#/engine/realm-whitelist).

## Connection tokens

A game server only accepts WebTransport sessions that present a token signed with `GATEWAY_GAME_SERVER_SECRET`. The webserver issues them to a logged-in account.

```json title="GET /api/gateway/connection-token"
{
  "token": "<64 hex characters>",
  "timestamp": 1760000000000,
  "expiresAt": 1760000060000,
  "signature": "<hex HMAC>",
  "origin": "https://play.example.com",
  "account": "<64 hex characters>"
}
```

- `expiresAt` is a short while after `timestamp`.
- `origin` is the origin of the page that asked. `account` is the SHA-256 of the caller's session token, in hexadecimal.
- `signature` is the HMAC SHA-256 of the string `token:timestamp:expiresAt:origin:account` with the shared secret, in hexadecimal.
- Without a valid session token the route answers `401`.
- If the caller's account has an open two-factor challenge, has not verified its email, or needs a subscription, the route answers `403` and no token is issued. Guests need no verified email.
- If `GATEWAY_GAME_SERVER_SECRET` is not set the route answers `500`.
- For a cluster realm (`?realm=<region>`) the response also names the node the token is for, as `nodeId` and `node`, and the signature covers the node id too: `token:timestamp:expiresAt:origin:account:nodeId`. The client connects to that node. See below for how it is chosen.

For a cluster realm the node is the one that owns the block of the account's saved position (the dead player's corpse, when the player is dead), when the gateway knows it and that node is online. Otherwise it is the online node with the fewest connections. The webserver counts each token it hands out as one more connection on its node until that node's next heartbeat, so a burst of logins is spread over the nodes. When the gateway cannot be asked in time, or knows nothing of the position or its map, the least-loaded node is used, exactly as for an account without a saved position.

The client sends these six values, plus its user agent, in an `AUTH_CONNECT` frame as the first thing on the new session. The game server recomputes the signature, checks the expiry, checks the origin when its `CORS_ALLOWED_ORIGINS` is set, and refuses a token it has already accepted once. It then answers `AUTH_CONNECT_SUCCESS` and the normal login handshake begins. At login it only accepts the session token whose SHA-256 equals `account`. See [Networking](#/engine/networking).

```ts title="How the signature is made"
const signature = crypto
  .createHmac("sha256", process.env.GATEWAY_GAME_SERVER_SECRET)
  .update(`${token}:${timestamp}:${expiresAt}:${origin}:${account}`)
  .digest("hex");
```

:::note What the token proves
The token shows that the client came through this gateway within the last minute, for one account, from one page origin. It opens one connection only and it is not tied to one realm. The player still logs in afterwards with the session token from [Authentication](#/gateway/authentication/session-token).
:::

## Failover

Two separate mechanisms deal with a game server that disappears.

### In the game client

When the session to a game server closes unexpectedly and `GATEWAY_ENABLED` is `true`, the client tries to reconnect a few times, a short pause apart. Each attempt runs the connection steps above again: a fresh token, a fresh realm list, the chosen realm first and otherwise the first `online` realm. On success the page reloads. When every attempt has failed, the player is asked to refresh the page.

### In the gateway server

The gateway server proxies any path it does not handle itself to a registered game server over HTTP. It picks a server at random and remembers the choice in a `gateway_http_session` cookie, so later requests go to the same server.

When the sweep removes a dead server, these proxy sessions are moved to the remaining servers that still have room, in round robin order. If no server has room they are dropped. The dashboard API reports the number of moved sessions and the latest migrations. A proxy session is forgotten `SESSION_TIMEOUT` after it was created or moved.

:::note Sessions here are HTTP proxy sessions
The migration in the gateway server concerns its own HTTP proxy sessions. It does not move a player's WebTransport connection, which runs directly between browser and game server. That part is handled by the reconnect logic in the client.
:::

## Gateway server HTTP API

Served on `GATEWAY_PORT` (9999), or `GATEWAY_PORTSSL` (9443) with TLS. `OPTIONS` requests get a `204` with permissive CORS headers.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/register` | `authKey` in body | Add or replace a game server |
| POST | `/heartbeat` | `authKey` in body | Report load and keep the server alive |
| POST | `/unregister` | `authKey` in body | Remove a game server |
| POST | `/blocks` | `authKey` in body | A cluster node reports which node owns each block of one map |
| GET | `/route` | `x-gateway-key` header | Which live node of a cluster region owns a position of a map. Used by the webserver. |
| GET | `/status` | None | Public realm list with state, player counts and whitelist flag |
| GET | `/debug/sessions` | Dashboard session (`dashboard_session` cookie) | The HTTP proxy sessions and which server each is bound to |
| GET | `/` | None | Dashboard login page |
| GET | `/api/session` | Website `token` cookie | Whether the caller is logged in and may open the dashboard |
| POST | `/api/login` | Website `token` cookie of an admin with `server.gateway` or `server.*` | Start a dashboard session, sets the `dashboard_session` cookie |
| POST | `/api/logout` | None | End the dashboard session |
| GET | `/api/stats` | Dashboard cookie | Servers with CPU, memory, latency and health, plus migration history |
| GET | `/dashboard` | Dashboard cookie | The dashboard page. Redirects to `/` without a valid session. |
| GET | `/css/...`, `/js/...`, `/img/...`, `/images/...` | None | Static files for the two pages above |
| Any | Anything else | None | Proxied to a registered game server, `503` when there is none |

```bash title="Check the realm list"
curl http://localhost:9999/status
```

```json title="GET /status"
{
  "totalServers": 1,
  "servers": [
    {
      "id": "realm-one",
      "description": "The first realm",
      "publicHost": "localhost",
      "port": 3000,
      "wtPort": 3000,
      "wtEnabled": true,
      "useSSL": true,
      "activeConnections": 42,
      "maxConnections": 2000,
      "latency": 2,
      "whitelisted": false,
      "pvp": false,
      "status": "online"
    }
  ]
}
```

:::warning Protect the gateway port
`/status` needs no key and `/debug/sessions` needs a dashboard session, and the request filter of the [Reverse Proxy](#/gateway/reverse-proxy) does not run on this port. Limit access to the gateway port with a firewall where you can. Browsers never need it: the website fetches the realm list for them over loopback.
:::

The dashboard routes are described in [Dashboard](#/gateway/dashboard).
