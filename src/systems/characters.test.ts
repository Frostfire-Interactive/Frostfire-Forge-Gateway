// USER REQUEST 2026-10-14: the character page's API (systems/characters.ts), against a real SQLite database in memory,
// through the same transaction code the database worker runs. Characters are keyed by id: status(accountId, characterId)
// and create(accountId, characterId, classId); the account's own row holds only the account.
import { beforeEach, expect, mock, test } from "bun:test";
import { SQL } from "bun";
import { GuardError, runTransaction } from "../controllers/sqltransaction";
import { sqlWrapper } from "../controllers/sqlescape";

let db: any;

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, values: any[] = []) => db.unsafe(sqlWrapper(sql, values, "sqlite")),
  transaction: async (statements: any[]) => runTransaction(db, statements, "sqlite"),
  GuardError,
}));

const { default: characters } = await import("./characters");

const MAGE = { name: "Mage", description: "Casts.", max_health: 80, max_stamina: 150, stat_damage: 3, stat_armor: 1, stat_critical_chance: 12, stat_critical_damage: 40, stat_avoidance: 5, spells: '[{"spell":"frost_bolt","level":1},{"spell":"blink","level":4}]', items: '[{"item":"Wooden_Staff","quantity":1},{"item":"health_potion","quantity":5},{"item":"gone_item","quantity":2}]' };

// ids: account 1 = veteran (character 1), account 2 = newbie (character 2), character 3 = veteran's second character
const VETERAN = { account: 1, character: 1 };
const NEWBIE = { account: 2, character: 2 };
const VETERAN_TWO = 3;

