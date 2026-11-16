# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "download"
# summary = "把一個 http 或 https 網址的檔案下載到 --out 目錄"
# domains = ["*"]
# effects = "local-write"
# args = "<網址> [--name <檔名>]；呼叫時要加 --out <目錄>；大檔案加長 --timeout"
# outputs = "成功時 stdout 印一行 JSON：{\"path\": <存檔的絕對路徑>, \"bytes\": <大小>, \"sha256\": <雜湊>}"
# exit = { 0 = "存好了", 1 = "下載失敗", 2 = "參數錯：網址不是 http 或 https，或檔名不合法", 3 = "呼叫時沒加 --out", 4 = "檔案超過 100 MiB", 5 = "--out 裡已有同名的檔案" }
# ///
import argparse, hashlib, json, os, shutil, sys, tempfile, urllib.error, urllib.parse, urllib.request

LIMIT = 100 * 1024 * 1024
CHUNK = 1024 * 1024


def file_name(url: str, name: str | None) -> str | None:
    if name is None:
        name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]) or "download"
    if "/" in name or "\\" in name or "\0" in name or name.startswith(".") or len(name.encode()) > 255:
        return None
    return name


def main() -> int:
    p = argparse.ArgumentParser(prog="download")
    p.add_argument("url")
    p.add_argument("--name")
    a = p.parse_args()
    if urllib.parse.urlsplit(a.url).scheme.lower() not in ("http", "https"):
        p.error("網址要是 http 或 https")
    name = file_name(a.url, a.name)
    if name is None:
        p.error("檔名不能含 / 或 \\，不能以 . 開頭；用 --name 指定一個檔名")
    out = os.environ.get("TARS_OUT")
    if not out:
        print("沒有 TARS_OUT：呼叫時要加 --out <目錄>", file=sys.stderr)
        return 3
    path = os.path.join(out, name)
    if os.path.lexists(path):
        print(f"{name} 已經存在，換一個 --name", file=sys.stderr)
        return 5

    # 先下載到沙盒自己的暫存檔，完整了才放進 --out：逾時被殺或超過上限時，--out 不會留下半個檔案。
    with tempfile.TemporaryFile() as tmp:
        digest, size = hashlib.sha256(), 0
        try:
            with urllib.request.urlopen(a.url, timeout=30) as r:
                length = r.headers.get("Content-Length")
                if length is not None and length.isdigit() and int(length) > LIMIT:
                    print(f"檔案有 {int(length)} bytes，超過 100 MiB", file=sys.stderr)
                    return 4
                while chunk := r.read(CHUNK):
                    size += len(chunk)
                    if size > LIMIT:
                        print("檔案超過 100 MiB", file=sys.stderr)
                        return 4
                    digest.update(chunk)
                    tmp.write(chunk)
        except urllib.error.HTTPError as e:
            print(f"伺服器回 HTTP {e.code}", file=sys.stderr)
            return 1
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"下載失敗：{getattr(e, 'reason', e)}", file=sys.stderr)
            return 1
        try:
            f = open(path, "xb")
        except FileExistsError:
            print(f"{name} 已經存在，換一個 --name", file=sys.stderr)
            return 5
        with f:
            tmp.seek(0)
            shutil.copyfileobj(tmp, f)
    print(json.dumps({"path": path, "bytes": size, "sha256": digest.hexdigest()}))
    return 0


sys.exit(main())
