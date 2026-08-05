/* ============================================================
   app.js — 应用主控
   ============================================================ */
(function () {
  'use strict';

  const $ = U.$, $$ = U.$$;

  const S = {
    page: 'market',
    universe: [],            // 全市场快照
    universeTime: 0,         // 快照时间戳
    listTab: U.store.get('listTab', 'gainers'),
    watch: U.store.get('watch', ['600519', '000001', '601318', '600036', '002594', '600900']),
    current: null,           // 当前股票对象
    klt: 0,                  // 0=分时
    overlay: 'ma',
    sub: 'macd',
    auto: U.store.get('auto', true),
    theme: U.store.get('theme', 'light'),
    kcache: {},              // 当前个股K线缓存
    scrResult: [],
    scrSort: { key: 'score', asc: false },
    activeStrategy: null,
    loadingChart: false
  };

  const useMock = () => API.mode === 'mock';

  /* ============ 初始化 ============ */
  async function boot() {
    document.documentElement.setAttribute('data-theme', S.theme);
    bindUI();
    CH.init($('#mainChart'));
    window.addEventListener('resize', U.debounce(() => CH.resize(), 150));

    setStatus('connecting', '连接行情网关…');
    const ok = await API.probe();
    if (ok) {
      setStatus('live', '东方财富 · 实时');
    } else {
      setStatus('mock', '离线演示数据');
      U.toast('行情网关不可达，已切换到离线演示数据（功能完整可用）', 'err', 5200);
    }

    renderStrategies();
    loadIndexes();
    await loadUniverse();          // 渐进式：首批到达即渲染并选中默认股
    trySelectDefault();
    startAutoRefresh();
  }

  /** 有数据后选中默认股票（自选第一只 → 否则榜单第一只） */
  function trySelectDefault() {
    if (S.current || !S.universe.length) return;
    let first = null;
    for (const c of S.watch) { first = S.universe.find(s => s.code === c); if (first) break; }
    if (!first) first = currentListData()[0] || S.universe[0];
    if (first) selectStock(first);
  }

  function setStatus(mode, text) {
    const dot = $('#statusDot');
    dot.className = 'status-dot' + (mode === 'live' ? '' : ' off');
    $('#statusText').textContent = text;
  }

  /* ============ 全市场数据 ============ */
  /**
   * 全市场快照（渐进式加载：首批 100 只立即可用，其余后台补齐）
   * 东财网关单页上限 100 条，全市场约 5400 只 ≈ 54 页
   */
  async function loadUniverse(silent) {
    if (useMock()) {
      S.universe = MOCK.tick(MOCK.universe(1200));
      renderList();
      return;
    }
    try {
      if (!silent) $('#scrHint').textContent = '正在拉取全市场快照…';
      await API.fetchAll(API.FS_ALL, null, (partial, done, pages) => {
        S.universe = partial;
        if (done === 1 || done % 8 === 0 || done === pages) {
          renderList();
          trySelectDefault();
        }
        if (!silent) {
          $('#scrHint').textContent = '载入全市场行情 ' + partial.length + ' 只（' + done + '/' + pages + ' 页）…';
          setStatus('live', done < pages ? '东方财富 · 载入 ' + Math.round(done / pages * 100) + '%' : '东方财富 · 实时');
        }
      });
      renderList();
      S.universeTime = Date.now();
      if (!silent) {
        const mb = S.universe.filter(s => SCR.isMainBoard(s.code)).length;
        setStatus('live', '东方财富 · 实时');
        $('#scrHint').textContent = '已载入 ' + S.universe.length + ' 只标的，其中沪深主板 ' + mb + ' 只（选股默认只在主板中筛选）';
      }
    } catch (e) {
      if (!S.universe.length) {
        API.mode = 'mock';
        setStatus('mock', '离线演示数据');
        S.universe = MOCK.tick(MOCK.universe(1200));
        renderList();
        U.toast('全市场拉取失败，已切换离线数据：' + e.message, 'err', 4200);
      }
    }
  }

  /** 轻量刷新：只更新当前可见的榜单 + 自选 + 当前个股，避免每次重拉全市场 */
  async function refreshVisible() {
    if (useMock()) { MOCK.tick(S.universe); return; }
    const FID = { gainers: ['f3', 1], losers: ['f3', 0], amount: ['f6', 1], turnover: ['f8', 1] };
    const tasks = [];

    if (S.listTab === 'watch') {
      const ids = S.watch.map(c => {
        const s = S.universe.find(x => x.code === c);
        return s ? s.secid : (/^(60|68|9|5|11|1[13])/.test(c) ? '1.' : '0.') + c;
      });
      tasks.push(API.fetchByCodes(ids));
    } else {
      const f = FID[S.listTab] || ['f3', 1];
      tasks.push(API.fetchList({ fs: API.FS_MAIN, pz: 100, pn: 1, fid: f[0], po: f[1] }).then(r => r.list));
    }
    if (S.current) tasks.push(API.fetchByCodes([S.current.secid]));

    const res = await Promise.all(tasks.map(p => p.catch(() => [])));
    const merged = [].concat.apply([], res);
    if (!merged.length) return;

    const idx = new Map(S.universe.map((s, i) => [s.code, i]));
    merged.forEach(ns => {
      const i = idx.get(ns.code);
      if (i !== undefined) S.universe[i] = ns;
      else { S.universe.push(ns); idx.set(ns.code, S.universe.length - 1); }
    });
  }

  async function loadIndexes() {
    try {
      const idx = useMock() ? MOCK.indexes() : await API.fetchIndex();
      $('#indexBar').innerHTML = idx.map(i =>
        '<span><span style="color:var(--text-3)">' + U.esc(i.name) + '</span> '
        + '<b class="num ' + U.cls(i.chgPct) + '">' + U.n(i.price) + '</b> '
        + '<span class="num ' + U.cls(i.chgPct) + '">' + U.pct(i.chgPct) + '</span></span>'
      ).join('');
    } catch (e) { /* 静默 */ }
  }

  /* ============ 左侧榜单 ============ */
  function currentListData() {
    const uni = S.universe;
    switch (S.listTab) {
      case 'watch':
        return S.watch.map(c => uni.find(s => s.code === c)).filter(Boolean);
      case 'gainers':
        return uni.filter(s => SCR.retailTradable(s)).slice().sort((a, b) => (b.chgPct || -99) - (a.chgPct || -99)).slice(0, 80);
      case 'losers':
        return uni.filter(s => SCR.retailTradable(s)).slice().sort((a, b) => (a.chgPct || 99) - (b.chgPct || 99)).slice(0, 80);
      case 'amount':
        return uni.filter(s => SCR.retailTradable(s)).slice().sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 80);
      case 'turnover':
        return uni.filter(s => SCR.retailTradable(s)).slice().sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, 80);
      default: return [];
    }
  }

  function renderList() {
    $$('.list-tab').forEach(t => t.classList.toggle('active', t.dataset.list === S.listTab));
    const data = currentListData();
    const box = $('#quoteList');
    if (!data.length) {
      box.innerHTML = '<div class="list-empty">' +
        (S.listTab === 'watch' ? '自选列表为空<br>在个股页点击「☆ 加自选」添加' : '暂无数据') + '</div>';
      return;
    }
    box.innerHTML = data.map(s =>
      '<div class="quote-row' + (S.current && s.code === S.current.code ? ' active' : '') + '" data-code="' + s.code + '">'
      + '<div class="qr-main"><div class="qr-name">' + U.esc(s.name) + '</div><div class="qr-code num">' + s.code + '</div></div>'
      + '<div class="qr-right"><div class="qr-price num ' + U.cls(s.chgPct) + '">' + U.n(s.price) + '</div>'
      + '<div class="qr-chg num ' + U.cls(s.chgPct) + '">' + U.pct(s.chgPct) + '</div></div>'
      + '</div>'
    ).join('');
  }

  /* ============ 选中个股 ============ */
  async function selectStock(stock) {
    if (!stock) return;
    S.current = stock;
    S.kcache = {};
    renderList();
    renderHead(stock);
    updateWatchBtn();
    await Promise.all([loadChart(), loadSnapshot()]);
  }

  function renderHead(s) {
    $('#shName').textContent = s.name || '--';
    $('#shCode').textContent = s.code || '--';
    $('#shBoard').textContent = SCR.boardOf(s.code) + (SCR.retailTradable(s) ? ' · 可交易' : '');
    const cls = U.cls(s.chgPct);
    const p = $('#shPrice'); p.textContent = U.n(s.price); p.className = 'sh-price num ' + cls;
    const c = $('#shChg'); c.textContent = (s.chg > 0 ? '+' : '') + U.n(s.chg); c.className = 'sh-chg num ' + cls;
    const cp = $('#shChgPct'); cp.textContent = U.pct(s.chgPct); cp.className = 'sh-chg num ' + cls;

    const pc = s.preClose;
    const m = [
      ['今开', U.n(s.open), U.cls(s.open - pc)],
      ['最高', U.n(s.high), U.cls(s.high - pc)],
      ['最低', U.n(s.low), U.cls(s.low - pc)],
      ['昨收', U.n(pc), 'flat'],
      ['成交量', U.vol(s.volume), ''],
      ['成交额', U.money(s.amount), ''],
      ['换手率', U.n(s.turnover) + '%', ''],
      ['量比', U.n(s.volRatio), (s.volRatio || 0) > 1 ? 'up' : 'down'],
      ['振幅', U.n(s.amplitude) + '%', ''],
      ['市盈率', s.pe != null && s.pe < 0 ? '亏损' : U.n(s.pe), ''],
      ['市净率', U.n(s.pb), ''],
      ['总市值', U.money(s.mktCap), '']
    ];
    $('#shMetrics').innerHTML = m.map(x =>
      '<div class="mt"><span class="mt-k">' + x[0] + '</span><span class="mt-v ' + x[2] + '">' + x[1] + '</span></div>'
    ).join('');
  }

  /* ============ 图表 ============ */
  async function loadChart() {
    if (!S.current || S.loadingChart) return;
    S.loadingChart = true;
    $('#chartLoading').classList.add('show');
    const key = S.klt === 0 ? null : 'k' + S.klt;
    try {
      if (S.klt === 0) {
        const td = useMock() ? MOCK.trends(S.current.secid) : await API.fetchTrends(S.current.secid, 1);
        CH.renderTrends(td);
        $('#techPanel').innerHTML = '<div style="color:var(--text-3)">分时模式下不计算技术指标，切换到日K查看</div>';
      } else {
        let k = S.kcache[key];
        if (!k) {
          try {
            k = useMock() ? MOCK.kline(S.current.secid, S.klt, 320)
              : await API.fetchKline(S.current.secid, S.klt, 1, S.klt >= 101 ? 400 : 300);
            S.kcache[key] = k;
          } catch (e) {
            // 实时拉取失败：用演示数据兜底，并写入缓存，避免点指标时反复拉取报错
            k = MOCK.kline(S.current.secid, S.klt, 320);
            S.kcache[key] = k;
            if (!useMock()) U.toast('实时行情获取失败，已用演示数据兜底', 'err', 2600);
          }
        }
        CH.renderKline(k, { sub: S.sub, overlay: S.overlay });
        if (S.klt === 101) renderTech(k);
        else $('#techPanel').innerHTML = '<div style="color:var(--text-3)">技术诊断基于日K，切换到日K查看</div>';
      }
      $('#updateTime').textContent = '更新 ' + U.now();
    } catch (e) {
      // 渲染层（非数据层）异常才算真正的图表加载失败
      U.toast('图表加载失败：' + e.message, 'err');
      try {
        if (S.klt === 0) CH.renderTrends(MOCK.trends(S.current.secid));
        else { const k = MOCK.kline(S.current.secid, S.klt, 300); S.kcache['k' + S.klt] = k; CH.renderKline(k, { sub: S.sub, overlay: S.overlay }); }
      } catch (_) { /* 兜底也失败则保持现状 */ }
    } finally {
      S.loadingChart = false;
      $('#chartLoading').classList.remove('show');
    }
  }

  function renderTech(k) {
    const d = IND.diagnose(k);
    if (!d) { $('#techPanel').innerHTML = '<div style="color:var(--text-3)">数据不足</div>'; return; }
    const color = d.score >= 70 ? 'var(--up)' : d.score >= 45 ? 'var(--warn)' : 'var(--down)';
    let html = '<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px">'
      + '<div style="font-size:24px;font-weight:800;color:' + color + '" class="num">' + d.score + '</div>'
      + '<div style="font-size:11px;color:var(--text-3);line-height:1.4">技术综合评分<br>' +
      (d.score >= 70 ? '偏强' : d.score >= 55 ? '中性偏强' : d.score >= 45 ? '中性' : '偏弱') + '</div></div>';
    html += '<div style="margin-bottom:8px">' + d.tags.map(t => '<span class="tag tech">' + t + '</span>').join('') + '</div>';
    const dt = d.detail;
    const rows = [
      ['MA5 / MA10', U.n(dt.ma5) + ' / ' + U.n(dt.ma10)],
      ['MA20 / MA60', U.n(dt.ma20) + ' / ' + U.n(dt.ma60)],
      ['DIF / DEA', U.n(dt.dif, 3) + ' / ' + U.n(dt.dea, 3)],
      ['KDJ', U.n(dt.k, 1) + ' / ' + U.n(dt.d, 1) + ' / ' + U.n(dt.j, 1)],
      ['RSI14', U.n(dt.rsi, 1)],
      ['5日/20日量比', U.n(dt.volRatio5v20)],
      ['60日位置', U.n(dt.pos60, 1) + '%']
    ];
    html += rows.map(r => '<div class="kv"><span class="kv-k">' + r[0] + '</span><span class="kv-v num">' + r[1] + '</span></div>').join('');
    $('#techPanel').innerHTML = html;
  }

  /* ============ 盘口与右栏 ============ */
  async function loadSnapshot() {
    if (!S.current) return;
    let sp = null;
    try {
      sp = useMock() ? MOCK.snapshot(S.current.secid) : await API.fetchSnapshot(S.current.secid);
    } catch (e) { sp = MOCK.snapshot(S.current.secid); }
    if (!sp) return;

    // 盘口
    const maxV = Math.max(1, ...sp.bids.concat(sp.asks).map(x => x.v || 0));
    const upC = U.cssVar('--up'), downC = U.cssVar('--down');
    let html = '';
    for (let i = 4; i >= 0; i--) {
      const a = sp.asks[i] || {};
      html += obRow('卖' + (i + 1), a.p, a.v, sp.preClose, maxV, upC, downC);
    }
    html += '<div class="ob-sep"></div>';
    for (let i = 0; i < 5; i++) {
      const b = sp.bids[i] || {};
      html += obRow('买' + (i + 1), b.p, b.v, sp.preClose, maxV, upC, downC);
    }
    $('#orderBook').innerHTML = html;

    // 实时指标
    $('#rtMetrics').innerHTML = [
      ['最新', U.n(sp.price), U.cls(sp.price - sp.preClose)],
      ['均价', U.n(sp.avg), U.cls(sp.avg - sp.preClose)],
      ['涨停', U.n(sp.limitUp), 'up'],
      ['跌停', U.n(sp.limitDown), 'down'],
      ['成交量', U.vol(sp.volume), ''],
      ['成交额', U.money(sp.amount), ''],
      ['换手率', U.n(sp.turnover) + '%', ''],
      ['量比', U.n(sp.volRatio), ''],
      ['振幅', U.n(sp.amplitude) + '%', '']
    ].map(r => '<div class="kv"><span class="kv-k">' + r[0] + '</span><span class="kv-v ' + r[2] + '">' + r[1] + '</span></div>').join('');

    $('#valMetrics').innerHTML = [
      ['市盈率(动)', sp.pe != null && sp.pe < 0 ? '亏损' : U.n(sp.pe)],
      ['市净率', U.n(sp.pb)],
      ['总市值', U.money(sp.mktCap)],
      ['流通市值', U.money(sp.floatCap)],
      ['总股本', U.money(sp.totalShare).replace('元', '')],
      ['流通股', U.money(sp.floatShare)],
      ['板块', SCR.boardOf(sp.code)]
    ].map(r => '<div class="kv"><span class="kv-k">' + r[0] + '</span><span class="kv-v">' + r[1] + '</span></div>').join('');

    function obRow(label, p, v, pre, maxV, upC, downC) {
      const has = p != null && isFinite(p) && p > 0;
      const cls = has ? U.cls(p - pre) : 'flat';
      const w = has && v ? Math.min(100, (v / maxV) * 100) : 0;
      const barC = label[0] === '买' ? upC : downC;
      return '<div class="ob-row">'
        + '<div class="ob-bar" style="width:' + w + '%;background:' + barC + '"></div>'
        + '<span class="ob-label">' + label + '</span>'
        + '<span class="ob-price num ' + cls + '">' + (has ? U.n(p) : '--') + '</span>'
        + '<span class="ob-vol num">' + (v ? v : '--') + '</span></div>';
    }
  }

  /* ============ 自选 ============ */
  function updateWatchBtn() {
    if (!S.current) return;
    const on = S.watch.indexOf(S.current.code) >= 0;
    const btn = $('#btnWatch');
    btn.textContent = on ? '★ 已自选' : '☆ 加自选';
    btn.classList.toggle('on', on);
  }

  function toggleWatch() {
    if (!S.current) return;
    const i = S.watch.indexOf(S.current.code);
    if (i >= 0) { S.watch.splice(i, 1); U.toast('已移出自选', 'ok', 1500); }
    else { S.watch.unshift(S.current.code); U.toast('已加入自选', 'ok', 1500); }
    U.store.set('watch', S.watch);
    updateWatchBtn();
    if (S.listTab === 'watch') renderList();
  }

  /* ============ 自动刷新 ============ */
  let timer = null;
  function startAutoRefresh() {
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      if (!S.auto || document.hidden || !S.universe.length) return;
      await refreshVisible();
      if (S.current) {
        const nu = S.universe.find(s => s.code === S.current.code);
        if (nu) { S.current = nu; renderHead(nu); }
      }
      renderList();
      loadIndexes();
      loadSnapshot();
      if (S.klt === 0) { S.kcache = {}; loadChart(); }   // 分时随盘走
      else if (!useMock()) { delete S.kcache['k' + S.klt]; loadChart(); } // K线也拉最新一根
      $('#updateTime').textContent = '更新 ' + U.now();
    }, 6000);
  }

  /* ============ 搜索 ============ */
  const doSuggest = U.debounce(function () {
    const q = $('#searchInput').value.trim();
    const box = $('#suggest');
    if (!q) { box.classList.remove('show'); return; }
    const lower = q.toLowerCase();
    const hits = S.universe.filter(s =>
      s.code.indexOf(q) === 0 || (s.name && s.name.toLowerCase().indexOf(lower) >= 0)
    ).slice(0, 12);
    if (!hits.length) { box.innerHTML = '<div class="suggest-item" style="color:var(--text-3)">无匹配结果</div>'; box.classList.add('show'); return; }
    box.innerHTML = hits.map(s =>
      '<div class="suggest-item" data-code="' + s.code + '">'
      + '<span>' + U.esc(s.name) + '</span><span class="suggest-code num">' + s.code + '</span>'
      + '<span class="suggest-price num ' + U.cls(s.chgPct) + '">' + U.n(s.price) + '  ' + U.pct(s.chgPct) + '</span></div>'
    ).join('');
    box.classList.add('show');
  }, 160);

  /* ============ 选股页 ============ */
  function renderStrategies() {
    $('#strategyGrid').innerHTML = SCR.STRATEGIES.map(st =>
      '<div class="strategy-card" data-id="' + st.id + '">'
      + '<div class="sc-name">' + st.name + '</div><div class="sc-desc">' + st.desc + '</div></div>'
    ).join('');
  }

  function applyStrategy(id) {
    const st = SCR.STRATEGIES.find(x => x.id === id);
    if (!st) return;
    S.activeStrategy = (S.activeStrategy === id) ? null : id;
    $$('.strategy-card').forEach(c => c.classList.toggle('active', c.dataset.id === S.activeStrategy));
    clearFilters();
    if (S.activeStrategy) {
      Object.keys(st.filters).forEach(k => {
        const el = $('#f_' + k);
        if (el) el.value = st.filters[k];
      });
    }
  }

  function clearFilters() {
    $$('#filterGrid .fl-in').forEach(el => el.value = '');
  }

  function readFilters() {
    const f = {};
    $$('#filterGrid .fl-in').forEach(el => {
      const k = el.id.replace('f_', '');
      const v = el.value.trim();
      if (v !== '' && !isNaN(Number(v))) f[k] = Number(v);
    });
    f.mainBoardOnly = $('#sw_main').checked;
    f.excludeST = $('#sw_st').checked;
    f.excludeSuspend = $('#sw_susp').checked;
    return f;
  }

  async function runScreen() {
    $('#btnRun').disabled = true;
    $('#scrHint').textContent = '扫描中…';
    try {
      // 全市场快照超过 90 秒未更新则重新拉取，保证选股基于最新行情
      if (!S.universe.length || Date.now() - (S.universeTime || 0) > 90000) await loadUniverse();
      const f = readFilters();
      const st = SCR.STRATEGIES.find(x => x.id === S.activeStrategy);
      let hit = SCR.filter(S.universe, f);
      hit = SCR.score(hit.map(s => Object.assign({}, s)), st ? st.weights : null);
      hit.sort((a, b) => b.score - a.score);
      S.scrResult = hit;
      S.scrSort = { key: 'score', asc: false };
      renderResult();
      const scope = f.mainBoardOnly ? '沪深主板' : '全市场';
      $('#scrHint').textContent = '扫描 ' + S.universe.length + ' 只 → 命中 ' + hit.length + ' 只（范围：' + scope + (f.excludeST ? ' · 已剔除ST' : '') + '）';
      if (!hit.length) U.toast('没有股票满足当前条件，试着放宽一些', 'err');
    } catch (e) {
      U.toast('选股失败：' + e.message, 'err');
    } finally {
      $('#btnRun').disabled = false;
    }
  }

  const COLS = [
    { k: 'idx', t: '#', cls: 'l', w: 34 },
    { k: 'code', t: '代码', cls: 'l' },
    { k: 'name', t: '名称', cls: 'l' },
    { k: 'board', t: '板块', cls: 'l' },
    { k: 'price', t: '现价' },
    { k: 'chgPct', t: '涨跌幅%' },
    { k: 'turnover', t: '换手%' },
    { k: 'volRatio', t: '量比' },
    { k: 'amount', t: '成交额' },
    { k: 'amplitude', t: '振幅%' },
    { k: 'chg60', t: '60日%' },
    { k: 'pe', t: 'PE' },
    { k: 'pb', t: 'PB' },
    { k: 'mktCap', t: '总市值' },
    { k: 'mainNet', t: '主力净额' },
    { k: 'score', t: '评分' },
    { k: 'tags', t: '标签', cls: 'l' }
  ];

  function renderResult() {
    const box = $('#scrResult');
    const list = S.scrResult;
    if (!list.length) {
      box.innerHTML = '<div class="empty-state"><div class="big">∅</div><div>没有符合条件的股票</div>'
        + '<div style="margin-top:6px;font-size:11.5px">试试放宽条件，或换一个策略模板</div></div>';
      return;
    }
    const sorted = list.slice().sort((a, b) => {
      const k = S.scrSort.key;
      if (k === 'idx') return 0;
      let av = a[k], bv = b[k];
      if (k === 'tags') { av = (a.tags || []).length; bv = (b.tags || []).length; }
      if (typeof av === 'string') return S.scrSort.asc ? String(av).localeCompare(bv) : String(bv).localeCompare(av);
      av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv;
      return S.scrSort.asc ? av - bv : bv - av;
    });

    const avgChg = list.reduce((x, s) => x + (s.chgPct || 0), 0) / list.length;
    const upCount = list.filter(s => (s.chgPct || 0) > 0).length;

    let html = '<div class="result-bar">'
      + '<span class="rb-stat">命中 <b class="num">' + list.length + '</b> 只</span>'
      + '<span class="rb-stat">上涨 <b class="num" style="color:var(--up)">' + upCount + '</b> / 下跌 <b class="num" style="color:var(--down)">' + (list.length - upCount) + '</b></span>'
      + '<span class="rb-stat">平均涨跌 <b class="num ' + U.cls(avgChg) + '" style="color:' + U.color(avgChg) + '">' + U.pct(avgChg) + '</b></span>'
      + '<span class="rb-stat">平均评分 <b class="num">' + Math.round(list.reduce((x, s) => x + s.score, 0) / list.length) + '</b></span>'
      + '<span style="margin-left:auto;font-size:11px;color:var(--text-3)">点击表头排序 · 点击行跳转看盘 · 数据 ' + (useMock() ? '离线演示' : '实时') + '</span>'
      + '</div>';

    html += '<table class="result"><thead><tr>' + COLS.map(c =>
      '<th class="' + (c.cls || '') + (S.scrSort.key === c.k ? ' sorted' + (S.scrSort.asc ? ' asc' : '') : '') + '" data-k="' + c.k + '">' + c.t + '</th>'
    ).join('') + '</tr></thead><tbody>';

    sorted.slice(0, 500).forEach((s, i) => {
      const tags = (s.tags || []).map(t => '<span class="tag ' + t.c + '">' + t.x + '</span>').join('')
        + (s.techTags ? s.techTags.slice(0, 2).map(t => '<span class="tag tech">' + t + '</span>').join('') : '');
      html += '<tr data-code="' + s.code + '">'
        + '<td class="l num" style="color:var(--text-3)">' + (i + 1) + '</td>'
        + '<td class="l num">' + s.code + '</td>'
        + '<td class="l" style="font-weight:600">' + U.esc(s.name) + '</td>'
        + '<td class="l" style="color:var(--text-3);font-size:11px">' + SCR.boardOf(s.code) + '</td>'
        + '<td class="num ' + U.cls(s.chgPct) + '">' + U.n(s.price) + '</td>'
        + '<td class="num ' + U.cls(s.chgPct) + '" style="font-weight:700">' + U.pct(s.chgPct) + '</td>'
        + '<td class="num">' + U.n(s.turnover) + '</td>'
        + '<td class="num ' + ((s.volRatio || 0) > 1.5 ? 'up' : '') + '">' + U.n(s.volRatio) + '</td>'
        + '<td class="num">' + U.money(s.amount) + '</td>'
        + '<td class="num">' + U.n(s.amplitude) + '</td>'
        + '<td class="num ' + U.cls(s.chg60) + '">' + U.n(s.chg60) + '</td>'
        + '<td class="num">' + (s.pe != null && s.pe < 0 ? '亏损' : U.n(s.pe)) + '</td>'
        + '<td class="num">' + U.n(s.pb) + '</td>'
        + '<td class="num">' + U.money(s.mktCap) + '</td>'
        + '<td class="num ' + U.cls(s.mainNet) + '">' + U.money(s.mainNet) + '</td>'
        + '<td><span class="score-bar"><span class="num" style="font-weight:700">' + s.score + '</span>'
        + '<span class="score-track"><span class="score-fill" style="width:' + s.score + '%"></span></span></span></td>'
        + '<td class="l">' + tags + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  async function runDeepCheck() {
    if (!S.scrResult.length) { U.toast('请先执行一次选股', 'err'); return; }
    const btn = $('#btnDeep');
    btn.disabled = true;
    $('#scrProgress').style.display = '';
    const n = Math.min(30, S.scrResult.length);
    await SCR.deepCheck(S.scrResult, n, useMock(), (done, total) => {
      $('#scrProgressFill').style.width = (done / total * 100) + '%';
      $('#scrHint').textContent = '深度校验 ' + done + '/' + total + '（拉取日K并计算 MA / MACD / KDJ / RSI / 背离）';
    });
    S.scrResult.sort((a, b) => b.score - a.score);
    renderResult();
    $('#scrProgress').style.display = 'none';
    $('#scrProgressFill').style.width = '0';
    $('#scrHint').textContent = '已完成前 ' + n + ' 只的技术面深度校验，评分已融合技术分（快照 55% + 技术 45%）';
    btn.disabled = false;
    U.toast('深度技术校验完成', 'ok');
  }

  function exportCSV() {
    if (!S.scrResult.length) { U.toast('没有可导出的结果', 'err'); return; }
    const headers = ['序号', '代码', '名称', '板块', '现价', '涨跌幅%', '换手率%', '量比', '成交额(元)', '振幅%', '60日涨跌%', 'PE', 'PB', '总市值(元)', '主力净额(元)', '综合评分', '标签', '技术标签'];
    const rows = S.scrResult.map((s, i) => [
      i + 1, s.code, s.name, SCR.boardOf(s.code), s.price, s.chgPct, s.turnover, s.volRatio,
      s.amount, s.amplitude, s.chg60, s.pe, s.pb, s.mktCap, s.mainNet, s.score,
      (s.tags || []).map(t => t.x).join(' '), (s.techTags || []).join(' ')
    ]);
    const d = new Date();
    const ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    U.exportCSV('选股结果_' + ds + '.csv', headers, rows);
    U.toast('已导出 ' + rows.length + ' 条记录', 'ok');
  }

  /** 设定副图指标，并同步 X 关闭按钮的显隐 */
  function applySub(sub) {
    S.sub = sub;
    $$('#segSub .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.sub === sub));
    const close = $('#btnSubClose');
    if (close) close.classList.toggle('show', sub !== 'vol');
    if (S.klt !== 0) loadChart();
  }

  /* ============ 可拖动面板分隔条 ============ */
  function initResizers() {
    const left = $('.side-left');
    const resizer = $('#resizerLeft');
    if (!left || !resizer) return;

    const MIN = 168, MAX_RATIO = 0.45;
    let startX = 0, startW = 0, dragging = false;

    function clientX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
    function setWidth(w) {
      const max = Math.max(MIN, Math.floor(window.innerWidth * MAX_RATIO));
      w = Math.max(MIN, Math.min(max, w));
      left.style.flex = '0 0 ' + w + 'px';
      U.store.set('sideLeftWidth', w);
    }

    function start(e) {
      dragging = true;
      startX = clientX(e);
      startW = left.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      const dx = clientX(e) - startX;
      setWidth(startW + dx);
      setTimeout(() => CH.resize(), 0);
    }
    function stop() {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
    }

    resizer.addEventListener('mousedown', start);
    resizer.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchend', stop);

    const saved = U.store.get('sideLeftWidth');
    if (saved) setWidth(Number(saved));
  }

  /* ============ 事件绑定 ============ */
  function bindUI() {
    // 页面切换
    $$('.nav-tab').forEach(t => t.addEventListener('click', () => {
      S.page = t.dataset.page;
      $$('.nav-tab').forEach(x => x.classList.toggle('active', x === t));
      $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + S.page));
      if (S.page === 'market') setTimeout(() => CH.resize(), 60);
    }));

    // 榜单
    $$('.list-tab').forEach(t => t.addEventListener('click', () => {
      S.listTab = t.dataset.list; U.store.set('listTab', S.listTab); renderList();
    }));
    $('#quoteList').addEventListener('click', e => {
      const row = e.target.closest('.quote-row');
      if (!row) return;
      const s = S.universe.find(x => x.code === row.dataset.code);
      if (s) selectStock(s);
    });

    // 周期 / 主图 / 副图
    $('#segPeriod').addEventListener('click', e => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      $$('#segPeriod .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      S.klt = Number(b.dataset.klt);
      delete S.kcache['k' + S.klt];   // 切换周期强制拉取最新行情
      loadChart();
    });
    $('#segOverlay').addEventListener('click', e => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      $$('#segOverlay .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      S.overlay = b.dataset.ov;
      if (S.klt !== 0) loadChart();
    });
    $('#segSub').addEventListener('click', e => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      applySub(b.dataset.sub);
    });
    $('#btnSubClose').addEventListener('click', () => applySub('vol'));   // X 关闭副图指标

    // 竖参考线开关（可拖拽左右移动）
    $('#btnVline').addEventListener('click', () => {
      const b = $('#btnVline');
      const on = !b.classList.contains('active');
      b.classList.toggle('active', on);
      CH.toggleVLine(on);
    });

    $('#btnWatch').addEventListener('click', toggleWatch);

    // 顶栏
    $('#btnRefresh').addEventListener('click', async () => {
      $('#btnRefresh').disabled = true;
      await refreshVisible();
      if (S.current) {
        const nu = S.universe.find(s => s.code === S.current.code);
        if (nu) { S.current = nu; renderHead(nu); }
      }
      S.kcache = {};
      renderList(); loadIndexes(); loadSnapshot(); loadChart();
      $('#btnRefresh').disabled = false;
      U.toast('已刷新', 'ok', 1400);
    });
    $('#btnAuto').addEventListener('click', () => {
      S.auto = !S.auto;
      U.store.set('auto', S.auto);
      $('#btnAuto').classList.toggle('on', S.auto);
      U.toast(S.auto ? '自动刷新已开启（6 秒）' : '自动刷新已关闭', 'ok', 1600);
    });
    $('#btnTheme').addEventListener('click', () => {
      S.theme = S.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', S.theme);
      U.store.set('theme', S.theme);
      setTimeout(() => { loadChart(); renderList(); if (S.scrResult.length) renderResult(); }, 40);
    });

    // 搜索
    $('#searchInput').addEventListener('input', doSuggest);
    $('#searchInput').addEventListener('focus', doSuggest);
    $('#searchInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const first = $('#suggest .suggest-item[data-code]');
        if (first) first.click();
      } else if (e.key === 'Escape') $('#suggest').classList.remove('show');
    });
    $('#suggest').addEventListener('click', e => {
      const it = e.target.closest('.suggest-item'); if (!it || !it.dataset.code) return;
      const s = S.universe.find(x => x.code === it.dataset.code);
      if (s) { selectStock(s); $('#suggest').classList.remove('show'); $('#searchInput').value = ''; }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrap')) $('#suggest').classList.remove('show');
    });

    // 选股页
    $('#strategyGrid').addEventListener('click', e => {
      const c = e.target.closest('.strategy-card'); if (!c) return;
      applyStrategy(c.dataset.id);
    });
    $('#btnRun').addEventListener('click', runScreen);
    $('#btnDeep').addEventListener('click', runDeepCheck);
    $('#btnReset').addEventListener('click', () => {
      clearFilters();
      S.activeStrategy = null;
      $$('.strategy-card').forEach(c => c.classList.remove('active'));
      $('#sw_main').checked = true; $('#sw_st').checked = true; $('#sw_susp').checked = true;
      $('#scrHint').textContent = '条件已重置';
    });
    $('#btnExport').addEventListener('click', exportCSV);

    $('#scrResult').addEventListener('click', e => {
      const th = e.target.closest('th');
      if (th && th.dataset.k) {
        if (S.scrSort.key === th.dataset.k) S.scrSort.asc = !S.scrSort.asc;
        else S.scrSort = { key: th.dataset.k, asc: false };
        renderResult();
        return;
      }
      const tr = e.target.closest('tbody tr');
      if (tr && tr.dataset.code) {
        const s = S.universe.find(x => x.code === tr.dataset.code);
        if (s) {
          $$('.nav-tab').forEach(x => x.classList.toggle('active', x.dataset.page === 'market'));
          $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-market'));
          S.page = 'market';
          selectStock(s);
          setTimeout(() => CH.resize(), 60);
        }
      }
    });

    // 快捷键
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
      if (e.key === '1') $$('#segPeriod .seg-btn')[0].click();
      if (e.key === '2') $$('#segPeriod .seg-btn')[1].click();
      if (e.key === '3') $$('#segPeriod .seg-btn')[2].click();
    });

    initResizers();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
