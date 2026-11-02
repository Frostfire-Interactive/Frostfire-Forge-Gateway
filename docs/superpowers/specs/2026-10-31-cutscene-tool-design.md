# Cutscene and trailer tool: design and plan

Decided 2026-10-31. The user chose "just dive in" and walked away, so the calls below were made without asking.

One tool, built on the existing editor pattern. An admin opens `/cutsceneeditor` (`/cse`), lays a scene out on a
timeline in a popup, previews it live in the game window, saves it to the server, and either has it played to
players (through triggers, a command or a plugin) or records it to a video file.

`/ce` is taken by the creature editor, so the alias is `/cse`, as the class editor took `/cle`.

## Parts

| Part | Where | What it does |
|---|---|---|
| Scene store and editor packets | engine `src/systems/cutscenes.ts` | Table, validation, permission, list/save/delete |
| Player sessions and triggers | engine `src/systems/cutscenes.ts` | Plays a scene to a player, holds them still and safe, runs the end of a scene, watches triggers |
| Runtime | gateway `core/cutscene.ts` | Deterministic `evaluate(t)`: camera, actors, screen, text, audio, world. Used by both preview and live play |
| Overlay | gateway `core/cutsceneoverlay.ts`, `#cutscene-layer` | Bars, fades, tints, vignette, text. Top canvas, so the recording catches it |
| Director | gateway `core/cutsceneeditor.ts` | Game half of the editor: free camera, world overlay of the path and actors, picks places, relays to the server |
| Timeline popup | gateway `core/cutsceneeditorbridge.ts`, `core/cutscenetimeline.ts`, `cutsceneeditor.html` | The editor window, on `EditorShell` |
| Capture | gateway `core/cutscenecapture.ts` | Composites every layer to a canvas, records video and sound, takes stills |

## The scene document

The same JSON everywhere: stored in `cutscenes.data`, sent to the editor, sent (resolved) to players.

```ts
type Ease = "linear" | "smooth" | "in" | "out" | "hold";
type Dir = "up" | "down" | "left" | "right";

interface CutsceneDoc {
  name: string;          // key. 1-64 chars: letters, digits, space, _ and -. Never renamed once saved.
  description: string;   // editor's note, up to 500
  map: string;           // the map it plays on, no ".json"
  duration: number;      // seconds, 0.5 to 600
  settings: {
    letterbox: boolean;
    letterboxSize: number; // 0 to 0.25 of the screen's height, each bar
    hideHud: boolean;
    hideOthers: boolean;   // other players
    hideSelf: boolean;     // the viewer's own character
    hideCreatures: boolean;
    skippable: boolean;
    lock: boolean;         // holds the player still and out of harm's way
    worldVolume: number;   // 0 to 1, the world's own sounds during the scene
    fadeIn: number;        // seconds, 0 to 10
    fadeOut: number;       // seconds, 0 to 10
  };
  actors: Actor[];       // up to 32
  tracks: Track[];       // up to 64
  triggers: Trigger[];   // up to 16
  end: {
    teleport: { map: string; x: number; y: number } | null;
    next: string | null; // the scene that follows it
  };
}

interface Actor {
  id: string;            // "a1", unique in the doc, up to 16 chars
  name: string;          // up to 64
  showName: boolean;
  look:
    | { kind: "npc"; npcId: number }
    | { kind: "viewer" }  // the viewer's own character
    | { kind: "layers"; sprite_type: "animated" | "static"; body: string | null; head: string | null;
        helmet: string | null; shoulderguards: string | null; neck: string | null; hands: string | null;
        chest: string | null; feet: string | null; legs: string | null; weapon: string | null };
  x: number; y: number; direction: Dir;
  visible: boolean;      // at the start of the scene
  // Filled in by the server when it resolves a doc. Never stored.
  sprite_type?: string;
  spriteLayers?: unknown;
}

type Track =
  | { id: string; kind: "camera"; label: string; muted?: boolean; items: CameraKey[] }
  | { id: string; kind: "shake";  label: string; muted?: boolean; items: ShakeClip[] }
  | { id: string; kind: "screen"; label: string; muted?: boolean; items: ScreenClip[] }
  | { id: string; kind: "text";   label: string; muted?: boolean; items: TextClip[] }
  | { id: string; kind: "actor";  label: string; muted?: boolean; actor: string; items: ActorItem[] }
  | { id: string; kind: "audio";  label: string; muted?: boolean; items: AudioClip[] }
  | { id: string; kind: "world";  label: string; muted?: boolean; items: WorldClip[] }
  | { id: string; kind: "mark";   label: string; muted?: boolean; items: Mark[] };

// t: start in seconds, 0 to duration. d: length in seconds, 0 for a point. Up to 500 items a track, 4000 a doc.
interface Item { id: string; t: number; d: number }

interface CameraKey extends Item {  // d is 0
  x: number; y: number;             // world px; an offset from the followed actor when `follow` is set
  zoom: number;                     // 1 to 3
  ease: Ease;                       // how the camera comes INTO this key; "hold" cuts to it
  follow: string | null;            // an actor id, "viewer", or null
}
interface ShakeClip extends Item { strength: number; speed: number } // 0-64 px, 1-60 Hz
interface ScreenClip extends Item {
  effect: "fade" | "flash" | "tint" | "vignette";
  color: string;                    // #rrggbb
  amount: number;                   // 0 to 1
  in: number; out: number;          // seconds
}
interface TextClip extends Item {
  style: "title" | "subtitle" | "caption" | "dialogue";
  text: string;                     // up to 500
  sub: string;                      // title's second line, up to 200
  speaker: string;                  // dialogue's name, up to 64
  x: number; y: number;             // caption only: 0 to 1 of the screen
  in: number; out: number;
  typewriter: number;               // characters a second, 0 for all at once, up to 120
  color: string;                    // #rrggbb
  size: number;                     // 0.5 to 3, a multiplier
}
type ActorItem = Item & (
  | { do: "move"; path: { x: number; y: number }[]; ease: Ease; animation: "walk" | "mount_walk" | "cast_walk" } // 1-64 points
  | { do: "place"; x: number; y: number; direction: Dir }
  | { do: "face"; direction: Dir }
  | { do: "animate"; animation: "idle" | "walk" | "cast_idle" | "cast_walk" | "mount_idle" | "mount_walk" }
  | { do: "say"; text: string }     // up to 200, a bubble for d seconds
  | { do: "show" } | { do: "hide" }
);
interface AudioClip extends Item {
  sound: string;                    // audio file name on the asset server, up to 128
  bus: "music" | "effects";
  volume: number;                   // 0 to 1
  rate: number;                     // 0.25 to 4
  loop: boolean;
  in: number; out: number;
}
type WorldClip = Item & (
  | { do: "weather"; weather: string; weatherData?: unknown }  // weatherData: resolved by the server, never stored
  | { do: "time"; from: number; to: number }                    // hours, 0 to 24, eased across the clip
  | { do: "particles"; particle: string; x: number; y: number; particleData?: unknown } // same
);
interface Mark extends Item { name: string }  // up to 64. Fires Events.CUTSCENE_MARK on the server.

interface Trigger {
  id: string;
  on: "area" | "map" | "login" | "quest_accept" | "quest_complete" | "npc";
  once: boolean;                    // once per character, ever (cutscene_views)
  minLevel: number;                 // 0 for none
  x: number; y: number; w: number; h: number;  // area: a rect in world px on doc.map
  questId: number | null;           // quest_accept, quest_complete
  npcId: number | null;             // npc
}
```

