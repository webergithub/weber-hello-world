#!/usr/bin/env python3
"""CineRoute 的 Python 检索执行器。

用法：Node 把一个 JSON 作业从 stdin 喂进来，这里把结果 JSON 写到 stdout。
不接受命令行参数里的查询词——那条路迟早会有人拼进 shell 里去。

    echo '{"url":"https://…","headers":{…}}' | python3 tools/serp_search.py

为什么这一步值得交给 Python
--------------------------
不是因为 Python 会写请求（Node 也会），是因为**它能换掉 TLS 指纹**。

Google、Cloudflare 这类不只看 User-Agent 和请求头。TLS 握手时客户端提供的
密码套件顺序、扩展列表、椭圆曲线偏好合起来是一个指纹（JA3/JA4），
Node 的 undici 有它自己那一套，跟任何一个真浏览器都对不上——请求头调得
再像也没用，握手那一刻就已经被认出来了。

`curl_cffi` 能直接冒充 Chrome 的握手。这是纯 Node 做不到的事，
也是这条路真正的价值所在。装上它这条路才有意义：

    pip install curl_cffi

没装也能跑：按 curl_cffi → httpx → requests → urllib 的顺序挑一个能用的，
用了哪个会在返回里的 `via` 字段说明，不含糊。

两种应答形状
------------
1. **传输模式**（默认，本脚本就是这个）：只回原始字节，解析交给 Node。

       {"ok": true, "status": 200, "final_url": "…",
        "content_type": "text/html; charset=gbk",
        "body_b64": "…", "via": "curl_cffi/chrome124"}

   之所以回 base64 而不是文本：编码判定在 Node 那边（见 serp/charset.js），
   百度返回 GBK 时这一步不能先按 UTF-8 解一遍——那就毁了。

2. **自解析模式**：脚本自己出结果，Node 原样收下。想接 ddgs 或自己的
   爬虫就改成这个形状：

       {"ok": true, "results": [{"url": …, "title": …, "snippet": …}],
        "related": ["…"], "via": "ddgs"}

出错就 {"ok": false, "error": "人能看懂的一句话"}，**不要**抛异常了事：
上层要把原因显示给用户，栈回溯不是给用户看的。
"""

import base64
import json
import sys
import time

TIMEOUT_DEFAULT = 15.0


def _fetch_curl_cffi(url, headers, timeout):
    """最优解：连 TLS 握手一起冒充 Chrome。"""
    from curl_cffi import requests as cffi  # noqa: PLC0415

    # impersonate 是这个库存在的全部理由。版本号跟着库走，
    # 写死一个太老的反而更可疑，所以用它的通用别名。
    r = cffi.get(
        url, headers=headers, timeout=timeout,
        impersonate="chrome", allow_redirects=True,
    )
    return r.status_code, str(r.url), r.headers.get("content-type", ""), r.content, \
        f"curl_cffi/{getattr(r, 'impersonate', 'chrome')}"


def _fetch_httpx(url, headers, timeout):
    import httpx  # noqa: PLC0415

    with httpx.Client(follow_redirects=True, timeout=timeout) as c:
        r = c.get(url, headers=headers)
        return r.status_code, str(r.url), r.headers.get("content-type", ""), r.content, "httpx"


def _fetch_requests(url, headers, timeout):
    import requests  # noqa: PLC0415

    r = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    return r.status_code, r.url, r.headers.get("content-type", ""), r.content, "requests"


def _fetch_urllib(url, headers, timeout):
    """兜底：标准库，什么都不用装。

    要自己解压。Node 那边发的 accept-encoding 带 br，而标准库不认——
    原样转发会拿回一堆没法解的字节，还看不出哪里错了，所以这里改写成
    只要 gzip/deflate。
    """
    import gzip  # noqa: PLC0415
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415
    import zlib  # noqa: PLC0415

    h = {k: v for k, v in headers.items() if k.lower() != "accept-encoding"}
    h["accept-encoding"] = "gzip, deflate"

    req = urllib.request.Request(url, headers=h, method="GET")
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)  # noqa: S310
    except urllib.error.HTTPError as e:
        # 4xx/5xx 的响应体照样要——拦截判定就靠它认出验证码页
        resp = e

    raw = resp.read()
    enc = (resp.headers.get("content-encoding") or "").lower()
    if "gzip" in enc:
        raw = gzip.decompress(raw)
    elif "deflate" in enc:
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)

    return resp.status, resp.geturl(), resp.headers.get("content-type", ""), raw, "urllib"


# 顺序即优先级。curl_cffi 排第一是因为只有它能改 TLS 指纹。
TRANSPORTS = [
    ("curl_cffi", _fetch_curl_cffi),
    ("httpx", _fetch_httpx),
    ("requests", _fetch_requests),
    ("urllib", _fetch_urllib),
]


def available_transport():
    """挑一个装了的。返回 (名字, 函数)，urllib 永远兜得住。"""
    import importlib.util  # noqa: PLC0415

    for name, fn in TRANSPORTS:
        if name == "urllib" or importlib.util.find_spec(name) is not None:
            return name, fn
    return "urllib", _fetch_urllib


def run(job):
    url = job.get("url")
    if not url:
        return {"ok": False, "error": "作业里没有 url"}

    headers = job.get("headers") or {}
    timeout = float(job.get("timeoutMs") or TIMEOUT_DEFAULT * 1000) / 1000.0

    name, fn = available_transport()
    started = time.monotonic()
    try:
        status, final_url, ctype, body, via = fn(url, headers, timeout)
    except Exception as err:  # noqa: BLE001 - 什么都不能漏出去，上层要拿去显示
        return {
            "ok": False,
            "via": name,
            "error": f"{type(err).__name__}: {err}",
        }

    return {
        "ok": True,
        "status": status,
        "final_url": final_url,
        "content_type": ctype,
        # base64 而不是文本：编码由 Node 判（百度会返 GBK），
        # 这里先解一次就把它毁了
        "body_b64": base64.b64encode(body).decode("ascii"),
        "via": via,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def main():
    try:
        job = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as err:
        json.dump({"ok": False, "error": f"作业不是合法 JSON：{err}"}, sys.stdout)
        return 2

    # --probe：只回报这台机器上能用哪个传输，不发请求。设置页用它做自检。
    if job.get("probe"):
        import importlib.util  # noqa: PLC0415

        name, _ = available_transport()
        json.dump({
            "ok": True,
            "via": name,
            "available": [n for n, _f in TRANSPORTS
                          if n == "urllib" or importlib.util.find_spec(n) is not None],
            "python": sys.version.split()[0],
        }, sys.stdout)
        return 0

    json.dump(run(job), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
