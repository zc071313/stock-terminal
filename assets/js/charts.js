/* ============================================================
   charts.js — ECharts 看盘图表
   K线（主图 MA/BOLL + 量能 + 副图 MACD/KDJ/RSI）与分时图
   ============================================================ */
(function (global) {
  'use strict';

  const CH = {};
  let chart = null;

  CH.init = function (dom) {
    if (chart) { chart.dispose(); chart = null; }
    chart = echarts.init(dom, null, { renderer: 'canvas' });
    setupVLine();
    return chart;
  };
  CH.get = function () { return chart; };
  CH.resize = function () { if (chart) chart.resize(); };

  /* ============ 可拖拽竖直线（参考线） ============ */
  CH._vline = { enabled: true, data: null, idx: null, px: null, rect: null };

  function setupVLine() {
    if (!chart) return;
    const zr = chart.getZr();
    let dragging = false;
    const offX = e => (e && e.offsetX != null) ? e.offsetX : (e && e.event ? e.event.offsetX : null);

    zr.on('mousedown', e => {
      if (!CH._vline.enabled || !CH._vline.data || CH._vline.px == null) return;
      const x = offX(e);
      if (x != null && Math.abs(x - CH._vline.px) <= 9) dragging = true;
    });
    zr.on('mousemove', e => {
      if (!dragging) return;
      const x = offX(e);
      if (x != null) moveVLine(x);
    });
    const stop = () => { dragging = false; };
    zr.on('mouseup', stop);
    zr.on('globalout', stop);
    chart.on('dataZoom', () => drawVLine());
  }

  function moveVLine(px) {
    if (px == null || isNaN(px) || !chart || !CH._vline.data) return;
    const idx = chart.convertFromPixel({ xAxisIndex: 0 }, px);
    if (idx == null || isNaN(idx)) return;
    const i = Math.round(idx);
    const n = CH._vline.data.length;
    CH._vline.idx = Math.max(0, Math.min(n - 1, i));
    drawVLine();
  }

  // 获取所有 grid 的纵向像素并集（用于竖参考线）。
  // 兼容不同 echarts 构建：部分构建未暴露 getComponents（复数），回退 getComponent（单数），再不行用整张画布兜底，绝不崩溃。
  function getGridArea() {
    try {
      const model = chart && chart.getModel && chart.getModel();
      if (model) {
        let grids = null;
        if (typeof model.getComponents === 'function') {
          grids = model.getComponents('grid');
        } else if (typeof model.getComponent === 'function') {
          const g = model.getComponent('grid', 0);
          grids = g ? [g] : [];
        }
        if (grids && grids.length) {
          let top = Infinity, bottom = -Infinity;
          grids.forEach(function (g) {
            const r = g && typeof g.getRect === 'function' ? g.getRect() : null;
            if (r && isFinite(r.y) && isFinite(r.height)) {
              top = Math.min(top, r.y);
              bottom = Math.max(bottom, r.y + r.height);
            }
          });
          if (isFinite(top) && isFinite(bottom)) return { top: top, bottom: bottom };
        }
      }
    } catch (e) { /* 忽略内部 API 异常，走兜底 */ }
    const zr = chart && chart.getZr ? chart.getZr() : null;
    const h = zr ? zr.getHeight() : 0;
    return h ? { top: 0, bottom: h } : null;
  }

  function drawVLine() {
    if (!chart) return;
    const visible = CH._vline.enabled && !!CH._vline.data;
    const area = getGridArea();
    if (!area) { CH._vline.rect = null; return; }
    let top = area.top, bottom = area.bottom;

    let px = CH._vline.px, idx = CH._vline.idx, date = '', close = '';
    if (visible) {
      idx = (idx == null) ? CH._vline.data.length - 1 : Math.max(0, Math.min(CH._vline.data.length - 1, idx));
      CH._vline.idx = idx;
      px = chart.convertToPixel({ xAxisIndex: 0 }, idx);
      if (px == null || isNaN(px)) return;
      CH._vline.px = px;
      const d = CH._vline.data[idx];
      date = d ? d.date : '';
      close = d ? d.close.toFixed(2) : '';
      CH._vline.rect = { top: top, bottom: bottom, px: px };
    } else if (CH._vline.rect) {
      // 隐藏时复用上次坐标，仅置透明，避免 merge 模式无法清除
      px = CH._vline.rect.px; top = CH._vline.rect.top; bottom = CH._vline.rect.bottom;
    } else {
      return; // 从未绘制过，直接跳过
    }

    const op = visible ? 1 : 0;
    chart.setOption({
      graphic: [
        {
          type: 'line', id: 'vline', silent: true, z: 98,
          shape: { x1: px, y1: top, x2: px, y2: bottom },
          style: { stroke: '#f0a92c', lineWidth: 1.4, lineDash: [5, 4], opacity: op }
        },
        {
          type: 'text', id: 'vline-label', silent: true, z: 99,
          style: {
            x: px + 5, y: Math.max(2, top - 15),
            text: date,
            fill: '#ffffff', font: '11px sans-serif',
            textBackgroundColor: '#f0a92c', textPadding: [2, 5], textBorderRadius: 2, opacity: op
          }
        },
        {
          type: 'text', id: 'vline-price', silent: true, z: 99,
          style: {
            x: px + 5, y: top + 3,
            text: close,
            fill: '#ffffff', font: '10px sans-serif',
            textBackgroundColor: '#f0a92c', textPadding: [1, 4], textBorderRadius: 2, opacity: op
          }
        }
      ]
    });
  }

  CH.toggleVLine = function (show) {
    CH._vline.enabled = (show !== false);
    if (!CH._vline.enabled) CH._vline.px = null;
    drawVLine();
  };

  function theme() {
    return {
      up: U.cssVar('--up'),
      down: U.cssVar('--down'),
      text: U.cssVar('--text'),
      text2: U.cssVar('--text-2'),
      text3: U.cssVar('--text-3'),
      grid: U.cssVar('--grid-line'),
      border: U.cssVar('--border'),
      panel: U.cssVar('--panel'),
      panel2: U.cssVar('--panel-2'),
      axis: U.cssVar('--axis-text'),
      accent: U.cssVar('--accent')
    };
  }

  function baseTooltip(t) {
    return {
      trigger: 'axis',
      axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }], label: { backgroundColor: t.accent, fontSize: 11 } },
      backgroundColor: t.panel,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: t.text, fontSize: 11.5 },
      extraCssText: 'box-shadow:0 4px 20px rgba(0,0,0,.14);border-radius:8px;'
    };
  }

  /* ==================== K 线图 ==================== */
  /**
   * @param {Array} data  K线数组
   * @param {object} opt  { sub:'vol'|'macd'|'kdj'|'rsi', overlay:'ma'|'boll'|'none', title, precision }
   */
  CH.renderKline = function (data, opt) {
    if (!chart) return;
    opt = opt || {};
    const t = theme();
    const sub = opt.sub || 'macd';
    const overlay = opt.overlay || 'ma';
    const dates = data.map(d => d.date);
    const ohlc = data.map(d => [d.open, d.close, d.low, d.high]);
    const vols = data.map((d, i) => [i, d.volume, d.close >= d.open ? 1 : -1]);

    // Heiken Ashi（平均K线，主图叠加 / 副图共用）
    const avk = (overlay === 'avk' || sub === 'avk') ? IND.heikenAshi(data) : null;
    const avkData = avk ? avk.map(d => d ? [d.open, d.close, d.low, d.high] : null) : null;

    const series = [];
    const legend = [];

    series.push({
      name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
      itemStyle: {
        color: t.up, color0: t.down,
        borderColor: t.up, borderColor0: t.down, borderWidth: 1
      },
      barMaxWidth: 16
    });

    if (overlay === 'ma') {
      [[5, '#f0a92c'], [10, '#2f6fed'], [20, '#c247e0'], [60, '#12a89a']].forEach(([n, color]) => {
        const name = 'MA' + n;
        legend.push(name);
        series.push({
          name: name, type: 'line', xAxisIndex: 0, yAxisIndex: 0,
          data: IND.MA(data, n), smooth: true, symbol: 'none',
          lineStyle: { width: 1.1, color: color }, z: 3
        });
      });
    } else if (overlay === 'avk') {
      legend.push('平均K');
      series.push({
        name: '平均K', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: avkData,
        itemStyle: {
          color: 'rgba(235,137,42,0.60)', color0: 'rgba(58,130,210,0.60)',
          borderColor: 'rgba(235,137,42,0.95)', borderColor0: 'rgba(58,130,210,0.95)', borderWidth: 1
        },
        barMaxWidth: 11, z: 2
      });
      [[5, '#f0a92c'], [10, '#2f6fed'], [20, '#c247e0'], [60, '#12a89a']].forEach(([n, color]) => {
        const name = 'MA' + n;
        legend.push(name);
        series.push({ name: name, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: IND.MA(data, n), smooth: true, symbol: 'none', lineStyle: { width: 1, color: color, opacity: .85 }, z: 3 });
      });
    } else if (overlay === 'boll') {
      const b = IND.BOLL(data, 20, 2);
      legend.push('BOLL上轨', 'BOLL中轨', 'BOLL下轨');
      series.push(
        { name: 'BOLL上轨', type: 'line', data: b.up, symbol: 'none', smooth: true, lineStyle: { width: 1, color: '#e0574a' } },
        { name: 'BOLL中轨', type: 'line', data: b.mid, symbol: 'none', smooth: true, lineStyle: { width: 1.1, color: '#f0a92c' } },
        { name: 'BOLL下轨', type: 'line', data: b.low, symbol: 'none', smooth: true, lineStyle: { width: 1, color: '#12a89a' } }
      );
    }

    // ---- 网格布局：主图 + 量 + 副图
    const hasSub = sub !== 'vol';
    const grids = hasSub
      ? [
        { left: 56, right: 58, top: 26, height: '52%' },
        { left: 56, right: 58, top: '64%', height: '13%' },
        { left: 56, right: 58, top: '81%', height: '15%' }
      ]
      : [
        { left: 56, right: 58, top: 26, height: '64%' },
        { left: 56, right: 58, top: '76%', height: '19%' }
      ];

    const xAxes = grids.map((g, i) => ({
      type: 'category', gridIndex: i, data: dates, boundaryGap: true,
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: i === grids.length - 1, color: t.axis, fontSize: 10, hideOverlap: true },
      axisPointer: { z: 100, label: { show: i === grids.length - 1 } },
      min: 'dataMin', max: 'dataMax'
    }));

    const yAxes = [{
      scale: true, gridIndex: 0, position: 'right',
      splitLine: { lineStyle: { color: t.grid, type: 'solid' } },
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.axis, fontSize: 10, inside: false, margin: 6 }
    }, {
      scale: true, gridIndex: 1, position: 'right', splitNumber: 2,
      splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.axis, fontSize: 9.5, formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v }
    }];
    if (hasSub) {
      yAxes.push({
        scale: true, gridIndex: 2, position: 'right', splitNumber: 2,
        splitLine: { lineStyle: { color: t.grid } }, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: t.axis, fontSize: 9.5 }
      });
    }

    // ---- 成交量
    series.push({
      name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
      data: vols.map(v => v[1]),
      itemStyle: {
        color: p => data[p.dataIndex].close >= data[p.dataIndex].open ? t.up : t.down,
        opacity: .78
      },
      barMaxWidth: 16
    });
    // 量均线
    series.push({
      name: 'VMA5', type: 'line', xAxisIndex: 1, yAxisIndex: 1,
      data: IND.MA(data, 5, 'volume'), symbol: 'none', lineStyle: { width: 1, color: '#f0a92c' }
    });

    // ---- 副图
    if (sub === 'macd') {
      const m = IND.MACD(data);
      legend.push('DIF', 'DEA');
      series.push(
        {
          name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: m.macd,
          itemStyle: { color: p => p.value >= 0 ? t.up : t.down }, barMaxWidth: 10
        },
        { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: m.dif, symbol: 'none', lineStyle: { width: 1.1, color: '#f0a92c' } },
        { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: m.dea, symbol: 'none', lineStyle: { width: 1.1, color: '#2f6fed' } }
      );
    } else if (sub === 'kdj') {
      const k = IND.KDJ(data);
      legend.push('K', 'D', 'J');
      series.push(
        { name: 'K', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: k.k, symbol: 'none', lineStyle: { width: 1.1, color: '#f0a92c' } },
        { name: 'D', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: k.d, symbol: 'none', lineStyle: { width: 1.1, color: '#2f6fed' } },
        { name: 'J', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: k.j, symbol: 'none', lineStyle: { width: 1.1, color: '#c247e0' } }
      );
    } else if (sub === 'rsi') {
      legend.push('RSI6', 'RSI14');
      series.push(
        { name: 'RSI6', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: IND.RSI(data, 6), symbol: 'none', lineStyle: { width: 1.1, color: '#f0a92c' } },
        { name: 'RSI14', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: IND.RSI(data, 14), symbol: 'none', lineStyle: { width: 1.1, color: '#2f6fed' } }
      );
    } else if (sub === 'avk') {
      legend.push('平均K');
      series.push({
        name: '平均K', type: 'candlestick', xAxisIndex: 2, yAxisIndex: 2, data: avkData,
        itemStyle: { color: t.up, color0: t.down, borderColor: t.up, borderColor0: t.down, borderWidth: 1 },
        barMaxWidth: 12
      });
    }

    const startPct = Math.max(0, 100 - (120 / Math.max(data.length, 1)) * 100);

    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        data: legend, top: 3, left: 58, itemWidth: 12, itemHeight: 2, itemGap: 12,
        textStyle: { color: t.text2, fontSize: 10.5 }
      },
      tooltip: Object.assign(baseTooltip(t), {
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          const i = ps[0].dataIndex;
          const d = data[i];
          if (!d) return '';
          const pc = i > 0 ? data[i - 1].close : d.open;
          const chg = d.close - pc, chgP = (chg / pc) * 100;
          const c = chg >= 0 ? t.up : t.down;
          let html = '<div style="font-weight:700;margin-bottom:5px">' + d.date + '</div>';
          html += row('开', d.open.toFixed(2), d.open >= pc ? t.up : t.down);
          html += row('高', d.high.toFixed(2), d.high >= pc ? t.up : t.down);
          html += row('低', d.low.toFixed(2), d.low >= pc ? t.up : t.down);
          html += row('收', d.close.toFixed(2), c);
          html += row('涨跌', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '  ' + (chgP >= 0 ? '+' : '') + chgP.toFixed(2) + '%', c);
          html += row('量', U.vol(d.volume), t.text2);
          html += row('额', U.money(d.amount), t.text2);
          if (d.turnover) html += row('换手', d.turnover.toFixed(2) + '%', t.text2);
          ps.forEach(p => {
            if (p.seriesName === 'K线' || p.seriesName === '成交量' || p.seriesName === 'VMA5') return;
            if (p.seriesName === '平均K') {
              const v = p.value;
              if (!v) return;
              const col = v[1] >= v[0] ? t.up : t.down;
              html += row('平均K', '开' + v[0].toFixed(2) + ' 收' + v[1].toFixed(2) + ' 低' + v[2].toFixed(2) + ' 高' + v[3].toFixed(2), col);
              return;
            }
            if (p.value === null || p.value === undefined) return;
            html += row(p.seriesName, Number(p.value).toFixed(p.seriesName.indexOf('MA') === 0 || p.seriesName.indexOf('BOLL') === 0 ? 2 : 3), p.color);
          });
          return html;
          function row(k, v, col) {
            return '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.65">'
              + '<span style="color:' + t.text3 + '">' + k + '</span>'
              + '<span style="color:' + col + ';font-weight:600">' + v + '</span></div>';
          }
        }
      }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: grids.map((_, i) => i), start: startPct, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: 'slider', xAxisIndex: grids.map((_, i) => i), start: startPct, end: 100,
          height: 15, bottom: 2, borderColor: t.border, backgroundColor: t.panel2,
          fillerColor: 'rgba(47,111,237,.12)', handleSize: '92%',
          textStyle: { color: t.axis, fontSize: 9 },
          dataBackground: { lineStyle: { color: t.border }, areaStyle: { color: t.grid } }
        }
      ],
      series: series
    }, true);

    // 竖立可拖拽参考线
    CH._vline.data = data;
    if (CH._vline.idx != null && CH._vline.idx > data.length - 1) CH._vline.idx = data.length - 1;
    drawVLine();
  };

  /* ==================== 分时图 ==================== */
  CH.renderTrends = function (td, opt) {
    if (!chart) return;
    opt = opt || {};
    const t = theme();
    const pre = td.preClose;
    const rows = td.rows;
    const times = rows.map(r => r.time.slice(11));
    const prices = rows.map(r => r.close);
    const avgs = rows.map(r => r.avg);
    const vols = rows.map(r => r.volume);

    // 上下对称区间
    let maxDev = 0.005;
    rows.forEach(r => { maxDev = Math.max(maxDev, Math.abs(r.close - pre) / pre, Math.abs(r.avg - pre) / pre); });
    maxDev = Math.min(maxDev * 1.15, 0.105);
    const yMin = pre * (1 - maxDev), yMax = pre * (1 + maxDev);
    const lastC = prices[prices.length - 1];
    const lineColor = lastC >= pre ? t.up : t.down;

    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        data: ['分时', '均价'], top: 3, left: 58, itemWidth: 12, itemHeight: 2, itemGap: 14,
        textStyle: { color: t.text2, fontSize: 10.5 }
      },
      tooltip: Object.assign(baseTooltip(t), {
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          const i = ps[0].dataIndex;
          const r = rows[i];
          if (!r) return '';
          const chg = r.close - pre, chgP = (chg / pre) * 100;
          const c = chg >= 0 ? t.up : t.down;
          return '<div style="font-weight:700;margin-bottom:5px">' + r.time.slice(11) + '</div>'
            + line('价格', r.close.toFixed(2), c)
            + line('涨跌', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '  ' + (chgP >= 0 ? '+' : '') + chgP.toFixed(2) + '%', c)
            + line('均价', r.avg.toFixed(2), '#f0a92c')
            + line('分量', U.vol(r.volume), t.text2)
            + line('金额', U.money(r.amount), t.text2);
          function line(k, v, col) {
            return '<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.65">'
              + '<span style="color:' + t.text3 + '">' + k + '</span>'
              + '<span style="color:' + col + ';font-weight:600">' + v + '</span></div>';
          }
        }
      }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 62, right: 62, top: 26, height: '62%' },
        { left: 62, right: 62, top: '76%', height: '19%' }
      ],
      xAxis: [
        {
          type: 'category', data: times, gridIndex: 0, boundaryGap: false,
          axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: true, interval: (idx) => idx === 60 || idx === 120 || idx === 180, lineStyle: { color: t.grid } }
        },
        {
          type: 'category', data: times, gridIndex: 1, boundaryGap: false,
          axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false },
          axisLabel: {
            color: t.axis, fontSize: 10, interval: (idx) => idx === 0 || idx === 60 || idx === 120 || idx === 180 || idx === times.length - 1
          },
          splitLine: { show: true, interval: (idx) => idx === 60 || idx === 120 || idx === 180, lineStyle: { color: t.grid } }
        }
      ],
      yAxis: [
        {
          gridIndex: 0, min: yMin, max: yMax, scale: true, splitNumber: 6, position: 'left',
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: t.grid } },
          axisLabel: {
            fontSize: 10, margin: 6,
            formatter: v => v.toFixed(2),
            color: v => v > pre ? t.up : v < pre ? t.down : t.text3
          }
        },
        {
          gridIndex: 0, min: yMin, max: yMax, position: 'right', splitNumber: 6,
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: {
            fontSize: 10, margin: 6,
            formatter: v => (((v - pre) / pre) * 100).toFixed(2) + '%',
            color: v => v > pre ? t.up : v < pre ? t.down : t.text3
          }
        },
        {
          gridIndex: 1, scale: true, splitNumber: 2, position: 'left',
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: t.axis, fontSize: 9.5, formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v }
        }
      ],
      series: [
        {
          name: '分时', type: 'line', data: prices, xAxisIndex: 0, yAxisIndex: 0,
          symbol: 'none', lineStyle: { width: 1.4, color: lineColor },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: hexA(lineColor, .22) },
                { offset: 1, color: hexA(lineColor, .01) }
              ]
            }
          },
          markLine: {
            symbol: 'none', silent: true,
            label: { formatter: '昨收 ' + pre.toFixed(2), position: 'insideStartTop', color: t.text3, fontSize: 10 },
            lineStyle: { color: t.text3, type: 'dashed', width: 1 },
            data: [{ yAxis: pre }]
          }
        },
        {
          name: '均价', type: 'line', data: avgs, xAxisIndex: 0, yAxisIndex: 0,
          symbol: 'none', lineStyle: { width: 1.1, color: '#f0a92c' }
        },
        {
          name: '分时量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 2,
          itemStyle: { color: p => (rows[p.dataIndex].close >= (p.dataIndex > 0 ? rows[p.dataIndex - 1].close : pre)) ? t.up : t.down },
          barMaxWidth: 3
        }
      ]
    }, true);

    // 分时图不显示 K 线参考线（隐藏而非移除，merge 模式更稳妥）
    CH._vline.data = null; CH._vline.px = null;
    drawVLine();
  };

  function hexA(hex, a) {
    hex = (hex || '#888').trim();
    if (hex[0] !== '#') return hex;
    if (hex.length === 4) hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  global.CH = CH;
})(window);
