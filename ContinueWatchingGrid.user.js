// ==UserScript==
// @name         AniKai Continue Watching Grid
// @namespace    anime-extension
// @version      3.0
// @description  Replaces the Continue Watching swiper with a 6-column grid. Unwatched episodes first. Expand/collapse rows.
// @match        https://anikai.to/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const ROWS_INIT   = 1;
  const ROWS_MAX    = 5;
  const COLS        = 6;
  const GAP         = 14;  // px
  const NEC_TIMEOUT = 3000;

  // =========================
  // CSS
  // =========================
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    /* ── Grid ── */
    .ae-cw-grid {
      display: grid !important;
      grid-template-columns: repeat(${COLS}, 1fr) !important;
      gap: ${GAP}px !important;
      padding: 8px 0 0 !important;
      width: 100% !important;
      overflow: hidden !important;
      transition: max-height .35s ease !important;
      box-sizing: border-box !important;
    }

    /* ── Strip all swiper layout from cards ── */
    .ae-cw-grid .aitem,
    .ae-cw-grid .swiper-slide {
      float:   none !important;
      width:   auto !important;
      height:  auto !important;
      margin:  0    !important;
      position: relative !important;
      flex-shrink: 0 !important;
      transition: none !important;
    }

    /* ── Inner: rounded card, clip content ── */
    .ae-cw-grid .aitem .inner {
      display: flex !important;
      flex-direction: column !important;
      border-radius: var(--bs-border-radius, 12px) !important;
      overflow: hidden !important;
      padding: 0 !important;
      height: auto !important;
      width: 100% !important;
      background: var(--bs-secondary-bg, #11161b) !important;
      position: relative !important;
      box-sizing: border-box !important;
    }

    /* ── Poster: fixed height, image covers ── */
    .ae-cw-grid .aitem .poster {
      display: block !important;
      flex-shrink: 0 !important;
      height: 200px !important;
      width: 100% !important;
      overflow: hidden !important;
    }
    .ae-cw-grid .aitem .poster > div {
      width: 100% !important;
      height: 100% !important;
    }
    .ae-cw-grid .aitem .poster img {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
    }

    /* ── Title section ── */
    .ae-cw-grid .ae-cw-title {
      flex-shrink: 0 !important;
      padding: 6px 8px 4px !important;
    }
    .ae-cw-grid .ae-cw-title > a.title {
      display: -webkit-box !important;
      -webkit-line-clamp: 2 !important;
      -webkit-box-orient: vertical !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: normal !important;
      margin: 0 !important;
      font-size: 12px !important;
      line-height: 1.35 !important;
      height: calc(1.35em * 2) !important;
    }

    /* ── Meta section (badges + countdown) ── */
    .ae-cw-grid .ae-cw-meta {
      flex-shrink: 0 !important;
      padding: 0 8px 6px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;
    }
    .ae-cw-grid .ae-cw-meta > .info {
      display: flex !important;
      align-items: center !important;
      flex-wrap: nowrap !important;
      gap: 4px !important;
      margin: 0 !important;
      font-size: 11px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
    }
    .ae-cw-grid .ae-cw-meta > .info .nec-badge {
      font-size: 9px !important;
      padding: 1px 4px !important;
      flex-shrink: 0 !important;
    }
    .ae-cw-grid .ae-cw-meta > .info span:last-child b {
      font-size: 11px !important;
    }
    .ae-cw-grid .ae-cw-meta > .nec-countdown {
      margin: 0 !important;
      font-size: 10px !important;
    }
    .ae-cw-grid .ae-cw-meta > .progress-bar {
      margin: 2px 0 0 !important;
      border-radius: 0 !important;
    }

    /* ── X button: absolute overlay on image ── */
    .ae-cw-grid .aitem .ctrl {
      position: absolute !important;
      top:    8px !important;
      right:  8px !important;
      left:   auto !important;
      bottom: auto !important;
      z-index: 10 !important;
      width: auto !important;
      height: auto !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      background: transparent !important;
    }
    .ae-cw-grid .aitem .ctrl .watching-delete {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      position: static !important;
      width: 26px !important;
      height: 26px !important;
      background-color: rgb(228, 95, 58) !important;
      color: rgb(255, 255, 255) !important;
      border-radius: 50% !important;
      border: none !important;
      cursor: pointer !important;
      opacity: 1 !important;
      font-weight: 400 !important;
      box-shadow: none !important;
      outline: none !important;
      padding: 0 !important;
      transform: none !important;
    }

    /* ── Hover ── */
    .ae-cw-grid .aitem {
      transition: transform .15s ease !important;
    }
    .ae-cw-grid .aitem:hover {
      transform: translateY(-3px) scale(1.02) !important;
      z-index: 2 !important;
    }
    .ae-cw-grid .aitem:hover .inner {
      box-shadow: 0 8px 24px rgba(0,0,0,.45) !important;
    }

    /* ── Unwatched: green border ── */
    .ae-cw-grid .aitem.ae-has-unwatched .inner {
      outline: 1.5px solid rgba(0, 220, 100, .4) !important;
    }

    /* ── Expand / collapse row ── */
    .ae-cw-expand-row {
      display: flex;
      justify-content: center;
      padding: 8px 0 4px;
    }
    .ae-cw-expand-btn {
      background: transparent;
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 99px;
      color: rgba(255,255,255,.45);
      font: 600 11px/1 system-ui, sans-serif;
      letter-spacing: .35px;
      padding: 5px 20px;
      cursor: pointer;
      user-select: none;
      transition: border-color .15s, color .15s, background .15s;
    }
    .ae-cw-expand-btn:hover {
      border-color: rgba(255,255,255,.3);
      color: rgba(255,255,255,.85);
      background: rgba(255,255,255,.05);
    }
  `;
  document.documentElement.appendChild(styleEl);

  // =========================
  // Helpers
  // =========================
  function parseNum(text) {
    const m = String(text || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function getEpInfo(item) {
    const badge  = item.querySelector('.nec-badge');
    const subEl  = item.querySelector('.info .sub');
    const title  = badge?.getAttribute('title') || '';
    const latest  = parseNum(title.match(/Latest episode:\s*(\d+)/i)?.[1]);
    const newCnt  = parseNum(title.match(/\((\d+)\s+new\)/i)?.[1]);
    const watched = parseNum(subEl?.textContent);
    return { latest, watched, newCnt, hasUnwatched: latest > 0 && watched < latest };
  }

  function allNecDone(items) {
    return items.every(el => el.hasAttribute('data-nec-done'));
  }

  // localStorage index 0 = most recently watched
  function getWatchOrder() {
    try {
      const raw = localStorage.getItem('user_watching');
      if (!raw) return new Map();
      return new Map(JSON.parse(raw).map(([id], i) => [id, i]));
    } catch { return new Map(); }
  }

  function applySort(items) {
    const watchOrder = getWatchOrder();
    items.forEach(item => {
      const info = getEpInfo(item);
      if (info.hasUnwatched) item.classList.add('ae-has-unwatched');
      else item.classList.remove('ae-has-unwatched');
      item._newCnt   = info.newCnt;
      item._watchIdx = watchOrder.get(item.dataset.id) ?? 9999;
    });
    items.sort((a, b) => {
      const au = a.classList.contains('ae-has-unwatched');
      const bu = b.classList.contains('ae-has-unwatched');
      if (au !== bu) return bu ? 1 : -1;
      if (au) return (b._newCnt || 0) - (a._newCnt || 0);   // most new eps first
      return (b._watchIdx || 0) - (a._watchIdx || 0);        // highest index = most recently watched
    });
    return items;
  }

  function findCWSection() {
    for (const s of document.querySelectorAll('section')) {
      const btn = s.querySelector('.onoff-toggle');
      if (btn && /continue\s+watching/i.test(btn.textContent)) return s;
    }
    return null;
  }

  // =========================
  // Transform
  // =========================
  function transform(section) {
    if (section.dataset.cwGrid) return;
    section.dataset.cwGrid = '1';

    const swiperEl = section.querySelector('.swiper');
    if (!swiperEl) return;

    const items = [...section.querySelectorAll('.aitem')];
    if (!items.length) return;

    // Destroy Swiper
    if (swiperEl.swiper) {
      try { swiperEl.swiper.destroy(true, false); } catch {}
    }

    // Initial sort (NEC badges may not exist yet — re-sort fires after they land)
    applySort(items);

    // Build grid
    const grid = document.createElement('div');
    grid.className = 'ae-cw-grid';

    for (const item of items) {
      // Strip all inline swiper sizing
      ['width','height','margin-right','margin-bottom','transform','left','opacity'].forEach(p => {
        item.style.removeProperty(p);
      });
      grid.appendChild(item);

      // Split text into title section + meta section
      const inner = item.querySelector('.inner');
      if (inner) {
        const titleEl = inner.querySelector(':scope > a.title');
        if (titleEl) {
          const titleWrap = document.createElement('div');
          titleWrap.className = 'ae-cw-title';
          titleWrap.appendChild(titleEl);
          inner.appendChild(titleWrap);
        }

        // .info moves into meta; nec-countdown inserted by NEC afterend of .info
        // → lands inside .ae-cw-meta automatically
        const metaEls = [...inner.querySelectorAll(':scope > .info, :scope > .progress-bar')];
        if (metaEls.length) {
          const metaWrap = document.createElement('div');
          metaWrap.className = 'ae-cw-meta';
          metaEls.forEach(el => metaWrap.appendChild(el));
          inner.appendChild(metaWrap);
        }
      }
    }

    // Expand row
    const expandRow = document.createElement('div');
    expandRow.className = 'ae-cw-expand-row';
    expandRow.innerHTML = `<button class="ae-cw-expand-btn">▼ Show more</button>`;

    const tabNav = section.querySelector('.tab-nav');
    if (tabNav) tabNav.style.display = 'none';

    swiperEl.replaceWith(grid);
    grid.insertAdjacentElement('afterend', expandRow);

    // Re-sort once NEC injects badges (data-nec-done fires before AniList fetch completes)
    const resortObs = new MutationObserver((_, obs) => {
      if (grid.querySelector('.nec-badge')) {
        obs.disconnect();
        const gridItems = [...grid.querySelectorAll('.aitem')];
        applySort(gridItems);
        gridItems.forEach(item => grid.appendChild(item));
      }
    });
    resortObs.observe(grid, { childList: true, subtree: true });
    setTimeout(() => resortObs.disconnect(), 10000);

    // Expand/collapse — measure after paint
    let expanded = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const totalRows = Math.ceil(items.length / COLS);
        if (totalRows <= ROWS_INIT) {
          expandRow.style.display = 'none';
          return;
        }

        const rowH    = grid.firstElementChild?.getBoundingClientRect().height ?? 0;
        const calcH   = rows => (rowH * rows + 20 + GAP * (rows - 1)) + 'px'  ;

        grid.style.maxHeight = calcH(ROWS_INIT);

        const btn = expandRow.querySelector('.ae-cw-expand-btn');
        btn.addEventListener('click', () => {
          expanded = !expanded;
          grid.style.maxHeight = expanded ? calcH(Math.min(ROWS_MAX, totalRows) + 20) : calcH(ROWS_INIT);
          btn.textContent = expanded ? '▲ Show less' : '▼ Show more';
        });
      });
    });
  }

  // =========================
  // Init
  // =========================
  function tryInit() {
    const section = findCWSection();
    if (!section || section.dataset.cwGrid) return !!section?.dataset.cwGrid;

    const items = [...section.querySelectorAll('.aitem')];
    if (!items.length) return false;

    if (allNecDone(items)) { transform(section); return true; }

    // Wait for NEC badges
    const deadline = Date.now() + NEC_TIMEOUT;
    const mo = new MutationObserver(() => {
      const cur = [...section.querySelectorAll('.aitem')];
      if (allNecDone(cur) || Date.now() >= deadline) { mo.disconnect(); transform(section); }
    });
    mo.observe(section, { subtree: true, attributes: true, attributeFilter: ['data-nec-done'] });
    setTimeout(() => { mo.disconnect(); if (!section.dataset.cwGrid) transform(section); }, NEC_TIMEOUT);
    return true;
  }

  function init() {
    if (tryInit()) return;
    const mo = new MutationObserver(() => { if (tryInit()) mo.disconnect(); });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  }

  // SPA
  const _push = history.pushState;
  history.pushState = function (...a) { const r = _push.apply(this, a); setTimeout(init, 300); return r; };
  const _replace = history.replaceState;
  history.replaceState = function (...a) { const r = _replace.apply(this, a); setTimeout(init, 300); return r; };
  window.addEventListener('popstate', () => setTimeout(init, 300));

  // Boot
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
