"""듀오 궁합.

OP.GG 경기 기록에는 본인 한 명만 들어 있다. 그래서 두 사람의 경기 목록을 놓고
같은 경기 번호(game_id) 를 찾는다. 팀 색(team_key) 이 같으면 같은 편, 다르면 맞대결.

솔로랭크·자유랭크·일반 판만 본다(칼바람·아레나 제외).
OP.GG 는 한 번에 최근 20판만 주지만, 받을 때마다 match_rows 에 쌓아 두므로
자주 볼수록 같이 한 판이 더 많이 잡힌다.

궁합 점수(0~100):
  같이 한 판이 3판 이상이면 "같이 할 때 승률 - 각자 평소 승률" 이 중심이다.
  판이 적으면 라인이 겹치는지와 두 사람의 평소 지표만으로 대강 본다.
"""
import asyncio
from collections import Counter

import opgg
from tierlist import LANE_KO, RECENT_GAMES, summary


def _wr(rows):
    return round(sum(r["result"] == "WIN" for r in rows) / len(rows), 3) if rows else None


def _kda(rows):
    if not rows:
        return None
    k = sum(r["kills"] or 0 for r in rows)
    d = sum(r["deaths"] or 0 for r in rows)
    a = sum(r["assists"] or 0 for r in rows)
    return round((k + a) / max(d, 1), 2)


def _clamp(x):
    return max(0, min(100, round(x)))


async def compare(a_name, a_tag, b_name, b_tag, fresh=False):
    pa, pb, _, _ = await asyncio.gather(
        opgg.profile(a_name, a_tag, fresh), opgg.profile(b_name, b_tag, fresh),
        opgg.matches(a_name, a_tag, fresh), opgg.matches(b_name, b_tag, fresh))

    # 같이 한 판은 쌓아 둔 협곡 경기(솔로·자유·일반) 전부에서 찾는다.
    # 칼바람·아레나는 stored_matches 가 이미 빼 준다
    rows_a = opgg.stored_matches(pa["puuid"])
    rows_b = opgg.stored_matches(pb["puuid"])
    by_game_b = {r["game_id"]: r for r in rows_b}

    together, versus = [], []
    for ra in rows_a:
        rb = by_game_b.get(ra["game_id"])
        if rb is None or not ra["team_key"] or not rb["team_key"]:
            continue
        (together if ra["team_key"] == rb["team_key"] else versus).append((ra, rb))

    shared = {ra["game_id"] for ra, _ in together + versus}
    solo_a = [r for r in rows_a if r["game_id"] not in shared]
    solo_b = [r for r in rows_b if r["game_id"] not in shared]

    # 개인 지표는 티어표와 똑같이 최근 20판으로
    sa, sb = summary(pa, rows_a[:RECENT_GAMES]), summary(pb, rows_b[:RECENT_GAMES])

    duo_wr = _wr([ra for ra, _ in together])
    base = [x for x in (_wr(solo_a), _wr(solo_b)) if x is not None]
    base_wr = round(sum(base) / len(base), 3) if base else None

    # 같이 한 판에서 어떤 라인·챔피언 조합이었나
    lane_pairs = Counter()
    champ_pairs = {}
    for ra, rb in together:
        lane_pairs[(LANE_KO.get(ra["position"], "?"), LANE_KO.get(rb["position"], "?"))] += 1
        key = (ra["champion"], rb["champion"])
        rec = champ_pairs.setdefault(key, {"a": ra["champion"], "b": rb["champion"], "games": 0, "wins": 0})
        rec["games"] += 1
        rec["wins"] += ra["result"] == "WIN"
    combos = sorted(champ_pairs.values(), key=lambda c: (c["wins"], c["games"]), reverse=True)[:5]

    # 맞대결은 누가 이겼나
    versus_a_wins = sum(ra["result"] == "WIN" for ra, _ in versus)

    # ── 점수 ──
    same_lane = sa["main_lane"] and sa["main_lane"] == sb["main_lane"]
    lane_bonus = -8 if same_lane else 8 if (sa["main_lane"] and sb["main_lane"]) else 0

    if len(together) >= 3 and duo_wr is not None and base_wr is not None:
        # 평소보다 10%p 높으면 +25점. 판이 많을수록 그대로 믿는다
        trust = min(len(together) / 10, 1)
        score = 55 + (duo_wr - base_wr) * 250 * trust + lane_bonus
        basis = "together"
    else:
        wr = [x for x in (sa["win_rate"], sb["win_rate"]) if x is not None]
        avg = sum(wr) / len(wr) if wr else 0.5
        score = 50 + (avg - 0.5) * 100 + lane_bonus
        basis = "profile"
    score = _clamp(score)

    return {
        "a": sa, "b": sb,
        "score": score,
        "basis": basis,
        "verdict": _verdict(score, basis),
        "together": {
            "games": len(together),
            "wins": sum(ra["result"] == "WIN" for ra, _ in together),
            "win_rate": duo_wr,
            "base_win_rate": base_wr,
            "kda_a": _kda([ra for ra, _ in together]),
            "kda_b": _kda([rb for _, rb in together]),
            "solo_kda_a": _kda(solo_a),
            "solo_kda_b": _kda(solo_b),
            "lanes": [{"a": k[0], "b": k[1], "games": v} for k, v in lane_pairs.most_common(3)],
            "combos": combos,
            "recent": [{"when": ra["created_at"], "a": ra["champion"], "b": rb["champion"],
                        "result": ra["result"],
                        "a_kda": "%d/%d/%d" % (ra["kills"], ra["deaths"], ra["assists"]),
                        "b_kda": "%d/%d/%d" % (rb["kills"], rb["deaths"], rb["assists"])}
                       for ra, rb in together[:8]],
        },
        "versus": {"games": len(versus), "a_wins": versus_a_wins,
                   "b_wins": len(versus) - versus_a_wins},
        "same_lane": bool(same_lane),
        "sample": {"a": len(rows_a), "b": len(rows_b)},
    }


def _verdict(score, basis):
    if basis == "profile":
        head = "같이 한 판이 아직 적어요. 평소 지표로만 본 예상이에요."
    elif score >= 75:
        head = "같이 하면 확실히 더 이겨요."
    elif score >= 55:
        head = "같이 할 때 조금 더 잘 풀려요."
    elif score >= 40:
        head = "같이 하든 따로 하든 비슷해요."
    else:
        head = "같이 할 때 오히려 더 져요."
    return head
