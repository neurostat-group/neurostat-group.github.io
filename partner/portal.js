/* NeuroStat Org. partner portal: login and document viewer.
   Everything happens in the browser. A sign-in opens the account's keyring (a small encrypted record kept
   with the site settings) with a key derived from the username and password. The keyring lists the
   documents the account may open and the key for each one; the documents themselves are fetched as
   encrypted files and opened only when selected. Accounts that are not in the settings fall back to the
   older encrypted package. */
(function () {
  'use strict';

  var ROUNDS = 600000;
  var MAX_TRIES = 5;
  var LOCK_MS = 15 * 60 * 1000;
  var STORE = 'nsp_attempts';
  var TOP = 999999;

  var loginView = document.getElementById('login-view');
  var portalView = document.getElementById('portal-view');
  var form = document.getElementById('login-form');
  var errBox = document.getElementById('login-error');
  var btn = document.getElementById('login-btn');
  if (!form) return;

  var enc = new TextEncoder();
  var urls = [];
  var viewer = null; // the document viewer that is open
  var current = null; // the signed-in account: { b, user, pass, hash, ver, dynamic, sig }

  function state() {
    try { return JSON.parse(window.localStorage.getItem(STORE)) || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; }
  }
  function save(s) {
    try { window.localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Sign-in attempts are recorded in the audit log. Passwords are never sent.
  function logEvent(kind, fields) {
    if (window.siteLog) window.siteLog.send(kind, '', fields);
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64ToBlob(b64, mime) {
    return new Blob([unb64(b64)], { type: mime });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  async function nameHash(user) {
    return hex(await crypto.subtle.digest('SHA-256', enc.encode('ns-partner:' + user))).slice(0, 32);
  }
  async function deriveKey(user, pass, salt) {
    var base = await crypto.subtle.importKey('raw', enc.encode(user + '\n' + pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }

  function lockedMessage(until) {
    var mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return 'Your account has been locked after too many failed attempts. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.';
  }

  // ---- opening an account ---------------------------------------------------------------------

  // The older way: one encrypted package per account, as a static file.
  async function tryOpen(user, pass, hash) {
    var res = await fetch('/partner/d/' + hash + '.bin', { cache: 'no-store' });
    if (!res.ok) return null;
    var data = new Uint8Array(await res.arrayBuffer());
    if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'NSP1') return null;
    var key = await deriveKey(user, pass, data.slice(4, 20));
    try {
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(20, 32) }, key, data.slice(32));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
      return null;
    }
  }

  // The keyring of an account: its record in the settings store, named after the account and a version.
  async function openKeyring(user, pass, hash, ver) {
    var cfg = window.SITE_LOG || {};
    if (!cfg.projectId || !cfg.apiKey) return null;
    var id = 'acc-' + hash + '-' + ('000000' + (TOP - ver)).slice(-6);
    var res = await fetch('https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(cfg.projectId) + '/databases/(default)/documents/submissions/' + id +
      '?key=' + encodeURIComponent(cfg.apiKey), { cache: 'no-store' });
    if (!res.ok) return null;
    var f = (await res.json()).fields || {};
    if (!f.k || !f.iv || !f.c) return null;
    try {
      var key = await deriveKey(user, pass, unb64(f.k.stringValue));
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv.stringValue) }, key, unb64(f.c.stringValue));
      var ring = JSON.parse(new TextDecoder().decode(plain));
      return {
        name: ring.name, role: ring.role, welcome: ring.welcome, folders: ring.folders || [],
        docs: (ring.docs || []).map(function (d) {
          return { id: d.id, folder: d.folder || '', title: d.title, number: d.number, date: d.date, classification: d.classification, description: d.description || '', lib: d.lib, fs: d.fs, key: d.key };
        }),
      };
    } catch (e) { return null; }
  }

  // A document of a keyring is an encrypted file of its own: fetched and opened only when selected.
  // A document written in the control panel lives in the settings store: pieces of one encrypted payload and a small
  // manifest, both named after the document and a version that counts down (so the newest sorts first).
  async function loadFsDoc(d) {
    var cfg = window.SITE_LOG || {};
    var base = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(cfg.projectId) + '/databases/(default)/documents';
    var key = await crypto.subtle.importKey('raw', unb64(d.key), 'AES-GCM', false, ['decrypt']);
    var ref = function (id) { return 'projects/' + cfg.projectId + '/databases/(default)/documents/submissions/' + id; };
    var f = function (op, id) { return { fieldFilter: { field: { fieldPath: '__name__' }, op: op, value: { referenceValue: ref(id) } } }; };
    var res = await fetch(base + ':runQuery?key=' + encodeURIComponent(cfg.apiKey), { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'submissions' }],
        where: { compositeFilter: { op: 'AND', filters: [f('GREATER_THAN_OR_EQUAL', 'dm-' + d.fs + '-'), f('LESS_THAN', 'dm-' + d.fs + '.')] } },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 8 } }) });
    if (!res.ok) throw new Error('The document could not be loaded.');
    var rows = await res.json();
    for (var i = 0; i < rows.length; i++) {
      var doc = rows[i].document;
      if (!doc) continue;
      var fl = doc.fields || {};
      var man;
      try { man = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(fl.iv.stringValue) }, key, unb64(fl.c.stringValue)))); } catch (e) { continue; }
      if (man.gone) { d.file = null; d.nsdoc = null; d.gone = true; return; }
      var invStr = doc.name.split('/').pop().split('-')[2];
      var pieces = new Array(man.n), pw = man.pw || 2;
      for (var p = 0; p < man.n; p += 8) {
        var batch = [];
        for (var q = p; q < Math.min(p + 8, man.n); q++) {
          batch.push(fetch(base + '/submissions/dp-' + d.fs + '-' + invStr + '-' + ('0000' + q).slice(-pw) + '?key=' + encodeURIComponent(cfg.apiKey), { cache: 'no-store' }).then(function (idx) {
            return function (pr) { if (!pr.ok) throw new Error('The document could not be loaded.'); return pr.json().then(function (j) { pieces[idx] = j.fields.c.stringValue; }); };
          }(q)));
        }
        await Promise.all(batch);
      }
      var payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(man.iv) }, key, unb64(pieces.join('')))));
      if (payload.kind === 'file') { d.file = { filename: payload.filename, mime: payload.mime, b64: payload.b64 }; d.nsdoc = null; }
      else { d.file = null; d.nsdoc = payload; }
      d.stamp = '';
      return;
    }
    throw new Error('The document could not be loaded.');
  }
  async function loadDoc(d) {
    if (d.fs) { if (d.file === undefined) await loadFsDoc(d); return; }
    if (d.file !== undefined || !d.lib) return;
    var res = await fetch('/partner/lib/' + d.lib + '.enc', { cache: 'no-store' });
    if (!res.ok) throw new Error('The document could not be loaded.');
    var data = new Uint8Array(await res.arrayBuffer());
    if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'NSD1') throw new Error('The document could not be loaded.');
    var key = await crypto.subtle.importKey('raw', unb64(d.key), 'AES-GCM', false, ['decrypt']);
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(4, 16) }, key, data.slice(16));
    var o = JSON.parse(new TextDecoder().decode(plain));
    d.file = o.b64 ? { filename: o.filename, mime: o.mime, b64: o.b64 } : null;
    d.stamp = o.stamp || '';
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    errBox.hidden = true;
    var s = state();
    var user = form.elements.username.value.trim().toLowerCase();
    var pass = form.elements.password.value;
    if (s.until && s.until > Date.now()) {
      logEvent('portal-login', [{ label: 'Username', value: user }, { label: 'Result', value: 'Blocked (locked out)' }]);
      showError(lockedMessage(s.until));
      return;
    }
    if (s.until && s.until <= Date.now()) { s = { n: 0, until: 0 }; save(s); }
    if (!user || !pass) { showError('The username or password is incorrect.'); return; }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    var started = Date.now();
    var settingsP = window.siteControl ? window.siteControl.refresh() : Promise.resolve({});
    var hash = await nameHash(user);
    var settings = await Promise.race([settingsP, wait(2500).then(function () { return window.siteControl ? window.siteControl.state() : {}; })]);
    var bundle = null, ver = 0, dynamic = false;
    try {
      if (settings && settings.dir && Object.prototype.hasOwnProperty.call(settings.dir, hash)) {
        ver = settings.dir[hash];
        dynamic = true;
        // a version of 0 means the account has been removed
        bundle = ver ? await openKeyring(user, pass, hash, ver) : null;
      } else {
        bundle = await tryOpen(user, pass, hash);
      }
    } catch (e) { bundle = null; }
    var left = 1000 - (Date.now() - started);
    if (left > 0) await wait(left);
    btn.disabled = false;
    btn.textContent = 'Sign in';

    if (!bundle) {
      s.n = (s.n || 0) + 1;
      logEvent('portal-login', [{ label: 'Username', value: user }, { label: 'Result', value: 'Wrong username or password' }, { label: 'Failed attempts in a row', value: String(s.n) }]);
      if (s.n >= MAX_TRIES) {
        s.until = Date.now() + LOCK_MS;
        s.n = 0;
        save(s);
        showError(lockedMessage(s.until));
      } else {
        save(s);
        showError('The username or password is incorrect.');
      }
      return;
    }
    save({ n: 0, until: 0 });
    var acct = accountSettings(settings, user, hash);
    if (acct && acct.blocked) {
      logEvent('portal-login', [{ label: 'Username', value: user }, { label: 'Result', value: 'Account suspended' }]);
      form.reset();
      showError(acct.message || 'This account has been suspended. Contact the IT Service Desk.');
      return;
    }
    logEvent('portal-login', [{ label: 'Username', value: user }, { label: 'Result', value: 'Signed in' }, { label: 'Account', value: bundle.name }]);
    form.reset();
    render(bundle, { user: user, pass: pass, hash: hash, ver: ver, dynamic: dynamic });
  });

  // ---- what is on screen ----------------------------------------------------------------------

  // Per-account settings are kept under the account hash (older notices used the plain username).
  function accountSettings(st, user, hash) {
    var accounts = (st && st.accounts) || {};
    return accounts[hash] || accounts[user] || {};
  }
  function currentSettings() {
    return current ? accountSettings(window.siteControl ? window.siteControl.state() : {}, current.user, current.hash) : {};
  }
  function shownDocs(b) {
    var day = window.siteControl && window.siteControl.todayISO ? window.siteControl.todayISO() : null;
    return b.docs.filter(function (d) { return !day || d.date <= day; });
  }
  function signature() {
    var st = window.siteControl ? window.siteControl.state() : {};
    return JSON.stringify([currentSettings().note || '', st.today || '', current ? current.ver : 0]);
  }

  // ---- the intranet page ----------------------------------------------------------------------

  var LIB = 'Company library';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ui = { tab: 'mine', q: '', cls: '', sub: '' };

  function isLib(d) { return (d.folder || '').indexOf(LIB) === 0; }
  function subOf(d) {
    var f = d.folder || '';
    if (!isLib(d)) return f;
    var i = f.indexOf(' / ');
    return i >= 0 ? f.slice(i + 3) : '';
  }
  function fmtDate(iso) {
    var p = String(iso).split('-');
    return +p[2] + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }
  function firstName(name) { return String(name).replace(/^(dr|mr|ms|mrs)\.?\s+/i, '').split(/\s+/)[0]; }
  function todayISO() { return window.siteControl && window.siteControl.todayISO ? window.siteControl.todayISO() : '2028-10-19'; }
  function dayNo(iso) { return Math.floor(new Date(iso + 'T12:00:00Z').getTime() / 86400000); }
  function isNew(d) { var t = todayISO(); return d.date <= t && dayNo(t) - dayNo(d.date) <= 14; }
  function longToday() {
    return new Date(todayISO() + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function shortTitle(t) { return String(t).replace(/\s*\(blank form\)$/i, ''); }
  function byDateDesc(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }

  function rowHtml(d) {
    return '<button type="button" class="doc-row" data-id="' + esc(d.id) + '"><span class="doc-title">' + esc(shortTitle(d.title)) +
      (isNew(d) ? ' <span class="chip-new">New</span>' : '') + '</span>' +
      '<span class="doc-no">' + esc(d.number) + '</span><span class="muted small">' + esc(fmtDate(d.date)) + ' · ' + esc(d.classification) + '</span></button>';
  }

  function render(b, who) {
    watch();
    current = { b: b, user: who.user, pass: who.pass, hash: who.hash, ver: who.ver, dynamic: who.dynamic, sig: '' };
    current.sig = signature();
    var docs = shownDocs(b);
    loginView.hidden = true;
    portalView.hidden = false;
    var mine = docs.filter(function (d) { return !isLib(d); });
    var lib = docs.filter(isLib);
    var hasLib = lib.length > 0;
    if (!hasLib && ui.tab !== 'mine') ui.tab = 'mine';
    var note = currentSettings().note;

    var h = '<div class="intra">';
    h += '<header class="intra-head"><div><p class="eyebrow">NeuroStat Org. · Employee intranet</p><h1>Welcome, ' + esc(firstName(b.name)) + '</h1>' +
      '<p class="muted">' + esc(b.name) + ' · ' + esc(b.role) + '</p></div>' +
      '<div class="intra-actions"><span class="intra-date">' + esc(longToday()) + '</span><button class="btn ghost" id="signout" type="button">Sign out</button></div></header>';
    if (b.welcome) h += '<p class="form-note">' + esc(b.welcome) + '</p>';
    if (note) h += '<p class="form-note"><b>Notice:</b> ' + esc(note) + '</p>';

    var newest = docs.slice().sort(byDateDesc)[0];
    h += '<div class="intra-stats">' +
      '<div class="stat"><b>' + mine.length + '</b><span>' + (hasLib ? 'Documents for your role' : 'Documents') + '</span></div>' +
      (hasLib ? '<div class="stat"><b>' + lib.length + '</b><span>In the company library</span></div>' : '') +
      '<div class="stat"><b>' + docs.filter(isNew).length + '</b><span>Added in the last 14 days</span></div>' +
      (newest ? '<div class="stat wide"><b>' + esc(fmtDate(newest.date)) + '</b><span>Latest: ' + esc(shortTitle(newest.title)) + '</span></div>' : '') + '</div>';

    if (hasLib) {
      var forms = lib.filter(function (d) { return subOf(d) === 'Forms'; }).sort(function (x, y) { return x.title < y.title ? -1 : 1; });
      var ref = lib.filter(function (d) { return /^NS-GRP-(DIR|CAL)/.test(d.number); });
      var tiles = forms.concat(ref);
      h += '<section class="intra-sec"><h2 class="intra-h">Forms and quick links</h2><div class="tiles">';
      tiles.forEach(function (d) {
        h += '<button type="button" class="tile" data-id="' + esc(d.id) + '"><span class="tile-k">' + (subOf(d) === 'Forms' ? 'Form' : 'Reference') + '</span><span class="tile-t">' + esc(shortTitle(d.title)) +
          '</span><span class="tile-m">' + esc(d.number) + '</span></button>';
      });
      h += '<div class="tile tile-static"><span class="tile-k">IT Service Desk</span><span class="tile-t">+41 44 538 17 40</span><span class="tile-m">Every day, around the clock</span></div>' +
        '<div class="tile tile-static"><span class="tile-k">HR Services</span><span class="tile-t">hr@neurostat.com</span><span class="tile-m">Weekdays 08:30 – 17:00</span></div>' +
        '<div class="tile tile-static"><span class="tile-k">Security Operations</span><span class="tile-t">+41 44 538 17 45</span><span class="tile-m">Every day, around the clock</span></div></div></section>';
      var news = lib.filter(function (d) { return subOf(d) === 'Bulletins'; }).sort(byDateDesc).slice(0, 3);
      if (news.length) {
        h += '<section class="intra-sec"><h2 class="intra-h">Notices and bulletins</h2><ul class="news-list">';
        news.forEach(function (d) {
          h += '<li><button type="button" class="news-item" data-id="' + esc(d.id) + '"><span class="news-d">' + esc(fmtDate(d.date)) + '</span><span class="news-t">' + esc(shortTitle(d.title)) +
            '</span><span class="muted small">' + esc(d.description) + '</span></button></li>';
        });
        h += '</ul></section>';
      }
    }

    h += '<section class="intra-sec"><h2 class="intra-h">Documents</h2><div class="intra-cols"><div class="intra-docs">';
    h += '<div class="tabs" role="tablist">' +
      '<button type="button" role="tab" data-tab="mine">' + (hasLib ? 'For your role' : 'All documents') + ' <span class="cnt" id="cnt-mine">' + mine.length + '</span></button>' +
      (hasLib ? '<button type="button" role="tab" data-tab="library">Company library <span class="cnt" id="cnt-lib">' + lib.length + '</span></button>' +
        '<button type="button" role="tab" data-tab="all">All <span class="cnt">' + docs.length + '</span></button>' : '') + '</div>';
    var classes = {};
    docs.forEach(function (d) { classes[d.classification] = 1; });
    h += '<div class="doc-tools"><input type="search" id="doc-q" placeholder="Search title, number or text" aria-label="Search documents" value="' + esc(ui.q) + '" />' +
      '<select id="doc-cls" aria-label="Classification"><option value="">All classifications</option>' +
      Object.keys(classes).sort().map(function (c) { return '<option value="' + esc(c) + '"' + (ui.cls === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>';
    h += '<div class="subs" id="doc-subs"></div><div class="doc-list" id="doc-list"></div>';
    h += '</div><div class="portal-viewer" id="viewer"><p class="muted">Select a document from the list, a form or a notice.</p></div></div></section>';
    h += '<p class="intra-foot small muted">Access to this intranet is logged. Documents marked confidential must not be forwarded or printed without the permission of the owner.</p></div>';
    portalView.innerHTML = h;

    document.getElementById('signout').addEventListener('click', signOut);
    var byId = {};
    docs.forEach(function (d) { byId[d.id] = d; });
    function pick(id, row) {
      var d = byId[id];
      if (!d) return;
      portalView.querySelectorAll('.doc-row').forEach(function (r) { r.removeAttribute('aria-current'); });
      portalView.querySelectorAll('.doc-row[data-id="' + id + '"]').forEach(function (r) { r.setAttribute('aria-current', 'true'); });
      open(d, who.user);
    }
    function wire(scope) {
      scope.querySelectorAll('[data-id]').forEach(function (el) { el.addEventListener('click', function () { pick(el.getAttribute('data-id')); }); });
    }
    wire(portalView.querySelector('.tiles') || document.createElement('div'));
    wire(portalView.querySelector('.news-list') || document.createElement('div'));

    function listDocs() {
      var q = ui.q.trim().toLowerCase();
      return docs.filter(function (d) {
        if (ui.tab === 'mine' && isLib(d)) return false;
        if (ui.tab === 'library' && !isLib(d)) return false;
        if (ui.cls && d.classification !== ui.cls) return false;
        if (ui.tab === 'library' && ui.sub && subOf(d) !== ui.sub) return false;
        return !q || (d.title + ' ' + d.number + ' ' + d.description + ' ' + d.classification + ' ' + subOf(d)).toLowerCase().indexOf(q) >= 0;
      });
    }
    function renderList() {
      portalView.querySelectorAll('[data-tab]').forEach(function (t) {
        var on = t.getAttribute('data-tab') === ui.tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.classList.toggle('on', on);
      });
      var subs = document.getElementById('doc-subs');
      if (ui.tab === 'library') {
        var names = [];
        lib.forEach(function (d) { var s = subOf(d); if (s && names.indexOf(s) < 0) names.push(s); });
        subs.innerHTML = ['All'].concat(names).map(function (n) {
          var val = n === 'All' ? '' : n;
          return '<button type="button" class="sub' + (ui.sub === val ? ' on' : '') + '" data-sub="' + esc(val) + '">' + esc(n) + '</button>';
        }).join('');
        subs.hidden = false;
        subs.querySelectorAll('[data-sub]').forEach(function (s) { s.addEventListener('click', function () { ui.sub = s.getAttribute('data-sub'); renderList(); }); });
      } else {
        subs.hidden = true;
        subs.innerHTML = '';
      }
      var list = listDocs();
      var groups = {}, order = [];
      function add(name, d) { if (!groups[name]) { groups[name] = []; order.push(name); } if (d) groups[name].push(d); }
      if (ui.tab !== 'library') {
        (b.folders || []).forEach(function (f) { if (!ui.q && !ui.cls) add(f.name, null); });
        list.filter(function (d) { return !isLib(d); }).forEach(function (d) { add(d.folder || 'Documents', d); });
      }
      if (ui.tab !== 'mine') {
        list.filter(isLib).sort(function (x, y) { return subOf(x) < subOf(y) ? -1 : subOf(x) > subOf(y) ? 1 : byDateDesc(x, y); })
          .forEach(function (d) { add(ui.tab === 'all' ? LIB + ' · ' + subOf(d) : subOf(d), d); });
      }
      var html = '';
      order.forEach(function (name) {
        var items = groups[name];
        var meta = (b.folders || []).filter(function (f) { return f.name === name; })[0];
        if (!items.length && !(meta && !ui.q && !ui.cls)) return;
        html += '<h3 class="portal-folder">' + esc(name) + '</h3>';
        if (!items.length) html += '<p class="muted small">' + esc(meta && meta.note ? meta.note : 'No documents in this folder.') + '</p>';
        items.sort(byDateDesc).forEach(function (d) { html += rowHtml(d); });
      });
      if (!list.length && (ui.q || ui.cls || ui.tab !== 'mine' || !docs.length)) html += '<p class="muted">' + (docs.length ? 'No document matches.' : 'There are no documents available to this account right now.') + '</p>';
      var box = document.getElementById('doc-list');
      box.innerHTML = html;
      wire(box);
      var cur = document.querySelector('#viewer [data-open]');
      if (cur) box.querySelectorAll('.doc-row[data-id="' + cur.getAttribute('data-open') + '"]').forEach(function (r) { r.setAttribute('aria-current', 'true'); });
    }
    portalView.querySelectorAll('[data-tab]').forEach(function (t) { t.addEventListener('click', function () { ui.tab = t.getAttribute('data-tab'); renderList(); }); });
    document.getElementById('doc-q').addEventListener('input', function (ev) { ui.q = ev.target.value; renderList(); });
    document.getElementById('doc-cls').addEventListener('change', function (ev) { ui.cls = ev.target.value; renderList(); });
    renderList();
  }

  async function open(d, user) {
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    if (viewer) { viewer.destroy(); viewer = null; }
    logEvent('portal-open', [{ label: 'Username', value: user }, { label: 'Document', value: d.number + ' ' + d.title }]);
    var v = document.getElementById('viewer');
    if ((d.lib || d.fs) && d.file === undefined) {
      v.innerHTML = '<p class="muted">Loading…</p>';
      try { await loadDoc(d); } catch (e) { v.innerHTML = '<p class="muted">The document could not be loaded. Try again in a moment.</p>'; return; }
    }
    var wm = 'CONFIDENTIAL — ' + user;
    if (d.gone) { v.innerHTML = '<p class="muted">This document is no longer available.</p>'; return; }
    var html = '<div class="doc-meta" data-open="' + esc(d.id) + '"><div><h2>' + esc(d.title) + '</h2><p class="doc-no">' + esc(d.number) + ' · ' + esc(d.date) + '</p>' +
      '<p class="small"><b>Classification:</b> ' + esc(d.classification) + '</p>' + (d.description ? '<p>' + esc(d.description) + '</p>' : '') + '</div>' +
      '<div class="doc-stamp" aria-hidden="true">' + (d.stamp || '') + '</div></div>';
    if (d.nsdoc) {
      window.NSDoc.ensureCss();
      html += '<p><button class="btn ghost" id="print-doc" type="button">Print or save as PDF</button></p><div class="frame doc-page"><div class="doc-sheet" id="doc-sheet"></div>' +
        '<div class="watermark" aria-hidden="true">' + new Array(24).join('<span>' + esc(wm) + '</span>') + '</div></div>';
      v.innerHTML = html;
      var sheet = document.getElementById('doc-sheet');
      sheet.innerHTML = window.NSDoc.render(d.nsdoc);
      window.NSDoc.fit(sheet.firstChild, 1.7);
      document.getElementById('print-doc').addEventListener('click', function () { window.print(); });
      v.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (d.file) {
      v.innerHTML = html + '<div class="frame dv-frame" id="dv-box"></div>';
      var box = document.getElementById('dv-box');
      if (window.DocView) {
        viewer = window.DocView.show(box, d.file, wm, function (url) {
          // pdf.js could not run here: use the browser's own viewer
          box.innerHTML = '<p class="dv-note"><a class="btn ghost" href="' + url + '" download="' + esc(d.file.filename) + '">Download</a></p><iframe class="dv-native" title="' + esc(d.title) + '" src="' + url + '"></iframe>' +
            '<div class="watermark" aria-hidden="true">' + new Array(24).join('<span>' + esc(wm) + '</span>') + '</div>';
        });
      }
      v.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    } else {
      html += '<p class="muted">This entry has no attached file.</p>';
    }
    v.innerHTML = html;
    v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function signOut() {
    current = null;
    if (viewer) { viewer.destroy(); viewer = null; }
    ui = { tab: 'mine', q: '', cls: '', sub: '' };
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    portalView.innerHTML = '';
    portalView.hidden = true;
    loginView.hidden = false;
    errBox.hidden = true;
  }

  // Changes made while somebody is signed in: an immediate suspension, a reload, a removed or changed
  // account, a different set of documents, a notice, or a new shared date.
  var watching = false;
  function watch() {
    if (watching || !window.siteControl) return;
    watching = true;
    window.siteControl.onChange(async function (st) {
      if (!current) return;
      var acct = accountSettings(st, current.user, current.hash);
      var since = window.siteControl.loadSeq() || 0;
      if (acct.blocked && (acct.mode === 'now' || acct.mode === 'reload') && (acct.at || 0) > since) {
        if (acct.mode === 'reload') { window.location.reload(); return; }
        var msg = acct.message || 'This account has been suspended. Contact the IT Service Desk.';
        signOut();
        showError(msg);
        return;
      }
      if (current.dynamic) {
        var ver = st.dir && Object.prototype.hasOwnProperty.call(st.dir, current.hash) ? st.dir[current.hash] : current.ver;
        if (!ver) { signOut(); showError('This account is no longer available.'); return; }
        if (ver !== current.ver) {
          var who = current;
          var fresh = null;
          try { fresh = await openKeyring(who.user, who.pass, who.hash, ver); } catch (e) { fresh = null; }
          if (!current || current !== who) return;
          if (!fresh) { signOut(); showError('Your sign-in details have changed. Please sign in again.'); return; }
          render(fresh, { user: who.user, pass: who.pass, hash: who.hash, ver: ver, dynamic: true });
          return;
        }
      }
      if (signature() !== current.sig) render(current.b, current);
    });
  }
})();
