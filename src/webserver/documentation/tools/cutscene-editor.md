---
title: Cutscene Editor
description: Direct cutscenes on a timeline, play them to players, and record trailers to a video file.
order: 107
---

The cutscene editor makes scenes that play in the game world: the camera moves, characters walk and speak, the screen fades, text appears and sound plays. A saved scene plays to players when something sets it off, such as walking into an area or finishing a quest. The same scene can be recorded to a video file for a trailer.

## Opening it

```text title="Chat command"
/cse
/cutsceneeditor
```

The editor opens in its own window at route `/cutscene-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.cutscene_editor` or `tools.*`
- `server.admin` or `server.*`

They are checked again on every packet the editor sends. A refused packet answers "You don't have permission to use the cutscene editor." Guests cannot use it.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The side pane lists every scene, with the search field filtering it as you type, and New. The work area has five tabs.

| Tab | What it holds |
| --- | --- |
| Timeline | The scene itself, and the controls that play it |
| Actors | The characters that appear in the scene |
| Settings | The scene's name, map and length, how the game looks while it plays, and what happens after it |
| When it plays | What starts the scene for a player |
| Record video | Recording the scene to a video file or a picture |

A new scene starts on the map you are on. A scene plays on one map, and the game window has to be on that map to preview it: the editor offers **Go there** when you are somewhere else.

With nothing picked on the timeline, the panel beside it lists the **Next steps** for the scene: frame the first shot, add what happens, watch it, save it, and choose when it plays. The next one has its button right there, and each ticks itself off as the scene gets there. **Done** under an item's form, or a click on an empty part of the timeline, brings the list back.

The **i** button at the end of the controls lists the keyboard shortcuts and opens this guide.

## Previewing

Everything you change shows in the game window at once, so keep the two windows side by side. The preview runs on your computer only: other players see nothing, and your character stays where it is.

The **Game window shows** buttons pick what the game window shows.

| View | What you see |
| --- | --- |
| Free camera | A camera you fly yourself, with the scene's camera path, actors and places drawn over the world so you can move them. Text, bars and fades stay out of the way |
| Player's view | The scene as a player gets it, stopped at the playhead |
| Normal game | The game as normal |

**Play** always shows Player's view, whichever view you are in, and the game window goes back to your view when the scene stops or you pause it.

With the playhead at the very start, Player's view shows the opening shot rather than the black of a fade in. Playing the scene and recording it show the fade.

In Free camera view, drag with the mouse to look around, and use the wheel to zoom. Drag a camera shot, an actor or a stop on a path to move it. A place picked this way goes straight into the scene.

**Add camera shot** keeps what the camera sees now as a shot at the playhead. This is the quickest way to block out a scene: fly to the shot in Free camera view, then press the button.

**Place in game** on a field waits for your next click in the game window, and uses that spot. **Set from game camera** takes where the camera is now. **Show in game** takes the free camera to the spot.

## The timeline

The timeline runs left to right, one row to a track. Drag the playhead along the ruler to move through the scene. **Scene length** sets how long the scene lasts, in seconds.

**Add** puts something into the scene at the playhead: a camera shot, text, a fade or flash, a shake, a sound, weather, the time of day, particles, something an actor does, a new actor, or a marker. The row it needs is made for you, a second one when the first already has something at the playhead, and the new item opens in the panel beside the timeline.

Double-click a row to put something on it at that spot. An empty row says what it takes. Drag an item to move it, or drag its ends to change how long it lasts. Click an item to edit it in the panel, and hold Shift or Ctrl to pick more than one. Hold Ctrl and turn the wheel to zoom the timeline.

**Empty track** at the end of the Add menu adds a row with nothing on it. The menu at the left of a row renames it, moves it, or deletes it. The eye on a row turns it off while you work on the others. An item with something wrong with it is marked, and the list above the work area says what.

| Track | What goes on it |
| --- | --- |
| Camera | Shots: where the camera is at that moment |
| Shake | Stretches where the camera shakes |
| Screen | Fades, flashes, colour tints and vignettes |
| Text | Titles, subtitles and speech lines |
| Actor | What one actor does: one track to an actor |
| Audio | Music and sound effects |
| World | Weather, the time of day and particles |
| Mark | Named moments that the server's scripts hear |

