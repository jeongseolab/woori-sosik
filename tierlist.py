"""나만의 티어표와 개인 지표.

재료는 최근 20판(솔로랭크·자유랭크·일반) 이다.
  1. 내 기록: 그 20판에서 챔피언별로 몇 판 해서 몇 판 이겼나, KDA 는 어떤가
  2. 내 티어 구간의 메타: 실버라면 실버 판에서 OP.GG 가 그 챔피언을 몇 티어로 보나

점수 = 보정 승률 + KDA 가산 + 판수 가산 + 메타 가산.

보정 승률을 쓰는 이유:
  1판 1승(100%) 챔피언이 6판 4승(67%) 챔피언보다 위에 서면 안 된다.
  그래서 모든 챔피언에 "가상의 50% 판" 을 몇 판 섞어 둔다.
  판수가 적을수록 50% 쪽으로 끌려가고, 많이 한 챔피언일수록 제 승률이 드러난다.
판수 가산: 20판 안에서 자주 고른 챔피언은 그만큼 손에 익은 챔피언이다.

OP 는 점수 1등 딱 한 명. 나머지는 점수 순서대로 1~5티어에 고르게 나눈다.
"""
import asyncio
from collections import Counter, defaultdict

import opgg

# 통계에 쓰는 판 수
RECENT_GAMES = 20
# 가상으로 섞는 50% 판의 수. 클수록 판수가 적은 챔피언을 더 믿지 않는다
PRIOR_GAMES = 4
# 한 판 더 할 때마다 붙는 점수와 그 한도(판)
PLAY_BONUS, PLAY_BONUS_CAP = 0.01, 8

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
        "updated_at": profile.get("updated_at"),
    }


async def recent(game_name: str, tagline: str, fresh=False):
    """프로필과 최근 20판. 새 판을 받아 쌓은 뒤 쌓인 것에서 최근 20판을 꺼낸다."""
    profile, _ = await asyncio.gather(
        opgg.profile(game_name, tagline, fresh),
        opgg.matches(game_name, tagline, fresh))
    return profile, opgg.stored_matches(profile["puuid"], RECENT_GAMES)


def _reason(c, bracket_ko):
    """왜 이 자리인지 한 줄로."""
    bits = ["%d판 %d승" % (c["play"], c["win"]), "KDA %.1f" % c["kda"]]
    if c.get("meta_tier"):
        where = bracket_ko + " 구간" if bracket_ko else "전체 구간"
        bits.append("%s %d티어" % (where, c["meta_tier"]))
    return ", ".join(bits)


async def build(game_name: str, tagline: str, fresh=False):
    """티어표 한 장을 만든다."""
    (profile, rows), index, lanes = await asyncio.gather(
        recent(game_name, tagline, fresh), opgg.champion_index(), opgg.main_lanes())

    rank = rank_of(profile)
    # OP.GG 티어 이름을 그대로 소문자로 쓰면 구간 필터가 된다(silver, gold ...)
    bracket = rank["tier"].lower() if rank else None
    bracket_ko = rank["tier_ko"] if rank else None

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
        champs.append({
            "id": int(champ_id) if champ_id else name, "key": info.get("key"), "name": name,
            "image": CHAMP_IMG % info["key"] if info.get("key") else None,
            "lane": lane, "lane_ko": LANE_KO.get(lane),
            "play": t["games"], "win": t["wins"], "win_rate": t["win_rate"],
            "kda": t["kda"], "cs_per_min": t["cs_per_min"],
        })

    metas = await asyncio.gather(*[
        opgg.champion_meta(c["key"], c["lane"], bracket) if c["key"] else _none()
        for c in champs])

    for c, meta in zip(champs, metas):
        meta = meta or {}
        c["meta_tier"] = meta.get("tier")
        c["meta_rank"] = meta.get("rank")
        c["meta_win_rate"] = meta.get("win_rate")

        adjusted = (c["win"] + PRIOR_GAMES * 0.5) / (c["play"] + PRIOR_GAMES)
        # KDA 3 을 보통으로 보고, 1 차이마다 1.5%p. 너무 튀지 않게 0~6 에서 자른다
        kda_bonus = (min(max(c["kda"], 0), 6) - 3) * 0.015
        play_bonus = min(c["play"], PLAY_BONUS_CAP) * PLAY_BONUS
        # 메타 3티어를 보통으로 보고, 1티어 차이마다 2%p
        meta_bonus = (3 - c["meta_tier"]) * 0.02 if c["meta_tier"] else 0
        c["score"] = round(adjusted + kda_bonus + play_bonus + meta_bonus, 4)
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
        "op": op,
        "tiers": tiers,
        "champion_count": len(champs),
        "games": len(rows),
        "target_games": RECENT_GAMES,
    }


async def _none():
    return None
