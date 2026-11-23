import { applyItemFrame } from "./itemframe.js";
import { icon, type IconName } from "./toolicons.js";
// On a touch screen, a way back to the game in every window built from this.
import "./toolback.js";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function brandName(): string {
  return document.documentElement.dataset.brandName || "Frostfire Forge";
}

export { icon, svg, type IconName } from "./toolicons.js";

// ------------------------------------------------------- words and numbers

export const shown = (username: unknown): string => {
  const name = String(username ?? "");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export function words(value: unknown): string {
  const text = String(value ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const WHOLE = new Intl.NumberFormat();

/** 1204 -> "1,204". */
export const num = (value: number): string => WHOLE.format(Math.round(value));

/** 2.34 -> "2.3", 12 -> "12": one decimal while the number is small enough for it to matter. */
export function short(value: number): string {
  return Math.abs(value) < 10 && !Number.isInteger(value) ? value.toFixed(1) : num(value);
}

/** "1 player", "4 players". */
export function count(value: number, one: string, many = `${one}s`): string {
  return `${num(value)} ${value === 1 ? one : many}`;
}

/** 93784 -> "1 d 2 h", 11520 -> "3 h 12 min", 75 -> "1 min 15 s". The two largest units that are not zero. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const parts: Array<[number, string]> = [[Math.floor(s / 86400), "d"], [Math.floor((s % 86400) / 3600), "h"], [Math.floor((s % 3600) / 60), "min"], [s % 60, "s"]];
  const from = parts.findIndex(([value]) => value > 0);
  if (from < 0) return "0 s";
  return parts.slice(from, from + 2).filter(([value], i) => i === 0 || value > 0).map(([value, unit]) => `${value} ${unit}`).join(" ");
}

/** 512 -> "512 MB", 1536 -> "1.5 GB". */
export function memory(megabytes: number): string {
  if (megabytes < 1024) return `${num(megabytes)} MB`;
  const gigabytes = megabytes / 1024;
  return `${gigabytes >= 100 ? num(gigabytes) : gigabytes.toFixed(gigabytes >= 10 ? 1 : 2).replace(/\.?0+$/, "")} GB`;
}

/** The time of day, as the admin's own machine writes it. */
export function clock(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString([], seconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

/** "Today, 14:02", "Yesterday, 21:14", "4 Oct, 10:50". */
export function dayAndTime(ms: number, now = Date.now()): string {
  const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(ms)) / 86400000);
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day}, ${clock(ms)}`;
}

/** "just now", "4 min ago", "3 h ago", then the day and time. */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return dayAndTime(ms, now);
}

/** "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------- feedback

/** Where toasts are stacked: the page's own #tl-toasts, or one made on the spot. */
function toastHost(): HTMLElement {
  let host = document.getElementById("tl-toasts");
  if (!host) {
    host = el("div", "tl-toasts");
    host.id = "tl-toasts";
    document.body.appendChild(host);
  }
  return host;
}

export function toast(text: string, kind: "info" | "warning" | "error" = "info"): void {
  const host = toastHost();
  const box = el("div", `tl-toast tl-toast-${kind}`);
  box.setAttribute("role", kind === "error" ? "alert" : "status");
  // What the server answers is passed on as it is: it may be a refusal in its own words, so it is not dressed as a success.
  box.appendChild(icon(kind === "info" ? "info" : "alert", 16));
  const [first, ...rest] = text.split("\n");
  const said = el("div", "tl-toast-words");
  said.appendChild(el("div", "tl-toast-text", first));
  if (rest.length) said.appendChild(el("div", "tl-toast-more", rest.join("\n")));
  box.appendChild(said);
  const close = el("button", "tl-icon-btn tl-toast-close");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.appendChild(icon("close", 14));
  box.appendChild(close);

  let timer: ReturnType<typeof setTimeout>;
  const leave = () => {
    box.classList.add("is-leaving");
    setTimeout(() => box.remove(), 180);
  };
  const wait = () => (timer = setTimeout(leave, kind === "error" ? 9000 : kind === "warning" ? 7000 : 5000));
  close.addEventListener("click", leave);
  box.addEventListener("pointerenter", () => clearTimeout(timer));
  box.addEventListener("pointerleave", wait);
  host.appendChild(box);
  while (host.childElementCount > 4) host.firstElementChild?.remove();
  wait();
}

export interface ConfirmOptions {
  /** The question, naming what it is about: "Delete Iron Sword?" */
  title: string;
  /** What happens on yes, in a sentence or two. Several strings are several paragraphs. */
  body: string | string[];
  /** What the yes button says: the action, not "OK". */
  okLabel: string;
  cancelLabel?: string;
  /** False for a question whose yes loses nothing. Dangerous by default: the yes button is red. */
  danger?: boolean;
  /** Nothing is being asked: there is only something to read, and one button to close it. */
  notice?: boolean;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const danger = options.danger !== false;
    const dialog = el("dialog", "tl-dialog");
    const badge = el("div", "tl-dialog-badge" + (danger ? "" : " tl-dialog-badge-plain"));
    badge.appendChild(icon(danger ? "alert" : "info", 20));
    const heading = el("h2", "tl-dialog-title", options.title);
    heading.id = "tl-dialog-title";
    const lines = Array.isArray(options.body) ? options.body : [options.body];
    const body = lines.length === 1 ? el("p", "tl-dialog-body", lines[0]) : el("div", "tl-dialog-body");
    if (lines.length > 1) for (const line of lines) body.appendChild(el("p", "", line));
    body.id = "tl-dialog-body";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", body.id);
    const said = el("div", "tl-dialog-words");
    said.append(heading, body);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (agreed: boolean) => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(agreed);
    };
    const actions = el("div", "tl-dialog-actions");
    const cancel = el("button", "tl-btn", options.cancelLabel ?? "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(false));
    const ok = el("button", options.notice ? "tl-btn" : `tl-btn ${danger ? "tl-btn-danger-solid" : "tl-btn-primary"}`, options.okLabel);
    ok.type = "button";
    ok.addEventListener("click", () => answer(true));
    if (options.notice) actions.append(ok);
    else actions.append(cancel, ok);
    dialog.append(top, actions);
    // A click on the dimmed page around the box is a no, and so is Escape.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer(false);
    });
    dialog.addEventListener("close", () => answer(false));
    document.body.appendChild(dialog);
    dialog.showModal();
    (options.notice ? ok : cancel).focus();
  });
}

export function noticeDialog(title: string, body: string | string[]): Promise<boolean> {
  return confirmDialog({ title, body, okLabel: "Close", notice: true });
}

export function leaveDialog(name: string): Promise<"save" | "discard" | "stay"> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "tl-dialog tl-dialog-three");
    const badge = el("div", "tl-dialog-badge tl-dialog-badge-plain");
    badge.appendChild(icon("save", 20));
    const heading = el("h2", "tl-dialog-title", "Save your changes before leaving?");
    heading.id = "tl-leave-title";
    const body = el("p", "tl-dialog-body", `What you changed in ${name} has not been saved. Leaving it without saving loses those changes.`);
    body.id = "tl-leave-body";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", body.id);
    const said = el("div", "tl-dialog-words");
    said.append(heading, body);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (choice: "save" | "discard" | "stay") => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(choice);
    };
    const choice = (label: string, value: "save" | "discard" | "stay", kind: string) => {
      const btn = el("button", `tl-btn${kind}`, label);
      btn.type = "button";
      btn.dataset.choice = value;
      btn.addEventListener("click", () => answer(value));
      return btn;
    };
    const actions = el("div", "tl-dialog-actions");
    const save = choice("Save and leave", "save", " tl-btn-primary");
    actions.append(choice("Keep editing", "stay", ""), choice("Discard changes", "discard", " tl-btn-danger"), save);
    dialog.append(top, actions);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer("stay");
    });
    dialog.addEventListener("close", () => answer("stay"));
    document.body.appendChild(dialog);
    dialog.showModal();
    save.focus();
  });
}

export interface AskOptions {
  /** What is being asked for: "New loot table". */
  title: string;
  /** A sentence on what to type and what happens with it. */
  body?: string;
  /** What the field holds: "Name". */
  label: string;
  /** What the yes button says: the action, not "OK". */
  okLabel: string;
  /** What the field starts with, selected so that typing replaces it. */
  value?: string;
  icon?: IconName;
  /** The most that can be typed. No limit unless given. */
  maxLength?: number;
  /** Cleans up what was typed before it counts as an answer. An answer that comes out empty is not accepted. */
  tidy?(typed: string): string;
  check?(answer: string): string | null;
  /** A class of the tool's own on the box, to tell it from a yes-or-no question. */
  className?: string;
}

export function askText(options: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "tl-dialog" + (options.className ? ` ${options.className}` : ""));
    const badge = el("div", "tl-dialog-badge tl-dialog-badge-plain");
    badge.appendChild(icon(options.icon ?? "pencil", 20));
    const heading = el("h2", "tl-dialog-title", options.title);
    heading.id = "tl-ask-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const said = el("div", "tl-dialog-words");
    said.appendChild(heading);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    const input = el("input", "tl-input");
    input.type = "text";
    input.id = "tl-ask-input";
    if (options.maxLength) input.maxLength = options.maxLength;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = options.value ?? "";
    if (options.body) {
      const body = el("p", "tl-dialog-body", options.body);
      body.id = "tl-ask-body";
      said.appendChild(body);
      input.setAttribute("aria-describedby", body.id);
    }
    const label = el("label", "tl-field-label", options.label);
    label.htmlFor = input.id;
    const field = el("div", "tl-field tl-dialog-field");
    field.append(label, input);
    // The problem with an answer, said under the field. toolfields.ts has the same for a field of a form.
    const complain = (message: string | null) => {
      field.querySelector(".tl-field-error")?.remove();
      field.classList.toggle("has-error", !!message);
      if (!message) return void input.removeAttribute("aria-invalid");
      input.setAttribute("aria-invalid", "true");
      const line = el("span", "tl-field-error");
      line.setAttribute("role", "alert");
      line.append(icon("alert", 13), el("span", "", message));
      field.appendChild(line);
    };

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (value: string | null) => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const submit = () => {
      const typed = input.value.trim();
      const value = options.tidy ? options.tidy(typed) : typed;
      // With nothing typed there is nothing to send: the field asks again, in the words of `check` when it has any.
      const wrong = options.check ? options.check(value) ?? (value ? null : "") : value ? null : "";
      if (wrong !== null) {
        if (wrong) complain(wrong);
        return input.focus();
      }
      answer(value);
    };
    const actions = el("div", "tl-dialog-actions");
    const cancel = el("button", "tl-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(null));
    const ok = el("button", "tl-btn tl-btn-primary", options.okLabel);
    ok.type = "button";
    ok.addEventListener("click", submit);
    actions.append(cancel, ok);
    input.addEventListener("input", () => complain(null));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      submit();
    });
    dialog.append(top, field, actions);
    // A click on the dimmed page around the box is a no, and so is Escape.
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      answer(null);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer(null);
    });
    dialog.addEventListener("close", () => answer(null));
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

export interface DialogParts {
  dialog: HTMLDialogElement;
  /** Under the title: a search field, a filter. Hidden while empty. */
  tools: HTMLElement;
  /** The part that scrolls. */
  body: HTMLElement;
  /** Buttons along the bottom. Hidden while empty. */
  foot: HTMLElement;
  close(): void;
}

export function openDialog(title: string, opts: { onClose?: () => void; keepOnOutsideClick?: boolean } = {}): DialogParts {
  const dialog = el("dialog", "tl-dialog tl-dialog-wide");
  const heading = el("h2", "tl-dialog-title", title);
  heading.id = "tl-dialog-wide-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const head = el("div", "tl-dialog-head");
  const shut = el("button", "tl-icon-btn");
  shut.type = "button";
  shut.setAttribute("aria-label", "Close");
  shut.appendChild(icon("close", 16));
  head.append(heading, shut);
  const tools = el("div", "tl-dialog-tools");
  const body = el("div", "tl-dialog-scroll");
  const foot = el("div", "tl-dialog-foot");
  dialog.append(head, tools, body, foot);

  // Done once, at once: the browser only says "closed" when it next draws.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    opts.onClose?.();
  };
  shut.addEventListener("click", close);
  // keepOnOutsideClick: a form that would lose what was typed stays open; only its buttons and Escape close it
  if (!opts.keepOnOutsideClick) dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("close", close);
  document.body.appendChild(dialog);
  dialog.showModal();
  // Parts nobody filled take no room.
  queueMicrotask(() => {
    tools.hidden = tools.childElementCount === 0;
    foot.hidden = foot.childElementCount === 0;
  });
  return { dialog, tools, body, foot, close };
}

let tipBox: HTMLElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;
let tipWatch: ReturnType<typeof setInterval> | null = null;
const tipped = new WeakSet<HTMLElement>();

function hideTip(): void {
  if (tipTimer) clearTimeout(tipTimer);
  if (tipWatch) clearInterval(tipWatch);
  tipTimer = tipWatch = null;
  tipBox?.remove();
  tipBox = null;
}

function showTip(node: HTMLElement): void {
  hideTip();
  const text = node.dataset.tip;
  if (!text || !node.isConnected) return;
  const box = el("div", "tl-tooltip", text);
  box.setAttribute("role", "tooltip");
  // Inside an open dialog, or it would be drawn behind it.
  (node.closest("dialog") ?? document.body).appendChild(box);
  const at = node.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.min(window.innerWidth - size.width - 8, Math.max(8, at.left + at.width / 2 - size.width / 2));
  const below = at.bottom + 6;
  const top = below + size.height > window.innerHeight - 8 ? at.top - size.height - 6 : below;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  tipBox = box;
  // The control may be redrawn away from under it.
  tipWatch = setInterval(() => {
    if (!node.isConnected) hideTip();
  }, 400);
}

export function tooltip<T extends HTMLElement>(node: T, text: string): T {
  node.dataset.tip = text;
  if (tipped.has(node)) return node;
  tipped.add(node);
  node.addEventListener("pointerenter", () => {
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(node), 350);
  });
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("pointerdown", hideTip);
  node.addEventListener("focus", () => {
    if (node.matches(":focus-visible")) showTip(node);
  });
  node.addEventListener("blur", hideTip);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
  return node;
}

// ------------------------------------------------------------------- parts

export interface ButtonOptions {
  icon?: IconName;
  kind?: "primary" | "danger" | "danger-solid" | "quiet" | "quiet-danger";
  small?: boolean;
  /** As wide as what it sits in. */
  block?: boolean;
  /** Under 1200px wide only the icon shows; the label becomes the tooltip. */
  fold?: boolean;
  /** "Add another": a dashed outline the width of the list it adds to. */
  add?: boolean;
  /** Words for a tooltip. */
  tip?: string;
}

/** A button: an icon if it has one, then its label. */
export function button(label: string, onClick: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const btn = el("button", "tl-btn" + (opts.kind ? ` tl-btn-${opts.kind}` : "") + (opts.small ? " tl-btn-sm" : "") + (opts.block ? " tl-btn-block" : "") + (opts.fold ? " tl-btn-fold" : "") + (opts.add ? " tl-btn-add" : ""));
  btn.type = "button";
  if (opts.icon) btn.appendChild(icon(opts.icon, opts.small ? 13 : 15));
  btn.appendChild(el("span", "", label));
  btn.addEventListener("click", onClick);
  if (opts.tip || opts.fold) tooltip(btn, opts.tip ?? label);
  return btn;
}

/** A button that is only an icon. The label is what a screen reader says and what the tooltip shows. */
export function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, opts: { danger?: boolean; size?: number } = {}): HTMLButtonElement {
  const btn = el("button", "tl-icon-btn" + (opts.danger ? " tl-icon-btn-danger" : ""));
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.appendChild(icon(name, opts.size ?? 16));
  btn.addEventListener("click", onClick);
  return tooltip(btn, label);
}

/** Puts another icon in a button made here, in place of the one it has: play for pause, an open lock for a closed one. */
export function setIcon<T extends HTMLElement>(btn: T, name: IconName, size = 16): T {
  btn.querySelector("svg")?.replaceWith(icon(name, size));
  return btn;
}

/** Shows a button as waiting for the server's answer, or as done waiting. */
export function setBusy(btn: HTMLElement | null, on: boolean): void {
  if (!btn) return;
  btn.classList.toggle("is-busy", on);
  if (on) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}

/** Grey a control out, with why. The first reason given stands. */
export function forbid<T extends HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(control: T, why: string): T {
  if (!control.disabled) {
    control.disabled = true;
    control.title = why;
    control.dataset.why = why;
  }
  return control;
}

export function tag(text: string, kind = "", name?: IconName): HTMLElement {
  const node = el("span", "tl-tag" + (kind ? ` tl-tag-${kind}` : ""));
  if (name) node.appendChild(icon(name, 12));
  node.appendChild(el("span", "", text));
  return node;
}

/** A state in a word: a dot (or an icon) and the word, in the colour of how things stand. */
export function pill(text: string, level = "", mark: IconName | "dot" = "dot"): HTMLElement {
  const node = el("span", "tl-pill" + (level ? ` tl-pill-${level}` : ""));
  node.append(mark === "dot" ? el("span", "tl-pill-dot") : icon(mark, 13), el("span", "", text));
  return node;
}

export function avatar(username: string, large = false): HTMLElement {
  const node = el("span", "tl-avatar" + (large ? " tl-avatar-lg" : ""), username.charAt(0).toUpperCase() || "?");
  node.setAttribute("aria-hidden", "true");
  return node;
}

export interface ThumbOptions {
  size?: "" | "lg" | "xl";
  /** The icon shown when there is no image, or none could be loaded. */
  fallback?: IconName;
  /** An item's quality: the square gets the game's rarity frame. */
  quality?: unknown;
  /** An image to try once if the first fails to load. */
  missing?: string | null;
  /** Load the image only when it scrolls into view: for a long grid, not for a list that is drawn again often. */
  lazy?: boolean;
}

const failedImages = new Map<string, number>();
const RETRY_IMAGE_MS = 60000;
const worthTrying = (src: string | null | undefined): src is string => !!src && Date.now() - (failedImages.get(src) ?? -RETRY_IMAGE_MS) >= RETRY_IMAGE_MS;

/** A square holding an icon. Without an image, or with one that will not load, it shows the fallback icon. */
export function thumb(image: string | null | undefined, opts: ThumbOptions = {}): HTMLElement {
  const box = el("span", "tl-thumb" + (opts.size ? ` tl-thumb-${opts.size}` : ""));
  box.setAttribute("aria-hidden", "true");
  if (opts.quality !== undefined) applyItemFrame(box, opts.quality);
  const size = opts.size === "xl" ? 22 : opts.size === "lg" ? 18 : 14;
  const blank = () => {
    if (opts.fallback) box.replaceChildren(icon(opts.fallback, size));
    else box.replaceChildren();
  };
  // The image itself, then the stand-in for a missing one. With no image at all there is nothing to stand in for.
  const sources = image ? [image, opts.missing].filter(worthTrying) : [];
  if (!sources.length) {
    blank();
    return box;
  }
  const img = el("img");
  img.alt = "";
  if (opts.lazy) img.loading = "lazy";
  let at = 0;
  img.addEventListener("error", () => {
    failedImages.set(sources[at], Date.now());
    at++;
    if (at < sources.length) img.src = sources[at];
    else blank();
  });
  img.src = sources[0];
  box.appendChild(img);
  return box;
}

/** A titled part of a page: what it is, a line on what it is for, and room for its controls. */
export function card(parent: HTMLElement, title: string, lead = ""): { root: HTMLElement; tools: HTMLElement; body: HTMLElement } {
  const root = el("section", "tl-card");
  const head = el("header", "tl-card-head");
  const said = el("div", "tl-card-words");
  said.appendChild(el("h2", "tl-card-title", title));
  if (lead) said.appendChild(el("p", "tl-card-lead", lead));
  const tools = el("div", "tl-card-tools");
  head.append(said, tools);
  const body = el("div", "tl-card-body");
  root.append(head, body);
  parent.appendChild(root);
  return { root, tools, body };
}

/** How many of them there are, beside a card's title. */
export function titleCount(cardRoot: HTMLElement, total: number): void {
  cardRoot.querySelector(".tl-card-title")?.appendChild(el("span", "tl-count", num(total)));
}

export interface SubcardOptions {
  title: string;
  /** A line under the title: what it is, or what it does. */
  lead?: string;
  thumb?: HTMLElement;
  /** Makes the head a button that opens the body and folds it away. */
  onToggle?(): void;
  /** With onToggle: whether the body shows now. */
  open?: boolean;
  /** Something in it is wrong: it is outlined in red, open or folded. */
  wrong?: boolean;
}

export function subcard(opts: SubcardOptions): { root: HTMLElement; fold: HTMLButtonElement | null; title: HTMLElement; lead: HTMLElement; tools: HTMLElement; body: HTMLElement } {
  const open = opts.onToggle ? !!opts.open : true;
  const root = el("div", "tl-subcard" + (opts.onToggle && open ? " is-open" : "") + (opts.wrong ? " has-error" : ""));
  const title = el("span", "tl-subcard-title", opts.title);
  const lead = el("span", "tl-subcard-lead", opts.lead ?? "");
  const said = el("span", "tl-subcard-words");
  said.append(title, lead);
  const tools = el("span", "tl-subcard-tools");
  const head = el("div", "tl-subcard-head");
  let fold: HTMLButtonElement | null = null;
  if (opts.onToggle) {
    fold = el("button", "tl-subcard-fold");
    fold.type = "button";
    fold.setAttribute("aria-expanded", String(open));
    fold.appendChild(icon("chevronRight", 15));
    if (opts.thumb) fold.appendChild(opts.thumb);
    fold.appendChild(said);
    fold.addEventListener("click", opts.onToggle);
    head.appendChild(fold);
  } else {
    if (opts.thumb) head.appendChild(opts.thumb);
    head.appendChild(said);
  }
  head.appendChild(tools);
  const body = el("div", "tl-subcard-body");
  root.appendChild(head);
  if (open) root.appendChild(body);
  return { root, fold, title, lead, tools, body };
}

/** A boxed remark inside the page. Several lines are listed one under the other. */
export function note(text: string | string[], tone: "" | "warning" | "danger" | "plain" = "", name?: IconName): HTMLElement {
  const box = el("div", "tl-note" + (tone ? ` tl-note-${tone}` : ""));
  box.appendChild(icon(name ?? (tone === "danger" || tone === "warning" ? "alert" : "info"), 15));
  const said = el("div", "tl-note-words");
  for (const line of Array.isArray(text) ? text : [text]) said.appendChild(el("div", "", line));
  box.appendChild(said);
  return box;
}

export function empty(parent: HTMLElement, name: IconName, title: string, text = ""): HTMLElement {
  const box = el("div", "tl-empty");
  box.appendChild(icon(name, 22));
  box.appendChild(el("div", "tl-empty-title", title));
  if (text) box.appendChild(el("div", "tl-empty-text", text));
  parent.appendChild(box);
  return box;
}

/** A page that has nothing to show but a reason. */
export function screen(parent: HTMLElement, name: IconName, title: string, text: string): HTMLElement {
  const box = el("div", "tl-screen");
  const badge = el("div", "tl-screen-badge");
  badge.appendChild(icon(name, 26));
  box.append(badge, el("h2", "tl-screen-title", title), el("p", "tl-screen-text", text));
  parent.appendChild(box);
  return box;
}

export function segments<T extends string>(options: Array<[T, string]>, value: T | null, onPick: (value: T) => void, label = ""): HTMLElement {
  const group = el("div", "tl-seg");
  group.setAttribute("role", "radiogroup");
  if (label) group.setAttribute("aria-label", label);
  for (const [key, text] of options) {
    const btn = el("button", "tl-seg-item", text);
    btn.type = "button";
    btn.dataset.value = key;
    if (label) btn.dataset.fk = `seg:${label}:${key}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(key === value));
    btn.addEventListener("click", () => {
      for (const other of group.children) other.setAttribute("aria-checked", String(other === btn));
      onPick(key);
    });
    group.appendChild(btn);
  }
  arrowKeys(group);
  return group;
}

