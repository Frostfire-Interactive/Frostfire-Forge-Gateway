import { characterListView, type CharacterRow } from '../core/characterlist';

interface CharacterClassView {
    id: number;
    name: string;
    description: string;
    stats: Record<string, number>;
    spells: { spell: string; level: number }[];
    items?: { item: string; quantity: number }[];
}

interface ClassCatalog {
    classes: CharacterClassView[];
    spellInfo: Record<string, { description: string; icon: string | null }>;
    itemInfo?: Record<string, { description: string; icon: string | null }>;
}

interface CharacterStatus extends ClassCatalog {
    needed: boolean;
    startsOver: boolean;
    username: string;
}

interface CharactersBody extends ClassCatalog {
    characters: { id: number; name: string; classId: number | null; className: string | null; level: number }[];
    limit: number;
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

/** list: the account's characters. create: a name and a class for a new one. pick: a class for the active one. */
type Mode = 'list' | 'create' | 'pick';

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

let mode: Mode = 'list';
let catalog: ClassCatalog = { classes: [], spellInfo: {} };
let startsOver = false;
let rows: CharacterRow[] = [];
let canCreate = false;
let selectedClassId: number | null = null;
let selectedCharacterId: number | null = null;
let busy = false;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const escapeHtml = (s: unknown): string =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const readable = (name: string): string => name.replace(/_/g, ' ');

/** An icon's address on the asset server: spells are under /sprite, items under /icon, both without the extension. */
function assetIcon(kind: 'sprite' | 'icon', icon: string | null | undefined): string | null {
    if (!icon) return null;
    return `${ASSET_SERVER}/${kind}?name=${encodeURIComponent(icon.replace(/\.(png|jpg|jpeg|gif)$/i, ''))}`;
}

const classOf = (id: number | null): CharacterClassView | undefined => catalog.classes.find((c) => c.id === id);

/** The mark inside a round slot: the class's first spell icon, or a letter when there is none. */
function emblemHtml(c: CharacterClassView | undefined, letterOf: string): string {
    const first = c?.spells[0];
    const icon = first ? assetIcon('sprite', catalog.spellInfo[first.spell]?.icon) : null;
    return icon
        ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy">`
        : `<span class="cc-emblem-letter">${escapeHtml(letterOf.charAt(0).toUpperCase())}</span>`;
}

function showError(message: string | null): void {
    const box = byId('error-message');
    if (!box) return;
    box.textContent = message ?? '';
    box.classList.toggle('show', !!message);
}

function authHeaders(json = false): Record<string, string> {
    return { 'Authorization': `Bearer ${characterToken}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

/** A request to the character API: the body on success, or null after showing why not (or leaving on 401). */
async function api<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: T | any } | null> {
    try {
        const response = await fetch(path, body === undefined
            ? { headers: authHeaders(), cache: 'no-store' }
            : { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) });
        if (response.status === 401) { window.location.href = '/'; return null; }
        const parsed = await response.json().catch(() => null);
        if (parsed?.redirect) { window.location.href = parsed.redirect; return null; }
        return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
        showError(`The server could not be reached: ${(error as Error)?.message ?? error}`);
        return null;
    }
}

const failure = (r: { status: number; body: any }, what: string): string =>
    r.body?.message || `${what} (the server answered ${r.status}).`;

async function load(): Promise<void> {
    const list = await api<CharactersBody>('/api/characters');
    if (!list) return;
    // A guest has one character: the list is not theirs, only its class pick.
    if (list.status === 403) { await loadPick(); return; }
    if (!list.ok) { showError(failure(list, 'The characters could not be loaded')); return; }
    catalog = list.body;
    const view = characterListView(list.body);
    rows = view.rows;
    canCreate = view.canCreate;
    if (!rows.some((r) => r.id === selectedCharacterId)) selectedCharacterId = rows[0]?.id ?? null;
    setMode(view.opensOnCreate ? 'create' : 'list');
    document.body.classList.add('cc-ready');
}

/** The guest's (or a classless character's) class pick, the page as it was before an account had a list. */
async function loadPick(): Promise<void> {
    const status = await api<CharacterStatus>('/api/character');
    if (!status) return;
    if (!status.ok) { showError(failure(status, 'The classes could not be loaded')); return; }
    const body = status.body as CharacterStatus;
    if (!body.needed) { window.location.href = '/game'; return; }
    catalog = body;
    startsOver = body.startsOver;
    setMode('pick');
    document.body.classList.add('cc-ready');
}

function setMode(next: Mode): void {
    mode = next;
    showError(null);
    closeDelete();
    const listing = mode === 'list';
    const listPanel = byId('list-panel');
    const classPanel = byId('class-panel');
    if (listPanel) listPanel.hidden = !listing;
    if (classPanel) classPanel.hidden = listing;
    const warning = byId('starts-over');
    if (warning) warning.hidden = !(mode === 'pick' && startsOver);
    const confirmBox = byId('starts-over-confirm');
    if (confirmBox) confirmBox.hidden = !(mode === 'pick' && startsOver);
    const nameField = byId('name-field');
    if (nameField) nameField.hidden = mode !== 'create';

    if (listing) {
        renderCharacters();
        if (selectedCharacterId !== null) selectCharacter(selectedCharacterId, false, true);
    } else {
        renderClasses();
        const first = classOf(selectedClassId) ?? catalog.classes[0];
        if (first) selectClass(first.id, false, true);
        else { selectedClassId = null; renderHero('Your character', null, ''); const box = byId('class-details'); if (box) box.innerHTML = ''; }
        if (mode === 'create') byId<HTMLInputElement>('name-input')?.focus();
    }
    updateButtons();
}

/** The characters down the left: the class's mark, the name, and its level and class. */
function renderCharacters(): void {
    const list = byId('character-list');
    if (!list) return;
    list.innerHTML = rows.map((r) => `
        <button type="button" class="cc-class" role="option" data-character-id="${r.id}" aria-selected="false" tabindex="-1">
            <span class="cc-emblem">${emblemHtml(classOf(r.classId), r.name)}</span>
            <span class="cc-class-words">
                <span class="cc-class-name">${escapeHtml(r.name)}</span>
                <span class="cc-class-blurb">${escapeHtml(r.label)}</span>
            </span>
        </button>
    `).join('');
    list.querySelectorAll<HTMLElement>('.cc-class').forEach((row) => {
        row.addEventListener('click', () => selectCharacter(Number(row.dataset.characterId)));
        row.addEventListener('dblclick', () => void play());
    });
}

/** The classes down the left: a round slot with the class's mark, its name and the start of its description. */
function renderClasses(): void {
    const list = byId('class-list');
    if (!list) return;
    list.innerHTML = catalog.classes.map((c) => `
        <button type="button" class="cc-class" role="option" data-class-id="${c.id}" aria-selected="false" tabindex="-1">
            <span class="cc-emblem">${emblemHtml(c, c.name)}</span>
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

/** Marks the chosen row of a list, and brings it into view (the list scrolls sideways on a phone). */
function markRow(listId: string, attr: string, id: number, scroll: boolean): void {
    let chosen: HTMLElement | null = null;
    document.querySelectorAll<HTMLElement>(`#${listId} .cc-class`).forEach((row) => {
        const on = Number(row.getAttribute(attr)) === id;
        row.classList.toggle('selected', on);
        row.setAttribute('aria-selected', String(on));
        row.tabIndex = on ? 0 : -1;
        if (on) chosen = row;
    });
    if (scroll && chosen) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        (chosen as HTMLElement).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
    }
}

/** A new pick's details start from the top. The page itself does not scroll. */
function swapDetails(_changed: boolean): void {
    document.querySelector<HTMLElement>('.cc-info-scroll')?.scrollTo({ top: 0 });
}

/** `force`: a selection the page makes itself (after loading), even while a request is in flight. */
function selectCharacter(id: number, scroll = true, force = false): void {
    const row = rows.find((r) => r.id === id);
    if (!row || (busy && !force)) return;
    const changed = selectedCharacterId !== id;
    selectedCharacterId = id;
    closeDelete();
    markRow('character-list', 'data-character-id', id, scroll);
    const c = classOf(row.classId);
    renderHero(row.name, row.label, c?.description ?? '');
    if (c) renderDetails(c); else { const box = byId('class-details'); if (box) box.innerHTML = ''; }
    swapDetails(changed);
    updateButtons();
}

function selectClass(id: number, scroll = true, force = false): void {
    const chosen = classOf(id);
    if (!chosen || (busy && !force)) return;
    const changed = selectedClassId !== id;
    selectedClassId = id;
    markRow('class-list', 'data-class-id', id, scroll);
    renderHero(chosen.name, null, chosen.description || 'No description.');
    renderDetails(chosen);
    swapDetails(changed);
    updateButtons();
}

/** The name (a character's or a class's), a character's level and class, and the class description. */
function renderHero(name: string, label: string | null, description: string): void {
    const hero = byId('class-hero');
    if (!hero) return;
    hero.innerHTML = `
        <h2 class="cc-name">${escapeHtml(name)}</h2>
        ${label ? `<p class="cc-description"><strong>${escapeHtml(label)}</strong></p>` : ''}
        ${description ? `<p class="cc-description">${escapeHtml(description)}</p>` : ''}`;
}

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
    const box = byId('class-details');
    if (!box) return;
    // label and number only: the stats have no common scale to draw bars against
    const stats = STAT_LABELS.map(([key, label, unit]) => {
        const value = Number(c.stats[key]) || 0;
        return `<div class="cc-stat"><span class="cc-stat-label">${label}</span><span class="cc-stat-value">${escapeHtml(value)}${unit}</span></div>`;
    }).join('');
    const spells: SlotView[] = c.spells.map((s) => {
        const info = catalog.spellInfo[s.spell];
        const start = s.level <= 1;
        return {
            name: readable(s.spell), icon: assetIcon('sprite', info?.icon), description: info?.description ?? '',
            badge: start ? '' : `Lv${s.level}`, tag: start ? 'Known from the start' : `Learned at level ${s.level}`,
        };
    });
    const items: SlotView[] = (c.items ?? []).map((i) => {
        const info = catalog.itemInfo?.[i.item];
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

function updateButtons(): void {
    const show = (id: string, on: boolean) => { const el = byId(id); if (el) el.hidden = !on; };
    show('new-button', mode === 'list' && canCreate);
    show('delete-button', mode === 'list' && selectedCharacterId !== null);
    show('play-button', mode === 'list');
    show('create-button', mode !== 'list');

    const play = byId<HTMLButtonElement>('play-button');
    if (play) {
        play.disabled = busy || selectedCharacterId === null;
        play.textContent = busy && mode === 'list' ? 'Entering...' : 'Play';
    }
    const create = byId<HTMLButtonElement>('create-button');
    if (create) {
        const confirmed = byId<HTMLInputElement>('starts-over-checkbox')?.checked ?? false;
        const named = (byId<HTMLInputElement>('name-input')?.value.trim().length ?? 0) > 0 && nameState !== 'taken';
        const noClasses = catalog.classes.length === 0;
        create.disabled = busy || (selectedClassId === null && !(mode === 'create' && noClasses))
            || (mode === 'create' && !named)
            || (mode === 'pick' && startsOver && !confirmed);
        create.textContent = busy && mode !== 'list' ? 'Creating...' : 'Create';
    }
    for (const id of ['new-button', 'delete-button']) {
        const b = byId<HTMLButtonElement>(id);
        if (b) b.disabled = busy;
    }
}

async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    showError(null);
    updateButtons();
    try { await work(); } finally { busy = false; updateButtons(); }
}

const play = (): Promise<void> => run(async () => {
    const row = rows.find((r) => r.id === selectedCharacterId);
    if (!row) return;
    const r = await api('/api/characters/play', { id: row.id });
    if (!r) return;
    if (!r.ok) { const message = failure(r, 'That character could not be played'); if (r.status === 404) await load(); showError(message); return; }
    // A character with no class yet picks one before the game.
    if (row.classId === null) { await loadPick(); return; }
    window.location.href = '/game';
});

const create = (): Promise<void> => run(async () => {
    if (selectedClassId === null && !(mode === 'create' && catalog.classes.length === 0)) return;
    if (mode === 'pick') {
        const r = await api('/api/character', { classId: selectedClassId });
        if (!r) return;
        if (!r.ok || !r.body?.ok) {
            // Made already (another tab), or the class is gone: the page as it now stands.
            const message = failure(r, 'The character could not be made');
            if (r.status === 409) await loadPick();
            showError(message);
            return;
        }
        window.location.href = '/game';
        return;
    }
    const name = byId<HTMLInputElement>('name-input')?.value.trim() ?? '';
    const r = await api<{ id: number }>('/api/characters', { name, classId: selectedClassId });
    if (!r) return;
    if (!r.ok) {
        // A name taken in the meantime shows as the cross at the name, not as a message.
        if (r.status === 409 && /name is taken/i.test(String(r.body?.message ?? ''))) { setNameState('taken', String(r.body.message)); return; }
        showError(failure(r, 'The character could not be made'));
        return;
    }
    const input = byId<HTMLInputElement>('name-input');
    if (input) input.value = '';
    setNameState('none');
    selectedCharacterId = Number(r.body?.id) || null;
    await load();
});

function openDelete(): void {
    const row = rows.find((r) => r.id === selectedCharacterId);
    const box = byId('delete-confirm');
    if (!row || !box) return;
    const title = byId('delete-title');
    if (title) title.textContent = `Delete ${row.name}?`;
    const input = byId<HTMLInputElement>('delete-name');
    if (input) { input.value = ''; input.placeholder = row.name; }
    box.hidden = false;
    updateDelete();
    input?.focus();
}

function closeDelete(): void {
    const box = byId('delete-confirm');
    if (box) box.hidden = true;
}

function updateDelete(): void {
    const row = rows.find((r) => r.id === selectedCharacterId);
    const typed = byId<HTMLInputElement>('delete-name')?.value.trim() ?? '';
    const yes = byId<HTMLButtonElement>('delete-yes');
    if (yes) yes.disabled = busy || !row || typed.toLowerCase() !== row.name.toLowerCase();
}

const remove = (): Promise<void> => run(async () => {
    const row = rows.find((r) => r.id === selectedCharacterId);
    if (!row) return;
    const confirmName = byId<HTMLInputElement>('delete-name')?.value.trim() ?? '';
    const r = await api('/api/characters/delete', { id: row.id, confirmName });
    if (!r) return;
    if (!r.ok) { showError(failure(r, 'That character could not be deleted')); return; }
    selectedCharacterId = null;
    await load();
});

/** Escape on the new-character screen goes back to the list, when there is one. */
function goBack(): void {
    if (busy) return;
    if (mode === 'create' && rows.length > 0) setMode('list');
}

type NameState = 'none' | 'checking' | 'free' | 'taken';
let nameState: NameState = 'none';
let nameTimer: ReturnType<typeof setTimeout> | undefined;
let nameAsked = 0;
const NAME_PATTERN = /^[A-Za-z0-9_]{3,15}$/;

function setNameState(state: NameState, reason = ''): void {
    nameState = state;
    const mark = byId('name-status');
    if (mark) {
        mark.textContent = state === 'free' ? '✓' : state === 'taken' ? '✗' : '';
        mark.className = `cc-name-status${state === 'free' || state === 'taken' ? ` ${state}` : ''}`;
        mark.title = reason;
        mark.setAttribute('aria-label', state === 'free' ? 'That name is free.' : reason);
    }
    updateButtons();
}

function onNameInput(): void {
    clearTimeout(nameTimer);
    const asked = ++nameAsked;
    const name = byId<HTMLInputElement>('name-input')?.value.trim() ?? '';
    if (!name) { setNameState('none'); return; }
    if (!NAME_PATTERN.test(name)) { setNameState('taken', 'Names are 3 to 15 letters, numbers or underscores.'); return; }
    setNameState('checking');
    nameTimer = setTimeout(async () => {
        try {
            const response = await fetch('/api/characters/name', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name }) });
            const body = await response.json().catch(() => null);
            if (asked !== nameAsked || !response.ok || !body) { if (asked === nameAsked) setNameState('none'); return; }
            setNameState(body.free ? 'free' : 'taken', body.free ? '' : String(body.message ?? 'That name is taken.'));
        } catch {
            if (asked === nameAsked) setNameState('none');
        }
    }, 300);
}

