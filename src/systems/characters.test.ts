// USER REQUEST 2026-10-14: the character page's API (systems/characters.ts), against a real SQLite database in memory,
// through the same transaction code the database worker runs.
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

const MAGE = { name: "Mage", description: "Casts.", max_health: 80, max_stamina: 150, stat_damage: 3, stat_armor: 1, stat_critical_chance: 12, stat_critical_damage: 40, stat_avoidance: 5, spells: '[{"spell":"frost_bolt","level":1},{"spell":"blink","level":4}]' };

beforeEach(async () => {
  db = new SQL({ adapter: "sqlite", filename: ":memory:" });
  for (const sql of [
    "CREATE TABLE accounts (username TEXT PRIMARY KEY, class_id INTEGER DEFAULT NULL, online INTEGER DEFAULT 0, map TEXT, position TEXT, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER)",
    "CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT, max_health INTEGER, max_stamina INTEGER, stat_damage INTEGER, stat_armor INTEGER, stat_critical_chance INTEGER, stat_critical_damage INTEGER, stat_avoidance INTEGER, spells TEXT)",
    "CREATE TABLE stats (username TEXT UNIQUE, health INTEGER, max_health INTEGER, stamina INTEGER, max_stamina INTEGER, xp INTEGER, max_xp INTEGER, level INTEGER, stat_critical_damage INTEGER DEFAULT 0, stat_critical_chance INTEGER DEFAULT 0, stat_armor INTEGER DEFAULT 0, stat_damage INTEGER DEFAULT 0, stat_health INTEGER DEFAULT 0, stat_stamina INTEGER DEFAULT 0, stat_avoidance INTEGER DEFAULT 0)",
    "CREATE TABLE inventory (username TEXT, item TEXT)",
    "CREATE TABLE bags (username TEXT UNIQUE, slot_1 TEXT)",
    "CREATE TABLE equipment (username TEXT UNIQUE, head TEXT, weapon TEXT)",
    "CREATE TABLE learned_spells (username TEXT, spell TEXT)",
    "CREATE TABLE quest_log (username TEXT, quest_id INTEGER)",
    "CREATE TABLE quest_objective_progress (username TEXT, quest_id INTEGER, objective_id INTEGER, count INTEGER)",
    "CREATE TABLE currency (username TEXT UNIQUE, copper INTEGER, silver INTEGER, gold INTEGER)",
    "CREATE TABLE player_home (username TEXT PRIMARY KEY, npc_id INTEGER)",
    "CREATE TABLE clientconfig (username TEXT UNIQUE, hotbar_config TEXT, inventory_config TEXT, music_volume INTEGER)",
    "CREATE TABLE collectables (username TEXT, type TEXT, item TEXT)",
    "CREATE TABLE friendslist (username TEXT, friends TEXT)",
    "CREATE TABLE spells (name TEXT, description TEXT, icon TEXT)",
  ]) await db.unsafe(sql);
  await db.unsafe("INSERT INTO spells VALUES ('frost_bolt', 'A bolt of ice.', 'frost_bolt.png'), ('blink', 'Jump ahead.', NULL), ('other', 'Not a class spell.', NULL)");
  // a player of some standing from before characters
  await db.unsafe("INSERT INTO accounts (username, map, position, is_dead, corpse_map) VALUES ('veteran', 'forest', '120,80', 1, 'forest')");
  await db.unsafe("INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_damage) VALUES ('veteran', 300, 300, 200, 200, 50, 900, 12, 40)");
  await db.unsafe("INSERT INTO inventory VALUES ('veteran', 'sword'), ('veteran', 'potion')");
  await db.unsafe("INSERT INTO bags VALUES ('veteran', 'big_bag')");
  await db.unsafe("INSERT INTO equipment VALUES ('veteran', 'cap', 'sword')");
  await db.unsafe("INSERT INTO learned_spells VALUES ('veteran', 'other')");
  await db.unsafe("INSERT INTO quest_log VALUES ('veteran', 3)");
  await db.unsafe("INSERT INTO quest_objective_progress VALUES ('veteran', 3, 1, 4)");
  await db.unsafe("INSERT INTO currency VALUES ('veteran', 5, 6, 7)");
  await db.unsafe("INSERT INTO player_home VALUES ('veteran', -5)");
  await db.unsafe("INSERT INTO clientconfig VALUES ('veteran', '{\"1\":\"other\"}', '{\"0\":\"sword\"}', 40)");
  await db.unsafe("INSERT INTO collectables VALUES ('veteran', 'mount', 'horse')");
  await db.unsafe("INSERT INTO friendslist VALUES ('veteran', 'pal')");
  // a new account
  await db.unsafe("INSERT INTO accounts (username, map, position) VALUES ('newbie', '', '0,0')");
  await db.unsafe("INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level) VALUES ('newbie', 100, 100, 100, 100, 0, 100, 1)");
});