beforeEach(async () => {
  db = new SQL({ adapter: "sqlite", filename: ":memory:" });
  for (const sql of [
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, guest_mode INTEGER DEFAULT 0, online INTEGER DEFAULT 0, active_character_id INTEGER DEFAULT NULL)",
    "CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, class_id INTEGER DEFAULT NULL, map TEXT, position TEXT, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER, created_at INTEGER DEFAULT 0, deleted_at INTEGER DEFAULT NULL)",
    "CREATE TABLE guilds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, leader TEXT, leader_id INTEGER)",
    "CREATE TABLE guild_members (character_id INTEGER, guild_id INTEGER, rank_index INTEGER)",
    "CREATE TABLE ignores (character_id INTEGER, ignored TEXT, created_at INTEGER)",
    "CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT, max_health INTEGER, max_stamina INTEGER, stat_damage INTEGER, stat_armor INTEGER, stat_critical_chance INTEGER, stat_critical_damage INTEGER, stat_avoidance INTEGER, spells TEXT, items TEXT)",
    "CREATE TABLE stats (username TEXT, character_id INTEGER UNIQUE, health INTEGER, max_health INTEGER, stamina INTEGER, max_stamina INTEGER, xp INTEGER, max_xp INTEGER, level INTEGER, stat_critical_damage INTEGER DEFAULT 0, stat_critical_chance INTEGER DEFAULT 0, stat_armor INTEGER DEFAULT 0, stat_damage INTEGER DEFAULT 0, stat_health INTEGER DEFAULT 0, stat_stamina INTEGER DEFAULT 0, stat_avoidance INTEGER DEFAULT 0)",
    "CREATE TABLE inventory (username TEXT, character_id INTEGER, item TEXT, quantity INTEGER DEFAULT 1)",
    "CREATE TABLE items (name TEXT, description TEXT, icon TEXT)",
    "CREATE TABLE bags (username TEXT, character_id INTEGER UNIQUE, slot_1 TEXT)",
    "CREATE TABLE equipment (username TEXT, character_id INTEGER UNIQUE, head TEXT, weapon TEXT)",
    "CREATE TABLE learned_spells (username TEXT, character_id INTEGER, spell TEXT)",
    "CREATE TABLE quest_log (username TEXT, character_id INTEGER, quest_id INTEGER)",
    "CREATE TABLE quest_objective_progress (username TEXT, character_id INTEGER, quest_id INTEGER, objective_id INTEGER, count INTEGER)",
    "CREATE TABLE currency (username TEXT, character_id INTEGER UNIQUE, copper INTEGER, silver INTEGER, gold INTEGER)",
    "CREATE TABLE player_home (username TEXT, character_id INTEGER UNIQUE, npc_id INTEGER)",
    "CREATE TABLE clientconfig (username TEXT, character_id INTEGER UNIQUE, hotbar_config TEXT, inventory_config TEXT, music_volume INTEGER, fps INTEGER, effects_volume INTEGER, ambience_volume INTEGER, weather_volume INTEGER)",
    "CREATE TABLE collectables (username TEXT, character_id INTEGER, type TEXT, item TEXT)",
    "CREATE TABLE friendslist (username TEXT, character_id INTEGER, friends TEXT)",
    "CREATE TABLE spells (name TEXT, description TEXT, icon TEXT)",
  ]) await db.unsafe(sql);
  await db.unsafe("INSERT INTO spells VALUES ('frost_bolt', 'A bolt of ice.', 'frost_bolt.png'), ('blink', 'Jump ahead.', NULL), ('other', 'Not a class spell.', NULL)");
  await db.unsafe("INSERT INTO items VALUES ('wooden_staff', 'A plain staff.', 'staff.png'), ('health_potion', 'Heals.', NULL)");
  // a player of some standing from before classes: account 1, character 1
  await db.unsafe("INSERT INTO accounts (username, active_character_id) VALUES ('veteran', 1), ('newbie', 2)");
  await db.unsafe("INSERT INTO characters (account_id, name, name_key, map, position, is_dead, corpse_map) VALUES (1, 'veteran', 'veteran', 'forest', '120,80', 1, 'forest')");
  await db.unsafe("INSERT INTO characters (account_id, name, name_key, map, position) VALUES (2, 'newbie', 'newbie', '', '0,0')");
  await db.unsafe("INSERT INTO characters (account_id, name, name_key, map, position) VALUES (1, 'Veteran Alt', 'veteran alt', '', '0,0')");
  await db.unsafe("INSERT INTO stats (character_id, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_damage) VALUES (1, 300, 300, 200, 200, 50, 900, 12, 40)");
  await db.unsafe("INSERT INTO inventory (character_id, item) VALUES (1, 'sword'), (1, 'potion')");
  await db.unsafe("INSERT INTO bags VALUES (NULL, 1, 'big_bag')");
  await db.unsafe("INSERT INTO equipment VALUES (NULL, 1, 'cap', 'sword')");
  await db.unsafe("INSERT INTO learned_spells VALUES (NULL, 1, 'other')");
  await db.unsafe("INSERT INTO quest_log VALUES (NULL, 1, 3)");
  await db.unsafe("INSERT INTO quest_objective_progress VALUES (NULL, 1, 3, 1, 4)");
  await db.unsafe("INSERT INTO currency VALUES (NULL, 1, 5, 6, 7)");
  await db.unsafe("INSERT INTO player_home VALUES (NULL, 1, -5)");
  await db.unsafe("INSERT INTO clientconfig VALUES (NULL, 1, '{\"1\":\"other\"}', '{\"0\":\"sword\"}', 40, 60, 30, 50, 60)");
  await db.unsafe("INSERT INTO collectables VALUES (NULL, 1, 'mount', 'horse')");
  await db.unsafe("INSERT INTO friendslist VALUES (NULL, 1, 'pal')");
  // a new account: character 2, and the veteran's second character 3, both with one row of stats
  await db.unsafe("INSERT INTO stats (character_id, health, max_health, stamina, max_stamina, xp, max_xp, level) VALUES (2, 100, 100, 100, 100, 0, 100, 1), (3, 100, 100, 100, 100, 0, 100, 1)");
  await db.unsafe("INSERT INTO inventory (character_id, item) VALUES (3, 'alt_item')");
});

