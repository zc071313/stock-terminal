/* ============================================================
   api.js — 实时行情数据层（data/quotes.json 静态源）
   行情数据由 GitHub Actions 每 30s 从东方财富抓取并写入 data/quotes.json
   前端直接 fetch 本地 JSON（同域无跨域），K线/分时仍走东方财富 JSONP
   ============================================================ */
(function (global) {
  'use strict';

  var API = { mode: 'connecting', lastError: '' };

  /* ============ 常量 ============ */
  var QUOTES_URL     = 'data/quotes.json';
  var QUOTES_MAX_AGE = 120;  // 超过 120 秒未更新 → 降级 mock

  var EM_KLINE  = 'https://push2.eastmoney.com/api/qt/stock/kline/get';
  var EM_TREND  = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
  var EM_UT     = 'fa5fd1943c7b386f172d6893dbf28df9';

  API.FS_MAIN = { type: 'main', desc: '沪深主板' };
  API.FS_ALL  = { type: 'all',  desc: '全市场' };

  /* ============ 行情缓存 ============ */
  var quotesCache = null;       // { updated, total, list, indexes }
  var quotesFetching = false;
  var quotesPromise = null;

  /**
   * loadQuotesCache — 加载 data/quotes.json
   * 带缓存：同一次页面生命周期内只请求一次 JSON 文件
   */
  function loadQuotesCache() {
    if (quotesCache) return Promise.resolve(quotesCache);
    if (quotesFetching && quotesPromise) return quotesPromise;

    quotesFetching = true;
    quotesPromise = fetch(QUOTES_URL + '?v=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.list && Array.isArray(data.list)) {
          quotesCache = data;
          return data;
        }
        throw new Error('Invalid quotes.json structure');
      })
      .catch(function (e) {
        API.lastError = 'Failed to load quotes.json: ' + e.message;
        throw e;
      })
      .finally(function () {
        quotesFetching = false;
      });

    return quotesPromise;
  }

  /* ============ JSONP（K线/分时用） ============ */
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

  /* ============ API 方法 ============ */

  /**
   * probe — 检查 quotes.json 是否存在且未过期
   * 过期阈值：QUOTES_MAX_AGE 秒（默认 120 秒）
   * 成功 → mode='live'，失败/过期 → mode='mock'
   */
  API.probe = async function () {
    try {
      var data = await loadQuotesCache();
      if (data && typeof data.updated === 'number') {
        var now = Math.floor(Date.now() / 1000);
        var age = now - data.updated;
        if (age <= QUOTES_MAX_AGE) {
          API.mode = 'live';
          API.dataSource = 'em';
          return true;
        }
        API.mode = 'mock';
        API.dataSource = 'mock';
        API.lastError = 'Quotes data expired (age=' + age + 's, max=' + QUOTES_MAX_AGE + 's)';
        return false;
      }
    } catch (e) {
      // fall through to mock
    }
    API.mode = 'mock';
    API.dataSource = 'mock';
    API.lastError = 'quotes.json unavailable or invalid';
    return false;
  };

  /**
   * fetchAll — 读取全量行情快照（不区分主板/全市场，返回全部）
   */
  API.fetchAll = async function (fs, onProgress, onBatch) {
    var data = await loadQuotesCache();
    var list = data.list || [];
    var cb = onBatch || onProgress;
    if (cb) {
      cb({ list: list, total: list.length }, list.length, list.length);
    }
    return { total: list.length, list: list };
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

    var data = await loadQuotesCache();
    var list = (data.list || []).slice();

    var keyMap = {
      'f3': 'chgPct', 'f6': 'amount', 'f8': 'turnover',
      'f10': 'volRatio', 'f20': 'mktCap', 'f2': 'price', 'f9': 'pe'
    };
    var sortKey = keyMap[fid] || 'chgPct';

    list.sort(function (a, b) {
      var va = a[sortKey] != null ? a[sortKey] : -Infinity;
      var vb = b[sortKey] != null ? b[sortKey] : -Infinity;
      return po === 1 ? vb - va : va - vb;
    });

    var total = list.length;
    var start = pn * pz;
    var page = list.slice(start, start + pz);

    return { total: total, list: page };
  };

  /**
   * fetchByCodes — 按 secid 数组查询（自选刷新）
   */
  API.fetchByCodes = async function (secids) {
    if (!secids || !secids.length) return [];
    var data = await loadQuotesCache();
    var set = Object.create(null);
    for (var i = 0; i < secids.length; i++) { set[secids[i]] = true; }
    return (data.list || []).filter(function (s) { return set[s.secid]; });
  };

  /**
   * fetchKline — K线（东方财富 JSONP，不变）
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
   * fetchTrends — 分时图（东方财富 JSONP，不变）
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
    var data = await loadQuotesCache();
    var snap = null;
    var list = data.list || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].secid === secid) { snap = list[i]; break; }
    }
    if (!snap) throw new Error('Snapshot not found: ' + secid);
    return {
      code: snap.code, name: snap.name, market: snap.market, secid: snap.secid,
      price: snap.price, open: snap.open, preClose: snap.preClose,
      high: snap.high, low: snap.low,
      chg: snap.chg, chgPct: snap.chgPct,
      volume: snap.volume, amount: snap.amount,
      turnover: snap.turnover, amplitude: snap.amplitude,
      pe: snap.pe, pb: snap.pb, volRatio: snap.volRatio,
      mktCap: snap.mktCap, floatCap: snap.floatCap,
      bids: snap.bids || [], asks: snap.asks || [],
      limitUp: snap.limitUp, limitDown: snap.limitDown,
      chg60: null, chgYtd: null, mainNet: null, peTtm: null, speed: null,
      avg: null,
      time: new Date().toTimeString().slice(0, 8),
      _source: 'em'
    };
  };

  /**
   * fetchIndex — 三大指数 + 沪深300
   */
  API.fetchIndex = async function () {
    var data = await loadQuotesCache();
    return (data.indexes || []).slice();
  };

  global.API = API;
})(window);