const addMage = async () => {
  await db.unsafe(sqlWrapper("INSERT INTO classes (name, description, max_health, max_stamina, stat_damage, stat_armor, stat_critical_chance, stat_critical_damage, stat_avoidance, spells) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [MAGE.name, MAGE.description, MAGE.max_health, MAGE.max_stamina, MAGE.stat_damage, MAGE.stat_armor, MAGE.stat_critical_chance, MAGE.stat_critical_damage, MAGE.stat_avoidance, MAGE.spells], "sqlite"));
  return Number((await db.unsafe("SELECT id FROM classes WHERE name = 'Mage'"))[0].id);
};

test("no class defined: nobody is asked for a character", async () => {
  expect(await characters.status("newbie")).toMatchObject({ needed: false, classes: [] });
});

test("with a class: an account without a character is asked for one, and told when it starts over", async () => {
  await addMage();
  const fresh = await characters.status("newbie");
  expect(fresh).toMatchObject({ needed: true, startsOver: false, username: "newbie" });
  expect(fresh.classes[0]).toMatchObject({ name: "Mage", stats: { max_health: 80, stat_avoidance: 5 }, spells: [{ spell: "frost_bolt", level: 1 }, { spell: "blink", level: 4 }] });
  expect(fresh.spellInfo).toEqual({ frost_bolt: { description: "A bolt of ice.", icon: "frost_bolt.png" }, blink: { description: "Jump ahead.", icon: null } });
  expect((await characters.status("veteran")).startsOver).toBe(true);
});

test("making the character starts the account over with the class's stats, and keeps what is not the character", async () => {
  const id = await addMage();
  expect(await characters.create("veteran", id)).toEqual({ ok: true, className: "Mage" });

  const one = async (sql: string) => (await db.unsafe(sql))[0];
  expect(await one("SELECT class_id, map, position, is_dead, corpse_map FROM accounts WHERE username = 'veteran'")).toEqual({ class_id: id, map: "", position: "0,0", is_dead: 0, corpse_map: null });
  expect(await one("SELECT health, max_health, stamina, max_stamina, xp, max_xp, level, stat_damage, stat_armor, stat_critical_chance, stat_critical_damage, stat_avoidance FROM stats WHERE username = 'veteran'"))
    .toEqual({ health: 80, max_health: 80, stamina: 150, max_stamina: 150, xp: 0, max_xp: 100, level: 1, stat_damage: 3, stat_armor: 1, stat_critical_chance: 12, stat_critical_damage: 40, stat_avoidance: 5 });
  for (const table of ["inventory", "bags", "learned_spells", "quest_log", "quest_objective_progress", "player_home"]) {
    expect(`${table}: ${(await db.unsafe(`SELECT COUNT(*) AS n FROM ${table} WHERE username = 'veteran'`))[0].n}`).toBe(`${table}: 0`);
  }
  expect(await one("SELECT head, weapon FROM equipment WHERE username = 'veteran'")).toEqual({ head: null, weapon: null });
  expect(await one("SELECT copper, silver, gold FROM currency WHERE username = 'veteran'")).toEqual({ copper: 0, silver: 0, gold: 0 });
  expect(await one("SELECT hotbar_config, inventory_config, music_volume FROM clientconfig WHERE username = 'veteran'")).toEqual({ hotbar_config: null, inventory_config: null, music_volume: 40 });
  expect(await one("SELECT item FROM collectables WHERE username = 'veteran'")).toEqual({ item: "horse" });
  expect(await one("SELECT friends FROM friendslist WHERE username = 'veteran'")).toEqual({ friends: "pal" });

  // one character per account
  expect(await characters.create("veteran", id)).toMatchObject({ ok: false, status: 409 });
  expect((await characters.status("veteran")).needed).toBe(false);
});

test("nothing is made for a class that is gone, an account in the game, or twice at once", async () => {
  const id = await addMage();
  expect(await characters.create("newbie", id + 1)).toMatchObject({ ok: false, status: 409 });
  expect(await characters.create("newbie", "x")).toMatchObject({ ok: false, status: 400 });

  await db.unsafe("UPDATE accounts SET online = 1 WHERE username = 'newbie'");
  expect(await characters.create("newbie", id)).toMatchObject({ ok: false, status: 409 });
  expect((await db.unsafe("SELECT class_id FROM accounts WHERE username = 'newbie'"))[0].class_id).toBeNull();
  await db.unsafe("UPDATE accounts SET online = 0 WHERE username = 'newbie'");

  const both = await Promise.all([characters.create("newbie", id), characters.create("newbie", id)]);
  expect(both.filter((r) => r.ok)).toHaveLength(1);
  expect((await db.unsafe("SELECT COUNT(*) AS n FROM stats WHERE username = 'newbie'"))[0].n).toBe(1);
});
