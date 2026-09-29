"""나만의 티어표와 개인 지표.

재료는 최근 20판(솔로랭크·자유랭크·일반) 이다.

20판으로는 승률이 팀운에 크게 흔들린다. 그래서 중심은 "판마다 얼마나 잘했나"
(플레이 점수, perf.py: 전투·성장·스노우볼·딜·시야·OP.GG 평점을 라인 기준과 비교) 이고,
승률은 작은 보정으로만 쓴다.

점수(0~100 근처) = 보정 플레이 점수 + 승률 보정 + 판수 가산 + 메타 가산.

보정 플레이 점수:
  1판 잘한 챔피언이 5판 꾸준히 잘한 챔피언보다 위에 서지 않게,
  모든 챔피언에 "보통(50점) 판" 을 몇 판 섞어 둔다.
승률 보정: 50% 에서 10%p 벗어날 때마다 1점. 최대 ±5점
판수 가산: 20판 안에서 자주 고른 챔피언은 그만큼 손에 익은 챔피언이다.
메타 가산: 내 티어 구간에서 OP.GG 가 매긴 챔피언 티어. 3티어 기준 한 칸에 1.5점

OP 는 점수 1등 딱 한 명. 나머지는 점수 순서대로 1~5티어에 고르게 나눈다.
"""
import asyncio
from collections import Counter, defaultdict

import opgg
import perf

# 통계에 쓰는 판 수
RECENT_GAMES = 20
# 가상으로 섞는 보통(50점) 판의 수. 클수록 판수가 적은 챔피언을 더 믿지 않는다
PRIOR_GAMES = 2
# 한 판 더 할 때마다 붙는 점수와 그 한도(판)
PLAY_BONUS, PLAY_BONUS_CAP = 0.75, 8

# 이미지 주소. key 는 OP.GG 챔피언 키(예: MonkeyKing)
CHAMP_IMG = "https://opgg-static.akamaized.net/meta/images/lol/latest/champion/%s.png"

TIER_KO = {"IRON": "아이언", "BRONZE": "브론즈", "SILVER": "실버", "GOLD": "골드",
           "PLATINUM": "플래티넘", "EMERALD": "에메랄드", "DIAMOND": "다이아몬드",
           "MASTER": "마스터", "GRANDMASTER": "그랜드마스터", "CHALLENGER": "챌린저"}
LANE_KO = {"top": "탑", "jungle": "정글", "mid": "미드", "adc": "원딜", "support": "서폿"}


def rank_of(profile):
    """솔로랭크가 있으면 솔로랭크, 없으면 자유랭크. 둘 다 없으면 None."""
    stats = {s.get("game_type"): s for s in profile.get("league_stats") or []}
    for kind in ("SOLORANKED", "FLEXRANKED"):
        s = stats.get(kind)
        tier = ((s or {}).get("tier_info") or {}).get("tier")
        if tier:
            info = s["tier_info"]
            return {"queue": "솔로랭크" if kind == "SOLORANKED" else "자유랭크",
                    "tier": tier, "tier_ko": TIER_KO.get(tier, tier),
                    "division": info.get("division"), "lp": info.get("lp"),
                    "win": s.get("win") or 0, "lose": s.get("lose") or 0}
    return None


TIER_ORDER = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD",
              "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"]


def real_tier(profile, rows):
    """이 사람의 실제 티어. 공식 티어표와 플레이 점수 기준을 이 티어에 맞춘다.

    1. 솔로랭크 티어  2. 없으면 자유랭크 티어
    3. 둘 다 없으면(언랭) 최근 판들의 평균 티어 - 그 사람이 실제로 섞여 노는 수준이다
    4. 그것도 모르면 None (전체 구간)
    """
    rank = rank_of(profile)
    if rank:
        return {"tier": rank["tier"], "tier_ko": rank["tier_ko"], "source": rank["queue"]}
    seen = [TIER_ORDER.index(t) for t in (r.get("avg_tier") for r in rows) if t in TIER_ORDER]
    if seen:
        tier = TIER_ORDER[round(sum(seen) / len(seen))]
        return {"tier": tier, "tier_ko": TIER_KO[tier], "source": "최근 판 평균"}
    return None


