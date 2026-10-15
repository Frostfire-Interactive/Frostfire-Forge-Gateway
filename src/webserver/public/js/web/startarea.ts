// The world's start area behind the character page. USER REQUESTS 2026-10-14: "I want the character creator to pan over
// the starting area of the world (don't show players or creatures)"; "it's stuttery and loads in weird. At realm
// selection, we should pre-load the chunks".
//
// The realm's game server says which map its players start on and where (GET /start-area). A worker reads that part of
// the map from the asset server as the game does (/tileset, /map-chunk) and draws it into one picture: the map's tiles
// only, so no player, creature or NPC. The picture is kept in the browser's Cache Storage under the map's version, so
// the realm page makes it while the player picks a realm (window.startAreaPrepare) and the character page shows it at
// once. The pan is a CSS transform animation, run by the browser's compositor: nothing is drawn while it moves.
// Anything that fails leaves the backdrop empty; the pages work the same without it.
(() => {
    interface StartArea {
        name: string;
        assetServerUrl: string;
        width: number;
        height: number;
        tilewidth: number;
        tileheight: number;
        tilesets: any[];
        spawnX: number;
        spawnY: number;
        version?: string;
    }
    /**
     * Where the picture lies on the map, in map pixels, how far the view drifts from the spawn each way, and the
     * picture's pixels to a map pixel (k).
     */
    interface Geometry { ox: number; oy: number; w: number; h: number; panX: number; panY: number; k: number }

    /** The window the picture is made for: this screen's, within these bounds. A bigger one scales the picture up. */
    const VIEW_MIN = [1280, 720];
    const VIEW_MAX = [2560, 1440];
    /** The drift: a figure eight through the spawn, these many tiles out each way, once round in PAN_PERIOD_MS. */
    const PAN_TILES_X = 24;
    const PAN_TILES_Y = 12;
    const PAN_PERIOD_MS = 100000;
    /** Points on the figure eight the animation runs straight between. */
    const PAN_STEPS = 360;
    const CACHE_NAME = 'start-area-v1';
    /** Part of the cache key: raise it when the picture is made differently, so old ones are not shown. */
    const PICTURE_BUILD = 2;

    const normalizeHost = (host: string): string => (host === 'localhost' ? '127.0.0.1' : host);

    async function readStartArea(serverId: string): Promise<StartArea | null> {
        const list = await fetch('/api/gateway/servers', { cache: 'no-store' });
        if (!list.ok) return null;
        const server = ((await list.json())?.servers || []).find((s: any) => s.id === serverId);
        if (!server) return null;
        const protocol = server.useSSL ? 'https' : 'http';
        const response = await fetch(`${protocol}://${normalizeHost(server.publicHost)}:${server.port}/start-area`, { cache: 'no-store' });
        if (!response.ok) return null;
        const area = await response.json() as StartArea;
        return area?.name && Array.isArray(area.tilesets) && area.tilesets.length ? area : null;
    }

    function geometry(area: StartArea): Geometry {
        const tw = area.tilewidth, th = area.tileheight;
        const panX = PAN_TILES_X * tw, panY = PAN_TILES_Y * th;
        const mapW = area.width * tw, mapH = area.height * th;
        // the screen's size in steps of 128, so a window resized a little makes the same picture
        const fit = (size: number, i: number) => Math.min(VIEW_MAX[i]!, Math.max(VIEW_MIN[i]!, Math.ceil(size / 128) * 128));
        const viewW = fit(Math.max(window.screen?.width || 0, window.innerWidth), 0);
        const viewH = fit(Math.max(window.screen?.height || 0, window.innerHeight), 1);
        const w = Math.min(viewW + 2 * panX, mapW), h = Math.min(viewH + 2 * panY, mapH);
        const ox = Math.min(Math.max(0, Math.round(area.spawnX - w / 2)), mapW - w);
        const oy = Math.min(Math.max(0, Math.round(area.spawnY - h / 2)), mapH - h);
        // Two picture pixels to a map pixel on a high density screen: the browser then draws it a screen pixel for
        // each, so it stays crisp while it moves smoothly between pixels (filtered, not snapped: snapped, a diagonal
        // drift steps across and down at different moments and judders).
        const k = (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1;
        return { ox, oy, w, h, panX, panY, k };
    }

    /**
     * The worker's whole code, run from its own source (it reads nothing outside itself). Given the area and the
     * picture's place on the map, it answers with the picture as a PNG blob, or an error.
     */
    function pictureWorker(): void {
        const HIDDEN = ['collision', 'nopvp', 'no-pvp', 'shadow'];
        const CHUNK_SIZES: Record<number, number> = { 16: 64, 32: 32, 64: 16 };
        // a tileset as the game reads it: PNG bytes, gzip or zlib compressed (pako.inflate takes either), base64
        async function tileset(assetServer: string, ts: any): Promise<ImageBitmap | null> {
            const name = String(ts?.image ?? '').split('/').pop();
            if (!name) return null;
            const response = await fetch(`${assetServer}/tileset?name=${encodeURIComponent(name)}`);
            if (!response.ok) return null;
            const raw = atob((await response.json())?.data ?? '');
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const format = bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip' : 'deflate';
            const png = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).blob();
            return createImageBitmap(new Blob([png], { type: 'image/png' }));
        }
        self.onmessage = async (event: MessageEvent) => {
            try {
                const { area, g } = event.data;
                const tw = area.tilewidth, th = area.tileheight;
                const chunkSize = CHUNK_SIZES[tw] || 32;
                const images = await Promise.all(area.tilesets.map((ts: any) => tileset(area.assetServerUrl, ts).catch(() => null)));
                // every drawable gid, as the game's tile atlas finds it (core/glmap/resources.ts): a later tileset wins
                const tiles: { img: ImageBitmap; sx: number; sy: number; sw: number; sh: number }[] = [];
                area.tilesets.forEach((ts: any, i: number) => {
                    const img = images[i];
                    const cols = Math.floor(Number(ts.imagewidth) / Number(ts.tilewidth));
                    if (!img || !(cols > 0)) return;
                    for (let local = 0; local < Number(ts.tilecount); local++) {
                        tiles[Number(ts.firstgid) + local] = { img, sx: (local % cols) * ts.tilewidth, sy: Math.floor(local / cols) * ts.tileheight, sw: ts.tilewidth, sh: ts.tileheight };
                    }
                });
                if (!tiles.length) throw new Error('no tileset could be read');

                const chunkW = chunkSize * tw, chunkH = chunkSize * th;
                const wanted: { x: number; y: number }[] = [];
                for (let y = Math.floor(g.oy / chunkH); y <= Math.floor((g.oy + g.h - 1) / chunkH); y++) {
                    for (let x = Math.floor(g.ox / chunkW); x <= Math.floor((g.ox + g.w - 1) / chunkW); x++) wanted.push({ x, y });
                }
                const chunks = await Promise.all(wanted.map(({ x, y }) =>
                    fetch(`${area.assetServerUrl}/map-chunk?map=${encodeURIComponent(area.name)}&x=${x}&y=${y}&size=${chunkSize}`)
                        .then((r) => (r.ok ? r.json() : null))
                        .then((data) => ({ x, y, data }))
                        .catch(() => ({ x, y, data: null }))));

                const canvas = new OffscreenCanvas(g.w * g.k, g.h * g.k);
                const c = canvas.getContext('2d')!;
                c.imageSmoothingEnabled = false;
                c.fillStyle = '#05080f';
                c.fillRect(0, 0, g.w * g.k, g.h * g.k);
                for (const { x, y, data } of chunks) {
                    const layers = (Array.isArray(data?.layers) ? data.layers : [])
                        .filter((l: any) => !HIDDEN.some((h) => String(l?.name ?? '').toLowerCase().includes(h)))
                        .sort((a: any, b: any) => Number(a.zIndex) - Number(b.zIndex));
                    // the chunk's cells that fall in the picture
                    const left = x * chunkW - g.ox, top = y * chunkH - g.oy;
                    const c0 = Math.max(0, Math.floor(-left / tw)), c1 = Math.min(chunkSize - 1, Math.floor((g.w - 1 - left) / tw));
                    const r0 = Math.max(0, Math.floor(-top / th)), r1 = Math.min(chunkSize - 1, Math.floor((g.h - 1 - top) / th));
                    for (const layer of layers) {
                        const cells: number[] = Array.isArray(layer.data) ? layer.data : [];
                        const w = Number(layer.width) || chunkSize;
                        for (let r = r0; r <= r1; r++) {
                            for (let col = c0; col <= c1; col++) {
                                const gid = cells[r * w + col];
                                const tile = gid ? tiles[gid] : undefined;
                                if (tile) c.drawImage(tile.img, tile.sx, tile.sy, tile.sw, tile.sh, (left + col * tw) * g.k, (top + r * th) * g.k, tw * g.k, th * g.k);
                            }
                        }
                    }
                }
                (self as any).postMessage({ blob: await canvas.convertToBlob({ type: 'image/png' }) });
            } catch (error) {
                (self as any).postMessage({ error: String((error as Error)?.message ?? error) });
            }
        };
    }

    function makePicture(area: StartArea, g: Geometry): Promise<Blob> {
        return new Promise((resolve, reject) => {
            const source = URL.createObjectURL(new Blob([`(${pictureWorker.toString()})()`], { type: 'text/javascript' }));
            const worker = new Worker(source);
            URL.revokeObjectURL(source);
            worker.onmessage = (event) => {
                worker.terminate();
                if (event.data?.blob) resolve(event.data.blob);
                else reject(new Error(event.data?.error || 'the picture could not be made'));
            };
            worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
            worker.postMessage({ area, g });
        });
    }

    async function openCache(): Promise<Cache | null> {
        try { return 'caches' in window ? await caches.open(CACHE_NAME) : null; } catch { return null; }
    }

    type Prepared = { area: StartArea; g: Geometry; blob: Blob };
    const preparing = new Map<string, Promise<Prepared | null>>();

    /**
     * The start area of a realm and its picture: from the cache when it was made for this version of the map, else
     * made now and kept (the realm's pictures of other versions are dropped). Null when there is none to show.
     */
    function prepare(serverId: string | null | undefined): Promise<Prepared | null> {
        if (!serverId) return Promise.resolve(null);
        let job = preparing.get(serverId);
        if (!job) {
            job = (async (): Promise<Prepared | null> => {
                const area = await readStartArea(serverId);
                if (!area) return null;
                const g = geometry(area);
                const key = `${location.origin}/__start-area?${new URLSearchParams({
                    server: serverId, map: area.name, version: area.version ?? '', x: String(g.ox), y: String(g.oy),
                    w: String(g.w), h: String(g.h), k: String(g.k), tile: String(area.tilewidth), build: String(PICTURE_BUILD),
                })}`;
                const cache = await openCache();
                const kept = await cache?.match(key).catch(() => undefined);
                if (kept) return { area, g, blob: await kept.blob() };
                const blob = await makePicture(area, g);
                if (cache) {
                    try {
                        for (const old of await cache.keys()) {
                            if (new URL(old.url).searchParams.get('server') === serverId) await cache.delete(old);
                        }
                        await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/png' } }));
                    } catch { /* not kept: made again next time */ }
                }
                return { area, g, blob };
            })().catch(() => null);
            preparing.set(serverId, job);
            // a failure is tried again on the next call
            void job.then((done) => { if (!done) preparing.delete(serverId); });
        }
        return job;
    }
    (window as any).startAreaPrepare = prepare;

    // The character page: the picture, panning.
    const picture = document.getElementById('start-area') as HTMLImageElement | null;
    if (!picture) return;

    void (async () => {
        const ready = await prepare(localStorage.getItem('selectedServerId'));
        if (!ready) return;
        const { area, g, blob } = ready;
        picture.src = URL.createObjectURL(blob);
        // decoded before it shows, so it does not appear half drawn; decode() can refuse (a hidden tab), then the load does
        await picture.decode().catch(() => new Promise<void>((done) => {
            if (picture.complete) { done(); return; }
            picture.addEventListener('load', () => done(), { once: true });
            picture.addEventListener('error', () => done(), { once: true });
        }));
        if (!picture.naturalWidth) return;

        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let animation: Animation | null = null;
        const run = () => {
            const vw = window.innerWidth, vh = window.innerHeight;
            // scaled up only when the window is wider or taller than the view the picture was made for
            const s = Math.max(1, vw / Math.max(1, g.w - 2 * g.panX), vh / Math.max(1, g.h - 2 * g.panY));
            const at = (t: number): string => {
                const angle = t * Math.PI * 2;
                const cx = area.spawnX - g.ox + Math.sin(angle) * g.panX;
                const cy = area.spawnY - g.oy + Math.sin(angle * 2) * g.panY;
                const tx = Math.min(0, Math.max(vw - g.w * s, vw / 2 - cx * s));
                const ty = Math.min(0, Math.max(vh - g.h * s, vh / 2 - cy * s));
                return `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${s / g.k})`;
            };
            const elapsed = Number(animation?.currentTime ?? 0);
            animation?.cancel();
            if (still) { picture.style.transform = at(0); return; }
            const frames: Keyframe[] = [];
            for (let i = 0; i <= PAN_STEPS; i++) frames.push({ transform: at(i / PAN_STEPS) });
            animation = picture.animate(frames, { duration: PAN_PERIOD_MS, iterations: Infinity, easing: 'linear' });
            animation.currentTime = elapsed;
        };
        run();
        let resizing = 0;
        window.addEventListener('resize', () => { window.clearTimeout(resizing); resizing = window.setTimeout(run, 150); });
        picture.classList.add('shown');
    })();
})();
