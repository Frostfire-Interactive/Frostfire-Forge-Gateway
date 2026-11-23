---
title: Map Editor
description: Paint tiles, edit collision and zone layers, place graveyards and warps, and save maps live from inside the game.
order: 30
---

The map editor paints the map your character is standing on. It has two halves: a tool window with the layers, the tools and the tile palette, and the game window itself, where you paint. This page covers both, the keyboard shortcuts, the permissions involved and what a save does.

## Opening it

Stand on the map you want to edit and type one of these in the game chat:

```text title="Chat command"
/te
/tileeditor
```

The tool window opens against the right edge of the screen, at route `/map-editor`. If the browser blocks it, the game shows "Popup blocked! Please allow popups for this site."

Typing the command again, or closing the tool window, closes the editor.

:::danger Closing the editor discards unsaved edits
When the editor closes, the map in your game window is put back to its last saved state. Save before you close.
:::

:::note The editor does not work inside a dungeon copy
Standing in a dungeon copy, editing the map, saving it and opening the map editor are refused with the notice "Leave the dungeon to edit its map". A copy is a clone, and a save from it would land on the dungeon's own map. Leave the dungeon first.
:::

## Permissions

The map editor is checked in three places, each with its own rule.

| Step | Needs | What happens without it |
| --- | --- | --- |
| Run `/te` | `tools.tile_editor` or `tools.*` | "You don't have permission to use this command" |
| Sync with the server when the editor opens, share live edits and layer locks | The admin role | The editor still opens, but the server does not send you the unsaved edits of others and does not relay your edits or layer locks. |
| Save the map | `server.admin` or `server.*` | "You do not have permission to save map changes." |

