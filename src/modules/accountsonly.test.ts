import { expect, test } from "bun:test";
import { accountsOnly } from "./accountsonly";

const request = () => new Request("http://localhost/api/profile");

test("a guest is refused a profile route, and the route is not run", async () => {
  let ran = false;
  const route = accountsOnly(() => { ran = true; return new Response("profile"); }, async () => true);
  const reply = await route(request());
  expect(reply.status).toBe(403);
  expect(await reply.json()).toEqual({ guest: true, message: "Guest accounts have no profile" });
  expect(ran).toBe(false);
});

test("an account that is not a guest gets the route's own reply", async () => {
  const route = accountsOnly(async () => new Response("profile", { status: 200 }), async () => false);
  const reply = await route(request());
  expect(reply.status).toBe(200);
  expect(await reply.text()).toBe("profile");
});
