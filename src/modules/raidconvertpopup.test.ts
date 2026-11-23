import { expect, jest, mock, test } from "bun:test";

const sent: any[] = [];
mock.module("../webserver/public/js/core/socket", () => ({ sendRequest: (packet: any) => sent.push(packet), cachedPlayerId: null }));

class FakeElement {
  id = ""; className = ""; innerText = ""; children: FakeElement[] = []; parent: FakeElement | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public tag = "div") {}
  set innerHTML(html: string) {
    this.children = [];
    const heading = new FakeElement("h2");
    this.appendChild(heading);
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
      const button = new FakeElement("button");
      button.id = id!;
      this.appendChild(button);
    }
  }
  querySelector(tag: string) { return this.children.find((c) => c.tag === tag) ?? null; }
  appendChild(node: FakeElement) { node.parent = this; this.children.push(node); return node; }
  append(...nodes: FakeElement[]) { for (const n of nodes) this.appendChild(n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
}

const body = new FakeElement("body");
const find = (node: FakeElement, id: string): FakeElement | null => {
  for (const c of node.children) { if (c.id === id) return c; const deep = find(c, id); if (deep) return deep; }
  return null;
};
(globalThis as any).document = { body, createElement: (tag: string) => new FakeElement(tag), getElementById: (id: string) => find(body, id) };

const { createInvitationPopup } = await import("../webserver/public/js/core/invites");

const offer = (authorization: string) => ({ action: "RAID_CONVERT", message: "Your party is full.", originator: "7", authorization });
const decline = (authorization: string) => ({ type: "INVITATION_RESPONSE", data: { authorization, originator: "7", action: "RAID_CONVERT", response: "DECLINE" } });

test("an unanswered raid conversion is declined, as Cancel does, before the server's minute runs out", () => {
  jest.useFakeTimers();
  try {
    sent.length = 0;
    createInvitationPopup(offer("a"));
    jest.advanceTimersByTime(50_000);
    expect(sent).toEqual([]);
    expect(find(body, "invitation-popup")).not.toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(sent).toEqual([decline("a")]);
    expect(find(body, "invitation-popup")).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("an answered raid conversion sends nothing more when the time runs out", () => {
  jest.useFakeTimers();
  try {
    sent.length = 0;
    createInvitationPopup(offer("b"));
    find(body, "accept-invitation")!.click();
    jest.advanceTimersByTime(60_000);
    expect(sent).toEqual([{ type: "INVITATION_RESPONSE", data: { authorization: "b", originator: "7", action: "RAID_CONVERT", response: "ACCEPT" } }]);
  } finally {
    jest.useRealTimers();
  }
});

test("the client keeps no party leader it never reads", async () => {
  const core = new URL("../webserver/public/js/core/", import.meta.url);
  for (const file of ["player.ts", "socket.ts", "ui.ts"]) {
    expect(await Bun.file(new URL(file, core)).text()).not.toContain("party_leader");
  }
});
