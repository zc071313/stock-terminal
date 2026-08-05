/* ============================================================
   screener.js — 选股引擎
   规则：默认锁定「沪深主板 + 散户可直接交易」
         剔除科创板(688)、创业板(300/301)、北交所(8xx/4xx)、ST/*ST、退市
   ============================================================ */
(function (global) {
  'use strict';

  const SCR = {};

  /* -------- 板块与可交易性判定 -------- */
  const SH_MAIN = /^(600|601|603|605)\d{3}$/;
  const SZ_MAIN = /^(000|001|002|003)\d{3}$/;

  SCR.isMainBoard = function (code) {
    return SH_MAIN.test(code) || SZ_MAIN.test(code);
  };

  SCR.boardOf = function (code) {
    if (SH_MAIN.test(code)) return '沪市主板';
    if (SZ_MAIN.test(code)) return '深市主板';
    if (/^688/.test(code)) return '科创板';
    if (/^(300|301)/.test(code)) return '创业板';
    if (/^(83|87|88|43|92)/.test(code)) return '北交所';
    return '其他';
  };

  SCR.isST = function (name) {
    return /ST|退|\*/i.test(name || '');
  };

  /** 散户可直接交易（无需额外权限） */
  SCR.retailTradable = function (s) {
    return SCR.isMainBoard(s.code) && !SCR.isST(s.name);
  };

  /* -------- 预置策略 -------- */
  SCR.STRATEGIES = [
    {
      id: 'volume_breakout', name: '放量突破', desc: '量能放大 + 温和上攻',
      filters: { chgPctMin: 2, chgPctMax: 7, volRatioMin: 1.5, turnoverMin: 3, turnoverMax: 15, amountMin: 2 },
      weights: { momentum: .3, volume: .35, activity: .25, value: .1 }
    },
    {
      id: 'oversold_rebound', name: '超跌反弹', desc: '深跌企稳 + 放量转强',
      filters: { chg60Max: -25, chgPctMin: 1, volRatioMin: 1.2, amountMin: 0.5 },
      weights: { momentum: .2, volume: .3, activity: .2, reversal: .3 }
    },
    {
      id: 'low_absorb', name: '低位潜伏', desc: '深跌缩量止跌，主力吸筹',
      filters: { chg60Max: -20, chgPctMin: -1.5, chgPctMax: 3.5, volRatioMin: 0.7, volRatioMax: 1.6, amountMin: 0.3 },
      weights: { reversal: .45, volume: .2, value: .2, activity: .15 }
    },
    {
      id: 'low_price_active', name: '低价活跃', desc: '低价 + 温和放量 + 有振幅',
      filters: { priceMax: 15, volRatioMin: 1.1, chgPctMin: -2, chgPctMax: 6, turnoverMin: 2, turnoverMax: 12, amountMin: 0.5, amplitudeMin: 2.5 },
      weights: { activity: .4, volume: .3, momentum: .2, value: .1 }
    },
    {
      id: 'price_volume_up', name: '量价齐升', desc: '价涨量增，趋势健康',
      filters: { chgPctMin: 0.5, volRatioMin: 1.2, turnoverMin: 2, amplitudeMin: 3, amountMin: 1 },
      weights: { momentum: .35, volume: .35, activity: .2, value: .1 }
    },
    {
      id: 'leader_strong', name: '强势龙头', desc: '大额资金推动的领涨股',
      filters: { chgPctMin: 5, amountMin: 10, turnoverMin: 3 },
      weights: { momentum: .45, volume: .3, activity: .2, value: .05 }
    },
    {
      id: 'value_blue', name: '低估蓝筹', desc: '低PE低PB大市值，防御配置',
      filters: { peMin: 0, peMax: 20, pbMin: 0, pbMax: 3, mktCapMin: 200, chgPctMin: -3, chgPctMax: 3.5 },
      weights: { value: .55, momentum: .15, volume: .15, activity: .15 }
    },
    {
      id: 'main_inflow', name: '主力净流入', desc: '资金净买入且股价企稳',
      filters: { chgPctMin: -1, mainNetMin: 3000, amountMin: 1 },
      weights: { volume: .4, momentum: .25, activity: .2, value: .15 }
    }
  ];

  /* -------- 条件筛选 -------- */
  /**
   * @param {Array} list  全市场股票
   * @param {object} f    过滤条件（数值单位：金额=亿元，市值=亿元，主力净流入=万元）
   * @returns {Array}
   */
  SCR.filter = function (list, f) {
    f = f || {};
    return list.filter(s => {
      if (s.price === null || s.price <= 0) return false;

      // 板块与可交易性
      if (f.mainBoardOnly !== false && !SCR.isMainBoard(s.code)) return false;
      if (f.excludeST !== false && SCR.isST(s.name)) return false;
      if (f.excludeSuspend !== false && (!s.volume || s.volume <= 0)) return false;

      if (!rng(s.price, f.priceMin, f.priceMax)) return false;
      if (!rng(s.chgPct, f.chgPctMin, f.chgPctMax)) return false;
      if (!rng(s.turnover, f.turnoverMin, f.turnoverMax)) return false;
      if (!rng(s.volRatio, f.volRatioMin, f.volRatioMax)) return false;
      if (!rng(s.amplitude, f.amplitudeMin, f.amplitudeMax)) return false;
      if (!rng(s.chg60, f.chg60Min, f.chg60Max)) return false;

      // 成交额：输入亿元
      if (f.amountMin != null && (s.amount == null || s.amount < f.amountMin * 1e8)) return false;
      if (f.amountMax != null && (s.amount == null || s.amount > f.amountMax * 1e8)) return false;

      // 市值：输入亿元
      if (f.mktCapMin != null && (s.mktCap == null || s.mktCap < f.mktCapMin * 1e8)) return false;
      if (f.mktCapMax != null && (s.mktCap == null || s.mktCap > f.mktCapMax * 1e8)) return false;

      // 主力净流入：输入万元
      if (f.mainNetMin != null && (s.mainNet == null || s.mainNet < f.mainNetMin * 1e4)) return false;

      // PE / PB：负值视为亏损，设置了下限则剔除
      if (f.peMin != null || f.peMax != null) {
        if (s.pe == null) return false;
        if (!rng(s.pe, f.peMin, f.peMax)) return false;
      }
      if (f.pbMin != null || f.pbMax != null) {
        if (s.pb == null) return false;
        if (!rng(s.pb, f.pbMin, f.pbMax)) return false;
      }
      return true;
    });

    function rng(v, min, max) {
      if (min == null && max == null) return true;
      if (v == null || !isFinite(v)) return false;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
      return true;
    }
  };

  /* -------- 综合评分 -------- */
  /**
   * 五个维度 0~100：momentum 动量 / volume 量能 / activity 活跃 / value 估值 / reversal 反转
   */
  SCR.score = function (list, weights) {
    const w = Object.assign({ momentum: .28, volume: .26, activity: .2, value: .14, reversal: .12 }, weights || {});
    return list.map(s => {
      const momentum = clamp(50 + (s.chgPct || 0) * 5.5 + (s.speed || 0) * 6);
      const volume = clamp(28 + Math.log10(Math.max(s.amount || 1, 1e5) / 1e7) * 22 + ((s.volRatio || 1) - 1) * 21);
      const activity = clamp(22 + (s.turnover || 0) * 5.2 + (s.amplitude || 0) * 3.6);
      let value = 50;
      if (s.pe != null && s.pe > 0) value = clamp(100 - Math.min(s.pe, 120) * 0.72);
      else if (s.pe != null && s.pe <= 0) value = 22;
      if (s.pb != null && s.pb > 0) value = clamp(value * 0.62 + (100 - Math.min(s.pb, 12) * 7.4) * 0.38);
      const reversal = clamp(50 - (s.chg60 || 0) * 1.15);

      const dims = { momentum, volume, activity, value, reversal };
      let total = 0, sw = 0;
      Object.keys(w).forEach(k => { if (dims[k] != null) { total += dims[k] * w[k]; sw += w[k]; } });
      s.dims = dims;
      s.score = Math.round(sw ? total / sw : 50);
      s.tags = buildTags(s);
      return s;
    });

    function clamp(v) { return Math.max(0, Math.min(100, v)); }
  };

  function buildTags(s) {
    const t = [];
    if (s.chgPct >= 9.8) t.push({ x: '涨停', c: 'hot' });
    else if (s.chgPct <= -9.8) t.push({ x: '跌停', c: 'cool' });
    if ((s.volRatio || 0) >= 2) t.push({ x: '放量', c: 'hot' });
    else if ((s.volRatio || 9) <= 0.6) t.push({ x: '缩量', c: 'cool' });
    if ((s.amount || 0) >= 10e8) t.push({ x: '大额', c: 'tech' });
    if ((s.turnover || 0) >= 10) t.push({ x: '高换手', c: 'hot' });
    if ((s.chg60 || 0) <= -30) t.push({ x: '深跌', c: 'cool' });
    else if ((s.chg60 || 0) >= 50) t.push({ x: '强趋势', c: 'hot' });
    if (s.pe != null && s.pe > 0 && s.pe <= 15) t.push({ x: '低PE', c: 'tech' });
    if ((s.mainNet || 0) >= 5000e4) t.push({ x: '主力买', c: 'hot' });
    if (s.price != null && s.price <= 10) t.push({ x: '低价', c: 'tech' });
    return t.slice(0, 3);
  }

  /* -------- 深度技术校验：对 Top N 拉日K做指标诊断 -------- */
  SCR.deepCheck = async function (list, topN, useMock, onProgress) {
    const targets = list.slice(0, topN);
    // 并发压到 3：批量拉历史K线时东财网关会限流，宁可慢一点也要拿全数据
    await U.pool(targets, 3, async (s) => {
      try {
        const k = useMock ? MOCK.kline(s.secid, 101, 160) : await API.fetchKline(s.secid, 101, 1, 160);
        const dg = IND.diagnose(k);
        if (dg) {
          s.tech = dg;
          // 技术分与快照分融合
          s.score = Math.round(s.score * 0.55 + dg.score * 0.45);
          s.techTags = dg.tags;
        }
      } catch (e) { s.tech = null; }
    }, onProgress);
    return list;
  };

  global.SCR = SCR;
})(window);
