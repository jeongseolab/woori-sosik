"""그룹방 순위: 스킬샷 피하기 기록과 주간 랭킹.

둘 다 OP.GG 를 부르지 않는다. 이미 쌓아 둔 것(dodge_runs, match_rows) 만 읽어서 빠르다.

주간은 한국 시각 월요일 0시부터다.
주간 랭킹의 경기는 match_rows 에 쌓인 판만 센다. Tier.gg 에서 누군가 그 사람의 전적을
불러올 때마다 쌓이므로(그룹방을 열면 방 사람 전부) 방을 자주 볼수록 정확해진다.
"""
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import opgg
import perf
from database import get_conn

KST = timezone(timedelta(hours=9))

# 한 판을 몇 초까지 인정할지. 이보다 긴 기록은 받지 않는다
RUN_MAX_SEC = 60 * 60
# 서버가 잰 시간보다 이만큼(초) 길어도 봐준다(네트워크가 늦게 닿는 몫)
RUN_SLACK_SEC = 2.0
# 1초도 못 버틴 판은 저장하지 않는다
RUN_MIN_MS = 1000
# 주간 순위에 들려면 이번 주에 이만큼은 해야 한다(1판 운으로 1등이 되지 않게)
WEEK_MIN_GAMES = 3


def week_start(now=None):
    """이번 주 월요일 0시(한국 시각)."""
    now = (now or datetime.now(KST)).astimezone(KST)
    monday = now - timedelta(days=now.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


# ── 스킬샷 피하기 ────────────────────────────────────────
# 판을 시작할 때 표를 끊어 두고, 끝났을 때 "그 사이 시간" 보다 긴 기록은 받지 않는다.
# 주소만 알면 아무 숫자나 보낼 수 있으니, 적어도 그만큼은 실제로 기다려야 하게 만든다.
# 서버가 다시 켜지면 표가 사라지지만, 그 판 하나만 저장이 안 될 뿐이다
_runs = {}
_runs_lock = threading.Lock()


def start_run(account_id: int) -> str:
    token = secrets.token_urlsafe(16)
    now = time.monotonic()
    with _runs_lock:
        # 오래된 표는 버린다
        for key in [k for k, (_, at) in _runs.items() if now - at > RUN_MAX_SEC + 60]:
            del _runs[key]
        _runs[token] = (account_id, now)
    return token


def finish_run(account_id: int, token: str, ms: int, dodged: int):
    """기록을 확인하고 저장한다. 믿을 수 없는 기록이면 ValueError."""
    with _runs_lock:
        got = _runs.pop(token or "", None)
    if got is None or got[0] != account_id:
        raise ValueError("이 판의 시작 기록을 찾지 못했어요. 다시 해 주세요")
    elapsed = time.monotonic() - got[1]
    if not 0 <= ms <= RUN_MAX_SEC * 1000 or ms > (elapsed + RUN_SLACK_SEC) * 1000:
        raise ValueError("기록을 확인하지 못했어요")

    before = my_dodge(account_id)
    if ms >= RUN_MIN_MS:
        conn = get_conn()
        conn.execute("INSERT INTO dodge_runs (account_id, ms, dodged, played_at) VALUES (?, ?, ?, ?)",
                     (account_id, ms, max(0, int(dodged or 0)), time.time()))
        conn.commit()
        conn.close()
    after = my_dodge(account_id)
    return {**after, "ms": ms, "saved": ms >= RUN_MIN_MS,
            "new_best": ms >= RUN_MIN_MS and ms > (before["best"] or 0),
            "new_week_best": ms >= RUN_MIN_MS and ms > (before["week_best"] or 0)}


def _dodge_stats(account_ids, since=None):
    """{account_id: (최고 ms, 판수)}. since 를 주면 그 뒤의 판만."""
    if not account_ids:
        return {}
    marks = ",".join("?" * len(account_ids))
    sql = "SELECT account_id, MAX(ms) AS best, COUNT(*) AS n FROM dodge_runs WHERE account_id IN (%s)" % marks
    params = list(account_ids)
    if since is not None:
        sql += " AND played_at >= ?"
        params.append(since)
    conn = get_conn()
    rows = conn.execute(sql + " GROUP BY account_id", tuple(params)).fetchall()
    conn.close()
    return {r["account_id"]: (r["best"], r["n"]) for r in rows}


def my_dodge(account_id: int):
    total = _dodge_stats([account_id]).get(account_id, (None, 0))
    week = _dodge_stats([account_id], week_start().timestamp()).get(account_id, (None, 0))
    return {"best": total[0], "runs": total[1], "week_best": week[0], "week_runs": week[1]}


def dodge_board(accounts):
    """방 사람들의 스킬샷 피하기 순위. accounts 는 auth.find_account 결과 목록."""
    ids = [a["id"] for a in accounts]
    total = _dodge_stats(ids)
    week = _dodge_stats(ids, week_start().timestamp())
    # slot: 방에 들어온 순서. 화면이 사람마다 같은 색을 쓰는 데 쓴다
    rows = [{"account_id": a["id"], "riot_id": a["riot_id"], "game_name": a["game_name"], "slot": i,
             "best": total.get(a["id"], (None, 0))[0], "runs": total.get(a["id"], (None, 0))[1],
             "week_best": week.get(a["id"], (None, 0))[0]} for i, a in enumerate(accounts)]
    # 기록 있는 사람을 기록 순으로, 없는 사람은 뒤에
    rows.sort(key=lambda r: (r["best"] is None, -(r["best"] or 0)))
    return {"since": week_start().isoformat(), "members": rows}


# ── 주간 랭킹 ────────────────────────────────────────────

def _played_at(row):
    """경기 시각을 datetime 으로. 모르면 None."""
    text = row.get("created_at")
    if not text:
        return None
    text = str(text).strip()
    try:
        if text.replace(".", "", 1).isdigit():
            # 숫자로 오면 초(또는 밀리초) 단위 시각
            num = float(text)
            return datetime.fromtimestamp(num / 1000 if num > 1e11 else num, KST)
        at = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=KST)


def _week_line(acc, since):
    rows = [r for r in opgg.stored_matches(acc["puuid"])
            if perf.counts(r) and (at := _played_at(r)) is not None and at >= since]
    n = len(rows)
    line = {"account_id": acc["id"], "riot_id": acc["riot_id"], "game_name": acc["game_name"],
            "games": n, "wins": 0, "win_rate": None, "play": None, "kda": None, "deaths_avg": None}
    if not n:
        return line
    wins = sum(r["result"] == "WIN" for r in rows)
    k = sum(r["kills"] or 0 for r in rows)
    d = sum(r["deaths"] or 0 for r in rows)
    a = sum(r["assists"] or 0 for r in rows)
    play = perf.summarize([perf.game(r) for r in rows])
    line.update(wins=wins, win_rate=round(wins / n, 3), kda=round((k + a) / max(d, 1), 2),
                deaths_avg=round(d / n, 1), play=play["overall"] if play else None)
    return line


def weekly(accounts):
    """이번 주 방 사람들의 성적. 순위를 매기는 건 화면이 한다(항목마다 기준이 달라서)."""
    since = week_start()
    lines = [_week_line(a, since) for a in accounts]
    dodge = _dodge_stats([a["id"] for a in accounts], since.timestamp())
    for line in lines:
        line["dodge_best"] = dodge.get(line["account_id"], (None, 0))[0]
    return {"since": since.isoformat(), "until": (since + timedelta(days=7)).isoformat(),
            "min_games": WEEK_MIN_GAMES, "members": lines}
