/* ============================================================
   api.js — 实时行情数据层（东方财富统一数据源）
   数据源：东方财富 push2.eastmoney.com
   协议：JSONP（cb 回调），全 HTTPS，适配 GitHub Pages 静态部署
   ============================================================ */
(function (global) {
  'use strict';

  const API = { mode: 'connecting', lastError: '' };

  /* ============ 常量 ============ */
  const EM_BASE  = 'https://push2.eastmoney.com';
  const EM_CLIST = EM_BASE + '/api/qt/clist/get';
  const EM_SLIST = EM_BASE + '/api/qt/slist/get';
  const EM_STOCK = EM_BASE + '/api/qt/stock/get';
  const EM_KLINE = EM_BASE + '/api/qt/stock/kline/get';
  const EM_TREND = EM_BASE + '/api/qt/stock/trends2/get';
  const EM_UT    = 'fa5fd1943c7b386f172d6893dbf28df9';

  // slist/get / clist/get 通用字段
  const F_QUOTE = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f62';

  // stock/get 字段（独立编号体系，不同于 slist/clist）
  const F_SNAP = 'f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f169,f170';

  API.FS_MAIN = { type: 'main', desc: '沪深主板' };
  API.FS_ALL  = { type: 'all',  desc: '全市场' };

  /* ============ JSONP ============ */
  function jsonp(url, timeout) {
    timeout = timeout || 15000;
    return new Promise((resolve, reject) => {
      const fn = '_em_' + Math.random().toString(36).slice(2, 8);
      const script = document.createElement('script');
      let done = false;
      const timer = setTimeout(() => { reject(new Error('JSONP timeout')); cleanup(); }, timeout);
      global[fn] = function (data) {
        done = true;
        clearTimeout(timer);
        resolve(data);
        cleanup();
      };
      const sep = url.indexOf('?') === -1 ? '?' : '&';
      script.src = url + sep + 'cb=' + fn;
      script.onerror = () => { if (!done) { reject(new Error('JSONP network error')); cleanup(); } };
      document.head.appendChild(script);
      function cleanup() {
        if (script.parentNode) script.parentNode.removeChild(script);
        delete global[fn];
      }
    });
  }

  /* ============ 代码宇宙 ============ */
  function getUniverse() {
    return (typeof MOCK_STOCKS !== 'undefined' && Array.isArray(MOCK_STOCKS)) ? MOCK_STOCKS : [];
  }

  function getUniverseSecids() {
    return getUniverse().map(function (s) { return s.secid; });
  }

  /* ============ normalize ============ */

  /** slist/clist 条目 → 统一快照 */
  function normalizeQuote(item) {
    var code = item.f12;
    var market = /^(60|68|9)/.test(code) ? 1 : 0;
    var price = num(item.f2);
    var preClose = num(item.f18);
    if (!price || price <= 0) return null;

    return {
      code: code, name: item.f14 || '', market: market, secid: market + '.' + code,
      price: price, open: num(item.f17), preClose: preClose, high: num(item.f15), low: num(item.f16),
      chg: num(item.f4) || +(price - preClose).toFixed(2),
      chgPct: num(item.f3),
      volume: (num(item.f5) || 0) * 100,
      amount: num(item.f6),
      amplitude: num(item.f7),
      turnover: num(item.f8),
      pe: num(item.f9),
      pb: num(item.f23),
      volRatio: num(item.f10),
      mktCap: num(item.f20),
      floatCap: num(item.f21),
      mainNet: num(item.f62),
      bids: [], asks: [],
      chg60: null, chgYtd: null, peTtm: null, speed: null,
      _source: 'em'
    };
  }

  /** stock/get → 盘口快照（用于 fetchSnapshot） */
  function normalizeSnap(data) {
    var code = data.f57;
    var market = /^(60|68|9)/.test(code) ? 1 : 0;
    var price = num(data.f43);
    var preClose = num(data.f60);
    if (!price || price <= 0) return null;

    return {
      code: code, name: data.f58 || '', market: market, secid: market + '.' + code,
      price: price, open: num(data.f46), preClose: preClose, high: num(data.f44), low: num(data.f45),
      chg: num(data.f170) || +(price - preClose).toFixed(2),
      chgPct: num(data.f169),
      volume: (num(data.f47) || 0) * 100,
      amount: num(data.f48),
      turnover: num(data.f167),
      pe: num(data.f162),
      pb: null,
      volRatio: num(data.f50),
      mktCap: num(data.f116),
      floatCap: num(data.f117),
      amplitude: null,
      bids: [], asks: [],
      chg60: null, chgYtd: null, mainNet: null, peTtm: null, speed: null,
      limitUp: num(data.f51),
      limitDown: num(data.f52),
      time: new Date().toTimeString().slice(0, 8),
      _source: 'em-snap'
    };
  }

  /* ============ API 方法 ============ */

  /**
   * probe — 连通性探测
   * 用 clist/get 轻量请求验证东财 API 可达
   */
  API.probe = async function (attempts) {
    attempts = attempts || 2;
    var params = 'pn=1&pz=1&po=1&np=1&fltt=2&invt=2&fs=m:0+t:6&fields=f2,f12&ut=' + EM_UT;
    for (var i = 0; i < attempts; i++) {
      try {
        var resp = await jsonp(EM_CLIST + '?' + params, 10000);
        if (resp && resp.data) {
          API.mode = 'live';
          return true;
        }
      } catch (e) {
        if (i < attempts - 1) await sleep(800);
      }
    }
    API.mode = 'mock';
    API.lastError = 'East Money API unreachable';
    return false;
  };

  /**
   * fetchAll — 渐进式拉取全量股票
   * 用 slist/get 分批（每批 80 只），每批抵达即回调 onBatch
   */
  API.fetchAll = async function (fs, onProgress, onBatch) {
    var secids = getUniverseSecids();
    if (!secids.length) throw new Error('No stock codes');

    var all = [];
    var total = secids.length;

    for (var i = 0; i < secids.length; i += 80) {
      var batch = secids.slice(i, i + 80);
      var params = 'spt=1&fltt=2&invt=2&fields=' + F_QUOTE + '&secids=' + batch.join(',');
      try {
        var resp = await jsonp(EM_SLIST + '?' + params);
        if (resp && resp.data && resp.data.diff) {
          resp.data.diff.forEach(function (item) {
            var s = normalizeQuote(item);
            if (s) all.push(s);
          });
        }
      } catch (e) { /* 单批失败跳过 */ }
      var cb = onBatch || onProgress;
      var done = Math.min(i + 80, total);
      if (cb) cb({ list: all, total: total }, done, total);
    }

    return { total: all.length, list: all };
  };

  /**
   * fetchList — 分页/排序列表
   * 用 clist/get 服务端排序（fid/po），避免客户端全量排序
   */
  API.fetchList = async function (opt) {
    opt = opt || {};
    var pn = (opt.pn || 0) + 1;  // 东财页码从 1 开始
    var pz = opt.pz || 50;
    var fid = opt.fid || 'f3';
    var po = opt.po != null ? opt.po : 1;

    var fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
    var params = [
      'pn=' + pn, 'pz=' + pz, 'po=' + po, 'np=1', 'fltt=2', 'invt=2',
      'fs=' + fs, 'fid=' + fid,
      'fields=' + F_QUOTE, 'ut=' + EM_UT
    ].join('&');

    try {
      var resp = await jsonp(EM_CLIST + '?' + params);
      if (!resp || !resp.data) throw new Error('Empty response');
      var list = (resp.data.diff || []).map(normalizeQuote).filter(Boolean);
      return { total: resp.data.total || list.length, list: list };
    } catch (e) {
      API.lastError = 'fetchList failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchByCodes — 按 secid 数组批量查询（用于自选刷新）
   */
  API.fetchByCodes = async function (secids) {
    if (!secids || !secids.length) return [];
    var results = [];
    for (var i = 0; i < secids.length; i += 80) {
      var batch = secids.slice(i, i + 80);
      var params = 'spt=1&fltt=2&invt=2&fields=' + F_QUOTE + '&secids=' + batch.join(',');
      try {
        var resp = await jsonp(EM_SLIST + '?' + params);
        if (resp && resp.data && resp.data.diff) {
          resp.data.diff.forEach(function (item) {
            var s = normalizeQuote(item);
            if (s) results.push(s);
          });
        }
      } catch (e) { /* skip */ }
    }
    return results;
  };

  /**
   * fetchKline — K线（日/周/月）
   */
  API.fetchKline = async function (secid, klt, fqt, lmt) {
    lmt = lmt || 400;
    fqt = fqt != null ? fqt : 1;
    var params = [
      'secid=' + secid,
      'klt=' + klt,
      'fqt=' + fqt,
      'end=20500101',
      'lmt=' + lmt,
      'fields1=f1,f2,f3,f4,f5,f6',
      'fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
      'ut=' + EM_UT
    ].join('&');

    try {
      var resp = await jsonp(EM_KLINE + '?' + params, 12000);
      if (!resp || !resp.data || !resp.data.klines || !resp.data.klines.length) {
        throw new Error('Empty K-line response');
      }
      return resp.data.klines.map(function (line) {
        var f = line.split(',');
        return {
          date:   f[0],
          open:   Number(f[1]),
          close:  Number(f[2]),
          high:   Number(f[3]),
          low:    Number(f[4]),
          volume: Number(f[5]),
          amount: Number(f[6])
        };
      });
    } catch (e) {
      API.lastError = 'K-line fetch failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchTrends — 分时图
   */
  API.fetchTrends = async function (secid, ndays) {
    ndays = ndays || 1;
    var params = [
      'secid=' + secid,
      'ndays=' + ndays,
      'fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
      'fields2=f51,f52,f53,f54,f55,f56,f57,f58',
      'ut=' + EM_UT
    ].join('&');

    try {
      var resp = await jsonp(EM_TREND + '?' + params, 12000);
      if (!resp || !resp.data) throw new Error('Empty trends response');

      var preClose = resp.data.preClose;
      var rawTrends = resp.data.trends || [];
      if (rawTrends.length === 0) throw new Error('Empty trends data');

      var rows = rawTrends.map(function (line) {
        var f = line.split(',');
        return { time: f[0], close: Number(f[1]), avg: 0, volume: Number(f[2]), amount: Number(f[3]) };
      });

      var cumVol = 0, cumAmt = 0;
      rows.forEach(function (r) {
        cumVol += r.volume;
        cumAmt += r.amount;
        r.avg = cumVol > 0 ? +(cumAmt / cumVol).toFixed(3) : r.close;
      });

      return { preClose: preClose, rows: rows };
    } catch (e) {
      API.lastError = 'Trends fetch failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchSnapshot — 单只股票盘口快照（stock/get）
   */
  API.fetchSnapshot = async function (secid) {
    var params = 'secid=' + secid + '&fields=' + F_SNAP + '&ut=' + EM_UT;
    try {
      var resp = await jsonp(EM_STOCK + '?' + params, 12000);
      if (!resp || !resp.data) throw new Error('No snapshot data');
      return normalizeSnap(resp.data);
    } catch (e) {
      API.lastError = 'Snapshot failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchIndex — 三大指数 + 沪深300
   * 用 slist/get 批量拉取
   */
  API.fetchIndex = async function () {
    var idxSecids = '1.000001,0.399001,0.399006,1.000300';
    var idxNames = { '1.000001': '上证指数', '0.399001': '深证成指', '0.399006': '创业板指', '1.000300': '沪深300' };
    var params = 'spt=1&fltt=2&invt=2&fields=f2,f3,f4,f5,f6,f12,f14&secids=' + idxSecids;

    try {
      var resp = await jsonp(EM_SLIST + '?' + params, 12000);
      if (!resp || !resp.data || !resp.data.diff) throw new Error('No index data');
      return resp.data.diff.map(function (item) {
        return {
          name: item.f14 || idxNames[item.f12] || item.f12,
          price: num(item.f2),
          chg: num(item.f4) || 0,
          chgPct: num(item.f3) || 0,
          volume: num(item.f5) || 0,
          amount: num(item.f6) || 0
        };
      });
    } catch (e) {
      API.lastError = 'Index fetch failed: ' + e.message;
      throw e;
    }
  };

  /* ============ 工具函数 ============ */
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function sleep(ms) { return new Promise(function (r) { return setTimeout(r, ms); }); }

  global.API = API;
})(window);
