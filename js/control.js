/* Shared site settings. Every few seconds the page reads the newest signed settings notice from the
   enquiry service and applies it: site notice, open positions, the shared date, forced reloads.
   Notices are signed, so only the holder of the signing key can change anything. A failed request
   never shows anything to the visitor; the page then keeps the last settings it had. */
(function () {
  'use strict';

  var c = window.SITE_LOG;
  if (!c || !c.projectId || !c.apiKey || !c.controlKey || !window.crypto || !crypto.subtle) return;

  var CACHE = 'sitectl_v1';
  var POLL_VISIBLE = 5000;
  var POLL_HIDDEN = 60000;
  var enc = new TextEncoder();
  var state = {};
  var lastName = '';
  var deep = false;
  var loadSeq = null;
  var loadReload = 0;
  var verifyKey = null;
  var listeners = [];
  var timer = null;
  var docs = 'projects/' + c.projectId + '/databases/(default)/documents/submissions/';
  var endpoint = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(c.projectId) +
    '/databases/(default)/documents:runQuery?key=' + encodeURIComponent(c.apiKey);

  function nodes(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function lang() { return (document.documentElement.lang || 'en').slice(0, 2); }
  function b64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- reading and checking the notices -------------------------------------------------------

  function query(limit) {
    var ctl = function (op, end) { return { fieldFilter: { field: { fieldPath: '__name__' }, op: op, value: { referenceValue: docs + end } } }; };
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var stop = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'submissions' }],
        where: { compositeFilter: { op: 'AND', filters: [ctl('GREATER_THAN_OR_EQUAL', 'ctl-'), ctl('LESS_THAN', 'ctl.')] } },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: limit,
      } }),
    }).then(function (r) {
      if (stop) clearTimeout(stop);
      if (!r.ok) throw new Error('settings ' + r.status);
      return r.json();
    });
  }

  async function verify(doc) {
    var f = doc.fields || {};
    var payload = f.c && f.c.stringValue, sig = f.k && f.k.stringValue;
    if (!payload || !sig) return null;
    try {
      if (!verifyKey) verifyKey = await crypto.subtle.importKey('jwk', c.controlKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      var ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b64(sig), enc.encode(payload));
      if (!ok) return null;
      var o = JSON.parse(payload);
      return o && typeof o.seq === 'number' ? o : null;
    } catch (e) { return null; }
  }

  async function pull(force) {
    var rows = await query(deep ? 10 : 1);
    var top = rows[0] && rows[0].document;
    if (!top) { if (loadSeq === null) loadSeq = 0; return; }
    var name = top.name.split('/').pop();
    if (name === lastName && !force && !deep) return;
    var best = deep ? null : await verify(top);
    if (!best) {
      // Something that is not a valid notice sits on top: look a little deeper and keep doing so.
      if (!deep) rows = await query(10);
      deep = true;
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].document) continue;
        var v = await verify(rows[i].document);
        if (v && (!best || v.seq > best.seq)) best = v;
      }
    }
    lastName = name;
    if (best && (best.seq !== state.seq || loadSeq === null)) accept(best);
  }

  function accept(s) {
    var first = loadSeq === null;
    state = s;
    if (first) { loadSeq = s.seq; loadReload = s.reload || 0; }
    try { window.sessionStorage.setItem(CACHE, JSON.stringify(s)); } catch (e) { /* ignore */ }
    apply();
    if (!first && (s.reload || 0) > loadReload) { window.location.reload(); return; }
    listeners.slice().forEach(function (fn) { try { fn(state, first); } catch (e) { /* ignore */ } });
  }

  // ---- applying them --------------------------------------------------------------------------

  function hide(el, why, on) {
    var w = el._why || (el._why = {});
    if (on) w[why] = 1; else delete w[why];
    var off = Object.keys(w).length > 0;
    el.hidden = off;
    if (el.tagName === 'OPTION') el.disabled = off;
  }

  // On a developer's own machine the date can also be tried out with ?today=YYYY-MM-DD in the address.
  var LOCAL_PREVIEW = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  function todayISO() {
    if (LOCAL_PREVIEW) {
      var q = (/[?&]today=(\d{4}-\d{2}-\d{2})/.exec(location.search) || [])[1];
      if (q) return q;
    }
    return state.today || c.baseDate || '2028-10-19';
  }
  function today() { return new Date(todayISO() + 'T23:59:59Z'); }

  function words(n, l) {
    var no = ['ingen', 'én', 'to', 'tre', 'fire', 'fem', 'seks', 'sju', 'åtte', 'ni', 'ti'];
    var en = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    return (l === 'nb' || l === 'no' ? no : en)[n] || String(n);
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // Spelled-out vacancy texts (Norwegian and English), so they always match the number of open positions.
  function phrase(kind, l, n) {
    var no = l === 'nb' || l === 'no';
    if (kind === 'top') return no ? (n === 0 ? 'Ingen ledige stillinger' : n + (n === 1 ? ' ledig stilling' : ' ledige stillinger')) : (n === 0 ? 'No open positions' : n + (n === 1 ? ' open position' : ' open positions'));
    if (kind === 'headline') return no ? (n === 0 ? 'Ingen ledige stillinger' : cap(n === 1 ? 'én ledig stilling' : words(n, l) + ' ledige stillinger') + ' til vintersesongen') : (n === 0 ? 'No open positions' : cap(words(n, l)) + (n === 1 ? ' open position' : ' open positions') + ' for the winter season');
    if (kind === 'count') return no ? (n === 0 ? 'Ingen ledige stillinger' : n + (n === 1 ? ' stilling' : ' stillinger') + ' til vintersesongen') : (n === 0 ? 'No open positions' : n + (n === 1 ? ' position' : ' positions') + ' for the winter season');
    if (kind === 'now') return no ? (n === 0 ? 'Akkurat nå er ingen stillinger ledige på Ødemark A.' : n === 1 ? 'Akkurat nå er én stilling ledig på Ødemark A.' : 'Akkurat nå er ' + words(n, l) + ' stillinger ledige på Ødemark A.') : (n === 0 ? 'Right now no positions are open on Ødemark A.' : n === 1 ? 'Right now one position is open on Ødemark A.' : 'Right now ' + words(n, l) + ' positions are open on Ødemark A.');
    if (kind === 'lead') {
      if (no) return n === 0 ? 'Bemanningen for vinteren 2028/29 er komplett. Det er ingen ledige stillinger på Ødemark A akkurat nå.'
        : 'Bemanningen for vinteren 2028/29 er nesten komplett. ' + (n === 1 ? 'Dette er den siste ledige stillingen' : 'Disse ' + words(n, l) + ' er de siste ledige stillingene') + ' på Ødemark A. Vi leser søknadene etter hvert som de kommer og kaller inn til intervju med en gang.';
      return n === 0 ? 'The crew for winter 2028/29 is complete. There are no open positions on Ødemark A right now.'
        : 'The crew for winter 2028/29 is almost complete. ' + (n === 1 ? 'This is the last open position' : 'These ' + words(n, l) + ' are the last open positions') + ' on Ødemark A. We read applications as they come in and call people in for interviews straight away.';
    }
    return '';
  }

  // A listing has a number of positions. The shared state can close it ("closed") or say how many are left (a number).
  function slotsLeft(ref, positions) {
    var v = (state.jobs || {})[ref];
    if (v === 'closed') return 0;
    if (typeof v === 'number') return Math.max(0, Math.min(positions, v));
    return positions;
  }
  function openCount(list) {
    var n = 0;
    (list || '').split(',').forEach(function (p) {
      var bits = p.split(':');
      if (!bits[0]) return;
      if (bits[1] && bits[1] > todayISO()) return;
      n += slotsLeft(bits[0], Math.max(1, parseInt(bits[2], 10) || 1));
    });
    return n;
  }

  function applyDates() {
    var day = todayISO(), l = lang();
    // data-date="YYYY-MM-DD": shown from that day on. data-until="YYYY-MM-DD": shown up to and including that day.
    nodes('[data-date]').forEach(function (el) { hide(el, 'date', el.getAttribute('data-date') > day); });
    nodes('[data-until]').forEach(function (el) { hide(el, 'until', day > el.getAttribute('data-until')); });
    nodes('[data-limit]').forEach(function (box) {
      var max = +box.getAttribute('data-limit'), seen = 0;
      Array.prototype.forEach.call(box.children, function (el) {
        if (!el.hasAttribute('data-date') && !el.hasAttribute('data-until')) return;
        if (el._why && (el._why.date || el._why.until)) { hide(el, 'limit', false); return; }
        hide(el, 'limit', seen >= max);
        seen++;
      });
    });
    // A message that appears only when everything in a list is hidden.
    nodes('[data-empty-for]').forEach(function (msg) {
      var box = document.getElementById(msg.getAttribute('data-empty-for'));
      if (!box) return;
      var shown = Array.prototype.some.call(box.querySelectorAll('[data-date],[data-until]'), function (el) { return !el.hidden; });
      hide(msg, 'empty', shown);
    });
    nodes('[data-today]').forEach(function (el) {
      var kind = el.getAttribute('data-today');
      var d = new Date(day + 'T12:00:00Z');
      el.textContent = kind === 'year' ? String(d.getUTCFullYear())
        : d.toLocaleDateString(l === 'nb' || l === 'no' ? 'nb-NO' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    });
    nodes('[data-gate]').forEach(function (el) {
      var gated = el.getAttribute('data-gate') > day;
      if (gated && el._kept === undefined) {
        el._kept = el.innerHTML;
        el.innerHTML = '<div class="wrap"><p class="lead">' + (l === 'nb' || l === 'no' ? 'Denne siden er ikke tilgjengelig.' : 'This page is not available.') + '</p></div>';
      } else if (!gated && el._kept !== undefined) {
        el.innerHTML = el._kept;
        el._kept = undefined;
      }
    });
  }

  function applyJobs() {
    var closed = state.jobs || {}, l = lang();
    nodes('[data-job]').forEach(function (el) { var v = closed[el.getAttribute('data-job')]; hide(el, 'closed', v === 'closed' || v === 0); });
    nodes('[data-slots]').forEach(function (el) {
      var bits = el.getAttribute('data-slots').split(':');
      var n = slotsLeft(bits[0], Math.max(1, parseInt(bits[1], 10) || 1));
      el.textContent = n > 1 ? ' · ' + n + (l === 'nb' || l === 'no' ? ' stillinger' : ' positions') : '';
    });
    nodes('select').forEach(function (sel) {
      if (sel.selectedOptions && sel.selectedOptions[0] && sel.selectedOptions[0].hidden) sel.value = '';
    });
    nodes('[data-vac]').forEach(function (el) {
      var n = openCount(el.getAttribute('data-jobs'));
      el.textContent = phrase(el.getAttribute('data-vac'), l, n);
    });
    nodes('[data-open-count]').forEach(function (el) {
      var n = openCount(el.getAttribute('data-jobs'));
      el.textContent = String(n);
      if (el.hasAttribute('data-hide-zero')) hide(el, 'zero', n === 0);
    });
    nodes('[data-vac-zero]').forEach(function (el) {
      var n = openCount(el.getAttribute('data-jobs'));
      var mode = el.getAttribute('data-vac-zero');
      hide(el, 'zero', mode === 'show' ? n > 0 : n === 0);
    });
  }

  function applyNotice() {
    var site = c.site || '';
    var b = (state.banner || {})[site];
    var bar = document.getElementById('site-notice');
    var full = document.getElementById('site-notice-full');
    var on = b && b.on && b.text;
    if (!on) {
      if (bar) bar.remove();
      if (full) full.remove();
      document.documentElement.classList.remove('notice-full');
      return;
    }
    var tone = b.tone === 'alert' || b.tone === 'full' ? b.tone : 'info';
    if (tone === 'full') {
      if (bar) bar.remove();
      if (!full) {
        full = document.createElement('div');
        full.id = 'site-notice-full';
        full.setAttribute('role', 'alertdialog');
        full.setAttribute('aria-live', 'assertive');
        full.appendChild(document.createElement('p'));
        document.body.appendChild(full);
      }
      full.firstChild.textContent = b.text;
      document.documentElement.classList.add('notice-full');
      return;
    }
    if (full) full.remove();
    document.documentElement.classList.remove('notice-full');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'site-notice';
      bar.setAttribute('role', 'status');
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.className = 'site-notice tone-' + tone;
    bar.textContent = b.text;
  }

  function apply() {
    applyNotice();
    applyDates();
    applyJobs();
    if (window.siteStock) { try { window.siteStock.apply(todayISO(), c.baseDate || '2028-10-19'); } catch (e) { /* ignore */ } }
  }

  // ---- polling --------------------------------------------------------------------------------

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
  }
  async function tick() {
    try { await pull(false); } catch (e) { /* keep the last settings */ }
    schedule();
  }

  window.siteControl = {
    state: function () { return state; },
    today: today,
    todayISO: todayISO,
    loadSeq: function () { return loadSeq; },
    onChange: function (fn) { listeners.push(fn); },
    // Used by the sign-in page, which wants the very latest settings before it decides anything.
    refresh: async function () { try { await pull(true); } catch (e) { /* keep the last settings */ } return state; },
  };

  function start() {
    try {
      var cached = JSON.parse(window.sessionStorage.getItem(CACHE));
      if (cached && typeof cached.seq === 'number') state = cached;
    } catch (e) { /* ignore */ }
    apply();
    tick();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { clearTimeout(timer); tick(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
