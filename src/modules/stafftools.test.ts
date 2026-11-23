import { describe, expect, test } from "bun:test";
import { STAFF_TOOLS, commandFor, staffToolGroups } from "../webserver/public/js/core/stafftools.ts";
import { ICONS } from "../webserver/public/js/core/toolicons.ts";

const ids = (groups: ReturnType<typeof staffToolGroups>) => groups.map((group) => group.map((tool) => tool.id));
const tool = (id: string) => STAFF_TOOLS.find((t) => t.id === id)!;

describe("staffToolGroups", () => {
  test("no tools, or anything that is not a list of ids, is no bar", () => {
    for (const sent of [[], undefined, null, "item_editor", { tools: ["item_editor"] }, [1, null, {}]]) {
      expect(staffToolGroups(sent)).toEqual([]);
    }
  });

  test("shows only the tools sent, in the bar's order, whatever order they came in", () => {
    expect(ids(staffToolGroups(["quest_editor", "item_editor"]))).toEqual([["item_editor", "quest_editor"]]);
  });

  test("leaves out ids it does not know, and shows a tool sent twice once", () => {
    expect(ids(staffToolGroups(["nuke_button", "item_editor", "item_editor"]))).toEqual([["item_editor"]]);
  });

  test("groups the tools, a group for each kind that has one", () => {
    expect(ids(staffToolGroups(["cutscene_editor", "control_panel", "item_editor"]))).toEqual([["control_panel"], ["item_editor"], ["cutscene_editor"]]);
  });

  test("every tool sent gives the whole bar in four groups", () => {
    const groups = staffToolGroups(STAFF_TOOLS.map((t) => t.id));
    expect(groups.map((group) => group[0].group)).toEqual(["admin", "world", "content", "effects"]);
    expect(groups.flat()).toEqual([...STAFF_TOOLS]);
  });

  test("the dungeon tool is one button: the portal editor's id opens nothing of its own", () => {
    expect(ids(staffToolGroups(["portal_editor", "dungeon_editor"]))).toEqual([["dungeon_editor"]]);
    expect(tool("dungeon_editor").name).toBe("Dungeon Tool");
  });
});

describe("the tools", () => {
  test("each has its own id, a name, a chat command and an icon that exists", () => {
    expect(new Set(STAFF_TOOLS.map((t) => t.id)).size).toBe(STAFF_TOOLS.length);
    for (const t of STAFF_TOOLS) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.command.startsWith("/")).toBe(true);
      expect(ICONS[t.icon]).toBeString();
    }
  });

  test("a group's tools stand together", () => {
    const order = STAFF_TOOLS.map((t) => t.group).filter((group, i, all) => group !== all[i - 1]);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("commandFor", () => {
  test("sends a tool's chat command as typed", () => {
    expect(commandFor(tool("item_editor"), "tester")).toBe("/ie");
    expect(commandFor(tool("control_panel"), null)).toBe("/cp");
  });

  test("opens the player editor on yourself", () => {
    expect(commandFor(tool("player_editor"), "tester")).toBe("/player edit tester");
  });

  test("without a name the player editor's command is sent bare, and the server says how to use it", () => {
    expect(commandFor(tool("player_editor"), undefined)).toBe("/player edit");
    expect(commandFor(tool("player_editor"), "  ")).toBe("/player edit");
  });
});
