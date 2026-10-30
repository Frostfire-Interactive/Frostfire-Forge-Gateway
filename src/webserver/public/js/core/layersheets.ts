// Which sheet each layer of a player's layered animation draws, by the name the server gives it. A worn item's or a
// mount's sheet comes with a template it shares with the base sheets ("fishing rod" with "player_body_base", "bronze
// helmet" with "player_head_base", "mount_unicorn" with "player_mount_base"), so the template's own name does not say
// which sheet a layer draws. A look compared by it differed for every worn item and mount, and each SPRITE_SHEET_ANIMATION
// rebuilt the player from the first frame: the walk restarted at every border crossing, where the new node sends two.

/** The packet field that names each layer's sheet. */
export const LAYER_SPRITE_KEYS = {
  mount: "mountSprite",
  body: "bodySprite",
  head: "headSprite",
  armor_helmet: "armorHelmetSprite",
  armor_shoulderguards: "armorShoulderguardsSprite",
  armor_neck: "armorNeckSprite",
  armor_hands: "armorHandsSprite",
  armor_chest: "armorChestSprite",
  armor_feet: "armorFeetSprite",
  armor_legs: "armorLegsSprite",
  armor_weapon: "armorWeaponSprite",
} as const;

type LayerType = keyof typeof LAYER_SPRITE_KEYS;

const LAYER_TYPES = Object.keys(LAYER_SPRITE_KEYS) as LayerType[];

/** A sheet's name: the server's sprite entry ({name, templateUrl, imageUrl}), a template, or a bare name. */
function sheetName(sheet: any): string | null {
  if (typeof sheet === "string") return sheet || null;
  return sheet && typeof sheet.name === "string" ? sheet.name : null;
}

/** Marks each built layer with the name of the sheet it was asked to draw (a template given directly keeps its own). */
export function nameLayerSheets(layers: Partial<Record<LayerType, any>>, sprites: Partial<Record<string, any>>): void {
  for (const type of LAYER_TYPES) {
    const layer = layers[type];
    if (layer) layer.sheetName = sheetName(sprites[LAYER_SPRITE_KEYS[type]]) ?? sheetName(layer.spriteSheet);
  }
}

/** Whether a look names other sheets than the layers draw (a layer that is not there draws none). */
export function layerSheetsChanged(layeredAnim: any, sprites: any): boolean {
  if (!layeredAnim?.layers) return true;
  return LAYER_TYPES.some((type) => {
    const layer = layeredAnim.layers[type];
    const drawn = layer ? layer.sheetName ?? sheetName(layer.spriteSheet) : null;
    return drawn !== sheetName(sprites?.[LAYER_SPRITE_KEYS[type]]);
  });
}
