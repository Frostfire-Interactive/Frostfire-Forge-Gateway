---
title: Zones
description: Named areas drawn on a map in the map editor. Entering one shows its text on screen and fades to its music. How zones are stored, checked, sent to the client and saved.
order: 135
---

A zone is a named area of a map, drawn as an outline in the zone map window of the [map editor](#/tools/map-editor). When a player walks into a zone, its text shows at the top of the screen for a few seconds and its music fades in. A zone can also have a `kind`: zones of kind `desert` and `snow` are the places where a sandstorm or a blizzard is drawn (see [Weather](#/engine/weather)).

The engine code is in `src/modules/zones.ts`, with the cutting of one zone's shape by another in `src/modules/zoneoverlap.ts`. The client code is in `js/core/zonelogic.ts` (which zone, which music), `js/core/areazones.ts` (the banner and the music), `js/core/tileeditorzones.ts` (the editor's geometry and checks), `js/core/zoneoverlap.ts` (the same cutting as the engine's) and `js/core/zonemap.ts` (the zone map window).

## A zone

| Field | Meaning |
|-------|---------|
| `name` | The zone's name, unique on its map. Shown on entry when the zone has no `text`. |
| `text` | Optional. The text shown on entry, for example `Welcome to Riverside`. |
| `music` | Optional. An audio file of the asset server, as the pickers store it: lower case, without its extension. |
| `kind` | Optional. `desert` or `snow` make the zone a sandstorm or blizzard area. Any other word is kept as it is. |
| `outline` | Rings of `[x, y]` points in tiles. Each ring is an area of the zone, so a zone can be in more than one place. A zone has no holes: a ring inside another ring of the zone is left out (see Holes below). |
| `bbox` | The box around the outline, in tiles. The engine works it out from the outline. |

Any other field of a zone (for example `id` or `hub`, which the world generator writes) is kept as it is.

## Where zones are stored

| Map | Where |
|-----|-------|
| A Tiled JSON map | The top-level `zones` key of `maps/<name>.json` |
| A `.world` map | The `zones` list of its `manifest.json` (see [World Maps](#/engine/world-maps)) |

## Loading

When the engine loads a map it checks every zone against the map's size in tiles (`cleanZonesLenient`). A zone that fails a check is left out with a warning in the log, and the other zones load. It then sets the map's `zones`, and its `deserts` and `snowfields` from the zones of those kinds (`applyZones`).

A zone is checked for:

- a name that is not empty and not used by another zone of the map
- text, music and kind that are strings of the allowed lengths (`ZONE_LIMITS`)
- rings of 3 or more points, every point a whole number of tiles inside the map

The zone's holes are then filled (`fillHoles`, below), and zones that lie partly over each other are cut back to each other's edges (`separateZones`, see Overlaps below). Each zone that was cut is named in the log, for example `Map town: Zone Forest was cut back to the edge of Riverside`.

## Holes

A point is inside a zone when an odd number of its rings surround it. A ring drawn inside another ring of the same zone would therefore cut a hole in it. Zones never keep such a ring: `fillHoles` leaves out every ring whose points, and the middle of each of its edges, are all inside another ring of the zone or on its border. Rings that lie apart stay, in their order. An island inside a hole goes too, so the outer ring is the whole zone.

Holes are filled:

- when the engine loads a map's zones, and when it checks the zones of a save (`cleanZone`, used by both)
- when the asset server checks the zones it writes (its copy of the same rules)
- in the map editor, when it takes a map's zones and when it makes each zone edit, and in the zones it sends with a save

A map whose zones were stored with holes shows them filled from the next time the engine loads it. Its file keeps the old rings until its zones are next saved.

## Overlaps

Two zones never lie partly over each other. Each pair of zones is one of:

| Pair | Kept |
|------|------|
| Apart, or touching along an edge | As they are |
| One wholly inside the other, such as a town inside a forest | As they are. The player is in the smaller one. |
| Partly over each other | Never. The part that both cover is given to one of them. |

A ring of a zone is inside another ring when none of its edges crosses that ring's border and it is on the inside. The rings can share points and edges.

### Zones already stored

When the engine loads a map's zones, and when it checks the zones of a save, it goes through the zones from the smallest to the largest (`separateZones`). Each zone is cut by every smaller zone it lies partly over, so the smaller zone keeps the part they shared and the larger one now ends at its edge. A forest drawn partly over a town loses the part under the town, and the town stays as it was. A zone that a smaller one cuts across can end up in two or more places: it keeps all of them.

The cut follows the smaller zone's border exactly. Where the two borders cross between tile corners, the new point goes on a tile corner next to the crossing that is outside the smaller zone or on its border, so every point of a zone is still a whole tile corner and the two zones still do not overlap. A cut that cannot be made in whole tiles, or that would leave a border that crosses itself, is not made: that pair keeps its overlap, and the log names both zones. The order of the zones in the map is kept.

A map stored with overlapping zones shows them cut from the next time the engine loads it. Its file keeps the old shapes until its zones are next saved, and the save writes the cut shapes.

### Zones being edited

An edit in the zone map snaps the zone to the edges of the zones it lies partly over (`fitZoneEdit`). For each such zone:

- when most of the edited ring lies outside it, the ring is cut back to its edge, as above
- when most of the edited ring lies inside it, the ring is cut down to the part inside it, so the edited zone becomes a zone inside that one

A zone dragged or drawn inside another one, around it or apart from it is left as drawn. The cut is made in whole tiles in the same way as on loading. An edit whose cut cannot be made in whole tiles is not made, and the zone map shows `The zone cannot be cut to the edge of <name> in whole tiles`.

## Sending zones to the client

The map's zones are part of the `LOAD_MAP` metadata (`zones`, or `null`). The client keeps them in `window.mapData.zones`.

Four times a second the client works out the player's position in tiles and:

1. Finds the zone the player is in. When the player is in a zone inside another one, the smallest one wins, so a town drawn inside a forest is the town. The size of a zone in more than one place is that of all its places.
2. Shows that zone's text (or its name) when the player has just walked into it. It is shown every time, with no wait. The old text is taken down first, and a new map takes the old map's text down at once. On a new map the zone the player stands in is always shown.
3. Plays the music of the smallest zone that has music. A town without its own music keeps the forest's.

A change of music crossfades over 5 seconds: the old track fades out to silence while the new one fades in from silence, from the start of its file. A track loops over its whole file: its last sample runs straight into its first, so music made to loop keeps its beat. Both fades are slow at the quiet end, so the music comes in and goes out gently. Walking back into a zone while its music is still fading out brings that music back up from where it is. The level follows the Music slider and the Muted box of the pause menu, and the music is silent during a cutscene. Leaving every zone with music fades the music out.

The minimap's bottom label shows the name of the zone the player is in (the smallest one there), or the map's name outside every zone. The world map (M) draws every zone's border with its name inside it, at the point of the zone farthest from its edges, so a name stays out of a notch. Borders are drawn under the houses, caves, warps and tornadoes, and names over them. The zone under the mouse is lit with a brighter tint.

## Editing

The zone map sends each edit to the game window, which checks it (`checkZoneEdit`) before making it. An edit is made when:

- the zone has a name no other zone of the map has, in any case
- every ring has 3 to 512 points, each a whole tile corner inside the map
- text, music and kind are within `ZONE_LIMITS`
- the border does not cross itself: no two edges meet, except two edges of a ring that follow each other at the point they share, and no edge runs back along the one before it (`outlineCrosses`)

A border that crosses itself would leave part of what it goes round out of the zone, because a point is inside when an odd number of edges surround it. A zone already saved with such a border can still be edited, one point at a time, until its border no longer crosses. A refused edit is not made, and the zone map shows why.

An edit that is made has its holes filled, and is then snapped to the edges of the zones it lies partly over (see Zones being edited above). The snapped zone is checked again, as above, before it is kept. The zone map always shows a zone without holes, and no two zones partly over each other.

## Saving

The map editor sends the zones with `SAVE_MAP` as a `zones` list, only when the Zones layer changed. The engine checks the whole list with the strict check (`zonesForSave`): one bad zone refuses the save with the notification `Cannot save zones: <reason>`, and nothing is written. For a Tiled map the check uses the map's size after the save, including any growth the save makes.

After the save:

1. The engine posts the zones to the asset server's `/save-map-properties` with the map's graveyards and warps.
2. It updates its own copy of the map (`zonesSavedHere`), including `deserts` and `snowfields`.
3. It sends `MAP_ZONES` to every player on the map, the saver included. Their clients take the new zones at once, with no reload.
4. It tells the other game servers of the cluster (`map-saved` or `world-saved`, with the zones). Each one updates its copy and sends `MAP_ZONES` to its own players on the map.

When the map grows to the left or up in the editor, the editor moves every zone by the same number of tiles, so the zones stay over the same ground.
