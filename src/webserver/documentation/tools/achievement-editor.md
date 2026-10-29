---
title: Achievement Editor
description: Make the achievements players earn, what counts toward each, and what each one gives.
order: 48
---

The achievement editor makes the achievements players earn. Type `/achievements` to open it in its own window; type it again to close it.

## Achievements

Each achievement counts one kind of deed. When a player's count reaches the number set, they earn it at once:

- A popup shows at the top centre of their screen for 5 seconds, with the icon, the name, the description and the reward. Its X closes it sooner. Several earned together show one after another.
- Their party sees "Name has completed [Achievement]" in party chat, and guild members who are not in the party see it in guild chat (no one sees it twice). The achievement is a green link: clicking it opens the reader's own achievements window at that achievement.
- The reward is given: an item into the bags, a mount into the collectables.

An achievement is earned once per player. Only what players do after an achievement exists counts: nothing done before is counted.

## Fields

| Field | What it does |
| --- | --- |
| Name | Shown in the popup and in the players' achievements window. Two achievements cannot share a name. Up to 100 characters. |
| Description | Shown under the name. Up to 500 characters. |
| Icon | Picked from the asset server's icons. |
| On | An achievement that is off is not counted and players do not see it. |
| Counts | What is counted. See the table below. |
| Creature, Quest, Item, Mount, Map or Spell | What exactly is counted. **Any** counts every one. Hidden for kinds that have no target. |
| How many | How many are needed, 1 to 1,000,000. For **Reach a level** the field is called **Level** and is the level to reach. |
| Item and Quantity | An item given when it is earned, 1 to 999 of it. If it does not fit in the bags it is mailed instead, from "Achievement Rewards", and the popup says so. A mailed reward cannot be sent back, and it is deleted with its items if not taken within 30 days. |
| Mount | A mount added to the player's collectables when it is earned. |

The server checks every field again when you save: the name is there, not taken and not too long, the description is not too long, the kind is known, the target exists, the number is 1 to 1,000,000, the item and the mount exist, and the quantity is 1 to 999.

## What can be counted

| Counts | Target | Counted when |
| --- | --- | --- |
| Kill creatures | A creature, or any | A player gets kill credit. Every party member who gets credit counts it |
| Kill players | None | A player kills another player |
| Die | None | A player dies, to anything |
| Complete quests | A quest, or any | A quest is turned in |
| Reach a level | None | A player reaches a level. The count is the level reached |
| Gather items | An item, or any | A gather succeeds. Counts how many were gathered |
| Loot items | An item, or any | Loot is picked up from the ground, or an item is taken from a creature's corpse. Counts how many. A corpse counts only the items actually added to the bags |
| Collect mounts | A mount, or any | A mount is added to the player's collectables. Only mounts count, not other collectables |
| Visit a map | A map (needed) | A player is moved to the map: a warp, a teleport, a summon or the home item |
| Cast spells | A spell, or any | A spell is cast |
| Complete trades | None | A trade completes. Both players count it |
| Add friends | None | A friend request is accepted. A friendship counts for both players: the one who asked and the one who accepts |
| Join or make a guild | None | A player joins or makes a guild |
| Ride a mount | A mount, or any | A player mounts |

Names are matched without regard to case. Guests are not counted.

Friends and guild joins that an admin sets in the player editor count too. A level set there counts only while the player is online.

## Changing and deleting

- Changing an achievement never takes it away from players who earned it.
- Changing what counts (the kind or the target) starts every player's progress toward it again.
- Changing only the number keeps progress made so far, compared with the new number on the next deed that counts.
- Turning an achievement off stops it counting and hides it from players. Turning it on again goes on from the progress kept.
- Deleting an achievement deletes every player's progress toward it. Rewards already given stay.
- When another admin saves or deletes an achievement, every open editor says so and shows the list as it is now.

## Players

Players open their achievements window with **Y** (on a touch screen, from the menu button). It lists every achievement that is on: earned ones with the date, the others with a progress bar such as "12 / 50", and each one's reward. It closes with its X, with **Y** or with **Esc**.

## Permission

`tools.achievement_editor`, or `tools.*`, `server.admin`, `server.*`, or the admin role. It is checked when the command is typed and on every request the editor sends.

## Storage

Achievements are kept in the `achievements` table and each player's progress in `player_achievements`. Both are made when the game server starts if they are missing. Progress is written on a regular timer, when the player leaves and when the game server shuts down; an achievement that was earned is written at once, with its reward, and is never lost. A completed achievement is never written twice, so its reward is never given twice.
