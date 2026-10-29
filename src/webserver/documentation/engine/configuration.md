---
title: Configuration
description: Every engine environment variable, the generated files under src/config, and the package.json scripts.
order: 10
---

The engine is configured in two places: an environment file (`.env.development` or `.env.production`) and three generated files under `src/config/`. This page lists every variable and every key the code reads, with the default the code falls back to.

## How configuration is created

`bun create-config` runs `src/utility/create_config.ts`. It only writes what is missing, so it is safe to run on every start (the `development` and `production` scripts do exactly that).

```bash title="Create the configuration"
bun create-config --environment development
bun create-config --environment production
```

| File | Written when | Notes |
|------|--------------|-------|
| `.env.development` | Missing and `--environment development` | Filled with local defaults |
| `.env.production` | Missing and `--environment production` | Every value empty except `LOG_LEVEL` and `PVP`: fill it in before starting |
| `src/config/settings.json` | Missing | An existing file is only migrated (old `websocket` keys become `webtransport` keys) |
| `src/config/aoi.json` | Missing | An existing file gets missing keys backfilled, and `USE_SPATIAL_GRID` is forced to `true` |
| `src/config/security.cfg` | Missing | Never changed once it exists |

:::note
Without `--environment`, the script writes only the three files under `src/config/` and no environment file.
:::

Bun loads the environment file through the `--env-file` flag in each script:

:::tabs
```bash title="Development"
bun development
# bun create-config --environment development
# bun --env-file=.env.development ./src/socket/server.ts
```
```bash title="Production"
bun production
# bun create-config --environment production
# bun --env-file=.env.production ./src/socket/server.ts --sql-preconnect
```
:::

## Example environment file

```env title=".env.development"
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=frostfire_forge
DATABASE_USER=root
DATABASE_PASSWORD=change-me
SQL_SSL_MODE=DISABLED

WEBSRV_PORT=3000
WEBSRV_PORTSSL=3000
WEBSRV_INTERNAL_PORT=3002
HTTP_USE_SSL=false
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

GAME_NAME=My Game
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1

GATEWAY_URL=http://localhost:9999
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me

SERVER_ID=server-1
SERVER_DESCRIPTION=My Realm
SERVER_HOST=localhost
PUBLIC_HOST=localhost
WHITELIST=false

ASSET_SERVER_URL=http://localhost:8000
ASSET_SERVER_AUTH_KEY=change-me

CACHE=memory
DB_WORKER_POOL_SIZE=8
AUTH_POOL_SIZE=8
```

## Environment variables

"Default" is what the code uses when the variable is unset or empty. "Required" means startup aborts without it.

### Database

| Name | Default | Purpose |
|------|---------|---------|
| `DATABASE_ENGINE` | Required (`mysql` inside the worker) | `mysql` or `sqlite`. The query worker also has a `postgres` branch, but no setup script exists for it. |
| `DATABASE_HOST` | Required, except with SQLite | Database host |
| `DATABASE_PORT` | `3306` | Database port |
| `DATABASE_USER` | Required, except with SQLite | Database user |
| `DATABASE_PASSWORD` | Required, except with SQLite | Database password |
| `DATABASE_NAME` | Required, except with SQLite when `DATABASE_PATH` is set | Database name. With SQLite it is the file name: `<tmp>/frostfire_forge/<DATABASE_NAME>.sqlite`. |
| `DATABASE_PATH` | none | SQLite only: the full path of the database file, used instead of the name above. Its folder is created when missing. |
| `SQL_SSL_MODE` | No TLS | Unset or `DISABLED` connects without TLS. Any other value loads `src/certs/db.crt` and connects with TLS. |
| `DB_WORKER_POOL_SIZE` | `8` | Number of database worker threads |

:::warning Set SQL_SSL_MODE explicitly
Startup validation replaces an empty `SQL_SSL_MODE` with the string `false`, and only `DISABLED` (or unset) means "no TLS" to the connection code. Write `SQL_SSL_MODE=DISABLED` when you do not use a database certificate.
:::

