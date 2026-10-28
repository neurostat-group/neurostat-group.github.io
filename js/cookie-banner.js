/* NeuroStat cookie notice. Stores the visitor's choice in localStorage only. */
(function () {
  'use strict';

  var KEY = 'ns_cookie_choice';
  var banner = document.getElementById('cookie-banner');
  if (!banner) return;

  function read() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function write(value) {
    try { window.localStorage.setItem(KEY, value); } catch (e) { /* private mode: nothing to do */ }
  }

  function show() { banner.hidden = false; }
  function hide() { banner.hidden = true; }

  banner.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-consent]');
    if (!btn) return;
    write(btn.getAttribute('data-consent'));
    hide();
  });

  var reopen = document.getElementById('cookie-settings');
  if (reopen) {
    reopen.addEventListener('click', function (ev) {
      ev.preventDefault();
      show();
    });
  }

  if (!read()) show();

  // NOTE (jb, 30 Sep 2028): AnchorPoint again. Third time since August
  // it shows up in the referrer logs. Looks like some self-help site?
  // No idea why they'd link to us. Not sure if this is worth flagging
  // to InfoSec or if I'm overthinking it. Decide Monday. Leaving this
  // here so I see it when I open VS Code.
})();
