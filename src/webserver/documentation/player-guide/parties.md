---
title: Parties
description: Team up with other players, share experience and loot, and stay together in the world.
order: 80
---

A party is a small group of players who play together. Party members cannot hurt each other, can heal each other, share what they earn from creatures, and have a private chat channel.

:::note
Parties need a full account. Guests cannot invite or be invited.
:::

## Inviting players

There are two ways to invite someone:

- **Right-click** the player and choose **Invite to Party**. On a touch screen, hold your finger on the player to open the same menu.
- Type the invite command with their name. The player has to be online.

```text title="Invite by name"
/invite Aria
```

The other player sees an **Invitation** window with your name. You get the message "Invitation sent to" followed by their name.

Rules for invitations:

- If you are not in a party yet, the first player who accepts forms a new party with you, and you become the leader.
- Once a party exists, only the leader can invite more players.
- You cannot invite a player who is already in a party.
- A party holds 5 players. When a sixth accepts, the leader is asked to convert the party into a raid group (see [Raid groups](#/player-guide/parties/raid-groups)). A raid group holds up to 20 players, and a player cannot join one that is full: "The party is full".

## Accepting or declining

When someone invites you, an **Invitation** window appears with two buttons:

| Button | Result |
|--------|--------|
| Accept | You join the party. Everyone's party frames update. |
| Decline | Nothing changes |

## Party frames

While you are in a party, a frame for every member is shown on your screen. Each frame shows the member's name, health and mana, and whether they are online, so you can see at a glance who needs help.

## Leaving a party

**Right-click** your own party frame and choose **Leave Party**. On a touch screen, tap your frame.

- When a member leaves, the others see a message and the party carries on.
- When the **leader** leaves, the next member in the list becomes the leader and the party carries on.
- A party needs at least two players. If only one would be left, the party is disbanded.

## Leader actions

The leader is the player who started the party.

| Action | How |
|--------|-----|
| Invite more players | Use the player menu or `/invite` |
| Remove a member | **Right-click** the member's party frame and choose **Kick**. On a touch screen, tap the frame. |
| Pass the lead | Leave the party. The next member becomes the leader. |

A kicked player is told they were removed, and the rest of the party is told who was kicked.

## Raid groups

A party holds 5 players. When a sixth player accepts an invitation, the leader gets a **Party full** window asking whether to convert the party into a raid group. It has two buttons:

| Button | Result |
|--------|--------|
| Convert | The party becomes a raid group and the sixth player joins it |
| Cancel | Nothing changes, and the player is told "The party is full" |

The window closes after 60 seconds. If the leader does not answer in that time, the player is told "The party is full". Only the leader can convert. A raid group holds up to 20 players.

A raid group is what a [raid](#/player-guide/dungeons) needs to go beyond 5 players. Everything else in this page applies to a raid group as it does to a party.

## Summoning stones

A summoning stone is a carved stone with glowing runes, found outside dungeons. Two members of a party at the stone can summon a third member of their party to it, even from another map.

1. **The first member targets who to summon and touches the stone.** Target a party member by clicking their frame in the party list, or by clicking them in the world. Then stand still and click or tap the stone within 150 pixels of its foot; touching it keeps your target. Touching it while walking tells you "You must stand still to use that." From farther away you are told "Move closer to the summoning stone." You must be in a party. With nobody targeted you are told "Target a party member to summon."; a target already at the stone, or not in your party, is refused.
2. **The summoner casts for 30 seconds while a second member touches the stone.** A **Summoning** cast bar runs for the summoner, who is shown casting. Moving or pressing Esc cancels it, and the summoner is told "The summon was cancelled." The second member must be in the summoner's party, and not the one being summoned. If nobody touches it in time, the summoner is told "Nobody else touched the summoning stone in time."
3. **Both cast for 5 seconds.** The two who touched the stone are shown casting, with a cast bar. It is cancelled, and both are told "The summon was cancelled.", if either of them moves or presses Esc, dies, disconnects or leaves the party, or if the player being summoned leaves the party.
4. **The summoned player is asked.** A **Summon** window asks whether to come, and they have 60 seconds to answer. If they accept, they are moved to the stone and stand just in front of it, facing down. If they decline or do not answer, nobody is moved; the summoner is told when they decline or do not answer.

Some players cannot be summoned. The summoner is told why:

| Player | Message |
|--------|---------|
| Dead, or a spirit | "*Name* is dead." |
| Inside a dungeon | "*Name* is inside a dungeon." |
| Offline | "*Name* is not online." |
| Already being summoned at another stone | "*Name* is already being summoned." |
| In a cutscene when they accept | "*Name* is in a cutscene." |

A stone runs one summon at a time. While it is in use, anyone else who touches it is told "This summoning stone is already in use."

## Party chat

Send a message to everyone in your party, wherever they are:

```text title="Party chat"
/p Meet at the bridge
```

Type `/p` and press **Space** to keep the chat box in party mode. See [Chat and Commands](#/player-guide/chat-and-commands) for more.

## What being in a party changes

### You stay together

On a busy realm, an area can be split into several copies so it does not get overcrowded. Party members are always brought into the same copy as their leader, so you can see and help each other.

### No friendly fire

- You cannot attack your party members. Harmful spells are refused, and your area damage passes them by.
- Heals and other helpful spells work on party members. Area heals reach you and your party only.
- If you vanish, your party members can still see you.

### Shared rewards from creatures

When your party defeats a creature, everyone who is close to it takes part in the reward:

| Reward | How it is shared |
|--------|------------------|
| Experience | Split between the members nearby, with higher level members getting a larger share. Groups of 3 or more earn bonus experience. The kill is valued by the highest level member, so a much stronger friend can lower what a weak creature is worth. |
| Quest credit | Every member nearby gets kill credit for their own quests |
| Items | The right to loot the body passes from member to member, one kill at a time |
| Coins | Split evenly between the members nearby when the body is looted |

:::tip Stay close
Members who are far away from the fight, or who are ghosts, get nothing from that kill. Stick together.
:::

A creature your party is fighting counts as claimed for the whole party. See [Combat and Spells](#/player-guide/combat-and-spells) for how claiming works.
