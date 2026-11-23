import { describe, expect, test } from "bun:test";
import { backToFront } from "../webserver/public/js/core/depthorder";

describe("a summoning stone among those standing", () => {
  test("someone else standing on the stone's foot line is drawn in front of it, as they see themselves", () => {
    const player = { feet: 93750, name: "test" };
    const stone = { feet: 93750, prop: true, name: "stone" };
    expect(backToFront([player, stone]).map((s) => s.name)).toEqual(["stone", "test"]);
    expect(backToFront([stone, player]).map((s) => s.name)).toEqual(["stone", "test"]);
  });

  test("one standing behind its foot is still behind it", () => {
    const player = { feet: 93749, name: "test" };
    const stone = { feet: 93750, prop: true, name: "stone" };
    expect(backToFront([stone, player]).map((s) => s.name)).toEqual(["test", "stone"]);
  });
});
