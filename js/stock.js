/* Share price for a chosen date. At the default date the page already shows the right numbers. When the
   shared date changes, the closing price, the change and the charts are redrawn for that date. */
(function () {
  'use strict';

  var DAY = 86400000;
  var data = null;
  var loading = null;
  var originals = [];

  function nodes(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function ms(day) { return Date.parse(day + 'T00:00:00Z'); }

  function load() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/js/stock-data.js';
      s.onload = function () {
        var p = window.NEUS_PX, out = [], t = ms(p.start), i = 0;
        while (i < p.closes.length) {
          var d = new Date(t), dow = d.getUTCDay();
          if (dow !== 0 && dow !== 6) { out.push({ date: d.toISOString().slice(0, 10), close: p.closes[i] / 100 }); i++; }
          t += DAY;
        }
        data = out;
        resolve(data);
      };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function lastOn(day) {
    var lo = 0, hi = data.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (data[mid].date <= day) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function longDate(day) {
    return new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function pick(key, end) {
    var span = { '1M': 31, '1Y': 365, '5Y': 365 * 5, MAX: 99999 }[key];
    var from = ms(data[end].date) - span * DAY;
    var sel = data.slice(0, end + 1).filter(function (p) { return ms(p.date) >= from; });
    var step = key === '5Y' ? 5 : key === 'MAX' ? 10 : 1;
    var out = sel.filter(function (_, i) { return i % step === 0; });
    if (out[out.length - 1] !== sel[sel.length - 1]) out.push(sel[sel.length - 1]);
    return out;
  }

  // Same drawing as the page builds on its own, so the chart looks the same on any date.
  function chart(key, pts) {
    var W = 900, H = 340, L = 56, R = 16, T = 16, B = 34;
    var closes = pts.map(function (p) { return p.close; });
    var min = Math.floor(Math.min.apply(null, closes) / 5) * 5;
    var max = Math.ceil(Math.max.apply(null, closes) / 5) * 5;
    if (max === min) max = min + 5;
    var x0 = ms(pts[0].date), x1 = ms(pts[pts.length - 1].date);
    var X = function (d) { return L + ((ms(d) - x0) / (x1 - x0)) * (W - L - R); };
    var Y = function (v) { return T + (1 - (v - min) / (max - min)) * (H - T - B); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.date).toFixed(1) + ' ' + Y(p.close).toFixed(1); }).join('');
    var nX = key === '1M' ? 4 : 5;
    var fmt = function (s) {
      var dt = new Date(s + 'T00:00:00Z');
      return key === '1M' || key === '1Y'
        ? dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: key === '1Y' ? '2-digit' : undefined, timeZone: 'UTC' })
        : String(dt.getUTCFullYear());
    };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="t-' + key + '" style="width:100%;height:auto;background:#fff;border:1px solid var(--line)">' +
      '<title id="t-' + key + '">NEUS share price in CHF, ' + (key === 'MAX' ? 'since listing' : key) + '. From CHF ' + pts[0].close.toFixed(2) + ' on ' + pts[0].date +
      ' to CHF ' + pts[pts.length - 1].close.toFixed(2) + ' on ' + pts[pts.length - 1].date + '.</title>';
    for (var i = 0; i < 5; i++) {
      var v = min + ((max - min) * i) / 4;
      svg += '<g><line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#e1e7ee"/><text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end" font-size="12" fill="#5c6b7d">' + Math.round(v) + '</text></g>';
    }
    for (var j = 0; j < nX; j++) {
      var p = pts[Math.round(((pts.length - 1) * j) / (nX - 1))];
      svg += '<text x="' + X(p.date) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="12" fill="#5c6b7d">' + fmt(p.date) + '</text>';
    }
    var lp = pts[pts.length - 1];
    svg += '<path d="' + path + '" fill="none" stroke="#14243a" stroke-width="2" stroke-linejoin="round"/><circle cx="' + X(lp.date) + '" cy="' + Y(lp.close) + '" r="4" fill="#14243a"/></svg>' +
      '<figcaption class="small muted" style="margin-top:.5rem">Share price in CHF, SIX Swiss Exchange. Closing prices up to ' + lp.date + '.</figcaption>';
    return svg;
  }

  function remember(el) {
    if (!el._orig) { el._orig = { html: el.innerHTML, cls: el.className }; originals.push(el); }
  }
  function restore() {
    originals.forEach(function (el) { el.innerHTML = el._orig.html; el.className = el._orig.cls; });
    nodes('[data-stock-block]').forEach(function (el) { el.hidden = false; });
  }

  function draw(day) {
    var end = lastOn(day);
    var blocks = nodes('[data-stock-block]');
    if (end < 1) { blocks.forEach(function (el) { el.hidden = true; }); return; }
    blocks.forEach(function (el) { el.hidden = false; });
    var last = data[end], prev = data[end - 1];
    var change = Math.round((last.close - prev.close) * 100) / 100;
    var pct = Math.round(((last.close - prev.close) / prev.close) * 10000) / 100;
    var up = change >= 0;
    nodes('[data-px]').forEach(function (el) { remember(el); el.textContent = 'CHF ' + last.close.toFixed(2); });
    nodes('[data-chg]').forEach(function (el) {
      remember(el);
      el.textContent = (up ? '+' : '') + change.toFixed(2) + ' (' + (up ? '+' : '') + pct.toFixed(2) + '%)';
      el.className = 'chg ' + (up ? 'up' : 'down');
    });
    nodes('[data-close-date]').forEach(function (el) { remember(el); el.textContent = 'Close, ' + longDate(last.date); });
    nodes('figure.chart[data-r]').forEach(function (fig) {
      var pts = pick(fig.getAttribute('data-r'), end);
      if (pts.length < 2) return;
      remember(fig);
      fig.innerHTML = chart(fig.getAttribute('data-r'), pts);
    });
  }

  window.siteStock = {
    apply: function (day, base) {
      if (!nodes('[data-stock-block]').length) return;
      if (day === base) { restore(); return; }
      load().then(function (d) { if (d) draw(day); });
    },
  };
})();
