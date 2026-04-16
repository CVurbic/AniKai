// ==UserScript==
// @name         AniKai Inspector Overlay
// @namespace    anime-extension
// @version      1.0
// @description  Inspector + DOM Tree + attributes + computed styles + LOG + Console mirror + Network spy + Episode watcher + syncData reader
// @match        https://anikai.to/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // =========================
  // Settings
  // =========================
  const HOTKEY_TOGGLE = { ctrl: true, shift: true, key: 'I' }; // Ctrl+Shift+I
  const PREFER_INTERESTING_ANCESTOR = true;

  const COMPUTED_KEYS = [
    'display', 'position', 'background-color', 'color', 'font-weight',
    'opacity', 'border-left-width', 'border-left-style', 'border-left-color',
    'border-radius', 'outline-color', 'box-shadow',
  ];

  const LOG_MAX = 400;
  const TREE_MAX_ANCESTORS = 10;
  const TREE_CHILD_DEPTH = 3;
  const TREE_MAX_CHILDREN = 30;

  // =========================
  // Helpers
  // =========================
  const cssEscape =
    window.CSS && CSS.escape
      ? CSS.escape
      : (s) => String(s).replace(/([^\w-])/g, '\\$1');

  function clampText(s, max = 220) {
    s = (s || '').toString().trim().replace(/\s+/g, ' ');
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  function clampBlock(s, max = 4000) {
    s = (s || '').toString();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  function safeStringify(v, maxLen = 1600) {
    try {
      if (typeof v === 'string') return clampBlock(v, maxLen);
      if (v instanceof Error) return clampBlock(`${v.name}: ${v.message}\n${v.stack || ''}`, maxLen);
      if (v instanceof Event) return clampBlock(`[Event ${v.type}]`, maxLen);
      if (v && typeof v === 'object') {
        const seen = new WeakSet();
        const json = JSON.stringify(
          v,
          (k, val) => {
            if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
            if (val && typeof val === 'object') {
              if (seen.has(val)) return '[Circular]';
              seen.add(val);
            }
            return val;
          },
          2
        );
        return clampBlock(json, maxLen);
      }
      return clampBlock(String(v), maxLen);
    } catch {
      return clampBlock(String(v), maxLen);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getReadableText(el) {
    if (!el) return '';
    const t = el.getAttribute('aria-label') || el.title || el.alt || el.textContent || '';
    return clampText(t, 220);
  }

  function getSimpleSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${cssEscape(el.id)}`;
    const cls = [...el.classList]
      .filter(Boolean)
      .filter(c => !/^(\d+|show|hide|open|close)$/i.test(c));
    if (cls.length) return el.tagName.toLowerCase() + '.' + cls.slice(0, 3).map(cssEscape).join('.');
    return el.tagName.toLowerCase();
  }

  function isUniqueSelector(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function getNthChildSelector(el) {
    if (!el || !el.parentElement) return '';
    const parent = el.parentElement;
    const tag = el.tagName.toLowerCase();
    const siblings = [...parent.children].filter(c => c.tagName.toLowerCase() === tag);
    if (siblings.length === 1) return tag;
    const index = siblings.indexOf(el) + 1;
    return `${tag}:nth-of-type(${index})`;
  }

  function buildBestSelector(el, maxDepth = 6) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${cssEscape(el.id)}`;

    let parts = [];
    let cur = el;
    let depth = 0;

    while (cur && cur.nodeType === 1 && depth < maxDepth && cur !== document.documentElement) {
      let part = getSimpleSelector(cur);
      const tentative = [part, ...parts].join(' > ');
      if (!isUniqueSelector(tentative)) {
        part = getNthChildSelector(cur);
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (isUniqueSelector(sel)) return sel;
      cur = cur.parentElement;
      depth++;
    }

    return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
  }

  function describeElement(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList && el.classList.length ? '.' + [...el.classList].join('.') : '';
    return `${tag}${id}${cls}`;
  }

  function getHrefOrSrc(el) {
    if (!el) return '';
    const href = el.getAttribute('href');
    const src = el.getAttribute('src') || el.getAttribute('data-src');
    return clampText(href || src || '', 260);
  }

  function getAttributesDump(el) {
    if (!el || !el.attributes) return '(none)';
    const attrs = [...el.attributes]
      .map(a => {
        const v = a.value === '' ? '""' : JSON.stringify(a.value);
        return `${a.name}=${v}`;
      })
      .sort((a, b) => a.localeCompare(b));
    if (!attrs.length) return '(none)';
    return clampBlock(attrs.join('\n'), 4000);
  }

  function getComputedDump(el) {
    if (!el) return '(none)';
    const cs = getComputedStyle(el);
    return clampBlock(COMPUTED_KEYS.map(k => `${k}: ${cs.getPropertyValue(k).trim()}`).join('\n'), 2500);
  }

  function getMatchFlags(el) {
    if (!el) return '(none)';
    const flags = [];
    const classFlags = ['active','selected','current','playing','on','is-active','is-current','watched','seen'];
    for (const c of classFlags) {
      if (el.classList.contains(c)) flags.push(`class:${c}`);
    }
    const ariaCurrent = el.getAttribute('aria-current');
    if (ariaCurrent) flags.push(`aria-current:${ariaCurrent}`);
    const ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected) flags.push(`aria-selected:${ariaSelected}`);
    const role = el.getAttribute('role');
    if (role) flags.push(`role:${role}`);
    if (el.matches?.('[data-active],[data-current],[data-selected]')) flags.push('has:data-active/current/selected');
    if (el.matches?.('.active,.selected,.current')) flags.push('matches:.active/.selected/.current');
    return flags.length ? flags.join(' | ') : '(none)';
  }

  function getParentChain(el, max = 6) {
    if (!el) return '(none)';
    const chain = [];
    let cur = el;
    let i = 0;
    while (cur && cur.nodeType === 1 && i < max && cur !== document.documentElement) {
      chain.push(describeElement(cur));
      cur = cur.parentElement;
      i++;
    }
    return chain.length ? chain.join('\n') : '(none)';
  }

  function getSiblingInfo(el) {
    if (!el || !el.parentElement) return '(none)';
    const parent = el.parentElement;
    const children = parent.children ? parent.children.length : 0;
    const tag = el.tagName.toLowerCase();
    const sameTag = [...parent.children].filter(c => c.tagName.toLowerCase() === tag).length;
    return `parent children: ${children}\nsame <${tag}> siblings: ${sameTag}`;
  }

  function pickInteresting(el) {
    if (!PREFER_INTERESTING_ANCESTOR || !el) return el;
    let cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      const tag = cur.tagName?.toLowerCase();
      const hasHref = cur.getAttribute?.('href');
      const hasData = cur.getAttribute?.('data-number') || cur.getAttribute?.('data-id') || cur.getAttribute?.('data-ep');
      const role = cur.getAttribute?.('role');
      if (tag === 'a' || tag === 'li' || tag === 'button') return cur;
      if (hasHref || hasData) return cur;
      if (role === 'button' || role === 'tab') return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  // =========================
  // CSS
  // =========================
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    /* ── Toggle button ── */
    #ae-inspector-btn {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 12px;
      border-radius: 99px;
      border: 1.5px solid rgba(255,255,255,.13);
      background: rgba(13,13,15,.92);
      color: rgba(255,255,255,.6);
      font: 600 11.5px/1 system-ui, -apple-system, Segoe UI, sans-serif;
      cursor: pointer;
      user-select: none;
      letter-spacing: .3px;
      box-shadow: 0 4px 18px rgba(0,0,0,.5);
      transition: border-color .15s, color .15s, box-shadow .15s;
    }
    #ae-inspector-btn:hover { border-color: rgba(255,255,255,.25); color: rgba(255,255,255,.9); }
    #ae-inspector-btn[data-on="true"] {
      border-color: rgba(0,255,140,.65);
      color: #fff;
      box-shadow: 0 0 0 3px rgba(0,255,140,.1), 0 4px 18px rgba(0,0,0,.5);
    }
    #ae-btn-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: rgba(255,255,255,.25);
      flex-shrink: 0;
      transition: background .15s, box-shadow .15s;
    }
    #ae-inspector-btn[data-on="true"] #ae-btn-dot {
      background: #00ff8c;
      box-shadow: 0 0 7px rgba(0,255,140,.9);
    }

    /* ── Panel ── */
    #ae-inspector-panel {
      position: fixed;
      bottom: 58px;
      right: 16px;
      width: min(700px, calc(100vw - 32px));
      height: min(76vh, 720px);
      z-index: 2147483647;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.09);
      background: rgba(11,11,14,.96);
      color: #fff;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.03) inset;
      display: none;
      flex-direction: column;
      resize: both;
      min-width: 420px;
      min-height: 260px;
      overflow: hidden;
    }

    /* ── Header ── */
    .ae-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 14px 9px;
      flex-shrink: 0;
      cursor: grab;
      user-select: none;
      border-bottom: 1px solid rgba(255,255,255,.07);
      transition: background .2s;
    }
    #ae-inspector-panel[data-dragging="true"] .ae-hdr { cursor: grabbing; }
    #ae-inspector-panel[data-frozen="true"] .ae-hdr {
      background: rgba(251,191,36,.04);
      border-bottom-color: rgba(251,191,36,.15);
    }
    .ae-hdr-left { display: flex; align-items: center; gap: 9px; }
    .ae-hdr-title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
    .ae-hdr-right { display: flex; align-items: center; gap: 5px; }

    /* Freeze badge */
    #ae-freeze-badge {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .7px;
      padding: 3px 9px;
      border-radius: 99px;
      border: 1.5px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.45);
      cursor: pointer;
      transition: all .15s;
    }
    #ae-freeze-badge:hover { border-color: rgba(251,191,36,.4); color: rgba(251,191,36,.85); }
    #ae-inspector-panel[data-frozen="true"] #ae-freeze-badge {
      border-color: rgba(251,191,36,.55);
      color: #fbbf24;
      background: rgba(251,191,36,.08);
    }

    /* Header icon buttons */
    .ae-hdr-btn {
      border: 1px solid rgba(255,255,255,.09);
      background: transparent;
      color: rgba(255,255,255,.45);
      border-radius: 7px;
      width: 26px; height: 26px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      font: 12px/1 system-ui, sans-serif;
      transition: background .12s, color .12s, border-color .12s;
    }
    .ae-hdr-btn:hover { background: rgba(255,255,255,.08); color: rgba(255,255,255,.85); border-color: rgba(255,255,255,.18); }

    /* ── Tab nav ── */
    .ae-tabs {
      display: flex;
      gap: 1px;
      padding: 0 14px;
      flex-shrink: 0;
      background: rgba(255,255,255,.025);
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .ae-tab {
      padding: 8px 14px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: .25px;
      color: rgba(255,255,255,.38);
      cursor: pointer;
      user-select: none;
      border-bottom: 2px solid transparent;
      transition: color .12s, border-color .12s;
      margin-bottom: -1px;
    }
    .ae-tab:hover { color: rgba(255,255,255,.65); }
    .ae-tab.ae-tab-active {
      color: #fff;
      border-bottom-color: #00ff8c;
    }

    /* ── Panes ── */
    .ae-pane { display: none; flex: 1; overflow: hidden; min-height: 0; }
    .ae-pane.ae-pane-active { display: flex; flex-direction: column; }

    /* Element pane */
    .ae-scroll {
      overflow-y: auto;
      flex: 1;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .ae-scroll::-webkit-scrollbar { width: 4px; }
    .ae-scroll::-webkit-scrollbar-track { background: transparent; }
    .ae-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 4px; }

    /* Collapsible sections */
    .ae-section {
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 9px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .ae-section-hdr {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      cursor: pointer;
      user-select: none;
      background: rgba(255,255,255,.025);
      transition: background .12s;
    }
    .ae-section-hdr:hover { background: rgba(255,255,255,.05); }
    .ae-section-title {
      flex: 1;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .55px;
      text-transform: uppercase;
      color: rgba(255,255,255,.42);
    }
    .ae-section-copy {
      border: 1px solid transparent !important;
      background: transparent !important;
      color: rgba(255,255,255,.22) !important;
      border-radius: 5px !important;
      padding: 2px 6px !important;
      font: 11px/1 system-ui, sans-serif !important;
      cursor: pointer;
      transition: color .12s, border-color .12s, background .12s !important;
    }
    .ae-section-copy:hover {
      color: rgba(255,255,255,.75) !important;
      border-color: rgba(255,255,255,.18) !important;
      background: rgba(255,255,255,.06) !important;
    }
    .ae-chevron {
      font-size: 9px;
      color: rgba(255,255,255,.22);
      transition: transform .15s;
      flex-shrink: 0;
    }
    .ae-section.ae-open .ae-chevron { transform: rotate(90deg); }
    .ae-section-body { display: none; }
    .ae-section.ae-open .ae-section-body { display: block; }

    .ae-v {
      background: rgba(255,255,255,.025);
      border-top: 1px solid rgba(255,255,255,.05);
      padding: 8px 10px;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      color: rgba(255,255,255,.8);
    }

    /* Selector uniqueness pill */
    .ae-sel-unique { color: #4ade80; font-size: 9.5px; font-weight: 800; letter-spacing: .4px; }
    .ae-sel-multi  { color: #fb923c; font-size: 9.5px; font-weight: 800; letter-spacing: .4px; }

    /* ── Tree pane ── */
    .ae-tree-wrap {
      flex: 1;
      overflow: auto;
      padding: 10px 12px;
    }
    .ae-tree-wrap::-webkit-scrollbar { width: 4px; }
    .ae-tree-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 4px; }
    #ae-tree {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: normal;
      user-select: none;
    }
    #ae-tree details {
      margin-left: 10px;
      border-left: 1px dashed rgba(255,255,255,.08);
      padding-left: 8px;
    }
    #ae-tree summary {
      list-style: none;
      cursor: pointer;
      outline: none;
      padding: 2px 4px;
      border-radius: 6px;
    }
    #ae-tree summary::-webkit-details-marker { display: none; }
    #ae-tree summary:hover { background: rgba(255,255,255,.05); }
    #ae-tree .ae-node {
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 5px;
      display: inline;
    }
    #ae-tree .ae-node:hover { background: rgba(255,255,255,.05); }
    #ae-tree .ae-node.ae-sel {
      outline: 2px solid rgba(0,255,140,.45);
      background: rgba(0,255,140,.06);
      border-radius: 4px;
    }
    /* Syntax colors */
    .ae-t-tag   { color: #7dd3fc; }
    .ae-t-close { color: rgba(125,211,252,.45); }
    .ae-t-id    { color: #fb923c; }
    .ae-t-cls   { color: #86efac; }
    .ae-t-text  { color: rgba(255,255,255,.35); font-size: 11px; }
    #ae-tree .ae-muted { opacity: .45; }
    #ae-tree .ae-pill {
      display: inline-block;
      margin-left: 5px;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 99px;
      border: 1px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.38);
    }
    #ae-tree .ae-pill-target { border-color: rgba(0,255,140,.4); color: rgba(0,255,140,.75); }

    /* ── Log pane ── */
    .ae-log-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .ae-log-controls {
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .ae-log-chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .ae-chips-label {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: .5px;
      color: rgba(255,255,255,.25);
      margin-right: 2px;
      text-transform: uppercase;
    }
    .ae-chip {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .3px;
      padding: 3px 8px;
      border-radius: 99px;
      border: 1.5px solid rgba(255,255,255,.09);
      color: rgba(255,255,255,.28);
      cursor: pointer;
      user-select: none;
      transition: all .12s;
    }
    .ae-chip:hover { color: rgba(255,255,255,.65); border-color: rgba(255,255,255,.22); }
    .ae-chip.ae-chip-on { color: #fff; }
    .ae-chip-console.ae-chip-on { color: #94a3b8; border-color: #94a3b8; }
    .ae-chip-fetch.ae-chip-on   { color: #60a5fa; border-color: #60a5fa; }
    .ae-chip-xhr.ae-chip-on     { color: #818cf8; border-color: #818cf8; }
    .ae-chip-nav.ae-chip-on     { color: #c084fc; border-color: #c084fc; }
    .ae-chip-dom.ae-chip-on     { color: #2dd4bf; border-color: #2dd4bf; }
    .ae-chip-watch.ae-chip-on   { color: #4ade80; border-color: #4ade80; }
    .ae-chip-sync.ae-chip-on    { color: #86efac; border-color: #86efac; }
    .ae-chip-init.ae-chip-on    { color: #f59e0b; border-color: #f59e0b; }

    .ae-log-row { display: flex; gap: 6px; align-items: center; }
    .ae-log-search {
      flex: 1;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 7px;
      padding: 5px 9px;
      color: #fff;
      font: 12px/1 system-ui, sans-serif;
      outline: none;
    }
    .ae-log-search::placeholder { color: rgba(255,255,255,.25); }
    .ae-log-search:focus { border-color: rgba(255,255,255,.22); }
    .ae-log-btn {
      border: 1px solid rgba(255,255,255,.09);
      background: rgba(255,255,255,.04);
      color: rgba(255,255,255,.45);
      border-radius: 7px;
      padding: 5px 9px;
      cursor: pointer;
      font: 600 11px/1 system-ui, sans-serif;
      transition: all .12s;
      white-space: nowrap;
    }
    .ae-log-btn:hover { background: rgba(255,255,255,.08); color: rgba(255,255,255,.85); }
    .ae-log-btn.ae-btn-lit { color: #fbbf24; border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.05); }

    .ae-log-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px 10px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .ae-log-body::-webkit-scrollbar { width: 4px; }
    .ae-log-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 4px; }
    .ae-log-line {
      display: flex;
      gap: 7px;
      padding: 3px 0;
      align-items: baseline;
      border-bottom: 1px solid rgba(255,255,255,.025);
    }
    .ae-log-time { color: rgba(255,255,255,.2); font-size: 10px; flex-shrink: 0; }
    .ae-log-badge {
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: .4px;
      padding: 1px 5px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .ae-lb-console { background: rgba(148,163,184,.12); color: #94a3b8; }
    .ae-lb-fetch   { background: rgba(96,165,250,.12);  color: #60a5fa; }
    .ae-lb-xhr     { background: rgba(129,140,248,.12); color: #818cf8; }
    .ae-lb-nav     { background: rgba(192,132,252,.12); color: #c084fc; }
    .ae-lb-dom     { background: rgba(45,212,191,.12);  color: #2dd4bf; }
    .ae-lb-watch   { background: rgba(74,222,128,.12);  color: #4ade80; }
    .ae-lb-sync    { background: rgba(134,239,172,.12); color: #86efac; }
    .ae-lb-init    { background: rgba(245,158,11,.12);  color: #f59e0b; }
    .ae-log-msg { color: rgba(255,255,255,.65); word-break: break-all; flex: 1; }
    .ae-log-extra { color: rgba(255,255,255,.3); display: block; padding-left: 2px; }

    /* ── Highlight overlay + dimension badge ── */
    #ae-inspector-highlight {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      border-radius: 5px;
      outline: 2px solid rgba(0,255,140,.85);
      box-shadow: 0 0 0 3000px rgba(0,0,0,.1);
      display: none;
    }
    #ae-dim-badge {
      position: absolute;
      top: -22px;
      right: 0;
      background: rgba(0,0,0,.82);
      color: #00ff8c;
      font: 700 10px/1 ui-monospace, monospace;
      padding: 3px 7px;
      border-radius: 5px;
      white-space: nowrap;
      border: 1px solid rgba(0,255,140,.28);
      letter-spacing: .3px;
    }

    /* ── Toast ── */
    #ae-toast {
      position: fixed;
      top: 58px;
      right: 16px;
      z-index: 2147483647;
      padding: 8px 13px;
      border-radius: 9px;
      background: rgba(10,10,12,.92);
      color: rgba(255,255,255,.9);
      font: 12px/1.2 system-ui, sans-serif;
      border: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
      display: none;
    }

    /* ── Help tooltip (fixed, outside panel) ── */
    #ae-help-tip {
      position: fixed;
      z-index: 2147483647;
      background: rgba(16,16,20,.97);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      padding: 12px 14px;
      font: 12px/1.8 system-ui, sans-serif;
      color: rgba(255,255,255,.65);
      min-width: 230px;
      box-shadow: 0 10px 30px rgba(0,0,0,.6);
      display: none;
    }
    #ae-help-tip.ae-vis { display: block; }
    #ae-help-tip b { color: #fff; font-weight: 700; }

    /* ── Tree context menu ── */
    #ae-tree-ctx {
      position: fixed;
      z-index: 2147483647;
      background: rgba(16,16,20,.97);
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 8px;
      padding: 4px;
      box-shadow: 0 8px 24px rgba(0,0,0,.6);
      display: none;
      min-width: 160px;
    }
    #ae-tree-ctx.ae-vis { display: block; }
    .ae-ctx-item {
      padding: 7px 12px;
      font: 12px/1 system-ui, sans-serif;
      color: rgba(255,255,255,.7);
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
      transition: background .1s, color .1s;
    }
    .ae-ctx-item:hover { background: rgba(255,255,255,.08); color: #fff; }

    /* ── Resize grip ── */
    #ae-inspector-resize-grip {
      position: absolute;
      right: 6px; bottom: 6px;
      width: 12px; height: 12px;
      border-right: 2px solid rgba(255,255,255,.22);
      border-bottom: 2px solid rgba(255,255,255,.22);
      border-radius: 2px;
      cursor: nwse-resize;
      z-index: 2;
      opacity: .4;
      transition: opacity .12s;
    }
    #ae-inspector-resize-grip:hover,
    #ae-inspector-panel[data-resizing="true"] #ae-inspector-resize-grip { opacity: 1; }
  `;
  document.documentElement.appendChild(styleEl);

  // =========================
  // Toggle button
  // =========================
  const btn = document.createElement('div');
  btn.id = 'ae-inspector-btn';
  btn.dataset.on = 'false';
  btn.innerHTML = `<span id="ae-btn-dot"></span><span>AK Inspector</span>`;

  // =========================
  // Panel
  // =========================
  const panel = document.createElement('div');
  panel.id = 'ae-inspector-panel';
  panel.innerHTML = `
    <div class="ae-hdr">
      <div class="ae-hdr-left">
        <span class="ae-hdr-title">AniKai Inspector</span>
        <span id="ae-freeze-badge">LIVE</span>
      </div>
      <div class="ae-hdr-right">
        <button class="ae-hdr-btn" id="ae-help-btn" title="Keyboard shortcuts">?</button>
        <button class="ae-hdr-btn" id="ae-close-panel" title="Close">✕</button>
      </div>
    </div>

    <div class="ae-tabs">
      <div class="ae-tab ae-tab-active" data-tab="element">Element</div>
      <div class="ae-tab" data-tab="tree">Tree</div>
      <div class="ae-tab" data-tab="log">Log</div>
    </div>

    <!-- Element pane -->
    <div class="ae-pane ae-pane-active" id="ae-pane-element">
      <div class="ae-scroll">

        <div class="ae-section ae-open" data-sec="el">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Element</span>
            <button class="ae-section-copy" data-copy-id="ae-el" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-el"></div></div>
        </div>

        <div class="ae-section ae-open" data-sec="txt">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Text / Label</span>
            <button class="ae-section-copy" data-copy-id="ae-txt" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-txt"></div></div>
        </div>

        <div class="ae-section ae-open" data-sec="sel">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Best Selector</span>
            <span id="ae-sel-status"></span>
            <button class="ae-section-copy" data-copy-id="ae-sel" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-sel"></div></div>
        </div>

        <div class="ae-section" data-sec="url">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Href / Src</span>
            <button class="ae-section-copy" data-copy-id="ae-url" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-url"></div></div>
        </div>

        <div class="ae-section" data-sec="flags">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Match Flags</span>
            <button class="ae-section-copy" data-copy-id="ae-flags" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-flags"></div></div>
        </div>

        <div class="ae-section" data-sec="attrs">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Attributes</span>
            <button class="ae-section-copy" data-copy-id="ae-attrs" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-attrs"></div></div>
        </div>

        <div class="ae-section" data-sec="css">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Computed Styles</span>
            <button class="ae-section-copy" data-copy-id="ae-css" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-css"></div></div>
        </div>

        <div class="ae-section" data-sec="parents">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Parent Chain</span>
            <button class="ae-section-copy" data-copy-id="ae-parents" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-parents"></div></div>
        </div>

        <div class="ae-section" data-sec="sibs">
          <div class="ae-section-hdr">
            <span class="ae-section-title">Sibling Info</span>
            <button class="ae-section-copy" data-copy-id="ae-sibs" title="Copy">⎘</button>
            <span class="ae-chevron">▶</span>
          </div>
          <div class="ae-section-body"><div class="ae-v" id="ae-sibs"></div></div>
        </div>

      </div>
    </div>

    <!-- Tree pane -->
    <div class="ae-pane" id="ae-pane-tree">
      <div class="ae-tree-wrap">
        <div id="ae-tree"></div>
      </div>
    </div>

    <!-- Log pane -->
    <div class="ae-pane" id="ae-pane-log">
      <div class="ae-log-pane">
        <div class="ae-log-controls">
          <div class="ae-log-chips">
            <span class="ae-chips-label">Filter</span>
            <span class="ae-chip ae-chip-console ae-chip-on" data-log-type="console">console</span>
            <span class="ae-chip ae-chip-fetch ae-chip-on"   data-log-type="fetch">fetch</span>
            <span class="ae-chip ae-chip-xhr ae-chip-on"     data-log-type="xhr">xhr</span>
            <span class="ae-chip ae-chip-nav ae-chip-on"     data-log-type="nav">nav</span>
            <span class="ae-chip ae-chip-dom ae-chip-on"     data-log-type="dom">dom</span>
            <span class="ae-chip ae-chip-watch ae-chip-on"   data-log-type="watch">watch</span>
            <span class="ae-chip ae-chip-sync ae-chip-on"    data-log-type="sync">sync</span>
            <span class="ae-chip ae-chip-init ae-chip-on"    data-log-type="init">init</span>
          </div>
          <div class="ae-log-row">
            <input class="ae-log-search" id="ae-log-search" type="text" placeholder="Search log…" autocomplete="off" spellcheck="false">
            <button class="ae-log-btn" id="ae-pause-log">Pause</button>
            <button class="ae-log-btn" id="ae-scroll-lock" title="Lock / unlock auto-scroll">⏸ Scroll</button>
            <button class="ae-log-btn" id="ae-clear-log">Clear</button>
          </div>
        </div>
        <div class="ae-log-body" id="ae-log-body"></div>
      </div>
    </div>

    <div id="ae-inspector-resize-grip" title="Resize"></div>
  `;

  // =========================
  // Highlight + dimension badge
  // =========================
  const highlight = document.createElement('div');
  highlight.id = 'ae-inspector-highlight';
  const dimBadge = document.createElement('div');
  dimBadge.id = 'ae-dim-badge';
  highlight.appendChild(dimBadge);

  // =========================
  // Help tooltip (outside panel to avoid overflow:hidden clip)
  // =========================
  const helpTip = document.createElement('div');
  helpTip.id = 'ae-help-tip';
  helpTip.innerHTML = `
    <b>Ctrl+Shift+I</b> — toggle panel<br>
    <b>F</b> — toggle freeze<br>
    <b>Click element</b> — freeze + copy selector<br>
    <b>Click LIVE badge</b> — toggle freeze<br>
    <b>Click tree node</b> — select element<br>
    <b>⎘ buttons</b> — copy individual fields
  `;

  const toast = document.createElement('div');
  toast.id = 'ae-toast';

  const treeCtx = document.createElement('div');
  treeCtx.id = 'ae-tree-ctx';
  treeCtx.innerHTML = `
    <div class="ae-ctx-item" id="ae-ctx-copy-html">⎘ Copy outer HTML</div>
    <div class="ae-ctx-item" id="ae-ctx-copy-styled">⎘ Copy HTML + styles</div>
  `;

  document.documentElement.appendChild(btn);
  document.documentElement.appendChild(panel);
  document.documentElement.appendChild(highlight);
  document.documentElement.appendChild(helpTip);
  document.documentElement.appendChild(toast);
  document.documentElement.appendChild(treeCtx);

  // =========================
  // Panel state persistence
  // =========================
  const LS_KEY = 'aeInspectorPanelState:v1';
  const LS_SEC_KEY = 'aeInspectorSections:v1';

  function readPanelState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
  }
  function writePanelState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
  }
  function readSecState() {
    try { return JSON.parse(localStorage.getItem(LS_SEC_KEY) || 'null'); } catch { return null; }
  }
  function writeSecState(s) {
    try { localStorage.setItem(LS_SEC_KEY, JSON.stringify(s)); } catch {}
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function applyPanelState() {
    const s = readPanelState();
    if (!s) return;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = clamp(Number(s.x ?? 16), 0, Math.max(0, window.innerWidth - 120)) + 'px';
    panel.style.top  = clamp(Number(s.y ?? 60), 0, Math.max(0, window.innerHeight - 80)) + 'px';
    if (s.w) panel.style.width  = clamp(Number(s.w), 420, window.innerWidth - 20) + 'px';
    if (s.h) panel.style.height = clamp(Number(s.h), 260, window.innerHeight - 20) + 'px';
  }

  function applySecState() {
    const s = readSecState();
    if (!s) return;
    panel.querySelectorAll('.ae-section[data-sec]').forEach(sec => {
      const key = sec.dataset.sec;
      if (key in s) sec.classList.toggle('ae-open', s[key]);
    });
  }

  function saveSecState() {
    const state = {};
    panel.querySelectorAll('.ae-section[data-sec]').forEach(sec => {
      state[sec.dataset.sec] = sec.classList.contains('ae-open');
    });
    writeSecState(state);
  }

  applyPanelState();
  applySecState();

  window.addEventListener('resize', () => {
    const r = panel.getBoundingClientRect();
    if (!r.width) return;
    const x = clamp(r.left, 0, Math.max(0, window.innerWidth - 40));
    const y = clamp(r.top,  0, Math.max(0, window.innerHeight - 40));
    panel.style.left = x + 'px';
    panel.style.top  = y + 'px';
    writePanelState({ x, y, w: r.width, h: r.height });
  });

  // =========================
  // Drag
  // =========================
  let uiDragging = false;
  let dragStart = null;
  const hdr = panel.querySelector('.ae-hdr');

  hdr.addEventListener('mousedown', (e) => {
    if (e.target?.closest?.('button, #ae-freeze-badge')) return;
    e.preventDefault();
    e.stopPropagation();
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = r.left + 'px';
    panel.style.top  = r.top + 'px';
    uiDragging = true;
    panel.dataset.dragging = 'true';
    dragStart = { mx: e.clientX, my: e.clientY, x: r.left, y: r.top };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!uiDragging || !dragStart) return;
    e.preventDefault();
    const nx = clamp(dragStart.x + e.clientX - dragStart.mx, 0, Math.max(0, window.innerWidth  - 40));
    const ny = clamp(dragStart.y + e.clientY - dragStart.my, 0, Math.max(0, window.innerHeight - 40));
    panel.style.left = nx + 'px';
    panel.style.top  = ny + 'px';
  }, true);

  document.addEventListener('mouseup', () => {
    if (!uiDragging) return;
    uiDragging = false;
    panel.dataset.dragging = 'false';
    const r = panel.getBoundingClientRect();
    writePanelState({ x: r.left, y: r.top, w: r.width, h: r.height });
  }, true);

  // =========================
  // Resize
  // =========================
  let uiResizing = false;
  let resizeStart = null;
  const grip = panel.querySelector('#ae-inspector-resize-grip');

  grip?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = r.left + 'px';
    panel.style.top  = r.top + 'px';
    uiResizing = true;
    panel.dataset.resizing = 'true';
    resizeStart = { mx: e.clientX, my: e.clientY, w: r.width, h: r.height };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!uiResizing || !resizeStart) return;
    e.preventDefault();
    panel.style.width  = clamp(resizeStart.w + e.clientX - resizeStart.mx, 420, window.innerWidth  - 20) + 'px';
    panel.style.height = clamp(resizeStart.h + e.clientY - resizeStart.my, 260, window.innerHeight - 20) + 'px';
  }, true);

  document.addEventListener('mouseup', () => {
    if (!uiResizing) return;
    uiResizing = false;
    panel.dataset.resizing = 'false';
    const r = panel.getBoundingClientRect();
    writePanelState({ x: r.left, y: r.top, w: r.width, h: r.height });
  }, true);

  function isPanelMovingOrResizing() { return uiDragging || uiResizing; }

  // =========================
  // Toast
  // =========================
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.style.display = 'none'), 1400);
  }

  // =========================
  // Log infrastructure
  // =========================
  // Each entry: { type, time, msg, extra }
  const logs = [];
  let logPaused = false;
  let logScrollLocked = false;
  let logFilters = new Set(['console','fetch','xhr','nav','dom','watch','sync','init']);
  let logSearch = '';

  const logBody = panel.querySelector('#ae-log-body');

  function fmtTime(d) {
    return d.toTimeString().slice(0, 8); // HH:MM:SS
  }

  function renderLogs() {
    if (!logBody) return;
    const search = logSearch.toLowerCase();
    const filtered = logs.filter(l => {
      if (!logFilters.has(l.type)) return false;
      if (search && !l.msg.toLowerCase().includes(search) && !(l.extra || '').toLowerCase().includes(search)) return false;
      return true;
    });

    logBody.innerHTML = filtered.map(l => {
      const extra = l.extra
        ? `<span class="ae-log-extra">${escapeHtml(l.extra)}</span>`
        : '';
      return `<div class="ae-log-line">
        <span class="ae-log-time">${escapeHtml(l.time)}</span>
        <span class="ae-log-badge ae-lb-${escapeHtml(l.type)}">${escapeHtml(l.type)}</span>
        <span class="ae-log-msg">${escapeHtml(l.msg)}${extra}</span>
      </div>`;
    }).join('');

    if (!logScrollLocked) logBody.scrollTop = logBody.scrollHeight;
  }

  function addLog(type, msg, extra = '') {
    if (logPaused) return;
    logs.push({ type, time: fmtTime(new Date()), msg: String(msg), extra: extra ? String(extra) : '' });
    while (logs.length > LOG_MAX) logs.shift();
    renderLogs();
  }

  // Auto-scroll lock: detect when user scrolls up
  logBody?.addEventListener('scroll', () => {
    const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 50;
    if (!atBottom && !logScrollLocked) {
      logScrollLocked = true;
      panel.querySelector('#ae-scroll-lock')?.classList.add('ae-btn-lit');
    } else if (atBottom && logScrollLocked) {
      logScrollLocked = false;
      panel.querySelector('#ae-scroll-lock')?.classList.remove('ae-btn-lit');
    }
  });

  // Log filter chips
  panel.querySelectorAll('.ae-chip[data-log-type]').forEach(chip => {
    chip.addEventListener('click', () => {
      const type = chip.dataset.logType;
      if (logFilters.has(type)) {
        logFilters.delete(type);
        chip.classList.remove('ae-chip-on');
      } else {
        logFilters.add(type);
        chip.classList.add('ae-chip-on');
      }
      renderLogs();
    });
  });

  // Search
  panel.querySelector('#ae-log-search')?.addEventListener('input', e => {
    logSearch = e.target.value;
    renderLogs();
  });

  // Pause
  panel.querySelector('#ae-pause-log')?.addEventListener('click', () => {
    logPaused = !logPaused;
    const b = panel.querySelector('#ae-pause-log');
    b.textContent = logPaused ? 'Resume' : 'Pause';
    b.classList.toggle('ae-btn-lit', logPaused);
    showToast(logPaused ? 'Log paused' : 'Log resumed');
  });

  // Scroll lock toggle
  panel.querySelector('#ae-scroll-lock')?.addEventListener('click', () => {
    logScrollLocked = !logScrollLocked;
    panel.querySelector('#ae-scroll-lock')?.classList.toggle('ae-btn-lit', logScrollLocked);
    if (!logScrollLocked) logBody.scrollTop = logBody.scrollHeight;
  });

  // Clear
  panel.querySelector('#ae-clear-log')?.addEventListener('click', () => {
    logs.length = 0;
    renderLogs();
    showToast('Log cleared');
  });

  // =========================
  // Console mirror
  // =========================
  (function hookConsole() {
    const orig = {
      log:   console.log,
      info:  console.info,
      warn:  console.warn,
      error: console.error,
      debug: console.debug,
    };

    const PREFIX = { warn: '⚠ ', error: '✖ ', info: 'ℹ ' };

    function joinArgs(args) {
      return args.map(a => safeStringify(a, 800)).join(' ');
    }

    let inHook = false;

    function wrap(fnName) {
      return function (...args) {
        try {
          if (!inHook) {
            inHook = true;
            const msg = (PREFIX[fnName] || '') + joinArgs(args);
            addLog('console', msg);
            inHook = false;
          }
        } catch {
          inHook = false;
        }
        try { return orig[fnName].apply(console, args); } catch {}
      };
    }

    console.log   = wrap('log');
    console.info  = wrap('info');
    console.warn  = wrap('warn');
    console.error = wrap('error');
    console.debug = wrap('debug');
  })();

  // =========================
  // Network spy (fetch + XHR)
  // =========================
  (function hookNetwork() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      try {
        const input = args[0];
        const init  = args[1] || {};
        const url    = typeof input === 'string' ? input : input?.url;
        const method = (init.method || 'GET').toUpperCase();
        addLog('fetch', `${method} ${url}`);
        const res = await origFetch.apply(this, args);
        addLog('fetch', `${method} ${url} → ${res.status}`);
        return res;
      } catch (e) {
        addLog('fetch', `ERROR ${String(e)}`);
        throw e;
      }
    };

    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OrigXHR();
      let _method = '', _url = '';

      const origOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        _method = (method || 'GET').toUpperCase();
        _url = url;
        return origOpen.call(this, method, url, ...rest);
      };

      const origSend = xhr.send;
      xhr.send = function (body) {
        addLog('xhr', `${_method} ${_url}`, body ? clampText(body, 320) : '');
        xhr.addEventListener('loadend', () => {
          addLog('xhr', `${_method} ${_url} → ${xhr.status}`);
        });
        return origSend.call(this, body);
      };

      return xhr;
    }
    window.XMLHttpRequest = PatchedXHR;
  })();

  // =========================
  // Navigation spy (SPA)
  // =========================
  (function hookNavigation() {
    const _push = history.pushState;
    history.pushState = function (...args) {
      const ret = _push.apply(this, args);
      addLog('nav', `pushState → ${location.href}`);
      return ret;
    };

    const _replace = history.replaceState;
    history.replaceState = function (...args) {
      const ret = _replace.apply(this, args);
      addLog('nav', `replaceState → ${location.href}`);
      return ret;
    };

    window.addEventListener('popstate', () => addLog('nav', `popstate → ${location.href}`));
  })();

  // =========================
  // syncData reader (anikai.to watch pages)
  // =========================
  function readSyncData() {
    const el = document.getElementById('syncData');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  function logSyncData() {
    const data = readSyncData();
    if (!data) return;
    addLog('sync', `page=${data.page} | ep=${data.episode}`);
    addLog('sync', `name="${data.name}"`);
    addLog('sync', `anime_id=${data.anime_id} | mal_id=${data.mal_id} | al_id=${data.al_id}`);
    addLog('sync', `series_url=${data.series_url}`);
  }

  // =========================
  // Episode DOM watcher (anikai.to: section.episode-section)
  // =========================
  function attachEpisodeWatcher() {
    const section = document.querySelector('section.episode-section');
    if (!section) {
      addLog('watch', 'section.episode-section not found yet');
      return false;
    }

    const EP_SELECTOR = 'a.ep-item, a.ssl-item, [data-number][href]';
    const items = section.querySelectorAll(EP_SELECTOR);

    if (items.length === 0 && section.children.length === 0) {
      addLog('watch', 'section.episode-section found but empty — waiting for AJAX');
      const mo = new MutationObserver(() => {
        const loaded = section.querySelectorAll(EP_SELECTOR);
        if (loaded.length > 0) {
          mo.disconnect();
          logEpisodes(section, EP_SELECTOR);
          observeEpisodeChanges(section, EP_SELECTOR);
        }
      });
      mo.observe(section, { childList: true, subtree: true });
      return true;
    }

    logEpisodes(section, EP_SELECTOR);
    observeEpisodeChanges(section, EP_SELECTOR);
    return true;
  }

  function logEpisodes(section, selector) {
    const items = section.querySelectorAll(selector);
    addLog('watch', `Episode watcher attached on section.episode-section`);
    addLog('watch', `Found ${items.length} episode links`);
    const active = section.querySelector(`${selector.split(',')[0]}.active, ${selector.split(',')[0]}[aria-current]`);
    if (active) {
      const ep = active.getAttribute('data-number') || active.textContent.trim();
      const id = active.getAttribute('data-id') || active.getAttribute('href');
      addLog('watch', `Active: ep=${ep} id=${id}`);
    }
    logSyncData();
  }

  function observeEpisodeChanges(section, selector) {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          const el = m.target;
          if (el?.matches?.(selector)) {
            const ep = el.getAttribute('data-number') || el.textContent.trim();
            const id = el.getAttribute('data-id') || el.getAttribute('href');
            addLog('dom', `ep attr changed: ep=${ep} id=${id} attr=${m.attributeName}`, `class="${el.className}"`);
          }
        } else if (m.type === 'childList') {
          addLog('dom', `episode-section childList changed (added:${m.addedNodes.length}, removed:${m.removedNodes.length})`);
        }
      }
    });
    mo.observe(section, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class','aria-current','aria-selected','style'],
      childList: true,
    });
  }

  let tries = 0;
  const epInterval = setInterval(() => {
    tries++;
    if (attachEpisodeWatcher() || tries > 20) clearInterval(epInterval);
  }, 750);

  if (location.pathname.includes('/watch/')) {
    setTimeout(logSyncData, 300);
  }

  // =========================
  // Tab system
  // =========================
  panel.querySelectorAll('.ae-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      panel.querySelectorAll('.ae-tab').forEach(t => t.classList.toggle('ae-tab-active', t === tab));
      panel.querySelectorAll('.ae-pane').forEach(p => p.classList.toggle('ae-pane-active', p.id === `ae-pane-${target}`));
    });
  });

  // =========================
  // Collapsible sections
  // =========================
  panel.querySelectorAll('.ae-section').forEach(sec => {
    sec.querySelector('.ae-section-hdr')?.addEventListener('click', e => {
      if (e.target?.closest?.('.ae-section-copy')) return;
      sec.classList.toggle('ae-open');
      saveSecState();
    });
  });

  // Per-section copy buttons
  panel.querySelectorAll('.ae-section-copy').forEach(copyBtn => {
    copyBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = copyBtn.dataset.copyId;
      const text = id ? (panel.querySelector('#' + id)?.textContent ?? '') : '';
      const ok = await copyToClipboard(text);
      showToast(ok ? '⎘ Copied' : '❌ Copy failed');
    });
  });

  // =========================
  // Help tooltip
  // =========================
  panel.querySelector('#ae-help-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    helpTip.style.top   = (r.bottom + 6) + 'px';
    helpTip.style.right = (window.innerWidth - r.right) + 'px';
    helpTip.classList.toggle('ae-vis');
  });

  document.addEventListener('click', e => {
    if (!e.target?.closest?.('#ae-help-btn') && !e.target?.closest?.('#ae-help-tip')) {
      helpTip.classList.remove('ae-vis');
    }
  }, true);

  // =========================
  // Inspector logic
  // =========================
  let enabled = false;
  let frozen  = false;
  let lastSelector = '';

  const treeIdToEl = new Map();
  let treeIdSeq = 1;

  function treeResetRegistry() { treeIdToEl.clear(); treeIdSeq = 1; }
  function treeReg(el) {
    const id = String(treeIdSeq++);
    treeIdToEl.set(id, el);
    return id;
  }

  function nodeLabel(el) {
    if (!el || el.nodeType !== 1) return '(none)';
    const tag = el.tagName.toLowerCase();
    const id  = el.id ? `<span class="ae-t-id">#${escapeHtml(el.id)}</span>` : '';
    let cls = '';
    if (el.classList?.length) {
      const arr = [...el.classList].slice(0, 4);
      cls = arr.map(c => `<span class="ae-t-cls">.${escapeHtml(c)}</span>`).join('');
      if (el.classList.length > 4) cls += '<span class="ae-muted">…</span>';
    }
    const t   = getReadableText(el);
    const txt = t ? ` <span class="ae-t-text">"${escapeHtml(clampText(t, 40))}"</span>` : '';
    return `<span class="ae-t-tag">&lt;${escapeHtml(tag)}&gt;</span>${id}${cls}${txt}`;
  }

  function ctag(el) {
    return `<span class="ae-t-close">&lt;/${escapeHtml(el.tagName.toLowerCase())}&gt;</span>`;
  }

  function buildChildrenDetails(el, depthLeft, selectedEl) {
    if (!el || depthLeft <= 0) return '';
    const children = el.children ? [...el.children] : [];
    if (!children.length) return '';

    const shown       = children.slice(0, TREE_MAX_CHILDREN);
    const hiddenCount = Math.max(0, children.length - shown.length);
    let out = '';

    for (const ch of shown) {
      const cid     = treeReg(ch);
      const isSel   = ch === selectedEl;
      const hasKids = ch.children?.length > 0;

      if (hasKids && depthLeft > 1) {
        // Expanded: show children, then closing tag inside <details>
        out += `<details>
          <summary>
            <span class="ae-node${isSel ? ' ae-sel' : ''}" data-ae-node="${cid}">${nodeLabel(ch)}</span>
            <span class="ae-pill">${ch.children.length}</span>
          </summary>
          ${buildChildrenDetails(ch, depthLeft - 1, selectedEl)}
          <div style="padding:1px 4px">${ctag(ch)}</div>
        </details>`;
      } else if (hasKids) {
        // Depth limit hit — show ellipsis to signal hidden children, then closing tag
        out += `<div style="margin-left:10px;padding-left:8px;border-left:1px dashed rgba(255,255,255,.08)">
          <span class="ae-node${isSel ? ' ae-sel' : ''}" data-ae-node="${cid}">${nodeLabel(ch)}</span>
          <span class="ae-muted"> … </span>${ctag(ch)}
        </div>`;
      } else {
        // Leaf: closing tag inline
        out += `<div style="margin-left:10px;padding-left:8px;border-left:1px dashed rgba(255,255,255,.08)">
          <span class="ae-node${isSel ? ' ae-sel' : ''}" data-ae-node="${cid}">${nodeLabel(ch)}</span>${ctag(ch)}
        </div>`;
      }
    }

    if (hiddenCount > 0) {
      out += `<div class="ae-muted" style="margin-left:10px;padding:2px 4px">… +${hiddenCount} more</div>`;
    }
    return out;
  }

  function renderDomTree(targetEl) {
    const treeBox = panel.querySelector('#ae-tree');
    if (!treeBox) return;
    if (!targetEl || targetEl.nodeType !== 1) {
      treeBox.innerHTML = '<span class="ae-muted">(none)</span>';
      return;
    }

    treeResetRegistry();

    // Build ancestor chain
    const chain = [];
    let cur = targetEl;
    while (cur && cur.nodeType === 1) {
      chain.push(cur);
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    chain.reverse();

    // Trim ancestors
    let trimmed = chain;
    if (chain.length > TREE_MAX_ANCESTORS) {
      trimmed = chain.slice(chain.length - TREE_MAX_ANCESTORS);
      const htmlEl = document.documentElement;
      if (trimmed[0] !== htmlEl && chain.includes(htmlEl)) {
        trimmed = [htmlEl, ...trimmed.filter(x => x !== htmlEl)];
      }
    }

    let html = '';
    for (let i = 0; i < trimmed.length; i++) {
      const el     = trimmed[i];
      const id     = treeReg(el);
      const isSel  = el === targetEl;
      const kCount = el.children?.length ?? 0;
      const kPill  = kCount ? `<span class="ae-pill">${kCount}</span>` : '';

      if (i === trimmed.length - 1) {
        html += `<details open>
          <summary>
            <span class="ae-node${isSel ? ' ae-sel' : ''}" data-ae-node="${id}">${nodeLabel(el)}</span>
            <span class="ae-pill ae-pill-target">TARGET</span>${kPill}
          </summary>
          ${buildChildrenDetails(el, TREE_CHILD_DEPTH, targetEl)}
          <div style="padding:1px 4px">${ctag(el)}</div>
        </details>`;
      } else {
        html += `<details open><summary>
          <span class="ae-node" data-ae-node="${id}">${nodeLabel(el)}</span>${kPill}
        </summary>`;
      }
    }
    // Close ancestor <details> from innermost to outermost, each with its closing tag
    for (let i = trimmed.length - 2; i >= 0; i--) {
      html += `<div style="padding:1px 4px">${ctag(trimmed[i])}</div></details>`;
    }
    treeBox.innerHTML = html;
  }

  // Tree node click → select element
  panel.querySelector('#ae-tree')?.addEventListener('click', e => {
    const node = e.target?.closest?.('[data-ae-node]');
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    const el = treeIdToEl.get(node.getAttribute('data-ae-node'));
    if (!el) return;
    setFrozen(true);
    updateHighlight(pickInteresting(el));
    updatePanel(el);
    showToast('Selected from tree');
  }, true);

  // Tree node right-click → context menu
  let treeCtxTargetEl = null;

  function hideTreeCtx() {
    treeCtx.classList.remove('ae-vis');
    treeCtxTargetEl = null;
  }

  panel.querySelector('#ae-tree')?.addEventListener('contextmenu', e => {
    const node = e.target?.closest?.('[data-ae-node]');
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    treeCtxTargetEl = treeIdToEl.get(node.getAttribute('data-ae-node'));
    if (!treeCtxTargetEl) return;
    treeCtx.style.left = e.clientX + 'px';
    treeCtx.style.top  = e.clientY + 'px';
    treeCtx.classList.add('ae-vis');
    // Clamp to viewport
    requestAnimationFrame(() => {
      const r = treeCtx.getBoundingClientRect();
      if (r.right  > window.innerWidth)  treeCtx.style.left = (e.clientX - r.width  + 4) + 'px';
      if (r.bottom > window.innerHeight) treeCtx.style.top  = (e.clientY - r.height + 4) + 'px';
    });
  }, true);

  treeCtx.querySelector('#ae-ctx-copy-html')?.addEventListener('click', async e => {
    e.stopPropagation();
    const target = treeCtxTargetEl;
    hideTreeCtx();
    if (!target) return;
    const html = target.outerHTML;
    const ok = await copyToClipboard(html);
    showToast(ok ? '⎘ Outer HTML copied' : '❌ Copy failed');
  }, true);

  function cloneWithStyles(el) {
    const clone = el.cloneNode(true);

    // Pair every original element with its clone counterpart
    const origEls  = [el,  ...[...el.querySelectorAll('*')]];
    const cloneEls = [clone, ...[...clone.querySelectorAll('*')]];

    for (let i = 0; i < origEls.length; i++) {
      const orig = origEls[i];
      const copy = cloneEls[i];
      if (orig.nodeType !== 1) continue;

      const cs = getComputedStyle(orig);
      let styleStr = '';
      for (let j = 0; j < cs.length; j++) {
        const prop = cs[j];
        const val  = cs.getPropertyValue(prop);
        if (val) styleStr += `${prop}:${val};`;
      }
      copy.setAttribute('style', styleStr);
    }

    return clone.outerHTML;
  }

  treeCtx.querySelector('#ae-ctx-copy-styled')?.addEventListener('click', async e => {
    e.stopPropagation();
    const target = treeCtxTargetEl;
    hideTreeCtx();
    if (!target) return;
    showToast('⏳ Computing styles…');
    let html;
    try { html = cloneWithStyles(target); }
    catch (err) {
      showToast('❌ Failed: ' + err.message);
      return;
    }
    const ok = await copyToClipboard(html);
    showToast(ok ? '⎘ HTML + styles copied' : '❌ Copy failed');
  }, true);

  document.addEventListener('click', e => { if (!e.target?.closest?.('#ae-tree-ctx')) hideTreeCtx(); }, true);
  document.addEventListener('keydown',    e => { if (e.key === 'Escape') hideTreeCtx(); }, true);
  document.addEventListener('scroll',     () => hideTreeCtx(), true);

  function setEnabled(on) {
    enabled = on;
    btn.dataset.on = String(on);
    panel.style.display = on ? 'flex' : 'none';
    if (on) applyPanelState();
    if (!on) {
      highlight.style.display = 'none';
      lastSelector = '';
      lastPickedEl = null;
      const treeBox = panel.querySelector('#ae-tree');
      if (treeBox) treeBox.innerHTML = '';
      ['ae-el','ae-txt','ae-sel','ae-url','ae-flags','ae-attrs','ae-css','ae-parents','ae-sibs'].forEach(id => {
        const el = panel.querySelector('#' + id);
        if (el) el.textContent = '';
      });
      const ss = panel.querySelector('#ae-sel-status');
      if (ss) { ss.textContent = ''; ss.className = ''; }
    }
  }

  function setFrozen(on) {
    frozen = on;
    panel.dataset.frozen = String(on);
    const badge = panel.querySelector('#ae-freeze-badge');
    if (badge) badge.textContent = on ? 'FROZEN' : 'LIVE';
  }

  function updateHighlight(el) {
    if (!el || el === document.documentElement || el === document.body) {
      highlight.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left   = Math.max(0, r.left) + 'px';
    highlight.style.top    = Math.max(0, r.top)  + 'px';
    highlight.style.width  = Math.max(0, r.width)  + 'px';
    highlight.style.height = Math.max(0, r.height) + 'px';
    dimBadge.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    dimBadge.style.top = r.top < 28 ? 'calc(100% + 4px)' : '-22px';
  }

  function updatePanel(elRaw) {
    const el = pickInteresting(elRaw);
    const selector = buildBestSelector(el);
    lastSelector = selector;

    renderDomTree(el);

    const setV = (id, val) => {
      const node = panel.querySelector('#' + id);
      if (node) node.textContent = val || '(none)';
    };

    setV('ae-el',      describeElement(el));
    setV('ae-txt',     getReadableText(el));
    setV('ae-url',     getHrefOrSrc(el));
    setV('ae-sel',     selector);
    setV('ae-flags',   getMatchFlags(el));
    setV('ae-attrs',   getAttributesDump(el));
    setV('ae-css',     getComputedDump(el));
    setV('ae-parents', getParentChain(el, 6));
    setV('ae-sibs',    getSiblingInfo(el));

    // Selector uniqueness indicator
    const ss = panel.querySelector('#ae-sel-status');
    if (ss && selector) {
      const unique = isUniqueSelector(selector);
      ss.textContent = unique ? '● UNIQUE' : '● MULTI';
      ss.className   = unique ? 'ae-sel-unique' : 'ae-sel-multi';
    }
  }

  function isInspectorUI(el) {
    return !!(el && (
      el.id?.startsWith('ae-') ||
      el.closest?.('#ae-inspector-panel') ||
      el.closest?.('#ae-inspector-btn') ||
      el.closest?.('#ae-help-tip')
    ));
  }

  // =========================
  // Events
  // =========================

  // Hover update
  document.addEventListener('mousemove', e => {
    if (!enabled || frozen || isPanelMovingOrResizing()) return;
    const el = e.target;
    if (!el || isInspectorUI(el)) return;
    updateHighlight(pickInteresting(el));
    updatePanel(el);
  }, true);

  // Keyboard
  document.addEventListener('keydown', e => {
    // F = toggle freeze (not when typing in inputs)
    if ((e.key === 'f' || e.key === 'F') && enabled && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const active = document.activeElement;
      const typing = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable
      );
      if (!typing) {
        e.preventDefault();
        setFrozen(!frozen);
        return;
      }
    }

    // Ctrl+Shift+I = toggle panel
    const keyMatch = e.key.toLowerCase() === HOTKEY_TOGGLE.key.toLowerCase();
    if (keyMatch && (!!HOTKEY_TOGGLE.ctrl === e.ctrlKey) && (!!HOTKEY_TOGGLE.shift === e.shiftKey)) {
      e.preventDefault();
      setEnabled(!enabled);
    }
  }, true);

  // Click = freeze + copy selector
  document.addEventListener('click', async e => {
    if (!enabled) return;
    const el = e.target;
    if (!el || isInspectorUI(el)) return;
    e.preventDefault();
    e.stopPropagation();
    setFrozen(true);
    updateHighlight(pickInteresting(el));
    updatePanel(el);
    const ok = await copyToClipboard(lastSelector || '');
    showToast(ok ? '⎘ Selector copied' : '❌ Copy failed');
  }, true);

  // Freeze badge click
  panel.querySelector('#ae-freeze-badge')?.addEventListener('click', e => {
    e.stopPropagation();
    setFrozen(!frozen);
  });

  // Button + close
  btn.addEventListener('click', () => setEnabled(!enabled));
  panel.querySelector('#ae-close-panel')?.addEventListener('click', () => setEnabled(false));

  // =========================
  // Init
  // =========================
  setEnabled(false);
  setFrozen(false);
  addLog('init', 'Inspector ready');

})();
