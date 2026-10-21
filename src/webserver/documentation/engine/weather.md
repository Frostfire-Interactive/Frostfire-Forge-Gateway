---
title: Weather
description: How weathers are defined and drawn, the weather commands, real weather from OpenWeatherMap, and how time of day works.
order: 120
---

Each world has a weather. The server stores and announces it, and the client draws rain, snow, wind, lightning and darkness from it. This page explains the data, the commands that change it, the optional link to real weather, and the day and night cycle.

## How a weather is defined

A weather is a row of the `weather` table. A world (a row of the `worlds` table) refers to its weather by name.

| Column | Range | Meaning |
|--------|-------|---------|
| `name` | Up to 45 characters: lower case letters, digits, `_` and `-`, starting with a letter or digit | What worlds refer to, and what the client decides its drawing by |
| `temperature` | -100 to 200 | Degrees Fahrenheit. Below 32, rain falls as snow. |
| `humidity` | 0 to 100 | Stored with the weather |
| `wind_speed` | 0 to 100 | Miles per hour. Drives wind streaks and how far rain and snow slant. |
| `wind_direction` | `none`, `left`, `right`, `up`, `down` | Where the wind blows to on screen |
| `precipitation` | 0 to 100 | How much rain or snow falls |
| `ambience` | 0 to 1 | How dark the scene gets in `thunderstorm` and `darkness` weather |
| `sounds` | Up to 12 sounds of each kind | Rain, wind and thunder sounds (JSON). Each is an audio file at its own volume. A rain or wind sound is heard while the precipitation or the wind speed is within its range. A thunder sound has no range: one is picked at random at each lightning strike. |

The limits are enforced by the weather editor (`src/systems/weathereditor.ts`).

A world's weather is either the name of such a row or one of four special words:

