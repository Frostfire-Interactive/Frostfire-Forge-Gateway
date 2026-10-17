// The character page (/character). USER REQUEST 2026-10-14: after realm selection, an account that has no character
// makes one here: it picks a class, and the gateway makes the character (src/systems/characters.ts). One character per
// account, named as the account is. An account made before characters existed starts over (the page says so first).
// The page is a full-screen creator over the world's start area (js/web/startarea.ts): the classes on the left, the
// chosen one named large in the middle, its stats and spells on the right, and Create under it.

interface CharacterClassView {
    id: number;
    name: string;
    description: string;
    stats: Record<string, number>;
    spells: { spell: string; level: number }[];
}

interface CharacterStatus {
    needed: boolean;
    startsOver: boolean;
    username: string;
    classes: CharacterClassView[];
    spellInfo: Record<string, { description: string; icon: string | null }>;
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

    const subtitle = document.getElementById('character-subtitle');
    if (subtitle) subtitle.textContent = `Playing as ${characterStatus.username}`;
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

/** A colour of its own for each class, from its name, so the emblems differ without art. */
function hueOf(name: string): number {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return (h + 200) % 360;
}

/** A shield with the class's first letter. */
function emblem(c: CharacterClassView, size: 'small' | 'large' | 'head' = 'small'): string {
    const hue = hueOf(c.name);
    const id = `cc-emblem-${c.id}-${size}`;
    const letter = escapeHtml((c.name.trim()[0] || '?').toUpperCase());
    return `
        <svg class="cc-emblem cc-emblem-${size}" viewBox="0 0 40 46" aria-hidden="true">
            <defs>
                <linearGradient id="${id}" x1="0" y1="0" x2="0.9" y2="1">
                    <stop offset="0" stop-color="hsl(${hue} 65% 58%)"/>
                    <stop offset="1" stop-color="hsl(${(hue + 35) % 360} 70% 24%)"/>
                </linearGradient>
            </defs>
            <path d="M20 2.5 36.5 8.5v13c0 10.5-7.4 17.8-16.5 21.9C10.9 39.3 3.5 32 3.5 21.5v-13z" fill="url(#${id})" stroke="rgba(255, 236, 200, 0.55)" stroke-width="1.3"/>
            <path d="M20 6.5 33 11.3v10.2c0 8.3-5.8 14.2-13 17.6-7.2-3.4-13-9.3-13-17.6V11.3z" fill="none" stroke="rgba(255, 255, 255, 0.16)" stroke-width="1"/>
            <text x="20" y="28.5" text-anchor="middle" class="cc-emblem-letter">${letter}</text>
        </svg>`;
}

function renderClasses(): void {
    const list = document.getElementById('class-list');
    if (!list || !characterStatus) return;
    list.innerHTML = characterStatus.classes.map((c, i) => `
        <button type="button" class="cc-class${c.id === selectedClassId ? ' selected' : ''}" data-class-id="${c.id}" style="--i: ${i}" aria-pressed="${c.id === selectedClassId}">
            ${emblem(c)}
            <span class="cc-class-words">
                <span class="cc-class-name">${escapeHtml(c.name)}</span>
                <span class="cc-class-description">${escapeHtml(c.description || 'No description.')}</span>
            </span>
            <svg class="cc-class-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
    `).join('');
    list.querySelectorAll<HTMLElement>('.cc-class').forEach((card) => {
        card.addEventListener('click', () => selectClass(Number(card.dataset.classId)));
    });
}

function selectClass(id: number, scroll = true): void {
    if (!characterStatus || creating) return;
    const chosen = characterStatus.classes.find((c) => c.id === id);
    if (!chosen) return;
    selectedClassId = id;
    document.querySelectorAll<HTMLElement>('#class-list .cc-class').forEach((card) => {
        const on = Number(card.dataset.classId) === id;
        card.classList.toggle('selected', on);
        card.setAttribute('aria-pressed', String(on));
    });
    renderHero(chosen);
    renderDetails(chosen);
    updateButton();

    // On a phone the classes are a row that scrolls sideways: the chosen card comes into view in it (the page itself
    // does not scroll there), and its details start from the top.
    if (window.matchMedia('(max-width: 900px), (max-height: 520px)').matches) {
        const card = document.querySelector<HTMLElement>(`#class-list .cc-class[data-class-id="${id}"]`);
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (scroll) card?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
        document.querySelector('.cc-details')?.scrollTo({ top: 0 });
    }
}

/** The chosen class, large over the world. Drawn again so its entrance plays for each class. */
function renderHero(c: CharacterClassView): void {
    const hero = document.getElementById('class-hero');
    if (!hero) return;
    hero.innerHTML = `
        <div class="cc-hero-inner">
            ${emblem(c, 'large')}
            <h2 class="cc-hero-name">${escapeHtml(c.name)}</h2>
            <p class="cc-hero-description">${escapeHtml(c.description || 'No description.')}</p>
        </div>`;
}

function renderDetails(c: CharacterClassView): void {
    const box = document.getElementById('class-details');
    if (!box || !characterStatus) return;
    // each bar against the highest of that stat among the classes, so they compare at a glance
    const most = (key: string) => Math.max(1, ...characterStatus!.classes.map((k) => Number(k.stats[key]) || 0));
    const stats = STAT_LABELS.map(([key, label, unit]) => {
        const value = Number(c.stats[key]) || 0;
        const share = Math.round((value / most(key)) * 100);
        return `
        <div class="cc-stat">
            <span class="cc-stat-label">${label}</span>
            <span class="cc-stat-value">${escapeHtml(value)}${unit}</span>
            <span class="cc-stat-bar" aria-hidden="true"><span style="width: ${value > 0 ? Math.max(4, share) : 0}%"></span></span>
        </div>`;
    }).join('');
    const spells = c.spells.length === 0
        ? '<p class="cc-none">This class learns no spells.</p>'
        : `<ul class="cc-spells">${c.spells.map((s) => {
            const info = characterStatus!.spellInfo[s.spell];
            const icon = info?.icon ? `${ASSET_SERVER}/sprite?name=${encodeURIComponent(info.icon.replace(/\.(png|jpg|jpeg|gif)$/i, ''))}` : null;
            return `
            <li class="cc-spell">
                <span class="cc-spell-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy">` : ''}</span>
                <span class="cc-spell-words">
                    <span class="cc-spell-name">${escapeHtml(s.spell.replace(/_/g, ' '))}</span>
                    ${info?.description ? `<span class="cc-spell-description">${escapeHtml(info.description)}</span>` : ''}
                </span>
                <span class="cc-spell-level">${s.level <= 1 ? 'Start' : `Lv ${escapeHtml(s.level)}`}</span>
            </li>`;
        }).join('')}</ul>`;
    // (the heading only shows where the class is not named large over the world: a phone held sideways)
    box.innerHTML = `
        <div class="cc-details-head">${emblem(c, 'head')}<h2 class="cc-details-name">${escapeHtml(c.name)}</h2></div>
        <h3 class="cc-section-title">Starting stats</h3>
        <div class="cc-stats">${stats}</div>
        <h3 class="cc-section-title">Spells</h3>
        ${spells}
    `;
}

function updateButton(): void {
    const button = document.getElementById('create-button') as HTMLButtonElement | null;
    const confirmed = (document.getElementById('starts-over-checkbox') as HTMLInputElement | null)?.checked ?? false;
    if (!button || !characterStatus) return;
    button.disabled = creating || selectedClassId === null || (characterStatus.startsOver && !confirmed);
    const chosen = characterStatus.classes.find((c) => c.id === selectedClassId);
    button.textContent = creating ? 'Creating...' : chosen ? `Create ${chosen.name}` : 'Create Character';
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

document.getElementById('create-button')?.addEventListener('click', () => void createCharacter());
document.getElementById('starts-over-checkbox')?.addEventListener('change', updateButton);

if (characterToken) void loadStatus();