/** The arrow keys move through the list in view (up and down, or left and right when it is a row on a phone). */
function listKeys(event: KeyboardEvent, ids: number[], current: number | null, select: (id: number) => void, listId: string, attr: string): void {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || ids.length === 0) return;
    event.preventDefault();
    const at = Math.max(0, ids.indexOf(current ?? -1));
    const next = event.key === 'Home' ? 0
        : event.key === 'End' ? ids.length - 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? Math.max(0, at - 1)
        : Math.min(ids.length - 1, at + 1);
    select(ids[next]);
    document.querySelector<HTMLElement>(`#${listId} .cc-class[${attr}="${ids[next]}"]`)?.focus();
}

byId('class-list')?.addEventListener('keydown', (event) =>
    listKeys(event, catalog.classes.map((c) => c.id), selectedClassId, (id) => selectClass(id), 'class-list', 'data-class-id'));
byId('character-list')?.addEventListener('keydown', (event) =>
    listKeys(event, rows.map((r) => r.id), selectedCharacterId, (id) => selectCharacter(id), 'character-list', 'data-character-id'));

// Escape closes the delete box, or goes back; Enter plays or creates.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (!byId('delete-confirm')?.hidden) { closeDelete(); return; }
        goBack();
        return;
    }
    if (event.key !== 'Enter') return;
    const active = document.activeElement;
    if (active?.id === 'delete-name') {
        event.preventDefault();
        if (!byId<HTMLButtonElement>('delete-yes')?.disabled) void remove();
        return;
    }
    if (active && active !== document.body && active.id !== 'name-input' && !active.closest('#character-list')) return;
    event.preventDefault();
    const button = byId<HTMLButtonElement>(mode === 'list' ? 'play-button' : 'create-button');
    if (button && !button.disabled && !button.hidden) void (mode === 'list' ? play() : create());
});

byId('new-button')?.addEventListener('click', () => { if (!busy) setMode('create'); });
byId('delete-button')?.addEventListener('click', openDelete);
byId('delete-no')?.addEventListener('click', closeDelete);
byId('delete-yes')?.addEventListener('click', () => void remove());
byId('delete-name')?.addEventListener('input', updateDelete);
byId('play-button')?.addEventListener('click', () => void play());
byId('create-button')?.addEventListener('click', () => void create());
byId('name-input')?.addEventListener('input', onNameInput);
byId('starts-over-checkbox')?.addEventListener('change', updateButtons);

if (characterToken) void load();
