import { expect, test } from "bun:test";
import { layerSheetsChanged, nameLayerSheets } from "../webserver/public/js/core/layersheets";

// Which sheets a player's layers draw (layersheets.ts): a worn item's or a mount's template carries a base sheet's name,
// so a look is compared by the sheet names the server sends, and the same look does not rebuild the player.

const entry = (name: string) => ({ name, templateUrl: `t?name=${name}`, imageUrl: `i?name=${name}` });
const template = (name: string) => ({ name, imageSource: "img", animations: {} });

/** Layers as initializeLayeredAnimation builds them: each holds its sheet's resolved template. */
function build(look: Record<string, string>, templates: Record<string, string>) {
  const sprites: Record<string, any> = {};
  for (const [key, name] of Object.entries(look)) sprites[key] = entry(name);
  const layers: Record<string, any> = {};
  const types: Record<string, string> = {
    mountSprite: "mount", bodySprite: "body", headSprite: "head", armorHelmetSprite: "armor_helmet",
    armorWeaponSprite: "armor_weapon",
  };
  for (const key of Object.keys(look)) layers[types[key]] = { type: types[key], spriteSheet: template(templates[key]) };
  nameLayerSheets(layers, sprites);
  return { layers, sprites };
}

const gear = { bodySprite: "player_body_base", headSprite: "player_head_base", armorHelmetSprite: "bronze helmet", armorWeaponSprite: "fishing rod" };
const gearTemplates = { bodySprite: "player_body_base", headSprite: "player_head_base", armorHelmetSprite: "player_head_base", armorWeaponSprite: "player_body_base" };

test("the same worn items do not rebuild the player", () => {
  const { layers } = build(gear, gearTemplates);
  const look = Object.fromEntries(Object.entries(gear).map(([k, n]) => [k, entry(n)]));
  expect(layerSheetsChanged({ layers }, look)).toBe(false);
});

test("the same mount does not rebuild the player", () => {
  const mounted = { ...gear, mountSprite: "mount_unicorn" };
  const { layers } = build(mounted, { ...gearTemplates, mountSprite: "player_mount_base" });
  const look = Object.fromEntries(Object.entries(mounted).map(([k, n]) => [k, entry(n)]));
  expect(layerSheetsChanged({ layers }, look)).toBe(false);
});

test("another worn item rebuilds the player", () => {
  const { layers } = build(gear, gearTemplates);
  const look = Object.fromEntries(Object.entries({ ...gear, armorWeaponSprite: "wooden sword" }).map(([k, n]) => [k, entry(n)]));
  expect(layerSheetsChanged({ layers }, look)).toBe(true);
});

test("an item taken off or put on rebuilds the player", () => {
  const { layers } = build(gear, gearTemplates);
  const { armorHelmetSprite, ...bare } = gear;
  expect(layerSheetsChanged({ layers }, Object.fromEntries(Object.entries(bare).map(([k, n]) => [k, entry(n)])))).toBe(true);
  const look = Object.fromEntries(Object.entries({ ...gear, mountSprite: "mount_unicorn" }).map(([k, n]) => [k, entry(n)]));
  expect(layerSheetsChanged({ layers }, look)).toBe(true);
});

test("a dismount rebuilds the player", () => {
  const mounted = { ...gear, mountSprite: "mount_unicorn" };
  const { layers } = build(mounted, { ...gearTemplates, mountSprite: "player_mount_base" });
  expect(layerSheetsChanged({ layers }, Object.fromEntries(Object.entries(gear).map(([k, n]) => [k, entry(n)])))).toBe(true);
});

test("a template given directly keeps its own name", () => {
  const layers: Record<string, any> = { body: { type: "body", spriteSheet: template("player_body_base") } };
  nameLayerSheets(layers, { bodySprite: template("player_body_base") });
  expect(layers.body.sheetName).toBe("player_body_base");
  expect(layerSheetsChanged({ layers }, { bodySprite: entry("player_body_base") })).toBe(false);
});

test("a player with no layers yet is built", () => {
  expect(layerSheetsChanged(null, { bodySprite: entry("player_body_base") })).toBe(true);
});
