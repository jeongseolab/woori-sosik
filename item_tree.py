"""챔피언의 템트리(OP.GG 가 집계한 순서) 받아 오기. items.plan_build 의 뼈대가 된다.

OP.GG MCP 의 lol_get_champion_analysis 에서 아이템 칸만 받는다.
  starter  시작 아이템(도란 + 물약 ...)        core   코어 3개(순서대로)        boots  신발
  fourth / fifth / sixth  4·5·6번째 후보 [(번호, 픽률)]. 여기서는 상황에 맞는 것을 고른다(items.plan_build)

- 서버(main.py) 와 오버레이(tools/item_overlay.py) 가 같이 쓴다. 오버레이는 DB 없이 돌아서
  받은 것은 tools/.cache/item_trees.json 에 12시간 들고 있는다(게임마다 OP.GG 에 묻지 않게)
- OP.GG 가 안 되면(인터넷이 없거나 거절) None. 그러면 items.py 가 스탯 값만으로 빌드를 짠다
"""
import json
import logging
import os
import threading
import time

import httpx

import opgg

HERE = os.path.dirname(os.path.abspath(__file__))


def _cache_dir():
    """템트리를 둘 곳. Tier.gg 앱(PyInstaller 로 묶은 것) 은 풀린 폴더가 끝나면 지워져서 사용자 폴더에 둔다."""
    import sys
    if not getattr(sys, "frozen", False):
        return os.path.join(HERE, "tools", ".cache")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/TierGG")
    return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "TierGG")


CACHE = os.path.join(_cache_dir(), "item_trees.json")
TTL = 12 * 60 * 60
FAIL_TTL = 5 * 60           # 실패도 잠깐 기억한다(게임 중 2초마다 다시 묻지 않게)
LANES = ("top", "jungle", "mid", "adc", "support")

_FIELDS = ["data.starter_items.{ids[]}", "data.core_items.{ids[],pick_rate}", "data.boots.{ids[]}",
           "data.fourth_items[].{ids[],pick_rate}", "data.fifth_items[].{ids[],pick_rate}",
           "data.sixth_items[].{ids[],pick_rate}"]

_lock = threading.Lock()
_mem = None
_failed = {}
log = logging.getLogger("tiergg.tree")


def _load():
    global _mem
    if _mem is None:
        try:
            with open(CACHE, encoding="utf-8") as f:
                _mem = json.load(f)
        except (OSError, ValueError):
            _mem = {}
    return _mem


def _save():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_mem, f, ensure_ascii=False)
    os.replace(tmp, CACHE)


def _call(tool, arguments):
    """opgg.call 의 동기판(오버레이는 이벤트 루프가 없다). 대답 읽기는 opgg.parse 를 그대로 쓴다."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    r = httpx.post(opgg.MCP_URL, json=payload, headers={"Accept": "application/json, text/event-stream"}, timeout=30)
    body = r.text
    if not body.lstrip().startswith("{"):
        lines = [l[5:].strip() for l in body.splitlines() if l.startswith("data:")]
        body = lines[-1] if lines else ""
    env = json.loads(body)
    res = env.get("result") or {}
    texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
    if "error" in env or res.get("isError") or not texts:
        raise opgg.OpggError("OP.GG 가 요청을 거절했습니다")
    return opgg.parse(texts[0])


def _keys():
    """챔피언 번호 → OP.GG 이름표(UPPER_SNAKE). 롤 별칭(MonkeyKing) 과 OP.GG 이름(WUKONG) 이 달라서 번호로 맞춘다."""
    hit = _load().get("keys")
    if hit and time.time() - hit["at"] < 7 * TTL:
        return hit["v"]
    got = _call("lol_list_champions", {"lang": "en_US", "desired_output_fields": ["data.champions[].{champion_id,key}"]})
    keys = {str(c["champion_id"]): c["key"] for c in opgg._dig(got, "data", "champions") or []
            if isinstance(c, dict) and c.get("champion_id") and c.get("key")}
    _mem["keys"] = {"at": time.time(), "v": keys}
    return keys


def _ids(x):
    return [int(i) for i in (x or {}).get("ids") or [] if isinstance(i, (int, float))]


def _opts(rows):
    out = []
    for r in rows or []:
        ids = _ids(r)
        if ids:
            out.append((ids[0], float(r.get("pick_rate") or 0)))
    return out


def shape(data):
    """OP.GG 대답의 data → 템트리 dict. 시험에서 손으로 만든 대답도 이걸 거친다."""
    return {"starter": _ids(data.get("starter_items")), "core": _ids(data.get("core_items")),
            "boots": _ids(data.get("boots"))[:1], "fourth": _opts(data.get("fourth_items")),
            "fifth": _opts(data.get("fifth_items")), "sixth": _opts(data.get("sixth_items")),
            "source": "opgg"}


def fetch(champion_id, lane, fresh=False):
    """(챔피언 번호, 라인) → 템트리 dict 또는 None. 라인을 모르면 None(어느 라인 빌드인지 모른다)."""
    if lane not in LANES:
        return None
    key = "%d:%s" % (int(champion_id), lane)
    with _lock:
        mem = _load()
        hit = mem.get(key)
        if hit and not fresh and time.time() - hit["at"] < TTL:
            return hit["v"]
        if time.time() - _failed.get(key, 0) < FAIL_TTL:
            return hit["v"] if hit else None
        try:
            name = _keys().get(str(int(champion_id)))
            if not name:
                raise opgg.OpggError("OP.GG 에 없는 챔피언")
            got = _call("lol_get_champion_analysis", {"game_mode": "ranked", "champion": name, "position": lane,
                                                      "lang": "en_US", "desired_output_fields": _FIELDS})
            tree = shape(opgg._dig(got, "data") or {})
            if not tree["core"]:
                raise opgg.OpggError("빌드가 비어 있음")
        except Exception as e:          # 인터넷·OP.GG 문제는 무엇이든 "템트리 없음" 으로(앱이 죽지 않게)
            log.warning("OP.GG 템트리를 못 받음 %s: %r", key, e)
            _failed[key] = time.time()
            return hit["v"] if hit else None      # 오래된 것이라도 있으면 그걸
        mem[key] = {"at": time.time(), "v": tree}
        try:
            _save()
        except OSError:
            pass
        return tree
