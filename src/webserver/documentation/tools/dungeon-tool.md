---
title: Dungeon Tool
description: Make the dungeons and raids of a realm, the portals that lead into them and around the world, and the summoning stones that pull a party member in.
order: 115
---

The Dungeon Tool is one window with three tabs:

- **Dungeons** makes the dungeons and raids of a realm: which map each is played on, who may enter, how strong its creatures are, which portal leads into it and where players appear.
- **Portals** makes the portals of the map you are standing on: dungeon portals, and teleports to a place on a live map.
- **Summoning stones** places the summoning stones of the map you are standing on. Two party members at a stone can summon a third. See [Summoning stones](#/player-guide/parties/summoning-stones) for what players do with them.

See [Dungeons](#/player-guide/dungeons) for what players see of dungeons and portals.

## Opening it

```text title="Chat command"
/de
/dungeoneditor
/poe
/portaleditor
```

All four commands open the same window, at route `/dungeon-editor`, on the **Dungeons** tab. Typing any of them again closes it. The staff bar has one button for it, **Dungeon Tool**. The window asks for every tab's list when it opens, so each tab shows how many records it has from the start.

## Permission

| Needs | What happens without it |
| --- | --- |
| Admin role, `tools.dungeon_editor`, `tools.*`, `server.admin` or `server.*` | The command says "You don't have permission to use this command". A packet from the window is answered with "You don't have permission to use the dungeon tool." |

`tools.dungeon_editor` opens the whole tool, every tab. `tools.portal_editor` is no longer checked; the database setup scripts still seed it. The permission is read from the database on every packet, so granting or removing it takes effect at once. A guest is always refused.

## The window

The tool uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The tabs are listed at the top of the side pane, each with its count. The side pane lists the records of the tab in view, and **In plain words** beside the form sums up what the open one is in the game.

Switching tabs with unsaved changes asks whether to save them, discard them or stay. **Save** switches once the server has confirmed the save; a save it refuses keeps you on the tab with the problems shown. Ctrl+S saves the open record of the tab in view.

## Dungeons

A dungeon is a map that each group plays in a private copy of its own. Portals are made on the **Portals** tab.

### Dungeon fields

| Field | What it does |
| --- | --- |
| Name | Shown to players. Up to 48 characters, unique without regard to case. |
| Map | The map the dungeon is played on, picked from the maps the server knows. A map has one dungeon at most. Each group plays its own copy of it. |
| Type | **Dungeon** is for a party of up to 5 players. **Raid** is for a raid group of 10 or 20 players. |
| Enabled | When off, portals into the dungeon say "This dungeon is closed." Copies that are already open keep running, and players who are inside one can go back into it. |
| Portal colour | The colour its portals glow in: the swirl, the light on the arch and the step, the runes, the sparks and the light on the ground. Pick it from the swatch or type a code such as `#ff8a3d`. Until one is picked a dungeon's portals are blue (`#6eaaff`) and a raid's green (`#6eff8c`); **Use blue** or **Use green** puts that back. |
| Raid sizes | Raids only: **10 players**, **20 players**, or both. Pick at least one. A dungeon is always size 5 and shows it as a fixed value. |
| Health × at 5, 10 or 20 | What creature health is multiplied by at that size. 0.1 to 100. Shown for each size that is on. |
| Damage × at 5, 10 or 20 | What creature damage is multiplied by at that size. 0.1 to 100. |
| Entrance portal | The dungeon portal players go in through, picked from the dungeon portals on every map that lead into no other dungeon. **None** leads from no portal. Picking one unlinks the dungeon's other portals. Teleports cannot be picked. |
| Entrance X and Entrance Y | Where players appear when they enter, in whole pixels inside the map (0 to its width or height minus 1). The exit portal stands just above it, so with an entrance portal picked Entrance Y must leave 16 pixels plus that portal's height above it. |

The server checks every field again when you save: the name is there, not too long and not taken, the map exists and has no other dungeon, the type is known, the sizes fit the type, each multiplier is in range, the entrance is whole pixels inside the map, Enabled is on or off, the portal colour is empty or a code like `#ff8a3d`, and the entrance portal is a dungeon portal that leads into no other dungeon. The portal link is written only when the pick changed, and the exit portal only when it changes.

### Defaults

A size turned on for the first time starts with these multipliers. Any size can be changed afterwards.

| Size | Health × | Damage × |
| --- | --- | --- |
| 5 players | 1 | 1 |
| 10 players | 2 | 1.5 |
| 20 players | 4 | 2 |

The multipliers apply to the creatures of the copy when it opens, for the size it was opened at. A raid with both sizes asks the player who opens it which one to use.

### Setting up the portal and the exit

A dungeon needs an entrance on another map and a map of its own.

1. **Make the dungeon's map** in the [Map Editor](#/tools/map-editor), or pick an existing one. Place its creatures on it with the [Creature Editor](#/tools/creature-editor). Place chests on it with the **Chests** object, described on the Map Editor page.
2. **Create the dungeon** on the Dungeons tab: pick the map, the type, the sizes and the entrance.
3. **Make the entrance portal** on the map players enter from: stand there, open the **Portals** tab and save a portal with destination **None**. Then pick it as **Entrance portal** on the Dungeons tab and save.
4. **The exit is made for you.** Stepping into a dungeon portal while inside a copy sends the player out, so the dungeon's map gets one: a dungeon portal linked to no dungeon, named after the entrance portal with ` (return)` (for example `Gate (return)`). It has the entrance portal's size and Mirror other side, and stands centred above the entrance with its bottom edge 16 pixels above it, so players arriving in a copy stand just in front of it. Every copy opened after that has it.

The exit follows the dungeon and its entrance portal: picking another entrance portal, moving the entrance or the map, or changing the portal on the Portals tab (moving, resizing, renaming, Mirror) updates it. Deleting the dungeon, picking **None**, or deleting or unlinking the portal deletes it. A dungeon has one exit made for it even when several portals lead into it: the portal that has it keeps it, else the first by map name. An exit you made yourself on the dungeon's map (a dungeon portal with destination **None**) is left as it is. The exit is never offered as an entrance portal and cannot be edited on the Portals tab. A portal linked before exits were made gets its exit the next time it or its dungeon is saved.

A portal fires when a player walks into its rectangle from the front, up across its bottom edge; its arch is solid, so it cannot be entered from behind or from a side. A player entering through a portal is sent back to the centre of that portal when they leave. The creatures of a copy are the ones placed on the map. A copy is cleared when every boss-rank creature in it is dead, so give the dungeon at least one. Its chests appear when it is cleared. A copy with no boss is never cleared and closes when it has been empty for 5 minutes.

:::note Maps with a dungeon are edited outside the copy
The map editor refuses to edit a copy. Anyone who types `/te` and tries to paint inside a dungeon sees "Leave the dungeon to edit its map". Leave the dungeon first, then edit the map.
:::

### Saving and deleting a dungeon

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `DUNGEON_EDITOR_LIST` | Sends every dungeon, the maps to pick from and the default multipliers |
| Save | `DUNGEON_EDITOR_SAVE` | Checks the dungeon, writes it, and answers with every dungeon as it then stands |
| Delete | `DUNGEON_EDITOR_DELETE` | Removes the dungeon |

Another open Dungeon Tool is told to reload its Dungeons tab after every change (`DUNGEON_EDITOR_UPDATED`).

After a save the tab says "Link an entrance portal to lead into it." for a new dungeon, and "Copies that are already open keep running with what they were opened with." for a change.

Deleting a dungeon does not close its copies. They keep running, and players inside can leave and come back, but no new copy opens. Players inside a copy of a deleted dungeon who release their spirit are sent to their portal, because the entrance is no longer known. Deleting a dungeon unlinks its portals: stepping into one does nothing until another dungeon picks it.

## Portals

A portal is either a **dungeon portal**, which leads into the dungeon that picks it as its entrance on the Dungeons tab, or a **teleport**, which leads to a place on a live map and gets a return portal there that leads back. A dungeon that a portal leads into gets an exit portal on its own map in the same way.

The tab lists the portals of your current map, and lists the new map's portals when you move to another one. Inside a dungeon copy its changes are refused: edit the dungeon's own map instead (for example with `/warp <map>`).

### Portal fields

| Field | What it does |
| --- | --- |
| Name | Unique on the map, without regard to case. Up to 48 characters. The Dungeons tab lists the portal by this name. |
| Mirror other side | On (the default): the opening shows the far side, with the players there moving live. Off: the arch and swirl only, and nothing is fetched for it. |
| Destination | **None (dungeon)**: a dungeon portal, linked from the Dungeons tab. **Teleport**: leads to a map and a place. |
| Map, X, Y | Teleports only: the map it leads to and where players arrive, in whole pixels inside that map. The return portal stands just above that place, so Y must leave 16 pixels plus the portal's height above it. |
| X, Y | The portal's top-left corner on this map. Players step in at its bottom edge. |
| Width, Height | 8 to 512 pixels. A new portal is 32 × 32. |

**Place at my position** centres the portal on where you stand when you click it, kept inside the map. A new portal starts where you stand when you click **New portal**. It stays there wherever you save from, so you can walk to the destination to set its place.

For a teleport, **Place at my position** under **Destination** sets the map and place to where you stand when you click it. Players arrive there. It stays there wherever you save from.

An open portal stays open when you walk to another map, with the changes not saved, and is saved on its own map. The list shows the portals of the map you are on. **Place at my position** under **Placement** works only on the portal's own map.

The server checks every field again on save. Changing a linked dungeon portal into a teleport unlinks it from its dungeon.

### Return portals

Saving a teleport with a destination keeps one **return portal** on the destination map. It is a teleport back to the spot just in front of the teleport, with the same size and Mirror other side.

- **Where players come out.** A portal fires when a player walks into its rectangle from the front, up across its bottom edge. Coming from above or from a side never fires it. The arch it stands in is solid on the ground: 94 pixels wide, centred on the rectangle, and 20 pixels deep up from its bottom edge, with an opening 42 pixels wide in the middle that is closed at the back. A player who comes out of a portal stands centred on it, 16 pixels below its bottom edge, outside the rectangle. Walking back up into it takes them through again.
- **Where the return stands.** Centred above the teleport's place, with its bottom edge 16 pixels above it, so players who arrive stand just in front of it. Near the left or right edge of the map it is moved along the edge. The teleport itself needs 16 pixels of map below it for players coming back.
- **Name.** The teleport's name with ` (return)`, for example `Gate (return)`. If that name is taken on the destination map, it becomes `Gate (return 2)`, then `(return 3)` and on.
- **It follows the teleport.** Moving the teleport, changing its destination, Mirror other side, name or size updates the return. A new destination map moves the return there. Deleting the teleport, setting its destination to None, or saving it as a dungeon portal deletes the return. Every map that changes is saved in the same change.
- **It is not edited on its own.** The list marks it **Return** with the teleport it belongs to. It cannot be saved, moved, copied or deleted here: edit that teleport instead. A return is never offered as a dungeon's entrance portal.
- **Same map.** A teleport and its return can be on one map. A place so close that the return would stand on the teleport is refused.
- **Older teleports.** A teleport saved before return portals existed gets its return the next time it is saved.

When the map editor grows a map to the left or up, every teleport that leads into that map, returns included, moves with it.

### Dungeon exits

A dungeon portal linked to a dungeon keeps one exit portal on the dungeon's own map, so players can leave a copy. It is a dungeon portal linked to no dungeon: inside a copy it sends players back out to the portal they came in through; on the dungeon's map itself it leads nowhere. It is named, sized and placed like a return portal, around the dungeon's entrance (where players arrive in a copy), and copies opened from then on have it. See [Setting up the portal and the exit](#/tools/dungeon-tool/setting-up-the-portal-and-the-exit) for when it changes.

- Saving a linked dungeon portal here (moved, resized, renamed, Mirror) updates the exit. Deleting it, or saving it as a teleport, deletes the exit, unless another portal leads into the same dungeon: that one then keeps it.
- With no room above the dungeon's entrance for a portal of this size, the save is refused on **Destination**.
- The list marks the exit **Exit**. Like a return portal, it cannot be saved, moved, copied or deleted here.
- A portal linked before exits were made gets its exit the next time it is saved.

### What the opening shows

| Portal | Far side |
| --- | --- |
| Dungeon portal outside a copy | The dungeon's entrance, with the players in your own or your party's copy. With no copy open, a still picture. Other groups' copies are never shown. |
| Dungeon portal inside a copy (the exit) | Your saved spot outside, live. |
| Teleport | The destination's tiles and the players there, live. |
| Return portal | The spot in front of its teleport and the players there, live. |
| Dungeon exit | As any dungeon portal inside a copy: your saved spot outside, live. On the dungeon's own map, nothing. |

Only players are shown, without nameplates; they cannot be targeted. The feed runs while you are within 200 pixels of the portal (the two nearest at most), at about 10 updates a second, for maps on the same game server.

### Where portals are kept

Portals are map objects: the `dungeonPortals` list of the map (the Tiled object layer **Dungeon Portals**), saved through the asset server like the map editor's objects. Each has `name`, `kind` (`dungeon` or `teleport`), `dungeonId` (the linked dungeon or `null`), `mirror`, `target` (`{ map, x, y }` for a teleport, else `null`), `position`, `size` and `layer`. A return portal or dungeon exit also has `returnOf` (`{ map, name }` of the portal it follows; Tiled properties `return_of_map` and `return_of`). A portal saved before these fields existed loads as a dungeon portal with Mirror other side on.

The [Map Editor](#/tools/map-editor) draws portals and keeps them as they are, but does not create or edit them.

## Summoning stones

A summoning stone stands on a map outside dungeons. Two members of a party who touch it can summon a third member of their party to it. The tab lists the stones of your current map, and lists the new map's stones when you move to another one; a stone that was open is closed when you move.

Stones can only be placed on maps outside dungeons. On a dungeon's map, or inside a copy, the tab shows "Summoning stones can only be placed on maps outside dungeons." in place of the list and the form.

### Stone fields

| Field | What it does |
| --- | --- |
| Name | Unique on the map, without regard to case. Up to 48 characters. |
| Position X and Position Y | The stone's foot: X is its middle and Y the line it stands on, in pixels inside the map. Players touch it from within 150 pixels of this point, and a summoned player lands 8 pixels below it, facing down. |
| Glow color | The colour its runes glow in, as a steady glow. Pick it from the swatch or type a code such as `#66ccff`, which is the colour a new stone starts with. Stored in lower case. |

**Place at my position** puts the stone's foot where you stand when it is saved. **Duplicate** is off on this tab: a summoning stone is placed, not copied.

The server checks every field again on save: the name is there ("Name is required."), not longer than 48 characters and not taken on the map ("This map already has a summoning stone with that name."), the position is a number inside the map ("The summoning stone must be inside the map."), and the glow colour is a `#rrggbb` code ("The glow color must be a #rrggbb color."). **Delete** asks first, and cannot be undone.

The stone is drawn from `img/summoning_stone.png` (64 × 96), standing on its foot. Its runes (its brightest parts, and the pale strokes joined to them) are drawn in the glow colour, shaded as the picture is, with a soft glow around them, and the stone casts its shadow on the ground behind it. The base of the stone is solid, 56 pixels wide and 16 deep, starting 16 pixels up from the foot, so a player can walk right up to the stone's foot.

### Where stones are kept

Stones are map objects like portals: the `summoningStones` list of the map, each `{ name, position, glowColor, layer }`, saved through the asset server. In the Tiled map they are point objects of type `summoning_stone` on the object layer **Summoning Stones**, with the glow colour in the property `glow_color`. When the map editor grows a map to the left or up, its stones move with it. Dungeon copies have no stones.

After a save or a delete, every player on the map is sent the map's stones (`MAP_SUMMONING_STONES`) and draws them at once.

## Packets

Every packet from the window checks the permission first.

| Packet | Direction | Purpose |
| --- | --- | --- |
| `TOGGLE_DUNGEON_EDITOR` | To client | Open or close the Dungeon Tool (sent for `/de`, `/dungeoneditor`, `/poe` and `/portaleditor`) |
| `DUNGEON_EDITOR_LIST` | To server | Ask for the Dungeons tab's data |
| `DUNGEON_EDITOR_DATA` | To client | The Dungeons tab's data: `{ dungeons, maps, portals, defaults, ready }`; `portals` lists every dungeon portal as `{ map, name, dungeonId }` |
| `DUNGEON_EDITOR_SAVE` | To server | Save a dungeon; `portal: { map, name }` or `null` changes the entrance portal, and leaving it out keeps the links |
| `DUNGEON_EDITOR_DELETE` | To server | Delete a dungeon |
| `DUNGEON_EDITOR_RESULT` | To client | Whether a change worked, with the field errors and the dungeons as they now stand |
| `DUNGEON_EDITOR_UPDATED` | To client | The dungeon list changed |
| `PORTAL_EDITOR_LIST` | To server | Ask for the map's portals |
| `PORTAL_EDITOR_DATA` | To client | `{ map, portals, dungeons, maps, here, nameMax, sizeMin, sizeMax }` |
| `PORTAL_EDITOR_SAVE` | To server | `{ original, map, name, mirror, destination, target, position, size, atMe }` (`map`: the map the portal stands on; the editor's own map when left out) |
| `PORTAL_EDITOR_DELETE` | To server | `{ name }` |
| `PORTAL_EDITOR_RESULT` | To client | `{ ok, errors, fields, name, notes, action, data }` |
| `MAP_PORTALS` | To client | A map's portals after a save: `{ mapName, portals }`, sent to the players on it |
| `SUMMON_STONE_EDITOR_LIST` | To server | Ask for the map's summoning stones |
| `SUMMON_STONE_EDITOR_DATA` | To client | `{ map, stones, here, nameMax, refused }`; `refused` is why stones cannot be placed on this map, or `null` |
| `SUMMON_STONE_EDITOR_SAVE` | To server | `{ original, name, position: { x, y }, glowColor, atMe }` |
| `SUMMON_STONE_EDITOR_DELETE` | To server | `{ name }` |
| `SUMMON_STONE_EDITOR_RESULT` | To client | `{ ok, errors, fields, name, action, data }`; `fields` keys are `name`, `position.x`, `position.y` and `glowColor` |
| `MAP_SUMMONING_STONES` | To client | A map's summoning stones after a save: `{ mapName, stones }`, sent to the players on it |
| `MAP_OBJECT_OPTIONS` | To server | The Map Editor asks for the dungeons and loot tables its pickers offer |
| `MAP_OBJECT_OPTIONS_DATA` | To client | `{ dungeons, lootTables }`, each a list of `{ id, name }` |
| `DUNGEON_SIZE_CHOICE` | To client | A raid that can be opened at more than one size asks the player for one: `{ dungeonId, name, sizes, authorization }` |
| `DUNGEON_SIZE_PICK` | To server | The size picked: `{ authorization, size }` |
| `DUNGEON_PORTAL_PREVIEW` | To server | `{ portal }`: what the named portal on your map leads to |
| `DUNGEON_PORTAL_PREVIEW_DATA` | To client | `{ portal, map, x, y, tilewidth, tileheight, tilesets, color }`, or `map: null` |
| `DUNGEON_PORTAL_PEEK` | To server | `{ portal, on }`: start or stop the live feed of a portal |
| `DUNGEON_PORTAL_PEEK_DATA` | To client | `{ portal, players: [{ i, x, y, d, m }], looks: [{ i, s }] }`: positions relative to the far place; a look is sent once per player |

`MAP_OBJECT_OPTIONS` is answered only to a player who may save maps (`server.admin` or `server.*`). The packet players send at a stone (`SUMMON_STONE_TOUCH`) is listed in [Packet Types](#/engine/packet-types).
