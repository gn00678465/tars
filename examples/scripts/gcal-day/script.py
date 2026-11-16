# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.tars]
# name = "gcal-day"
# summary = "列出使用者 Google 主日曆某一天的行程"
# secret = "gcal"
# domains = ["www.googleapis.com"]
# effects = "read-only"
# args = "--date <YYYY-MM-DD> [--tz <IANA 時區，預設 UTC>]"
# outputs = "成功時 stdout 印一行 JSON 陣列，照開始時間排序：[{\"start\": <RFC 3339 時間，全天行程是日期>, \"end\": <同上>, \"summary\": <標題>}]"
# exit = { 0 = "列出了（沒有行程時是 []）", 1 = "連不上 Google、Google 出錯或拒絕這個請求", 2 = "參數錯：日期、時區或 --api 不合法", 3 = "沒有金鑰，或 Google 不接受這個 access token" }
# ///
import argparse, datetime, http.client, json, os, sys, urllib.error, urllib.parse, urllib.request, zoneinfo

MAX_PAGES = 20


def when(value) -> str | None:
    # 全天行程只有 date，其他只有 dateTime。
    return (value.get("dateTime") or value.get("date")) if isinstance(value, dict) else None


def main() -> int:
    p = argparse.ArgumentParser(prog="gcal-day")
    p.add_argument("--date", required=True)
    p.add_argument("--tz", default="UTC")
    p.add_argument("--api", default="https://www.googleapis.com", help=argparse.SUPPRESS)
    a = p.parse_args()
    try:
        day = datetime.date.fromisoformat(a.date)
        tz = zoneinfo.ZoneInfo(a.tz)
        midnight = datetime.datetime.combine(day, datetime.time(), tz)
        next_midnight = datetime.datetime.combine(day + datetime.timedelta(days=1), datetime.time(), tz)
    except (ValueError, OverflowError):
        p.error("--date 要是 YYYY-MM-DD")
    except (zoneinfo.ZoneInfoNotFoundError, OSError):
        p.error("--tz 要是 IANA 時區名稱，例如 Asia/Taipei")
    api = urllib.parse.urlsplit(a.api)
    # access token 放在標頭裡，明文的 http 只留給測試用的本機假伺服器。
    if not api.hostname or not (api.scheme == "https" or (api.scheme == "http" and api.hostname == "127.0.0.1")):
        p.error("--api 要是有主機名稱的 https 網址")

    token = os.environ.get("TARS_SECRET")
    if not token:
        print("沒有金鑰：請使用者執行 tars secret login gcal", file=sys.stderr)
        return 3

    query = {
        "timeMin": midnight.isoformat(),
        "timeMax": next_midnight.isoformat(),
        "timeZone": a.tz,
        "singleEvents": "true",
        "orderBy": "startTime",
    }
    events = []
    for _ in range(MAX_PAGES):
        req = urllib.request.Request(
            a.api.rstrip("/") + "/calendar/v3/calendars/primary/events?" + urllib.parse.urlencode(query),
            headers={"Authorization": "Bearer " + token},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                page = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print("Google 不接受這個 access token（HTTP 401）", file=sys.stderr)
                return 3
            if e.code == 403:
                print("Google 拒絕了（HTTP 403）：授權的 scope 讀不到主日曆，或專案沒有啟用 Calendar API", file=sys.stderr)
                return 1
            print(f"Google 回 HTTP {e.code}", file=sys.stderr)
            return 1
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            print(f"連不上 Google：{getattr(e, 'reason', e)}", file=sys.stderr)
            return 1
        except ValueError:
            print("Google 的回應不是 JSON", file=sys.stderr)
            return 1
        if not isinstance(page, dict) or not isinstance(page.get("items", []), list):
            print("Google 的回應不是行程列表", file=sys.stderr)
            return 1
        for item in page.get("items", []):
            if not isinstance(item, dict):
                continue
            events.append({"start": when(item.get("start")), "end": when(item.get("end")), "summary": item.get("summary", "")})
        next_page = page.get("nextPageToken")
        if not next_page:
            print(json.dumps(events, ensure_ascii=False, separators=(",", ":")))
            return 0
        query["pageToken"] = next_page
    print(f"行程超過 {MAX_PAGES} 頁，沒有列完", file=sys.stderr)
    return 1


sys.exit(main())
