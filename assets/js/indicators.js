/* ============================================================
   indicators.js — 技术指标计算
   MA / EMA / BOLL / MACD / KDJ / RSI
   ============================================================ */
(function (global) {
  'use strict';

  const IND = {};

  /** 简单移动均线 */
  IND.MA = function (data, n, key) {
    key = key || 'close';
    const out = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i][key];
      if (i >= n) sum -= data[i - n][key];
      out.push(i >= n - 1 ? +(sum / n).toFixed(3) : null);
    }
    return out;
  };

  /** 指数移动均线（数组入） */
  IND.EMAArr = function (arr, n) {
    const out = new Array(arr.length);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined || !isFinite(v)) { out[i] = prev; continue; }
      prev = prev === null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };

  /** MACD：DIF / DEA / MACD柱 */
  IND.MACD = function (data, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const closes = data.map(d => d.close);
    const ef = IND.EMAArr(closes, fast);
    const es = IND.EMAArr(closes, slow);
    const dif = closes.map((_, i) => +(ef[i] - es[i]).toFixed(4));
    const dea = IND.EMAArr(dif, signal).map(v => +v.toFixed(4));
    const macd = dif.map((v, i) => +((v - dea[i]) * 2).toFixed(4));
    return { dif: dif, dea: dea, macd: macd };
  };

  /** KDJ */
  IND.KDJ = function (data, n, m1, m2) {
    n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
    const K = [], D = [], J = [];
    let k = 50, d = 50;
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(0, i - n + 1);
      let hh = -Infinity, ll = Infinity;
      for (let j = s; j <= i; j++) { hh = Math.max(hh, data[j].high); ll = Math.min(ll, data[j].low); }
      const rsv = hh === ll ? 50 : ((data[i].close - ll) / (hh - ll)) * 100;
      k = (rsv + (m1 - 1) * k) / m1;
      d = (k + (m2 - 1) * d) / m2;
      K.push(+k.toFixed(2)); D.push(+d.toFixed(2)); J.push(+(3 * k - 2 * d).toFixed(2));
    }
    return { k: K, d: D, j: J };
  };

  /** RSI */
  IND.RSI = function (data, n) {
    n = n || 14;
    const out = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < data.length; i++) {
      if (i === 0) { out.push(null); continue; }
      const diff = data[i].close - data[i - 1].close;
      const gain = Math.max(0, diff), loss = Math.max(0, -diff);
      if (i <= n) {
        avgGain += gain / n; avgLoss += loss / n;
        out.push(i === n ? +(100 - 100 / (1 + avgGain / (avgLoss || 1e-9))).toFixed(2) : null);
      } else {
        avgGain = (avgGain * (n - 1) + gain) / n;
        avgLoss = (avgLoss * (n - 1) + loss) / n;
        out.push(+(100 - 100 / (1 + avgGain / (avgLoss || 1e-9))).toFixed(2));
      }
    }
    return out;
  };

  /** BOLL */
  IND.BOLL = function (data, n, k) {
    n = n || 20; k = k || 2;
    const mid = IND.MA(data, n);
    const up = [], low = [];
    for (let i = 0; i < data.length; i++) {
      if (mid[i] === null) { up.push(null); low.push(null); continue; }
      let sq = 0;
      for (let j = i - n + 1; j <= i; j++) sq += Math.pow(data[j].close - mid[i], 2);
      const sd = Math.sqrt(sq / n);
      up.push(+(mid[i] + k * sd).toFixed(3));
      low.push(+(mid[i] - k * sd).toFixed(3));
    }
    return { mid: mid, up: up, low: low };
  };

  /** Heiken Ashi（平均K线）：平滑K线，无预热空值，每根都基于前一根递推 */
  IND.heikenAshi = function (data) {
    const out = [];
    let prevOpen = 0, prevClose = 0;
    for (let i = 0; i < data.length; i++) {
      const o = data[i].open, h = data[i].high, l = data[i].low, c = data[i].close;
      const haClose = (o + h + l + c) / 4;
      const haOpen = (i === 0) ? (o + c) / 2 : (prevOpen + prevClose) / 2;  // 用上一根开/收递推
      const hh = Math.max(h, haOpen, haClose);
      const ll = Math.min(l, haOpen, haClose);
      out.push({ open: +haOpen.toFixed(2), close: +haClose.toFixed(2), high: +hh.toFixed(2), low: +ll.toFixed(2) });
      prevOpen = haOpen; prevClose = haClose;
    }
    return out;
  };

  /**
   * 技术面综合诊断（用于选股深度校验）
   * 返回 { score, tags, detail }
   */
  IND.diagnose = function (kline) {
    if (!kline || kline.length < 30) return null;
    const n = kline.length;
    const last = kline[n - 1];
    const ma5 = IND.MA(kline, 5), ma10 = IND.MA(kline, 10), ma20 = IND.MA(kline, 20), ma60 = IND.MA(kline, 60);
    const macd = IND.MACD(kline);
    const kdj = IND.KDJ(kline);
    const rsi = IND.RSI(kline, 14);

    const tags = [];
    let score = 0;

    const m5 = ma5[n - 1], m10 = ma10[n - 1], m20 = ma20[n - 1], m60 = ma60[n - 1];

    // 均线多头排列
    if (m5 && m10 && m20 && m5 > m10 && m10 > m20) { tags.push('均线多头'); score += 18; }
    else if (m5 && m10 && m5 < m10) { score -= 6; }

    // 站上生命线
    if (m20 && last.close > m20) { tags.push('站上20日线'); score += 10; }
    if (m60 && last.close > m60) { score += 6; }

    // 金叉
    const dif = macd.dif, dea = macd.dea;
    if (dif[n - 1] > dea[n - 1] && dif[n - 2] <= dea[n - 2]) { tags.push('MACD金叉'); score += 20; }
    else if (dif[n - 1] > dea[n - 1]) { score += 8; }
    else if (dif[n - 1] < dea[n - 1] && dif[n - 2] >= dea[n - 2]) { tags.push('MACD死叉'); score -= 14; }

    // 零轴上方
    if (dif[n - 1] > 0 && dea[n - 1] > 0) score += 6;

    // KDJ
    const K = kdj.k[n - 1], D = kdj.d[n - 1];
    if (K > D && kdj.k[n - 2] <= kdj.d[n - 2]) { tags.push('KDJ金叉'); score += 14; }
    if (K < 20) { tags.push('KDJ超卖'); score += 8; }
    if (K > 88) { tags.push('KDJ超买'); score -= 8; }

    // RSI
    const R = rsi[n - 1];
    if (R !== null) {
      if (R < 30) { tags.push('RSI超卖'); score += 9; }
      else if (R > 78) { tags.push('RSI超买'); score -= 9; }
    }

    // 量能：近5日均量 / 近20日均量
    const v5 = avg(kline.slice(-5).map(d => d.volume));
    const v20 = avg(kline.slice(-20).map(d => d.volume));
    const vr = v20 ? v5 / v20 : 1;
    if (vr > 1.5) { tags.push('量能放大'); score += 12; }
    else if (vr < 0.65) { tags.push('缩量'); score += 3; }

    // 位置：距 60 日最高的回撤
    const win = kline.slice(-60);
    const hh = Math.max.apply(null, win.map(d => d.high));
    const ll = Math.min.apply(null, win.map(d => d.low));
    const posPct = hh === ll ? 50 : ((last.close - ll) / (hh - ll)) * 100;
    if (posPct < 25) { tags.push('低位区'); score += 12; }
    else if (posPct > 88) { tags.push('高位区'); score -= 6; }

    // MACD 底背离（近 40 日）
    if (n >= 40) {
      const seg = kline.slice(-40);
      const segDif = dif.slice(-40);
      let i1 = 0, i2 = 0;
      for (let i = 1; i < 20; i++) if (seg[i].low < seg[i1].low) i1 = i;
      for (let i = 20; i < 40; i++) if (seg[i].low < seg[i2 || 20].low) i2 = i;
      if (i2 && seg[i2].low < seg[i1].low && segDif[i2] > segDif[i1]) { tags.push('MACD底背离'); score += 16; }
    }

    return {
      score: Math.max(0, Math.min(100, Math.round(50 + score * 0.62))),
      tags: tags,
      detail: {
        ma5: m5, ma10: m10, ma20: m20, ma60: m60,
        dif: dif[n - 1], dea: dea[n - 1], macd: macd.macd[n - 1],
        k: K, d: D, j: kdj.j[n - 1], rsi: R,
        volRatio5v20: +vr.toFixed(2), pos60: +posPct.toFixed(1)
      }
    };
  };

  function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  global.IND = IND;
})(window);
