// The character page (/character). USER REQUEST 2026-10-14: after realm selection, an account that has no character
// makes one here: it picks a class, and the gateway makes the character (src/systems/characters.ts). One character per
// account, named as the account is. An account made before characters existed starts over (the page says so first).
// The page is a full-screen character creation screen over the world's start area (js/web/startarea.ts): the classes
// down the left, the chosen class's description, stats, spells and starter items on the right, the world open between
// them, and Back and Create in the bar at the foot. A class has no picture of its own: its mark is the icon of its
// first spell.

interface CharacterClassView {
    id: number;
    name: string;
    description: string;
    stats: Record<string, number>;
    spells: { spell: string; level: number }[];
    items?: { item: string; quantity: number }[];
}

interface CharacterStatus {
    needed: boolean;
    startsOver: boolean;
    username: string;
    classes: CharacterClassView[];
    spellInfo: Record<string, { description: string; icon: string | null }>;
    itemInfo?: Record<string, { description: string; icon: string | null }>;
}

/** A spell or starter item as its slot and the line under the slots show it. */
interface SlotView {
    name: string;
    icon: string | null;
    /** In the slot's corner, as the game's slots show a count: the level a spell is learned at, an item's count. */
    badge: string;
    /** The same said in full, beside the name under the slots. */
    tag: string;
    description: string;
}

function readCookie(name: string): string | undefined {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(';').shift();
}

const characterToken = readCookie('token');
if (!characterToken) window.location.href = '/';

const ASSET_SERVER = '__VAR.ASSET_SERVER_URL__';

/** The base stats as the page names them, in the order shown. Percent ones say so. */
const STAT_LABELS: [string, string, string][] = [
    ['max_health', 'Health', ''],
    ['max_stamina', 'Stamina', ''],
    ['stat_damage', 'Damage', ''],
    ['stat_armor', 'Armor', ''],
    ['stat_critical_chance', 'Critical chance', '%'],
    ['stat_critical_damage', 'Critical damage', '%'],
    ['stat_avoidance', 'Avoidance', '%'],
];

let characterStatus: CharacterStatus | null = null;
let selectedClassId: number | null = null;
let creating = false;

const escapeHtml = (s: unknown): string =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const readable = (name: string): string => name.replace(/_/g, ' ');

/** An icon's address on the asset server: spells are under /sprite, items under /icon, both without the extension. */
function assetIcon(kind: 'sprite' | 'icon', icon: string | null | undefined): string | null {
    if (!icon) return null;
    return `${ASSET_SERVER}/${kind}?name=${encodeURIComponent(icon.replace(/\.(png|jpg|jpeg|gif)$/i, ''))}`;
}

/** A class's mark: the icon of its first spell, or null when it has none. */
function classEmblem(c: CharacterClassView): string | null {
    const first = c.spells[0];
    return first ? assetIcon('sprite', characterStatus?.spellInfo[first.spell]?.icon) : null;
}

/** The mark inside a round slot: the icon, or the class's first letter when there is no icon. */
function emblemHtml(c: CharacterClassView): string {
    const icon = classEmblem(c);
    return icon
        ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy">`
        : `<span class="cc-emblem-letter">${escapeHtml(c.name.charAt(0).toUpperCase())}</span>`;
}

function showError(message: string | null): void {
    const box = document.getElementById('error-message');
    if (!box) return;
    box.textContent = message ?? '';
    box.classList.toggle('show', !!message);
}

