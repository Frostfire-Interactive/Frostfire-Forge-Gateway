---
title: Guilds
description: Create a guild, invite members, set up ranks, chat together, and learn what the Guild Master can do.
order: 90
---

A guild is a lasting group of players with its own name, member list and chat channel.

Press **G** to open the guild window.

:::note
Guilds need a full account. Guests cannot create or join a guild.
:::

## Creating a guild

If you are not in a guild, the guild window shows **Create Guild**.

1. Press **G**.
2. Type a name into **Guild Name**.
3. Select **Create**.

You see a message that your guild was created, and you become its **Guild Master**.

Rules:

- The name must not be used by another guild. Otherwise you see "A guild with that name already exists".
- You can only be in one guild at a time. Leave your current guild before you create a new one.

## Ranks

Every member of a guild holds a rank. Your rank is shown at the top of the guild window. A new guild starts with five ranks:

| Rank | What they can do |
|------|------------------|
| Guild Master | Everything. Only one player holds this rank: the one who created the guild, until they hand it over. |
| Officer | Everything except being Guild Master |
| Veteran | Use guild chat and invite players |
| Member | Use guild chat |
| Initiate | Use guild chat |

Players who join the guild start at the lowest rank.

### Permissions

Each rank is a set of permissions. These are the permissions a rank can have:

| Permission | What it allows |
|------------|----------------|
| Hear guild chat | See what is said in guild chat |
| Talk in guild chat | Send messages to guild chat |
| Hear officer chat | See what is said in officer chat |
| Talk in officer chat | Send messages to officer chat |
| Invite | Invite players to the guild |
| Kick | Remove members from the guild |
| Promote | Move members up a rank |
| Demote | Move members down a rank |
| Set MOTD | Change the message of the day |
| Edit public notes | Change other members' public notes |
| See officer notes | Read the officer note of a member |
| Edit officer notes | Change the officer note of a member |

### Acting on other members

You can only kick, promote, demote or edit the notes of members who are below your rank. You cannot do these to someone of your own rank or above.

- **Promote** moves a member up one rank. It never moves them to your own rank or above.
- **Demote** moves a member down one rank.
- **Kick** removes a member from the guild, and they are told. Click the member in the guild window and select **Kick**, or type the command below.
- Only the Guild Master can make a new Guild Master, with **Make Leader** or `/gleader`. The old Guild Master becomes an Officer.

```text title="Remove a member"
/gremove Aria
```

## Inviting players

You need a rank that may invite. There are three ways:

| Way | How |
|-----|-----|
| Guild window | Type the player's name into **Player Name** and select **Invite**. This works for players who are near you. |
| Player menu | **Right-click** the player and choose **Invite to Guild**. On a touch screen, hold your finger on the player. |
| Command | Type the command below. This works for any online player. |

```text title="Invite to your guild"
/ginvite Aria
```

The player gets an **Invitation** window with your guild's name and can choose **Accept** or **Decline**.

A player who is already in a guild cannot be invited. You see a message that they are already in a guild.

## The member list

The guild window shows the guild name, your rank, the message of the day, the number of members, and every member, highest rank first and by name within a rank. A marker next to each name shows whether that member is online.

Click a member to open their panel. It shows their rank and their public note, and their officer note if your rank may see it. The buttons **Promote**, **Demote**, **Kick**, **Make Leader** and **Save** only appear when you are allowed to use them on that member.

## Notes

Every member has a public note, and an officer note that only some ranks can see.

- Everyone can edit their own public note. Editing other members' public notes needs **Edit public notes**.
- Officer notes need **See officer notes** to read and **Edit officer notes** to change. This applies to your own officer note too.
- A note can be up to 31 characters long.
- Text with blocked words is refused.

Select **Save** in the member panel to keep your changes.

## Message of the day

The message of the day (MOTD) is shown in the guild window and in guild chat when you log in. A rank with **Set MOTD** sees an **Edit** button beside it. You can also type the command below.

```text title="Set the message of the day"
/gmotd Raid at eight
```

The message can be up to 128 characters long. Text with blocked words is refused.

## Guild chat

Guild chat reaches every online member who may hear it, wherever they are in the world.

```text title="Guild chat"
/g Anyone up for a quest?
```

Type `/g` and press **Space** to keep the chat box in guild mode. See [Chat and Commands](#/player-guide/chat-and-commands) for more.

## Officer chat

Officer chat is a second guild channel, shown in green. Only members whose rank has **Hear officer chat** receive it, and only ranks with **Talk in officer chat** can send to it.

```text title="Officer chat"
/o Raid plan is up
```

You can also type `/officer`. Type `/o` and press **Space** to keep the chat box in officer mode.

## Leaving a guild

Unless you are the **Guild Master**, open the guild window and select **Leave Guild**. You can also right-click your own name in the member list and choose **Leave Guild**.

The **Guild Master** cannot leave the guild. If you try, you see "You cannot leave your own guild." The Guild Master can hand the guild to someone else, or disband it.

## Editing ranks

The Guild Master can change the ranks of the guild. Select **Ranks** in the guild window. Other members do not see this button.

1. Select a rank in the list.
2. Rename it if you like.
3. Tick the permissions it should have.
4. Select **Save**.

| Button | What it does |
|--------|--------------|
| Add | Adds a new rank at the bottom of the list |
| Delete | Removes the lowest rank. It only works once nobody holds that rank. |

A guild has at least 2 and at most 8 ranks. The Guild Master rank can be renamed, but its permissions cannot be changed: it always has every permission.

## Guild Master actions

### Handing over the guild

Click the member in the guild window and select **Make Leader**, or type the command below. The member becomes Guild Master, and you become an Officer.

```text title="Make another member Guild Master"
/gleader Aria
```

### Disband the guild

For the Guild Master, the leave button in the guild window reads **Disband Guild**.

1. Select **Disband Guild**.
2. Confirm in the window that appears.

Every member is removed and told that the guild has been disbanded.

:::warning
Disbanding cannot be undone. The guild and its member list are gone for good.
:::
