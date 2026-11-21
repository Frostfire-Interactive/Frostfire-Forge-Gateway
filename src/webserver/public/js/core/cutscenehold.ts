let holds: () => boolean = () => false;

export const cutsceneHoldsInput = () => holds();
export const setCutsceneHold = (check: () => boolean) => {
  holds = check;
};
