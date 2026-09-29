"""OP.GG 에서 데이터 받아 오기.

OP.GG 가 공개한 MCP 서버(https://mcp-api.op.gg/mcp) 에 JSON-RPC 로 묻는다.
키는 필요 없지만, 원래 AI 도구용이라 너무 자주 부르지 않는다.
  - 받은 것은 api_cache 표에 잠깐 들고 있다가 다시 쓴다
  - 동시에 나가는 요청은 몇 개로 묶어 둔다

대답은 JSON 이 아니라 이런 모양의 글자다.

    class Summoner: game_name,tagline
    class TierInfo: tier,division

    Summoner("Hide on bush","KR1",TierInfo("CHALLENGER",1))

맨 위 class 줄이 칸 이름표이고, 아래가 실제 값이다. parse() 가 이걸 dict 로 바꾼다.
"""
import asyncio
import json
import re
import time

import httpx

import perf
from database import MATCH_EXTRA_COLUMNS, get_conn

MCP_URL = "https://mcp-api.op.gg/mcp"
REGION = "kr"
LANG = "ko_KR"

# 얼마나 오래 들고 있을지(초)
PROFILE_TTL = 10 * 60          # 전적은 금방 바뀐다
META_TTL = 12 * 60 * 60        # 챔피언 통계는 하루에 몇 번이면 충분하다
CHAMPION_LIST_TTL = 24 * 60 * 60

# OP.GG 에 한꺼번에 몇 개까지 물어볼지.
# 4 였을 때 그룹방(4명, 요청 30~40개) 이 줄을 서느라 13초 걸렸다.
# 너무 올리면 OP.GG 가 거절할 수 있어서 8 에서 멈춘다
_PARALLEL = 8


class OpggError(Exception):
    """OP.GG 가 거절했거나 닿지 않았을 때."""


class NotFound(OpggError):
    """그런 소환사가 없을 때."""


class Renamed(NotFound):
    """가입해 둔 닉네임이 지금은 없거나 다른 사람 것일 때. 그 사람이 닉네임을 바꾼 것이다."""

    def __init__(self, text="LOL 닉네임이 바뀐 것 같아요. 새 닉네임으로 다시 로그인하면 반영돼요"):
        super().__init__(text)


# ── 대답 읽기 ────────────────────────────────────────────

_NUMBER = re.compile(r"-?\d+(\.\d+)?([eE][-+]?\d+)?")
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def parse(text: str):
    """OP.GG 의 글자 대답을 dict/list 로 바꾼다.

    이름표(class 줄) 가 없는 대답도 가끔 온다. 그럴 땐 JSON 이면 풀고, 아니면 글자 그대로 준다.
    """
    if not text.startswith("class "):
        try:
            return json.loads(text)
        except ValueError:
            return text
    head, _, body = text.partition("\n\n")
    fields = {}
    for line in head.splitlines():
        if line.startswith("class "):
            name, _, names = line[6:].partition(":")
            fields[name.strip()] = [n.strip() for n in names.split(",")]
    try:
        return _Reader(body.strip(), fields).value()
    except (IndexError, ValueError):
        # 잘린 대답 등. 500 으로 터지지 않고 "OP.GG 문제" 로 알려 준다
        raise OpggError("OP.GG 대답을 읽지 못했습니다")


class _Reader:
    def __init__(self, text, fields):
        self.s = text
        self.i = 0
        self.fields = fields

    def _skip(self):
        while self.i < len(self.s) and self.s[self.i] in " \n\r\t":
            self.i += 1

    def _expect(self, ch):
        self._skip()
        if self.s[self.i] != ch:
            raise OpggError("OP.GG 대답을 읽지 못했습니다")
        self.i += 1

    def _items(self, close):
        """',' 로 나뉜 값들을 close 글자가 나올 때까지 읽는다."""
        out = []
        self._skip()
        if self.s[self.i] == close:
            self.i += 1
            return out
        while True:
            out.append(self.value())
            self._skip()
            ch = self.s[self.i]
            self.i += 1
            if ch == close:
                return out
            if ch != ",":
                raise OpggError("OP.GG 대답을 읽지 못했습니다")

    def value(self):
        self._skip()
        ch = self.s[self.i]

        if ch == '"':
            # 따옴표 안의 \" 는 끝이 아니다. 끝을 찾은 뒤 JSON 규칙으로 푼다
            j = self.i + 1
            while self.s[j] != '"':
                j += 2 if self.s[j] == "\\" else 1
            raw = self.s[self.i:j + 1]
            self.i = j + 1
            return json.loads(raw)

        if ch == "[":
            self.i += 1
            return self._items("]")

        m = _NUMBER.match(self.s, self.i)
        if m:
            self.i = m.end()
            return float(m.group(0)) if (m.group(1) or m.group(2)) else int(m.group(0))

        m = _WORD.match(self.s, self.i)
        if not m:
            raise OpggError("OP.GG 대답을 읽지 못했습니다")
        word = m.group(0)
        self.i = m.end()
        if word in ("null", "None"):
            return None
        if word in ("true", "True"):
            return True
        if word in ("false", "False"):
            return False

        # 이름( ... ) 은 class 줄의 이름표를 붙여 dict 로 만든다
        self._expect("(")
        values = self._items(")")
        return dict(zip(self.fields.get(word, []), values))


