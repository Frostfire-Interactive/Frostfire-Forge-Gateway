---
title: Mailbox Editor
description: Place, move and remove the mailboxes of a map, or give them back to its inns.
order: 46
---

The mailbox editor decides where mailboxes stand. A map left alone has its mailboxes placed for it: one in front of each inn door, on open country. Once a map's mailboxes are saved from the editor, the map keeps a list of its own in the `mailbox_spots` table, and its inns place none. Deleting that list gives the map back to its inns. A map saved with no mailbox has none.

## Opening it

```text title="Chat command"
/mailbox
```

The editor opens in its own window at route `/mailbox-editor`, against the right edge of the screen so the world stays in view. Typing the command again closes it.

## Permission

| Needs | What happens without it |
| --- | --- |
| Admin role, `tools.mailbox_editor`, `tools.*`, `server.admin` or `server.*` | "You don't have permission to use this command" |

The permission is read from the database on every packet, so granting or removing it takes effect at once. `tools.mailbox_editor` is added to `permission_types` when the server starts.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The side pane lists the map you are on, marked **You are here**, and the last 10 maps you visited, newest first. The game remembers them in your browser. Any other map is found by searching for its name: a search shows 50 maps at most, and says how many more match. Each map shows how many mailboxes it has, and **placed by hand** when they were saved from the editor. When you go to another map, the list follows.

The open map lists its mailboxes, each with its **X** and **Y** in px from the map's top left: the middle of the mailbox's foot. **In plain words** beside it says what the map's mailboxes are in the game.

| Control | What it does |
| --- | --- |
| **Add mailbox** | On the map you are on: a mailbox beside you. On another map: one 32 px right of the last. |
| Pin (on a mailbox) | Brings that mailbox beside you. Only on the map you are on. |
| Bin (on a mailbox) | Removes that mailbox. |
| **Save** | Saves the map's mailboxes as they are listed. The map then keeps its own list. |
| **Delete** | Deletes the list placed by hand: the map's inns place its mailboxes again. Only for a map with a list of its own. |

## In the world

While the editor has the map you are on open, its mailboxes are drawn as the editor has them, each in a frame, the picked one in gold. Changes show at once, before they are saved.

- Drag a mailbox with the mouse to move it. The editor follows it.
- Click or tap a mailbox to pick it in the editor. When the editor has another map open, the first click opens the map you are on.
- A click on a mailbox does not open the mail window while the editor is open.

When the editor shows another map, or closes, the mailboxes are drawn where the server has them again. Saving or deleting sends every player on that map the mailboxes as they now stand, and every other open mailbox editor reloads its list.

## Rules

| Rule | Message |
| --- | --- |
| X and Y are whole numbers from 0 to 1000000 | "X and Y must be whole numbers from 0 to 1000000." |
| Two mailboxes cannot stand on the same spot | "Another mailbox stands on the same spot." |
| The map must exist | "There is no map called ..." |
