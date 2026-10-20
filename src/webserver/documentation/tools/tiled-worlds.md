---
title: Frostfire Worlds for Tiled
description: Edit large .world maps in the Tiled map editor one region at a time, and save the changes straight back into the world while the servers run.
order: 35
---

A world (a `.world` directory, see [World maps](#/assets/world-maps)) is too large to open whole in Tiled: the 10240 x 10240 continent has over 100 million tiles per layer. **Frostfire Worlds for Tiled** is a [Tiled](https://www.mapeditor.org/) extension that shows the whole world as a map, opens any part of it as an ordinary Tiled map, and writes your edits back into the world's files.

The source code and releases are on GitHub: [Frostfire-Interactive/tiled-frostfire-worlds](https://github.com/Frostfire-Interactive/tiled-frostfire-worlds).

It works outside the game. It needs no login and no chat command: it reads and writes the world's files directly, in the asset server's maps folder or in a copy of it.

## Installing

You need Tiled 1.12 or newer.

1. Download `frostfire-worlds.zip` from the [latest release](https://github.com/Frostfire-Interactive/tiled-frostfire-worlds/releases/latest), or build it from source with `bun install` and `bun run build`.
2. Put the `frostfire-worlds` folder into Tiled's extensions folder.

| Platform | Extensions folder |
| --- | --- |
| Windows | `%USERPROFILE%/AppData/Local/Tiled/extensions/` |
| macOS | `~/Library/Preferences/Tiled/extensions/` |
| Linux | `~/.config/tiled/extensions/` |

You can also open the folder from Tiled: **Edit > Preferences > Plugins > Open**. Tiled loads the extension by itself; there is no need to restart it. Updating works the same way: replace the folder's contents.

## Opening a world

1. Choose **File > Open World Map...** (Ctrl+Alt+O).
2. Choose the world's folder, the one whose name ends in `.world`. The folder picker starts at the world you opened last.
3. If the world's tileset images are not found next to it, Tiled asks once for the folder that holds them and remembers it.

The world opens in a tab such as `overworld - world map (512)`. It shows the whole world drawn in the colours of its own tiles (ground, water, snow, roads and towns), the grid of regions on top, and a red dot at the spawn point. You can zoom and scroll it like any map.

The first time a world is opened, its picture is drawn from the world's packs. This takes a few seconds (about 10 for a 10240 x 10240 world). The picture is cached per pack file, so later opens take a fraction of a second, and after a save only the changed parts are drawn again.

## Picking a region

When the world map opens, the **Pick World Region** tool is selected (its icon is a green grid with a yellow square).

| To | Do |
| --- | --- |
| Select a region | Click it, or move the yellow highlight with the arrow keys |
| Open the selected region | Double-click it, press Enter, or click **Open Selected Region** in the tool bar |
| Change the region size | Click **Small**, **Medium** or **Large Regions** in the tool bar: 256, 512 or 1024 tiles a side |

The status bar shows the selected region's column, row and tiles. If the arrow keys scroll the view instead of moving the highlight, use Alt+Shift with the arrow keys.

The region opens in its own tab, for example `overworld - 512 - column 11, row 12`. It is an ordinary finite Tiled map with the world's layers and tilesets. The world map stays open in its tab, so you can go back and pick another region.

To move to the next region, use **Map > Go to Region North / South / West / East**, or Alt+Shift with an arrow key. If the region you leave has unsaved changes, Tiled asks whether to save them first.

## Editing and saving

Edit tiles and objects as in any Tiled map, then save with **File > Save** (Ctrl+S). Tiled's Console (**View > Views and Toolbars > Console**) reports what was written:

```text title="Tiled console"
[Frostfire World] Saved 3 chunk(s) in 1 pack(s); objects: 1 added, 0 changed, 0 removed (412ms).
```

| You can | You cannot |
| --- | --- |
| Paint and erase tiles on every tile layer, `Collisions` and `nopvpzone` included | Resize the region or make the map infinite |
| Add, move, edit and delete objects: warps, graveyards, particles | Add, remove or rename layers |
| Use tiles from every tileset of the world, in any order | Add a tileset the world does not have |

Changes to a layer's visibility, lock state or properties are not saved into the world.

A save does what the asset server does for an [editor save](#/assets/world-maps/saving-edits):

1. Every chunk the region overlaps is decoded and the region's tiles are copied in. Only chunks whose tiles changed are written, each with its `chunkRev` raised by one.
2. Each pack file that holds a changed chunk is written again. Its other chunk records are copied as they are.
3. The collision and no-PvP bitset blocks of the changed chunks are rebuilt from the layers with role `collision` and `nopvp`.
4. The objects inside the region are replaced by the map's objects. Objects outside the region are kept, and object ids are kept.
5. The packs are written first, then the bitsets, then `manifest.json` with `worldRev` raised by one. If Tiled stops in between, the asset server mends the world at its next start.

A save with no changes writes nothing.

## Saving while the servers run

You can save into the maps folder of a running asset server.

| Server | What happens after a save from Tiled |
| --- | --- |
| Asset server | Notices that the world's files changed on disk the next time the world is used, and reads them again (`World <id>.json changed on disk: read again`). It bakes the world's map image again, drawing only the changed packs. See [Changes made outside the server](#/assets/world-maps/changes-made-outside-the-server). |
| Game server | Checks the asset server every 10 seconds and takes in the new collision and no-PvP data, warps, graveyards and map version without a restart. See [Changes made outside the game](#/engine/world-maps/changes-made-outside-the-game). |
| Players | See the new tiles after they reload the page. |

Particle NPCs and a change of the world's size are not taken in while the servers run: restart the game server for those.

:::warning Older servers
Asset servers and game servers from before 2026-10-20 do not notice changes on disk. An older asset server keeps serving the old pack layout (`Error serving map chunk: incorrect header check`), and its next in-game save of warps or graveyards overwrites what Tiled saved. With older servers, stop the asset server while you save.
:::

## Safety checks

| Situation | What happens |
| --- | --- |
| The world was generated again since the region was opened | The save is refused. Open the region again. |
| Someone else saved changes to tiles or objects inside the same region after you opened it (another tab, another person, the in-game map editor) | Tiled asks before overwriting them. Saves elsewhere in the world never ask. |
| A layer or tileset that is not part of the world | The save is refused with the layer's or tileset's name. |

## Files the extension keeps

You never need to name or find these files. Each region and each world map is a small JSON file, kept with the world map pictures and a `settings.json` (the last world and region) in the `frostfire-worlds` folder next to Tiled's extensions folder.

```json title="overworld - 512 - column 11, row 12.region"
{
  "format": "region",
  "version": 1,
  "world": "D:/frostfire/assets/maps/overworld.world",
  "x": 5120,
  "y": 5632,
  "width": 512,
  "height": 512,
  "generationId": "3aee7f92f4a3409f"
}
```

An open region also carries its world in the map properties `world.folder`, `world.region`, `world.generationId` and `world.tilesetFolder`. Do not edit them: a save uses them to find where the region's tiles go.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| The world map shows only light and dark ground | The tileset images were not found. Open the world map again and choose the folder that holds them. |
| A region shows empty tiles | Same cause: the tileset images were not found. |
| `"<folder>" is not a world` | Choose the folder whose name ends in `.world`. It holds `manifest.json`, `collision.bits` and a `packs` folder. |
| The asset server logs `a save had been cut short` | A save from Tiled met an asset server from before 2026-10-20. The server kept the new tiles and rebuilt collision from them; object edits from that save may be lost. Update the asset server. |
| Players do not see the changes | They need to reload the page. The game server takes in the change within 10 seconds. |
