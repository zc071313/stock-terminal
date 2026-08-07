#!/usr/bin/env python3
"""
fetch_quotes.py — 从东方财富 push2.eastmoney.com 抓取自选股行情，
生成 data/quotes.json 供前端静态读取。

数据源：东方财富 stock/get API (JSON, 支持 HTTPS)
输出：data/quotes.json（含全量股票快照 + 指数数据）
"""

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# 配置
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MOCK_STOCKS_JS = os.path.join(PROJECT_DIR, "assets", "js", "mock_stocks.js")
QUOTES_JSON = os.path.join(PROJECT_DIR, "data", "quotes.json")

EM_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
EM_UT = "fa5fd1943c7b386f172d6893dbf28df9"
EM_FIELDS = "f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171,f172,f173"

# 指数 secid 映射
INDEX_SECIDS = {
    "1.000001": "上证指数",
    "0.399001": "深证成指",
    "0.399006": "创业板指",
    "1.000300": "沪深300",
}

BATCH_SIZE = 50  # 并行请求数
REQUEST_TIMEOUT = 15  # 秒
RETRY_COUNT = 2  # 重试次数


def parse_mock_stocks(path):
    """从 mock_stocks.js 提取股票列表 [{code, name, market}]"""
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 匹配 { code: 'XXXXXX', name: '名称', market: 0|1 }
    pattern = r"\{\s*code:\s*'(\d{6})'\s*,\s*name:\s*'(.+?)'\s*,\s*market:\s*(\d)\s*\}"
    matches = re.findall(pattern, content)

    stocks = []
    seen = set()
    for code, name, market in matches:
        if code not in seen:
            seen.add(code)
            stocks.append({"code": code, "name": name, "market": int(market)})
    return stocks


def fetch_stock(secid, timeout=REQUEST_TIMEOUT):
    """获取单只股票行情，返回原始 data dict，失败返回 None"""
    params = {
        "secid": secid,
        "fields": EM_FIELDS,
        "ut": EM_UT,
    }
    url = EM_QUOTE_URL

    for attempt in range(RETRY_COUNT + 1):
        try:
            resp = requests.get(
                url,
                params=params,
                timeout=timeout,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Referer": "https://quote.eastmoney.com/",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("data") and data["data"].get("f43") is not None:
                return data["data"]
        except Exception:
            if attempt < RETRY_COUNT:
                time.sleep(0.5)
    return None


def normalize(d):
    """东方财富字段 → 统一快照（与前端 api.js normalizeEm 逻辑一致）"""
    if not d or not d.get("f57") or d.get("f43") is None:
        return None

    code = d["f57"]
    market = 1 if code[0] in ("6", "9") else 0
    if isinstance(d.get("f59"), (int, float)):
        market = 1 if int(d["f59"]) == 2 else 0

    secid = f"{market}.{code}"

    def div(v, scale=100):
        if v is None:
            return None
        return v / scale

    price = div(d.get("f43"))
    preClose = div(d.get("f60"))
    if not price or price <= 0:
        return None

    high = div(d.get("f44"))
    low = div(d.get("f45"))
    open_ = div(d.get("f46"))

    amplitude = None
    if high is not None and low is not None and preClose and preClose > 0:
        amplitude = round(((high - low) / preClose) * 100, 2)

    return {
        "code": code,
        "name": d.get("f58", ""),
        "market": market,
        "secid": secid,
        "price": price,
        "open": open_,
        "preClose": preClose,
        "high": high,
        "low": low,
        "chg": div(d.get("f169")),
        "chgPct": div(d.get("f170")),
        "volume": (d.get("f47") or 0) * 100,
        "amount": d.get("f48") or 0,
        "amplitude": amplitude,
        "turnover": round(div(d.get("f168"), 100), 2) if d.get("f168") is not None else None,
        "pe": round(div(d.get("f162"), 100), 2) if d.get("f162") is not None else None,
        "pb": round(div(d.get("f167"), 100), 2) if d.get("f167") is not None else None,
        "volRatio": d.get("f173"),
        "mktCap": d.get("f116"),
        "floatCap": d.get("f117"),
        "bids": [],
        "asks": [],
        "limitUp": round(preClose * 1.1, 2) if preClose else None,
        "limitDown": round(preClose * 0.9, 2) if preClose else None,
        "chg60": None, "chgYtd": None, "mainNet": None,
        "peTtm": None, "speed": None,
        "_source": "em",
    }


def fetch_index(secid, name):
    """获取指数数据"""
    d = fetch_stock(secid)
    if not d:
        return None
    return {
        "name": d.get("f58") or name,
        "price": (d.get("f43") or 0) / 100 if d.get("f43") else None,
        "chg": (d.get("f169") or 0) / 100 if d.get("f169") else 0,
        "chgPct": (d.get("f170") or 0) / 100 if d.get("f170") else 0,
        "volume": d.get("f47") or 0,
        "amount": d.get("f48") or 0,
    }


def main():
    print("[fetch_quotes] 解析股票列表...")
    stocks = parse_mock_stocks(MOCK_STOCKS_JS)
    print(f"[fetch_quotes] 共 {len(stocks)} 只股票")

    # 构建 secid 列表
    secids = [f"{s['market']}.{s['code']}" for s in stocks]
    secid_map = {f"{s['market']}.{s['code']}": s for s in stocks}

    # 并行抓取股票行情
    print(f"[fetch_quotes] 开始并行抓取 {len(secids)} 只股票（并发={BATCH_SIZE}）...")
    results = {}
    failed = 0

    for i in range(0, len(secids), BATCH_SIZE):
        batch = secids[i : i + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
            futures = {executor.submit(fetch_stock, sid): sid for sid in batch}
            for future in as_completed(futures):
                sid = futures[future]
                try:
                    d = future.result()
                    if d:
                        results[sid] = d
                    else:
                        failed += 1
                except Exception:
                    failed += 1
        elapsed_pct = min(100, (i + len(batch)) * 100 // len(secids))
        print(f"[fetch_quotes] 进度: {elapsed_pct}% ({len(results)} 成功, {failed} 失败)")

    # 归一化数据
    snapshots = []
    for sid, d in results.items():
        s = normalize(d)
        if s:
            snapshots.append(s)

    print(f"[fetch_quotes] 归一化后共 {len(snapshots)} 条有效快照")

    # 抓取指数
    print("[fetch_quotes] 抓取指数数据...")
    indexes = []
    for secid, name in INDEX_SECIDS.items():
        idx = fetch_index(secid, name)
        if idx:
            indexes.append(idx)
    print(f"[fetch_quotes] 共 {len(indexes)} 条指数数据")

    # 组装输出
    output = {
        "updated": int(time.time()),
        "total": len(snapshots),
        "list": snapshots,
        "indexes": indexes,
    }

    # 写入 quotes.json
    os.makedirs(os.path.dirname(QUOTES_JSON), exist_ok=True)
    with open(QUOTES_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[fetch_quotes] 已写入 {QUOTES_JSON} ({len(json.dumps(output, ensure_ascii=False))} 字节)")

    if failed > 0:
        print(f"[fetch_quotes] 警告: {failed} 只股票抓取失败，已跳过")
        sys.exit(0)  # 部分成功不算失败

    return 0


if __name__ == "__main__":
    sys.exit(main())