def _kda(k, d, a):
    return round((k + a) / max(d, 1), 2)


def _totals(rows):
    """판들을 합친 승률·KDA·분당 CS."""
    n = len(rows)
    if not n:
        return {"games": 0, "wins": 0, "win_rate": None, "kda": None, "cs_per_min": None}
    wins = sum(r["result"] == "WIN" for r in rows)
    k = sum(r["kills"] or 0 for r in rows)
    d = sum(r["deaths"] or 0 for r in rows)
    a = sum(r["assists"] or 0 for r in rows)
    # CS 를 모르는 판(예전에 저장한 판)은 분당 CS 계산에서 뺀다
    with_cs = [r for r in rows if r.get("cs") is not None and r.get("length_sec")]
    minutes = sum(r["length_sec"] for r in with_cs) / 60
    return {"games": n, "wins": wins, "win_rate": round(wins / n, 3),
            "kda": _kda(k, d, a),
            "cs_per_min": round(sum(r["cs"] for r in with_cs) / minutes, 1) if minutes else None}


def summary(profile, rows):
    """그룹방에서 나란히 놓고 볼 개인 지표. rows 는 최근 20판."""
    bracket = (real_tier(profile, rows) or {}).get("tier")
    play = perf.summarize([perf.game(r, bracket) for r in rows if perf.counts(r)])
    lanes = Counter(r["position"] for r in rows if r.get("position") in LANE_KO)
    main_lane = lanes.most_common(1)[0][0] if lanes else None
    queues = Counter(r["game_type"] for r in rows)
    return {
        "riot_id": profile.get("game_name", "") + "#" + profile.get("tagline", ""),
        "game_name": profile.get("game_name"),
        "tagline": profile.get("tagline"),
        "icon": profile.get("profile_image_url"),
        "level": profile.get("level"),
        "rank": rank_of(profile),
        **_totals(rows),
        "queues": {opgg.QUEUE_KO[q]: queues[q] for q in opgg.RIFT_TYPES if queues[q]},
        "main_lane": main_lane,
        "main_lane_ko": LANE_KO.get(main_lane),
        "play": play,
        "updated_at": profile.get("updated_at"),
    }


async def recent(game_name: str, tagline: str, fresh=False, puuid=None):
    """프로필과 최근 20판. 새 판을 받아 쌓은 뒤 쌓인 것에서 최근 20판을 꺼낸다.

    puuid 를 주면 그 이름이 아직 그 사람인지 확인한다(opgg.profile_of).
    """
    profile, _ = await asyncio.gather(
        opgg.profile_of(game_name, tagline, puuid, fresh),
        opgg.matches(game_name, tagline, fresh))
    return profile, opgg.stored_matches(profile["puuid"], RECENT_GAMES)


def _reason(c, bracket_ko):
    """왜 이 자리인지 한 줄로. 가장 잘한 영역을 앞에 둔다."""
    bits = []
    if c.get("perf"):
        bits.append("플레이 %d점" % c["perf"]["overall"])
        areas = {n: v for n, v in c["perf"]["areas"].items() if v is not None}
        if areas:
            best = max(areas, key=areas.get)
            bits.append("%s %d" % (perf.AREA_KO[best], areas[best]))
    bits.append("%d판 %d승" % (c["play"], c["win"]))
    if c.get("meta_tier"):
        where = bracket_ko + " 공식" if bracket_ko and c.get("meta_scope") == "bracket" else "전체 구간 공식"
        bits.append("%s %d티어" % (where, c["meta_tier"]))
    return ", ".join(bits)