function authHeaders(json = false): Record<string, string> {
    return { 'Authorization': `Bearer ${characterToken}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function loadStatus(): Promise<void> {
    try {
        const response = await fetch('/api/character', { headers: authHeaders(), cache: 'no-store' });
        if (response.status === 401) { window.location.href = '/'; return; }
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            if (body?.redirect) { window.location.href = body.redirect; return; }
            throw new Error(body?.message || `The server answered ${response.status}`);
        }
        characterStatus = await response.json() as CharacterStatus;
    } catch (error) {
        showError(`The classes could not be loaded: ${(error as Error)?.message ?? error}. Refresh the page to try again.`);
        return;
    }
    // Nothing to make (a character already, or no classes to choose from): on into the game.
    if (!characterStatus.needed) { window.location.href = '/game'; return; }

    const warning = document.getElementById('starts-over');
    if (warning) warning.hidden = !characterStatus.startsOver;
    const confirmBox = document.getElementById('starts-over-confirm');
    if (confirmBox) confirmBox.hidden = !characterStatus.startsOver;
    renderClasses();
    // There is always a class in view: the first, until another is picked.
    const first = characterStatus.classes.find((c) => c.id === selectedClassId) ?? characterStatus.classes[0];
    if (first) selectClass(first.id, false);
    document.body.classList.add('cc-ready');
}

/** The classes down the left: a round slot with the class's mark, its name and the start of its description. */
function renderClasses(): void {
    const list = document.getElementById('class-list');
    if (!list || !characterStatus) return;
    list.innerHTML = characterStatus.classes.map((c) => `
        <button type="button" class="cc-class${c.id === selectedClassId ? ' selected' : ''}" role="option" data-class-id="${c.id}" aria-selected="${c.id === selectedClassId}" tabindex="${c.id === selectedClassId ? 0 : -1}">
            <span class="cc-emblem">${emblemHtml(c)}</span>
            <span class="cc-class-words">
                <span class="cc-class-name">${escapeHtml(c.name)}</span>
                <span class="cc-class-blurb">${escapeHtml(c.description || '')}</span>
            </span>
        </button>
    `).join('');
    list.querySelectorAll<HTMLElement>('.cc-class').forEach((row) => {
        row.addEventListener('click', () => selectClass(Number(row.dataset.classId)));
    });
}

function selectClass(id: number, scroll = true): void {
    if (!characterStatus || creating) return;
    const chosen = characterStatus.classes.find((c) => c.id === id);
    if (!chosen) return;
    const changed = selectedClassId !== id;
    selectedClassId = id;
    document.querySelectorAll<HTMLElement>('#class-list .cc-class').forEach((row) => {
        const on = Number(row.dataset.classId) === id;
        row.classList.toggle('selected', on);
        row.setAttribute('aria-selected', String(on));
        row.tabIndex = on ? 0 : -1;
    });
    renderHero(chosen);
    renderDetails(chosen);
    updateButton();

    // A new class's details start from the top and fade in; the chosen row comes into view in the list (which scrolls
    // sideways on a phone). The page itself does not scroll.
    const info = document.querySelector<HTMLElement>('.cc-info-scroll');
    info?.scrollTo({ top: 0 });
    if (changed && info) {
        info.classList.remove('cc-swap');
        void info.offsetWidth;
        info.classList.add('cc-swap');
    }
    if (scroll) {
        const row = document.querySelector<HTMLElement>(`#class-list .cc-class[data-class-id="${id}"]`);
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        row?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
    }
}

/** The chosen class's name and description, at the top of the details. */
function renderHero(c: CharacterClassView): void {
    const hero = document.getElementById('class-hero');
    if (!hero) return;
    hero.innerHTML = `
        <h2 class="cc-name">${escapeHtml(c.name)}</h2>
        <p class="cc-description">${escapeHtml(c.description || 'No description.')}</p>`;
}

/**
 * A row of slots (spells or items) and, under it, the one picked: its name, level or count, and description. Pointing
 * at a slot, focusing it or tapping it picks it; the first is picked to begin with.
 */
function slotsHtml(kind: string, views: SlotView[], none: string): string {
    if (views.length === 0) return `<p class="cc-none">${none}</p>`;
    const slots = views.map((v, i) => `
        <button type="button" class="cc-slot${i === 0 ? ' picked' : ''}" data-slot="${kind}" data-index="${i}" aria-label="${escapeHtml(`${v.name}, ${v.tag}`)}" aria-pressed="${i === 0}">
            ${v.icon ? `<img src="${escapeHtml(v.icon)}" alt="" loading="lazy">` : `<span class="cc-slot-letter">${escapeHtml(v.name.charAt(0).toUpperCase())}</span>`}
            ${v.badge ? `<span class="cc-slot-badge">${escapeHtml(v.badge)}</span>` : ''}
        </button>`).join('');
    return `<div class="cc-slots">${slots}</div><div class="cc-slot-info" data-slot-info="${kind}" aria-live="polite">${slotInfoHtml(views[0])}</div>`;
}

function slotInfoHtml(v: SlotView): string {
    return `
        <div class="cc-slot-info-head"><span class="cc-slot-info-name">${escapeHtml(v.name)}</span><span class="cc-slot-info-tag">${escapeHtml(v.tag)}</span></div>
        ${v.description ? `<p class="cc-slot-info-text">${escapeHtml(v.description)}</p>` : ''}`;
}