## Packets

Client to server:

| Packet | Data | Answer |
|---|---|---|
| `CUTSCENE_EDITOR_LIST` | `{}` | `CUTSCENE_EDITOR_DATA` |
| `CUTSCENE_EDITOR_SAVE` | `{ originalName: string \| null, doc }` | `CUTSCENE_EDITOR_RESULT` |
| `CUTSCENE_EDITOR_DELETE` | `{ originalName }` | `CUTSCENE_EDITOR_RESULT` |
| `CUTSCENE_EDITOR_RESOLVE` | `{ doc }` | `CUTSCENE_EDITOR_RESOLVED { doc }` or a RESULT with errors |
| `CUTSCENE_EDITOR_PLAY` | `{ name }` | plays the saved scene to the sender as a player would see it |
| `CUTSCENE_EDITOR_GOTO` | `{ map, x, y }` | teleports the sender |
| `CUTSCENE_STARTED` | `{ token }` | the client has begun: the session's clock starts |
| `CUTSCENE_END` | `{ token, skipped }` | the scene is over or was skipped |

Server to client: `TOGGLE_CUTSCENE_EDITOR`, `CUTSCENE_EDITOR_DATA`, `CUTSCENE_EDITOR_RESULT`,
`CUTSCENE_EDITOR_RESOLVED`, `CUTSCENE_EDITOR_UPDATED`, `CUTSCENE_PLAY { token, doc }`, `CUTSCENE_STOP { token }`.

`CUTSCENE_EDITOR_DATA` is `{ cutscenes: CutsceneDoc[] (each with updatedBy, updatedAt), npcs: { id, name, map }[],
weathers: string[], particles: string[], sounds: string[], quests: { id, name }[], maps: string[], limits }`.

`CUTSCENE_PLAY`'s doc is resolved (actors' `spriteLayers`, `weatherData`, `particleData`) and has no `triggers`.

## Decisions worth knowing

- **Preview is local.** Nothing the editor previews reaches the server or any other player. Only saved scenes play
  to players, through the server.
- **One map a scene.** A scene plays on `doc.map`. A chain (`end.next`) can change map: the server teleports the
  player between scenes and takes them home at the end if nothing else placed them.
- **Actors are local NPC objects** in `cache.npcs`, with string ids. Rendering, animation and y-sorting come free.
- **Zoom is 1 to 3.** Zoom below 1 would show what the server, the chunks and the light map do not cover.
- **The camera can fly anywhere on the map**, but the server only sends what is round the player, so other people's
  characters and creatures are seen near the player only. Actors and the map are seen everywhere.
- **Recording composites the layers.** `#ambience-overlay`, the cool overlay and the sun flare are DOM, so the
  compositor redraws them from their styles. A second mode records the tab itself for an exact copy, with a browser
  prompt.
- **Recording is live**, not offline: animation runs on `performance.now`, so frames cannot be stepped. Saved video
  plays at the real speed of the scene.
- **The lock has a time limit.** A client that disappears or never answers cannot leave a player held: a session
  ends by itself at its clock's end.

## Plan ledger

Status of each step. The hourly resume reads this.

- [x] 1. Read the code the tool plugs into
- [x] 2. Design
- [x] 3. Engine: storage, packets, triggers, lock, tests
- [x] 4. Client runtime, overlay, renderer and audio hooks
- [x] 5. Timeline popup and director
- [x] 6. Capture
- [x] 7. Docs, `bun check` in both repos, `bun test` in the engine
- [x] 8. Verify live: Docker test stack for the admin flow, guest flow with packet substitution for the client
