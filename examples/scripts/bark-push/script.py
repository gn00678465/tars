# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "bark-push"
# summary = "用 Bark 推播一則通知到使用者的 iPhone"
# secret = "bark"
# domains = ["secret:url"]
# effects = "external-write"
# args = "--body <內文> [--title <標題>]"
# outputs = "成功時 stdout 印一行 JSON：{\"sent\": true}"
# exit = { 0 = "送出", 1 = "連不上 Bark 伺服器或伺服器出錯", 2 = "參數錯", 3 = "沒有金鑰、金鑰格式不符或 device key 被拒" }
# ///
import argparse, http.client, json, os, sys, urllib.error, urllib.parse, urllib.request


def main() -> int:
    p = argparse.ArgumentParser(prog="bark-push")
    p.add_argument("--body", required=True)
    p.add_argument("--title")
    a = p.parse_args()
    if not a.body.strip():
        p.error("--body 不能是空的")

    secret = os.environ.get("TARS_SECRET")
    if secret is None:
        print("沒有金鑰：請使用者執行 tars secret set bark", file=sys.stderr)
        return 3
    try:
        s = json.loads(secret)
        url, key = s["url"], s["key"]
        if not isinstance(url, str) or not isinstance(key, str) or not key:
            raise ValueError
        if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        print('金鑰格式不符，要是 {"url": "<Bark 伺服器的 http 或 https 網址>", "key": "<device key>"}', file=sys.stderr)
        return 3

    # bark-server 的 POST /push 收 JSON 時讀 body 裡的 device_key，key 不會出現在 URL 與紀錄裡。
    payload = {"device_key": key, "body": a.body}
    if a.title:
        payload["title"] = a.title
    req = urllib.request.Request(
        url.rstrip("/") + "/push",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            reply = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            message = str(json.load(e).get("message", ""))
        except (ValueError, AttributeError):
            message = ""
        message = message.replace(key, "<device key>")[:200]
        if e.code == 400:
            print(f"Bark 拒絕了這個 device key（HTTP 400）：{message}", file=sys.stderr)
            return 3
        print(f"Bark 回 HTTP {e.code}：{message}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
        print(f"連不上 Bark 伺服器：{getattr(e, 'reason', e)}", file=sys.stderr)
        return 1
    except ValueError:
        print("Bark 的回應不是 JSON", file=sys.stderr)
        return 1
    if not isinstance(reply, dict) or reply.get("code") != 200:
        print("Bark 的回應不是成功", file=sys.stderr)
        return 1
    print(json.dumps({"sent": True}))
    return 0


sys.exit(main())
