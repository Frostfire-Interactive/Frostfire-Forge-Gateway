import { expect, test } from "bun:test";
import { DEFAULT_NAME_MAX, entranceHint, entranceProblem, mapProblem, nameMaxOf, savedIdOf } from "../webserver/public/js/core/dungeoneditorrules";

const bridge = await Bun.file(new URL("../webserver/public/js/core/dungeoneditorbridge.ts", import.meta.url)).text();

test("a dungeon whose map was removed says the map no longer exists", () => {
  expect(mapProblem("", undefined)).toBe("Pick a map.");
  expect(mapProblem("old_cave", undefined)).toBe("The map old_cave no longer exists. Pick another map.");
  expect(mapProblem("cave", { name: "cave", widthPx: 640, heightPx: 480 })).toBeNull();
  expect(bridge).toContain("mapProblem(");
});

test("a map with no readable size says so instead of a range of 0 to -1", () => {
  expect(entranceProblem(10, 0)).toBe("The map's size could not be read, so no entrance fits in it. Pick another map or fix this one.");
  expect(entranceHint(0, "left")).toBe("The map's size could not be read.");
  expect(entranceProblem(10, 640)).toBeNull();
  expect(entranceProblem(640, 640)).toBe("The entrance must be inside the map (0 to 639).");
  expect(entranceProblem(1.5, 640)).toBe("The entrance must be whole pixels.");
  expect(entranceHint(640, "top")).toBe("From 0 to 639, from the map's top edge.");
  expect(entranceHint(undefined, "top")).toBe("Pick a map first.");
  expect(bridge).toContain("entranceProblem(");
  expect(bridge).toContain("entranceHint(");
});

test("the name limit is the server's when its list gives one", () => {
  expect(DEFAULT_NAME_MAX).toBe(48);
  expect(nameMaxOf({})).toBe(48);
  expect(nameMaxOf({ nameMax: 64 })).toBe(64);
  expect(nameMaxOf({ nameMax: "64" })).toBe(48);
  expect(bridge).not.toMatch(/const NAME_MAX = \d+/);
});

test("a save answer is matched by the id the server gives, then by name ignoring case", () => {
  const dungeons = [{ id: 1, name: "Vault" }, { id: 2, name: "Crypt" }];
  expect(savedIdOf({ id: 2, name: "Vault" }, dungeons)).toBe(2);
  expect(savedIdOf({ name: "vault " }, dungeons)).toBe(1);
  expect(savedIdOf({ name: "Nowhere" }, dungeons)).toBeNull();
  expect(bridge).toContain("savedIdOf(");
  expect(bridge).not.toContain("find((d) => d.name === msg.name)");
});
