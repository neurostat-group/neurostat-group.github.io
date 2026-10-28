/* Delivery of form submissions. Each entry is encrypted in the browser before it is sent, so the stored
   copy cannot be read without the key. Passwords are never collected. Nothing is sent while
   log-config.js has no project id. */
(function () {
  'use strict';

  var QUEUE = 'sitelog_queue';

  function labelFor(el) {
    var short = el.getAttribute('data-label');
    if (short) return short;
    var l = el.id && document.querySelector('label[for="' + el.id + '"]');
    if (!l) l = el.closest('label');
    return (l ? l.textContent : el.name || el.id || 'Field').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  function collect(form) {
    var out = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      var t = el.type;
      if (!el.tagName || t === 'submit' || t === 'button' || t === 'reset' || t === 'password' || el.hasAttribute('data-hp')) return;
      var v;
      if (t === 'checkbox') v = el.checked ? 'yes' : 'no';
      else if (t === 'radio') { if (!el.checked) return; v = el.value; }
      else if (el.tagName === 'SELECT') v = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
      else v = el.value;
      out.push({ label: labelFor(el), value: String(v).slice(0, 1500) });
    });
    return out.slice(0, 30);
  }

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function seal(obj, publicJwk) {
    var enc = new TextEncoder();
    var pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(obj)));
    var wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, await crypto.subtle.exportKey('raw', key));
    return { k: b64(wrapped), iv: b64(iv), c: b64(ct) };
  }

  function endpoint(c) {
    return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(c.projectId) +
      '/databases/(default)/documents/submissions?key=' + encodeURIComponent(c.apiKey);
  }

  function readQueue() {
    try { return JSON.parse(window.localStorage.getItem(QUEUE)) || []; } catch (e) { return []; }
  }
  function writeQueue(q) {
    try { window.localStorage.setItem(QUEUE, JSON.stringify(q.slice(-20))); } catch (e) { /* ignore */ }
  }

  async function post(c, doc) {
    var res = await fetch(endpoint(c), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ fields: { t: { stringValue: doc.t }, k: { stringValue: doc.k }, iv: { stringValue: doc.iv }, c: { stringValue: doc.c } } }),
    });
    if (!res.ok) throw new Error('log ' + res.status);
  }

  async function send(kind, ref, fields) {
    var c = window.SITE_LOG;
    if (!c || !c.projectId || !c.apiKey || !c.publicKey || !window.crypto || !crypto.subtle) return;
    try {
      var t = new Date().toISOString();
      var sealed = await seal({
        t: t, site: c.site || '', form: kind, ref: ref || '', page: location.pathname,
        lang: document.documentElement.lang || '', ua: navigator.userAgent || '', fields: fields || [],
      }, c.publicKey);
      var doc = { t: t, k: sealed.k, iv: sealed.iv, c: sealed.c };
      try { await post(c, doc); } catch (e) { var q = readQueue(); q.push(doc); writeQueue(q); }
    } catch (e) { /* the visitor never sees logging problems */ }
  }

  // Send anything that could not be sent earlier (for example when the visitor was offline).
  async function flush() {
    var c = window.SITE_LOG;
    if (!c || !c.projectId) return;
    var q = readQueue();
    if (!q.length) return;
    var rest = [];
    for (var i = 0; i < q.length; i++) {
      try { await post(c, q[i]); } catch (e) { rest.push(q[i]); }
    }
    writeQueue(rest);
  }

  // Hidden field that only bots fill in.
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form[data-log]').forEach(function (f) {
      var hp = document.createElement('input');
      hp.type = 'text';
      hp.name = 'website';
      hp.tabIndex = -1;
      hp.autocomplete = 'off';
      hp.setAttribute('aria-hidden', 'true');
      hp.setAttribute('data-hp', '');
      hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';
      f.appendChild(hp);
    });
    flush();
  });

  window.siteLog = { collect: collect, send: send };
})();