### Camera shots

The camera goes from one shot to the next. **Arrives** says how: Smooth, Steady, Speed up, Slow down, or Cut, which jumps there at the moment of the shot. **Zoom** goes from 1 to 3.

**Follows** keeps the camera on an actor or on the player watching. The shot's X and Y are then an offset from them, which is how a shot follows someone walking. With no shot on the timeline, the camera stays on the player.

### Actors

The Actors tab adds characters. An actor can look like one of your NPCs, like the player who is watching, or be dressed by hand. Dressing by hand works as in the NPC editor: pick a sprite sheet for the body, head, hair and each piece of armour, or a still image, and the pickers show what each one looks like. It has a name, a place to stand and a direction to face, and can begin out of view.

Adding an actor adds a track for it. Its items are:

| Action | What it does |
| --- | --- |
| Move | Walks along the stops of a path. **Pace** sets how it speeds up and slows down, and **Walks as** picks the animation |
| Place | Puts it somewhere at once |
| Face | Turns it |
| Animate | Plays an animation. A length of 0 keeps it up until something else changes it |
| Say | Shows a speech bubble over it |
| Show, Hide | Brings it into view, or takes it out |

Actors exist only on the screen of the player watching. Nobody else sees them, and they cannot be fought or spoken to. An actor that looks like an NPC leaves the real NPC where it stands.

### Audio

A sound plays as Music or as an Effect, and the player's slider of that name sets how loud it is. A length of 0 plays the whole sound. Fade in, Fade out, Volume, Speed and Loop are on the item. The row shows how long the file is.

**Game sounds** in Settings sets how loud the game's own sounds go on under the scene.

### World

| Action | What it does |
| --- | --- |
| Weather | From that moment on, until the next weather item or the end of the scene |
| Time of day | Moves the light from one hour to another, and stays at the last hour until the scene ends |
| Particles | Runs a particle effect at a place in the world |

These change what the player watching sees. The real weather and time come back when the scene ends.

### Marks

