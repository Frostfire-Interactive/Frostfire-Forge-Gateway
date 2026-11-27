---
title: Game Settings
description: Change the game-wide values staff can tune: the XP curve, max health and stamina, speeds, regen, mail and trade limits, chat limits, party sizes, loot and corpse times, respawn and weather.
order: 125
---

The game settings editor changes values that apply to the whole game, from inside the game. Every setting starts at the value the game always used, so nothing changes until you save one. Resetting a setting puts its default back.

## Opening it

```text title="Chat command"
/gs
/gamesettings
```

The editor opens in its own window at route `/game-settings`. Typing the command again closes it. The staff bar has a Game Settings button that sends `/gs` for you.

## Permission

Any one of these lets you in:

- The admin role
- `tools.gamesettings` or `tools.*`
- `server.admin` or `server.*`

They are read from the permissions copied to you at login, and checked again on every packet the editor sends. A refused packet answers "You don't have permission to use the game settings editor."

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench). The side pane lists the sections, with the search field filtering them as you type. A section with unsaved changes is tagged **Unsaved**. Pick a section to see its settings on the right.

Each setting shows its name, a line saying when the change applies, the value, and `Default: X` with a **Reset** button. Reset is off while the setting holds its default. A setting someone has changed also says who set it.

**Save** saves every changed setting of the open section. They are sent one at a time, in the order shown, and the first one the server refuses stops the rest. The refused setting shows the server's reason under it. The ones saved before it stay saved. Changes you have not saved are kept when you pick another section, and when another admin saves a setting and the list reloads.

## Sections and values

The ranges below are what the server accepts. The window's own checks are only a convenience; the server decides.

### Progression

| Setting | Default | Notes |
| --- | --- | --- |
| XP to next level | `floor(100 * 1.1 ^ (level - 1))` | Formula |
| Max health | `100 + level ^ 1.5 * 5` | Formula |
| Max stamina | `100 + level ^ 1.5 * 3` | Formula |
| Level cap | 0 (no cap) | Whole number, 0 for no cap |

### Movement

| Setting | Default | Range |
| --- | --- | --- |
| Walk speed (px/s) | 180 | 30 to 900 |
| Mount speed multiplier | 1.35 | 1 to 5 |
| Ghost speed multiplier | 1.35 | 0.5 to 5 |

Walk speed times the larger of the mount and ghost multipliers must be at most 900 px/s (30 px a tick), so a step cannot pass through a wall.

### Combat and regen

| Setting | Default | Range |
| --- | --- | --- |
| Health regen (% per tick) | 1 | 0 to 100 |
| Stamina regen (% per tick) | 5 | 0 to 100 |
| Combat flag (seconds) | 5 | 0 to 600 |
| Resurrection sickness (minutes) | 15 | 0 to 240 |
| Sickness health multiplier | 0.8 | 0.1 to 1 |
| Sickness stat multiplier | 0.9 | 0.1 to 1 |
| Instant spell time (seconds) | 1.5 | 0.5 to 10 |
| Critical heal multiplier | 1.5 | 1 to 10 |

The instant spell time is not a cooldown and does not space casts apart. It is the cast time an instant spell counts as when its bonus from stats is worked out: a spell scales with max(this, its cast time) / 3.5.

### Inventory and economy

All are whole numbers.

| Setting | Default | Range |
| --- | --- | --- |
| Mailbox reach (px) | 120 | 1 to 1200 |
| Items per mail | 12 | 1 to 120 |
| Mailbox size | 100 | 1 to 1000 |
| Mail subject length | 64 | 1 to 64 |
| Mail body length | 500 | 1 to 5000 |
| Postage (copper) | 30 | 0 to 300 |
| Mail lifetime (days) | 30 | 1 to 300 |
| Trade reach (px) | 120 | 1 to 1200 |
| Items per trade side | 8 | 1 to 80 |
| Trade accept delay (ms) | 2000 | 0 to 20000 |

### Social and chat

All are whole numbers.

| Setting | Default | Range |
| --- | --- | --- |
| Chat message length | 500 | 50 to 2000 |
| Chat messages per window | 5 | 1 to 100 |
| Chat rate window (ms) | 3000 | 100 to 60000 |
| Party size | 5 | 2 to 40 |
| Raid size | 20 | 2 to 200 |

