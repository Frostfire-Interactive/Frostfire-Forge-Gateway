function detectMobileRenderer(): boolean {
  try {
    const override = new URLSearchParams(window.location.search).get("renderer");
    if (override === "mobile") return true;
    if (override === "desktop") return false;
  } catch {
    // Fall through to device detection.
  }
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports itself as a Mac; a Mac has no multi-touch screen.
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

export const MOBILE_RENDERER: boolean = detectMobileRenderer();