A mark names a moment of the scene. Reaching it sends the `onCutsceneMark` event on the server, so a plugin can open a door or hand over a reward at the exact moment. See [Scenes and plugins](#scenes-and-plugins).

### Keys

| Key | Does |
| --- | --- |
| Space | Play or pause |
| Home | Back to the start |
| Left, Right | Move the picked items a little, or move the playhead one frame when nothing is picked. Hold Shift for larger steps |
| Delete | Delete the picked items |
| Ctrl+D | Duplicate |
| Ctrl+C, Ctrl+V | Copy, and paste at the playhead |
| Ctrl+Z, Ctrl+Y | Undo and redo |
| Ctrl and the mouse wheel | Zoom the timeline |

## Settings

| Setting | What it does |
| --- | --- |
| Black bars, Bar height | The letterbox bars at the top and bottom of the screen |
| Game sounds | How loud the game goes on under the scene |
| Hide the interface | Takes the game's windows and bars off the screen |
| Hide other players, Hide the player watching, Hide creatures | What the world shows during the scene |
| Can be skipped | Shows a Skip button. The player can also press Escape |
| Holds the player still | They cannot move or be harmed until it ends. Admin commands and the player editor leave them alone too: `/cutscene stop` ends the scene first |
| Fade in, Fade out | Fades from and to black at each end of the scene |

**After it ends** says what comes next. **Goes on to** starts another scene, for a story told in several shots. **Move the player** takes them to a place on any map, with **Place in game** to choose it.

A scene goes on without a break when its player changes server node, and a chain can go on to a scene on ground another node owns.

## When it plays

A scene with no trigger plays only when an admin or a plugin starts it. A scene can have several triggers.

| When a player | Details |
| --- | --- |
| Walks into an area | Draw the area in the game window. It plays when they step in, not while they stand there |
| Arrives on the map | Plays when they enter the scene's map |
| Logs in on the map | Plays when they log in on the scene's map |
| Accepts a quest | Pick the quest |
| Finishes a quest | Pick the quest |
| Talks to an NPC | Pick the NPC |

**Once for each player** plays the scene to a player only the first time. **From level** keeps it from players below that level.

A trigger only works on the scene's map. Use `/cutscene reset` to let a player see a once-only scene again.

## Trailers and stills

The Record video tab records to a file on your computer. A recording runs in real time: the scene plays through in the game window, and the file goes to your downloads when it ends. **Stop** ends it early and keeps what there is.

| Setting | What it does |
| --- | --- |
| Records | **The scene** draws each frame at the size and shape you pick, with nothing of the interface in it. The camera sees as much of the world as a window of that shape would. **The browser tab** records the window as it stands |
| Plays | **This edit** records what is in the editor, saved or not. **The saved scene** plays it as a player gets it, and goes on to the next scene of a chain |
| File | MP4 or WebM |
| Size | Standard video sizes, and square and vertical frames for social media |
| Frames | 30 or 60 a second |
| Quality | How many megabits a second the file may use. Higher looks better and makes a larger file |
| Sound | Puts the game's sound in the file |
| From, To | The part of the scene to record. Blank To runs to the end |

**Save this frame** saves a PNG at the chosen size, without playing anything. Use it in Free camera or Player's view to make thumbnails and key art: Free camera gives the bare world, and Player's view adds the scene's text, bars and fades.

When recording the browser tab, the game window shows a **Start recording** button, and the browser asks which tab to share. Pick this one.

A recording of the scene goes on while the game window is behind another one. A recording of the browser tab needs the tab showing.

## Playing a scene by hand

```text title="Chat commands"
/cutscene play <name> [player | map]
/cutscene stop [player]
/cutscene list
/cutscene reset <name> <player>
```

| Command | What it does |
| --- | --- |
| `play <name>` | Plays the scene to you |
| `play <name> <player>` | Plays it to an online player |
| `play <name> map` | Plays it to everyone on your map |
| `stop [player]` | Ends the scene of you or of a player, without what follows it |
| `list` | Names every scene |
| `reset <name> <player>` | Lets a player see a once-only scene again |

A name with spaces goes in quotes. **Watch as a player** on the timeline does the same as `/cutscene play <name>` for the saved scene.

These commands need the same permission as the editor.

## Scenes and plugins

A plugin can start a scene and follow one:

```ts
await engine.playCutscene(player, "Intro");
```

[`playCutscene`](#/engine/engine-api/playcutscene) answers `true` when the scene began.

| Event | Sent when | Data |
| --- | --- | --- |
| `onCutsceneStarted` | A scene begins for a player | `player`, `cutscene` |
| `onCutsceneEnded` | A scene is over for a player | `player`, `cutscene`, `skipped` |
| `onCutsceneMark` | The scene reaches a mark | `player`, `cutscene`, `name`, `t` |

## Deleting

Deleting a scene removes it and the record of who has seen it. Scenes that go on to it stop going on to it: the editor names them before you confirm.

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `CUTSCENE_EDITOR_LIST` | Sends every scene, and the NPCs, weather, particles, sounds, quests, maps, sprite sheets and images a scene can use |
| Save | `CUTSCENE_EDITOR_SAVE` | Validates the whole scene, then saves it and refreshes the cache |
| Delete | `CUTSCENE_EDITOR_DELETE` | Deletes the scene and its record of who has seen it, and clears **Goes on to** in the scenes that named it |
| Preview | `CUTSCENE_EDITOR_RESOLVE` | Checks the scene as a save would, and fills in what the actors look like |
| Watch as a player | `CUTSCENE_EDITOR_PLAY` | Plays the saved scene to you |
| Go there | `CUTSCENE_EDITOR_GOTO` | Takes you to the scene's map |

Open is answered with `CUTSCENE_EDITOR_DATA`, Save and Delete with `CUTSCENE_EDITOR_RESULT`. A refused save names the fields that need fixing, and the editor marks them. After a successful change, every other online account that may use the editor receives `CUTSCENE_EDITOR_UPDATED`.

A saved scene is live at once. Scenes are stored in the `cutscenes` table, and who has seen a once-only scene in `cutscene_views`.
