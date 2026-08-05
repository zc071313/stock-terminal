/* ============================================================
   api.js — 行情数据层
   数据源：东方财富券商行情网关（push2 / push2his），JSONP 直连，
           无需后端代理，file:// 双击打开亦可取到实时数据。
   失败时自动降级到内置行情模拟引擎（Mock），保证界面可用。
   ============================================================ */
(function (global) {
  'use strict';

  const API = {
    /** 数据源状态：live | mock | connecting */
    mode: 'connecting',
    lastError: '',
    UT: 'fa5fd1943c7b386f172d6893dbfba10b'
  };

  let jsonpSeq = 0;

  /** JSONP 请求（绕过跨域，file:// 下同样有效） */
  function jsonp(url, timeout) {
    return new Promise((resolve, reject) => {
      const cb = 'zcjp_' + (++jsonpSeq) + '_' + Date.now().toString(36);
      const script = document.createElement('script');
      let timer = null;

      function cleanup() {
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      global[cb] = function (data) { cleanup(); resolve(data); };

      timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout || 12000);

      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + cb + '&_=' + Date.now();
      script.onerror = function () { cleanup(); reject(new Error('网络错误')); };
      document.head.appendChild(script);
    });
  }

  API.jsonp = jsonp;

  /* ---------------- 市场范围 ---------------- */
  // m:1+t:2  沪市主板 | m:0+t:6  深市主板(含原中小板)
  // m:1+t:23 科创板   | m:0+t:80 创业板 | m:0+t:81+s:2048 北交所
  const FS_MAIN = 'm:1+t:2,m:0+t:6';
  const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  API.FS_MAIN = FS_MAIN;
  API.FS_ALL = FS_ALL;

  const LIST_FIELDS = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f23,f24,f25,f62,f115';

  function num(v) {
    if (v === '-' || v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return isFinite(x) ? x : null;
  }

  /** 把东财原始行 -> 标准股票对象 */
  function normalize(d) {
    const market = d.f13 === 1 ? 1 : 0;   // 1=沪 0=深
    return {
      code: d.f12,
      name: d.f14,
      market: market,
      secid: market + '.' + d.f12,
      price: num(d.f2),
      chgPct: num(d.f3),
      chg: num(d.f4),
      volume: num(d.f5),        // 手
      amount: num(d.f6),        // 元
      amplitude: num(d.f7),     // %
      turnover: num(d.f8),      // 换手率 %
      pe: num(d.f9),            // 市盈率(动)
      volRatio: num(d.f10),     // 量比
      high: num(d.f15),
      low: num(d.f16),
      open: num(d.f17),
      preClose: num(d.f18),
      mktCap: num(d.f20),       // 总市值
      floatCap: num(d.f21),     // 流通市值
      speed: num(d.f22),        // 涨速
      pb: num(d.f23),
      chg60: num(d.f24),        // 60日涨跌幅
      chgYtd: num(d.f25),       // 年初至今
      mainNet: num(d.f62),      // 主力净流入
      peTtm: num(d.f115)
    };
  }
  API.normalize = normalize;

  /* ---------------- 全市场快照 ---------------- */
  /**
   * 拉取行情列表
   * @param {object} opt {fs, fid, po, pn, pz}
   */
  API.fetchList = async function (opt) {
    opt = opt || {};
    const url = 'https://push2.eastmoney.com/api/qt/clist/get'
      + '?pn=' + (opt.pn || 1)
      + '&pz=' + (opt.pz || 100)
      + '&po=' + (opt.po === undefined ? 1 : opt.po)
      + '&np=1&fltt=2&invt=2&dect=1'
      + '&ut=' + API.UT
      + '&fid=' + (opt.fid || 'f3')
      + '&fs=' + encodeURIComponent(opt.fs || FS_MAIN)
      + '&fields=' + LIST_FIELDS;
    const res = await jsonp(url);
    if (!res || !res.data || !res.data.diff) throw new Error('数据为空');
    const diff = Array.isArray(res.data.diff) ? res.data.diff : Object.values(res.data.diff);
    return { total: res.data.total, list: diff.map(normalize) };
  };

  /**
   * 拉取全市场（渐进式分页并发）
   * 注意：东财网关对单页条数有硬上限 100，pz 设更大也只返回 100 条，
   *       因此必须分页拉取。首批到达即可回调渲染，其余在后台补齐。
   * @param {string} fs         板块范围
   * @param {function} onProgress (done, totalPages)
   * @param {function} onBatch    (partialList, done, totalPages) 每批到达时回调
   */
  const PAGE_SIZE = 100;

  API.fetchAll = async function (fs, onProgress, onBatch) {
    const first = await API.fetchList({ fs: fs, pz: PAGE_SIZE, pn: 1, fid: 'f3' });
    const total = first.total || first.list.length;
    const pages = Math.min(Math.ceil(total / PAGE_SIZE), 80); // 防御：最多 8000 只
    const seen = new Set();
    const all = [];
    push(first.list);

    if (onProgress) onProgress(1, pages);
    if (onBatch) onBatch(all, 1, pages);
    if (pages <= 1) return all;

    const rest = [];
    for (let p = 2; p <= pages; p++) rest.push(p);
    let done = 1;

    await U.pool(rest, 5, async (p) => {
      let r = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try { r = await API.fetchList({ fs: fs, pz: PAGE_SIZE, pn: p, fid: 'f3' }); }
        catch (e) { if (attempt === 1) return null; }
      }
      if (r) push(r.list);
      done++;
      if (onProgress) onProgress(done, pages);
      if (onBatch) onBatch(all, done, pages);
      return null;
    });

    return all;

    function push(list) {
      list.forEach(s => {
        if (s && s.code && !seen.has(s.code)) { seen.add(s.code); all.push(s); }
      });
    }
  };

  /**
   * 按 secid 批量拉取（用于自选股轻量刷新，一次请求搞定）
   * @param {Array<string>} secids ["1.600519","0.000001"]
   */
  API.fetchByCodes = async function (secids) {
    if (!secids || !secids.length) return [];
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
      + '?ut=' + API.UT + '&fltt=2&invt=2&dect=1'
      + '&fields=' + LIST_FIELDS
      + '&secids=' + secids.slice(0, 100).join(',');
    const res = await jsonp(url);
    if (!res || !res.data || !res.data.diff) return [];
    const diff = Array.isArray(res.data.diff) ? res.data.diff : Object.values(res.data.diff);
    return diff.filter(d => d && d.f12).map(normalize);
  };

  /* ---------------- K线 ---------------- */
  // 东财历史行情有多个负载子域，单域限流时自动切换，提高批量拉K线的成功率
  const KLINE_HOSTS = [
    'push2his.eastmoney.com',
    '1.push2his.eastmoney.com',
    '63.push2his.eastmoney.com',
    'push2.eastmoney.com'
  ];
  let hostIdx = 0;   // 记忆当前可用域名

  function klineUrl(host, secid, klt, fqt, lmt) {
    return 'https://' + host + '/api/qt/stock/kline/get'
      + '?secid=' + secid
      + '&ut=' + API.UT
      + '&fields1=f1,f2,f3,f4,f5,f6'
      + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
      + '&klt=' + (klt || 101)
      + '&fqt=' + (fqt === undefined ? 1 : fqt)
      + '&end=20500101'
      + '&lmt=' + (lmt || 400);
  }

  function parseKlines(res) {
    if (!res || !res.data || !res.data.klines || !res.data.klines.length) return null;
    // 日期,开,收,高,低,成交量(手),成交额,振幅,涨跌幅,涨跌额,换手率
    return res.data.klines.map(s => {
      const a = s.split(',');
      return {
        date: a[0],
        open: +a[1], close: +a[2], high: +a[3], low: +a[4],
        volume: +a[5], amount: +a[6],
        amplitude: +a[7], chgPct: +a[8], chg: +a[9], turnover: +a[10]
      };
    });
  }

  /** 合并 K 线（用于 2小时/4小时 等合成周期，按 g 根一组） */
  function aggregateKlines(bars, g) {
    const out = [];
    for (let i = 0; i < bars.length; i += g) {
      const grp = bars.slice(i, i + g);
      if (!grp.length) continue;
      const o = grp[0].open, c = grp[grp.length - 1].close;
      const h = Math.max.apply(null, grp.map(b => b.high));
      const l = Math.min.apply(null, grp.map(b => b.low));
      const v = grp.reduce((s, b) => s + (b.volume || 0), 0);
      const a = grp.reduce((s, b) => s + (b.amount || 0), 0);
      const start = grp[0].date, end = grp[grp.length - 1].date;
      const pc = out.length ? out[out.length - 1].close : grp[0].open;
      out.push({
        date: start + '~' + end.slice(11), open: o, close: c, high: h, low: l,
        volume: v, amount: a,
        amplitude: +(((h - l) / (pc || o)) * 100).toFixed(2),
        chgPct: +(((c - pc) / (pc || o)) * 100).toFixed(2),
        chg: +(c - pc).toFixed(2),
        turnover: +(grp.reduce((s, b) => s + (b.turnover || 0), 0) / grp.length).toFixed(2)
      });
    }
    return out;
  }

  /**
   * @param {string} secid  形如 "1.600519"
   * @param {number} klt    101日 102周 103月 5/15/30/60 分钟；120=2小时 240=4小时（合成）
   * @param {number} fqt    0不复权 1前复权 2后复权
   * @param {number} lmt    根数
   */
  async function fetchKlineOnce(secid, klt, fqt, lmt) {
    // 2小时 / 4小时：底层取 60分K线再做合并
    let baseKlt = klt, group = 1, need = lmt || (klt >= 101 ? 400 : 300);
    if (klt === 120) { baseKlt = 60; group = 2; need = (lmt || 300) * 2; }
    else if (klt === 240) { baseKlt = 60; group = 4; need = (lmt || 300) * 4; }

    const fetchOnce = async (host) => {
      const r = await jsonp(klineUrl(host, secid, baseKlt, fqt, need), 8000);
      const k = parseKlines(r);
      if (!k) throw new Error('空');
      return group > 1 ? aggregateKlines(k, group) : k;
    };

    // 1) 先试记忆中的可用域名
    try {
      const k = await fetchOnce(KLINE_HOSTS[hostIdx]);
      if (k) return k;
    } catch (e) { /* 继续容灾 */ }

    // 2) 并行竞速其余域名，谁先成功用谁（成功后记住该域）
    const others = KLINE_HOSTS.filter((_, i) => i !== hostIdx);
    const race = others.map(h => fetchOnce(h).then(k => { hostIdx = KLINE_HOSTS.indexOf(h); return k; }));
    return anyOf(race);
  }

  API.fetchKline = async function (secid, klt, fqt, lmt) {
    let lastErr = null;
    // 一轮多域名竞速仍可能因限流全失败，退避后重试一轮（hostIdx 已轮换）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const k = await fetchKlineOnce(secid, klt, fqt, lmt);
        if (k && k.length) return k;
      } catch (e) { lastErr = e; }
      if (attempt < 1) await new Promise(r => setTimeout(r, 700));
    }
    throw new Error('K线数据为空（网关限流或该标的无数据）');
  };

  /** Promise.any 的兼容实现：任一成功即返回，全部失败才 reject */
  function anyOf(promises) {
    return new Promise((resolve, reject) => {
      let pending = promises.length;
      if (!pending) return reject(new Error('无候选'));
      promises.forEach(p => p.then(resolve, () => { if (--pending === 0) reject(new Error('全部失败')); }));
    });
  }

  /* ---------------- 分时 ---------------- */
  API.fetchTrends = async function (secid, ndays) {
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get'
      + '?secid=' + secid
      + '&ut=' + API.UT
      + '&fields1=f1,f2,f3,f4,f5,f6,f7,f8'
      + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
      + '&iscr=0&iscca=0&ndays=' + (ndays || 1);
    const res = await jsonp(url);
    if (!res || !res.data || !res.data.trends) throw new Error('分时数据为空');
    // 时间,开,收,高,低,成交量,成交额,均价
    const rows = res.data.trends.map(s => {
      const a = s.split(',');
      return {
        time: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4],
        volume: +a[5], amount: +a[6], avg: +a[7]
      };
    });
    return { preClose: res.data.preClose, name: res.data.name, code: res.data.code, rows: rows };
  };

  /* ---------------- 个股快照 + 五档盘口 ---------------- */
  const SNAP_FIELDS = [
    'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f49', 'f50', 'f51', 'f52', 'f57', 'f58', 'f59', 'f60',
    'f71', 'f84', 'f85', 'f86', 'f116', 'f117', 'f162', 'f167', 'f168', 'f169', 'f170', 'f171', 'f177',
    'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'f20',
    'f31', 'f32', 'f33', 'f34', 'f35', 'f36', 'f37', 'f38', 'f39', 'f40', 'f191', 'f192'
  ].join(',');

  API.fetchSnapshot = async function (secid) {
    const url = 'https://push2.eastmoney.com/api/qt/stock/get'
      + '?secid=' + secid + '&ut=' + API.UT + '&fields=' + SNAP_FIELDS + '&invt=2&fltt=1';
    const res = await jsonp(url);
    if (!res || !res.data) throw new Error('快照为空');
    const d = res.data;
    const dec = d.f59 === undefined ? 2 : d.f59;
    const s = Math.pow(10, dec);
    const p = v => (v === '-' || v === null || v === undefined || v === 0 && v !== 0) ? null : (num(v) === null ? null : num(v) / s);
    const p2 = v => num(v) === null ? null : num(v) / 100;

    return {
      code: d.f57, name: d.f58, decimal: dec,
      price: p(d.f43), high: p(d.f44), low: p(d.f45), open: p(d.f46),
      volume: num(d.f47), amount: num(d.f48), outer: num(d.f49),
      volRatio: p2(d.f50), limitUp: p(d.f51), limitDown: p(d.f52),
      preClose: p(d.f60), avg: p(d.f71),
      totalShare: num(d.f84), floatShare: num(d.f85),
      mktCap: num(d.f116), floatCap: num(d.f117),
      pe: p2(d.f162), pb: p2(d.f167), turnover: p2(d.f168),
      chg: p(d.f169), chgPct: p2(d.f170), amplitude: p2(d.f171),
      peTtm: p2(d.f164),
      // 五档：买 1..5 = f19/f17/f15/f13/f11（价） f20/f18/f16/f14/f12（量）
      bids: [
        { p: p(d.f19), v: num(d.f20) }, { p: p(d.f17), v: num(d.f18) },
        { p: p(d.f15), v: num(d.f16) }, { p: p(d.f13), v: num(d.f14) },
        { p: p(d.f11), v: num(d.f12) }
      ],
      // 卖 1..5 = f39/f37/f35/f33/f31
      asks: [
        { p: p(d.f39), v: num(d.f40) }, { p: p(d.f37), v: num(d.f38) },
        { p: p(d.f35), v: num(d.f36) }, { p: p(d.f33), v: num(d.f34) },
        { p: p(d.f31), v: num(d.f32) }
      ]
    };
  };

  /* ---------------- 指数（用于顶部/兜底判断） ---------------- */
  API.fetchIndex = async function () {
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
      + '?ut=' + API.UT + '&fltt=2&invt=2&fields=f1,f2,f3,f4,f12,f13,f14'
      + '&secids=1.000001,0.399001,0.399006,1.000300';
    const res = await jsonp(url, 8000);
    if (!res || !res.data || !res.data.diff) throw new Error('指数为空');
    const diff = Array.isArray(res.data.diff) ? res.data.diff : Object.values(res.data.diff);
    return diff.map(d => ({ code: d.f12, name: d.f14, price: num(d.f2), chgPct: num(d.f3), chg: num(d.f4) }));
  };

  /** 连通性探测（带重试：东财网关偶发限流一次失败不应让整站掉进 mock） */
  API.probe = async function (attempts) {
    attempts = attempts || 3;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await API.fetchList({ pz: 1, pn: 1 });
        API.mode = 'live';
        return true;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 600));
      }
    }
    API.mode = 'mock';
    API.lastError = (lastErr && lastErr.message) || String(lastErr);
    return false;
  };

  global.API = API;
})(window);
