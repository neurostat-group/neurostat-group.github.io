/* Form handling. Each form shows an on-page confirmation with a reference number, and the enquiry
   is passed on to the support queue (see site-log.js). */
(function () {
  'use strict';

  function ref(prefix) {
    var n = Math.floor(10000 + Math.random() * 89999);
    return prefix + '-' + n;
  }

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || !form.hasAttribute('data-confirm')) return;
    ev.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    var bot = form.querySelector('[data-hp]');
    if (bot && bot.value) return;
    var box = document.getElementById(form.getAttribute('data-confirm'));
    var out = box && box.querySelector('[data-ref]');
    var outcome = '';
    if (form.hasAttribute('data-eligibility') && box) {
      var ok = true;
      form.querySelectorAll('select[data-ok]').forEach(function (s) {
        if (s.value !== s.getAttribute('data-ok')) ok = false;
      });
      var msg = box.querySelector('[data-outcome]');
      outcome = ok ? 'May be eligible' : 'May not be eligible';
      if (msg) {
        msg.textContent = ok
          ? 'Based on your answers you may be eligible to take part in BOREAS-2.'
          : 'Based on your answers you may not be eligible to take part in BOREAS-2.';
      }
    }
    var prefix = form.getAttribute('data-ref-prefix') || 'NS';
    var code = ref(prefix);
    if (out) out.textContent = code;
    if (window.siteLog && form.hasAttribute('data-log')) {
      var fields = window.siteLog.collect(form);
      if (outcome) fields.push({ label: 'Outcome', value: outcome });
      window.siteLog.send(form.getAttribute('data-log'), code, fields);
    }
    if (box) {
      box.hidden = false;
      box.setAttribute('tabindex', '-1');
      box.focus();
    }
    form.hidden = true;
  });

  // "Are you a healthcare professional?" gate
  var gate = document.querySelector('[data-hcp-gate]');
  var content = document.querySelector('[data-hcp-content]');
  function showHcp() {
    if (gate) gate.hidden = true;
    if (content) content.hidden = false;
  }
  try {
    if (window.sessionStorage.getItem('ns_hcp') === 'yes') showHcp();
  } catch (e) { /* storage unavailable */ }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-hcp-yes]');
    if (!btn) return;
    try { window.sessionStorage.setItem('ns_hcp', 'yes'); } catch (e) { /* ignore */ }
    showHcp();
  });

  // Stock chart range switch
  var rangeBar = document.querySelector('[data-range]');
  if (rangeBar) {
    rangeBar.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-r]');
      if (!b) return;
      var r = b.getAttribute('data-r');
      rangeBar.querySelectorAll('button').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      document.querySelectorAll('.chart').forEach(function (c) {
        c.hidden = c.getAttribute('data-r') !== r;
      });
    });
  }
})();