See [Database](#/engine/database) for the engines and the setup scripts.

### Ports and HTTP

| Name | Default | Purpose |
|------|---------|---------|
| `WEBSRV_PORTSSL` | `3000` | The game port. WebTransport listens on its UDP side. With `HTTP_USE_SSL=true` the HTTPS API listens on its TCP side. Falls back to `GAME_PORT`, then `3000`. |
| `GAME_PORT` | none | Fallback for `WEBSRV_PORTSSL` only |
| `WEBSRV_PORT` | The game port | Public plain HTTP port. With `HTTP_USE_SSL=true` this port only answers with a redirect to HTTPS. |
| `WEBSRV_INTERNAL_PORT` | `3002` | Port of the internal HTTP API, bound to `127.0.0.1` |
| `HTTP_USE_SSL` | off | `true` turns on TLS for the public HTTP listener (the certificate files must exist) |
| `WEBSRV_HTTP1` | on | `false` turns HTTP/1.1 off |
| `WEBSRV_HTTP2` | on | `false` turns HTTP/2 off |
| `WEBSRV_HTTP3` | ignored | The engine always passes `http3: false` to its public HTTP listener, because WebTransport owns the UDP port |

### TLS certificates

| Name | Default | Purpose |
|------|---------|---------|
| `TLS_CERT_PATH` | Required | Certificate (PEM). Generated on startup when missing. |
| `TLS_KEY_PATH` | Required | Private key (PEM). Generated on startup when missing. |
| `TLS_CA_PATH` | none | CA bundle appended to the certificate chain |
| `SKIP_CERT_TRUST` | off | `true` stops the engine from adding a generated certificate to the Windows user root store |
| `LAN_CA_KEY_PATH` | mkcert's default path | Only read by `bun renew-lan-cert`: the key of the local CA that signs the renewed certificate |

Details are on the [Networking](#/engine/networking) page.

### Realm, gateway and asset server

| Name | Default | Purpose |
|------|---------|---------|
| `GAME_NAME` | Required | Checked at startup: the server aborts when it is empty |
| `SERVER_ID` | `server-<random hex>` | The realm id sent to the gateway. The whitelist uses `default` and asset server requests use `game-server` when it is unset, so always set it. |
| `SERVER_DESCRIPTION` | empty | Text shown for the realm |
| `SERVER_HOST` | `localhost` | Host the gateway uses to reach this server. Also added to a generated certificate. |
| `PUBLIC_HOST` | `SERVER_HOST` | Host that browsers connect to. Also added to a generated certificate. |
| `WHITELIST` | off | `true` starts the realm with its [whitelist](#/engine/realm-whitelist) on |
| `PVP` | on | `false` stops every harmful spell one player casts on another. Beneficial spells and spells on creatures still work. Sent to the gateway at registration. |
| `GATEWAY_URL` | `http://localhost:9999` | Gateway address for registration and heartbeats |
| `GATEWAY_INTERNAL_URL` | none | Used instead of `GATEWAY_URL` when set (a server to server address) |
| `GATEWAY_AUTH_KEY` | none | Sent with register, heartbeat and unregister requests |
| `GATEWAY_GAME_SERVER_SECRET` | none | Shared secret that signs connection tokens. Without it every connection is refused. |
| `ASSET_SERVER_URL` | none | Asset server address for map and world sync. Without it, map sync at startup is skipped, and other requests fall back to `http://localhost:8000` or `http://localhost:8081`. |
| `ASSET_SERVER_INTERNAL_URL` | none | Used instead of `ASSET_SERVER_URL` for server to server requests when set |
| `ASSET_SERVER_AUTH_KEY` | `GATEWAY_AUTH_KEY` | Sent with every asset server request |
| `WORLD_SYNC_INTERVAL` | `10` | Seconds between checks for worlds changed on the asset server. `0` turns the check off. See [Changes made outside the game](#/engine/world-maps/changes-made-outside-the-game). |

### Security

| Name | Default | Purpose |
|------|---------|---------|
| `CORS_ALLOWED_ORIGINS` | empty | Comma separated origins. Empty blocks every cross origin HTTP request. When set, a WebTransport connection must also come from one of these origins. `*` allows every origin for HTTP only. |
| `SESSION_KEY` | generated | Overwritten with a random value on every start. Do not set it. |
| `RSA_PASSPHRASE` | generated | Overwritten with a random value on every start (it protects the chat key pair). Do not set it. |
| `TOKEN_LIFETIME_HOURS` | `168` (7 days) | Hours an account token lasts from when it is issued. After that a new password login is needed. |

### Cache and login workers

| Name | Default | Purpose |
|------|---------|---------|
| `CACHE` | `memory` | `redis` keeps asset data and cached rows in Redis. See [Caching](#/engine/caching). |
| `REDIS_URL` | none | Redis address. When `CACHE=redis` and this is empty, the server warns and falls back to `memory`. |
| `AUTH_POOL_SIZE` | `8` | Number of login worker threads |

### Cluster

These variables only matter with `CLUSTER=true`. Each one is explained on [Cluster Mode](#/engine/cluster/environment-variables).

| Name | Default | Purpose |
|------|---------|---------|
| `CLUSTER` | off | `true` makes this process a [cluster node](#/engine/cluster). Unset or `false` runs the engine as a single process. |
| `NODE_ID` | Required in a cluster | The node's name in the cluster: 1 to 64 letters, digits, `_` or `-` |
| `REGION_ID` | Required in a cluster | The region the node serves, with the same characters. Shared by every node and coordinator of one world. |
| `CLUSTER_LINK_SECRET` | Required in a cluster | At least 32 random characters. Signs the node links, the cluster bus and sealed Redis records. |
| `NODE_LINK_PORT` | Game port plus 1 | UDP port of the node link listener. `0` turns links off. |
| `NODE_LINK_HOST` | `SERVER_HOST`, else `127.0.0.1` | The address other nodes dial to reach this node's links |
| `NODE_LINK_BIND_HOST` | Required in a cluster unless `NODE_LINK_PORT=0` | The interface the link listener binds. Use the node's private address. |
| `CLUSTER_EXPECTED_NODES` | none | Coordinator only: split a new map once this many nodes are alive |
| `CLUSTER_SETTLE_MS` | `60000` with `CLUSTER_EXPECTED_NODES` | Coordinator only: the longest the first split waits |

A cluster node also needs `CACHE=redis`, a `REDIS_URL` with a password (or a `rediss://` URL) and `GATEWAY_GAME_SERVER_SECRET`.

### Weather

| Name | Default | Purpose |
|------|---------|---------|
| `WEATHER_API_KEY` | none | OpenWeatherMap key. Empty turns real weather off. |
| `WEATHER_API_LOCATION` | none | `lat,lon` (`47.61,-122.33`) or a city with its country (`Seattle,US`) |
| `WEATHER_API_MINUTES` | `10` | Minutes between readings, at least 1 |

See [Weather](#/engine/weather).

### Chat translation

| Name | Default | Purpose |
|------|---------|---------|
| `TRANSLATION_SERVICE` | `google_translate` | `google_translate` or `openai` |
| `GOOGLE_TRANSLATE_API_KEY` | none | Key for Google Translate. Startup warns when it is missing. |
| `OPENAI_API_KEY` | none | Key for the OpenAI client, used when the service is `openai` |
| `OPENAI_MODEL` | `gpt-4.1-nano-2025-04-14` | Model used for translation |

### Logging and diagnostics

| Name | Default | Purpose |
|------|---------|---------|
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn` or `error`. Only `debug` and `trace` output is gated: `debug` lines print at `debug` or `trace`, `trace` lines print at `trace`. |
| `BENCHMARK_PROFILE` | off | `1` or `true` prints profiling lines (`[profile:gameloop]`, `[profile:inbound]` and others) every 5 seconds |
| `WT_HANDSHAKE_RATE_LIMIT_DISABLED` | off | `true` replaces the handshake limits from `settings.json` with "no limit". See the note under [settings.json](#/engine/configuration/settingsjson). |
| `GATEWAY_ENABLED` | off | Only read by `bun benchmark`: `true` routes benchmark clients through the gateway |

Log lines are also appended to `src/logs/<date>.log`.

## Startup validation

`src/utility/validate_config.ts` runs while the server's modules load, before any listener opens.

| Problem | Result |
|---------|--------|
| `DATABASE_ENGINE`, `DATABASE_NAME` or `GAME_NAME` is empty (`DATABASE_NAME` may be empty with SQLite when `DATABASE_PATH` is set) | Error, then `process.exit(1)` |
| `DATABASE_HOST`, `DATABASE_USER` or `DATABASE_PASSWORD` is empty, and the engine is not SQLite | Error, then `process.exit(1)` |
| `DATABASE_PORT` is empty, and the engine is not SQLite | Warning, set to `3306` |
| `LOG_LEVEL` is empty or not a known level | Warning, set to `info` |
| `WEBSRV_PORTSSL` and `GAME_PORT` are both empty | Warning, port `3000` |
| `CACHE=redis` without `REDIS_URL` | Warning, `CACHE` set to `memory` |
| `CLUSTER=true` without `CACHE=redis`, `REDIS_URL` or `GATEWAY_GAME_SERVER_SECRET`; with a `CLUSTER_LINK_SECRET` shorter than 32 characters; with a `REDIS_URL` that is not a valid `redis://` or `rediss://` URL, has no password (unless it uses `rediss://`) or has a placeholder password; with an invalid `NODE_ID`, `REGION_ID` or `NODE_LINK_PORT`; or with `NODE_LINK_BIND_HOST` unset, unless `NODE_LINK_PORT=0` | Error, then `process.exit(1)` |
| `SESSION_KEY` or `RSA_PASSPHRASE` is set | Warning, the value is replaced |
| `settings.json` has no `webtransport` or `packetRatelimit` section | Warning |

:::warning An empty password stops the server
`DATABASE_PASSWORD=""` counts as "not set", and so does every other required database variable. The generated `.env.development` uses MySQL and has an empty password: fill it in.
:::

## settings.json

`src/config/settings.json` is imported as a module, so a change needs a restart.

```json title="src/config/settings.json"
{
  "webserverRatelimit": { "enabled": true, "windowMs": 5, "max": 500 },
  "packetRatelimit": { "enabled": true, "maxRequests": 2000, "time": 2000, "maxWindowTime": 1000 },
  "webtransport": {
    "enabled": true,
    "maxPayloadMB": 50,
    "benchmarkenabled": false,
    "idleTimeout": 120,
    "maxSessions": 50000,
    "maxDatagramSize": 1200,
    "authTimeoutMs": 10000,
    "rateLimits": {
      "handshakesPerSec": 1000,
      "handshakesBurst": 2000,
      "handshakesBurstPerPrefix": 500,
      "streamsPerSec": 2000,
      "streamsBurst": 4000,
      "datagramsPerSec": 500000,
      "datagramsBurst": 200000
    }
  },
  "gateway": { "heartbeatInterval": 5000 },
  "world": "overworld",
  "default_map": "overworld.json",
  "spawn_x": null,
  "spawn_y": null
}
```

| Key | Generated value | What it does |
|-----|-----------------|--------------|
| `packetRatelimit.enabled` | `true` | Turns the per connection packet limit on |
| `packetRatelimit.maxRequests` | `2000` | Packets a connection may send in one counting window before it is rate limited |
| `packetRatelimit.maxWindowTime` | `1000` | Length of the counting window. Every second, 1000 ms is added to a connection's window time, and its counter resets once that exceeds this value (every 2 seconds with the default). |
| `packetRatelimit.time` | `2000` | Milliseconds a rate limited connection stays muted |
| `webtransport.maxPayloadMB` | `50` | Largest frame, in megabytes. Falls back to `1` when missing. Only admins and players with a permission get this much: a connection with no player logged in, and any other player, get a smaller limit. |
| `webtransport.benchmarkenabled` | `false` | `true` lets every connection send frames up to `maxPayloadMB` |
| `webtransport.maxSessions` | `50000` | Largest number of WebTransport sessions. Also reported to the gateway as the realm's capacity. Falls back to `2000`. |
| `webtransport.maxDatagramSize` | `1200` | Largest datagram in bytes. Larger movement batches are split, other packets go on the stream. |
| `webtransport.authTimeoutMs` | `10000` | Time a new session has to send a valid `AUTH_CONNECT` frame |
| `webtransport.idleTimeout` | `120` | Seconds a connection may stay open without logging a player in. Then it is closed. |
| `webtransport.rateLimits.*` | see above | Limits on new sessions and on datagrams. See the note below. |
| `gateway.heartbeatInterval` | `5000` | Milliseconds between heartbeats to the gateway |
| `world` | `overworld` | Name of the default world (a row of the `worlds` table) |
| `default_map` | `overworld.json` | Map new characters start on. Falls back to `main`. |
| `spawn_x`, `spawn_y` | `null` | Start position in pixels. `null` uses the world's own spawn point, or the centre of the map. |
| `webserverRatelimit.*` | see above | Requests one address may send to the HTTP API: at most `max` (500) in each `windowMs`. A `windowMs` under 1000 is read as seconds, so `5` is 5 seconds. More answers `429`. `enabled: false` turns it off. |
| `webtransport.enabled` | `true` | Generated, but nothing in the engine's `src/` reads it |

:::note Transport limits
The transport (`src/socket/transport.ts`) applies `handshakesPerSec` and `handshakesBurst` to new sessions, and `datagramsPerSec` and `datagramsBurst` to incoming datagrams, each for the whole server. A session over the handshake limit is refused, and a datagram over its limit is dropped. `handshakesBurstPerPrefix`, `streamsPerSec` and `streamsBurst` are read and logged, but not enforced. `WT_HANDSHAKE_RATE_LIMIT_DISABLED` removes the handshake limits.
:::

Optional keys that are not generated but are read when present:

| Key | Default | What it does |
|-----|---------|--------------|
| `animation_system.use_sprite_sheets` | `true` | Turns the sprite sheet system off when `false` |
| `creatures.yardPx` | `8` | Pixels per yard for creature ranges |
| `creatures.respawnMultiplier` | `1` | Multiplier applied to every rolled respawn time |
| `webtransport.rateLimits.datagramsPerSecPerConnection` | `240` | Datagrams one connection may send per second. More are dropped. |
| `webtransport.rateLimits.datagramsBurstPerConnection` | `480` | Datagrams one connection may send at once |
| `webtransport.rateLimits.maxConcurrentStreams` | `16` | Streams one session may have open at once |

## aoi.json

```json title="src/config/aoi.json"
{
  "DEFAULT_RADIUS": 1000,
  "UPDATE_THRESHOLD": 100,
  "GRID_CELL_SIZE": 512,
  "USE_SPATIAL_GRID": true,
  "SPATIAL_GRID_THRESHOLD": 50,
  "MAX_PLAYERS_PER_LAYER": 150,
  "BLOCK_SIZE_PX": 4096,
  "MAX_VISIBLE_PLAYERS": 150,
  "NEAR_TIER_DISTANCE": 500,
  "FAR_UPDATE_EVERY": 3,
  "EXIT_HYSTERESIS": 1.25,
  "DEBUG": false
}
```

`MAX_PLAYERS_PER_LAYER` is counted per block of `BLOCK_SIZE_PX` pixels, not per map. Every key is explained on the [AOI and layers](#/engine/aoi-and-layers/aoijson-settings) page.

## security.cfg

`src/config/security.cfg` is a plain list of path fragments, one per line (`.env`, `wp-admin`, `php`, `shell` and similar probes). `create_config.ts` writes it, and the server reads it once at startup. A request to the HTTP API whose path has a segment on the list is answered `404` (`.env` also covers `.env.*`). Lines starting with `#` and blank lines are skipped. The gateway keeps its own copy of the same list for its reverse proxy: see [Reverse proxy](#/gateway/reverse-proxy).

## package.json scripts

| Script | What it runs |
|--------|--------------|
| `bun development` | `create-config --environment development`, then the server with `.env.development` |
| `bun production` | `create-config --environment production`, then the server with `.env.production` |
| `bun create-config` | `src/utility/create_config.ts` |
| `bun setup-development` | `create-config --environment development` only |
| `bun setup-production` | `create-config --environment production`, then `bun setup` |
| `bun setup` | `src/utility/database_setup_dispatch.ts` with `.env.production`: the SQLite script when `DATABASE_ENGINE=sqlite`, otherwise `src/utility/database_setup.ts` (MySQL schema and seed data) |
| `bun setup-localdb` | `src/utility/database_setup_sqlite.ts` (SQLite schema and seed data) with `.env.development` |
| `bun generate-local-cert` | `src/utility/generate_local_cert.ts`: creates a local WebTransport certificate when needed |
| `bun renew-lan-cert` | `src/utility/renew_lan_cert.ts`: renews a certificate signed by a local CA |
| `bun docker:dev`, `docker:dev:down`, `docker:dev:logs`, `docker:dev:build`, `docker:dev:rebuild` | Docker Compose with `src/docker/docker-compose.dev.yml` |
| `bun docker:prod`, `docker:prod:down`, `docker:prod:logs`, `docker:prod:build`, `docker:prod:rebuild` | Docker Compose with `src/docker/docker-compose.prod.yml` |
| `bun cluster <nodes>` | `create-config --environment production`, then starts Redis (when `REDIS_URL` is this machine's port 6379) and runs `<nodes>` cluster nodes and a coordinator with `.env.production`. See [Running a cluster](#/engine/cluster/running-a-cluster) |
| `bun cluster-local <nodes>` | `src/utility/cluster-local.ts` with `.env.production`: the same cluster, without starting Redis |
| `bun coordinator:production` | `src/cluster/coordinator-main.ts` with `.env.production`: one cluster coordinator |
| `bun benchmark`, `benchmark:development` | `src/utility/benchmark-cli.ts` with `.env.development` |
| `bun benchmark:production` | `src/utility/benchmark-cli.ts` with `.env.production` |
| `bun benchmark:connections` | `src/utility/benchmark-connections.ts` with no environment file |
| `bun benchmark:connections:development`, `benchmark:connections:production` | The same tool with the matching environment file |
| `bun creature-loadtest`, `creature-loadtest:production` | `src/utility/creature-loadtest.ts` |

:::note
`--sql-preconnect` in the `production` script is placed after the script path, and nothing under `src/` reads it.
:::

The load test scripts are covered in [Benchmarking](#/engine/benchmarking), and the checks that run before a commit in [Testing](#/engine/testing).
