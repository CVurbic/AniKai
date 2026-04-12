// ==UserScript==
// @name         Anime Watched Overlay (Supabase)
// @namespace    anime-extension
// @version      0.9.0
// @description  Watched overlay (Supabase) + klik vodi na link + watched badge na posterima + auto "Finish watching?" na 95% zadnje ep + scrape detalja + FS finish button + Manual finish + Sort + Filter chips [Anikai.to]
// @match        https://anikai.to/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =========================
    // Supabase config
    // =========================
    const SUPABASE_URL = 'https://xxqeupvmmmxltbtxcgvp.supabase.co';
    const SUPABASE_ANON_KEY =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4cWV1cHZtbW14bHRidHhjZ3ZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE2Njk1Nzk3MDYsImV4cCI6MTk4NTE1NTcwNn0.Pump9exBhsc1TbUGqegEsqIXnmsmlUZMVlo2gSHoYDo';

    const SUPABASE_TABLE = 'anime';

    // Cache
    const CACHE_KEY = 'awo_cache_anime_v1';
    const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

    // UI inject check
    const MENU_CHECK_INTERVAL = 500;

    // Auto-finish settings
    const FINISH_PERCENT_THRESHOLD = 95; // trigger na 95%
    const FINISH_DEDUPE_PREFIX = 'awo_finish_prompted_ep_'; // sessionStorage key prefix

    // Fullscreen "Finish" button settings
    const FS_BUTTON_PERCENT_THRESHOLD = 90; // prikazi button na 90%+
    const FS_BUTTON_DEDUPE_KEY = 'awo_fs_finish_clicked_ep_'; // sessionStorage dedupe

    // Debug
    const AWO_DEBUG = false;          // stavi true ako želiš HUD
    const AWO_DEBUG_KEY_TOGGLE = 'd'; // tipka za toggle HUD-a

    // Overlay prefs
    const OVERLAY_PREFS_KEY = 'awo_overlay_prefs_v1';

    // Local state
    let __awoFinishedIds = new Set(); // numeric ids (npr. 100, 18922...)
    let __awoObs = null;
    let __awoMarkQueued = false;

    // Overlay state
    let __awoOverlayState = loadOverlayPrefs();

    // Fix logo link (ako postoji)
    const logo = document.getElementById('logo');
    if (logo) logo.href = '/home';

    // =========================
    // Boot: add menu item
    // =========================
    // TODO: Anikai user menu struktura nepoznata (potreban logged-in HTML)
    // Privremeno: dodaj floating dugme za otvaranje overlay-a
    const interval = setInterval(() => {
        if (document.querySelector('.awo-float-btn')) {
            clearInterval(interval);
            return;
        }

        // Pokušaj naći nav-user za ubacivanje linka (kad je user logiran)
        const navUser = document.querySelector('.nav-user .acc-wrap');
        if (navUser) {
            if (navUser.querySelector('.anime-watched-link')) {
                clearInterval(interval);
                return;
            }
            const watchedLink = document.createElement('a');
            watchedLink.className = 'anime-watched-link nav-btn';
            watchedLink.href = '#';
            watchedLink.title = 'Watched list';
            watchedLink.innerHTML = `<i class="fas fa-eye"></i>`;
            watchedLink.addEventListener('click', (e) => {
                e.preventDefault();
                openWatchedOverlay();
            });
            navUser.prepend(watchedLink);
            clearInterval(interval);
            return;
        }

        // Fallback: floating dugme
        const btn = document.createElement('button');
        btn.className = 'awo-float-btn';
        btn.title = 'Watched list';
        btn.innerHTML = `<i class="fas fa-eye"></i>`;
        btn.style.cssText = `
            position:fixed; bottom:20px; left:20px; z-index:999998;
            width:44px; height:44px; border-radius:999px;
            background:rgba(15,17,21,0.85); border:1px solid rgba(255,255,255,0.2);
            color:#fff; cursor:pointer; font-size:16px;
            box-shadow:0 4px 20px rgba(0,0,0,.4); display:flex;
            align-items:center; justify-content:center;
        `;
        btn.addEventListener('click', () => openWatchedOverlay());
        document.body.appendChild(btn);
        clearInterval(interval);
    }, MENU_CHECK_INTERVAL);

    // =========================
    // Boot: watched badges on page (finished=true)
    // =========================
    injectWatchedMarkerStyles();
    initWatchedMarkers();

    // =========================
    // Boot: manual finish button on watch page
    // =========================
    initManualFinishedButton();

    // =========================
    // Boot: auto "Finish watching?" via XHR hook
    // =========================
    hookContinueWatchLog();

    // =========================
    // Boot: Fullscreen finish button + Debug HUD
    // =========================
    initFullscreenFinishButton();
    initAwoDebugHud();

    // =========================
    // Watched markers on listing pages
    // =========================
    function initWatchedMarkers() {
        loadWatchedFromSupabase({ force: false })
            .then((list) => {
                buildFinishedIdSet(list);
                queueMarkAll();
                setupMutationObserver();
            })
            .catch((err) => {
                console.warn('[Anime Extension] Failed to init watched markers:', err);
                setupMutationObserver();
            });
    }

    function buildFinishedIdSet(list) {
        const ids = new Set();
        const items = Array.isArray(list) ? list : [];
        for (const it of items) {
            if (!it || it.finished !== true) continue;
            const id = extractAnimeIdFromSupabaseRow(it);
            if (id) ids.add(id);
        }
        __awoFinishedIds = ids;
    }

    function extractAnimeIdFromSupabaseRow(it) {
        const link = (it.link || '').trim();
        const idFromLink = extractAnimeIdFromUrlOrPath(link);
        if (idFromLink) return idFromLink;

        return null;
    }

    function extractAnimeIdFromUrlOrPath(urlOrPath) {
        if (!urlOrPath) return null;
        const s = String(urlOrPath).trim();
        if (!s) return null;

        try {
            let path = s;

            // Ako je apsolutan URL, uzmi pathname (bez ?query i #hash)
            if (s.startsWith('http://') || s.startsWith('https://')) {
                const u = new URL(s);
                path = u.pathname || '';
            } else {
                // Ako je relativan, makni ?query i #hash ručno
                path = s.split('#')[0].split('?')[0];
            }

            // Anikai koristi alfanumeričke slugove: /watch/anime-name-e4w9
            // Vraćamo cijeli normalizirani path kao ID (string)
            path = path.replace(/\/+$/, ''); // makni trailing slash
            return path || null;
        } catch {
            const clean = String(urlOrPath).split('#')[0].split('?')[0].replace(/\/+$/, '');
            return clean || null;
        }
    }

    function setupMutationObserver() {
        if (__awoObs) return;

        __awoObs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    queueMarkAll();
                    break;
                }
            }
        });

        __awoObs.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    }

    function queueMarkAll() {
        if (__awoMarkQueued) return;
        __awoMarkQueued = true;
        requestAnimationFrame(() => {
            __awoMarkQueued = false;
            markWatchedOnPage();
        });
    }

    function markWatchedOnPage() {
        if (!__awoFinishedIds || __awoFinishedIds.size === 0) return;

        // Regular cards: div.aitem > div.inner > a.poster[href]
        // Mini cards:    a.aitem[href]
        const items = document.querySelectorAll('.aitem');
        for (const item of items) {
            if (item.classList.contains('awo-watched-container')) continue;

            const id = getAnimeIdFromPosterContainer(item);
            if (!id) continue;
            if (!__awoFinishedIds.has(id)) continue;

            applyWatchedOverlayToPoster(item);
        }
    }

    function getAnimeIdFromPosterContainer(itemEl) {
        if (!itemEl) return null;

        // Mini format: <a class="aitem" href="/watch/...">
        let href = (itemEl.tagName === 'A') ? (itemEl.getAttribute('href') || '') : '';

        // Regular format: <div class="aitem"> contains <a class="poster" href="/watch/...">
        if (!href) {
            const a = itemEl.querySelector('a.poster[href], a[href^="/watch/"]');
            href = (a?.getAttribute('href') || '').trim();
        }

        if (!href) return null;
        return extractAnimeIdFromUrlOrPath(href);
    }

    function applyWatchedOverlayToPoster(itemEl) {
        if (!itemEl) return;

        itemEl.classList.add('awo-watched-container');

        // Nađi poster kontejner unutar kartice (div s posterom)
        const posterTarget = itemEl.querySelector('.inner') || itemEl.querySelector('.poster') || itemEl;
        if (posterTarget.querySelector(':scope > .awo-watched-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'awo-watched-overlay';
        overlay.innerHTML = `
      <div class="awo-watched-shade"></div>
      <div class="awo-watched-badge">
        <i class="fas fa-eye"></i>
        WATCHED
      </div>
    `;
        posterTarget.style.position = 'relative';
        posterTarget.appendChild(overlay);
    }

    function injectWatchedMarkerStyles() {
        if (document.getElementById('awo-watched-marker-style')) return;

        const style = document.createElement('style');
        style.id = 'awo-watched-marker-style';
        style.textContent = `
      .aitem.awo-watched-container { position: relative !important; }
      .aitem.awo-watched-container .awo-watched-overlay {
        position: absolute; inset: 0; z-index: 6;
        pointer-events: none; border-radius: inherit; overflow: hidden;
      }
      .aitem.awo-watched-container .awo-watched-shade {
        position: absolute; inset: 0; background: rgba(0,0,0,0.75);
      }
      .aitem.awo-watched-container .awo-watched-badge {
        position: absolute; top: 8px; left: 8px;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 9px; border-radius: 999px;
        background: rgba(15,17,21,0.78);
        border: 1px solid rgba(255,255,255,0.14);
        color: rgba(255,255,255,0.92);
        font-size: 11px; font-weight: 800;
        letter-spacing: .6px; text-transform: uppercase;
        box-shadow: 0 8px 22px rgba(0,0,0,.35);
      }
    `;
        document.head.appendChild(style);
    }

    // =========================
    // Overlay UI (Watched list) + Sort + Filters
    // =========================
    function ensureWatchedOverlay() {
        if (document.querySelector('#anime-watched-overlay')) return;

        const style = document.createElement('style');
        style.id = 'anime-watched-overlay-style';
        style.textContent = `
      #anime-watched-overlay {
        position: fixed; inset: 0; z-index: 999999;
        display: none; align-items: center; justify-content: center; padding: 24px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      #anime-watched-overlay.is-open { display: flex; }

      .awo-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(2px); }
      .awo-panel {
        position: relative; width: min(980px, 96vw); max-height: min(720px, 88vh);
        background: #0f1115; border: 1px solid rgba(255,255,255,.08);
        border-radius: 14px; box-shadow: 0 20px 80px rgba(0,0,0,.55);
        overflow: hidden; display: flex; flex-direction: column;
        color: #e9edf2;
      }

      .awo-header {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        background: rgba(15,17,21,0.88);
        position: sticky; top: 0; z-index: 5;
        backdrop-filter: blur(6px);
        flex-wrap: wrap;
      }
      .awo-title {
        font-weight: 800; font-size: 16px;
        margin-right: auto; display: flex; align-items: center; gap: 10px;
        letter-spacing: .2px;
      }

      .awo-search {
        width: min(340px, 38vw);
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.10);
        color: #e9edf2; border-radius: 10px;
        padding: 9px 10px; outline: none; font-size: 13px;
      }
      .awo-search::placeholder { color: rgba(233,237,242,.55); }

      .awo-select {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.12);
        color: #e9edf2;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        outline: none;
        cursor: pointer;
      }

      .awo-chip-row { display:flex; gap: 8px; flex-wrap: wrap; }
      .awo-chip {
        display:inline-flex; align-items:center; gap:6px;
        padding: 7px 10px;
        border-radius: 999px;
        font-size: 12px;
        background: rgba(255,255,255,.05);
        border: 1px solid rgba(255,255,255,.10);
        color: rgba(233,237,242,.90);
        cursor: pointer;
        user-select:none;
      }
      .awo-chip:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.16); }
      .awo-chip[aria-pressed="true"] {
        background: rgba(0,255,140,.10);
        border-color: rgba(0,255,140,.28);
        box-shadow: 0 0 0 3px rgba(0,255,140,.10);
      }
      .awo-chip .dot {
        width: 9px; height: 9px; border-radius: 999px;
        background: rgba(255,255,255,.45);
      }
      .awo-chip[aria-pressed="true"] .dot {
        background: rgba(0,255,140,.85);
        box-shadow: 0 0 0 3px rgba(0,255,140,.16);
      }

      .awo-btn {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.12);
        color: #e9edf2; border-radius: 10px;
        padding: 8px 10px; cursor: pointer; font-size: 13px;
      }
      .awo-btn:hover { background: rgba(255,255,255,.09); }

      .awo-body { padding: 12px; overflow: auto; }
      .awo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }

      .awo-card {
        display: flex; gap: 10px; padding: 10px;
        border-radius: 12px; background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.08);
        cursor: pointer;
        min-height: 112px;
        transition: transform .08s ease, background .12s ease, border-color .12s ease;
        outline: none;
      }
      .awo-card:hover {
        background: rgba(255,255,255,.06);
        border-color: rgba(255,255,255,.14);
        transform: translateY(-1px);
      }
      .awo-card:focus {
        outline: 2px solid rgba(255,255,255,.18);
        outline-offset: 2px;
      }

      .awo-poster { width: 54px; height: 76px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: rgba(255,255,255,.08); }
      .awo-meta { min-width: 0; display:flex; flex-direction:column; gap: 6px; flex: 1 1 auto; }

      .awo-name {
        font-weight: 700; font-size: 13px; line-height: 1.25;
        overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
        -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .awo-sub { font-size: 12px; opacity: .8; display: flex; gap: 8px; flex-wrap: wrap; }
      .awo-pill {
        font-size: 11px; padding: 3px 8px; border-radius: 999px;
        background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.10);
      }

      .awo-desc-wrap{
        position: relative;
        margin-top: 2px;
        opacity: 0;
        max-height: 0;
        transform: translateY(-2px);
        transition: opacity .12s ease, transform .12s ease, max-height .12s ease;
        overflow: hidden;
      }
      .awo-card:hover .awo-desc-wrap,
      .awo-card:focus .awo-desc-wrap,
      .awo-card:focus-within .awo-desc-wrap{
        opacity: .92;
        max-height: 40px;
        transform: translateY(0);
      }
      .awo-desc {
        font-size: 12px;
        opacity: .78;
        line-height: 1.35;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .awo-desc-fade{
        position:absolute; left:0; right:0; bottom:0;
        height: 16px;
        pointer-events:none;
        background: linear-gradient(to bottom, rgba(15,17,21,0), rgba(15,17,21,1));
        opacity: .95;
      }

      .awo-empty { opacity: .75; padding: 30px 10px; text-align: center; }

      .awo-skeleton { display: none; }
      .awo-skeleton.is-on { display: grid; }

      .awo-skel-card{
        display:flex; gap:10px; padding:10px;
        border-radius: 12px;
        background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.08);
        min-height: 112px;
      }
      .awo-skel-poster{
        width:54px; height:76px; border-radius:8px;
        background: rgba(255,255,255,.08);
        flex: 0 0 auto;
        position: relative;
        overflow: hidden;
      }
      .awo-skel-lines{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:10px; padding-top:2px; }
      .awo-skel-line{
        height: 12px;
        border-radius: 8px;
        background: rgba(255,255,255,.08);
        overflow:hidden;
        position: relative;
      }
      .awo-skel-line.w60{ width:60%; }
      .awo-skel-line.w85{ width:85%; }
      .awo-skel-line.w40{ width:40%; }
      .awo-skel-pills{ display:flex; gap:8px; flex-wrap:wrap; }
      .awo-skel-pill{
        height: 18px; width: 46px;
        border-radius: 999px;
        background: rgba(255,255,255,.08);
        position: relative;
        overflow: hidden;
      }

      /* shimmer */
      .awo-skel-line::after, .awo-skel-poster::after, .awo-skel-pill::after{
        content:"";
        position:absolute; inset:0;
        background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.10), rgba(255,255,255,0));
        transform: translateX(-100%);
        animation: awoShimmer 1.1s infinite;
      }
      @keyframes awoShimmer {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
      }
    `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'anime-watched-overlay';
        overlay.innerHTML = `
      <div class="awo-backdrop" data-awo-close="1"></div>
      <div class="awo-panel" role="dialog" aria-modal="true" aria-label="Watched list">
        <div class="awo-header">
          <div class="awo-title"><i class="fas fa-eye"></i>Watched</div>

          <input class="awo-search" type="text" placeholder="Search title..." />

          <select class="awo-select" id="awo-sort">
            <option value="newest">Newest</option>
            <option value="az">A-Z</option>
            <option value="rating">Rating</option>
          </select>

          <div class="awo-chip-row" id="awo-chips">
            <button type="button" class="awo-chip" data-chip="finished" aria-pressed="false"><span class="dot"></span>Finished</button>
            <button type="button" class="awo-chip" data-chip="watching" aria-pressed="false"><span class="dot"></span>Watching</button>
            <button type="button" class="awo-chip" data-chip="hd" aria-pressed="false"><span class="dot"></span>HD</button>
            <button type="button" class="awo-chip" data-chip="tv" aria-pressed="false"><span class="dot"></span>TV</button>
          </div>

          <button class="awo-btn" type="button" data-awo-refresh="1"><i class="fas fa-sync-alt mr-1"></i> Refresh</button>
          <button class="awo-btn" type="button" data-awo-close="1" title="Close"><i class="fas fa-times"></i></button>
        </div>

        <div class="awo-body">
          <div class="awo-grid awo-skeleton" id="awo-skeleton">
            ${Array.from({ length: 9 }).map(() => `
              <div class="awo-skel-card">
                <div class="awo-skel-poster"></div>
                <div class="awo-skel-lines">
                  <div class="awo-skel-line w85"></div>
                  <div class="awo-skel-pills">
                    <div class="awo-skel-pill"></div>
                    <div class="awo-skel-pill"></div>
                    <div class="awo-skel-pill"></div>
                  </div>
                  <div class="awo-skel-line w60"></div>
                </div>
              </div>
            `).join('')}
          </div>

          <div class="awo-grid" id="awo-grid"></div>
          <div class="awo-empty" id="awo-error" style="display:none;">Error loading list.</div>
          <div class="awo-empty" id="awo-empty" style="display:none;">No items match your filters.</div>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);

        // Close handlers
        overlay.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.getAttribute && t.getAttribute('data-awo-close') === '1') closeWatchedOverlay();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeWatchedOverlay();
        });

        // Search
        const searchInput = overlay.querySelector('.awo-search');
        searchInput.value = __awoOverlayState.q || '';
        searchInput.addEventListener('input', () => {
            __awoOverlayState.q = searchInput.value.trim();
            saveOverlayPrefs(__awoOverlayState);
            applyOverlayQuerySortFilterAndRender();
        });

        // Sort
        const sortSel = overlay.querySelector('#awo-sort');
        sortSel.value = __awoOverlayState.sort || 'newest';
        sortSel.addEventListener('change', () => {
            __awoOverlayState.sort = sortSel.value;
            saveOverlayPrefs(__awoOverlayState);
            applyOverlayQuerySortFilterAndRender();
        });

        // Chips
        syncChipsUiFromState();
        overlay.querySelector('#awo-chips').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-chip]');
            if (!btn) return;

            const key = btn.getAttribute('data-chip');
            toggleFilterChip(key);
            syncChipsUiFromState();
            saveOverlayPrefs(__awoOverlayState);
            applyOverlayQuerySortFilterAndRender();
        });

        // Refresh
        overlay.querySelector('[data-awo-refresh="1"]').addEventListener('click', async () => {
            try {
                setOverlayState('loading');
                const list = await loadWatchedFromSupabase({ force: true });
                window.__awoData = list;
                setOverlayState('idle');

                buildFinishedIdSet(list);
                queueMarkAll();

                applyOverlayQuerySortFilterAndRender();
            } catch (err) {
                console.error('[Anime Extension] Refresh failed:', err);
                setOverlayState('error');
                renderWatchedList([]);
            }
        });
    }

    function openWatchedOverlay() {
        ensureWatchedOverlay();
        const overlay = document.querySelector('#anime-watched-overlay');
        overlay.classList.add('is-open');

        // ensure UI reflects saved state
        const search = overlay.querySelector('.awo-search');
        const sortSel = overlay.querySelector('#awo-sort');
        if (search) search.value = __awoOverlayState.q || '';
        if (sortSel) sortSel.value = __awoOverlayState.sort || 'newest';
        syncChipsUiFromState();

        setOverlayState('loading');

        loadWatchedFromSupabase({ force: false })
            .then((list) => {
                window.__awoData = list;
                setOverlayState('idle');

                buildFinishedIdSet(list);
                queueMarkAll();

                applyOverlayQuerySortFilterAndRender();
                setTimeout(() => search && search.focus(), 0);
            })
            .catch((err) => {
                console.error('[Anime Extension] Supabase load failed:', err);
                setOverlayState('error');
                renderWatchedList([]);
            });
    }

    function closeWatchedOverlay() {
        const overlay = document.querySelector('#anime-watched-overlay');
        if (!overlay) return;
        overlay.classList.remove('is-open');
    }

    function setOverlayState(state) {
        const error = document.querySelector('#awo-error');
        const skeleton = document.querySelector('#awo-skeleton');
        const grid = document.querySelector('#awo-grid');

        const isLoading = state === 'loading';
        const isError = state === 'error';

        if (error) error.style.display = isError ? 'block' : 'none';
        if (skeleton) skeleton.classList.toggle('is-on', isLoading);
        if (grid) grid.style.display = isLoading ? 'none' : 'grid';
    }

    function syncChipsUiFromState() {
        const chips = document.querySelectorAll('#awo-chips .awo-chip[data-chip]');
        for (const c of chips) {
            const key = c.getAttribute('data-chip');
            const pressed = !!__awoOverlayState.filters?.[key];
            c.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        }
    }

    function toggleFilterChip(key) {
        if (!__awoOverlayState.filters) __awoOverlayState.filters = {};
        __awoOverlayState.filters[key] = !__awoOverlayState.filters[key];
    }

    function applyOverlayQuerySortFilterAndRender() {
        const all = window.__awoData || [];
        const q = String(__awoOverlayState.q || '').trim().toLowerCase();
        const sort = __awoOverlayState.sort || 'newest';
        const f = __awoOverlayState.filters || {};

        // filter
        let out = all.filter((x) => {
            const title = (x.title || '').toLowerCase();
            const desc = (x.description || '').toLowerCase();
            if (q && !(title.includes(q) || desc.includes(q))) return false;

            // Finished/Watching chips (ako nijedan nije upaljen -> ne filtrira po statusu)
            const finishedOn = !!f.finished;
            const watchingOn = !!f.watching;
            if (finishedOn || watchingOn) {
                const isFinished = x.finished === true;
                if (finishedOn && !watchingOn && !isFinished) return false;
                if (!finishedOn && watchingOn && isFinished) return false;
                // ako su oba ON -> sve prolazi (nema potrebe za dodatnim uvjetom)
            }

            // HD chip
            if (f.hd) {
                const ql = String(x.quality || '').toUpperCase();
                if (ql !== 'HD' && ql !== 'FHD' && ql !== 'UHD' && ql !== '4K') return false;
            }

            // TV chip
            if (f.tv) {
                const fmt = String(x.format || '').toUpperCase();
                if (fmt !== 'TV') return false;
            }

            return true;
        });

        // sort
        if (sort === 'az') {
            out = out.slice().sort((a, b) => {
                const at = (a.title || '').toLowerCase();
                const bt = (b.title || '').toLowerCase();
                return at.localeCompare(bt, undefined, { sensitivity: 'base' });
            });
        } else if (sort === 'rating') {
            out = out.slice().sort((a, b) => {
                const ar = Number(a.rating);
                const br = Number(b.rating);
                const aOk = Number.isFinite(ar);
                const bOk = Number.isFinite(br);
                if (aOk && bOk) return br - ar;
                if (aOk && !bOk) return -1;
                if (!aOk && bOk) return 1;
                // fallback newest by created_at
                return compareCreatedAtDesc(a, b);
            });
        } else {
            // newest
            out = out.slice().sort(compareCreatedAtDesc);
        }

        renderWatchedList(out);
    }

    function compareCreatedAtDesc(a, b) {
        const ad = Date.parse(a.created_at || '') || 0;
        const bd = Date.parse(b.created_at || '') || 0;
        return bd - ad;
    }

    function navigateToAnimeLink(link) {
        if (!link) return;
        window.location.href = link;
    }

    function renderWatchedList(items) {
        // always hide skeleton when rendering
        const skeleton = document.querySelector('#awo-skeleton');
        if (skeleton) skeleton.classList.remove('is-on');

        const grid = document.querySelector('#awo-grid');
        const empty = document.querySelector('#awo-empty');
        const error = document.querySelector('#awo-error');
        if (!grid || !empty) return;

        if (error) error.style.display = 'none';

        grid.innerHTML = '';
        const safeItems = Array.isArray(items) ? items : [];
        window.__awoRendered = safeItems;

        if (safeItems.length === 0) {
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        for (const it of safeItems) {
            const card = document.createElement('div');
            card.className = 'awo-card';
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');

            const title = escapeHtml(it.title || '');
            const desc = it.description ? escapeHtml(shortenText(it.description, 220)) : '';
            const descTitle = it.description ? escapeHtml(it.description) : '';

            card.innerHTML = `
        <img class="awo-poster" src="${it.posterUrl || ''}" alt="">
        <div class="awo-meta">
          <div class="awo-name" title="${title}">${title}</div>
          <div class="awo-sub">
            <span class="awo-pill">${it.finished ? 'Finished' : 'Watching'}</span>
            ${it.quality ? `<span class="awo-pill">${escapeHtml(it.quality)}</span>` : ''}
            ${it.format ? `<span class="awo-pill">${escapeHtml(it.format)}</span>` : ''}
            ${it.duration ? `<span class="awo-pill">${escapeHtml(it.duration)}</span>` : ''}
            ${it.rating != null ? `<span class="awo-pill">⭐ ${escapeHtml(String(it.rating))}</span>` : ''}
          </div>

          <div class="awo-desc-wrap">
            ${it.description ? `
              <div class="awo-desc" title="${descTitle}">${desc}</div>
              <div class="awo-desc-fade"></div>
            ` : `<div class="awo-desc"></div>`}
          </div>
        </div>
      `;

            card.addEventListener('click', () => navigateToAnimeLink(it.link));
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigateToAnimeLink(it.link);
                }
            });

            grid.appendChild(card);
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function shortenText(str, maxLen = 220) {
        const s = String(str || '').replace(/\s+/g, ' ').trim();
        if (!s) return '';
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen - 1).trimEnd() + '…';
    }

    function loadOverlayPrefs() {
        try {
            const raw = localStorage.getItem(OVERLAY_PREFS_KEY);
            if (!raw) return { q: '', sort: 'newest', filters: { finished: false, watching: false, hd: false, tv: false } };
            const p = JSON.parse(raw);
            return {
                q: String(p.q || ''),
                sort: ['newest', 'az', 'rating'].includes(p.sort) ? p.sort : 'newest',
                filters: {
                    finished: !!p.filters?.finished,
                    watching: !!p.filters?.watching,
                    hd: !!p.filters?.hd,
                    tv: !!p.filters?.tv
                }
            };
        } catch {
            return { q: '', sort: 'newest', filters: { finished: false, watching: false, hd: false, tv: false } };
        }
    }

    function saveOverlayPrefs(state) {
        try {
            localStorage.setItem(OVERLAY_PREFS_KEY, JSON.stringify(state));
        } catch { }
    }

    // =========================
    // Supabase REST fetch + cache
    // =========================
    async function loadWatchedFromSupabase({ force = false } = {}) {
        if (!force) {
            const cached = readCache();
            if (cached) return cached;
        }

        const selectCols = [
            'id',
            'created_at',
            'title',
            'posterUrl',
            'link',
            'finished',
            'description',
            'rating',
            'quality',
            'subtitles',
            'dubbed',
            'format',
            'duration',
            'producerName'
        ].join(',');

        const url =
            `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}` +
            `?select=${encodeURIComponent(selectCols)}` +
            `&order=${encodeURIComponent('created_at.desc')}`;

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Supabase error ${res.status}: ${text || res.statusText}`);
        }

        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        writeCache(list);
        return list;
    }

    function readCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.ts || !Array.isArray(parsed.data)) return null;
            if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
            return parsed.data;
        } catch {
            return null;
        }
    }

    function writeCache(list) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: list }));
        } catch { }
    }

    function invalidateCache() {
        try {
            localStorage.removeItem(CACHE_KEY);
        } catch { }
    }

    // =========================
    // ✅ Auto Finish Watching (XHR hook + modal + Supabase upsert)
    // =========================
    function hookContinueWatchLog() {
        injectFinishModalStyles();

        const OrigXHR = window.XMLHttpRequest;

        function PatchedXHR() {
            const xhr = new OrigXHR();
            let _method = '';
            let _url = '';

            const origOpen = xhr.open;
            xhr.open = function (method, url, ...rest) {
                _method = (method || 'GET').toUpperCase();
                _url = url || '';
                return origOpen.call(this, method, url, ...rest);
            };

            const origSend = xhr.send;
            xhr.send = function (body) {
                try {
                    // TODO: provjeriti pravi XHR endpoint za Anikai (Network tab dok gledaš epizodu)
                    // Trenutno tražimo /ajax/ POST requeste s percent/episode_id parametrima
                    if (_method === 'POST' && typeof _url === 'string' && (
                        _url.includes('/ajax/continue-watch/log') ||
                        _url.includes('/ajax/watch/') ||
                        _url.includes('/api/watch/')
                    )) {
                        const data = parseUrlEncodedBody(body);
                        maybeOfferFinishWatching(data);
                    }
                } catch { }
                return origSend.call(this, body);
            };

            return xhr;
        }

        window.XMLHttpRequest = PatchedXHR;
    }

    function parseUrlEncodedBody(body) {
        if (!body) return {};
        const s = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '';
        const params = new URLSearchParams(s);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        return obj;
    }

    function parseFirstInt(text) {
        const m = String(text || '').match(/(\d{1,6})/);
        return m ? parseInt(m[1], 10) : null;
    }

    function parseFirstFloat(text) {
        const m = String(text || '').match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
    }

    function getTotalEpisodesFromTick() {
        // Anikai: broj epizoda iz .detail div koji sadrži "Episodes:"
        const divs = [...document.querySelectorAll('.entity-section .detail div')];
        const epDiv = divs.find((d) => (d.textContent || '').includes('Episodes:'));
        if (epDiv) {
            const span = epDiv.querySelector('span');
            const n = parseFirstInt(span?.textContent);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }

    function getActiveEpisodeNumber() {
        // TODO: episode lista se učitava dinamički — treba naći pravi selektor
        // Privremeno: pokušaj iz URL hash/query (#ep=N ili ?ep=N)
        try {
            const ep = new URL(location.href).searchParams.get('ep') ||
                       location.hash.match(/ep=(\d+)/)?.[1];
            const n = ep ? parseInt(ep, 10) : null;
            if (Number.isFinite(n) && n > 0) return n;
        } catch { }
        return null;
    }

    function getWatchPageBaseLink() {
        const u = new URL(location.href);
        u.search = '';
        return u.toString();
    }

    // ======================================================
    // ✅ Scrape detalja
    // ======================================================
    function getAnimeTitle() {
        // Anikai: h1.title ili h1[itemprop="name"] unutar .entity-section
        const titleEl =
            document.querySelector('h1.title') ||
            document.querySelector('h1[itemprop="name"]') ||
            document.querySelector('.entity-section h1') ||
            document.querySelector('h1') ||
            document.querySelector('h2') ||
            null;

        const t1 = (titleEl?.textContent || '').trim();
        if (t1) return t1;

        const t = document.title || '';
        const cleaned = t.replace(/\s*\|\s*AniKai.*$/i, '').replace(/\s*-\s*AniKai.*$/i, '');
        return cleaned.replace(/\s*Episode\s*\d+.*$/i, '').trim() || cleaned.trim() || 'Unknown';
    }

    function getDescription() {
        // Anikai: .desc.text-expand ili .desc unutar .entity-section
        const root =
            document.querySelector('.desc.text-expand') ||
            document.querySelector('.entity-section .desc') ||
            document.querySelector('.desc') ||
            null;
        if (!root) return null;
        const s = (root.textContent || '').trim();
        return s ? s : null;
    }

    function getPosterUrl() {
        const og = document.querySelector('meta[property="og:image"]');
        const ogc = (og?.getAttribute('content') || '').trim();
        if (ogc) return ogc;

        // Anikai: .poster-wrap .poster img
        const img =
            document.querySelector('.poster-wrap .poster img') ||
            document.querySelector('.poster img') ||
            null;

        const src = (img?.getAttribute('src') || img?.getAttribute('data-src') || '').trim();
        if (src) return src;

        return null;
    }

    function getSubDubCounts() {
        // Anikai: .entity-section .info .sub (SVG + broj)
        const subEl = document.querySelector('.entity-section .info .sub');
        const sub = subEl ? parseFirstInt(subEl.textContent) : null;
        // Dub nije vidljiv u statičnom HTML-u — TODO kad nađemo pravi selektor
        return {
            subtitles: Number.isFinite(sub) ? sub : null,
            dubbed: null
        };
    }

    function getQuality() {
        // Anikai: nema vidljivog quality elementa u statičnom HTML-u — TODO
        return null;
    }

    function getFormatDurationFromTick() {
        // Anikai: .entity-section .info span b sadrži "TV", "Movie" itd.
        const infoEl = document.querySelector('.entity-section .info');
        if (!infoEl) return { format: null, duration: null };

        const bTags = [...infoEl.querySelectorAll('b')]
            .map((b) => (b.textContent || '').trim())
            .filter(Boolean);

        const format = bTags.find((s) => /^(TV|Movie|OVA|ONA|Special|Music)$/i.test(s)) || null;

        // Trajanje: iz .detail div koji sadrži "Duration:"
        const durationEl = [...document.querySelectorAll('.detail div')]
            .find((d) => (d.textContent || '').includes('Duration:'));
        const durationSpan = durationEl?.querySelector('span');
        const duration = (durationSpan?.textContent || '').trim().replace('?', '') || null;

        return { format, duration: duration || null };
    }

    function getRatingFromVoteBlock() {
        // Anikai: data-score atribut na .rate-box, ili .info .rating
        const rateBox = document.querySelector('.rate-box[data-score]');
        if (rateBox) {
            const v = parseFirstFloat(rateBox.getAttribute('data-score'));
            if (Number.isFinite(v)) return v;
        }
        const ratingEl = document.querySelector('.entity-section .info .rating');
        const t = (ratingEl?.textContent || '').trim();
        const v = t && t !== '?' ? parseFirstFloat(t) : null;
        return Number.isFinite(v) ? v : null;
    }

    function scrapeAnimeDetails() {
        const { subtitles, dubbed } = getSubDubCounts();
        const { format, duration } = getFormatDurationFromTick();

        return {
            title: getAnimeTitle(),
            posterUrl: getPosterUrl(),
            link: getWatchPageBaseLink(),
            finished: true,

            description: getDescription(),
            rating: getRatingFromVoteBlock(),
            quality: getQuality(),
            subtitles,
            dubbed,
            format,
            duration,
            producerName: null
        };
    }

    function isAlreadyFinishedInLocalSet() {
        const id = extractAnimeIdFromUrlOrPath(location.pathname);
        if (!id) return false;
        return __awoFinishedIds.has(id);
    }

    function maybeOfferFinishWatching(payload) {
        const percent = parseFirstInt(payload.percent);
        if (!Number.isFinite(percent)) return;
        if (percent < FINISH_PERCENT_THRESHOLD) return;

        if (isAlreadyFinishedInLocalSet()) return;

        const tickTotal = getTotalEpisodesFromTick();
        if (!tickTotal) return;

        const activeEp = getActiveEpisodeNumber();
        if (!activeEp) return;
        if (activeEp !== tickTotal) return;

        const episodeId = payload.episode_id || '';
        if (episodeId) {
            const key = FINISH_DEDUPE_PREFIX + episodeId;
            if (sessionStorage.getItem(key) === '1') return;
            sessionStorage.setItem(key, '1');
        }

        const anime = scrapeAnimeDetails();
        showFinishModal(anime);
    }

    // =========================
    // Finish modal UI
    // =========================
    function injectFinishModalStyles() {
        if (document.getElementById('awo-finish-modal-style')) return;

        const style = document.createElement('style');
        style.id = 'awo-finish-modal-style';
        style.textContent = `
      #awo-finish-modal {
        position: fixed; inset: 0; z-index: 1000000;
        display: none; align-items: center; justify-content: center;
        padding: 24px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      #awo-finish-modal.is-open { display: flex; }

      .awo-finish-backdrop {
        position: absolute; inset: 0;
        background: rgba(0,0,0,.60);
        backdrop-filter: blur(2px);
      }

      .awo-finish-card {
        position: relative;
        width: min(560px, 96vw);
        border-radius: 16px;
        background: #0f1115;
        border: 1px solid rgba(255,255,255,.10);
        box-shadow: 0 20px 80px rgba(0,0,0,.55);
        overflow: hidden;
        color: #e9edf2;
      }

      .awo-finish-top {
        display:flex; gap:12px; padding: 14px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.02);
        align-items: center;
      }

      .awo-finish-poster {
        width: 52px; height: 74px; border-radius: 10px; object-fit: cover;
        background: rgba(255,255,255,.08); flex: 0 0 auto;
      }

      .awo-finish-title { font-weight: 800; font-size: 14px; line-height: 1.25; }
      .awo-finish-sub { opacity: .8; font-size: 12px; margin-top: 4px; }

      .awo-finish-body { padding: 14px; }
      .awo-finish-body p { margin: 0; opacity: .9; font-size: 13px; line-height: 1.4; }
      .awo-finish-mini {
        margin-top: 10px;
        font-size: 12px;
        opacity: .85;
        display:flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .awo-pill {
        font-size: 11px; padding: 3px 8px; border-radius: 999px;
        background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.10);
      }

      .awo-finish-actions {
        display:flex; gap:10px; justify-content:flex-end;
        padding: 14px; border-top: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.02);
      }

      .awo-finish-btn {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
        color: #e9edf2;
        border-radius: 12px;
        padding: 9px 12px;
        cursor: pointer;
        font-size: 13px;
      }
      .awo-finish-btn:hover { background: rgba(255,255,255,.10); }

      .awo-finish-btn.primary {
        border-color: rgba(0,255,140,.35);
        box-shadow: 0 0 0 3px rgba(0,255,140,.12);
      }

      .awo-finish-toast {
        position: fixed; top: 18px; right: 18px; z-index: 1000001;
        padding: 8px 10px; border-radius: 12px;
        background: rgba(0,0,0,.75); border: 1px solid rgba(255,255,255,.12);
        color: #fff; display:none;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
      }
    `;
        document.head.appendChild(style);

        const modal = document.createElement('div');
        modal.id = 'awo-finish-modal';
        modal.innerHTML = `
      <div class="awo-finish-backdrop" data-awo-finish-close="1"></div>
      <div class="awo-finish-card" role="dialog" aria-modal="true" aria-label="Finish watching">
        <div class="awo-finish-top">
          <img class="awo-finish-poster" id="awo-finish-poster" src="" alt="">
          <div style="min-width:0">
            <div class="awo-finish-title" id="awo-finish-title"></div>
            <div class="awo-finish-sub">Detected ~${FINISH_PERCENT_THRESHOLD}% on last episode</div>
          </div>
        </div>
        <div class="awo-finish-body">
          <p>Mark this anime as <b>Finished</b> in your Watched list?</p>
          <div class="awo-finish-mini" id="awo-finish-mini"></div>
        </div>
        <div class="awo-finish-actions">
          <button class="awo-finish-btn" type="button" data-awo-finish-close="1">Not now</button>
          <button class="awo-finish-btn primary" type="button" id="awo-finish-confirm">Finish watching</button>
        </div>
      </div>
      <div class="awo-finish-toast" id="awo-finish-toast"></div>
    `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.getAttribute && t.getAttribute('data-awo-finish-close') === '1') closeFinishModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeFinishModal();
        });
    }

    function showFinishToast(msg) {
        const t = document.getElementById('awo-finish-toast');
        if (!t) return;
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(showFinishToast._t);
        showFinishToast._t = setTimeout(() => (t.style.display = 'none'), 1400);
    }

    function showFinishModal(anime) {
        injectFinishModalStyles();

        const modal = document.getElementById('awo-finish-modal');
        if (!modal) return;

        const title = document.getElementById('awo-finish-title');
        const poster = document.getElementById('awo-finish-poster');
        const mini = document.getElementById('awo-finish-mini');
        const btn = document.getElementById('awo-finish-confirm');

        title.textContent = anime.title || 'Unknown';
        poster.src = anime.posterUrl || '';
        poster.alt = anime.title || '';

        if (mini) {
            const pills = [];
            if (anime.quality) pills.push(`Quality: ${anime.quality}`);
            if (anime.format) pills.push(`Format: ${anime.format}`);
            if (anime.duration) pills.push(`Duration: ${anime.duration}`);
            if (anime.subtitles != null) pills.push(`SUB: ${anime.subtitles}`);
            if (anime.dubbed != null) pills.push(`DUB: ${anime.dubbed}`);
            if (anime.rating != null) pills.push(`⭐ ${anime.rating}`);
            mini.innerHTML = pills.map((p) => `<span class="awo-pill">${escapeHtml(p)}</span>`).join('');
        }

        // remove old handlers by cloning
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', async () => {
            try {
                newBtn.disabled = true;
                newBtn.textContent = 'Saving...';

                await upsertFinishedToSupabase(anime);

                invalidateCache();
                const list = await loadWatchedFromSupabase({ force: true });
                window.__awoData = list;

                buildFinishedIdSet(list);
                queueMarkAll();

                showFinishToast('✅ Marked as Finished');
                closeFinishModal();

                // if overlay open, refresh current view
                applyOverlayQuerySortFilterAndRender();
            } catch (e) {
                console.warn('[Anime Extension] Finish save failed:', e);
                showFinishToast('❌ Save failed');
                newBtn.disabled = false;
                newBtn.textContent = 'Finish watching';
            }
        });

        modal.classList.add('is-open');
    }

    function closeFinishModal() {
        const modal = document.getElementById('awo-finish-modal');
        if (!modal) return;
        modal.classList.remove('is-open');
    }

    async function upsertFinishedToSupabase(anime) {
        const link = (anime.link || '').trim();
        if (!link) throw new Error('Missing link for upsert');

        // 1) select existing
        const findUrl =
            `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}` +
            `?select=id,link` +
            `&link=eq.${encodeURIComponent(link)}` +
            `&limit=1`;

        const findRes = await fetch(findUrl, {
            method: 'GET',
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!findRes.ok) {
            const t = await findRes.text().catch(() => '');
            throw new Error(`Supabase find failed ${findRes.status}: ${t || findRes.statusText}`);
        }

        const found = await findRes.json().catch(() => []);
        const exists = Array.isArray(found) && found.length > 0;

        const payload = {
            finished: true,
            title: anime.title || null,
            posterUrl: anime.posterUrl || null,
            link,
            description: anime.description ?? null,
            rating: anime.rating ?? null,
            quality: anime.quality ?? null,
            subtitles: anime.subtitles ?? null,
            dubbed: anime.dubbed ?? null,
            format: anime.format ?? null,
            duration: anime.duration ?? null,
            producerName: anime.producerName ?? null
        };

        if (exists) {
            const patchUrl =
                `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}` +
                `?link=eq.${encodeURIComponent(link)}`;

            const patchRes = await fetch(patchUrl, {
                method: 'PATCH',
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    Prefer: 'return=minimal'
                },
                body: JSON.stringify(payload)
            });

            if (!patchRes.ok) {
                const t = await patchRes.text().catch(() => '');
                throw new Error(`Supabase patch failed ${patchRes.status}: ${t || patchRes.statusText}`);
            }
            return;
        }

        const postUrl = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;
        const postRes = await fetch(postUrl, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
            },
            body: JSON.stringify(payload)
        });

        if (!postRes.ok) {
            const t = await postRes.text().catch(() => '');
            throw new Error(`Supabase insert failed ${postRes.status}: ${t || postRes.statusText}`);
        }
    }

    // =========================
    // Manual "Finished watching" button (watch page)
    // =========================
    function injectManualFinishedButtonStyles() {
        if (document.getElementById('awo-manual-finish-style')) return;

        const style = document.createElement('style');
        style.id = 'awo-manual-finish-style';
        style.textContent = `
      .awo-manual-finish-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(15,17,21,0.75);
        border: 1px solid rgba(255,255,255,0.16);
        color: rgba(255,255,255,0.92);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .2px;
        cursor: pointer;
        user-select: none;
      }
      .awo-manual-finish-btn:hover { background: rgba(30,33,40,0.78); }
      .awo-manual-finish-btn[disabled] { opacity: .55; cursor: not-allowed; }
      .awo-manual-finish-hint { margin-top: 6px; font-size: 11px; opacity: .75; }
            .awo-manual-finish-wrap{
        margin-top: 10px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        position: relative;
        z-index: 50;
      }

      /* malo “jači” button da bude čitljiv na njihovoj pozadini */
      .awo-manual-finish-btn{
        z-index: 51;
      }
    `;
        document.head.appendChild(style);
    }

    function isWatchPage() {
        return location.pathname.startsWith('/watch/');
    }

    function findManualButtonMount() {
        // Anikai watch page: .entity-section > .poster-wrap + .main-entity
        const entitySection = document.querySelector('.entity-section');
        if (!entitySection) {
            return { mount: null, insertAfter: null };
        }

        const posterWrap = entitySection.querySelector('.poster-wrap');
        if (posterWrap) {
            return { mount: entitySection, insertAfter: posterWrap };
        }

        return { mount: entitySection, insertAfter: null };
    }

    function initManualFinishedButton() {
        injectManualFinishedButtonStyles();

        const tryInject = () => {
            if (!isWatchPage()) return false;

            if (document.querySelector('#awo-manual-finish-btn')) return true;

            const where = findManualButtonMount();
            const mount = where.mount;
            if (!mount) return false;

            const wrap = document.createElement('div');
            wrap.id = 'awo-manual-finish-wrap';
            wrap.className = 'awo-manual-finish-wrap';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'awo-manual-finish-btn';
            btn.className = 'awo-manual-finish-btn';
            btn.innerHTML = `<i class="fas fa-check"></i> Finished watching`;

            const hint = document.createElement('div');
            hint.className = 'awo-manual-finish-hint';
            hint.textContent = 'Click to add this anime to Watched (Finished).';

            // click handler ostaje isti (samo ga ostavi ispod ovog)
            btn.addEventListener('click', async () => {
                try {
                    btn.disabled = true;
                    btn.textContent = 'Saving...';

                    if (isAlreadyFinishedInLocalSet()) {
                        showFinishToast('✅ Already in Watched');
                        btn.disabled = false;
                        btn.innerHTML = `<i class="fas fa-check"></i> Finished watching`;
                        return;
                    }

                    const anime = scrapeAnimeDetails();
                    await upsertFinishedToSupabase(anime);

                    invalidateCache();
                    const list = await loadWatchedFromSupabase({ force: true });
                    window.__awoData = list;

                    buildFinishedIdSet(list);
                    queueMarkAll();

                    showFinishToast('✅ Marked as Finished');
                    btn.innerHTML = `<i class="fas fa-check"></i> Finished ✓`;

                    applyOverlayQuerySortFilterAndRender();
                } catch (e) {
                    console.warn('[Anime Extension] Manual finish failed:', e);
                    showFinishToast('❌ Save failed');
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fas fa-check"></i> Finished watching`;
                }
            });

            wrap.appendChild(btn);
            wrap.appendChild(hint);

            // ✅ Insert odmah nakon postera (ako postoji), inače na vrh entity-section
            if (where.insertAfter && where.insertAfter.parentElement) {
                where.insertAfter.insertAdjacentElement('afterend', wrap);
            } else {
                mount.insertAdjacentElement('afterbegin', wrap);
            }

            return true;
        };

        // try now
        if (tryInject()) return;

        // observe until injected then disconnect
        const mo = new MutationObserver(() => {
            if (tryInject()) mo.disconnect();
        });
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }

    // =========================
    // Fullscreen "Finish watching" button
    // =========================
    let __awoFsBtn = null;
    let __awoFsBtnVideo = null;
    let __awoFsBtnBound = false;

    function initFullscreenFinishButton() {
        injectFsFinishButtonStyles();
        ensureFsFinishButton();

        document.addEventListener('fullscreenchange', updateFsFinishButtonVisibility, true);
        document.addEventListener('webkitfullscreenchange', updateFsFinishButtonVisibility, true);

        bindFsButtonToVideo();
        const mo = new MutationObserver(() => bindFsButtonToVideo());
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });

        setInterval(() => {
            if (!__awoFsBtnVideo) bindFsButtonToVideo();
            updateFsFinishButtonVisibility();
        }, 800);
    }

    function injectFsFinishButtonStyles() {
        if (document.getElementById('awo-fs-finish-style')) return;
        const style = document.createElement('style');
        style.id = 'awo-fs-finish-style';
        style.textContent = `
      #awo-fs-finish-btn {
        position: fixed;
        right: 18px;
        bottom: 86px;
        z-index: 2147483647;
        display: block;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 999px;
        background: rgba(15,17,21,0.85);
        border: 1px solid rgba(255,255,255,0.16);
        color: rgba(255,255,255,0.95);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: .3px;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 14px 40px rgba(0,0,0,.45);
        backdrop-filter: blur(2px);
      }
      #awo-fs-finish-btn:hover { background: rgba(30,33,40,0.88); }
      #awo-fs-finish-btn .awo-dot {
        width: 10px; height: 10px; border-radius: 999px;
        background: rgba(0,255,140,0.9);
        box-shadow: 0 0 0 3px rgba(0,255,140,0.14);
        flex: 0 0 auto;
      }
      #awo-fs-finish-btn .awo-mini {
        font-size: 12px;
        opacity: .78;
        font-weight: 700;
      }
    `;
        document.head.appendChild(style);
    }

    function ensureFsFinishButton() {
        if (__awoFsBtn && document.body.contains(__awoFsBtn)) return;

        const btn = document.createElement('div');
        btn.id = 'awo-fs-finish-btn';
        btn.innerHTML = `
      <span class="awo-dot"></span>
      <span>Finish watching</span>
      <span class="awo-mini" id="awo-fs-finish-pct"></span>
    `;

        btn.addEventListener('click', () => {
            try {
                const payload = computeFsButtonState();
                if (!payload.shouldShow) return;

                const epId = payload.episodeId || '';
                if (epId) {
                    const key = FS_BUTTON_DEDUPE_KEY + epId;
                    if (sessionStorage.getItem(key) === '1') return;
                    sessionStorage.setItem(key, '1');
                }

                const anime = scrapeAnimeDetails();
                showFinishModal(anime);
            } catch (e) {
                console.warn('[Anime Extension] FS finish click failed:', e);
            }
        });

        document.body.appendChild(btn);
        __awoFsBtn = btn;
    }

    function bindFsButtonToVideo() {
        const vids = Array.from(document.querySelectorAll('video'));
        const vid =
            vids.find((v) => v && (v.readyState > 0 || v.duration) && isElementVisible(v)) ||
            vids[0] ||
            null;

        if (!vid) return;
        if (__awoFsBtnVideo === vid && __awoFsBtnBound) return;

        __awoFsBtnVideo = vid;
        __awoFsBtnBound = true;

        const onTime = () => updateFsFinishButtonVisibility();
        vid.addEventListener('timeupdate', onTime, { passive: true });
        vid.addEventListener('durationchange', onTime, { passive: true });
        vid.addEventListener('loadedmetadata', onTime, { passive: true });
        vid.addEventListener('play', onTime, { passive: true });

        updateFsFinishButtonVisibility();
    }

    function isElementVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
    }

    function isFullscreenActive() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function getCurrentEpisodeIdForDedupe() {
        try {
            const u = new URL(location.href);
            const ep = u.searchParams.get('ep');
            if (ep) return String(ep);
        } catch { }
        return null;
    }

    function getVideoPercentWatched(video) {
        if (!video) return null;
        const d = Number(video.duration);
        const t = Number(video.currentTime);
        if (!Number.isFinite(d) || d <= 0) return null;
        if (!Number.isFinite(t) || t < 0) return null;
        return Math.min(100, Math.max(0, (t / d) * 100));
    }

    function computeFsButtonState() {
        const video = __awoFsBtnVideo;
        const percent = getVideoPercentWatched(video);

        const fs = isFullscreenActive();
        const okPct = Number.isFinite(percent) && percent >= FS_BUTTON_PERCENT_THRESHOLD;

        const tickTotal = getTotalEpisodesFromTick();
        const activeEp = getActiveEpisodeNumber();
        const isLastEp = !!tickTotal && !!activeEp && activeEp === tickTotal;

        const alreadyFinished = isAlreadyFinishedInLocalSet();

        const shouldShow = fs && okPct && isLastEp && !alreadyFinished;

        return {
            shouldShow,
            percent: Number.isFinite(percent) ? percent : null,
            episodeId: getCurrentEpisodeIdForDedupe()
        };
    }

    function updateFsFinishButtonVisibility() {
        if (!__awoFsBtn) return;

        const state = computeFsButtonState();

        const pctEl = document.getElementById('awo-fs-finish-pct');
        if (pctEl) pctEl.textContent = state.percent != null ? `${Math.floor(state.percent)}%` : '';

        __awoFsBtn.style.display = state.shouldShow ? 'inline-flex' : 'none';
    }

    // =========================
    // Debug HUD (optional)
    // =========================
    let __awoDebugHud = null;
    let __awoDebugEnabled = false;
    let __awoDebugTimer = null;

    function initAwoDebugHud() {
        __awoDebugEnabled = !!AWO_DEBUG;
        if (!__awoDebugEnabled) return;

        injectAwoDebugHudStyles();
        ensureAwoDebugHud();
        setAwoDebugHudVisible(__awoDebugEnabled);

        document.addEventListener('keydown', (e) => {
            const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea') return;

            if ((e.key || '').toLowerCase() === (AWO_DEBUG_KEY_TOGGLE || 'd')) {
                __awoDebugEnabled = !__awoDebugEnabled;
                setAwoDebugHudVisible(__awoDebugEnabled);
                if (__awoDebugEnabled) tickAwoDebugHud(true);
            }
        });

        __awoDebugTimer = setInterval(() => tickAwoDebugHud(false), 250);
        tickAwoDebugHud(true);
    }

    function injectAwoDebugHudStyles() {
        if (document.getElementById('awo-debug-hud-style')) return;
        const style = document.createElement('style');
        style.id = 'awo-debug-hud-style';
        style.textContent = `
      #awo-debug-hud {
        position: fixed;
        top: 12px;
        left: 12px;
        z-index: 2147483647;
        width: 320px;
        max-width: calc(100vw - 24px);
        background: rgba(0,0,0,.72);
        border: 1px solid rgba(255,255,255,.18);
        color: rgba(255,255,255,.92);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 12px;
        line-height: 1.35;
        border-radius: 12px;
        padding: 10px 10px;
        backdrop-filter: blur(2px);
        box-shadow: 0 12px 34px rgba(0,0,0,.45);
        display: none;
        pointer-events: none;
        white-space: pre;
      }
      #awo-debug-hud .awo-debug-title { font-weight: 900; margin-bottom: 6px; letter-spacing: .3px; }
      #awo-debug-hud .awo-debug-hint { opacity: .75; margin-top: 6px; }
    `;
        document.head.appendChild(style);
    }

    function ensureAwoDebugHud() {
        if (__awoDebugHud && document.body.contains(__awoDebugHud)) return;
        const hud = document.createElement('div');
        hud.id = 'awo-debug-hud';
        hud.innerHTML = `<div class="awo-debug-title">AWO DEBUG</div><div id="awo-debug-lines"></div><div class="awo-debug-hint">Press "${(AWO_DEBUG_KEY_TOGGLE || 'd').toUpperCase()}" to toggle</div>`;
        document.body.appendChild(hud);
        __awoDebugHud = hud;
    }

    function setAwoDebugHudVisible(visible) {
        ensureAwoDebugHud();
        __awoDebugHud.style.display = visible ? 'block' : 'none';
    }

    function fmtBool(b) { return b ? 'true' : 'false'; }
    function fmtNum(n, digits = 2) { if (!Number.isFinite(n)) return 'n/a'; return n.toFixed(digits); }

    function tickAwoDebugHud(forceLog) {
        if (!__awoDebugEnabled) return;

        try {
            if (!__awoFsBtnVideo) bindFsButtonToVideo();
        } catch { }

        const fs = (() => {
            try { return !!(document.fullscreenElement || document.webkitFullscreenElement); } catch { return false; }
        })();

        const video = __awoFsBtnVideo || null;
        const ct = video ? Number(video.currentTime) : NaN;
        const du = video ? Number(video.duration) : NaN;
        const pct = (video && Number.isFinite(du) && du > 0 && Number.isFinite(ct))
            ? Math.min(100, Math.max(0, (ct / du) * 100))
            : NaN;

        let state = null;
        try { state = computeFsButtonState(); } catch { state = null; }

        const tickTotal = (() => { try { return getTotalEpisodesFromTick(); } catch { return null; } })();
        const activeEp = (() => { try { return getActiveEpisodeNumber(); } catch { return null; } })();
        const isLastEp = !!tickTotal && !!activeEp && activeEp === tickTotal;

        const alreadyFinished = (() => { try { return isAlreadyFinishedInLocalSet(); } catch { return false; } })();

        const btn = __awoFsBtn || document.getElementById('awo-fs-finish-btn');
        const btnDisplay = btn ? (btn.style.display || '(empty)') : 'missing';

        const lines = [];
        lines.push(`url: ${location.pathname}${location.search}`);
        lines.push(`fullscreen: ${fmtBool(fs)}`);
        lines.push(`videoFound: ${fmtBool(!!video)}`);
        lines.push(`time: ${fmtNum(ct, 1)} / ${fmtNum(du, 1)} sec`);
        lines.push(`percent: ${fmtNum(pct, 1)}% (threshold ${FS_BUTTON_PERCENT_THRESHOLD}%)`);
        lines.push(`tickTotal: ${tickTotal ?? 'n/a'} | activeEp: ${activeEp ?? 'n/a'} | isLastEp: ${fmtBool(isLastEp)}`);
        lines.push(`alreadyFinished: ${fmtBool(alreadyFinished)}`);

        if (state) {
            lines.push(`computeFsButtonState.shouldShow: ${fmtBool(!!state.shouldShow)}`);
            lines.push(`computeFsButtonState.percent: ${state.percent != null ? fmtNum(state.percent, 1) + '%' : 'n/a'}`);
            lines.push(`episodeId(dedupe): ${state.episodeId || 'n/a'}`);
        } else {
            lines.push(`computeFsButtonState: ERROR`);
        }

        lines.push(`btnExists: ${fmtBool(!!btn)} | btnDisplay: ${btnDisplay}`);

        const out = lines.join('\n');
        const box = document.getElementById('awo-debug-lines');
        if (box) box.textContent = out;

        if (forceLog) console.log('[AWO DEBUG]\n' + out);
    }
})();
