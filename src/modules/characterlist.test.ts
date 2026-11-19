import { expect, test } from "bun:test";
import { characterListView } from "../webserver/public/js/core/characterlist";

const list = (characters: any[], limit = 5) => ({ characters, limit, classes: [], spellInfo: {}, itemInfo: {} });

test("label reads Level 3 Mage", () => {
  const view = characterListView(list([{ id: 7, name: "Aria", classId: 2, className: "Mage", level: 3 }]));
  expect(view.rows).toEqual([{ id: 7, name: "Aria", classId: 2, label: "Level 3 Mage" }]);
});

test("a character without a class reads its level alone", () => {
  const view = characterListView(list([{ id: 1, name: "Bo", classId: null, className: null, level: 1 }]));
  expect(view.rows[0].label).toBe("Level 1");
});

test("canCreate is false at the limit", () => {
  const two = [
    { id: 1, name: "A1a", classId: 1, className: "Mage", level: 1 },
    { id: 2, name: "B2b", classId: 1, className: "Mage", level: 1 },
  ];
  expect(characterListView(list(two, 2)).canCreate).toBe(false);
  expect(characterListView(list(two, 3)).canCreate).toBe(true);
});

test("an empty list opens on create", () => {
  const view = characterListView(list([]));
  expect(view.rows).toEqual([]);
  expect(view.opensOnCreate).toBe(true);
  expect(characterListView(list([{ id: 1, name: "Abc", classId: 1, className: "Mage", level: 1 }])).opensOnCreate).toBe(false);
});
