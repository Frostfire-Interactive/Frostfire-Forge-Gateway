import { expect, test } from "bun:test";
import { TOOL_KINDS, packetKind } from "../webserver/public/js/core/dungeontoolparts";
import { ICONS } from "../webserver/public/js/core/toolicons";

test("the tabs are Dungeons, Portals and Summoning stones", () => {
  expect(TOOL_KINDS.map((k) => k.label)).toEqual(["Dungeons", "Portals", "Summoning stones"]);
  expect(TOOL_KINDS.map((k) => k.id)).toEqual(["dungeons", "portals", "stones"]);
  expect(TOOL_KINDS.find((k) => k.id === "stones")!.plural).toBe("summoning stones");
  for (const k of TOOL_KINDS) expect(ICONS[k.icon]).toBeString();
});

test("requests are routed by packet prefix", () => {
  expect(packetKind("SUMMON_STONE_EDITOR_SAVE")).toBe("stones");
  expect(packetKind("PORTAL_EDITOR_LIST")).toBe("portals");
  expect(packetKind("DUNGEON_EDITOR_DELETE")).toBe("dungeons");
  expect(packetKind("CHAT")).toBeNull();
  // the touch packets are the game's, not the tool's
  expect(packetKind("SUMMON_STONE_TOUCH")).toBeNull();
  expect(packetKind(42 as unknown as string)).toBeNull();
});

test("the game sends every part's answers to the one tool, and the old portal editor is gone", async () => {
  const at = (path: string) => new URL(`../webserver/public/${path}`, import.meta.url);
  const socket = await Bun.file(at("js/core/socket.ts")).text();
  // a packet's branch: from its case to the next one
  const branchOf = (type: string) => {
    const from = socket.indexOf(`case "${type}"`);
    expect(from).toBeGreaterThan(-1);
    return socket.slice(from, socket.indexOf("\n    case ", from + 1));
  };
  for (const type of ["DUNGEON_EDITOR_DATA", "DUNGEON_EDITOR_RESULT", "DUNGEON_EDITOR_UPDATED", "PORTAL_EDITOR_DATA", "PORTAL_EDITOR_RESULT", "SUMMON_STONE_EDITOR_DATA", "SUMMON_STONE_EDITOR_RESULT"]) {
    expect(branchOf(type)).toContain("./dungeontool.js");
  }
  expect(socket).not.toContain("TOGGLE_PORTAL_EDITOR");
  expect(socket).not.toContain("./portaleditor.js");
  expect(socket).not.toContain("./dungeoneditor.js");
  for (const type of ["LOAD_MAP", "MAP_PORTALS", "MAP_SUMMONING_STONES"]) {
    expect(branchOf(type)).toContain("onMapChanged()");
  }
  const page = await Bun.file(at("dungeoneditor.html")).text();
  expect(page).toContain("<title>Dungeon Tool</title>");
  expect(page).toContain("./js/core/dungeontoolbridge.js");
  expect(await Bun.file(at("portaleditor.html")).exists()).toBe(false);
  expect(await Bun.file(at("js/core/portaleditor.ts")).exists()).toBe(false);
  expect(await Bun.file(at("js/core/dungeoneditor.ts")).exists()).toBe(false);
});

test("the three tabs share one way of asking, waiting and refusing (toolpart.ts)", async () => {
  const core = (file: string) => Bun.file(new URL(`../webserver/public/js/core/${file}`, import.meta.url)).text();
  for (const [file, name] of [["dungeoneditorbridge.ts", "DungeonPart"], ["portaleditorbridge.ts", "PortalPart"], ["stoneeditorbridge.ts", "StonePart"]] as const) {
    const source = await core(file);
    expect(source).toContain(`class ${name} extends ToolPartBase<EditorShell> implements ToolPart`);
    for (const shared of ["beginRequest(kind", "endRequest(): void", "onMessage({", "report(lines", "problemLines(): string[]", "activate(): void", "pendingTimer"]) {
      expect(source).not.toContain(shared);
    }
    // each tab keeps its own scroll
    expect(source).not.toContain("page(String(this.opened)");
    expect(source).toContain("this.shell.page(this.pageKey()");
  }
});

test("a tab waiting or refused can still be left for another", async () => {
  const core = (file: string) => Bun.file(new URL(`../webserver/public/js/core/${file}`, import.meta.url)).text();
  const shell = await core("tooleditor.ts");
  const usable = shell.slice(shell.indexOf("private usable("), shell.indexOf("// ---", shell.indexOf("private usable(")));
  expect(usable).toContain("this.opts.kindsStayOpen");
  expect(await core("dungeontoolbridge.ts")).toContain("kindsStayOpen: true");
});

test("a hidden tab says nothing when the map changes", async () => {
  const core = (file: string) => Bun.file(new URL(`../webserver/public/js/core/${file}`, import.meta.url)).text();
  for (const file of ["portaleditorbridge.ts", "stoneeditorbridge.ts"]) {
    expect(await core(file)).toMatch(/if \(this\.active\) toast\(`You are on \$\{this\.data\.map\} now/);
  }
});

test("the Dungeons tab asks for its portals again when a portal changes", async () => {
  const core = (file: string) => Bun.file(new URL(`../webserver/public/js/core/${file}`, import.meta.url)).text();
  const socket = await core("socket.ts");
  const from = socket.indexOf('case "DUNGEON_PORTALS_CHANGED"');
  const branch = socket.slice(from, socket.indexOf("\n    case ", from + 1));
  expect(branch).toContain("forgetPortalPreviews()");
  expect(branch).toContain("./dungeontool.js");
  expect(branch).toContain("onPortalsChanged()");
  const tool = await core("dungeontool.ts");
  const method = tool.slice(tool.indexOf("onPortalsChanged(): void"), tool.indexOf("\n  }\n", tool.indexOf("onPortalsChanged(): void")));
  expect(method).toContain("if (!this.isActive) return;");
  expect(method).toContain("LISTS.dungeons");
});
