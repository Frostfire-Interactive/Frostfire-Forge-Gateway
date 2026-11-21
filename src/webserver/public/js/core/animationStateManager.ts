


import { updateLayeredAnimation, changeLayeredAnimation } from './layeredAnimation.js';

const STALL_REVERT_MS = 1500;

export class AnimationStateManager {

  updateAllPlayers(players: Map<string, any>, deltaTime: number, localPlayerId?: string | null): void {
    const now = performance.now();
    players.forEach(player => {
      if (player.layeredAnimation) {
        updateLayeredAnimation(player.layeredAnimation, deltaTime);

        if (player.id === localPlayerId) return;

        const animName = player.layeredAnimation.currentAnimationName || "";
        const animAppliedAt = player.layeredAnimation._animAppliedAt || 0;
        if (
          animName.includes("walk") &&
          now - animAppliedAt > STALL_REVERT_MS &&
          typeof player.lastServerUpdate === "number" &&
          player.lastServerUpdate > 0 &&
          now - player.lastServerUpdate > STALL_REVERT_MS
        ) {
          changeLayeredAnimation(player.layeredAnimation, animName.replace(/walk/, "idle"));
        }
      }
    });
  }

}

export const animationManager = new AnimationStateManager();