:::warning A map builder needs all three
An account with `tools.tile_editor` but no admin role can open the editor, but it does not share edits or layer locks with the other editors on the map. One without `server.admin` can paint but not save. Give map builders the admin role, `tools.tile_editor` (or `tools.*`) and `server.admin`. See [Permissions](#/engine/permissions).
:::

## The tool window

### Top bar

| Part | Meaning |
| --- | --- |
| Title | The name of the map, with the number of layers and tilesets under it |
| Status | The selected layer, the tool in use, and "No unsaved edits" or how many layers have unsaved edits |
| New map | Makes a new, blank map or world and moves you onto it |
| Undo, Redo | Step back and forward through your own edits |
| Save | Sends the map to the server |

### Layers

The side pane lists the map's tile layers and, under "Objects", its four object layers.

- Click a layer to select it. The tools work on the selected layer only.
- The eye button hides or shows a layer in your own game window. It does not change the map.
- The lock button locks a layer so nobody paints on it. Locks are shared with the other editors on the map.
- Up and Down move through the rows.

Three kinds of layer are recognised by name and marked with their own icon:

| Layer name contains | Shown as | Purpose |
| --- | --- | --- |
| `collision` | Collision layer | Tiles here block movement |
| `nopvp` or `no-pvp` | No-PvP zone layer | Tiles here mark where players cannot attack each other |
| `shadow` | Shadow layer | Shadows drawn over the map |

Every other layer is a plain tile layer.

The object layers are **Graveyards**, **Warps** and **Chests**. Portals and summoning stones are drawn on the map but are made in the [Dungeon Tool](#/tools/dungeon-tool); the map editor keeps them as they are and moves them with the map when it grows left or up. Selecting a layer switches the game window from painting tiles to placing and editing those objects, and turns the tile tools off. Zones are drawn in the zone map window, described under Zones below.

### Toolbar

| Tool | Key | What it does |
| --- | --- | --- |
| Paint | `P` | Paints the picked tiles onto the selected layer |
| Erase | `E` | Erases tiles from the selected layer |
| Copy | `C` | Picks tiles up from the map, in the game window |
| Paste | `V` | Puts the picked tiles down as they were copied |
| Rotate | `Z` | Turns the picked tiles a quarter turn |
| Grid | none | Shows or hides the grid in the game window |
| Clear edits | none | Takes back every edit of yours that is not saved |
| Zoom | Ctrl + wheel | Size of the tiles in the palette, from 1x to 4x |

Paint, Erase and Paste are off while the selected layer is locked. All four tile tools are off while an object layer is selected.

### Tile palette

The palette shows the map's tilesets as tabs and the tileset in view as a picture.

- Click a tile to pick it. Drag across several to pick a block.
- The footer shows what is picked and the column and row under the pointer.
- A yellow corner marks a tile that is animated.
- Left and Right move through the tileset tabs.

Tilesets are part of the map file. A map with none shows "This map has no tilesets": add them to the map on the asset server. See [Asset Paths](#/assets/asset-paths).

### Footprints tab

The **Footprints** tab gives tiles the footprints players leave when they walk on them, like sand, snow or mud. The setting belongs to the tile of the tileset, so it holds on every map that draws that tile.

- Pick tiles as in the other tabs: click, drag, Shift or Ctrl to add, Alt to take away, Ctrl + A for the whole tileset, Esc for none.
- Set the prints on the bar:
  - **Style**: Boots, Bare feet (no toes), or Deep holes (pushed into deep snow, mud or sand, darkest along their upper edge). Prints are pixel art, a few pixels each, and face the nearest of eight ways (the diagonals have their own drawings).
  - **Colour** of the prints.
  - **Darkness**: how strong they are when laid, 5 to 100 %.
  - **Fade**: how long they stay, 1 to 600 seconds. They stay as laid for most of that time, then fade away.
- **Preview** shows someone walking across the first picked tile, leaving the bar's prints as the game draws them. A fade longer than 3 seconds is shown sped up.
- **Apply to N tiles** (or Enter) gives the picked tiles those prints. **No footprints** takes them away. **Take from picked** sets the bar to what the picked tiles have now, and **Pick all with these** picks every tile of the tileset that has the bar's prints.
- Tiles with footprints are tinted in their colour with a print in the corner, and the footer lists the tileset's settings.

A player leaves a print on each footstep, in time with the footstep sound (every 44 px), left foot and right foot in turn, turned the way they walk. Ghosts and riders leave none. Saving needs `server.admin` or `server.*`, and a save reaches every player online at once. The settings are rows of `tile_footprints`.

### Fishing tab

The **Fishing** tab chooses what can be caught from tiles. A tile that gives catches is water: players can cast a line into it. The setting belongs to the tile of the tileset, so it holds on every map that draws that tile.

- Click a tile to pick it. Drag across several to pick a block. Shift or Ctrl adds tiles, Alt takes them away, Ctrl + A picks the whole tileset and Esc picks none.
- **Choose catches** opens the Catches list, in two parts:
  - **Catches**: the material items a fish can turn out to be, each with a chance in percent. Only items of type `material` can be picked: make them in the [Item Editor](#/tools/item-editor) first.
  - **Fishing items**: the weapons that fish the picked tiles. A player must have one of them equipped to cast a line there. Only equipable items in the weapon slot can be picked. At least one is needed.
- **Apply to N tiles** (or Enter) gives the picked tiles those catches and fishing items. **Not fishable** takes them away.
- **Take from picked** starts the list from what the picked tiles have now. **Pick all with them** picks every tile of the tileset with the same catches and fishing items.
- Fishable tiles are tinted in the colour of their catches and fishing items together, with a wave in the corner. The footer names the tileset's combinations and how many tiles have each.

A tile gives several catches, each with a chance from 0.01 to 100 %, and names the fishing items. The chances do not need to add up to 100 %: each counts as its share of their sum, which the Catches list shows after the `=`.

:::note Tiles made before fishing items
Tiles given catches before fishing items existed name none, so nobody can fish them. The footer shows them as "no item fishes them". Pick them, choose their fishing items and apply again.
:::

Saving needs `server.admin` or `server.*`. A save is sent to every player online at once. The catches and fishing items are rows of `fishing_tiles` (columns `catches` and `tools`).

## Fishing

Players click or tap a fishable tile within 256 px to cast, with one of the tile's fishing items equipped. Without one they are told which to equip. They face the water and hold that item, drawn with its own sprite sheet, while the bobber floats. A fish bites after 3 to 10 seconds and the bobber goes under. Holding the mouse button or a finger down reels the fish in; it pulls back now and then, but never off the water. When the bobber reaches the shore near the player, the fish is pulled out and goes into the bags, and a notice names it in its quality's colour, as loot does. A fish not reeled within 5 seconds of its bite gets away: the bobber comes up again, the line stays out, and another fish may bite. One not landed within a minute of the reel starting gets away too.

Holding the button down with no fish on the line reels the bobber in across the water; when it reaches the shore it comes up out of the water to the staff and the line is in. While a line is out, a click only reels: to cast somewhere else, reel the line in first.

Players may walk up to 64 px from where they cast while fishing, still turned to the water. The line leaves the tip of the staff.

The catch is picked when the line is cast, from the tile the bobber lands on. A cast is refused in combat, while stunned or casting, without one of the tile's fishing items equipped, on a tile that names no fishing item, and when the bags have no room for the catch. Walking further than 64 px from where the line was cast, unequipping the item it was cast with, any damage, a stun, dying or leaving the map takes the line in.

## Painting in the game window

With a tile layer selected:

| Action | Result |
| --- | --- |
| Left click or drag | Uses the current tool: paint, erase, paste, or copy the tile under the pointer |
| Shift + left click | With Paint or Paste, draws a straight line from the last tile you placed |
| Right drag | Picks up a block of tiles from the map |
| Middle drag | Pans the editor camera |

## Graveyards and warps

Select **Graveyards** or **Warps** in the Objects list, then work in the game window. Chests work the same way, and are described under Chests below.

| Action | Result |
| --- | --- |
| Right click on empty ground | "Create" places a new object, named `Graveyard_1`, `Warp_1` and so on |
| Left click an object | Selects it. Drag to move it. |
| Drag a corner of a warp | Resizes the warp area |
| Click an object's label | Renames it in place. Enter confirms, Escape cancels. |
| Right click an object | "Properties" or "Delete" |
| `Delete` key | Deletes the selected object |

The Properties panel lists an object's custom properties. "Add Property" asks for a property name and a value type: `string`, `bool`, `int`, `float`, `color`, `file` or `object`. The names `layer`, `position`, `size` and `name` are reserved.

A warp needs three properties before the map can be saved:

| Property | Meaning |
| --- | --- |
| `map` | The map the warp leads to |
| `x` | Destination X |
| `y` | Destination Y |

:::warning A warp without a destination blocks the save
If any warp is missing `map`, `x` or `y`, the save is refused with "Cannot save: Invalid warps" and the names of the warps to fix. A new warp starts with an empty `map`, so fill it in right after creating it.
:::

Graveyards are where players return after dying. See [Combat and Spells](#/player-guide/combat-and-spells).

## Chests

Select **Chests** in the Objects list. Chests are placed, moved, renamed and deleted like graveyards and warps: right click on empty ground and choose "Create", drag to move, click the label to rename. A chest is a single point.

They are named `Chest_1`, `Chest_2` and so on. Every chest needs a name, and the names must be different. A map can have at most 200.

Their properties are pickers, filled from the server with a `MAP_OBJECT_OPTIONS` request:

| Object | Property | Meaning |
| --- | --- | --- |
| Chest | Loot table | The [Loot Editor](#/tools/loot-editor) table the chest holds. Required. |
| Chest | Reset (minutes, 1 to 1440) | How often the chest refills. Default 30. |

A chest on an ordinary map refills on its reset timer. A chest on a dungeon's map does not refill inside a copy: each new copy has it full.

:::warning A chest without a choice blocks the save
The save is refused if a chest has no loot table or a reset outside 1 to 1440. A new chest starts with nothing chosen, so pick one right after creating it.
:::

Chests can be made in Tiled as `chest` objects (properties `loot_table` and `reset_minutes`). Portals can be read from Tiled `dungeon_portal` objects (properties `kind`, `dungeon`, `mirror`, and for a teleport `map`, `x`, `y`).



## Zones

A zone is a named area drawn as an outline on the map. When a player walks into it, its text shows at the top of the screen and its music fades in. How the game uses zones is described in [Zones](#/engine/zones).

Zones are drawn and edited in the zone map, a window of its own. **Zones**, at the end of the row of views at the top of the map editor (Tiles, Sounds, Fishing, Footprints), opens it. A dot on **Zones** marks zone edits that are not saved yet.

### Zone map

The zone map shows the whole map, so zones of any size can be drawn. It shows the asset server's baked picture of the map (the one the world map shows), with the full-detail pictures once zoomed in close. Your character is the blue dot. Every point snaps to the nearest tile corner.

| Action | Result |
| --- | --- |
| Mouse wheel | Zooms around the cursor, from the whole map down to single tiles |
| Drag an empty part of the map, or drag with the middle button | Pans |
| `S` | Select tool |
| `D` | Draw tool |
| `F`, or **Whole map** | Shows the whole map |
| **Find me** | Centres the map on your character |
| `+` and `-` | Zoom in and out |

With the **Select** tool:

| Action | Result |
| --- | --- |
| Click a zone, or its name in the list | Selects it. Clicking a name in the list also frames the zone. |
| Drag a zone | Moves it |
| Drag a point of the selected zone | Moves that point |
| Click an edge of the selected zone | Adds a point there |
| Right click a point, or select it and press `Delete` | Deletes the point |
| `Delete` or `Backspace` | Deletes the selected zone, after asking |
| `Escape` | Clears the selection |

With the **Draw** tool, each click places a point on a tile corner. Clicking the first point, double clicking or pressing `Enter` closes the zone (3 points or more). `Backspace` takes back the last point and `Escape` stops drawing. The new zone is called "New zone", is selected, and its name is ready to type over.

A zone can be drawn inside another one: a town inside a forest. The player is in the smallest zone they stand in.

Two zones never lie partly over each other. A zone drawn, moved or reshaped partly over another zone snaps to that zone's edge. When most of it is outside the other zone, the part over that zone is cut away. When most of it is inside, the part outside is cut away, so it becomes a zone inside that one. How the cut is made is described in [Zones](#/engine/zones).

A zone's border never crosses itself. While drawing, the dashed line to the next point turns red where that point would make the border cross. A point placed there, a close that would cross, or a dragged point that would cross is not made, and the message "A zone's border cannot cross itself" shows. A zone saved with a border that crosses itself is drawn with a red border, and its panel says so: drag its points until the red border no longer crosses.

The panel on the right holds the selected zone's fields:

| Field | Meaning |
| --- | --- |
| Name | The zone's name, unique on the map in any case |
| Text | What is shown on entering the zone. When empty, the zone's name is shown. |
| Music | A track from the asset server's audio files, picked from a searchable list. "No music" clears it. A zone without music keeps the music of the zone around it. |
| Kind | `none`, `desert` (sandstorms are drawn here) or `snow` (blizzards are drawn here) |

The zone map does not hold zones of its own. The game window holds them, and each edit made in the zone map is sent there: it is one undo step of the map editor and marks the zones unsaved. Undo, Redo and Save in the zone map (and `Ctrl+Z`, `Ctrl+Y`, `Ctrl+S`) do the same as the map editor's. When the map grows to the left or up, the zones move with the tiles when the map is saved. The zone map closes when the map editor closes, and shows the new map when the game changes maps.

## Keyboard shortcuts

These work in both the tool window and the game window.

| Key | Action |
| --- | --- |
| `P` | Paint |
| `E` | Erase |
| `C` | Copy |
| `V` | Paste |
| `Z` | Rotate the picked tiles |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Save the map |
| `Delete` | Delete the selected graveyard, warp or chest (game window) |
| `Shift` + click | Line from the last placed tile (game window) |
| `Ctrl` + wheel | Zoom the palette (tool window) |

## Working with other editors

Several admins can edit the same map at once.

- Each edit is sent to the server as an `EDITOR_TILE_EDIT` packet and relayed to the other admins on that map who have the editor open.
- Layer locks travel the same way (`EDITOR_LAYER_LOCK`).
- When you open the editor on a map others are already editing, the server replays their unsaved edits to you first. The game shows "Syncing map state..." while that happens.
- The server forgets the unsaved edit history of a map when its last editor closes.

## Saving

Save sends a `SAVE_MAP` packet with the changed chunks, the map bounds, all graveyards and warps, the zones and chests when they changed, and the portals only when the map grew left or up. The game server then:

1. Checks `server.admin` or `server.*`.
2. Sends the changed chunks to the asset server (`/save-map-chunks`) and the graveyards, warps and zones (`/save-map-properties`).
3. Reloads the map so collision and zones match the new tiles.
4. Answers "Map saved successfully!" with the number of chunks updated.
5. Tells the other players on the map to reload the changed chunks, and sends every player on the map the new zones (`MAP_ZONES`).

The edits stay marked unsaved until the server answers that the save worked (`MAP_SAVE_RESULT`). A save that is refused or fails keeps them marked, and the next save sends them again.

The map stays on screen while it is saved, for every player on it: there is no loading screen, and the editor stays open. The asset server tells every game server of each save as soon as it has written it, often before the save has finished. The game server leaves that to the save in progress, which reloads the map itself (step 3). In [cluster mode](#/engine/cluster) the saving node first tells the other nodes that a save of the map is under way, and they leave the asset server's word to the save too. Each node then takes in the save from the saving node's news and sends its players the changed chunks. A save that fails after the asset server has written it ends with the map taken in like any other change on the asset server.

A zone with fewer than 3 points refuses the save with "Cannot save: Invalid zones" and the names of the zones to fix. A zone the server refuses (a point outside the map, a name used twice) gives "Cannot save zones:" and the reason.

Large world maps (see [World Maps](#/engine/world-maps)) are saved the same way, except that the asset server writes the chunks into the world's packs and the game server fetches the new collision and no-PvP data afterwards. A world's size is fixed. For larger edits, a world can also be edited in Tiled with [Frostfire Worlds for Tiled](#/tools/tiled-worlds).

If the tool window reports "The game window did not save the map", the game window shows the reason: an invalid warp or a save sent too soon after the last one.

How the asset server stores maps is described in [Asset Server Integration](#/assets/integration).

## Tips

- Select the layer before you paint. With nothing selected the tools do nothing and the top bar shows "No layer selected".
- Lock finished layers such as the ground so a stray click cannot change them.
- Hide upper layers while you work on the ones below. Hiding only affects your view.
- Use right drag to copy a finished building or tree and Paste to stamp it elsewhere.
- Paint the collision layer last, with the other layers visible, so blocked tiles line up with the art.
- Save often. Closing the editor, reloading the game or losing the connection discards unsaved edits.