| Word | Meaning |
|------|---------|
| `clear` | No rain, snow or darkening. `clear` also exists as a row, so it can still have wind. |
| `random` | A random weather from the table (never `tornado`), picked again every 30 minutes |
| `weather_api` | The real weather of a configured place. See [Real weather](#/engine/weather/real-weather). |
| `tornado` | A thunderstorm with tornadoes: the world always has one or two. Uses the `tornado` row, or the `thunderstorm` values when there is none. Tornadoes pull in players who come near and take 5% of their maximum health every second. Any thunderstorm world also has a rare chance of one. |

`random`, `none` and `weather_api` are reserved and cannot be used as the name of a weather.

### Seeded weathers

The setup scripts insert these rows if they are missing:

| Name | Ambience | Wind | Humidity | Temperature | Precipitation |
|------|----------|------|----------|-------------|---------------|
| `clear` | 0 | none, 0 | 30 | 68 | 0 |
| `thunderstorm` | 0.8 | right, 25 | 90 | 55 | 80 |
| `darkness` | 0.9 | none, 0 | 40 | 50 | 0 |
| `rainy` | 0 | left, 6 | 85 | 58 | 50 |
| `snowy` | 0 | left, 4 | 80 | 25 | 80 |
| `sandstorm` | 0 | right, 35 | 10 | 100 | 0 |
| `tornado` | 0.85 | right, 30 | 85 | 68 | 75 |
| `blizzard` | 0 | right, 35 | 85 | 10 | 80 |

The seeded weathers other than `blizzard` are given default rain, wind and thunder sounds when they have none.

The world `overworld` is seeded with the weather `rainy`.

### Where the data lives at runtime

All weathers are loaded into `assetCache` under the key `weather` at startup. `src/systems/weather.ts` writes the table first and then the cached list, so reads never touch the database.

```ts title="src/systems/weather.ts"
async find(weather: WeatherData) {
  if (!weather?.name) return;
  const weathers = await assetCache.get("weather") as WeatherData[];
  return weathers.find((w) => w.name === weather.name);
},
```

## How a weather is drawn

The client picks what to draw by the weather's name. The row's values shape it.

| Name | Drawn |
|------|-------|
| `rainy` | Rain, with splashes where it lands |
| `thunderstorm` | Rain, lightning bolts and a darkened scene |
| `snowy` | Snow, which melts where it lands |
| `darkness` | A near black scene with no sun and no shadows |
| `sandstorm` | Blowing dust and an orange tint, only while the player stands in a desert zone of a world map. Its wind speed sets how harsh it is. |
| `blizzard` | Blowing snow and a cold tint, only while the player stands in a snow zone of a world map. Its wind speed sets how harsh it is. |
| `clear` or any other name | No rain, snow or darkening. Only its wind. |

The server tells a `tornado` world as `thunderstorm`, with `sandstorm` and `blizzard` set to `true` in `weatherData`, so it also blows a sandstorm in desert zones and a blizzard in snow zones. The desert and snow zones come from a world's manifest (see [World maps](#/engine/world-maps)).

How the values change the picture:

- **Precipitation** sets how many rain drops or snow flakes are drawn: `precipitation / 100` of the full amount, never less than a tenth for a weather that is named for rain or snow.
- **Temperature** below 32 turns the rain of `rainy` and `thunderstorm` into snow.
- **Wind speed and direction** draw wind streaks across the screen and push rain and snow. A direction of `none` or a speed of 0 draws no streaks.
- **Ambience** is the opacity of the dark overlay in `thunderstorm` and `darkness`.

The drawing code is part of the game client (`weather.ts`, `ambience.ts`, `windstreaks.ts`, `sandstorm.ts`, `blizzard.ts` and `tornado.ts` in the gateway's `public/js/core`).

### Packets

| Packet | Sent when | Data |
|--------|-----------|------|
| `WEATHER` | A player logs in or loads a map | `{ weather, weatherData }` |
| `CHANGE_WEATHER` | The weather of the player's world changes | `{ weather, weatherData }` |
| `LIGHTNING` | A bolt strikes on a thunderstorm world | `{ x, y, map }` |
| `TORNADOES` | Tornadoes are on the player's map, and once more with an empty list when the last is gone | `{ map, tornadoes }`, each `{ id, x, y }` |

`weather` is the name the client draws by, and `weatherData` is the row (or `null`). A weather with no sounds of its own carries the sounds of the weather it is drawn as. On `CHANGE_WEATHER` the client fades the old weather out and the new one in. If only the values changed, it applies them without a fade.

:::note Maps without a world
Weather belongs to worlds: a map takes part when the `worlds` table has a row with the map's name. The map data sent to the client carries a `hasWeather` flag that says whether such a row exists, and a map without one resolves to `clear`.
:::

### Lightning

While any world shows `thunderstorm`, the server picks a random player on that world every 2 to 5 seconds and places a bolt within 300 pixels left or right and 200 pixels above or below them. The `LIGHTNING` packet goes, as a datagram, to that player and everyone who can see them.

## Weather commands

| Command | Permission | Effect |
|---------|------------|--------|
| `/weather <name>` | `admin.weather` or `admin.*` | Sets the weather of the world you are standing on to a weather from the table |
| `/weather clear` | same | Clear weather |
| `/weather random` | same | A random weather now, and a new one every 30 minutes |
| `/weather weather_api` | same | Follow the real weather |
| `/weather tornado` | same | A thunderstorm with tornadoes |
| `/we` or `/weathereditor` | `tools.weather_editor`, `tools.*`, `server.admin` or `server.*` (admins always) | Opens the weather editor |

```text title="In game chat"
/weather thunderstorm
/weather random
/weather weather_api
```

`/weather` writes the new weather to the `worlds` table, so it survives a restart, and sends `CHANGE_WEATHER` to every player on that world. An unknown name answers `Weather '<name>' not found`.

The full command list is on the [Admin commands](#/engine/admin-commands) page, and permissions are explained under [Permissions](#/engine/permissions).

### The weather editor

The editor creates, changes and deletes weathers while the server runs. Every save is validated, written to the database and the cache, and shown at once to the players of every world that uses that weather.

- A weather's name cannot be changed after it is created.
- `clear` cannot be deleted. It is what a world falls back to.
- Deleting a weather sets every world that used it to `clear`.

The window itself is described in [Weather editor](#/tools/weather-editor).

## Real weather

A world set to `weather_api` follows the weather of a real place, read from OpenWeatherMap's Current Weather Data API.

```env title=".env.production"
WEATHER_API_KEY=change-me
# "lat,lon" or "City,CountryCode"
WEATHER_API_LOCATION=Seattle,US
# Minutes between readings (default 10, minimum 1)
WEATHER_API_MINUTES=10
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEATHER_API_KEY` | none | Your OpenWeatherMap key |
| `WEATHER_API_LOCATION` | none | `47.61,-122.33` or `Seattle,US` |
| `WEATHER_API_MINUTES` | `10` | Minutes between readings |

Then give it to a world:

```text title="In game chat"
/weather weather_api
```

How it behaves (`src/systems/weatherapi.ts`):

- A reading is taken at startup and then every `WEATHER_API_MINUTES`. A request times out after 10 seconds.
- The reading is held in memory. It is not a row of the `weather` table and is never written to the database.
- There is one reading for the whole server. Every world on `weather_api` shows the same weather.
- When a reading differs from the last one, every player on such a world gets `CHANGE_WEATHER` straight away.
- Without a key or a location nothing is requested, and `weather_api` is a still, clear day (68 degrees, no wind).
- If a request fails, the last reading is kept. A repeated failure is logged once, not every few minutes.

### From a reading to a weather

The client only knows the names it can draw, so it is never told `weather_api`. The server translates the reading's condition code and wind into one of five names:

| OpenWeatherMap condition id | Shown as |
|-----------------------------|----------|
| 200 to 299 (thunderstorm) | `thunderstorm` |
| 300 to 399 (drizzle), 500 to 599 (rain) | `rainy` |
| 600 to 699 (snow) | `snowy` |
| Everything else, with a wind of 1 mph or more, or sand and dust (731, 751, 761) | `sandstorm` |
| Everything else | `clear` |

A reading with a wind of 1 mph or more also has `blizzard` set to `true` in `weatherData`, so it blows a blizzard in snow zones.

| Value | How it is derived |
|-------|-------------------|
| `temperature` | The reading in Fahrenheit, rounded |
| `humidity` | The reading's humidity |
| `wind_speed` | Miles per hour, capped at 100 |
| `wind_direction` | Opposite of the compass bearing the wind comes from: a west wind blows `right`, a north wind blows `down`. Below 1 mph it is `none`. |
| `precipitation` | 0 when dry. Otherwise 5 to 100 from the millimetres per hour (snow counts three times), or 20, 50 or 85 from the condition code when no amount is reported. |
| `ambience` | `0.8` in a thunderstorm, up to `0.3` from cloud cover when dry, `0.3` to `0.6` when it rains or snows |

```ts title="src/systems/weatherapi.ts"
function lookOfCondition(id: number): Look {
  if (id >= 200 && id < 300) return "thunderstorm";
  if ((id >= 300 && id < 400) || (id >= 500 && id < 600)) return "rainy";
  if (id >= 600 && id < 700) return "snowy";
  return "clear";
}
```

:::tip A new key needs time
OpenWeatherMap answers `401` for a key that is not active yet. The log then says the key was refused and that a new key takes up to two hours to work. A `404` means the place in `WEATHER_API_LOCATION` was not found.
:::

## Time of day

The game follows the real clock. There is no accelerated in game day.

1. At login the server sends one `SERVER_TIME` packet with its current time.
2. The client anchors its clock to that time and advances it locally. The server does not send the time again every second.
3. Once a minute the client recomputes the ambience: a colour gradient and darkness level interpolated between keyframes for the hours of the day (night until 4, dawn from 5 to 7, full daylight at 12, dusk from 18 to 20).

```ts title="src/socket/packet_manager.ts"
serverTime: (utcOffset?: number | null) => {
  return [
    packet.encode(JSON.stringify({ type: "SERVER_TIME", data: Date.now(), ...(utcOffset != null ? { utcOffset } : {}) })),
  ] as any[];
},
```

### Whose clock

| Situation | Time of day shown |
|-----------|-------------------|
| Real weather is off | Each player's own local time |
| Real weather is on | The local time of the place in `WEATHER_API_LOCATION`, for every player on every world |

Each OpenWeatherMap reading carries the place's offset from UTC in seconds, daylight saving included. The server passes it along as `utcOffset` in `SERVER_TIME`. When the offset first becomes known, or changes with daylight saving, every online player is sent `SERVER_TIME` again.

:::note
The time of day follows the real weather's place as soon as a key and a location are set, whether or not any world is set to `weather_api`.
:::

The client only draws the day and night overlay while weather is active for the current map. `thunderstorm` and `darkness` replace it with their own darker look.
