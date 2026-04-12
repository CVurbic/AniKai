// ==UserScript==
// @name         AniKai Continue Watching Sync (Supabase)
// @namespace    anime-extension
// @version      1.0.0
// @description  Bidirectional sync of continue-watching localStorage data to Supabase for cross-device access
// @match        https://anikai.to/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // =========================
  // Config
  // =========================
  const SUPABASE_URL  = 'https://xxqeupvmmmxltbtxcgvp.supabase.co';
  const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4cWV1cHZtbW14bHRidHhjZ3ZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE2Njk1Nzk3MDYsImV4cCI6MTk4NTE1NTcwNn0.Pump9exBhsc1TbUGqegEsqIXnmsmlUZMVlo2gSHoYDo';
  const TABLE         = 'continue_watching';

  // localStorage keys the site uses
  const LS_META       = 'user_watching_meta';   // [[anime_id, [url, thumb, title, alt_title]], ...]
  const LS_WATCH      = 'user_watching';         // [[anime_id, [ep_id, ep_num, ep_num_str, sub_dub, current_secs, total_secs]], ...]

  // Our own keys
  const LS_USER_ID    = 'cws_user_id';           // persistent device/user UUID
  const LS_TIMESTAMPS = 'cws_updated_at';        // {anime_id: ISO_string} — local update timestamps

  const PUSH_DEBOUNCE_MS  = 2000;   // wait 2s after last write before pushing
  const PERIODIC_SYNC_MS  = 5 * 60 * 1000; // full sync every 5 minutes

  // =========================
  // User ID
  // =========================
  function getUserId() {
    let id = localStorage.getItem(LS_USER_ID);
    if (!id) {
      id = 'u_' + crypto.randomUUID();
      localStorage.setItem(LS_USER_ID, id);
    }
    return id;
  }

  const USER_ID = getUserId();

  // =========================
  // Parse localStorage
  // =========================

  /**
   * Returns Map<anime_id, {url, thumbnail, title, alt_title}>
   */
  function parseMeta() {
    try {
      const raw = localStorage.getItem(LS_META);
      if (!raw) return new Map();
      const arr = JSON.parse(raw);
      const map = new Map();
      for (const [id, data] of arr) {
        map.set(id, {
          watch_url:  data[0] || null,
          thumbnail:  data[1] || null,
          title:      data[2] || null,
          alt_title:  data[3] || null,
        });
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Returns Map<anime_id, {episode_id, episode_num, sub_dub, current_secs, total_secs}>
   */
  function parseWatch() {
    try {
      const raw = localStorage.getItem(LS_WATCH);
      if (!raw) return new Map();
      const arr = JSON.parse(raw);
      const map = new Map();
      for (const [id, data] of arr) {
        map.set(id, {
          episode_id:   data[0] || null,
          episode_num:  Number(data[1]) || 0,
          sub_dub:      data[3] || 'sub',
          current_secs: Number(data[4]) || 0,
          total_secs:   Number(data[5]) || 0,
        });
      }
      return map;
    } catch {
      return new Map();
    }
  }

  function readTimestamps() {
    try {
      return JSON.parse(localStorage.getItem(LS_TIMESTAMPS) || '{}');
    } catch {
      return {};
    }
  }

  function writeTimestamps(ts) {
    localStorage.setItem(LS_TIMESTAMPS, JSON.stringify(ts));
  }

  /**
   * Merge meta + watch into flat row array ready for Supabase upsert.
   * Only includes anime_ids that appear in at least one of the maps.
   */
  function buildRows(meta, watch) {
    const ids = new Set([...meta.keys(), ...watch.keys()]);
    const ts = readTimestamps();
    const now = new Date().toISOString();
    const rows = [];

    for (const anime_id of ids) {
      const m = meta.get(anime_id) || {};
      const w = watch.get(anime_id) || {};
      rows.push({
        user_id:      USER_ID,
        anime_id,
        watch_url:    m.watch_url    ?? null,
        thumbnail:    m.thumbnail    ?? null,
        title:        m.title        ?? null,
        alt_title:    m.alt_title    ?? null,
        episode_id:   w.episode_id   ?? null,
        episode_num:  w.episode_num  ?? 0,
        sub_dub:      w.sub_dub      ?? 'sub',
        current_secs: w.current_secs ?? 0,
        total_secs:   w.total_secs   ?? 0,
        updated_at:   ts[anime_id]   || now,
      });
    }

    return rows;
  }

  // =========================
  // Supabase REST helpers
  // =========================
  const HEADERS = {
    'Content-Type': 'application/json',
    'apikey':       SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer':       'return=minimal',
  };

  async function sbUpsert(rows) {
    if (!rows.length) return;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method:  'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[CWS] upsert failed', res.status, txt);
    }
  }

  async function sbFetch() {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(USER_ID)}&select=*`,
      { headers: { ...HEADERS, 'Prefer': '' } }
    );
    if (!res.ok) {
      console.warn('[CWS] fetch failed', res.status);
      return [];
    }
    return res.json();
  }

  // =========================
  // Apply remote rows → localStorage
  // =========================

  /**
   * Given remote rows, merge them into localStorage.
   * Per anime_id: whichever updated_at is newer wins.
   */
  function applyRemoteRows(rows) {
    if (!rows.length) return;

    const localMeta  = parseMeta();
    const localWatch = parseWatch();
    const ts         = readTimestamps();

    let metaChanged  = false;
    let watchChanged = false;

    for (const row of rows) {
      const id          = row.anime_id;
      const remoteTime  = new Date(row.updated_at).getTime();
      const localTime   = ts[id] ? new Date(ts[id]).getTime() : 0;

      if (remoteTime <= localTime) continue; // local is newer or same, skip

      // Remote wins — update local maps
      if (row.watch_url || row.thumbnail || row.title) {
        localMeta.set(id, {
          watch_url: row.watch_url,
          thumbnail: row.thumbnail,
          title:     row.title,
          alt_title: row.alt_title,
        });
        metaChanged = true;
      }

      if (row.episode_id || row.episode_num) {
        localWatch.set(id, {
          episode_id:   row.episode_id,
          episode_num:  row.episode_num,
          sub_dub:      row.sub_dub,
          current_secs: row.current_secs,
          total_secs:   row.total_secs,
        });
        watchChanged = true;
      }

      ts[id] = row.updated_at;
    }

    if (metaChanged) {
      const arr = [...localMeta.entries()].map(([id, m]) => [
        id,
        [m.watch_url, m.thumbnail, m.title, m.alt_title],
      ]);
      // Write without triggering our own push (use raw setItem before we patch it)
      _origSetItem.call(localStorage, LS_META, JSON.stringify(arr));
    }

    if (watchChanged) {
      const arr = [...localWatch.entries()].map(([id, w]) => [
        id,
        [w.episode_id, w.episode_num, String(w.episode_num), w.sub_dub, w.current_secs, w.total_secs],
      ]);
      _origSetItem.call(localStorage, LS_WATCH, JSON.stringify(arr));
    }

    if (metaChanged || watchChanged) {
      writeTimestamps(ts);
      log('pull', `Applied ${rows.length} remote rows`);
    }
  }

  // =========================
  // Push logic
  // =========================
  let pushTimer = null;

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, PUSH_DEBOUNCE_MS);
  }

  async function doPush() {
    const meta  = parseMeta();
    const watch = parseWatch();
    const rows  = buildRows(meta, watch);

    // Stamp all rows with now (they just changed locally)
    const now = new Date().toISOString();
    const ts  = readTimestamps();
    for (const row of rows) {
      row.updated_at = now;
      ts[row.anime_id] = now;
    }
    writeTimestamps(ts);

    await sbUpsert(rows);
    log('push', `Pushed ${rows.length} rows`);
  }

  // =========================
  // Full sync (pull then push delta)
  // =========================
  async function fullSync() {
    log('sync', 'Starting full sync...');
    const remote = await sbFetch();
    applyRemoteRows(remote);

    // Push anything newer locally that remote doesn't have
    const meta  = parseMeta();
    const watch = parseWatch();
    const ts    = readTimestamps();

    const remoteMap = new Map(remote.map(r => [r.anime_id, r]));
    const rows = buildRows(meta, watch);
    const toPush = rows.filter(row => {
      const rem = remoteMap.get(row.anime_id);
      if (!rem) return true; // remote missing this entry
      const localTime  = ts[row.anime_id] ? new Date(ts[row.anime_id]).getTime() : 0;
      const remoteTime = new Date(rem.updated_at).getTime();
      return localTime > remoteTime;
    });

    if (toPush.length) {
      await sbUpsert(toPush);
      log('sync', `Pushed ${toPush.length} newer local rows`);
    } else {
      log('sync', 'Local already up to date');
    }
  }

  // =========================
  // Patch localStorage to detect site writes
  // =========================
  const _origSetItem = localStorage.setItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    _origSetItem(key, value);
    if (key === LS_META || key === LS_WATCH) {
      // Stamp updated_at for changed entries
      stampChangedEntries(key, value);
      schedulePush();
    }
  };

  /**
   * When the site writes user_watching or user_watching_meta,
   * figure out which anime_ids changed and stamp them with now.
   */
  function stampChangedEntries(key, newValue) {
    try {
      const arr = JSON.parse(newValue);
      const ts  = readTimestamps();
      const now = new Date().toISOString();
      let changed = false;
      for (const [id] of arr) {
        ts[id] = now;
        changed = true;
      }
      if (changed) writeTimestamps(ts);
    } catch {
      // ignore parse errors
    }
  }

  // Cross-tab: the site on another tab changed localStorage
  window.addEventListener('storage', (e) => {
    if (e.key === LS_META || e.key === LS_WATCH) {
      log('storage', `Cross-tab change on ${e.key} — scheduling push`);
      schedulePush();
    }
  });

  // =========================
  // Status HUD (small floating indicator)
  // =========================
  const hud = document.createElement('div');
  hud.id = 'cws-hud';
  hud.style.cssText = `
    position: fixed;
    bottom: 56px;
    left: 14px;
    z-index: 2147483640;
    padding: 5px 10px;
    border-radius: 10px;
    background: rgba(14,14,14,.82);
    color: rgba(255,255,255,.75);
    font: 11px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
    border: 1px solid rgba(255,255,255,.10);
    pointer-events: none;
    display: none;
  `;
  document.documentElement.appendChild(hud);

  let hudTimer = null;
  function showHud(msg) {
    hud.textContent = `CWS: ${msg}`;
    hud.style.display = 'block';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud.style.display = 'none'), 3000);
  }

  function log(type, msg) {
    console.log(`[CWS:${type}] ${msg}`);
    showHud(msg);
  }

  // =========================
  // Boot
  // =========================
  async function boot() {
    log('boot', `User: ${USER_ID.slice(0, 16)}…`);
    await fullSync();
    setInterval(fullSync, PERIODIC_SYNC_MS);
  }

  // Run after page has settled
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    setTimeout(boot, 500);
  }

})();
