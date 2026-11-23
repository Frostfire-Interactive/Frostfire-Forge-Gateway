export const DEFAULT_BRAND_NAME = "Frostfire Forge";
const BRAND_NAME_MAX = 40;

export const BRANDED_PAGES: ReadonlySet<string> = new Set([
  "/",
  "/registration",
  "/game",
  "/forgot-password",
  "/realm-selection",
  "/manage-profile",
  "/2fa-challenge",
  "/map-editor",
  "/zone-map",
  "/particle-editor",
  "/npc-editor",
  "/creature-editor",
  "/item-editor",
  "/mount-editor",
  "/cutscene-editor",
  "/spell-editor",
  "/weather-editor",
  "/class-editor",
  "/dungeon-editor",
  "/mailbox-editor",
  "/gathering-editor",
  "/achievement-editor",
  "/character",
  "/player-editor",
  "/control-panel",
  "/quest-editor",
  "/loot-editor",
  "/animator",
]);

export function cleanBrandName(raw: string | null | undefined): string {
  if (!raw) return "";
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return Array.from(flat).slice(0, BRAND_NAME_MAX).join("").trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Read once, when the process starts.
export const BRAND_NAME = cleanBrandName(process.env.BRAND_NAME);

function nameSwap(name: string) {
  let pending = "";
  return {
    text(chunk: HTMLRewriterTypes.Text) {
      pending += chunk.text;
      if (chunk.lastInTextNode) {
        chunk.replace(pending.split(DEFAULT_BRAND_NAME).join(name));
        pending = "";
      } else {
        chunk.remove();
      }
    },
  };
}

export function brandHtml(source: Response, name: string): Response {
  if (!name) return source;
  const attribute = escapeHtml(name);
  return new HTMLRewriter()
    .on("html", {
      element(el) {
        el.setAttribute("data-brand-name", attribute);
      },
    })
    .on("title, .site-brand-name, .tl-brand-name, .register-subtitle, .loading-brand span", nameSwap(name))
    .on("[aria-label]", {
      element(el) {
        const label = el.getAttribute("aria-label");
        if (label && label.includes(DEFAULT_BRAND_NAME)) el.setAttribute("aria-label", label.split(DEFAULT_BRAND_NAME).join(attribute));
      },
    })
    .transform(source);
}

export async function brandHtmlText(html: string): Promise<string> {
  if (!BRAND_NAME) return html;
  return await brandHtml(new Response(html), BRAND_NAME).text();
}

