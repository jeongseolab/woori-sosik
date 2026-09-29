"""한 판의 플레이를 점수로 본다.

20판으로는 승률이 운에 크게 흔들린다(팀운, 트롤 한 명). 그래서 이긴 판인지보다
"그 판에서 내가 얼마나 잘했나" 를 본다.

지표마다 그 라인의 보통 수준(기준값) 과 견줘서 0~100 점으로 바꾼다. 50 이 보통이다.
  - 서폿의 분당 CS 8 과 원딜의 분당 CS 8 은 뜻이 다르다 -> 라인별 기준값
  - 브론즈 판과 다이아 판의 CS 는 수준이 다르다 -> 그 판의 평균 티어로 기준값을 늘리고 줄임

지표(영역):
  전투      KDA, 킬 관여율
  성장      분당 CS, 팀 골드 중 내 몫 (서폿은 CS 대신 골드 몫만)
  스노우볼  초반(14분) OP.GG 평점, 최다 연속 킬
  딜        분당 챔피언 피해량
  시야      분당 와드 설치 + 제어 와드 구매
  OP.GG     OP.GG 가 매긴 그 판 평점(0~10)

라인마다 중요한 영역이 달라서 합칠 때 비중을 다르게 준다(서폿은 시야, 원딜은 딜·성장).
기준값은 에메랄드 구간 평균을 어림한 값이다. 정밀한 통계가 아니라 잣대로 쓴다.
"""

# ── 기준값 (에메랄드 구간 어림값) ─────────────────────────
CS_PER_MIN = {"top": 7.0, "jungle": 6.0, "mid": 7.4, "adc": 7.8, "support": 1.3}
GOLD_SHARE = {"top": 0.21, "jungle": 0.20, "mid": 0.22, "adc": 0.235, "support": 0.135}
DMG_PER_MIN = {"top": 700, "jungle": 550, "mid": 800, "adc": 820, "support": 400}
KILL_PART = {"top": 0.45, "jungle": 0.58, "mid": 0.52, "adc": 0.55, "support": 0.60}
KDA = {"top": 2.3, "jungle": 2.8, "mid": 2.6, "adc": 2.6, "support": 3.2}
WARDS_PER_MIN = {"top": 0.45, "jungle": 0.55, "mid": 0.45, "adc": 0.45, "support": 1.3}

# 판의 평균 티어에 따라 CS·딜·시야 기준을 늘리고 줄인다
TIER_FACTOR = {"IRON": 0.75, "BRONZE": 0.80, "SILVER": 0.86, "GOLD": 0.90,
               "PLATINUM": 0.95, "EMERALD": 1.0, "DIAMOND": 1.04, "MASTER": 1.07,
               "GRANDMASTER": 1.08, "CHALLENGER": 1.10}

# 라인별 비중. 각 줄의 합은 1
WEIGHTS = {
    "top":     {"combat": .25, "growth": .20, "snowball": .20, "damage": .20, "vision": .05, "opgg": .10},
    "jungle":  {"combat": .30, "growth": .15, "snowball": .20, "damage": .10, "vision": .10, "opgg": .15},
    "mid":     {"combat": .25, "growth": .20, "snowball": .20, "damage": .20, "vision": .05, "opgg": .10},
    "adc":     {"combat": .20, "growth": .25, "snowball": .15, "damage": .25, "vision": .05, "opgg": .10},
    "support": {"combat": .35, "growth": .05, "snowball": .10, "damage": .10, "vision": .30, "opgg": .10},
}

AREAS = ("combat", "growth", "snowball", "damage", "vision", "opgg")
AREA_KO = {"combat": "전투", "growth": "성장", "snowball": "스노우볼",
           "damage": "딜", "vision": "시야", "opgg": "OP.GG 평점"}

# 이보다 짧은 판은 다시하기(리메이크) 로 보고 뺀다
MIN_GAME_SEC = 5 * 60
# 스노우볼에서 "초반" 으로 보는 시각
EARLY_SEC = 14 * 60


def _pts(value, base, gain):
    """기준값과의 비율을 0~100 점으로. 기준과 같으면 50, 비율이 1 늘 때마다 gain 점."""
    if value is None or not base:
        return None
    return max(0.0, min(100.0, 50 + (value / base - 1) * gain))


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def counts(row):
    """점수에 넣을 판인지. 다시하기처럼 너무 짧은 판은 뺀다."""
    return (row.get("length_sec") or 0) >= MIN_GAME_SEC


def game(row, bracket=None):
    """한 판 -> 영역별 점수와 종합 점수(0~100). 모르는 값은 None."""
    minutes = (row.get("length_sec") or 0) / 60
    if minutes <= 0:
        return None
    lane = row.get("position") if row.get("position") in WEIGHTS else "mid"
    tier = (row.get("avg_tier") or bracket or "EMERALD").upper()
    f = TIER_FACTOR.get(tier, 1.0)

    k, d, a = row.get("kills") or 0, row.get("deaths") or 0, row.get("assists") or 0
    team_kills = row.get("team_kills")
    team_gold = row.get("team_gold")

    kda = (k + a) / max(d, 1)
    kp = (k + a) / team_kills if team_kills else None
    combat = _mean([_pts(kda, KDA[lane], 50), _pts(kp, KILL_PART[lane], 150)])

    cs = row.get("cs")
    cs_pts = _pts(cs / minutes, CS_PER_MIN[lane] * f, 150) if cs is not None and lane != "support" else None
    gold = row.get("gold")
    share = gold / team_gold if gold is not None and team_gold else None
    growth = _mean([cs_pts, _pts(share, GOLD_SHARE[lane], 200)])

    early = row.get("early_score")
    spree = row.get("spree")
    spree_pts = None if spree is None else min(100.0, 30 + spree * 10)
    snowball = _mean([None if early is None else max(0.0, min(100.0, early * 10)), spree_pts])

    dmg = row.get("damage")
    damage = _pts(dmg / minutes, DMG_PER_MIN[lane] * f, 100) if dmg is not None else None

    wards = row.get("wards")
    vision = _pts(wards / minutes, WARDS_PER_MIN[lane] * f, 80) if wards is not None else None

    op = row.get("op_score")
    opgg = max(0.0, min(100.0, op * 10)) if op is not None else None

    areas = {"combat": combat, "growth": growth, "snowball": snowball,
             "damage": damage, "vision": vision, "opgg": opgg}

    # 모르는 영역은 빼고, 남은 비중으로 다시 나눈다
    w = WEIGHTS[lane]
    known = {n: v for n, v in areas.items() if v is not None}
    total_w = sum(w[n] for n in known)
    overall = sum(v * w[n] for n, v in known.items()) / total_w if total_w else None

    return {"areas": areas, "overall": overall, "lane": lane,
            "kp": kp, "gold_share": share,
            "dmg_per_min": dmg / minutes if dmg is not None else None}


def summarize(games):
    """여러 판의 점수를 평균낸다. games 는 game() 결과 목록."""
    games = [g for g in games if g and g["overall"] is not None]
    if not games:
        return None
    return {
        "overall": round(_mean([g["overall"] for g in games])),
        "areas": {n: (round(v) if v is not None else None)
                  for n, v in ((n, _mean([g["areas"][n] for g in games])) for n in AREAS)},
        "kp": _round(_mean([g["kp"] for g in games]), 3),
        "gold_share": _round(_mean([g["gold_share"] for g in games]), 3),
        "dmg_per_min": _round(_mean([g["dmg_per_min"] for g in games]), 0),
        "games": len(games),
    }


def _round(x, n):
    if x is None:
        return None
    return round(x, n) if n else round(x)