function renderDetails(c: CharacterClassView): void {
    const box = document.getElementById('class-details');
    if (!box || !characterStatus) return;
    // label and number only: the stats have no common scale to draw bars against
    const stats = STAT_LABELS.map(([key, label, unit]) => {
        const value = Number(c.stats[key]) || 0;
        return `<div class="cc-stat"><span class="cc-stat-label">${label}</span><span class="cc-stat-value">${escapeHtml(value)}${unit}</span></div>`;
    }).join('');
    const spells: SlotView[] = c.spells.map((s) => {
        const info = characterStatus!.spellInfo[s.spell];
        const start = s.level <= 1;
        return {
            name: readable(s.spell), icon: assetIcon('sprite', info?.icon), description: info?.description ?? '',
            badge: start ? '' : `Lv${s.level}`, tag: start ? 'Known from the start' : `Learned at level ${s.level}`,
        };
    });
    const items: SlotView[] = (c.items ?? []).map((i) => {
        const info = characterStatus!.itemInfo?.[i.item];
        return {
            name: readable(i.item), icon: assetIcon('icon', info?.icon), description: info?.description ?? '',
            badge: i.quantity > 1 ? `${i.quantity}` : '', tag: `x${i.quantity}`,
        };
    });
    box.innerHTML = `
        <h3 class="cc-section-title">Starting stats</h3>
        <div class="cc-stats">${stats}</div>
        <h3 class="cc-section-title">Spells</h3>
        ${slotsHtml('spells', spells, 'This class learns no spells.')}
        <h3 class="cc-section-title">Starter items</h3>
        ${slotsHtml('items', items, 'This class starts with no items.')}
    `;
    const lists: Record<string, SlotView[]> = { spells, items };
    box.querySelectorAll<HTMLElement>('.cc-slot').forEach((slot) => {
        const pick = () => {
            const kind = slot.dataset.slot as string;
            const view = lists[kind]?.[Number(slot.dataset.index)];
            const info = box.querySelector<HTMLElement>(`[data-slot-info="${kind}"]`);
            if (!view || !info) return;
            box.querySelectorAll<HTMLElement>(`.cc-slot[data-slot="${kind}"]`).forEach((other) => {
                other.classList.toggle('picked', other === slot);
                other.setAttribute('aria-pressed', String(other === slot));
            });
            info.innerHTML = slotInfoHtml(view);
        };
        slot.addEventListener('click', pick);
        slot.addEventListener('focus', pick);
        slot.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') pick(); });
    });
}

function updateButton(): void {
    const button = document.getElementById('create-button') as HTMLButtonElement | null;
    const confirmed = (document.getElementById('starts-over-checkbox') as HTMLInputElement | null)?.checked ?? false;
    if (!button || !characterStatus) return;
    button.disabled = creating || selectedClassId === null || (characterStatus.startsOver && !confirmed);
    button.textContent = creating ? 'Creating...' : 'Create';
}

async function createCharacter(): Promise<void> {
    if (creating || selectedClassId === null) return;
    creating = true;
    showError(null);
    updateButton();
    try {
        const response = await fetch('/api/character', {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ classId: selectedClassId }),
        });
        if (response.status === 401) { window.location.href = '/'; return; }
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) {
            // Made already (another tab), or the class is gone: the page as it now stands.
            showError(body?.message || `The character could not be made (the server answered ${response.status}).`);
            if (response.status === 409) await loadStatus();
            return;
        }
        window.location.href = '/game';
    } catch (error) {
        showError(`The character could not be made: ${(error as Error)?.message ?? error}`);
    } finally {
        creating = false;
        updateButton();
    }
}

const goBack = (): void => { window.location.href = '/realm-selection'; };

/** The arrow keys move through the classes (up and down, or left and right when they are a row on a phone). */
document.getElementById('class-list')?.addEventListener('keydown', (event) => {
    if (!characterStatus || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const classes = characterStatus.classes;
    const at = Math.max(0, classes.findIndex((c) => c.id === selectedClassId));
    const next = event.key === 'Home' ? 0
        : event.key === 'End' ? classes.length - 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? Math.max(0, at - 1)
        : Math.min(classes.length - 1, at + 1);
    const target = classes[next];
    if (!target) return;
    selectClass(target.id);
    document.querySelector<HTMLElement>(`#class-list .cc-class[data-class-id="${target.id}"]`)?.focus();
});

// Escape goes back to realm selection; Enter with nothing in focus makes the character.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { goBack(); return; }
    if (event.key === 'Enter' && (document.activeElement === document.body || !document.activeElement)) {
        event.preventDefault();
        const button = document.getElementById('create-button') as HTMLButtonElement | null;
        if (button && !button.disabled) void createCharacter();
    }
});

document.getElementById('create-button')?.addEventListener('click', () => void createCharacter());
document.getElementById('starts-over-checkbox')?.addEventListener('change', updateButton);

if (characterToken) void loadStatus();
