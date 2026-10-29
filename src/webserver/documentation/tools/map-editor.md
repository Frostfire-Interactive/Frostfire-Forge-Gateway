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

The side pane lists the map's tile layers and, under "Objects", its two object layers.

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

The object layers are **Graveyards** and **Warps**. Selecting one switches the game window from painting tiles to placing and editing those objects, and turns the tile tools off.

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

Select **Graveyards** or **Warps** in the Objects list, then work in the game window.

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
| `Delete` | Delete the selected graveyard or warp (game window) |
| `Shift` + click | Line from the last placed tile (game window) |
| `Ctrl` + wheel | Zoom the palette (tool window) |

## Working with other editors

Several admins can edit the same map at once.

- Each edit is sent to the server as an `EDITOR_TILE_EDIT` packet and relayed to the other admins on that map who have the editor open.
- Layer locks travel the same way (`EDITOR_LAYER_LOCK`).
- When you open the editor on a map others are already editing, the server replays their unsaved edits to you first. The game shows "Syncing map state..." while that happens.
- The server forgets the unsaved edit history of a map when its last editor closes.

## Saving

Save sends a `SAVE_MAP` packet with the changed chunks, the map bounds, and all graveyards and warps. The game server then:

1. Checks `server.admin` or `server.*`.
2. Sends the changed chunks to the asset server (`/save-map-chunks`) and the graveyards and warps (`/save-map-properties`).
3. Reloads the map so collision and zones match the new tiles.
4. Answers "Map saved successfully!" with the number of chunks updated.
5. Tells the other players on the map to reload the changed chunks.

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
