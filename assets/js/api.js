/* ============================================================
   api.js — 实时行情数据层（腾讯 qt.gtimg.cn 主源 + 东财 K线/分时）
   数据源：腾讯 qt.gtimg.cn（行情报价） + 东方财富（K线/分时）
   协议：script 注入（腾讯）+ JSONP（东财），全 HTTPS，适配 GitHub Pages
   ============================================================ */
(function (global) {
  'use strict';

  var API = { mode: 'connecting', lastError: '' };

  /* ============ 常量 ============ */
  var QT_BASE   = 'https://qt.gtimg.cn/q=';
  var EM_KLINE  = 'https://push2.eastmoney.com/api/qt/stock/kline/get';
  var EM_TREND  = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
  var EM_UT     = 'fa5fd1943c7b386f172d6893dbf28df9';

  API.FS_MAIN = { type: 'main', desc: '沪深主板' };
  API.FS_ALL  = { type: 'all',  desc: '全市场' };

  /* ============ JSONP（仅用于东财 K线/分时） ============ */
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

  /* ============ 腾讯行情 — script 注入（非标准 JSONP） ============ */
  /**
   * 腾讯 qt.gtimg.cn 批量行情
   * 返回格式：每只股票一行 v_shXXXXXX="f0~f1~f2~..."
   * 加载后读取全局变量 v_shXXXXXX，解析完立刻 delete 避免污染
   */
  function qtQuote(codes) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('QT timeout')); script.remove(); }, 15000);
      script.src = QT_BASE + codes.join(',');
      script.charset = 'gbk';
      script.onload = function () {
        clearTimeout(timer);
        var results = {};
        codes.forEach(function (c) {
          var vn = 'v_' + c;
          if (global[vn] !== undefined) {
            results[c] = String(global[vn]);
            delete global[vn];
          }
        });
        // 兜底：腾讯可能返回 v_s_xxx 前缀的变量
        codes.forEach(function (c) {
          var alt = 'v_s_' + c;
          if (global[alt] !== undefined && results[c] === undefined) {
            results[c] = String(global[alt]);
            delete global[alt];
          }
        });
        script.remove();
        resolve(results);
      };
      script.onerror = function () {
        clearTimeout(timer);
        script.remove();
        reject(new Error('QT network error'));
      };
      document.head.appendChild(script);
    });
  }

  /* ============ 代码转换 ============ */
  function getUniverse() {
    return (typeof MOCK_STOCKS !== 'undefined' && Array.isArray(MOCK_STOCKS)) ? MOCK_STOCKS : [];
  }

  // secid "1.600519" → 腾讯 "sh600519"
  function secidToQt(secid) {
    if (!secid || typeof secid !== 'string') return null;
    var p = secid.split('.');
    if (!p || p.length < 2) return null;
    return (p[0] === '1' ? 'sh' : 'sz') + p[1];
  }

  function getUniverseQtCodes() {
    return getUniverse().map(function (s) {
      if (!s || !s.code) return null;
      return (s.market === 1 ? 'sh' : 'sz') + s.code;
    }).filter(Boolean);
  }

  /* ============ normalize：腾讯 ~ 分割字符串 → 统一快照 ============ */
  /**
   * 腾讯字段（v_shXXXXXX="f0~f1~f2~..."）
   *   0:市场(1沪/51深)  1:名称  2:代码  3:最新价  4:昨收  5:今开
   *   6:成交量(手)  7:外盘  8:内盘
   *   9/11/13/15/17: 买1-5价   10/12/14/16/18: 买1-5量
   *  19/21/23/25/27: 卖1-5价   20/22/24/26/28: 卖1-5量
   *  29:空  30:时间  31:涨跌额  32:涨跌幅  33:最高  34:最低
   *  35:成交量(手)  36:成交额(万)  37:换手率  38:市盈率(动)
   *  39:空  40:最高  41:最低  42:振幅  43:流通市值(亿)  44:总市值(亿)
   *  45:市净率  46:涨停价  47:跌停价  48:量比  49:委差
   */
  function normalizeQt(qtCode, raw) {
    if (!raw || raw === '') return null;
    var match = raw.match(/^"(.+)"$/);
    if (!match) return null;
    var f = match[1].split('~');
    if (f.length < 47) return null;

    var code = f[2];
    var market = f[0] === '1' ? 1 : 0;
    var price = num(f[3]);
    var preClose = num(f[4]);
    if (!price || price <= 0) return null;

    return {
      code: code, name: f[1], market: market, secid: market + '.' + code,
      price: price, open: num(f[5]), preClose: preClose, high: num(f[33]), low: num(f[34]),
      chg: num(f[31]), chgPct: num(f[32]),
      volume: (num(f[6]) || 0) * 100,
      amount: (num(f[36]) || 0) * 10000,   // 万 → 元
      amplitude: num(f[42]),
      turnover: num(f[37]),
      pe: num(f[38]),
      pb: num(f[45]),
      volRatio: num(f[48]),
      mktCap: num(f[44]) != null ? num(f[44]) * 1e8 : null,   // 亿 → 元
      floatCap: num(f[43]) != null ? num(f[43]) * 1e8 : null,
      // 买卖五档
      bids: [
        { price: num(f[9]),  volume: num(f[10]) },
        { price: num(f[11]), volume: num(f[12]) },
        { price: num(f[13]), volume: num(f[14]) },
        { price: num(f[15]), volume: num(f[16]) },
        { price: num(f[17]), volume: num(f[18]) }
      ].filter(function (b) { return b.price > 0; }),
      asks: [
        { price: num(f[19]), volume: num(f[20]) },
        { price: num(f[21]), volume: num(f[22]) },
        { price: num(f[23]), volume: num(f[24]) },
        { price: num(f[25]), volume: num(f[26]) },
        { price: num(f[27]), volume: num(f[28]) }
      ].filter(function (b) { return b.price > 0; }),
      // 涨跌停
      limitUp: num(f[46]),
      limitDown: num(f[47]),
      chg60: null, chgYtd: null, mainNet: null, peTtm: null, speed: null,
      _source: 'qt'
    };
  }

  /* ============ 批量拉取辅助 ============ */
  /** 分批 qtQuote，返回全部快照数组 */
  async function batchQtQuote(codes, onBatch) {
    var all = [];
    var total = codes.length;
    for (var i = 0; i < codes.length; i += 200) {
      var batch = codes.slice(i, i + 200);
      try {
        var raw = await qtQuote(batch);
        codes.forEach(function (c) {
          var s = normalizeQt(c, raw[c]);
          if (s) all.push(s);
        });
      } catch (e) { /* 单批失败跳过 */ }
      if (onBatch) {
        var done = Math.min(i + 200, total);
        onBatch({ list: all, total: total }, done, total);
      }
    }
    return all;
  }

  /* ============ API 方法 ============ */

  /**
   * probe — 连通性探测
   * 用腾讯 qt.gtimg.cn 请求上证指数（始终有数据），2 次重试
   */
  API.probe = async function (attempts) {
    attempts = attempts || 2;
    for (var i = 0; i < attempts; i++) {
      try {
        var raw = await qtQuote(['sh000001']);
        if (raw && raw.sh000001 && raw.sh000001 !== '') {
          API.mode = 'live';
          return true;
        }
      } catch (e) {
        if (i < attempts - 1) await sleep(800);
      }
    }
    API.mode = 'mock';
    API.lastError = 'Tencent qt.gtimg.cn unreachable';
    return false;
  };

  /**
   * fetchAll — 渐进式拉取全量股票
   * 分批拉取腾讯行情，每批抵达即回调
   */
  API.fetchAll = async function (fs, onProgress, onBatch) {
    var codes = getUniverseQtCodes();
    if (!codes.length) throw new Error('No stock codes');

    var all = await batchQtQuote(codes, onBatch || onProgress);
    return { total: all.length, list: all };
  };

  /**
   * fetchList — 分页/排序列表
   * 拉取全量 → 客户端排序 → 分页返回
   */
  API.fetchList = async function (opt) {
    opt = opt || {};
    var pn = opt.pn || 0;
    var pz = opt.pz || 50;
    var fid = opt.fid || 'f3';
    var po  = opt.po != null ? opt.po : 1;

    var codes = getUniverseQtCodes();
    if (!codes.length) throw new Error('No stock codes');

    var all = await batchQtQuote(codes);

    // 排序字段映射
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
    var codes = secids.map(secidToQt).filter(Boolean);
    if (!codes.length) return [];
    return await batchQtQuote(codes);
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
   * 直接用 normalizeQt 获取，含五档买卖 + 涨跌停价
   */
  API.fetchSnapshot = async function (secid) {
    var qtCode = secidToQt(secid);
    if (!qtCode) throw new Error('Invalid secid: ' + secid);
    try {
      var raw = await qtQuote([qtCode]);
      var s = normalizeQt(qtCode, raw[qtCode]);
      if (!s) throw new Error('No snapshot data');
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
        _source: 'qt'
      };
    } catch (e) {
      API.lastError = 'Snapshot fetch failed: ' + e.message;
      throw e;
    }
  };

  /**
   * fetchIndex — 三大指数 + 沪深300
   * 腾讯指数代码与股票相同格式：sh000001, sz399001, sz399006, sh000300
   */
  API.fetchIndex = async function () {
    var idxCodes = ['sh000001', 'sz399001', 'sz399006', 'sh000300'];
    var idxNames = { sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指', sh000300: '沪深300' };

    try {
      var raw = await qtQuote(idxCodes);
      var results = [];
      idxCodes.forEach(function (ic) {
        var r = raw[ic];
        if (!r || r === '') return;
        var f;
        var match = r.match(/^"(.+)"$/);
        if (match) f = match[1].split('~');
        if (!f || f.length < 6) return;
        results.push({
          name: f[1] || idxNames[ic] || ic,
          price: num(f[3]),
          chg: num(f[31]) || 0,
          chgPct: num(f[32]) || 0,
          volume: num(f[6]) || 0,
          amount: num(f[36]) || 0
        });
      });
      return results;
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
