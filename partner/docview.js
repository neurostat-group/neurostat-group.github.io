/* Document viewer for the partner portal: PDFs are drawn page by page in the browser (pdf.js, kept in /partner/pdf/),
   with a small toolbar for the page, the zoom, download and print. Images get the same frame. If pdf.js cannot run
   (an old browser, say), the PDF falls back to the browser's own viewer.

   window.DocView.show(box, { title, filename, mime, b64 }, onFallback) fills `box`; the returned object has destroy(). */
(function (root) {
  'use strict';

  var PDF = '/partner/pdf/';
  var lib = null;

  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function loadLib() {
    if (!lib) {
      lib = import(PDF + 'pdf.min.mjs').then(function (m) {
        m.GlobalWorkerOptions.workerSrc = PDF + 'pdf.worker.min.mjs';
        return m;
      });
    }
    return lib;
  }

  var ICON = {
    prev: '<path d="M15 6l-6 6 6 6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><path d="M7 14h10v6H7z"/>',
  };
  function btn(id, icon, label) {
    return '<button type="button" class="dv-btn" id="' + id + '" aria-label="' + label + '" title="' + label + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[icon] + '</svg></button>';
  }

  function show(box, file, wm, onFallback) {
    var state = { destroyed: false, url: null, doc: null, zoom: 1, pages: [], observer: null, ro: null };
    var blob = new Blob([unb64(file.b64)], { type: file.mime });
    state.url = URL.createObjectURL(blob);
    var isPdf = file.mime === 'application/pdf';

    var bar = '<div class="dv-bar">' +
      (isPdf ? '<div class="dv-group">' + btn('dv-prev', 'prev', 'Previous page') + '<span class="dv-count" id="dv-count" aria-live="polite">–</span>' + btn('dv-next', 'next', 'Next page') + '</div>' +
        '<div class="dv-group">' + btn('dv-out', 'minus', 'Zoom out') + '<span class="dv-zoom" id="dv-zoom">100 %</span>' + btn('dv-in', 'plus', 'Zoom in') + btn('dv-fit', 'fit', 'Fit to width') + '</div>' : '<div class="dv-group"><span class="dv-count">Image</span></div>') +
      '<div class="dv-group">' + '<a class="dv-btn" id="dv-down" href="' + state.url + '" download="' + esc(file.filename) + '" aria-label="Download" title="Download"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON.down + '</svg></a>' +
      (isPdf ? btn('dv-print', 'print', 'Print') : '') + '</div></div>';
    box.innerHTML = '<div class="dv">' + bar + '<div class="dv-body"><div class="dv-scroll" id="dv-scroll"><div class="dv-pages" id="dv-pages"><p class="dv-msg">Opening the document…</p></div></div>' +
      '<div class="watermark" aria-hidden="true">' + new Array(24).join('<span>' + esc(wm) + '</span>') + '</div></div></div>';

    var scroll = box.querySelector('#dv-scroll'), pagesEl = box.querySelector('#dv-pages'), count = box.querySelector('#dv-count'), zoomEl = box.querySelector('#dv-zoom');

    if (!isPdf) {
      pagesEl.innerHTML = '<img class="dv-img" alt="' + esc(file.filename) + '" src="' + state.url + '" />';
      return { destroy: destroy };
    }

    function destroy() {
      state.destroyed = true;
      if (state.observer) state.observer.disconnect();
      if (state.ro) state.ro.disconnect();
      if (state.doc) { try { state.doc.destroy(); } catch (e) { /* ignore */ } }
      if (state.url) URL.revokeObjectURL(state.url);
    }

    function fail() {
      if (state.destroyed) return;
      // the browser's own viewer is better than nothing
      if (onFallback) { onFallback(state.url); return; }
      pagesEl.innerHTML = '<p class="dv-msg">This document could not be shown here. Use the download button instead.</p>';
    }

    function fitScale(vp1) {
      var avail = Math.max(240, scroll.clientWidth - (scroll.clientWidth < 600 ? 16 : 40));
      return Math.min(avail / vp1.width, 2.2) * state.zoom;
    }

    function layout() {
      state.pages.forEach(function (p) {
        var s = fitScale(p.vp1);
        p.scale = s;
        p.el.style.width = Math.round(p.vp1.width * s) + 'px';
        p.el.style.height = Math.round(p.vp1.height * s) + 'px';
        p.rendered = 0; // draw again at the new size
        if (p.canvas) { p.canvas.remove(); p.canvas = null; }
        if (p.visible) draw(p);
      });
      zoomEl.textContent = Math.round(state.zoom * 100) + ' %';
    }

    function draw(p) {
      if (state.destroyed || p.drawing || p.rendered === p.scale) return;
      p.drawing = true;
      var want = p.scale;
      var ratio = Math.min(root.devicePixelRatio || 1, 2.5);
      var vp = p.page.getViewport({ scale: want * ratio });
      // keep the canvas within what phones can hold
      var maxPx = 14e6, px = vp.width * vp.height;
      if (px > maxPx) { var k = Math.sqrt(maxPx / px); vp = p.page.getViewport({ scale: want * ratio * k }); }
      var c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      c.className = 'dv-canvas';
      var task = p.page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      task.promise.then(function () {
        if (state.destroyed) return;
        if (p.canvas) p.canvas.remove();
        p.el.appendChild(c);
        p.canvas = c;
        p.rendered = want;
        p.el.classList.add('done');
      }, function () { /* a cancelled draw */ }).then(function () { p.drawing = false; if (p.rendered !== p.scale && p.visible) draw(p); });
    }

    function current() {
      var top = scroll.scrollTop + scroll.clientHeight * 0.35, idx = 0;
      state.pages.forEach(function (p, i) { if (p.el.offsetTop <= top) idx = i; });
      return idx;
    }
    function updateCount() { if (state.pages.length) count.textContent = (current() + 1) + ' / ' + state.pages.length; }
    function go(i) {
      i = Math.max(0, Math.min(state.pages.length - 1, i));
      scroll.scrollTo({ top: state.pages[i].el.offsetTop - 8, behavior: 'smooth' });
    }
    function setZoom(z) {
      var idx = current();
      state.zoom = Math.max(0.5, Math.min(3, z));
      layout();
      if (state.pages[idx]) scroll.scrollTop = state.pages[idx].el.offsetTop - 8;
      updateCount();
    }

    box.querySelector('#dv-prev').addEventListener('click', function () { go(current() - 1); });
    box.querySelector('#dv-next').addEventListener('click', function () { go(current() + 1); });
    box.querySelector('#dv-in').addEventListener('click', function () { setZoom(state.zoom * 1.2); });
    box.querySelector('#dv-out').addEventListener('click', function () { setZoom(state.zoom / 1.2); });
    box.querySelector('#dv-fit').addEventListener('click', function () { setZoom(1); });
    box.querySelector('#dv-print').addEventListener('click', function () {
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      f.src = state.url;
      f.onload = function () { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { root.open(state.url); } setTimeout(function () { f.remove(); }, 60000); };
      document.body.appendChild(f);
    });
    scroll.addEventListener('scroll', updateCount, { passive: true });
    scroll.setAttribute('tabindex', '0');
    scroll.addEventListener('keydown', function (e) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(state.zoom * 1.2); }
      else if (e.key === '-') { e.preventDefault(); setZoom(state.zoom / 1.2); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    });

    loadLib().then(function (pdfjs) {
      if (state.destroyed) return null;
      return pdfjs.getDocument({ data: unb64(file.b64), standardFontDataUrl: PDF + 'standard_fonts/', isEvalSupported: false }).promise;
    }).then(function (doc) {
      if (!doc || state.destroyed) { if (doc) doc.destroy(); return; }
      state.doc = doc;
      pagesEl.textContent = '';
      var all = [];
      for (var n = 1; n <= doc.numPages; n++) all.push(doc.getPage(n));
      return Promise.all(all).then(function (pages) {
        if (state.destroyed) return;
        pages.forEach(function (page, i) {
          var el = document.createElement('div');
          el.className = 'dv-page';
          el.setAttribute('aria-label', 'Page ' + (i + 1));
          pagesEl.appendChild(el);
          state.pages.push({ page: page, el: el, vp1: page.getViewport({ scale: 1 }), scale: 0, rendered: 0, visible: false, canvas: null, drawing: false });
        });
        state.observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            var p = state.pages.filter(function (x) { return x.el === en.target; })[0];
            if (!p) return;
            p.visible = en.isIntersecting;
            if (p.visible) draw(p);
            else if (p.canvas && Math.abs(state.pages.indexOf(p) - current()) > 3) { p.canvas.remove(); p.canvas = null; p.rendered = 0; p.el.classList.remove('done'); }
          });
        }, { root: scroll, rootMargin: '700px 0px' });
        state.pages.forEach(function (p) { state.observer.observe(p.el); });
        layout();
        updateCount();
        var lastW = scroll.clientWidth, timer = null;
        if (root.ResizeObserver) {
          state.ro = new ResizeObserver(function () {
            if (scroll.clientWidth === lastW) return;
            lastW = scroll.clientWidth;
            clearTimeout(timer);
            timer = setTimeout(function () { layout(); updateCount(); }, 120);
          });
          state.ro.observe(scroll);
        }
      });
    }).catch(fail);

    return { destroy: destroy };
  }

  root.DocView = { show: show };
})(window);