const addMage = async () => {
  await db.unsafe(sqlWrapper("INSERT INTO classes (name, description, max_health, max_stamina, stat_damage, stat_armor, stat_critical_chance, stat_critical_damage, stat_avoidance, spells, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [MAGE.name, MAGE.description, MAGE.max_health, MAGE.max_stamina, MAGE.stat_damage, MAGE.stat_armor, MAGE.stat_critical_chance, MAGE.stat_critical_damage, MAGE.stat_avoidance, MAGE.spells, MAGE.items], "sqlite"));
  return Number((await db.unsafe("SELECT id FROM classes WHERE name = 'Mage'"))[0].id);
};

const one = async (sql: string) => (await db.unsafe(sql))[0];

test("no class defined: nobody is asked for a character", async () => {
  expect(await characters.status(NEWBIE.account, NEWBIE.character)).toMatchObject({ needed: false, classes: [] });
});

test("with a class: a character without one is asked for it, and told when it starts over", async () => {
  await addMage();
  const fresh = await characters.status(NEWBIE.account, NEWBIE.character);
  expect(fresh).toMatchObject({ needed: true, startsOver: false, username: "newbie" });
  expect(fresh.classes[0]).toMatchObject({ name: "Mage", stats: { max_health: 80, stat_avoidance: 5 }, spells: [{ spell: "frost_bolt", level: 1 }, { spell: "blink", level: 4 }] });
  expect(fresh.spellInfo).toEqual({ frost_bolt: { description: "A bolt of ice.", icon: "frost_bolt.png" }, blink: { description: "Jump ahead.", icon: null } });
  expect(fresh.classes[0]!.items).toEqual([{ item: "Wooden_Staff", quantity: 1 }, { item: "health_potion", quantity: 5 }, { item: "gone_item", quantity: 2 }]);
  expect(fresh.itemInfo).toEqual({ Wooden_Staff: { description: "A plain staff.", icon: "staff.png" }, health_potion: { description: "Heals.", icon: null } });
  expect((await characters.status(VETERAN.account, VETERAN.character)).startsOver).toBe(true);
});

test("status answers about the named character of the account, and about no other account's", async () => {
  await addMage();
  // the veteran's second character has an item, so it starts over; the first one's level does too
  expect(await characters.status(VETERAN.account, VETERAN_TWO)).toMatchObject({ needed: true, startsOver: true, username: "Veteran Alt" });
  // a character of another account is not this account's: nothing is told of it (no name, no classes)
  expect(await characters.status(NEWBIE.account, VETERAN.character)).toMatchObject({ needed: false, classes: [], username: "" });
  await db.unsafe("UPDATE characters SET class_id = 99 WHERE id = 2");
  expect(await characters.status(NEWBIE.account, NEWBIE.character)).toMatchObject({ needed: false });
  // a deleted character is not asked for
  await db.unsafe("UPDATE characters SET deleted_at = 1 WHERE id = 3");
  expect(await characters.status(VETERAN.account, VETERAN_TWO)).toMatchObject({ needed: false });
});

test("making the character starts it over with the class's stats, keeps what is not the character, and touches no other", async () => {
  const id = await addMage();
  expect(await characters.create(VETERAN.account, VETERAN.character, id)).toEqual({ ok: true, className: "Mage" });

  expect(await one("SELECT class_id, map, position, is_dead, corpse_map FROM characters WHERE id = 1")).toEqual({ class_id: id, map: "", position: "0,0", is_dead: 0, corpse_map: null });
  expect(await one("SELECT health, max_health, stamina, max_stamina, xp, max_xp, level, stat_damage, stat_armor, stat_critical_chance, stat_critical_damage, stat_avoidance FROM stats WHERE character_id = 1"))
    .toEqual({ health: 80, max_health: 80, stamina: 150, max_stamina: 150, xp: 0, max_xp: 100, level: 1, stat_damage: 3, stat_armor: 1, stat_critical_chance: 12, stat_critical_damage: 40, stat_avoidance: 5 });
  // the class's starter items, under the items table's names; one no longer there is passed over
  expect(await db.unsafe("SELECT item, quantity FROM inventory WHERE character_id = 1 ORDER BY item")).toEqual([{ item: "health_potion", quantity: 5 }, { item: "wooden_staff", quantity: 1 }]);
  for (const table of ["bags", "learned_spells", "quest_log", "quest_objective_progress", "player_home"]) {
    expect(`${table}: ${(await db.unsafe(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = 1`))[0].n}`).toBe(`${table}: 0`);
  }
  expect(await one("SELECT head, weapon FROM equipment WHERE character_id = 1")).toEqual({ head: null, weapon: null });
  expect(await one("SELECT copper, silver, gold FROM currency WHERE character_id = 1")).toEqual({ copper: 0, silver: 0, gold: 0 });
  expect(await one("SELECT hotbar_config, inventory_config, music_volume FROM clientconfig WHERE character_id = 1")).toEqual({ hotbar_config: null, inventory_config: null, music_volume: 40 });
  expect(await one("SELECT item FROM collectables WHERE character_id = 1")).toEqual({ item: "horse" });
  expect(await one("SELECT friends FROM friendslist WHERE character_id = 1")).toEqual({ friends: "pal" });
  // nothing is keyed by name
  expect(await one("SELECT COUNT(*) AS n FROM stats WHERE username IS NOT NULL")).toEqual({ n: 0 });
  expect(await one("SELECT COUNT(*) AS n FROM inventory WHERE username IS NOT NULL")).toEqual({ n: 0 });

  // the account's other character, and another account's, are untouched
  expect(await one("SELECT class_id FROM characters WHERE id = 3")).toEqual({ class_id: null });
  expect(await one("SELECT level FROM stats WHERE character_id = 3")).toEqual({ level: 1 });
  expect(await one("SELECT item FROM inventory WHERE character_id = 3")).toEqual({ item: "alt_item" });
  expect(await one("SELECT class_id FROM characters WHERE id = 2")).toEqual({ class_id: null });

  // one class pick per character
  expect(await characters.create(VETERAN.account, VETERAN.character, id)).toMatchObject({ ok: false, status: 409 });
  expect((await characters.status(VETERAN.account, VETERAN.character)).needed).toBe(false);
  // but the account's second character can still pick its own
  expect(await characters.create(VETERAN.account, VETERAN_TWO, id)).toEqual({ ok: true, className: "Mage" });
  expect(await one("SELECT class_id FROM characters WHERE id = 3")).toEqual({ class_id: id });
});

test("a character of another account cannot be given a class", async () => {
  const id = await addMage();
  expect(await characters.create(NEWBIE.account, VETERAN.character, id)).toMatchObject({ ok: false, status: 404 });
  expect(await one("SELECT class_id, map FROM characters WHERE id = 1")).toEqual({ class_id: null, map: "forest" });
  expect(await one("SELECT level FROM stats WHERE character_id = 1")).toEqual({ level: 12 });
  expect(await characters.create(NEWBIE.account, 9999, id)).toMatchObject({ ok: false, status: 404 });
});

test("nothing is made for a class that is gone, an account in the game, or twice at once", async () => {
  const id = await addMage();
  expect(await characters.create(NEWBIE.account, NEWBIE.character, id + 1)).toMatchObject({ ok: false, status: 409 });
  expect(await characters.create(NEWBIE.account, NEWBIE.character, "x")).toMatchObject({ ok: false, status: 400 });

  await db.unsafe("UPDATE accounts SET online = 1 WHERE username = 'newbie'");
  expect(await characters.create(NEWBIE.account, NEWBIE.character, id)).toMatchObject({ ok: false, status: 409 });
  expect((await db.unsafe("SELECT class_id FROM characters WHERE id = 2"))[0].class_id).toBeNull();
  await db.unsafe("UPDATE accounts SET online = 0 WHERE username = 'newbie'");

  const both = await Promise.all([characters.create(NEWBIE.account, NEWBIE.character, id), characters.create(NEWBIE.account, NEWBIE.character, id)]);
  expect(both.filter((r) => r.ok)).toHaveLength(1);
  expect((await db.unsafe("SELECT COUNT(*) AS n FROM stats WHERE character_id = 2"))[0].n).toBe(1);
});

test("activeOf finds an account's id and active character from its name, and nothing else", async () => {
  expect(await characters.activeOf("veteran")).toEqual({ accountId: 1, characterId: 1 });
  await db.unsafe("UPDATE accounts SET active_character_id = NULL WHERE username = 'newbie'");
  expect(await characters.activeOf("newbie")).toEqual({ accountId: 2, characterId: null });
  expect(await characters.activeOf("nobody")).toBeNull();
});

// Multiple characters per account: the list, making one, playing one, deleting one.

test("list shows the account's own characters with class and level, not deleted ones", async () => {
  const id = await addMage();
  await db.unsafe(`UPDATE characters SET class_id = ${id} WHERE id = 3`);
  await db.unsafe("INSERT INTO characters (account_id, name, name_key, deleted_at) VALUES (1, 'Gone', 'gone', 5)");
  const list = await characters.list(VETERAN.account);
  expect(list.characters).toEqual([
    { id: 1, name: "veteran", classId: null, className: null, level: 12 },
    { id: 3, name: "Veteran Alt", classId: id, className: "Mage", level: 1 },
  ]);
  expect(list.classes.map((c) => c.name)).toEqual(["Mage"]);
  expect(list.spellInfo.frost_bolt).toBeDefined();
});

test("add makes a character with the class's starting rows", async () => {
  const id = await addMage();
  const made = await characters.add(NEWBIE.account, "Aria_2", id, 5);
  expect(made).toMatchObject({ ok: true });
  const row = await one("SELECT id, account_id, name, name_key, class_id FROM characters WHERE name_key = 'aria_2'");
  expect(row).toMatchObject({ account_id: 2, name: "Aria_2", class_id: id });
  expect(made.ok && made.id).toBe(row.id);
  expect(await one(`SELECT level, max_health FROM stats WHERE character_id = ${row.id}`)).toEqual({ level: 1, max_health: 80 });
  expect((await db.unsafe(`SELECT item FROM inventory WHERE character_id = ${row.id} ORDER BY item`)).map((r: any) => r.item)).toEqual(["health_potion", "wooden_staff"]);
  expect(await one(`SELECT COUNT(*) AS n FROM currency WHERE character_id = ${row.id}`)).toEqual({ n: 1 });
  expect(await one(`SELECT COUNT(*) AS n FROM equipment WHERE character_id = ${row.id}`)).toEqual({ n: 1 });
  // the pause menu's sliders as a character starts with them
  expect(await one(`SELECT fps, music_volume, effects_volume, ambience_volume, weather_volume FROM clientconfig WHERE character_id = ${row.id}`))
    .toEqual({ fps: 60, music_volume: 50, effects_volume: 30, ambience_volume: 50, weather_volume: 60 });
});

test("add refuses a bad name, a taken name, another account's username, and past the limit", async () => {
  const id = await addMage();
  expect(await characters.add(NEWBIE.account, "ab", id, 5)).toMatchObject({ ok: false, status: 400, error: "Names are 3 to 15 letters, numbers or underscores." });
  expect(await characters.add(NEWBIE.account, "has space", id, 5)).toMatchObject({ ok: false, status: 400 });
  expect(await characters.add(NEWBIE.account, "VETERAN ALT", id, 5)).toMatchObject({ ok: false, status: 400 });
  expect(await characters.add(NEWBIE.account, "Veteran", id, 5)).toMatchObject({ ok: false, status: 409, error: "That name is taken." });
  await db.unsafe("INSERT INTO accounts (username) VALUES ('Someone')");
  expect(await characters.add(NEWBIE.account, "someone", id, 5)).toMatchObject({ ok: false, status: 409, error: "That name is taken." });
  expect(await characters.add(NEWBIE.account, "Second", id, 2)).toMatchObject({ ok: true });
  expect(await characters.add(NEWBIE.account, "Third", id, 2)).toMatchObject({ ok: false, status: 409, error: "You have the most characters you can have." });
  expect(await characters.add(NEWBIE.account, "Fourth", id + 1, 5)).toMatchObject({ ok: false, status: 409 });
});

test("play sets the active character only for the account's own, not deleted one", async () => {
  expect(await characters.play(VETERAN.account, VETERAN_TWO)).toBe(true);
  expect(await one("SELECT active_character_id FROM accounts WHERE id = 1")).toEqual({ active_character_id: 3 });
  expect(await characters.play(VETERAN.account, NEWBIE.character)).toBe(false);
  await db.unsafe("UPDATE characters SET deleted_at = 1 WHERE id = 1");
  expect(await characters.play(VETERAN.account, 1)).toBe(false);
  expect(await one("SELECT active_character_id FROM accounts WHERE id = 1")).toEqual({ active_character_id: 3 });
});

test("remove needs the name, refuses one in play or leading a guild with members, and clears the active pick", async () => {
  expect(await characters.remove(VETERAN.account, 1, "wrong")).toMatchObject({ ok: false, status: 400, error: "Type the character's name to delete it." });
  expect(await characters.remove(NEWBIE.account, 1, "veteran")).toMatchObject({ ok: false, status: 404 });

  await db.unsafe("UPDATE accounts SET online = 1 WHERE id = 1");
  expect(await characters.remove(VETERAN.account, 1, "veteran")).toMatchObject({ ok: false, status: 409, error: "Leave the game first." });
  await db.unsafe("UPDATE accounts SET online = 0 WHERE id = 1");

  await db.unsafe("INSERT INTO guilds (name, leader, leader_id) VALUES ('Band', 'veteran', 1)");
  await db.unsafe("INSERT INTO guild_members VALUES (1, 1, 0), (2, 1, 1)");
  expect(await characters.remove(VETERAN.account, 1, "veteran")).toMatchObject({ ok: false, status: 409, error: "Pass on leadership of your guild first." });
  await db.unsafe("DELETE FROM guild_members WHERE character_id = 2");

  expect(await characters.remove(VETERAN.account, 1, "VETERAN")).toMatchObject({ ok: true });
  expect((await one("SELECT deleted_at FROM characters WHERE id = 1")).deleted_at).toBeGreaterThan(0);
  expect(await one("SELECT active_character_id FROM accounts WHERE id = 1")).toEqual({ active_character_id: null });
  expect((await characters.list(VETERAN.account)).characters.map((c) => c.id)).toEqual([3]);
});

test("purgeDeleted removes characters past the grace period and their name from friend and ignore lists", async () => {
  await db.unsafe("UPDATE characters SET deleted_at = 1000 WHERE id = 3");
  await db.unsafe("UPDATE characters SET deleted_at = 9000 WHERE id = 2");
  await db.unsafe("INSERT INTO friendslist (character_id, friends) VALUES (1, 'pal,Veteran Alt,newbie')");
  await db.unsafe("INSERT INTO ignores VALUES (1, 'Veteran Alt', 1)");
  expect(await characters.purgeDeleted(5000, 10000)).toBe(1);
  expect(await one("SELECT COUNT(*) AS n FROM characters WHERE id = 3")).toEqual({ n: 0 });
  expect(await one("SELECT COUNT(*) AS n FROM characters WHERE id = 2")).toEqual({ n: 1 });
  expect(await one("SELECT friends FROM friendslist WHERE character_id = 1 AND friends LIKE 'pal%'")).toEqual({ friends: "pal,newbie" });
  expect(await one("SELECT COUNT(*) AS n FROM ignores")).toEqual({ n: 0 });
});

test("with no class defined, add makes a character without one", async () => {
  const made = await characters.add(NEWBIE.account, "Plain", null, 5);
  expect(made).toMatchObject({ ok: true });
  expect(await one("SELECT class_id FROM characters WHERE name_key = 'plain'")).toEqual({ class_id: null });
});

test("add refuses a name starting with guest_", async () => {
  const id = await addMage();
  expect(await characters.add(NEWBIE.account, "Guest_abc", id, 5)).toMatchObject({ ok: false, status: 400 });
});

test("remove refuses any character while the account is in the game", async () => {
  await db.unsafe("UPDATE accounts SET online = 1, active_character_id = 3 WHERE id = 1");
  expect(await characters.remove(VETERAN.account, 1, "veteran")).toMatchObject({ ok: false, status: 409, error: "Leave the game first." });
});

test("purgeDeleted removes ignore rows stored lowercase", async () => {
  await db.unsafe("UPDATE characters SET deleted_at = 1 WHERE id = 3");
  await db.unsafe("INSERT INTO ignores VALUES (1, 'veteran alt', 1)");
  await characters.purgeDeleted(0, 10);
  expect(await one("SELECT COUNT(*) AS n FROM ignores")).toEqual({ n: 0 });
});
