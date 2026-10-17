---
title: Gathering Editor
description: Place the areas where resource nodes spawn, and preview where their nodes would stand.
order: 47
---

The gathering editor places the areas where resource nodes spawn. Type `/gathering` to open it in its own window; type it again to close it.

## Areas

An area is a circle on the map you are on. Nodes of one item stand on random walkable tiles inside it, never close enough for their pictures to overlap. Each layer of the map has its own nodes, so players on other layers do not compete for them.

| Field | What it does |
|---|---|
| Item | What a gather gives. Its icon, from the asset server, is what stands in the world. |
| Size | How big a node is drawn, 8 to 128 px: the longest side of its picture, the other side in proportion. 32 when not set. |
| Least per gather, Most per gather | One gather gives a random amount between the two. |
| X, Y, Radius | The circle, in px from the map's top left. Use my position puts the centre where you stand. |
| Nodes at once | How many stand at once on each layer, 1 to 200. |
| Shortest regrow, Longest regrow | A gathered node comes back after a random time between the two, in seconds, on a random free tile in the circle. |
| On | An area that is off spawns nothing. |

Saving an area whose settings changed takes its nodes away and fills it again with the new settings. An area saved unchanged keeps its nodes. Deleting an area takes its nodes away.

## Preview

Preview draws, for you only, the circle and the nodes where they would stand with the settings as typed, half transparent. The spots are placed by the server on the map's collision data, as real nodes are. When fewer nodes fit than you asked for, the editor says how many. The preview redraws 250 ms after a change, and only for values that pass the checks. A value that does not pass keeps the last preview drawn. The preview goes away on Hide preview, on Save, when the area is deleted, when you open another area, start a New area, or go to another map, and when the editor closes.

## Gathering

Players click or tap a node, or press E beside one, within 100 px. The gather is a 1 s cast: a step, any damage, a stun or dying breaks it. It is refused in combat, while dead, stunned, moving or casting, and when the bags are full. When several players finish gathering the same node within 50 ms of each other, one of them is picked at random and the others are told someone else gathered it.

## Storage

Areas are rows of `gathering_areas`. The table is made when the game server starts, if it is missing.
