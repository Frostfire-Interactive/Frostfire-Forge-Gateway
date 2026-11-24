

import {
  extractFramesFromSpriteSheet,
  buildAnimationFrames,
  preloadSpriteSheetImage,
  validateSpriteSheetTemplate
} from './spritesheetParser.js';
import { nameLayerSheets } from './layersheets.ts';
import { switchLayers } from './layerswitch.ts';

const spriteSheetCache: SpriteSheetCache = {};

const animationFrameCache: Map<string, AnimationFrame[]> = new Map();

const pendingAnimationFrameBuilds: Map<string, Promise<AnimationFrame[]>> = new Map();

const spriteSheetTemplateCache: Map<string, Promise<any>> = new Map();

// Fetch sprite sheet template from asset server with caching
async function fetchSpriteSheetTemplate(templateUrl: string): Promise<any> {
  // Return cached template if available
  if (spriteSheetTemplateCache.has(templateUrl)) {
    return spriteSheetTemplateCache.get(templateUrl)!;
  }

  // Create fetch promise and cache it immediately to prevent duplicate requests
  const fetchPromise = (async () => {
    try {
      const response = await fetch(templateUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch sprite template: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      // Remove from cache on error so it can be retried
      spriteSheetTemplateCache.delete(templateUrl);
      console.error(`Error fetching sprite template from ${templateUrl}:`, error);
      throw error;
    }
  })();

  spriteSheetTemplateCache.set(templateUrl, fetchPromise);
  return fetchPromise;
}

// Helper to convert SpriteUrl to SpriteSheetTemplate
async function resolveSpriteUrl(spriteUrl: any): Promise<any> {
  // If it's already a template, return it
  if (spriteUrl.frameWidth) {
    return spriteUrl;
  }

  // If it has templateUrl, fetch the template
  if (spriteUrl.templateUrl) {
    const template = { ...(await fetchSpriteSheetTemplate(spriteUrl.templateUrl)) };

    // Extract base URL from templateUrl
    const baseUrl = spriteUrl.templateUrl.substring(0, spriteUrl.templateUrl.indexOf('?'));
    const assetServerUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/'));

    if (spriteUrl.imageUrl) {
      // Equipment sprite with shared template - use the equipment's specific image
      template.imageSource = spriteUrl.imageUrl;
    } else if (template.imageSource) {
      // Body/head sprite - convert imageSource relative path to full asset server URL
      const baseName = template.imageSource.split('/').pop()?.replace('.png', '');
      if (baseName) {
        template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(baseName)}`;
      } else {
        template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(template.name)}`;
      }
    } else {
      template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(template.name)}`;
    }

    return template;
  }

  if (spriteUrl.imageUrl) {
    const createDirections = (frameDuration: number, loop: boolean) => ({
      down: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      up: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      left: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      right: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      downleft: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      downright: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      upleft: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      upright: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } }
    });

    return {
      name: spriteUrl.name,
      imageSource: spriteUrl.imageUrl,
      frameWidth: 64,
      frameHeight: 64,
      columns: 1,
      rows: 1,
      animations: {
        idle: { directions: createDirections(1000, false) },
        walk: { directions: createDirections(150, true) },
        mount_idle: { directions: createDirections(1000, false) },
        mount_walk: { directions: createDirections(200, true) },
        cast_idle: { directions: createDirections(1000, false) },
        cast_walk: { directions: createDirections(150, true) }
      }
    };
  }

  throw new Error(`Invalid sprite data: ${JSON.stringify(spriteUrl)}`);
}

async function resolveWornSprite(spriteUrl: any): Promise<any> {
  try {
    return await resolveSpriteUrl(spriteUrl);
  } catch (error) {
    console.warn(`Worn sprite sheet "${spriteUrl?.name}" could not be loaded, so it is not drawn:`, error);
    return null;
  }
}

/** The same for a worn item's layer, whose image may fail to load. */
async function wornLayer(
  type: 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  zIndex: number,
  isMounted: boolean
): Promise<AnimationLayer | null> {
  try {
    return await createAnimationLayer(type, spriteSheet, animationName, zIndex, isMounted);
  } catch (error) {
    console.warn(`Worn sprite sheet "${spriteSheet?.name}" could not be drawn:`, error);
    return null;
  }
}

export async function initializeLayeredAnimation(
  mountSprite: Nullable<SpriteSheetTemplate>,
  bodySprite: Nullable<SpriteSheetTemplate>,
  headSprite: Nullable<SpriteSheetTemplate>,
  armorHelmetSprite: Nullable<SpriteSheetTemplate>,
  armorShoulderguardsSprite: Nullable<SpriteSheetTemplate>,
  armorNeckSprite: Nullable<SpriteSheetTemplate>,
  armorHandsSprite: Nullable<SpriteSheetTemplate>,
  armorChestSprite: Nullable<SpriteSheetTemplate>,
  armorFeetSprite: Nullable<SpriteSheetTemplate>,
  armorLegsSprite: Nullable<SpriteSheetTemplate>,
  armorWeaponSprite: Nullable<SpriteSheetTemplate>,
  initialAnimation: string = 'idle'
): Promise<LayeredAnimation> {

  // Resolve sprite URLs to full templates (handles both SpriteUrl and SpriteSheetTemplate)
  let resolvedMount = mountSprite;
  let resolvedBody = bodySprite;
  let resolvedHead = headSprite;
  let resolvedArmorHelmet = armorHelmetSprite;
  let resolvedArmorShoulderguards = armorShoulderguardsSprite;
  let resolvedArmorNeck = armorNeckSprite;
  let resolvedArmorHands = armorHandsSprite;
  let resolvedArmorChest = armorChestSprite;
  let resolvedArmorFeet = armorFeetSprite;
  let resolvedArmorLegs = armorLegsSprite;
  let resolvedArmorWeapon = armorWeaponSprite;

  // Resolve any SpriteUrl objects to full templates
  if (mountSprite && ((mountSprite as any).templateUrl || (mountSprite as any).imageUrl)) {
    resolvedMount = await resolveSpriteUrl(mountSprite);
  }
  if (bodySprite && ((bodySprite as any).templateUrl || (bodySprite as any).imageUrl)) {
    resolvedBody = await resolveSpriteUrl(bodySprite);
  }
  if (headSprite && ((headSprite as any).templateUrl || (headSprite as any).imageUrl)) {
    resolvedHead = await resolveSpriteUrl(headSprite);
  }
  if (armorHelmetSprite && ((armorHelmetSprite as any).templateUrl || (armorHelmetSprite as any).imageUrl)) {
    resolvedArmorHelmet = await resolveWornSprite(armorHelmetSprite);
  }
  if (armorShoulderguardsSprite && ((armorShoulderguardsSprite as any).templateUrl || (armorShoulderguardsSprite as any).imageUrl)) {
    resolvedArmorShoulderguards = await resolveWornSprite(armorShoulderguardsSprite);
  }
  if (armorNeckSprite && ((armorNeckSprite as any).templateUrl || (armorNeckSprite as any).imageUrl)) {
    resolvedArmorNeck = await resolveWornSprite(armorNeckSprite);
  }
  if (armorHandsSprite && ((armorHandsSprite as any).templateUrl || (armorHandsSprite as any).imageUrl)) {
    resolvedArmorHands = await resolveWornSprite(armorHandsSprite);
  }
  if (armorChestSprite && ((armorChestSprite as any).templateUrl || (armorChestSprite as any).imageUrl)) {
    resolvedArmorChest = await resolveWornSprite(armorChestSprite);
  }
  if (armorFeetSprite && ((armorFeetSprite as any).templateUrl || (armorFeetSprite as any).imageUrl)) {
    resolvedArmorFeet = await resolveWornSprite(armorFeetSprite);
  }
  if (armorLegsSprite && ((armorLegsSprite as any).templateUrl || (armorLegsSprite as any).imageUrl)) {
    resolvedArmorLegs = await resolveWornSprite(armorLegsSprite);
  }
  if (armorWeaponSprite && ((armorWeaponSprite as any).templateUrl || (armorWeaponSprite as any).imageUrl)) {
    resolvedArmorWeapon = await resolveWornSprite(armorWeaponSprite);
  }

  if (resolvedMount && !validateSpriteSheetTemplate(resolvedMount)) {
    throw new Error('Invalid mount sprite sheet template');
  }
  if (resolvedBody && !validateSpriteSheetTemplate(resolvedBody)) {
    throw new Error('Invalid body sprite sheet template');
  }
  if (resolvedHead && !validateSpriteSheetTemplate(resolvedHead)) {
    throw new Error('Invalid head sprite sheet template');
  }
  if (resolvedArmorHelmet && !validateSpriteSheetTemplate(resolvedArmorHelmet)) {
    throw new Error('Invalid armor helmet sprite sheet template');
  }
  if (resolvedArmorShoulderguards && !validateSpriteSheetTemplate(resolvedArmorShoulderguards)) {
    throw new Error('Invalid armor shoulderguards sprite sheet template');
  }
  if (resolvedArmorNeck && !validateSpriteSheetTemplate(resolvedArmorNeck)) {
    throw new Error('Invalid armor neck sprite sheet template');
  }
  if (resolvedArmorHands && !validateSpriteSheetTemplate(resolvedArmorHands)) {
    throw new Error('Invalid armor hands sprite sheet template');
  }
  if (resolvedArmorChest && !validateSpriteSheetTemplate(resolvedArmorChest)) {
    throw new Error('Invalid armor chest sprite sheet template');
  }
  if (resolvedArmorFeet && !validateSpriteSheetTemplate(resolvedArmorFeet)) {
    throw new Error('Invalid armor feet sprite sheet template');
  }
  if (resolvedArmorLegs && !validateSpriteSheetTemplate(resolvedArmorLegs)) {
    throw new Error('Invalid armor legs sprite sheet template');
  }
  if (resolvedArmorWeapon && !validateSpriteSheetTemplate(resolvedArmorWeapon)) {
    throw new Error('Invalid armor weapon sprite sheet template');
  }

  const isMounted = resolvedMount !== null;

  const mountLayer = resolvedMount
    ? await createAnimationLayer('mount', resolvedMount, initialAnimation, -1, false)
    : null;

  const bodyLayer = resolvedBody
    ? await createAnimationLayer('body', resolvedBody, initialAnimation, 0, isMounted)
    : null;

  const armorNeckLayer = resolvedArmorNeck
    ? await wornLayer('armor_neck', resolvedArmorNeck, initialAnimation, 1, isMounted)
    : null;

  const armorHandsLayer = resolvedArmorHands
    ? await wornLayer('armor_hands', resolvedArmorHands, initialAnimation, 2, isMounted)
    : null;

  const armorChestLayer = resolvedArmorChest
    ? await wornLayer('armor_chest', resolvedArmorChest, initialAnimation, 3, isMounted)
    : null;

  const armorFeetLayer = resolvedArmorFeet
    ? await wornLayer('armor_feet', resolvedArmorFeet, initialAnimation, 4, isMounted)
    : null;

  const armorLegsLayer = resolvedArmorLegs
    ? await wornLayer('armor_legs', resolvedArmorLegs, initialAnimation, 5, isMounted)
    : null;

  const headLayer = resolvedHead
    ? await createAnimationLayer('head', resolvedHead, initialAnimation, 6, isMounted)
    : null;

  const armorHelmetLayer = resolvedArmorHelmet
    ? await wornLayer('armor_helmet', resolvedArmorHelmet, initialAnimation, 7, isMounted)
    : null;

  const armorShoulderguardsLayer = resolvedArmorShoulderguards
    ? await wornLayer('armor_shoulderguards', resolvedArmorShoulderguards, initialAnimation, 8, isMounted)
    : null;

  const armorWeaponLayer = resolvedArmorWeapon
    ? await wornLayer('armor_weapon', resolvedArmorWeapon, initialAnimation, 9, isMounted)
    : null;

  const layers = {
    mount: mountLayer as AnimationLayer,
    body: bodyLayer as AnimationLayer,
    head: headLayer as AnimationLayer,
    armor_helmet: armorHelmetLayer as AnimationLayer,
    armor_shoulderguards: armorShoulderguardsLayer as AnimationLayer,
    armor_neck: armorNeckLayer as AnimationLayer,
    armor_hands: armorHandsLayer as AnimationLayer,
    armor_chest: armorChestLayer as AnimationLayer,
    armor_feet: armorFeetLayer as AnimationLayer,
    armor_legs: armorLegsLayer as AnimationLayer,
    armor_weapon: armorWeaponLayer as AnimationLayer,
  };
  // A worn item's template carries a base sheet's name; each layer keeps the sheet it was asked for (layersheets.ts).
  nameLayerSheets(layers, {
    mountSprite, bodySprite, headSprite, armorHelmetSprite, armorShoulderguardsSprite, armorNeckSprite,
    armorHandsSprite, armorChestSprite, armorFeetSprite, armorLegsSprite, armorWeaponSprite,
  });

  return {
    layers,
    currentAnimationName: initialAnimation,
    _animAppliedAt: performance.now(),
    syncFrames: true
  };
}

async function createAnimationLayer(
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  zIndex: number,
  isMounted: boolean = false
): Promise<AnimationLayer> {

  const normalizedName = spriteSheet.name.toLowerCase();
  const imageSource = (spriteSheet as any).imageData || spriteSheet.imageSource;
  const cacheKey = `${normalizedName}:${imageSource}`;

  if (!spriteSheetCache[cacheKey]) {

    const image = await preloadSpriteSheetImage(imageSource);

    const extractedFramesMap = await extractFramesFromSpriteSheet(image, spriteSheet);

    const extractedFrames: { [frameIndex: number]: HTMLImageElement } = {};
    if (extractedFramesMap instanceof Map) {
      extractedFramesMap.forEach((value, key) => {
        extractedFrames[key] = value;
      });
    } else {
      Object.assign(extractedFrames, extractedFramesMap);
    }

    const clonedTemplate = JSON.parse(JSON.stringify(spriteSheet));

    spriteSheetCache[cacheKey] = {
      imageElement: image,
      template: clonedTemplate,
      extractedFrames,
      extractedFramesMap: new Map<number, HTMLImageElement>(Object.entries(extractedFrames).map(([k, v]) => [Number(k), v]))
    };
  }

  const cached = spriteSheetCache[cacheKey];

  let actualAnimationName = animationName;
  const isArmorLayer = type.startsWith('armor_');
  if (isMounted && (type === 'body' || type === 'head' || isArmorLayer)) {
    if (animationName.startsWith('idle_')) {

      actualAnimationName = animationName.replace('idle_', 'mount_idle_');
    } else if (animationName.startsWith('walk_')) {

      actualAnimationName = animationName.replace('walk_', 'mount_walk_');
    }
  }

  const frameCacheKey = `${type}:${cacheKey}`;
  const frames = await getOrBuildAnimationFrames(
    frameCacheKey,
    actualAnimationName,
    spriteSheet,
    cached.extractedFramesMap
  );

  const layer: any = {
    type,
    spriteSheet,
    frames,
    currentFrame: 0,
    lastFrameTime: performance.now(),
    zIndex,
    visible: true,
    _cacheKey: cacheKey
  };
  return layer as AnimationLayer;
}

export function updateLayeredAnimation(
  layeredAnim: LayeredAnimation,
  deltaTime: number
): void {
  const now = performance.now();
  const layers = Object.values(layeredAnim.layers).filter(l => l !== null) as AnimationLayer[];

  if (layers.length === 0) return;

  // Update each layer's animation independently based on its frame duration
  for (const layer of layers) {
    if (layer.frames.length === 0) continue;

    // Initialize lastFrameTime if not set
    if (!layer.lastFrameTime) {
      layer.lastFrameTime = now;
      layer.currentFrame = 0;
    }

    if (!layer.frames[layer.currentFrame]) continue;

    // Advance every frame whose time has passed; after a long gap (hidden tab)
    // drop the backlog instead of replaying it one frame per tick.
    for (let steps = 0; ; steps++) {
      const frameDuration = layer.frames[layer.currentFrame]?.delay || 125;
      if (now - layer.lastFrameTime < frameDuration) break;
      if (steps >= layer.frames.length) { layer.lastFrameTime = now; break; }
      layer.currentFrame = (layer.currentFrame + 1) % layer.frames.length;
      layer.lastFrameTime += frameDuration;
    }
  }
}

async function getOrBuildAnimationFrames(
  spriteName: string,
  animationName: string,
  spriteSheet: SpriteSheetTemplate,
  extractedFrames: Map<number, HTMLImageElement>
): Promise<AnimationFrame[]> {
  const cacheKey = `${spriteName}:${animationName}`;

  // Return cached frames if available
  if (animationFrameCache.has(cacheKey)) {
    return animationFrameCache.get(cacheKey)!;
  }

  // Check if this animation is already being built by another request
  if (pendingAnimationFrameBuilds.has(cacheKey)) {
    return pendingAnimationFrameBuilds.get(cacheKey)!;
  }

  // Build and cache the frames
  const buildPromise = buildAnimationFrames(spriteSheet, animationName, extractedFrames)
    .then(frames => {
      animationFrameCache.set(cacheKey, frames);
      pendingAnimationFrameBuilds.delete(cacheKey);
      return frames;
    })
    .catch(err => {
      pendingAnimationFrameBuilds.delete(cacheKey);
      throw err;
    });

  pendingAnimationFrameBuilds.set(cacheKey, buildPromise);
  return buildPromise;
}

// A layer's frames for a pose: given as they are when built already (to switch at once: layerswitch.ts), else built.
function layerFramesFor(layer: AnimationLayer, newAnimationName: string, isMounted: boolean): AnimationFrame[] | null | Promise<AnimationFrame[] | null> {
  const cacheKey = (layer as any)._cacheKey;
  const cached = spriteSheetCache[cacheKey];
  let actualAnimationName = newAnimationName;
  const isArmorLayer = layer.type.startsWith('armor_');
  if (isMounted && (layer.type === 'body' || layer.type === 'head' || isArmorLayer)) {
    if (newAnimationName.startsWith('idle_')) {
      actualAnimationName = newAnimationName.replace('idle_', 'mount_idle_');
    } else if (newAnimationName.startsWith('walk_')) {
      actualAnimationName = newAnimationName.replace('walk_', 'mount_walk_');
    }
  }
  // Check if animation exists
  let animationExists = false;
  if (cached.template.animations[actualAnimationName]) {
    animationExists = true;
  } else if (actualAnimationName.includes('_')) {
    const lastUnderscoreIndex = actualAnimationName.lastIndexOf('_');
    const baseName = actualAnimationName.substring(0, lastUnderscoreIndex);
    const direction = actualAnimationName.substring(lastUnderscoreIndex + 1);
    if (cached.template.animations[baseName]?.directions?.[direction]) {
      animationExists = true;
    }
  }
  if (!animationExists) return null;
  const built = animationFrameCache.get(`${layer.type}:${cacheKey}:${actualAnimationName}`);
  if (built) return built;
  return getOrBuildAnimationFrames(`${layer.type}:${cacheKey}`, actualAnimationName, cached.template, cached.extractedFramesMap);
}

export async function changeLayeredAnimation(
  layeredAnim: LayeredAnimation,
  newAnimationName: string
): Promise<void> {
  if (layeredAnim.currentAnimationName === newAnimationName) return;

  layeredAnim.currentAnimationName = newAnimationName;
  layeredAnim._animAppliedAt = performance.now();
  const changeToken =
    ((layeredAnim as any)._animChangeToken = ((layeredAnim as any)._animChangeToken || 0) + 1);

  const isMounted = layeredAnim.layers.mount !== null;

  // Every layer's frames first, then all layers switch together from the same start: switched one at a time, the
  // layers drew different poses, or the same pose out of step, until each caught up.
  const layers = Object.values(layeredAnim.layers).filter(
    (layer): layer is AnimationLayer => !!layer && !!layer.spriteSheet && !!spriteSheetCache[(layer as any)._cacheKey]
  );
  const framesFor = (layer: AnimationLayer) => layerFramesFor(layer, newAnimationName, isMounted);

  switchLayers(
    layers,
    framesFor,
    () => (layeredAnim as any)._animChangeToken === changeToken,
    () => performance.now()
  ).catch(err => console.error('Error updating animation layers:', err));
}

/** Builds a character's frames for `names` ahead of time, so a change to one of them switches at once (the walk out
 *  of a portal, built while its walk in goes on, is not drawn with the walk in's frames while built). */
export function warmPoses(layeredAnim: LayeredAnimation | null | undefined, names: string[]): void {
  if (!layeredAnim) return;
  const isMounted = layeredAnim.layers.mount !== null;
  for (const layer of Object.values(layeredAnim.layers)) {
    if (!layer || !layer.spriteSheet || !spriteSheetCache[(layer as any)._cacheKey]) continue;
    for (const name of names) {
      const frames = layerFramesFor(layer as AnimationLayer, name, isMounted);
      if (frames instanceof Promise) frames.catch(() => {});
    }
  }
}

export function getLayerStillFrame(
  layer: AnimationLayer | null | undefined,
  animationName: string = "idle_down"
): { image: HTMLImageElement; width: number; height: number } | null {
  if (!layer) return null;
  const cached = spriteSheetCache[(layer as any)._cacheKey];
  if (!cached) return null;
  const template: any = cached.template;
  const split = animationName.lastIndexOf("_");
  const base = split > 0 ? animationName.substring(0, split) : animationName;
  const direction = split > 0 ? animationName.substring(split + 1) : "down";
  const animation = template?.animations?.[base];
  const pose = animation?.directions?.[direction] ?? animation?.directions?.down ?? animation;
  const frameIndex = Array.isArray(pose?.frames) ? pose.frames[0] : undefined;
  if (frameIndex === undefined) return null;
  const image = cached.extractedFramesMap.get(Number(frameIndex));
  if (!image?.complete || !image.naturalWidth) return null;
  return {
    image,
    width: Number(template.frameWidth) || image.naturalWidth,
    height: Number(template.frameHeight) || image.naturalHeight,
  };
}

export function getVisibleLayersSorted(layeredAnim: LayeredAnimation): AnimationLayer[] {
  const layers = Object.values(layeredAnim.layers)
    .filter(l => l !== null && l.visible) as AnimationLayer[];

  const animName = layeredAnim.currentAnimationName;
  const direction = animName.split('_').pop() || '';
  const isUpDirection = direction === 'up' || direction === 'upleft' || direction === 'upright';
  const isLeftDirection = direction === 'left' || direction === 'upleft';

  return layers.map(layer => {

    if (isUpDirection) {
      if (layer.type === 'armor_shoulderguards') {

        return { ...layer, zIndex: 5.3 };
      }
      if (layer.type === 'armor_weapon') {

        return { ...layer, zIndex: -2 };
      }
    }

    if (isLeftDirection) {
      if (layer.type === 'armor_weapon') {

        return { ...layer, zIndex: -2 };
      }
    }
    return layer;
  }).sort((a, b) => a.zIndex - b.zIndex);
}

