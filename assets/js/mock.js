/* ============================================================
   mock.js — 离线行情模拟引擎
   当外网行情网关不可达（断网 / 内网 / 接口变更）时接管，
   生成结构完全一致的行情数据，保证软件功能可完整演示。
   ============================================================ */
(function (global) {
  'use strict';

  const MOCK = {};

  const SH_PREFIX = ['600', '601', '603', '605'];
  const SZ_PREFIX = ['000', '001', '002', '003'];

  const WORDS_A = ['华', '中', '大', '东', '南', '西', '北', '金', '天', '海', '万', '新', '国', '长', '广', '浙', '苏', '皖', '鲁', '湘'];
  const WORDS_B = ['科', '能', '电', '通', '医', '药', '钢', '材', '化', '农', '光', '汽', '机', '智', '数', '云', '港', '航', '建', '融'];
  const WORDS_C = ['股份', '科技', '集团', '实业', '控股', '发展', '电子', '生物', '能源', '装备', '智能', '材料', '传媒', '物流', '重工'];
  const INDUSTRIES = ['半导体', '电力设备', '医药生物', '食品饮料', '银行', '有色金属', '汽车零部件', '计算机', '化工', '机械设备', '房地产', '通信', '家用电器', '农林牧渔', '公用事业', '交通运输', '建筑材料', '国防军工'];

  /** 稳定伪随机（同一 seed 每次结果一致） */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  let CACHE = null;

  /** 生成全市场主板股票池 */
  MOCK.universe = function (count) {
    if (CACHE) return CACHE;
    count = count || 1200;

    // 如果页面引入了真实股票名单（mock_stocks.js），优先使用真实代码/名称，
    // 让离线模式下的搜索也能命中真实股票。
    const realStocks = global.MOCK_STOCKS || [];
    if (realStocks.length) {
      const list = realStocks.slice(0, Math.min(count, realStocks.length)).map(s => {
        const rnd = mulberry32(hashCode(s.code));
        return buildStock(s.code, s.name, s.market, rnd);
      });
      CACHE = list;
      return list;
    }

    const rnd = mulberry32(20260805);
    const list = [];
    const used = new Set();

    for (let i = 0; i < count; i++) {
      const isSH = rnd() < 0.52;
      const pre = isSH ? SH_PREFIX[Math.floor(rnd() * SH_PREFIX.length)] : SZ_PREFIX[Math.floor(rnd() * SZ_PREFIX.length)];
      let code;
      do { code = pre + String(Math.floor(rnd() * 1000)).padStart(3, '0'); } while (used.has(code));
      used.add(code);

      const name = WORDS_A[Math.floor(rnd() * WORDS_A.length)]
        + WORDS_B[Math.floor(rnd() * WORDS_B.length)]
        + (rnd() < 0.45 ? WORDS_C[Math.floor(rnd() * WORDS_C.length)] : '');

      list.push(buildStock(code, name, isSH ? 1 : 0, rnd));
    }
    CACHE = list;
    return list;
  };

  /** 构造一只模拟股票（价格/指标按 rnd 生成） */
  function buildStock(code, name, market, rnd) {
    const base = 2 + Math.pow(rnd(), 2.4) * 78;              // 价格分布偏低价
    const chgPct = (rnd() + rnd() + rnd() - 1.5) * 4.2;      // 近似正态
    const chgClamped = Math.max(-10, Math.min(10, chgPct));
    const price = +(base * (1 + chgClamped / 100)).toFixed(2);
    const preClose = +(price / (1 + chgClamped / 100)).toFixed(2);
    const amplitude = Math.abs(chgClamped) + rnd() * 3.4;
    const high = +(Math.max(price, preClose) * (1 + rnd() * amplitude / 240)).toFixed(2);
    const low = +(Math.min(price, preClose) * (1 - rnd() * amplitude / 240)).toFixed(2);
    const open = +(preClose * (1 + (rnd() - 0.5) * amplitude / 90)).toFixed(2);
    const floatShare = (0.6 + Math.pow(rnd(), 2) * 42) * 1e8;
    const turnover = +(0.3 + Math.pow(rnd(), 1.7) * 13).toFixed(2);
    const volume = Math.round(floatShare * turnover / 100 / 100);
    const amount = Math.round(volume * 100 * price);
    const totalShare = floatShare * (1 + rnd() * 0.9);

    return {
      code: code,
      name: name,
      market: market,
      secid: market + '.' + code,
      price: price,
      chgPct: +chgClamped.toFixed(2),
      chg: +(price - preClose).toFixed(2),
      volume: volume,
      amount: amount,
      amplitude: +amplitude.toFixed(2),
      turnover: turnover,
      pe: rnd() < 0.12 ? -(rnd() * 60).toFixed(2) * 1 : +(5 + Math.pow(rnd(), 2) * 110).toFixed(2),
      volRatio: +(0.3 + Math.pow(rnd(), 1.5) * 3.6).toFixed(2),
      high: high, low: low, open: open, preClose: preClose,
      mktCap: Math.round(totalShare * price),
      floatCap: Math.round(floatShare * price),
      speed: +((rnd() - 0.5) * 1.6).toFixed(2),
      pb: +(0.4 + Math.pow(rnd(), 1.8) * 8).toFixed(2),
      chg60: +((rnd() + rnd() - 1.05) * 42).toFixed(2),
      chgYtd: +((rnd() + rnd() - 1) * 60).toFixed(2),
      mainNet: Math.round((rnd() - 0.48) * amount * 0.24),
      peTtm: +(6 + Math.pow(rnd(), 2) * 100).toFixed(2),
      industry: INDUSTRIES[Math.floor(rnd() * INDUSTRIES.length)]
    };
  }

  /** 模拟：让快照价格随时间小幅漂移，制造"实时"感 */
  MOCK.tick = function (list) {
    const t = Date.now() / 1000;
    list.forEach(s => {
      const r = mulberry32(hashCode(s.code) + Math.floor(t / 3))();
      const delta = (r - 0.5) * s.preClose * 0.004;
      let np = +(s.price + delta).toFixed(2);
      const cap = s.preClose * 1.1, flr = s.preClose * 0.9;
      np = Math.max(flr, Math.min(cap, np));
      s.price = np;
      s.chg = +(np - s.preClose).toFixed(2);
      s.chgPct = +((s.chg / s.preClose) * 100).toFixed(2);
      s.high = Math.max(s.high, np);
      s.low = Math.min(s.low, np);
      s.speed = +((r - 0.5) * 1.2).toFixed(2);
    });
    return list;
  };

  /** 模拟 K 线 */
  MOCK.kline = function (secid, klt, lmt) {
    lmt = lmt || 300;
    // 2小时(120)/4小时(240)：先生成 60分K线再做合并
    if (klt === 120 || klt === 240) {
      const g = klt === 120 ? 2 : 4;
      const base = MOCK.kline(secid, 60, lmt * g);
      return base.length ? aggregateBars(base, g) : base;
    }
    const code = secid.split('.')[1] || secid;
    const stock = (CACHE || MOCK.universe()).find(s => s.code === code);
    const endPrice = stock ? stock.price : 20;
    const rnd = mulberry32(hashCode(code + '_' + klt));

    // 反向游走：从今天价格倒推历史
    const closes = new Array(lmt);
    closes[lmt - 1] = endPrice;
    const vol = klt >= 101 ? 0.021 : 0.006;
    for (let i = lmt - 2; i >= 0; i--) {
      const drift = (rnd() - 0.5) * 2 * vol + Math.sin(i / 22) * 0.0035;
      closes[i] = Math.max(1.2, closes[i + 1] / (1 + drift));
    }

    const out = [];
    const today = new Date();
    const stepDays = klt === 102 ? 7 : klt === 103 ? 30 : 1;
    let cursor = new Date(today);
    const dates = [];
    for (let i = 0; i < lmt; i++) {
      dates.unshift(new Date(cursor));
      cursor = new Date(cursor.getTime() - stepDays * 86400000);
      if (klt === 101) { while (cursor.getDay() === 0 || cursor.getDay() === 6) cursor = new Date(cursor.getTime() - 86400000); }
    }

    for (let i = 0; i < lmt; i++) {
      const c = +closes[i].toFixed(2);
      const o = +(i === 0 ? c * (1 + (rnd() - 0.5) * 0.01) : closes[i - 1] * (1 + (rnd() - 0.5) * 0.012)).toFixed(2);
      const h = +(Math.max(o, c) * (1 + rnd() * 0.017)).toFixed(2);
      const l = +(Math.min(o, c) * (1 - rnd() * 0.017)).toFixed(2);
      const pc = i === 0 ? o : +closes[i - 1].toFixed(2);
      const v = Math.round((0.4 + rnd() * 1.9) * (stock ? stock.volume : 200000));
      const d = dates[i];
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      out.push({
        date: klt < 101 ? ds + ' ' + String(9 + Math.floor(i % 4)).padStart(2, '0') + ':30' : ds,
        open: o, close: c, high: h, low: l,
        volume: v, amount: Math.round(v * 100 * c),
        amplitude: +(((h - l) / pc) * 100).toFixed(2),
        chgPct: +(((c - pc) / pc) * 100).toFixed(2),
        chg: +(c - pc).toFixed(2),
        turnover: +(0.3 + rnd() * 8).toFixed(2)
      });
    }
    return out;
  };

  /** 合并 K 线（用于 2h/4h 等合成周期） */
  function aggregateBars(bars, g) {
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

  /** 模拟分时 */
  MOCK.trends = function (secid) {
    const code = secid.split('.')[1] || secid;
    const stock = (CACHE || MOCK.universe()).find(s => s.code === code);
    const preClose = stock ? stock.preClose : 20;
    const target = stock ? stock.price : 20;
    const rnd = mulberry32(hashCode(code + '_t'));
    const N = 241;
    const rows = [];
    let sumPV = 0, sumV = 0;
    const today = new Date();
    const ds = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

    let p = preClose;
    for (let i = 0; i < N; i++) {
      const progress = i / (N - 1);
      const pull = (target - p) * progress * 0.06;
      p = p + pull + (rnd() - 0.5) * preClose * 0.0026;
      p = Math.max(preClose * 0.9, Math.min(preClose * 1.1, p));
      const v = Math.round((0.3 + rnd() * 1.6) * (stock ? stock.volume : 200000) / N);
      sumPV += p * v; sumV += v;
      const minute = i < 121 ? 9 * 60 + 30 + i : 13 * 60 + (i - 121);
      const hh = String(Math.floor(minute / 60)).padStart(2, '0');
      const mm = String(minute % 60).padStart(2, '0');
      rows.push({
        time: ds + ' ' + hh + ':' + mm,
        open: +p.toFixed(2), close: +p.toFixed(2), high: +p.toFixed(2), low: +p.toFixed(2),
        volume: v, amount: Math.round(v * 100 * p), avg: +(sumPV / (sumV || 1)).toFixed(3)
      });
    }
    return { preClose: preClose, name: stock ? stock.name : code, code: code, rows: rows };
  };

  /** 模拟快照（含五档） */
  MOCK.snapshot = function (secid) {
    const code = secid.split('.')[1] || secid;
    const s = (CACHE || MOCK.universe()).find(x => x.code === code);
    if (!s) return null;
    const rnd = mulberry32(hashCode(code + Math.floor(Date.now() / 4000)));
    const step = Math.max(0.01, +(s.price * 0.001).toFixed(2));
    const bids = [], asks = [];
    for (let i = 0; i < 5; i++) {
      bids.push({ p: +(s.price - step * (i + 1)).toFixed(2), v: Math.round(20 + rnd() * 3200) });
      asks.push({ p: +(s.price + step * (i + 1)).toFixed(2), v: Math.round(20 + rnd() * 3200) });
    }
    return {
      code: s.code, name: s.name, decimal: 2,
      price: s.price, high: s.high, low: s.low, open: s.open,
      volume: s.volume, amount: s.amount, outer: Math.round(s.volume * 0.52),
      volRatio: s.volRatio, limitUp: +(s.preClose * 1.1).toFixed(2), limitDown: +(s.preClose * 0.9).toFixed(2),
      preClose: s.preClose, avg: +((s.high + s.low + s.price) / 3).toFixed(2),
      totalShare: s.mktCap / s.price, floatShare: s.floatCap / s.price,
      mktCap: s.mktCap, floatCap: s.floatCap,
      pe: s.pe, pb: s.pb, turnover: s.turnover,
      chg: s.chg, chgPct: s.chgPct, amplitude: s.amplitude,
      bids: bids, asks: asks
    };
  };

  MOCK.indexes = function () {
    const rnd = mulberry32(Math.floor(Date.now() / 5000));
    const defs = [['000001', '上证指数', 3280], ['399001', '深证成指', 10450], ['399006', '创业板指', 2130], ['000300', '沪深300', 3860]];
    return defs.map(d => {
      const chgPct = +((rnd() - 0.5) * 2.4).toFixed(2);
      return { code: d[0], name: d[1], price: +(d[2] * (1 + chgPct / 100)).toFixed(2), chgPct: chgPct, chg: +(d[2] * chgPct / 100).toFixed(2) };
    });
  };

  global.MOCK = MOCK;
})(window);
