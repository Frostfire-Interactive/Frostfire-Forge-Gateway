const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)");

function backButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tl-btn tl-back";
  button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg><span>Back to game</span>';
  button.addEventListener("click", () => {
    window.close();
    // A window that would not close (the browser kept it): the game's window is asked to come forward at least.
    setTimeout(() => { try { window.opener?.focus(); } catch { /* not allowed: the window stays as it is */ } }, 300);
  });
  return button;
}

function install(): void {
  if (!window.opener) return;
  const bar = document.querySelector(".tl-topbar");
  if (!bar) return;
  const button = backButton();
  const place = () => {
    button.hidden = !TOUCH.matches;
    if (bar.firstElementChild !== button) bar.prepend(button);
  };
  place();
  new MutationObserver(place).observe(bar, { childList: true });
  TOUCH.addEventListener("change", place);
}

function noPinchZoom(): void {
  if (!TOUCH.matches) return;
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
}

function sidePane(): void {
  const app = document.querySelector<HTMLElement>(".tl-app.me-app, .tl-app.an-app");
  const bar = app?.querySelector(".tl-topbar");
  if (!app || !bar || !app.querySelector(".tl-side")) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tl-icon-btn tl-list-toggle";
  toggle.setAttribute("aria-label", "Show or hide the side panel");
  toggle.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01"/></svg>';
  toggle.addEventListener("click", () => app.classList.toggle("is-list-open"));
  new MutationObserver(() => { if (toggle.disabled) toggle.disabled = false; }).observe(toggle, { attributes: true, attributeFilter: ["disabled"] });
  const scrim = document.createElement("div");
  scrim.className = "tl-scrim";
  scrim.addEventListener("click", () => app.classList.remove("is-list-open"));
  app.appendChild(scrim);
  const place = () => {
    const back = bar.querySelector(":scope > .tl-back");
    const wanted = back ? back.nextElementSibling : bar.firstElementChild;
    if (wanted !== toggle) bar.insertBefore(toggle, back ? back.nextSibling : bar.firstChild);
  };
  place();
  new MutationObserver(place).observe(bar, { childList: true });
}

function keepToScreen(): void {
  if (!TOUCH.matches) return;
  const settle = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable) return;
    if (window.scrollX !== 0 || window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0) window.scrollTo(0, 0);
    document.documentElement.style.setProperty("--tl-vh", `${Math.round(window.visualViewport?.height || window.innerHeight)}px`);
  };
  const soon = () => { for (const delay of [0, 120, 400, 900]) setTimeout(settle, delay); };
  document.documentElement.classList.add("tl-touch");
  soon();
  for (const type of ["resize", "orientationchange", "pageshow", "focus"]) window.addEventListener(type, soon);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(); });
  // (and when a field gives the keyboard back)
  document.addEventListener("focusout", soon);
  window.visualViewport?.addEventListener("resize", settle);
  window.visualViewport?.addEventListener("scroll", settle);
}

if (typeof document !== "undefined") {
  noPinchZoom();
  keepToScreen();
  const ready = () => { install(); sidePane(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
}

export {};
