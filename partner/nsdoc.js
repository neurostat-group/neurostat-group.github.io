/* NeuroStat Org. standard form, drawn in the browser.
   A document is a small JSON object (form code, title, grid of fields, a body written in a light markup, approvals).
   The same file is used by the partner portal (to show a document) and by the control panel (to edit and preview one),
   so keep apps/neurostat/public/partner/nsdoc.js and apps/painel/nsdoc.js identical.

   The measurements are those of the printed forms (a page is 460 px wide) and the whole page is scaled to fit. */
(function (root) {
  'use strict';

  var NAVY = '#14243a', GRAY = '#5c6b7d', LINE = '#9aa9bb', BLUEF = '#dfe8f7', TINT = '#eef2f8', RULE = '#c7d0dc';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }

  // ---- little drawings: barcode, QR block, mark, stamp -----------------------------------------
  function rng(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(text) {
    var n = 7;
    for (var i = 0; i < text.length; i++) n = (Math.imul(n, 31) + text.charCodeAt(i)) >>> 0;
    return n;
  }
  function barcode(seed, w, h) {
    var r = rng(seed), x = 2, bars = '';
    while (x < w - 2) {
      var bw = 1 + Math.floor(r() * 3);
      if (r() < 0.78) bars += '<rect x="' + x + '" y="0" width="' + bw + '" height="' + h + '"/>';
      x += bw + (r() < 0.7 ? 1 : 2);
    }
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" shape-rendering="crispEdges" fill="' + NAVY + '">' + bars + '</svg>';
  }
  function qr(seed, size) {
    var n = 25, r = rng(seed), out = '';
    function inFinder(x, y) { return (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8); }
    function finder(ox, oy) {
      for (var y = 0; y < 7; y++) for (var x = 0; x < 7; x++) {
        var edge = x === 0 || y === 0 || x === 6 || y === 6, core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (edge || core) out += '<rect x="' + (ox + x) + '" y="' + (oy + y) + '" width="1" height="1"/>';
      }
    }
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if (inFinder(x, y)) continue;
      if (r() < 0.48) out += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
    }
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" fill="' + NAVY + '">' + out + '</svg>';
  }
  var MARK = '<polygon points="968,285 692,747 968,746"/><polygon points="959,789 667,789 411,1224"/><polygon points="1010,285 1010,592 1469,1048"/>' +
    '<polygon points="1588,1230 1011,658 1010,806 426,1227 989,979"/><circle cx="986.6" cy="1118.3" r="63.9"/>';
  function mark(w, h, color) { return '<svg width="' + w + '" height="' + h + '" viewBox="411 285 1177 945" fill="' + (color || NAVY) + '">' + MARK + '</svg>'; }
  function stamp(text) {
    var label = esc(String(text || '').toUpperCase());
    var c = '#a3202a';
    return '<svg class="nsd-stamp" viewBox="0 0 160 145" aria-hidden="true"><g transform="rotate(-5 80 72)">' +
      '<rect x="3" y="3" width="154" height="139" fill="rgba(253,253,251,.6)" stroke="' + c + '" stroke-width="2.4"/><rect x="8" y="8" width="144" height="129" fill="none" stroke="' + c + '" stroke-width=".5"/>' +
      '<g transform="translate(58 17) scale(.0346)" fill="' + c + '">' + MARK + '</g>' +
      '<text x="80" y="96" text-anchor="middle" font-family="Roboto Condensed,Arial Narrow,sans-serif" font-weight="700" font-size="17" letter-spacing="3.4" fill="' + c + '">NEUROSTAT</text>' +
      '<line x1="22" y1="104" x2="138" y2="104" stroke="' + c + '" stroke-width="1"/>' +
      '<text x="80" y="123" text-anchor="middle" font-family="Roboto Condensed,Arial Narrow,sans-serif" font-weight="700" font-size="9.5" fill="' + c + '" textLength="' + Math.min(116, 7.2 * label.length) + '" lengthAdjust="spacingAndGlyphs">' + label + '</text></g></svg>';
  }

  // ---- the body: a light markup -------------------------------------------------------------------
  //  ## A | Heading         section heading (the part before | is the letter or number)
  //  plain lines             a paragraph (a blank line ends it)
  //  - item                  bullet list        1. item   numbered list
  //  | a | b |               table, first line is the header. Add # to a header for a monospaced column, > to right-align it
  //  > text                  shaded note box    !! text   small grey note
  //  [sign] LABEL | LABEL    signature lines
  //  **bold** works inside any line.
  function parseBody(text) {
    var lines = String(text || '').replace(/\r/g, '').split('\n'), out = [], i = 0;
    function flushPara(buf) { if (buf.length) out.push({ t: 'p', text: buf.join(' ') }); buf.length = 0; }
    var para = [];
    while (i < lines.length) {
      var ln = lines[i], m;
      if (!ln.trim()) { flushPara(para); i++; continue; }
      if ((m = /^##\s*(.*)$/.exec(ln))) {
        flushPara(para);
        var parts = m[1].split('|');
        out.push(parts.length > 1 ? { t: 'h', tag: parts[0].trim(), text: parts.slice(1).join('|').trim() } : { t: 'h', tag: '', text: m[1].trim() });
        i++; continue;
      }
      if (/^[-•]\s+/.test(ln)) {
        flushPara(para); var items = [];
        while (i < lines.length && /^[-•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-•]\s+/, '')); i++; }
        out.push({ t: 'ul', items: items }); continue;
      }
      if (/^\d+[.)]\s+/.test(ln)) {
        flushPara(para); var nums = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) { nums.push(lines[i].replace(/^\d+[.)]\s+/, '')); i++; }
        out.push({ t: 'ol', items: nums }); continue;
      }
      if (/^\|/.test(ln)) {
        flushPara(para); var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          var cells = lines[i].replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
          if (!cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) rows.push(cells);
          i++;
        }
        if (rows.length) out.push({ t: 'table', head: rows[0], rows: rows.slice(1) });
        continue;
      }
      if (/^>\s?/.test(ln)) {
        flushPara(para); var box = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { box.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push({ t: 'box', lines: box }); continue;
      }
      if ((m = /^!!\s*(.*)$/.exec(ln))) { flushPara(para); out.push({ t: 'small', text: m[1] }); i++; continue; }
      if ((m = /^\[sign\]\s*(.*)$/.exec(ln))) { flushPara(para); out.push({ t: 'sign', labels: m[1].split('|').map(function (s) { return s.trim(); }) }); i++; continue; }
      para.push(ln.trim()); i++;
    }
    flushPara(para);
    return out;
  }

  function renderBlocks(blocks) {
    return blocks.map(function (b) {
      if (b.t === 'h') return '<div class="nsd-sec">' + (b.tag ? esc(b.tag) + '&nbsp; ' : '') + esc(b.text.toUpperCase()) + '</div>';
      if (b.t === 'p') return '<p class="nsd-p">' + inline(b.text) + '</p>';
      if (b.t === 'small') return '<p class="nsd-small">' + inline(b.text) + '</p>';
      if (b.t === 'ul') return '<ul class="nsd-ul">' + b.items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>';
      if (b.t === 'ol') return '<ol class="nsd-ol">' + b.items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ol>';
      if (b.t === 'box') return '<div class="nsd-box">' + b.lines.map(inline).join('<br>') + '</div>';
      if (b.t === 'sign') return '<div class="nsd-sign">' + b.labels.map(function (l) { return '<div><i></i><span>' + esc(l.toUpperCase()) + '</span></div>'; }).join('') + '</div>';
      if (b.t === 'table') {
        var cols = b.head.map(function (h) {
          var mono = /#\s*$/.test(h) || /#>\s*$/.test(h) || />#\s*$/.test(h), right = />\s*$/.test(h) || /#>\s*$/.test(h);
          return { text: h.replace(/[#>]+\s*$/, ''), mono: mono, right: right };
        });
        return '<table class="nsd-table"><thead><tr>' + cols.map(function (c) { return '<th' + (c.right ? ' class="r"' : '') + '>' + esc(c.text.toUpperCase()) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          b.rows.map(function (r) {
            return '<tr>' + cols.map(function (c, i) { return '<td class="' + (c.mono ? 'm ' : '') + (c.right ? 'r' : '') + '">' + inline(r[i] || '') + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
      }
      return '';
    }).join('');
  }

  // ---- the page ---------------------------------------------------------------------------------------
  function dmy(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return esc(iso || '');
    return (+m[3]) + ' ' + ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][+m[2] - 1] + ' ' + m[1];
  }

  function fieldsHtml(rows, numbered) {
    var n = 0;
    return (rows || []).map(function (row, ri) {
      var cols = row.map(function (c) { return (+c.w > 0 ? +c.w : 1) + 'fr'; }).join(' ');
      return '<div class="nsd-grid' + (ri === 0 ? ' first' : '') + '" style="grid-template-columns:' + cols + '">' + row.map(function (c) {
        n++;
        var lab = (numbered === false ? '' : n + ' · ') + String(c.l || '').toUpperCase();
        return '<div class="nsd-cell' + (c.s === false ? ' plain' : '') + '"><div class="nsd-lab">' + esc(lab) + '</div><div class="nsd-val' + (c.m ? ' m' : '') + (c.b ? ' b' : '') + '">' + inline(c.v || '') + '</div></div>';
      }).join('') + '</div>';
    }).join('');
  }

  function approvalsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="nsd-sec">ISSUED AND APPROVED</div><div class="nsd-appr" style="grid-template-columns:repeat(' + list.length + ',1fr)">' + list.map(function (a) {
      return '<div><div class="h">' + esc(String(a.r || '').toUpperCase()) + '</div><div class="b">' +
        (a.n ? '<b>' + esc(String(a.n).toUpperCase()) + '</b><span>' + esc(a.s || '') + '</span>' : 'PENDING<span>— / — / —</span>') + '</div></div>';
    }).join('') + '</div>';
  }

  var CSS = '.nsd{width:460px;box-sizing:border-box;position:relative;background:#fdfdfb;color:#17202b;font-family:"Source Sans 3",Arial,sans-serif;font-size:7.6px;line-height:1.4;padding:0 0 12px;text-align:left}' +
    '.nsd *{box-sizing:border-box}.nsd .nsd-in{padding:0 24px}' +
    '.nsd-head{position:relative;padding:13px 24px 0}.nsd-top{display:flex;justify-content:space-between;font-size:5.3px;letter-spacing:.09em;color:' + GRAY + '}.nsd-top b{color:' + NAVY + '}' +
    '.nsd-no{position:absolute;left:24px;top:27px;font-family:"Courier Prime","Courier New",monospace;font-size:5.2px;color:' + GRAY + ';line-height:1.55}.nsd-no b{display:block;color:' + NAVY + ';font-size:6px}' +
    '.nsd-bar{position:absolute;right:24px;top:25px}.nsd-bar svg{display:block}' +
    '.nsd-logo{display:flex;flex-direction:column;align-items:center;margin-top:4px}.nsd-logo .w{font-family:"Roboto Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:16px;letter-spacing:.34em;margin:4px 0 0 .34em;color:' + NAVY + ';line-height:1}' +
    '.nsd-logo .u{font-size:5.4px;letter-spacing:.24em;color:' + GRAY + ';margin-top:4px;text-transform:uppercase}' +
    '.nsd-rule{margin-top:8px;height:2px;background:' + NAVY + '}.nsd-rule2{margin-top:2px;height:.75px;background:' + NAVY + '}' +
    '.nsd-stamp{position:absolute;right:36px;top:52px;width:60px;height:auto;opacity:.9}' +
    '.nsd-title{display:flex;justify-content:space-between;align-items:baseline;margin-top:11px}.nsd-title h2{font-family:"Roboto Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:15px;letter-spacing:.06em;color:' + NAVY + ';margin:0;text-transform:uppercase}' +
    '.nsd-title span{font-size:6px;letter-spacing:.08em;color:' + GRAY + ';text-transform:uppercase}' +
    '.nsd-grid{display:grid;border-left:1px solid ' + NAVY + '}.nsd-grid.first{border-top:1px solid ' + NAVY + ';margin-top:9px}' +
    '.nsd-cell{padding:3px 6px 4px;border-right:1px solid ' + NAVY + ';border-bottom:1px solid ' + NAVY + ';background:' + BLUEF + ';min-width:0}.nsd-cell.plain{background:transparent}' +
    '.nsd-lab{font-size:4.8px;letter-spacing:.09em;color:' + GRAY + ';font-weight:700}.nsd-val{font-size:7.6px;margin-top:1px;line-height:1.35;min-height:8px}.nsd-val.m{font-family:"Courier Prime","Courier New",monospace;font-weight:700;font-size:7.4px}.nsd-val.b{font-weight:700}' +
    '.nsd-sec{font-family:"Roboto Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:8px;letter-spacing:.14em;color:' + NAVY + ';border-bottom:1px solid ' + NAVY + ';padding-bottom:2px;margin:11px 0 5px}' +
    '.nsd-p{margin:0 0 4px;font-size:7.6px;line-height:1.5}.nsd-small{margin:0 0 4px;font-size:6.4px;line-height:1.45;color:' + GRAY + '}' +
    '.nsd-ul,.nsd-ol{margin:0 0 4px;padding-left:11px;font-size:7.6px;line-height:1.5}.nsd-ul li,.nsd-ol li{margin-bottom:2px}' +
    '.nsd-box{background:' + BLUEF + ';border:1px solid ' + LINE + ';padding:5px 7px;font-size:7.6px;line-height:1.5;margin:0 0 4px}' +
    '.nsd-table{width:100%;border-collapse:collapse;border:1px solid ' + NAVY + ';font-size:7.2px;margin:0 0 4px}' +
    '.nsd-table th{background:' + NAVY + ';color:#fff;font-family:"Roboto Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:5.6px;letter-spacing:.11em;padding:3px 5px;text-align:left}' +
    '.nsd-table td{padding:3px 5px;border-top:1px solid ' + RULE + ';vertical-align:top;line-height:1.3}.nsd-table .r{text-align:right}.nsd-table .m{font-family:"Courier Prime","Courier New",monospace;font-size:7px;white-space:nowrap}' +
    '.nsd-sign{display:flex;gap:14px;margin:14px 0 4px}.nsd-sign div{flex:1}.nsd-sign i{display:block;height:20px;border-bottom:.9px solid ' + NAVY + '}.nsd-sign span{font-size:4.8px;letter-spacing:.09em;color:' + GRAY + ';font-weight:700}' +
    '.nsd-appr{display:grid;border:1px solid ' + NAVY + ';font-size:6px;margin-bottom:4px}.nsd-appr>div{border-right:1px solid ' + NAVY + '}.nsd-appr>div:last-child{border-right:0}' +
    '.nsd-appr .h{background:' + TINT + ';padding:3px 6px;font-weight:700;letter-spacing:.08em;font-size:5.2px;color:' + GRAY + '}.nsd-appr .b{padding:5px 6px;min-height:26px;font-size:6.4px}.nsd-appr .b span{display:block;font-family:"Courier Prime","Courier New",monospace;color:' + GRAY + ';font-size:6px}' +
    '.nsd-foot{margin:14px 24px 0;border-top:.75px solid ' + NAVY + ';padding-top:5px;display:flex;justify-content:space-between;align-items:flex-end;gap:12px}.nsd-foot .t{font-size:5px;line-height:1.55;color:#4d5a6a}' +
    '.nsd-foot .r{display:flex;gap:6px;align-items:flex-end;flex-shrink:0}.nsd-foot .pg{font-size:5.4px;text-align:right;color:' + GRAY + ';line-height:1.5}.nsd-foot .pg b{color:' + NAVY + ';display:block}' +
    '@media print{body *{visibility:hidden!important}.nsd,.nsd *{visibility:visible!important}.nsd{position:absolute;left:0;top:0;zoom:1.73!important}}';

  function ensureCss() {
    if (root.document && !root.document.getElementById('nsd-css')) {
      var s = root.document.createElement('style');
      s.id = 'nsd-css';
      s.textContent = CSS;
      root.document.head.appendChild(s);
    }
  }

  function render(doc) {
    doc = doc || {};
    var seed = seedOf(String(doc.number || 'NS'));
    var top = '<div class="nsd-top"><span>' + esc(doc.form || '') + '</span><b>' + esc(doc.cls || '') + '</b></div>';
    var head = '<div class="nsd-head">' + top +
      '<div class="nsd-no">DOC NO.<b>' + esc(doc.number || '') + '</b></div><div class="nsd-bar">' + barcode(seed, 76, 20) + '</div>' +
      '<div class="nsd-logo">' + mark(36, 29) + '<div class="w">NEUROSTAT</div><div class="u">' + esc(doc.unit || '') + '</div></div>' +
      '<div class="nsd-rule"></div><div class="nsd-rule2"></div>' + (doc.stamp ? stamp(doc.stamp) : '') + '</div>';
    var title = '<div class="nsd-title"><h2>' + esc(doc.formname || 'Document') + '</h2><span>' + esc(doc.unitRight || '') + '</span></div>';
    var foot = '<div class="nsd-foot"><div class="t"><div>This document contains confidential and proprietary information of NeuroStat Org. Unauthorized disclosure, copying or distribution is prohibited.</div>' +
      '<div>Issued ' + dmy(doc.date) + ' · NeuroStat Document Management System v4.2</div></div><div class="r"><div class="pg">PAGE<b>1 OF 1</b></div>' + qr(seed + 1, 30) + '</div></div>';
    return '<div class="nsd">' + head + '<div class="nsd-in">' + title + fieldsHtml(doc.fields, doc.numbered) + renderBlocks(parseBody(doc.body)) + approvalsHtml(doc.approvals) + '</div>' + foot + '</div>';
  }

  // Scales the 460 px page to the width of its container.
  function fit(el, maxZoom) {
    if (!el || !el.parentNode) return;
    var w = el.parentNode.clientWidth || 460;
    var z = Math.max(0.6, Math.min(maxZoom || 1.8, w / 460));
    if ('zoom' in el.style) el.style.zoom = String(z);
    else { el.style.transformOrigin = 'top left'; el.style.transform = 'scale(' + z + ')'; el.parentNode.style.height = Math.round(el.offsetHeight * z) + 'px'; }
  }

  // ---- starting points for the editor ----------------------------------------------------------------------
  var TEMPLATES = {
    memo: { label: 'Memorando', doc: {
      form: 'FORM NS-CM-01 · REV. 04/22', formname: 'Memorandum', unit: 'Clinical Field Operations', unitRight: '', cls: 'INTERNAL — INSTALLATION MANAGERS', number: 'NS-CFO-', date: '2028-10-19', stamp: 'INTERNAL USE · LEVEL N3',
      fields: [[{ w: 2, l: 'Subject', v: 'Subject of the memorandum', b: true }, { w: 1, l: 'Document no.', v: 'NS-CFO-', m: true }], [{ w: 1.4, l: 'To', v: '' }, { w: 1, l: 'From', v: '' }, { w: 0.8, l: 'Date', v: '19 OCT 2028' }]],
      body: '## 1 | Background\nText of the first section.\n\n## 2 | What this means\n- First point\n- Second point\n\n## 3 | Contacts\nQuestions go to Clinical Field Operations.',
      approvals: [{ r: 'Issued by', n: '', s: '' }, { r: 'Copy to', n: '', s: '' }, { r: 'File copy', n: '', s: '' }] } },
    report: { label: 'Relatório com tabela', doc: {
      form: 'FORM NS-RP-05 · REV. 09/23', formname: 'Report', unit: 'Clinical Field Operations', unitRight: 'LEGACY SITES PROGRAMME', cls: 'CONFIDENTIAL — MANAGEMENT', number: 'NS-CFO-', date: '2028-10-19', stamp: 'CONFIDENTIAL · LEVEL N4',
      fields: [[{ w: 2, l: 'Title', v: 'Title of the report', b: true }, { w: 1, l: 'Document no.', v: 'NS-CFO-', m: true }], [{ w: 1, l: 'Programme', v: '' }, { w: 1, l: 'Date', v: '19 OCT 2028' }, { w: 1, l: 'Distribution', v: '' }]],
      body: '## A | Summary\nOne short paragraph.\n\n## B | Figures\n| Item | Plan> | Actual> |\n| First | 100 | 98 |\n| Second | 40 | 41 |\n\n## C | Notes\n> A shaded note.\n!! Small grey print.',
      approvals: [{ r: 'Prepared by', n: '', s: '' }, { r: 'Approved', n: '', s: '' }, { r: 'File copy', n: '', s: '' }] } },
    transcript: { label: 'Transcrição de reunião', doc: {
      form: 'FORM NS-CL-12 · REV. 02/25', formname: 'Meeting Transcript', unit: 'Clinical Field Operations', unitRight: '', cls: 'CONFIDENTIAL — INSTALLATION MANAGERS', number: 'NS-CFO-TR-', date: '2028-10-19', stamp: 'CONFIDENTIAL · LEVEL N4',
      fields: [[{ w: 2, l: 'Meeting', v: 'Name of the meeting', b: true }, { w: 1, l: 'Document no.', v: 'NS-CFO-TR-', m: true }], [{ w: 1, l: 'Date', v: '' }, { w: 1, l: 'Time', v: '', m: true }, { w: 1, l: 'Source', v: 'Video call, recording' }, { w: 1, l: 'Engine', v: 'NS-ASR v2.3' }]],
      body: '## A | Transcript\n!! Automatic transcript, checked against the audio.\n| Time# | Speaker | Statement |\n| 10:00:12 | **SECRETARY** | Recording has started. |\n| 10:00:31 | **HOLT, M.** | Good morning. |',
      approvals: [{ r: 'Transcribed by', n: 'NS-ASR v2.3', s: '' }, { r: 'Checked by', n: '', s: '' }, { r: 'Distribution', n: '', s: '' }] } },
    blank: { label: 'Em branco', doc: {
      form: 'FORM NS-GR-01 · REV. 01/24', formname: 'Notice', unit: 'NeuroStat Org.', unitRight: '', cls: 'INTERNAL USE', number: 'NS-', date: '2028-10-19', stamp: '',
      fields: [[{ w: 2, l: 'Title', v: '', b: true }, { w: 1, l: 'Document no.', v: 'NS-', m: true }]], body: '', approvals: [] } },
  };

  root.NSDoc = { render: render, fit: fit, ensureCss: ensureCss, parseBody: parseBody, templates: TEMPLATES, esc: esc, dmy: dmy };
})(typeof window !== 'undefined' ? window : globalThis);
