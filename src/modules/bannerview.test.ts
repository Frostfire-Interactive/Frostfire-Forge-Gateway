import { expect, test } from "bun:test";
import { clearBanner, showBanner } from "../webserver/public/js/core/bannerview";

// A new zone's text takes the old text's place at once: the old text (shown, or fading out) is gone before the new
// one is shown, and on a new map (through a portal) the old map's text does not stay up.

function element() {
  const classes = new Set<string>();
  const seen: string[] = [];
  const el: any = {
    textContent: "", style: { transition: "" },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    get offsetWidth() { seen.push(`${classes.has("shown") ? "shown" : "hidden"}:${el.textContent}:${el.style.transition}`); return 1; },
  };
  return { el, seen, shown: () => classes.has("shown") };
}

test("the old text is taken down, with no fade, before the new zone's text is shown", () => {
  const { el, seen, shown } = element();
  el.textContent = "Welcome to Town";
  el.classList.add("shown");
  showBanner(el, "Forest");
  // laid out once with the old text gone and no fade
  expect(seen).toEqual(["hidden::none"]);
  expect(el.textContent).toBe("Forest");
  expect(el.style.transition).toBe("");
  expect(shown()).toBe(true);
});

test("a new map takes the old map's text down at once", () => {
  const { el, shown } = element();
  el.textContent = "Welcome to Town";
  el.classList.add("shown");
  clearBanner(el);
  expect(shown()).toBe(false);
  expect(el.textContent).toBe("");
  expect(el.style.transition).toBe("");
});