async def build(game_name: str, tagline: str, fresh=False, puuid=None):
    """티어표 한 장을 만든다. puuid 는 가입한 사람일 때 본인 확인용."""
    (profile, rows), index, lanes = await asyncio.gather(
        recent(game_name, tagline, fresh, puuid), opgg.champion_index(), opgg.main_lanes())

    real = real_tier(profile, rows)
    # OP.GG 티어 이름을 그대로 소문자로 쓰면 구간 필터가 된다(silver, gold ...)
    bracket = real["tier"].lower() if real else None
    bracket_ko = real["tier_ko"] if real else None

    key_by_name = {v["name"]: k for k, v in index.items()}
    by_champ = defaultdict(list)
    for r in rows:
        by_champ[r["champion"]].append(r)

    champs = []
    for name, games in by_champ.items():
        champ_id = next((g["champion_id"] for g in games if g.get("champion_id")), None) \
            or key_by_name.get(name)
        info = index.get(str(champ_id)) or {}
        played = Counter(g["position"] for g in games if g.get("position") in LANE_KO)
        lane = played.most_common(1)[0][0] if played else lanes.get(name) or "mid"
        t = _totals(games)
        scored = [perf.game(g, real["tier"] if real else None) for g in games if perf.counts(g)]
        champs.append({
            "perf": perf.summarize(scored),
            "_perf_sum": sum(s["overall"] for s in scored if s and s["overall"] is not None),
            "_perf_n": sum(1 for s in scored if s and s["overall"] is not None),
            "id": int(champ_id) if champ_id else name, "key": info.get("key"), "name": name,
            "image": CHAMP_IMG % info["key"] if info.get("key") else None,
            "lane": lane, "lane_ko": LANE_KO.get(lane),
            "play": t["games"], "win": t["wins"], "win_rate": t["win_rate"],
            "kda": t["kda"], "cs_per_min": t["cs_per_min"],
        })

    async def official(c):
        """내 티어 구간의 공식 티어. 못 받으면 전체 구간 것을 쓰고 그렇다고 표시한다."""
        if not c["key"]:
            return None, None
        if bracket:
            got = await opgg.champion_meta(c["key"], c["lane"], bracket)
            if got and got.get("tier"):
                return got, "bracket"
        got = await opgg.champion_meta(c["key"], c["lane"], None)
        return (got, "all") if got and got.get("tier") else (None, None)

    metas = await asyncio.gather(*[official(c) for c in champs])

    for c, (meta, scope) in zip(champs, metas):
        meta = meta or {}
        c["meta_tier"] = meta.get("tier")
        c["meta_rank"] = meta.get("rank")
        c["meta_win_rate"] = meta.get("win_rate")
        c["meta_scope"] = scope

        # 판마다의 플레이 점수 평균. 판이 적으면 보통(50) 쪽으로 당긴다
        adjusted = (c.pop("_perf_sum") + PRIOR_GAMES * 50) / (c.pop("_perf_n") + PRIOR_GAMES)
        # 20판 승률은 팀운이 커서 작게만 반영한다
        win_adj = max(-5.0, min(5.0, (c["win_rate"] - 0.5) * 10)) if c["win_rate"] is not None else 0
        play_bonus = min(c["play"], PLAY_BONUS_CAP) * PLAY_BONUS
        meta_bonus = (3 - c["meta_tier"]) * 1.5 if c["meta_tier"] else 0
        c["score"] = round(adjusted + win_adj + play_bonus + meta_bonus, 1)
        c["reason"] = _reason(c, bracket_ko)

    champs.sort(key=lambda c: (c["score"], c["play"]), reverse=True)

    op = champs[0] if champs else None
    rest = champs[1:]
    tiers = {str(t): [] for t in range(1, 6)}
    n = len(rest)
    for i, c in enumerate(rest):
        # 5개보다 적으면 1티어부터 하나씩, 많으면 순서대로 5등분
        tier = i + 1 if n < 5 else 1 + i * 5 // n
        c["tier"] = tier
        tiers[str(tier)].append(c)

    return {
        "player": summary(profile, rows),
        "bracket": bracket_ko,
        "bracket_source": real["source"] if real else None,
        "op": op,
        "tiers": tiers,
        "champion_count": len(champs),
        "games": len(rows),
        "target_games": RECENT_GAMES,
    }


async def _none():
    return None