# ── 부르기 ───────────────────────────────────────────────

# 연결과 줄 세우기는 이벤트 루프에 묶여 있어서 루프마다 따로 둔다.
# (서버는 루프가 하나라 사실상 한 벌이지만, 시험할 때는 루프가 여러 번 바뀐다)
_per_loop = {}


def _http():
    loop = asyncio.get_running_loop()
    if loop not in _per_loop:
        _per_loop.clear()
        _per_loop[loop] = (httpx.AsyncClient(timeout=httpx.Timeout(40.0)),
                           asyncio.Semaphore(_PARALLEL))
    return _per_loop[loop]


async def call(tool: str, arguments: dict):
    """OP.GG 도구 하나를 불러서 읽은 결과를 돌려준다."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": tool, "arguments": arguments}}
    client, gate = _http()
    async with gate:
        try:
            res = await client.post(
                MCP_URL, json=payload,
                headers={"Accept": "application/json, text/event-stream"})
        except httpx.HTTPError:
            raise OpggError("OP.GG 에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요")

    body = res.text
    # 가끔 스트림 모양(data: {...}) 으로 온다. 그럴 땐 data 줄만 꺼낸다
    if not body.lstrip().startswith("{"):
        lines = [l[5:].strip() for l in body.splitlines() if l.startswith("data:")]
        body = lines[-1] if lines else ""
    try:
        envelope = json.loads(body)
    except ValueError:
        raise OpggError("OP.GG 가 알 수 없는 대답을 보냈습니다")

    if "error" in envelope:
        error = envelope["error"]
        message = str(error.get("message", "") if isinstance(error, dict) else error)
        if "not found" in message.lower():
            raise NotFound("그런 소환사를 찾지 못했습니다")
        raise OpggError("OP.GG 가 요청을 거절했습니다: " + message[:120])

    result = envelope.get("result") or {}
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    if result.get("isError") or not texts:
        message = texts[0] if texts else ""
        if "not found" in message.lower():
            raise NotFound("그런 소환사를 찾지 못했습니다")
        raise OpggError("OP.GG 가 요청을 거절했습니다")
    return parse(texts[0])


# ── 잠깐 들고 있기 ───────────────────────────────────────

def _cache_get(key, ttl):
    conn = get_conn()
    row = conn.execute("SELECT value, saved_at FROM api_cache WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row and time.time() - row["saved_at"] < ttl:
        return json.loads(row["value"])
    return None


def _cache_put(key, value):
    conn = get_conn()
    conn.execute(
        "INSERT INTO api_cache (key, value, saved_at) VALUES (?, ?, ?)"
        " ON CONFLICT (key) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at",
        (key, json.dumps(value, ensure_ascii=False), time.time()),
    )
    conn.commit()
    conn.close()


# 지금 OP.GG 에 물어보고 있는 것. 같은 걸 또 물으면 새로 보내지 않고 이 대답을 같이 기다린다.
# 그룹방에서 여럿이 같은 챔피언을 하면 같은 통계를 동시에 여러 번 물어보던 것을 막는다
_in_flight = {}


async def _cached(key, ttl, fetch, fresh=False):
    if not fresh:
        hit = _cache_get(key, ttl)
        if hit is not None:
            return hit
    loop = asyncio.get_running_loop()
    slot = (id(loop), key)
    waiting = _in_flight.get(slot)
    if waiting is not None:
        return await asyncio.shield(waiting)
    task = loop.create_task(_fetch_and_store(key, fetch))
    _in_flight[slot] = task
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            _in_flight.pop(slot, None)
        else:
            task.add_done_callback(lambda _t: _in_flight.pop(slot, None))


async def _fetch_and_store(key, fetch):
    value = await fetch()
    _cache_put(key, value)
    return value


def _dig(obj, *path):
    for p in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(p)
    return obj


# ── 소환사 ───────────────────────────────────────────────

_PROFILE_FIELDS = [
    "data.summoner.{game_name,tagline,puuid,level,profile_image_url,updated_at}",
    "data.summoner.league_stats[].{game_type,win,lose}",
    "data.summoner.league_stats[].tier_info.{tier,division,lp}",
]


async def profile(game_name: str, tagline: str, fresh=False):
    """프로필: 이름, 레벨, 아이콘, 랭크."""
    async def fetch():
        got = await call("lol_get_summoner_profile", {
            "game_name": game_name, "tag_line": tagline, "region": REGION,
            "lang": LANG, "desired_output_fields": _PROFILE_FIELDS})
        s = _dig(got, "data", "summoner")
        if not s or not s.get("puuid"):
            raise NotFound("그런 소환사를 찾지 못했습니다")
        return s

    key = "profile:" + (game_name + "#" + tagline).replace(" ", "").lower()
    return await _cached(key, PROFILE_TTL, fetch, fresh)


async def profile_of(game_name: str, tagline: str, puuid: str | None, fresh=False):
    """profile 과 같다. puuid 를 주면 지금 그 이름이 정말 그 사람인지도 본다.

    확인하지 않으면 누가 닉네임을 바꾼 뒤 다른 사람이 옛 닉네임을 가져갔을 때
    엉뚱한 사람의 전적이 이 사람 이름으로 나온다.
    """
    try:
        p = await profile(game_name, tagline, fresh)
    except Renamed:
        raise
    except NotFound:
        if puuid:
            raise Renamed() from None
        raise
    if puuid and p["puuid"] != puuid:
        raise Renamed()
    return p


_MATCH_FIELDS = [
    "data.game_history[].{id,created_at,game_type,game_length_second}",
    "data.game_history[].average_tier_info.{tier}",
    "data.game_history[].teams[].key",
    "data.game_history[].teams[].game_stat.{champion_kill,gold_earned}",
    "data.game_history[].participants[].{champion_id,champion_name,position,team_key}",
    "data.game_history[].participants[].summoner.{puuid}",
    "data.game_history[].participants[].stats."
    "{result,kill,death,assist,op_score,op_score_rank,minion_kill,neutral_minion_kill,"
    "gold_earned,total_damage_dealt_to_champions,ward_place,vision_wards_bought_in_game,"
    "largest_killing_spree}",
    "data.game_history[].participants[].stats.op_score_timeline[].{score,second}",
]


def _early_score(timeline):
    """분 단위 OP.GG 평점에서 초반(14분 무렵) 값을 고른다. 없으면 None."""
    points = [p for p in timeline or [] if isinstance(p, dict)
              and isinstance(p.get("score"), (int, float)) and isinstance(p.get("second"), (int, float))]
    if not points:
        return None
    # 14분이 안 돼서 끝난 판이면 가장 늦은 값을 쓴다
    before = [p for p in points if p["second"] <= perf.EARLY_SEC]
    pick = max(before, key=lambda p: p["second"]) if before else min(points, key=lambda p: p["second"])
    return float(pick["score"])


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


async def matches(game_name: str, tagline: str, fresh=False):
    """최근 20판. 받은 판은 match_rows 에도 쌓아 둔다."""
    async def fetch():
        got = await call("lol_list_summoner_matches", {
            "game_name": game_name, "tag_line": tagline, "region": REGION,
            "lang": LANG, "limit": 20, "desired_output_fields": _MATCH_FIELDS})
        rows = []
        for g in _dig(got, "data", "game_history") or []:
            teams = {t.get("key"): (t.get("game_stat") or {}) for t in g.get("teams") or []
                     if isinstance(t, dict)}
            # 이 도구는 본인 한 명의 기록만 준다
            for p in g.get("participants") or []:
                stats = p.get("stats") or {}
                team = teams.get(p.get("team_key")) or {}
                wards = _num(stats.get("ward_place"))
                if wards is not None:
                    wards += _num(stats.get("vision_wards_bought_in_game")) or 0
                rows.append({
                    "puuid": _dig(p, "summoner", "puuid"),
                    "game_id": g.get("id"),
                    "created_at": g.get("created_at"),
                    "game_type": g.get("game_type"),
                    "champion": p.get("champion_name"),
                    "champion_id": p.get("champion_id"),
                    "cs": (stats.get("minion_kill") or 0) + (stats.get("neutral_minion_kill") or 0),
                    "gold": _num(stats.get("gold_earned")),
                    "damage": _num(stats.get("total_damage_dealt_to_champions")),
                    "wards": wards,
                    "spree": _num(stats.get("largest_killing_spree")),
                    "op_rank": _num(stats.get("op_score_rank")),
                    "early_score": _early_score(stats.get("op_score_timeline")),
                    "team_kills": _num(team.get("champion_kill")),
                    "team_gold": _num(team.get("gold_earned")),
                    "avg_tier": _dig(g, "average_tier_info", "tier"),
                    "position": (p.get("position") or "").lower() or None,
                    "team_key": p.get("team_key"),
                    "result": stats.get("result"),
                    "kills": stats.get("kill") or 0,
                    "deaths": stats.get("death") or 0,
                    "assists": stats.get("assist") or 0,
                    "op_score": stats.get("op_score"),
                    "length_sec": g.get("game_length_second"),
                })
        _store_matches(rows)
        return rows

    key = "matches:" + (game_name + "#" + tagline).replace(" ", "").lower()
    return await _cached(key, PROFILE_TTL, fetch, fresh)


_BASE_COLUMNS = ("puuid", "game_id", "created_at", "game_type", "champion", "position",
                 "team_key", "result", "kills", "deaths", "assists", "op_score", "length_sec")


def _store_matches(rows):
    extra = tuple(MATCH_EXTRA_COLUMNS)
    columns = _BASE_COLUMNS + extra
    sql = ("INSERT INTO match_rows (%s) VALUES (%s)"
           # 예전에 칸이 적을 때 저장한 판이면 새 칸을 채워 넣는다
           " ON CONFLICT (puuid, game_id) DO UPDATE SET %s"
           % (", ".join(columns), ", ".join("?" * len(columns)),
              ", ".join("%s = excluded.%s" % (c, c) for c in extra + ("op_score",))))
    conn = get_conn()
    for r in rows:
        if not r["puuid"] or not r["game_id"]:
            continue
        conn.execute(sql, tuple(r.get(c) for c in columns))
    conn.commit()
    conn.close()


# 통계에 쓰는 모드: 솔로랭크, 자유랭크, 일반(교차 선택).
# 칼바람·아레나 등은 라인과 챔피언 성적의 의미가 달라서 뺀다
RIFT_TYPES = ("SOLORANKED", "FLEXRANKED", "NORMAL")
QUEUE_KO = {"SOLORANKED": "솔로랭크", "FLEXRANKED": "자유랭크", "NORMAL": "일반"}


def stored_matches(puuid: str, limit: int | None = None):
    """지금까지 쌓아 둔 이 사람의 협곡 경기(RIFT_TYPES). 최근 것이 먼저.

    OP.GG 는 모드를 가리지 않고 최근 20판만 주므로, 칼바람이 섞이면 한 번에는
    20판이 안 찬다. 그래서 받은 판을 쌓아 두고 여기서 최근 것부터 채운다.
    """
    sql = ("SELECT * FROM match_rows WHERE puuid = ? AND game_type IN (?, ?, ?)"
           " ORDER BY created_at DESC")
    params = (puuid,) + RIFT_TYPES
    if limit:
        sql += " LIMIT ?"
        params += (limit,)
    conn = get_conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── 챔피언 ───────────────────────────────────────────────

async def champion_index():
    """챔피언 번호 -> {key, name}. key 는 이미지 주소와 통계 조회에 쓴다."""
    async def fetch():
        got = await call("lol_list_champions", {
            "lang": LANG, "desired_output_fields": ["data.champions[].{champion_id,key,name}"]})
        return {str(c["champion_id"]): {"key": c["key"], "name": c.get("name")}
                for c in _dig(got, "data", "champions") or []
                if isinstance(c, dict) and c.get("champion_id") and c.get("key")}
    return await _cached("champions:" + LANG, CHAMPION_LIST_TTL, fetch)


_LANES = ("top", "jungle", "mid", "adc", "support")


async def main_lanes():
    """챔피언 이름 -> 가장 많이 가는 라인. 내 경기에 그 챔피언이 없을 때 쓴다."""
    async def fetch():
        got = await call("lol_list_lane_meta_champions", {
            "position": "all", "lang": LANG,
            "desired_output_fields": ["data.positions.%s[].{champion,play}" % l for l in _LANES]})
        best = {}
        for lane in _LANES:
            for c in _dig(got, "data", "positions", lane) or []:
                name, play = c.get("champion"), c.get("play") or 0
                if name and play > best.get(name, ("", -1))[1]:
                    best[name] = (lane, play)
        return {name: lane for name, (lane, _) in best.items()}
    return await _cached("lanes:" + LANG, META_TTL, fetch)


async def champion_meta(champion_key: str, lane: str, tier: str | None):
    """그 티어 구간에서 이 챔피언이 어떤지. OP.GG 가 매긴 티어(1이 최고)와 승률.

    tier 가 None 이면 전체 구간. 실패하면 None 을 돌려준다(티어표는 이것 없이도 만든다).
    """
    async def fetch():
        args = {"game_mode": "ranked", "champion": champion_key.upper(),
                "position": lane, "lang": LANG,
                "desired_output_fields": ["data.summary.average_stats.{win_rate,pick_rate,play,tier,rank}"]}
        if tier:
            args["tier"] = tier
        got = await call("lol_get_champion_analysis", args)
        return _dig(got, "data", "summary", "average_stats") or {}

    key = "meta:%s:%s:%s" % (champion_key, lane, tier or "all")
    try:
        return await _cached(key, META_TTL, fetch)
    except OpggError:
        return None
