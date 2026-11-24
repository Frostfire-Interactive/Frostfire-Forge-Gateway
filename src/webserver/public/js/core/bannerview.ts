/** Takes the zone text down at once (no fade): on a new map, and before a new zone's text is shown. */
export function clearBanner(el: HTMLElement): void {
  el.style.transition = "none";
  el.classList.remove("shown");
  el.textContent = "";
  void el.offsetWidth;
  el.style.transition = "";
}

/** Shows a zone's text in place of what was there. */
export function showBanner(el: HTMLElement, text: string): void {
  clearBanner(el);
  el.textContent = text;
  el.classList.add("shown");
}
