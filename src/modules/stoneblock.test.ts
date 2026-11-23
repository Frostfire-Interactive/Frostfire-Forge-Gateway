import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STONE_DEPTH, STONE_HALF_WIDTH, STONE_LIFT, stoneBlocksStep, stonesAt } from "../webserver/public/js/core/stoneblock";

// A summoning stone is solid (systems/stoneblock.ts): x - 28 to x + 28, from 32 px above its foot to 16 px above it.
// A player's feet are 16 px below their y, so walking up to it they stop with their feet on its foot line.
// A player's box: x ± 12, from y down to y + 20. These are the engine's cases (src/tests/stone-block.test.ts there) on the client's copy.
const s = { x: 100, foot: 200 };

describe("stone footprint", () => {
    test("the footprint and where a stone stands", () => {
        expect([STONE_HALF_WIDTH, STONE_DEPTH, STONE_LIFT]).toEqual([28, 16, 16]);
        expect(stonesAt([{ position: { x: 100, y: 200 } }])).toEqual([s]);
        expect(stonesAt([])).toEqual([]);
        expect(stoneBlocksStep([], { x: 100, y: 210 }, { x: 100, y: 190 })).toBe(false);
    });

    test("walking up into the base from below is blocked", () => {
        expect(stoneBlocksStep([s], { x: 100, y: 195 }, { x: 100, y: 180 })).toBe(true);
        expect(stoneBlocksStep([s], { x: 100, y: 210 }, { x: 100, y: 186 })).toBe(false);
    });

    test("walking down onto it from above is blocked at its back", () => {
        expect(stoneBlocksStep([s], { x: 100, y: 140 }, { x: 100, y: 160 })).toBe(true);
    });

    test("passing beside it is free", () => {
        expect(stoneBlocksStep([s], { x: 141, y: 175 }, { x: 141, y: 165 })).toBe(false);
    });

    test("a long step cannot jump through it", () => {
        expect(stoneBlocksStep([s], { x: 40, y: 170 }, { x: 160, y: 170 })).toBe(true);
    });

    test("a player a warp left on the stone can walk off", () => {
        expect(stoneBlocksStep([s], { x: 100, y: 175 }, { x: 100, y: 190 })).toBe(false);
    });

    test("the summon spot is clear of the footprint", () => {
        expect(stoneBlocksStep([s], null, { x: 100, y: 208 })).toBe(false);
        expect(stoneBlocksStep([s], null, { x: 100, y: 175 })).toBe(true);
    });

    // The engine's file is read when the two repos sit side by side; the constants and the core of the logic must match.
    const enginePath = resolve(import.meta.dir, "../../../Frostfire-Forge/src/systems/stoneblock.ts");
    const numbers = (text: string) => Object.fromEntries([...text.matchAll(/const ([A-Z_]+) = (\d+);/g)].map((m) => [m[1], Number(m[2])]));
    test.skipIf(!existsSync(enginePath))("the copy matches the engine's numbers and logic", () => {
        const engine = readFileSync(enginePath, "utf8");
        const copy = readFileSync(resolve(import.meta.dir, "../webserver/public/js/core/stoneblock.ts"), "utf8");
        expect(numbers(copy)).toEqual(numbers(engine));
        expect(numbers(copy).STONE_HALF_WIDTH).toBe(STONE_HALF_WIDTH);
        expect(numbers(copy).STONE_DEPTH).toBe(STONE_DEPTH);
        expect(numbers(copy).STONE_LIFT).toBe(STONE_LIFT);
        const body = (text: string, name: string) => text.slice(text.indexOf(`function ${name}`)).split(/\r?\n}\r?\n/)[0]!.replace(/\s+/g, " ");
        expect(body(copy, "onStone")).toBe(body(engine, "onStone"));
        expect(body(copy, "stoneBlocksStep")).toBe(body(engine, "stoneBlocksStep"));
    });
});
