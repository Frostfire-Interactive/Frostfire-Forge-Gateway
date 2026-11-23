/** The tools' icons, apart from the rest of the toolkit: the game window draws them too (stafftoolbar.ts),
 * and the toolkit also sets up the tool windows themselves. */

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** The icons: drawn on a 24 by 24 grid as strokes, in the colour of the text around them. */
export const ICONS = {
  dashboard: "M4 4h6.5v8H4z M13.5 4H20v4.5h-6.5z M13.5 12H20v8h-6.5z M4 15.5h6.5V20H4z",
  players: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19 M10 10.5A3.25 3.25 0 1 0 10 4a3.25 3.25 0 0 0 0 6.5z M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4 M15.5 4.2a3.25 3.25 0 0 1 0 6.1",
  megaphone: "M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1z M15 9a4.2 4.2 0 0 1 0 6 M18 6.5a8 8 0 0 1 0 11",
  server: "M4 5h16v6H4z M4 13h16v6H4z M7.5 8h.01 M7.5 16h.01",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a13.5 13.5 0 0 1 0 18 M12 3a13.5 13.5 0 0 0 0 18",
  box: "M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z M3.5 8 12 12.5 20.5 8 M12 12.5v8",
  refresh: "M21 5v5h-5 M3 19v-5h5 M5.2 9.5a7.5 7.5 0 0 1 12.4-2.8L21 10 M3 14l3.4 3.3a7.5 7.5 0 0 0 12.4-2.8",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  close: "M6 6l12 12 M18 6 6 18",
  alert: "M12 4 2.8 19.5h18.4z M12 10v4.5 M12 17h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01",
  lock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  shield: "M12 3l7.5 3v5.5c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V6z",
  eyeOff: "M3 3l18 18 M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4 M6.6 6.7A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.3 9.3 0 0 0 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  arrowDown: "M12 5v14 M6 13l6 6 6-6",
  user: "M18 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20 M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  chip: "M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4",
  gauge: "M4.5 17.5a8.5 8.5 0 1 1 15 0 M12 13.5l4-5.5",
  paw: "M12 20c-2.6 0-4.5-1.3-4.5-3.2 0-2.2 2.2-4.3 4.5-4.3s4.5 2.1 4.5 4.3c0 1.9-1.9 3.2-4.5 3.2z M6.2 11.5a1.6 1.9 0 1 0 0-3.8 1.6 1.9 0 0 0 0 3.8z M17.8 11.5a1.6 1.9 0 1 0 0-3.8 1.6 1.9 0 0 0 0 3.8z M9.6 8a1.6 2 0 1 0 0-4 1.6 2 0 0 0 0 4z M14.4 8a1.6 2 0 1 0 0-4 1.6 2 0 0 0 0 4z",
  power: "M12 3v9 M7 6.3a8 8 0 1 0 10 0",
  restart: "M20 12a8 8 0 1 1-2.6-5.9 M20 4v5h-5",
  trash: "M4 7h16 M9 7V4h6v3 M6.5 7l1 13h9l1-13 M10 11v5 M14 11v5",
  plus: "M12 5v14 M5 12h14",
  fish: "M3 12c3.2-4.4 9-5.6 13.6-2.2L21 7v10l-4.4-2.8C12 17.6 6.2 16.4 3 12z M8.5 11.2h.01",
  send: "M21 3 10.5 13.5 M21 3l-6.5 18-4-7.5L3 9.5z",
  cloud: "M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a3.75 3.75 0 0 1-.5 7.5z",
  wind: "M3 8h10a2.5 2.5 0 1 0-2.5-2.5 M3 12h15a2.5 2.5 0 1 1-2.5 2.5 M3 16h7",
  pin: "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  plug: "M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4",
  flame: "M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.2 1.6 1 2.5 2 2.7-.6-3 0-6 1-8.5z",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  key: "M14.5 9.5a4 4 0 1 0-3.6 4L8 16.5V19H5.5v-2.5l5.4-5.4 M15.5 8.5h.01",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  move: "M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M5.7 5.7l12.6 12.6",
  // Added for the editors.
  save: "M5 4h11l4 4v12H4V4z M8 4v5h7V4 M8 20v-6h8v6",
  copy: "M9 9h11v11H9z M6 15H4V4h11v2",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h10",
  image: "M4 5h16v14H4z M4 16l4.5-4.5 4 4 3-3L20 17 M9 10.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z",
  wand: "M5 19 15.5 8.5 M14 7l3 3 M18 3v3 M16.5 4.5h3 M20 10v2 M19 11h2 M10 3v2 M9 4h2",
  pencil: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  eye: "M2.5 12c1-2 4.5-6 9.5-6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  layers: "M12 3.5 3.5 8 12 12.5 20.5 8z M3.5 12 12 16.5 20.5 12 M3.5 16 12 20.5 20.5 16",
  bolt: "M13 3 5 13.5h6L10 21l8.5-11h-6z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12h.01",
  map: "M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z M9 4.5v13 M15 6.5v13",
  brush: "M19.5 4.5 10 14 M12.5 16.5l-5-5 M7.5 11.5l-1.2 1.2a3 3 0 0 0-.8 1.5l-1 5.3 5.3-1a3 3 0 0 0 1.5-.8l1.2-1.2",
  scroll: "M7 4h11v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-1h10v1a2 2 0 0 0 2 2 M7 4a2 2 0 0 0-2 2v10 M10 8.5h5 M10 12h5",
  coins: "M9 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M14.8 10.6a5 5 0 1 1-4.3 8",
  undo: "M4 9h10a5.5 5.5 0 0 1 0 11h-4 M8 5 4 9l4 4",
  grip: "M9 6h.01 M9 12h.01 M9 18h.01 M15 6h.01 M15 12h.01 M15 18h.01",
  more: "M6 12h.01 M12 12h.01 M18 12h.01",
  sparkle: "M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z M19 16.5v3 M17.5 18h3",
  sword: "M19.5 4.5h-4L7 13l4 4 8.5-8.5z M5.5 13.5l5 5 M4 20l3.5-3.5",
  bag: "M6 8.5h12l1 11.5H5z M9 8.5V7a3 3 0 0 1 6 0v1.5",
  folder: "M3.5 6.5h6l2 2.5h9v10.5h-17z",
  filter: "M4 5h16l-6 7.5V19l-4-2v-4.5z",
  // Added for the tools with a canvas or a map: playing and stepping, drawing tools, what stands in the world.
  play: "M7.5 5v14l11-7z",
  pause: "M8.5 5.5v13 M15.5 5.5v13",
  stop: "M6.5 6.5h11v11h-11z",
  back: "M19 12H5 M11 6l-6 6 6 6",
  redo: "M20 9H10a5.5 5.5 0 0 0 0 11h4 M16 5l4 4-4 4",
  history: "M4 12a8 8 0 1 0 2.6-5.9 M4 4v5h5 M12 8v4.5l3 1.5",
  eraser: "M20 20H9.5l-4.9-4.9a1.5 1.5 0 0 1 0-2.1L13 4.6a1.5 1.5 0 0 1 2.1 0l4.3 4.3a1.5 1.5 0 0 1 0 2.1L10.5 20 M8.6 9l6.4 6.4",
  paste: "M8.5 5H6v15h12V5h-2.5 M8.5 3.5h7v3h-7z M9 11.5h6 M9 15.5h4",
  grid: "M4 4h16v16H4z M4 9.33h16 M4 14.67h16 M9.33 4v16 M14.67 4v16",
  unlock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  route: "M6 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8.5 17h6a2.5 2.5 0 0 0 0-5h-5a2.5 2.5 0 0 1 0-5h6",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  headstone: "M7 20v-9a5 5 0 0 1 10 0v9 M4.5 20h15 M12 9.5v5 M10 11.5h4",
  portal: "M12 21a9 9 0 1 1 9-9 M12 17a5 5 0 1 1 5-5 M12 12h.01",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
} as const;

export type IconName = keyof typeof ICONS;

/** One icon, sized in pixels. It is decoration: the words beside it say what it means. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const node = svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  });
  node.classList.add("tl-icon");
  node.appendChild(svg("path", { d: ICONS[name] }));
  return node;
}
