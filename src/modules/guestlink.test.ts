import { expect, test } from "bun:test";
import path from "path";
import fs from "fs";

// The login page script, run against a stub page (no DOM): `/?guest=1` signs in as a guest on load and takes the
// parameter out of the address; without it nothing is sent until "Continue as guest" is clicked.
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  fs.readFileSync(path.join(import.meta.dir, "..", "webserver", "public", "js", "web", "login.ts"), "utf-8"),
);

async function openLogin(search: string) {
  const listeners: Record<string, ((event?: Event) => unknown)[]> = {};
  const element = (id: string) => ({
    id, value: "", disabled: false, innerHTML: "",
    focus() {}, click() {},
    addEventListener(type: string, fn: (event?: Event) => unknown) { (listeners[`${id}:${type}`] ??= []).push(fn); },
    removeEventListener() {},
  });
  const elements: Record<string, ReturnType<typeof element>> = {};
  const document = {
    getElementById: (id: string) => (elements[id] ??= element(id)),
    addEventListener() {},
    activeElement: null,
    body: {},
  };
  const location = { search, pathname: "/", hash: "", href: `/${search}` };
  const window = { location, Notify() {}, setTimeout, scrollTo() {} };
  const replaced: string[] = [];
  const history = { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) };
  const requests: string[] = [];
  const fetch = async (url: string) => { requests.push(url); return new Response(null, { status: 301 }); };
  new Function("document", "window", "navigator", "sessionStorage", "history", "fetch", source)(
    document, window, { maxTouchPoints: 0 }, { setItem() {} }, history, fetch,
  );
  await Promise.resolve();
  return { requests, replaced, location, listeners };
}

test("/?guest=1 signs in as a guest on load, drops the parameter and goes to realm selection; other keys stay", async () => {
  const page = await openLogin("?guest=1&next=gateway");
  expect(page.requests).toEqual(["/guest-login"]);
  expect(page.replaced).toEqual(["/?next=gateway"]);
  await new Promise((r) => setTimeout(r, 0));
  expect(page.location.href).toBe("/realm-selection");
  expect((await openLogin("?guest=1")).replaced).toEqual(["/"]);
});

test("without guest=1 the page waits for the guest link to be clicked", async () => {
  for (const search of ["", "?guest=0", "?guest=true", "?next=gateway"]) {
    const page = await openLogin(search);
    expect(page.requests).toEqual([]);
    expect(page.replaced).toEqual([]);
    await page.listeners["guest-login-link:click"][0]({ preventDefault() {} } as Event);
    expect(page.requests).toEqual(["/guest-login"]);
  }
});
