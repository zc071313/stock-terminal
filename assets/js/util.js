/* ============================================================
   util.js — 通用工具
   ============================================================ */
(function (global) {
  'use strict';

  const U = {};

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 数字格式化：保留 n 位小数，空值返回 '--' */
  U.n = function (v, d) {
    if (v === null || v === undefined || v === '' || v === '-' || Number.isNaN(Number(v))) return '--';
    return Number(v).toFixed(d === undefined ? 2 : d);
  };

  /** 带符号百分比 */
  U.pct = function (v, d) {
    if (v === null || v === undefined || v === '-' || Number.isNaN(Number(v))) return '--';
    const x = Number(v);
    return (x > 0 ? '+' : '') + x.toFixed(d === undefined ? 2 : d) + '%';
  };

  /** 大额金额：元 -> 万/亿 */
  U.money = function (v) {
    if (v === null || v === undefined || v === '-' || Number.isNaN(Number(v))) return '--';
    const x = Number(v);
    const a = Math.abs(x);
    if (a >= 1e12) return (x / 1e12).toFixed(2) + '万亿';
    if (a >= 1e8) return (x / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (x / 1e4).toFixed(2) + '万';
    return x.toFixed(0);
  };

  /** 成交量：手 -> 万手/亿手 */
  U.vol = function (v) {
    if (v === null || v === undefined || v === '-' || Number.isNaN(Number(v))) return '--';
    const x = Number(v);
    if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(2) + '亿手';
    if (Math.abs(x) >= 1e4) return (x / 1e4).toFixed(2) + '万手';
    return x.toFixed(0) + '手';
  };

  /** 涨跌 class */
  U.cls = function (v) {
    const x = Number(v);
    if (!isFinite(x) || x === 0) return 'flat';
    return x > 0 ? 'up' : 'down';
  };

  /** 涨跌色值 */
  U.color = function (v) {
    const x = Number(v);
    const css = getComputedStyle(document.documentElement);
    if (!isFinite(x) || x === 0) return css.getPropertyValue('--flat').trim();
    return (x > 0 ? css.getPropertyValue('--up') : css.getPropertyValue('--down')).trim();
  };

  U.cssVar = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  };

  U.debounce = function (fn, wait) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), wait);
    };
  };

  U.esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  /** localStorage 安全封装（file:// 下也可用） */
  U.store = {
    get(key, def) {
      try {
        const raw = localStorage.getItem('zc_' + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try { localStorage.setItem('zc_' + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
    }
  };

  /** Toast 通知 */
  U.toast = function (msg, type, ms) {
    let box = U.$('#toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastBox';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(24px)';
      setTimeout(() => el.remove(), 260);
    }, ms || 2600);
  };

  /** 导出 CSV（含 BOM，Excel 中文不乱码） */
  U.exportCSV = function (filename, headers, rows) {
    const lines = [headers.join(',')];
    rows.forEach(r => {
      lines.push(r.map(c => {
        const s = c === null || c === undefined ? '' : String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  };

  /** 交易时段判断（A股） */
  U.isTradingTime = function (d) {
    d = d || new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    return (m >= 9 * 60 + 15 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60 + 2);
  };

  U.now = function () {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  /** 并发受限的任务池 */
  U.pool = async function (items, limit, worker, onProgress) {
    const results = new Array(items.length);
    let idx = 0, done = 0;
    async function run() {
      while (idx < items.length) {
        const i = idx++;
        try { results[i] = await worker(items[i], i); }
        catch (e) { results[i] = null; }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  };

  global.U = U;
})(window);
