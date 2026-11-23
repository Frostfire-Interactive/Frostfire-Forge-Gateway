import { expect, mock, test } from "bun:test";

const sent: any[] = [];
mock.module("../webserver/public/js/core/socket", () => ({ sendRequest: (packet: any) => sent.push(packet), cachedPlayerId: null }));

class FakeElement {
  id = ""; className = ""; innerText = ""; children: FakeElement[] = []; parent: FakeElement | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  append(...nodes: FakeElement[]) { for (const n of nodes) this.appendChild(n); }
  appendChild(node: FakeElement) { node.parent = this; this.children.push(node); return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
}

const body = new FakeElement();
const find = (node: FakeElement, id: string): FakeElement | null => {
  for (const c of node.children) { if (c.id === id) return c; const deep = find(c, id); if (deep) return deep; }
  return null;
};
(globalThis as any).document = { body, createElement: () => new FakeElement(), getElementById: (id: string) => find(body, id) };

const { createDungeonSizePopup } = await import("../webserver/public/js/core/invites");

test("the size popup closes on its own when the server's choice runs out", async () => {
  createDungeonSizePopup({ name: "Vault", sizes: [10, 20], authorization: "tok", expiresInMs: 20 });
  expect(find(body, "dungeon-size-popup")).not.toBeNull();
  await Bun.sleep(40);
  expect(find(body, "dungeon-size-popup")).toBeNull();
});

test("a pick before then sends it once and no later timer removes a newer popup", async () => {
  createDungeonSizePopup({ name: "Vault", sizes: [10, 20], authorization: "a", expiresInMs: 20 });
  const first = find(body, "dungeon-size-popup")!;
  first.children[2]!.children[0]!.click();
  expect(sent.at(-1)).toEqual({ type: "DUNGEON_SIZE_PICK", data: { authorization: "a", size: 10 } });
  createDungeonSizePopup({ name: "Vault", sizes: [10, 20], authorization: "b", expiresInMs: 60 });
  await Bun.sleep(40);
  expect(find(body, "dungeon-size-popup")).not.toBeNull();
  await Bun.sleep(50);
  expect(find(body, "dungeon-size-popup")).toBeNull();
});