Raid size cannot be below the party size, and party size cannot be above the raid size. To raise both, save the raid size first.

### Loot and corpses

| Setting | Default | Range |
| --- | --- | --- |
| Loot pickup radius (px) | 100 | 10 to 1000 |
| Ground loot lifetime (minutes) | 30 | 1 to 1440 |
| Corpse with loot (seconds) | 300 | 10 to 3600 |
| Empty corpse (seconds) | 60 | 10 to 3600 |
| Respawn time multiplier | The creatures' configured multiplier, 1 unless set | 0.05 to 20 |

### World

| Setting | Default | Range |
| --- | --- | --- |
| Weather cycle (minutes) | 30 | 1 to 1440, whole number |

## Formulas

XP to next level, max health and max stamina are formulas in `level`. A formula is text of at most 200 characters, worked out for a character's level.

- The variable is `level`.
- Numbers may have a decimal point.
- Operators: `+`, `-`, `*`, `/`, `%` and `^` (power), with brackets.
- Functions: `min`, `max`, `pow`, `floor`, `ceil`, `round`, `abs`, `sqrt`, `log` and `exp`. `min` and `max` take any number of values.

```text title="Examples"
floor(100 * 1.1 ^ (level - 1))
100 + level ^ 1.5 * 5
max(50, round(sqrt(level) * 40))
```

The result is rounded down. The server checks a formula at every level from 1 to the top a character can reach. With a level cap, that is every level up to the cap. With no level cap, the XP formula is checked to be finite at every level up to 1000, and to fit up to level 178, where the default curve's target stops fitting; a steeper curve with no level cap is refused. Max health and max stamina are checked up to the larger of 1000 and the highest level the XP curve lets a character reach (at most 100000). At each level the result must be a finite number inside the setting's range: at least 1, and no more than 2147483647, the largest value the stats table holds. A max health or max stamina value above that limit is held at it in play.

Under each formula a table shows its values for levels 1 to 20, and for the level cap when it is higher. It follows what you type, a moment after the last key. A formula the server cannot use shows its reason under the field instead of a table, and nothing is saved by looking.

### The XP curve and the level cap

- With a level cap, the XP curve is checked at every level up to the cap. The cap itself cannot be higher than the last level whose XP target fits.
- With no level cap, levelling stops at the last level whose XP target still fits in the stats table, which is level 178 for the default curve. A character there shows a full XP bar and cannot go higher. A steeper curve is refused unless a level cap is set.
- The same check applies whichever way a value is saved: a level cap is held to the XP curve in force, and an XP curve to the cap in force.
- Turning the cap off (0) is allowed only when the XP curve fits without a cap.
- Resetting a setting is refused if its default would not hold with the other values. The reason starts "The default would not hold:".

## When changes apply

A saved value is live at once on the game server, and each setting takes effect where it is next used.

| Setting | Applies |
| --- | --- |
| XP to next level, max health, max stamina | At each character's next level-up |
| Level cap | From the next XP gain |
| Walk, mount and ghost speed | After the current walk, from the next step |
| Party size and raid size | On new joins and invites |
| Respawn time multiplier | On the next respawn schedule |
| Resurrection sickness settings | On the next death |
| Every other setting | From its next use, as the line under it says |

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `GAME_SETTINGS_EDITOR_LIST` | Sends every section and setting, with its value, default, range and whether it is changed |
| Save | `GAME_SETTINGS_EDITOR_SAVE` | Validates one setting and stores it, with your name and the time |
| Reset | `GAME_SETTINGS_EDITOR_RESET` | Removes the stored value so the default applies again |
| Formula table | `GAME_SETTINGS_EDITOR_PREVIEW` | Checks a formula and answers with its values; saves nothing |

Open is answered with `GAME_SETTINGS_EDITOR_DATA`. Save, Reset and the formula table are answered with `GAME_SETTINGS_EDITOR_RESULT`. A refused save names the setting that needs fixing. After a successful change, every other online account that may use the editor receives `GAME_SETTINGS_EDITOR_UPDATED` and its list reloads.