export function oneStop(group: HTMLElement): void {
  const choices = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  const usable = choices.filter((choice) => !(choice as HTMLButtonElement).disabled);
  const stop = usable.find((choice) => choice.getAttribute("aria-checked") === "true") ?? usable[0];
  for (const choice of choices) choice.tabIndex = choice === stop ? 0 : -1;
}

export function arrowKeys(group: HTMLElement): void {
  oneStop(group);
  // A pick made with the pointer moves the stop too, once the click has marked it.
  group.addEventListener("click", () => queueMicrotask(() => oneStop(group)));
  group.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const choices = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((choice) => !choice.disabled);
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? choices[0] : e.key === "End" ? choices[choices.length - 1] : choices[(at + step + choices.length) % choices.length];
    if (!next) return;
    e.preventDefault();
    // Picking may redraw the page; the page puts the focus back on the choice picked.
    next.focus();
    next.click();
  });
}

/** An on/off switch. `label` is its name for a screen reader; put the visible words beside it. */
export function switchControl(on: boolean, label: string, onToggle: (on: boolean) => void): HTMLButtonElement {
  const toggle = el("button", "tl-switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(on));
  toggle.setAttribute("aria-label", label);
  toggle.appendChild(el("span", "tl-switch-knob"));
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    onToggle(next);
  });
  return toggle;
}

/** A search field with its magnifying glass. */
export function searchBox(placeholder: string, onInput: (value: string) => void): { root: HTMLElement; input: HTMLInputElement } {
  const root = el("div", "tl-search");
  const input = el("input", "tl-input");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("input", () => onInput(input.value));
  root.append(icon("search", 15), input);
  return { root, input };
}
