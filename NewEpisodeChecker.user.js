// ==UserScript==
// @name         AniKai New Episode Checker (AniList)
// @namespace    anime-extension
// @version      1.2.0
// @description  Shows new episode badges in continue-watching cards via AniList API. Caches anime_id→al_id from watch pages.
// @match        https://anikai.to/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const ANILIST_URL    = 'https://graphql.anilist.co';
  const LS_ALID_CACHE  = 'nec_alid_cache';  // { site_anime_id: anilist_id }
  const BADGE_ATTR     = 'data-nec-done';   // marks cards already processed

  // =========================
  // AniList ID cache (populated from #syncData on watch pages)
  // =========================
  function readAlidCache() {
    try { return JSON.parse(localStorage.getItem(LS_ALID_CACHE) || '{}'); }
    catch { return {}; }
  }

  function writeAlidCache(cache) {
    localStorage.setItem(LS_ALID_CACHE, JSON.stringify(cache));
  }

  /**
   * On /watch/* pages, #syncData contains anime_id and al_id.
   * Cache the mapping so we can resolve data-id on the home page.
   */
  function cacheFromSyncData() {
    const el = document.getElementById('syncData');
    if (!el) return;
    try {
      const data = JSON.parse(el.textContent);
      if (!data.anime_id || !data.al_id) return;
      const alid = parseInt(data.al_id, 10);
      if (!alid) return;
      const cache = readAlidCache();
      if (cache[data.anime_id] === alid) return; // already cached
      cache[data.anime_id] = alid;
      writeAlidCache(cache);
    } catch {}
  }

  // =========================
  // Background fetch: resolve unknown anime_id → al_id via watch pages
  // =========================
  const LS_META = 'user_watching_meta'; // [[anime_id, [watch_url, thumb, title, alt]], ...]

  /**
   * For anime_ids not yet in cache, fetch their watch page in the background,
   * parse #syncData, and store al_id. Returns updated cache.
   */
  async function warmCache(unknownIds) {
    if (!unknownIds.length) return readAlidCache();

    // Build anime_id → watch_url from localStorage
    let metaMap = new Map();
    try {
      const raw = localStorage.getItem(LS_META);
      if (raw) {
        for (const [id, data] of JSON.parse(raw)) {
          metaMap.set(id, data[0]); // data[0] = watch_url like "/watch/..."
        }
      }
    } catch {}

    const cache = readAlidCache();
    const toFetch = unknownIds.filter(id => metaMap.has(id));

    await Promise.all(toFetch.map(async (animeId) => {
      const url = metaMap.get(animeId);
      if (!url) return;
      try {
        const res = await fetch('https://anikai.to' + url, { credentials: 'include' });
        if (!res.ok) return;
        const html = await res.text();
        // Parse #syncData from the returned HTML (no DOMParser needed — regex is fine)
        const match = html.match(/<script[^>]+id=["']syncData["'][^>]*>([\s\S]*?)<\/script>/i);
        if (!match) return;
        const data = JSON.parse(match[1]);
        if (!data.al_id || !data.anime_id) return;
        const alid = parseInt(data.al_id, 10);
        if (alid) {
          cache[data.anime_id] = alid;
          console.log(`[NEC] Cached ${data.anime_id} → al_id ${alid} (${data.name})`);
        }
      } catch {}
    }));

    writeAlidCache(cache);
    return cache;
  }

  // =========================
  // AniList batch query
  // =========================
  const QUERY = `
    query ($ids: [Int]) {
      Page(perPage: 50) {
        media(id_in: $ids, type: ANIME) {
          id
          status
          episodes
          nextAiringEpisode {
            episode
            timeUntilAiring
          }
        }
      }
    }
  `;

  /**
   * @param {number[]} alids
   * @returns {Promise<Map<number, {lastEp: number, status: string}>>}
   */
  async function fetchAniListData(alids) {
    if (!alids.length) return new Map();
    try {
      const res = await fetch(ANILIST_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify({ query: QUERY, variables: { ids: alids } }),
      });
      if (!res.ok) {
        console.warn('[NEC] AniList request failed', res.status);
        return new Map();
      }
      const json = await res.json();
      const media = json?.data?.Page?.media ?? [];
      const map = new Map();
      for (const m of media) {
        let lastEp = 0;
        if (m.nextAiringEpisode) {
          // nextAiringEpisode.episode is the NEXT one — last released is episode - 1
          lastEp = m.nextAiringEpisode.episode - 1;
        } else if (m.episodes) {
          lastEp = m.episodes;
        }
        map.set(m.id, { lastEp, status: m.status });
      }
      return map;
    } catch (e) {
      console.warn('[NEC] AniList fetch error', e);
      return new Map();
    }
  }

  // =========================
  // Extract card info
  // =========================

  /**
   * Given a swiper-slide.aitem, returns { alid, currentEp, subEl } or null.
   *
   * Structure:
   *   div.swiper-slide.aitem[data-id="c4e-8ac"]
   *     div.inner
   *       div.ctrl
   *       a.poster
   *       a.title
   *       div.info
   *         span.sub  ← "6" (episode being watched)
   *         span      ← "24:42 / 24:42"
   *
   * No data-alid on the slide — resolved via LS_ALID_CACHE populated from watch pages.
   */
  function extractCard(card) {
    const siteId = card.dataset.id;
    if (!siteId) return null;

    // Try direct data-alid first (might exist in some card variants)
    const bookmarkEl = card.querySelector('[data-alid]');
    let alid = bookmarkEl ? parseInt(bookmarkEl.dataset.alid, 10) : 0;

    // Fall back to watch-page cache
    if (!alid) {
      const cache = readAlidCache();
      alid = cache[siteId] || 0;
    }

    if (!alid) return null;

    const infoEl = card.querySelector('div.info');
    if (!infoEl) return null;

    const subEl = infoEl.querySelector('span.sub');
    if (!subEl) return null;

    // span.sub may contain an SVG icon — extract only text nodes
    const rawText = [...subEl.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .join('');

    const currentEp = parseInt(rawText, 10);
    if (isNaN(currentEp)) return null;

    return { alid, currentEp, subEl };
  }

  // =========================
  // Inject badge
  // =========================

  function injectBadge(subEl, newEps, lastEp) {
    subEl.parentElement?.querySelector('.nec-badge')?.remove();

    const badge = document.createElement('span');
    badge.className = 'nec-badge';
    badge.textContent = `L ${lastEp}`;
    badge.title = `Latest episode: ${lastEp} (${newEps} new)`;
    const hasNew = newEps > 0;
    badge.style.cssText = `
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 1px 7px;
      border-radius: 999px;
      background: ${hasNew ? 'rgba(0, 220, 100, 0.18)' : 'rgba(255, 255, 255, 0.08)'};
      border: 1px solid ${hasNew ? 'rgba(0, 220, 100, 0.55)' : 'rgba(255, 255, 255, 0.2)'};
      color: ${hasNew ? 'rgb(0, 220, 100)' : 'rgba(255, 255, 255, 0.5)'};
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
      line-height: 1.5;
      vertical-align: middle;
      white-space: nowrap;
      pointer-events: none;
    `;
    subEl.insertAdjacentElement('afterend', badge);
  }

  // =========================
  // Process continue-watching cards
  // =========================
  async function processCards(container) {
    try {
    const cards = [...container.querySelectorAll('.swiper-slide.aitem')];
    if (!cards.length) return;

    // Find which site IDs are not yet in cache
    const currentCache = readAlidCache();
    const unknownIds = cards
      .filter(card => {
        const id = card.dataset.id;
        return id && !currentCache[id] && !card.querySelector('[data-alid]');
      })
      .map(card => card.dataset.id);

    // Warm cache for unknown IDs by fetching their watch pages
    if (unknownIds.length) await warmCache(unknownIds);

    const cardData = cards
      .map(card => ({ card, info: extractCard(card) }))
      .filter(({ info }) => info !== null);

    // Mark all cards so we don't reprocess on re-runs
    for (const card of cards) card.setAttribute(BADGE_ATTR, '1');

    if (!cardData.length) return;

    const alids = [];
    for (const { info } of cardData) {
      if (info.alid && !alids.includes(info.alid)) alids.push(info.alid);
    }

    const aniData = await fetchAniListData(alids);

    for (const { info } of cardData) {
      const data = aniData.get(info.alid);
      if (!data) continue;
      injectBadge(info.subEl, data.lastEp - info.currentEp, data.lastEp);
    }
    } catch (e) {
      console.warn('[NEC] processCards error:', e);
    }
  }

  // =========================
  // Watch for #continue-watching population (AJAX loaded)
  // =========================
  function watchContinueWatching() {
    const section = document.getElementById('continue-watching');
    if (!section) return;

    if (section.querySelector('.swiper-slide.aitem')) {
      processCards(section);
      return;
    }

    const mo = new MutationObserver(() => {
      if (section.querySelector('.swiper-slide.aitem')) {
        mo.disconnect();
        setTimeout(() => processCards(section), 300);
      }
    });
    mo.observe(section, { childList: true, subtree: true });
  }

  // =========================
  // SPA navigation
  // =========================
  function onPageChange() {
    setTimeout(() => {
      cacheFromSyncData();   // no-op if not on a watch page
      watchContinueWatching();
    }, 600);
  }

  const _push = history.pushState;
  history.pushState = function (...args) {
    const ret = _push.apply(this, args);
    onPageChange();
    return ret;
  };
  window.addEventListener('popstate', onPageChange);

  // =========================
  // Boot
  // =========================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageChange);
  } else {
    onPageChange();
  }

})();
