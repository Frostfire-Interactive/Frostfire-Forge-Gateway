---
title: Weather Editor
description: Create, edit and delete the weathers a world can show: wind, sky darkness, temperature and precipitation.
order: 50
---

The weather editor manages the rows of the `weather` table. A world shows one weather at a time, and a saved change reaches every player in a world showing it at once. This page covers the window, each field, how a weather's name decides what is drawn, and what happens on save and delete.

How worlds pick their weather, the `/weather` command and real weather from an API are covered in [Weather](#/engine/weather).

## Opening it

```text title="Chat command"
/we
/weathereditor
```

The editor opens in its own window at route `/weather-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.weather_editor` or `tools.*`
- `server.admin` or `server.*`

Guests are always refused. Permission is checked again on every packet the editor sends.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). A weather fits on one page, so there are no tabs.

| Area | Contents |
| --- | --- |
| Side pane | Search field, the list of all weathers, and New |
| Top bar | The open weather, its state, then Duplicate, Delete and Save |
| Banner | Which worlds are showing this weather right now |
| Page | Four cards of fields and three cards of sounds, with the "In plain words" card beside them |

There are few weathers, so the whole list is held in the window. The search field only filters it as you type.

When the open weather is live somewhere, the banner reads "Showing now on" followed by the world names, and warns that a save changes it there at once, for every player.

## Fields

### Weather

| Field | Notes |
| --- | --- |
| Name | Lower case letters, digits, underscores and hyphens, starting with a letter or digit. Up to 45 characters. Fixed once saved. |

:::warning The name decides what the game draws
The client chooses its visuals by the weather's name, not by its numbers. Only the names below draw rain, snow, sand, lightning or darkness. A weather with any other name only carries its wind.
:::

| Name | What the game draws |
| --- | --- |
| `rainy` | Rain as heavy as Precipitation says, with splashes where it lands. Below 32 degrees it falls as snow. |
| `thunderstorm` | Rain (snow below 32 degrees) and lightning strikes. Shadows are off and the scene is darkened as much as Ambience says. |
| `snowy` | Snow as heavy as Precipitation says, which melts where it lands |
| `darkness` | A near black scene, darkened as much as Ambience says, with no sun and no shadows. Lights and glowing particles carry it. |
| `tornado` | A `thunderstorm` with one or two tornadoes on the map, which pull players in and hurt them. It also blows a sandstorm in desert zones and a blizzard in snow zones. Any thunderstorm also has a rare chance of a tornado. |
| `sandstorm` | Only where the player stands in a desert zone, clear elsewhere: an orange tint, rolling dust and blowing sand, harsher the higher Wind speed is |
| `blizzard` | Only where the player stands in a snow zone, clear elsewhere: a cold whiteout, rolling snow and driven flakes, harsher the higher Wind speed is. Flakes fall as much as Precipitation says. |

These words can never be used as a name, because `/weather` gives them a meaning of their own: `random`, `none` and `weather_api`.

### Wind

Wind draws wind streaks, slants rain and snow, and pushes particles that are set to be affected by weather.

| Field | Range | Notes |
| --- | --- | --- |
| Wind speed | 0 to 100 | 0 is still air. Gusts add up to half as much again. |
| Wind direction | None, Left, Right, Up, Down | Wind streaks need a direction and a speed above 0, and follow all four directions. Rain, snow and particles are only pushed left or right. |

### Sky

| Field | Range | Notes |
| --- | --- | --- |
| Ambience | 0 to 1 | How much `thunderstorm`, `tornado` and `darkness` darken the scene: 0 not at all, 1 fully black. No other name uses it. |

### Climate

| Field | Range | Notes |
| --- | --- | --- |
| Temperature | -100 to 200 | Degrees Fahrenheit. Below 32, rain falls as snow. |
| Humidity | 0 to 100 % | Only stored. Nothing in the game reads it. |
| Precipitation | 0 to 100 % | How much rain or snow falls. It does not make rain fall on its own: the name does. |

### Sounds

There is a card for each kind of sound: **Rain sounds**, **Wind sounds** and **Thunder sounds**. Each holds up to 12 sounds, added with its Add button. A kind with no sounds is silent.

| Field | Range | Notes |
| --- | --- | --- |
| Audio | Up to 100 characters | A file from the asset server's audio folder. The play button listens to it. |
| From, To | Rain and thunder: 0 to 100 % of Precipitation. Wind: 0 to 150 mph of wind speed with its gusts. | Where the sound is heard. To must not be under From. |
| Volume | 0 to 1 | 1 as loud as the game makes it, 0 silent |

- Rain and wind sounds are loops. Where two ranges overlap, the lower fades into the higher.
- Sounds with the same range are variants: one of them is picked each time the weather is shown.
- A thunder sound is heard just after each lightning strike: one of the sounds whose range holds Precipitation, at random.

The **In plain words** card beside the form describes what the open weather does in the game, including what its name draws.

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `WEATHER_EDITOR_LIST` | Sends every weather, the worlds and what each is showing, and the rules |
| Save | `WEATHER_EDITOR_SAVE` | Validates and writes the `weather` row |
| Delete | `WEATHER_EDITOR_DELETE` | Removes the row and moves affected worlds to `clear` |

The list comes back as `WEATHER_EDITOR_DATA`. Each answer to a save or delete comes back as `WEATHER_EDITOR_RESULT` with the fresh list. Other admins with the editor open are told with `WEATHER_EDITOR_UPDATED`.

A saved weather is shown at once to the players of every world that shows it, including a world set to `random` that has settled on it.

## Deleting

- `clear` cannot be deleted. It is what a world with no weather shows, and what a world falls back to.
- Deleting any other weather sets every world that uses it to `clear`.
- A world on `random` that had settled on the deleted weather shows `clear` until it next changes.

Delete always asks for confirmation first.

## Tips

- To make a variant of a storm, open `thunderstorm`, Duplicate it and change the numbers. Remember that the copy needs one of the drawn names to show rain or lightning, and names must be unique, so a variant with a new name only keeps the wind.
- For a calm overcast or windy day, create a weather with any new name and set only Wind speed and Wind direction.
- Use Ambience in small steps. Values near 1 make the scene almost unreadable without light sources.
- Test on a development world with `/weather <name>` before giving a new weather to a busy world.
