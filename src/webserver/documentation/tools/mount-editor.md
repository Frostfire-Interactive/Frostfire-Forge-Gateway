---
title: Mount Editor
description: Add, change and delete the mounts players can ride: name, description and icon.
order: 105
---

The mount editor adds, changes and deletes the rows of the `mounts` table from inside the game. Before it, the only mount was the `unicorn` the setup script creates.

## Opening it

```text title="Chat command"
/me
/mounteditor
```

The editor opens in its own window at route `/mount-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.mount_editor` or `tools.*`
- `server.admin` or `server.*`

They are read from the permissions copied to you at login, as for the item editor, and checked again on every packet the editor sends. A refused packet answers "You don't have permission to use the mount editor."

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The side pane lists every mount, with the search field filtering it as you type, and New. A mount whose sprite sheet the asset server does not have is tagged **No sheet**.

| Field | Notes |
| --- | --- |
| Name | Required, up to 255 characters, and unique whatever its case. It cannot hold `/`, `\` or `..`, because it also names the sprite sheet. **A saved mount keeps its name**: players' collections and achievement rewards know a mount by its name, so it cannot be renamed. |
| Description | Required, up to 500 characters. |
| Icon | Picked from the icons the asset server has. Shown in the player's collectables window (K). |

The **When ridden** card says which sprite sheet the mount is drawn with, and whether the asset server has it.

## What a mount looks like

A mount is drawn with the sprite sheet `mount_<name in lower case>`, using the shared `player_mount_base` template. The sheet is a PNG in the asset server's `spritesheets/mounts` folder, named after the mount: `spritesheets/mounts/griffin.png` draws the mount `griffin`. See [Asset Paths](#/assets/asset-paths).

The editor does not upload sheets. Add the PNG to the asset server and restart it; until then, riding the mount shows nothing. The `particles` column of a mount is kept as it is when you save: nothing in the game draws it, so the editor does not show it.

## Giving a mount to players

The mount editor only makes mounts. Players get one:

- From the [Player Editor](#/tools/player-editor), with "Add mount"
- As the reward of an achievement, set in the [Achievement Editor](#/tools/achievement-editor)

## Deleting

Deleting a mount removes its row. Players who have it no longer see it in their collection from their next login: their collectables row stays, so a mount made later with the same name gives it back to them. Achievements that give it should be changed to give something else.

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `MOUNT_EDITOR_LIST` | Sends every mount, with its sprite sheet and whether the asset server has it, and the icons |
| Save | `MOUNT_EDITOR_SAVE` | Validates, then inserts or updates the `mounts` row and refreshes the mount cache |
| Delete | `MOUNT_EDITOR_DELETE` | Deletes the row and refreshes the mount cache |

Open is answered with `MOUNT_EDITOR_DATA`. Save and Delete are answered with `MOUNT_EDITOR_RESULT`, which carries the whole list as it then stands. A refused save names the fields that need fixing. After a successful change, every other online account that may use the editor receives `MOUNT_EDITOR_UPDATED`.

A saved mount is live at once. The login workers are handed the new list too, so a player logging in sees a new mount in their collection without a server restart.
