---
title: Class Editor
description: Create, edit and delete character classes: the stats a new character starts with and the spells it learns at each level.
order: 45
---

The class editor manages the rows of the `classes` table. A class is what a player picks on the character page when they make their character: its name and description, the stats a new character of it starts with, and the spells it learns, each at a level.

## Characters and classes

Each account has one character, named as the account is. Its class is kept in `accounts.class_id`.

| `class_id` | Meaning |
| --- | --- |
| `NULL` | No character yet |
| The id of a class | A character of that class |
| `0`, or the id of a deleted class | A character without a class (benchmark clients, or a class deleted later) |

While at least one class exists, an account without a character makes one before it plays:

1. After realm selection, the player goes to the character page at `/character` instead of the game. The page fills the screen, and behind it the view drifts slowly over the world's starting area: the realm's default map round its spawn, tiles only, with no players or creatures. The realm page draws that picture ahead while the player picks a realm, and the browser keeps it until the map changes.
2. They pick a class and select **Create**.
3. The game opens. Its level 1 spells are learned at that first login.

A game server also refuses a login without a character (packet `CHARACTER_REQUIRED`), which sends the client to the character page. With no class defined, accounts go straight into the game as before.

:::warning Making a character starts the account over
Accounts made before classes existed have no character either. Making one brings the account back to level 1 with the class's stats. Its items, equipment, bags, spells, quests, gold and home are removed, and it starts at the world's starting point. Its friends, ignores, permissions, mounts and sound settings stay. The character page says so first, and asks the player to confirm it.
:::

Nothing is written while the account is in the game: the page refuses until the player has left it.

## Opening it

```text title="Chat command"
/cle
/classeditor
```

The editor opens in its own window at route `/class-editor`. Typing the command again closes it.

## Permission

| Needs | What happens without it |
| --- | --- |
| Admin role, `tools.class_editor`, `tools.*`, `server.admin` or `server.*` | "You don't have permission to use this command" |

The permission is read from the database on every packet, so granting or removing it takes effect at once.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The side pane lists every class with its health, stamina and number of spells. The open class is split over three tabs, **General**, **Stats** and **Spells**, as the spell and item editors split theirs. **In plain words** beside every tab sums up what the class is in the game. A tab with a field that needs fixing shows how many.

### General

| Field | Notes |
| --- | --- |
| Name | Up to 45 characters, unique without regard to case. Shown on the character page. It can be renamed later: characters refer to their class by its id. |
| Description | Up to 500 characters. Shown when a player picks the class. |

### Stats

What a new character of the class starts with at level 1. These are starting values only: levelling works as it does for every character, and characters already made keep their stats when the class is changed.

| Field | Range | Meaning |
| --- | --- | --- |
| Health | 1 to 100000 | Starting health and maximum health |
| Stamina | 0 to 100000 | Starting stamina and maximum stamina |
| Damage | 0 to 10000 | Added to every hit and every damaging spell |
| Armor | 0 to 10000 | Taken away from the damage the character is dealt |
| Critical chance | 0 to 100 | Percent of hits that are critical |
| Critical damage | 0 to 1000 | Percent added to the damage of a critical hit |
| Avoidance | 0 to 100 | Percent of hits that miss the character |

### Spells

The spells the class learns, each at a level from 1 to 1000, up to 50 spells. Each spell is a card of its own with the spell, picked from the spell list with its icon, and the level it is learned at. **Add spell** adds a card with the next spell not yet in the list. A spell can be in the list once.

| When | What is learned |
| --- | --- |
| The character's first login | Every spell of level 1 |
| Reaching a level | The spells of that level, and any of lower levels it does not know |
| Every login | Spells of levels it already has that it does not know, such as a spell added to the class later |

A spell that has since been deleted in the [Spell Editor](#/tools/spell-editor) is passed over. Spells are made there first.

## Saving and deleting

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `CLASS_EDITOR_LIST` | Sends every class, the spells to pick from and the rules |
| Save | `CLASS_EDITOR_SAVE` | Checks the class, writes it, and answers with every class as it then stands |
| Delete | `CLASS_EDITOR_DELETE` | Removes the class |

Another open class editor is told to reload after every change (`CLASS_EDITOR_UPDATED`).

Deleting a class does not touch the characters of it. They keep their stats and spells and go on playing, but learn no more spells of it. New characters can no longer choose it. When the last class is deleted, accounts go straight into the game again.

Ctrl+S in the tool window saves the open class.
