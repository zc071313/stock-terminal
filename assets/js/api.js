/* ============================================================
   api.js — 实时行情数据层（东方财富 push2.eastmoney.com 全源）
   数据源：东方财富（行情报价 / K线 / 分时），全 HTTPS，适配 GitHub Pages
   协议：JSONP，全 HTTPS
   ============================================================ */
(function (global) {
  'use strict';

  var API = { mode: 'connecting', lastError: '' };

  /* ============ 常量 ============ */
  var EM_QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get';
  var EM_KLINE = 'https://push2.eastmoney.com/api/qt/stock/kline/get';
  var EM_TREND = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
  var EM_UT    = 'fa5fd1943c7b386f172d6893dbf28df9';

  // 东方财富行情字段（用于 stock/get API）
  var EM_QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171,f172,f173';

  API.FS_MAIN = { type: 'main', desc: '沪深主板' };
  API.FS_ALL  = { type: 'all',  desc: '全市场' };

  /* ============ JSONP ============ */
  function jsonp(url, timeout, cbParam) {
    timeout = timeout || 15000;
    cbParam = cbParam || 'cb';
    return new Promise(function (resolve, reject) {
      var fn = '_jp_' + Math.random().toString(36).slice(2, 8);
      var script = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () { reject(new Error('JSONP timeout')); cleanup(); }, timeout);
      global[fn] = function (data) {
        done = true;
        clearTimeout(timer);
        resolve(data);
        cleanup();
      };
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      script.src = url + sep + cbParam + '=' + fn;
      script.onerror = function () { if (!done) { reject(new Error('JSONP network error')); cleanup(); } };
      document.head.appendChild(script);
      function cleanup() {
        if (script.parentNode) script.parentNode.removeChild(script);
        delete global[fn];
      }
    });
  }

  /* ============ 东方财富单股行情 ============ */
  /**
   * emQuote — 单只股票行情（东方财富 JSONP）
   * secid 格式："1.600519"（市场.代码）
   * 返回东方财富原始 data 对象，失败返回 null
   */
  function emQuote(secid, timeout) {
    timeout = timeout || 12000;
    var url = EM_QUOTE + '?secid=' + secid + '&fields=' + EM_QUOTE_FIELDS + '&ut=' + EM_UT;
    return jsonp(url, timeout).then(function (resp) {
      if (!resp || !resp.data) return null;
      return resp.data;
    }).catch(function () {
      return null;
    });
  }

  /**
   * emQuoteBatch — 并行批量行情请求
   * secids: secid 数组
   * concurrency: 并发上限（默认 30）
   * 返回快照数组（跳过失败的）
   */
  async function emQuoteBatch(secids, concurrency) {
    concurrency = concurrency || 30;
    var results = [];
    for (var i = 0; i < secids.length; i += concurrency) {
      var batch = secids.slice(i, i + concurrency);
      var promises = batch.map(function (sid) { return emQuote(sid); });
      var batchResults = await Promise.all(promises);
      for (var j = 0; j < batchResults.length; j++) {
        if (batchResults[j]) results.push(batchResults[j]);
      }
    }
    return results;
  }

  /* ============ 代码转换 ============ */
  function getUniverse() {
    return (typeof MOCK_STOCKS !== 'undefined' && Array.isArray(MOCK_STOCKS)) ? MOCK_STOCKS : [];
  }

  function getUniverseSecids() {
    return getUniverse().map(function (s) {
      if (!s || !s.code || s.market == null) return null;
      return s.market + '.' + s.code;
    }).filter(Boolean);
  }

  /* ============ normalize：东方财富字段 → 统一快照 ============ */
  /**
   * 东方财富 stock/get 字段映射（值均来自 API 原始返回）：
   *   f43: 最新价,     f44: 最高,       f45: 最低,       f46: 今开
   *   f47: 成交量(手),  f48: 成交额(元)
   *   f57: 代码,       f58: 名称,       f59: 市场标识
   *   f60: 昨收
   *   f116: 总市值(元), f117: 流通市值(元)
   *   f162: PE(TTM),   f167: PB,        f168: 换手率
   *   f169: 涨跌额(元), f170: 涨跌幅(%),  f173: 量比
   *
   * 价格类字段 (f43/f44/f45/f46/f60/f169) 需要 /100
   * 比例类字段 (f170/f162/f167/f168) 需要 /100
   * 涨跌停 = preClose * 1.1 / preClose * 0.9（计算值）
   */
  function normalizeEm(d) {
    if (!d || !d.f57 || !d.f43) return null;

    var code   = d.f57;
    var market = String(d.f57).length === 6 && (String(d.f57).charAt(0) === '6' || String(d.f57).charAt(0) === '9') ? 1 : 0;
    // f59: 2=沪, 但用代码前缀更可靠
    if (typeof d.f59 === 'number') {
      market = d.f59 === 2 ? 1 : d.f59 === 1 ? 0 : market;
    }
    var secid = market + '.' + code;

    var price    = (d.f43 != null) ? d.f43 / 100 : null;
    var preClose = (d.f60 != null) ? d.f60 / 100 : null;
    if (!price || price <= 0) return null;

    var high = (d.f44 != null) ? d.f44 / 100 : null;
    var low  = (d.f45 != null) ? d.f45 / 100 : null;
    var open = (d.f46 != null) ? d.f46 / 100 : null;

    return {
      code: code, name: d.f58, market: market, secid: secid,
      price: price, open: open, preClose: preClose,
      high: high, low: low,
      chg:     (d.f169 != null) ? d.f169 / 100 : null,
      chgPct:  (d.f170 != null) ? d.f170 / 100 : null,
      volume:  (d.f47  != null) ? d.f47 * 100 : 0,       // 手 → 股
      amount:  (d.f48  != null) ? d.f48 : 0,              // 已是元
      amplitude: (high != null && low != null && preClose && preClose > 0)
                  ? +(((high - low) / preClose) * 100).toFixed(2) : null,
      turnover: (d.f168 != null) ? +(d.f168 / 100).toFixed(2) : null,
      pe:       (d.f162 != null) ? +(d.f162 / 100).toFixed(2) : null,
      pb:       (d.f167 != null) ? +(d.f167 / 100).toFixed(2) : null,
      volRatio: (d.f173 != null) ? d.f173 : null,
      mktCap:   (d.f116 != null) ? d.f116 : null,         // 已是元
      floatCap: (d.f117 != null) ? d.f117 : null,
      // 买卖五档：东方财富 stock/get 不返回盘口，留空
      bids: [],
      asks: [],
      // 涨跌停：计算值
      limitUp:   preClose ? +(preClose * 1.1).toFixed(2) : null,
      limitDown: preClose ? +(preClose * 0.9).toFixed(2) : null,
      chg60: null, chgYtd: null, mainNet: null, peTtm: null, speed: null,
      _source: 'em'
    };
  }

  /* ============ 批量拉取辅助 ============ */
  async function batchEmToSnapshots(secids, onBatch) {
    var all = [];
    var total = secids.length;
    var concurrency = 30;
    for (var i = 0; i < secids.length; i += concurrency) {
      var batch = secids.slice(i, i + concurrency);
      try {
        var promises = batch.map(function (sid) { return emQuote(sid); });
        var rawList = await Promise.all(promises);
        for (var j = 0; j < rawList.length; j++) {
          var s = normalizeEm(rawList[j]);
          if (s) all.push(s);
        }
      } catch (e) { /* 单批失败跳过 */ }
      if (onBatch) {
        onBatch({ list: all, total: total }, Math.min(i + concurrency, total), total);
      }
    }
    return all;
  }

  /* ============ API 方法 ============ */

  /**
   * probe — 连通性探测（东方财富 push2.eastmoney.com）
   * 探测上证指数（1.000001），3 次重试，失败回退 mock
   */
  API.probe = async function () {
    var intervals = [800, 1200, 2000];
    for (var i = 0; i < 3; i++) {
      try {
        var url = EM_QUOTE + '?secid=1.000001&fields=f43&ut=' + EM_UT;
        var resp = await jsonp(url, 10000);
        if (resp && resp.data && resp.data.f43 != null) {
          API.mode = 'live';
          API.dataSource = 'em';
          return true;
        }
      } catch (e) {
        if (i < 2) await sleep(intervals[i]);
      }
    }
    API.mode = 'mock';
    API.dataSource = 'mock';
    API.lastError = 'EastMoney push2.eastmoney.com unreachable';
    return false;
  };

  /**
   * fetchAll — 渐进式拉取全量股票
   */
  API.fetchAll = async function (fs, onProgress, onBatch) {
    var secids = getUniverseSecids();
    if (!secids.length) throw new Error('No stock codes');

    var all = await batchEmToSnapshots(secids, onBatch || onProgress);
    return { total: all.length, list: all };
  };

  /**
   * fetchList — 分页/排序列表
   */
  API.fetchList = async function (opt) {
    opt = opt || {};
    var pn  = opt.pn  || 0;
    var pz  = opt.pz  || 50;
    var fid = opt.fid || 'f3';
    var po  = opt.po  != null ? opt.po : 1;

    var secids = getUniverseSecids();
    if (!secids.length) throw new Error('No stock codes');

    var rawList = await emQuoteBatch(secids, 30);
    var all = rawList.map(normalizeEm).filter(Boolean);

    var keyMap = {
      'f3': 'chgPct', 'f6': 'amount', 'f8': 'turnover',
      'f10': 'volRatio', 'f20': 'mktCap', 'f2': 'price', 'f9': 'pe'
    };
    var sortKey = keyMap[fid] || 'chgPct';

    all.sort(function (a, b) {
      var va = a[sortKey] != null ? a[sortKey] : -Infinity;
      var vb = b[sortKey] != null ? b[sortKey] : -Infinity;
      return po === 1 ? vb - va : va - vb;
    });

    var total = all.length;
    var start = pn * pz;
    var page = all.slice(start, start + pz);

    return { total: total, list: page };
  };

  /**
   * fetchByCodes — 按 secid 数组批量查询（自选刷新）
   */
  API.fetchByCodes = async function (secids) {
    if (!secids || !secids.length) return [];
    var rawList = await emQuoteBatch(secids, secids.length > 30 ? 30 : secids.length);
    return rawList.map(normalizeEm).filter(Boolean);
  };

  /**
   * fetchKline — K线（东方财富）
   * 日线 klt=101 / 周线 102 / 月线 103
   */
  API.fetchKline = async function (secid, klt, fqt, lmt) {
    lmt = lmt || 400;
    fqt = fqt != null ? fqt : 1;
    var params = [
      'secid=' + secid, 'klt=' + klt, 'fqt=' + fqt,
      'end=20500101', 'lmt=' + lmt,
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
        if (!line || typeof line !== 'string') return null;
        var f = line.split(',');
        if (!f || f.length < 7) return null;
        return {
          date:   f[0],
          open:   Number(f[1]),
          close:  Number(f[2]),
          high:   Number(f[3]),
          low:    Number(f[4]),
          volume: Number(f[5]),
          amount: Number(f[6])
        };
      }).filter(Boolean);
    } catch (e) {
      API.lastError = 'K-line fetch failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchTrends — 分时图（东方财富）
   */
  API.fetchTrends = async function (secid, ndays) {
    ndays = ndays || 1;
    var params = [
      'secid=' + secid, 'ndays=' + ndays,
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
        if (!line || typeof line !== 'string') return null;
        var f = line.split(',');
        if (!f || f.length < 4) return null;
        return { time: f[0], close: Number(f[1]), avg: 0, volume: Number(f[2]), amount: Number(f[3]) };
      }).filter(Boolean);

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
   * fetchSnapshot — 单只股票盘口快照
   */
  API.fetchSnapshot = async function (secid) {
    if (!secid) throw new Error('Invalid secid');
    try {
      var d = await emQuote(secid, 12000);
      if (!d) throw new Error('No snapshot data');
      var s = normalizeEm(d);
      if (!s) throw new Error('Failed to normalize snapshot');
      return {
        code: s.code, name: s.name, market: s.market, secid: s.secid,
        price: s.price, open: s.open, preClose: s.preClose,
        high: s.high, low: s.low,
        chg: s.chg, chgPct: s.chgPct,
        volume: s.volume, amount: s.amount,
        turnover: s.turnover, amplitude: s.amplitude,
        pe: s.pe, pb: s.pb, volRatio: s.volRatio,
        mktCap: s.mktCap, floatCap: s.floatCap,
        bids: s.bids, asks: s.asks,
        limitUp: s.limitUp, limitDown: s.limitDown,
        chg60: null, chgYtd: null, mainNet: null, peTtm: null, speed: null,
        avg: null,
        time: new Date().toTimeString().slice(0, 8),
        _source: 'em'
      };
    } catch (e) {
      API.lastError = 'Snapshot fetch failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchIndex — 三大指数 + 沪深300
   * 东方财富指数 secid：1.000001(上证), 0.399001(深证), 0.399006(创业板), 1.000300(沪深300)
   */
  API.fetchIndex = async function () {
    var idxSecids = ['1.000001', '0.399001', '0.399006', '1.000300'];
    var idxNames  = { '1.000001': '上证指数', '0.399001': '深证成指', '0.399006': '创业板指', '1.000300': '沪深300' };

    try {
      var promises = idxSecids.map(function (sid) { return emQuote(sid, 8000); });
      var rawList = await Promise.all(promises);
      var results = [];
      for (var i = 0; i < rawList.length; i++) {
        var d = rawList[i];
        if (!d) continue;
        results.push({
          name:    d.f58 || idxNames[idxSecids[i]] || idxSecids[i],
          price:   (d.f43 != null) ? d.f43 / 100 : null,
          chg:     (d.f169 != null) ? d.f169 / 100 : 0,
          chgPct:  (d.f170 != null) ? d.f170 / 100 : 0,
          volume:  (d.f47  != null) ? d.f47 : 0,
          amount:  (d.f48  != null) ? d.f48 : 0
        });
      }
      return results;
    } catch (e) {
      API.lastError = 'Index fetch failed: ' + e.message;
      throw e;
    }
  };

  /* ============ 工具函数 ============ */
  function sleep(ms) { return new Promise(function (r) { return setTimeout(r, ms); }); }

  global.API = API;
})(window);
