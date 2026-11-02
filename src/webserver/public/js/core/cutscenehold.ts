// Whether a playing scene holds the player. This stays apart from cutscene.ts, with no imports of its own, because
// death.ts loads ahead of the renderer: importing cutscene.ts there reaches ui.ts through the NPCs before ui.ts has run
// its own imports, and weather.ts then finds no canvas and the page stops loading.

let holds: () => boolean = () => false;

export const cutsceneHoldsInput = () => holds();
export const setCutsceneHold = (check: () => boolean) => {
  holds = check;
};
