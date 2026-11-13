"""아이템 추천기 확인. python test_items.py (pytest 로 돌려도 된다)."""
import itertools
import json
import random

import item_context as X
import items as I


def brute(cands, budget, slots, must=None):
    """모든 조합을 다 따진 정답(값만 더한다). dp 를 확인하는 데 쓴다."""
    best = 0.0 if must is None else None
    for n in range(slots + 1):
        for combo in itertools.combinations(cands, n):
            groups = [c[3] for c in combo if c[3]]
            if len(groups) != len(set(groups)):
                continue
            if must and must not in groups:
                continue
            # dp 는 골드를 25 단위로 올려서 본다. 정답도 같은 잣대로
            if sum(I._units(c[2]) for c in combo) > I._units(budget):
                continue
            v = sum(c[1] for c in combo)
            if best is None or v > best:
                best = v
    return best


def test_dp_matches_brute_force():
    rng = random.Random(7)
    for trial in range(300):
        n = rng.randint(1, 9)
        cands = [(i, float(rng.randint(1, 60)), rng.choice([300, 800, 1100, 2600, 3000, 3333]),
                  rng.choice([None, None, "a", "b", "boots"])) for i in range(n)]
        budget, slots = rng.choice([1000, 3000, 6000, 9999, 20000]), rng.randint(1, 4)
        must = "boots" if trial % 3 == 0 else None
        ids, v = I.build_dp(cands, budget, slots, must)
        if not any(c[3] == must for c in cands):
            must = None             # 후보에 신발이 없으면 dp 는 조건 없이 푼다
        want = brute(cands, budget, slots, must)
        if want is None:            # 신발이 없거나 못 사는 경우: dp 도 빈 답
            assert ids == [], (cands, budget, slots)
            continue
        assert abs(v - want) < 1e-6, (cands, budget, slots, must, ids, v, want)
        # 되찾은 빌드가 그 값·조건을 그대로 지키는지
        got = [c for c in cands if c[0] in ids]
        assert abs(sum(c[1] for c in got) - v) < 1e-6
        assert len(got) <= slots
        groups = [c[3] for c in got if c[3]]
        assert len(groups) == len(set(groups))
        if must:
            assert must in groups


def test_best_never_worse_than_dp_or_greedy():
    # 상황(시간·라인전·조합) 을 넣어도 마찬가지인지 챔피언 넷 중 하나는 상황을 넣어 본다
    ctx = X.make_context(9, -.6, [{"id": 89}, {"id": 86}], [{"id": 238}, {"id": 16}, {"id": 266}, {"id": 54}])
    for n, c in enumerate(I.champion_list()):
        for budget in (None, 9000):
            r = I.recommend(c["id"], None, budget, ctx=ctx if n % 4 == 0 else None)
            best = r["best"]["true_value"]
            assert best >= r["dp"]["true_value"] - 1, (c["name"], budget, r["best"], r["dp"])
            assert best >= r["greedy"]["true_value"] - 1, (c["name"], budget)
            ids = [x["id"] for x in r["best"]["items"]]
            assert len(ids) <= 6 and len(set(ids)) == len(ids)
            assert r["best"]["price"] <= (budget or I.MAX_BUDGET)
            kinds = [x["kind"] for x in r["best"]["items"]]
            assert kinds.count("boots") == 1, (c["name"], kinds)


def test_owned_items_stay():
    jinx = 222
    r = I.recommend(jinx, "adc", None, owned=[3031, 3006, 1036])     # 무한의 대검·광전사 + 롱소드(재료라 빌드엔 안 듦)
    assert {x["id"] for x in r["owned"]} == {3031, 3006}
    ids = [x["id"] for x in r["best"]["items"]]
    assert len(ids) == 4 and 3031 not in ids
    assert all(x["kind"] != "boots" for x in r["best"]["items"])


def test_next_buy():
    items = I.data()["items"]
    ie = 3031                      # 무한의 대검 = B.F. 대검 + 곡괭이 + 민첩성의 망토 + 725
    assert I.next_buy([ie], [], 5000)[0] == {"id": ie, "name": items[ie]["name"], "cost": 3500, "toward": None}
    # 1300 이면 재료 중 가장 비싼 B.F. 대검(1300)
    assert I.next_buy([ie], [], 1300)[0]["id"] == 1038
    # 재료를 다 가지고 있으면 조합 값만
    assert I.next_buy([ie], [1038, 1037, 1018], 725)[0]["cost"] == 725
    # 이미 가진 완성품은 건너뛰고 다음 것
    assert I.next_buy([ie, 3006], [ie], 2000)[0]["id"] == 3006
    # 재료를 사 둔 신발(장화+단검) 을 먼저 마치고, 그 뒤는 빌드 순서(도미닉). 단검이 신발에 쓰였으니 폭풍갈퀴는 "시작한 것" 이 아니다
    got = I.next_buy([ie, 3036, 3006, 3095], [ie, 1001, 1042], 4200)
    assert [(b["id"], b["cost"]) for b in got] == [(3006, 550), (3036, 3300)], got
    # 시작템 롱소드 하나로는 도미닉(최후의 속삭임 재료) 을 "시작한 것" 으로 보지 않는다: 빌드 첫 아이템(무한의 대검) 재료부터
    got = I.next_buy([ie, 3036, 3006], [1036], 1400)
    assert got[0]["id"] == 1038 and got[0]["toward"] == items[ie]["name"], got
    # 같은 재료가 둘 드는 아이템(지배자의 피갑옷 = 땅굴 채굴기 × 2): 하나 가졌으면 두 번째를 산다
    got = I.next_buy([2501], [2021], 1150)
    assert got and got[0]["id"] == 2021 and got[0]["cost"] == 1150, got


def test_small_budgets():
    # 10골드는 "제한 없음" 이 아니라 진짜 예산이다(빈 빌드). 신발도 못 사는 예산이면 신발 조건을 풀고 살 수 있는 것을 고른다
    r = I.recommend(222, "adc", 10)
    assert r["budget"] == 0 and r["best"]["items"] == []
    r = I.recommend(222, "adc", 800)
    assert r["best"]["price"] <= 800


def test_gold_values_from_parts():
    g = I.data()["gold"]
    assert 30 <= g["ad"] <= 36       # 롱소드 350 / 10
    assert 2.5 <= g["hp"] <= 2.8     # 루비 수정 400 / 150
    assert 15 <= g["ap"] <= 21


NAME = {c["name"]: c["id"] for c in I.champion_list()}


def team(*names):
    return [{"id": NAME[n]} for n in names]


def build_stats(r):
    total = {}
    for it in r["best"]["items"]:
        for k, v in it["stats"].items():
            total[k] = total.get(k, 0) + v
    return total


def ids_of(r):
    return {x["id"] for x in r["best"]["items"]}


def test_enemy_damage_type_moves_defense():
    ari = NAME["아리"]
    vs_ad = I.recommend(ari, "mid", ctx=X.make_context(20, None, (), team("제드", "탈론", "렉사이", "케이틀린", "파이크")))
    vs_ap = I.recommend(ari, "mid", ctx=X.make_context(20, None, (), team("애니", "신드라", "엘리스", "브랜드", "카시오페아")))
    # 마법사는 AD 상대든 AP 상대든 존야(방어력 50) 를 사서 방어력 합은 같을 수 있다. AD 상대면 존야는 꼭
    assert build_stats(vs_ad).get("armor", 0) >= build_stats(vs_ap).get("armor", 0)
    assert 3157 in ids_of(vs_ad)
    assert build_stats(vs_ap).get("mr", 0) > build_stats(vs_ad).get("mr", 0)
    assert any("AD" in w for w in vs_ad["reasons"]) and any("AP" in w for w in vs_ap["reasons"])


def test_healers_bring_grievous_and_tanks_bring_pen():
    jinx = NAME["징크스"]
    plain = I.recommend(jinx, "adc", ctx=X.make_context(20, None, (), team("가렌", "아리", "케이틀린", "럭스", "리 신")))
    heal = I.recommend(jinx, "adc", ctx=X.make_context(20, None, (), team("아트록스", "소라카", "케이틀린", "럭스", "문도 박사")))
    assert not ids_of(plain) & I.GRIEVOUS_ITEMS
    assert ids_of(heal) & I.GRIEVOUS_ITEMS
    assert any("치유 감소" in w for w in heal["reasons"])
    tanks = X.make_context(25, None, (), team("말파이트", "오른", "레오나", "자크", "케이틀린"))
    assert tanks["e_tank"] >= .5
    r = I.recommend(jinx, "adc", ctx=tanks)
    assert ids_of(r) & {3033, 3036}          # 필멸자의 운명·도미닉: % 방어구 관통


def test_laning_sustain_only_changes_order_not_build():
    darius = NAME["다리우스"]
    early = I.recommend(darius, "top", ctx=X.make_context(6, None))
    late = I.recommend(darius, "top", ctx=X.make_context(35, None))
    assert 3072 not in ids_of(early)          # 라인전 흡혈 가치로 피바라기를 완성 빌드에 넣지 않는다
    assert ids_of(early) == ids_of(late)      # 라인전 상태를 모르면 완성 빌드는 같고 순서만 다를 수 있다


def test_order_eff():
    values = {3031: 3000.0, 3006: 1100.0, 3036: 2900.0, 6692: 2600.0}   # 6692 월식 2900골드
    assert I.order([3031, 3036, 6692, 3006], values, 0)[0] == 3031      # 값이 큰 것 먼저
    v = {**values, 3123: 900.0}                                          # 처형인의 대검 800골드(가성비 최고)
    assert I.order([3031, 3123, 3006], v, 1)[0] == 3123


def test_lane_score_sign():
    even = {"cs": 60, "level": 7, "kills": 1, "deaths": 1, "item_gold": 1500}
    assert X.lane_score(even, even) == 0
    assert X.lane_score({**even, "cs": 90, "kills": 3, "item_gold": 2600}, even) > .5
    assert X.lane_score(even, {**even, "cs": 90, "kills": 3, "item_gold": 2600}) < -.5


def test_from_live_demo():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    live = X.from_live(O.DEMO)
    assert live["champion"] == NAME["징크스"] and live["lane"] == "adc" and live["gold"] == 1400
    assert live["opponent"] == "드레이븐" and live["ctx"]["lane"] < 0 and 8 < live["ctx"]["t"] < 10
    assert set(live["ctx"]["heal_names"]) == {"소라카", "아트록스"}
    a = O.advise(O.DEMO)
    assert a["buy"] and a["reasons"]
    assert X.make_context(10, None, (), [{"id": 999999}]) == {"t": 10.0}   # 모르는 챔피언은 빼고


# ── 템트리 뼈대 + 이번 귀환에 살 것(plan_build / plan_buy) ─────────────
# OP.GG 에서 받은 템트리(패치 16.22). 인터넷 없이 돌게 손으로 넣어 둔다
TREES = {
    "징크스": {"starter": [1086, 2003, 2003], "core": [2523, 3085, 3031], "boots": [3006],
             "fourth": [[3036, .47], [3031, .22], [3033, .14]], "fifth": [[3026, .41], [3072, .26], [3139, .09]],
             "sixth": [[3026, .33], [3072, .25], [3139, .12]]},
    "아리": {"starter": [1056, 2003, 2003], "core": [3118, 4645, 3157], "boots": [3020],
           "fourth": [[3089, .33], [3157, .25], [3135, .09]], "fifth": [[3089, .19], [3135, .17], [3157, .16]],
           "sixth": [[3135, .15], [4629, .15], [3100, .11]]},
    "말파이트": {"starter": [1056, 2003, 2003], "core": [3068, 3075, 3110], "boots": [3047],
             "fourth": [[6665, .19], [3143, .14], [2504, .14]], "fifth": [[6665, .17], [3143, .13], [2504, .1]],
             "sixth": [[3143, .09], [3118, .08], [6665, .07]]},
    "가렌": {"starter": [1054, 2003], "core": [6631, 3046, 3033], "boots": [3006],
           "fourth": [[3742, .25], [3031, .12], [3033, .12]], "fifth": [[4401, .14], [3053, .14], [3742, .14]],
           "sixth": [[3142, .18], [3742, .14], [3046, .11]]},
    "제드": {"starter": [1055, 2003], "core": [6699, 2520, 3036], "boots": [3158],
           "fourth": [[3814, .17], [6694, .16], [3036, .13]], "fifth": [[3814, .2], [2517, .15], [6695, .1]],
           "sixth": [[3142, .24], [3026, .18], [2517, .12]]},
    "레오나": {"starter": [2003, 2003], "core": [3190, 3109, 2524], "boots": [3047],
            "fourth": [[3075, .21], [2525, .18], [2504, .13]], "fifth": [[3143, .16], [6665, .16], [3110, .11]],
            "sixth": []},
}
LANE_OF = {"징크스": "adc", "아리": "mid", "말파이트": "top", "가렌": "top", "제드": "mid", "레오나": "support"}
LIFESTEAL = {3072, 3153, 6673}          # 피바라기·몰락한 왕의 검·불멸의 철갑궁


def plan(name, t, gold, inv, enemies=(), foes=(), lane_state=None):
    cid, lane = NAME[name], LANE_OF[name]
    ctx = X.make_context(t, lane_state, (), team(*enemies), team(*foes))
    b = I.plan_build(cid, lane, TREES[name], ctx, inv)
    return b, I.plan_buy(cid, lane, b["items"], inv, gold, ctx)


def bought(p, consumables=True):
    """이번에 사는 번호들. consumables=False 면 제어 와드·엘릭서를 뺀다."""
    return {x["id"] for x in p["buy"] if consumables or x["id"] not in I.data()["consumables"]}


def test_plan_build_keeps_tree_core_order():
    items = I.data()["items"]
    for name, tree in TREES.items():
        for ctx in (None, X.make_context(30, None, (), team("아트록스", "소라카", "제드", "말파이트", "케이틀린"))):
            b = I.plan_build(NAME[name], LANE_OF[name], tree, ctx)
            legend = [i for i in b["items"] if items[i]["kind"] == "legendary"]
            assert legend[:3] == tree["core"], (name, b["items"])          # 우선순위 1: 코어 순서 그대로
            assert items[b["items"][1]]["kind"] == "boots"                  # 신발은 첫 코어 다음
            assert len(b["items"]) == 6 and len(set(b["items"])) == 6


def test_plan_build_lifesteal_stays_late():
    # 라인전 초반에 밀려도(유지력 가치가 큰 때) 징크스의 피바라기(5·6번째 후보) 는 앞으로 오지 않는다
    for t, s in ((5, -.9), (30, None)):
        b = I.plan_build(NAME["징크스"], "adc", TREES["징크스"], X.make_context(t, s))
        assert all(n >= 4 for n, i in enumerate(b["items"]) if i in LIFESTEAL), b["items"]


def test_plan_build_situational_swap_only_in_late_slots():
    # 회복형 상대면 4번째 이후가 중상 템(필멸자의 운명) 으로. 코어는 그대로
    heal = X.make_context(20, None, (), team("아트록스", "소라카", "블라디미르", "케이틀린", "워윅"))
    b = I.plan_build(NAME["징크스"], "adc", TREES["징크스"], heal)
    assert 3033 in b["items"][4:] and b["items"][0] == 2523


def test_plan_buy_detours_by_role():
    """같은 "맞라인 회복형" 이라도 챔피언마다 맞는 중상 하위템이 다르다(원딜·마법사·탱커)."""
    # 원딜: 처형인의 대검(필멸자의 운명 재료) 을 먼저
    _, p = plan("징크스", 9, 1400, [1055, 3340], ["드레이븐", "소라카", "제드", "카직스", "아트록스"], ["드레이븐", "소라카"])
    assert 3123 in bought(p), p["buy"]
    # 마법사: 망각의 구
    _, p = plan("아리", 8, 1100, [1056, 3340], ["블라디미르", "다리우스", "리 신", "케이틀린", "레오나"], ["블라디미르"])
    assert 3916 in bought(p), p["buy"]
    # 탱커: 덤불 조끼
    _, p = plan("말파이트", 7, 900, [1056, 3340], ["아트록스", "아리", "리 신", "케이틀린", "레오나"], ["아트록스"])
    assert 3076 in bought(p), p["buy"]
    # 중상 하위템은 그 스탯을 쓰는 챔피언만: 원딜이 덤불 조끼·망각의 구를, 마법사가 처형인의 대검을 사지 않는다
    _, p = plan("징크스", 9, 1400, [1055, 3340], ["드레이븐", "소라카", "제드", "카직스", "아트록스"], ["드레이븐", "소라카"], -.9)
    assert not bought(p) & {3076, 3916}, p["buy"]
    _, p = plan("아리", 8, 1100, [1056, 3340], ["블라디미르", "다리우스", "리 신", "케이틀린", "레오나"], ["블라디미르"])
    assert 3123 not in bought(p)


def test_plan_buy_no_detour_without_reason():
    # 회복형이 없으면 중상 하위템으로 돌아가지 않고 템트리 재료(코어·신발) 를 산다
    b, p = plan("징크스", 9, 1400, [1055, 3340], ["드레이븐", "레오나", "제드", "카직스", "가렌"], ["드레이븐", "레오나"])
    assert not bought(p) & set(I.PART_PASSIVE)
    near = set(b["items"][:3]).union(*(I._tree(t) for t in b["items"][:3]))
    assert bought(p, False) <= near, p["buy"]


def test_plan_buy_lane_defense_from_lane_opponent():
    # 팀 전체는 AD 가 많아도 맞라인이 AP(티모) 면 라인전 동안 마법무효화의 망토
    _, p = plan("가렌", 8, 1000, [1054, 3340], ["티모", "다리우스", "리 신", "케이틀린", "파이크"], ["티모"])
    assert 1033 in bought(p), p["buy"]
    # 맞라인이 AD 면 망토는 사지 않는다
    _, p = plan("가렌", 8, 1000, [1054, 3340], ["다리우스", "아리", "리 신", "케이틀린", "레오나"], ["다리우스"])
    assert 1033 not in bought(p), p["buy"]


def test_plan_buy_component_choice_and_role_stats():
    items = I.data()["items"]
    # 암살자: 롱소드 셋이 아니라 톱날 단검 하나(칸 몫)
    _, p = plan("제드", 9, 1100, [1055, 3340], ["아리", "레오나", "리 신", "케이틀린", "가렌"], ["아리"])
    assert 3134 in bought(p), p["buy"]
    # 마법사는 AD 하위템을, 원딜은 AP 하위템을 사지 않는다(시간·골드를 바꿔 가며)
    for t, g in ((4, 500), (9, 1300), (15, 2400), (24, 3100)):
        _, p = plan("아리", t, g, [1056, 3340])
        assert all(not items[x]["stats"].get("ad") for x in bought(p, False)), (t, g, p["buy"])
        _, p = plan("징크스", t, g, [1055, 3340])
        assert all(not items[x]["stats"].get("ap") for x in bought(p, False)), (t, g, p["buy"])
    # 서포터: 적은 골드로도 빌드 재료를
    b, p = plan("레오나", 6, 500, [3865, 3340])
    assert p["buy"] and sum(x["cost"] for x in p["buy"]) <= 500


def test_plan_buy_finishes_and_sells():
    # 재료가 가방에 있고 골드가 되면 완성템을 산다(재료가 빠져 칸도 생긴다). 무한의 대검 재료가 다 있어도
    # 템트리 첫 코어(마법광학 장치 C44) 를 곡괭이로 먼저 완성하는 것도 맞다(우선순위 1)
    _, p = plan("징크스", 16, 3000, [1055, 2003, 1038, 1037, 1018, 3006, 3340])
    assert bought(p) & {2523, 3031} and not p["sell"], p
    # 가방이 꽉 차서(6칸) 새 재료를 넣을 곳이 없으면 시작템을 판다. dp 는 팔지 못해서 exact 가 더 낫다
    # (증폭의 고서·사파이어·루비는 징크스 빌드 어디에도 안 들어가 합쳐서 칸을 비울 수도 없다)
    _, p = plan("징크스", 12, 1300, [1055, 2003, 1052, 1052, 1027, 1028, 3340])
    assert p["sell"] and p["buy"], p
    assert p["exact"]["value"] >= p["dp"]["value"]


def test_consumables():
    # 서포터는 제어 와드를 같이 산다(가방에 이미 있으면 안 산다)
    _, p = plan("레오나", 6, 500, [3865, 3340])
    assert I.WARD in bought(p), p["buy"]
    _, p = plan("레오나", 6, 500, [3865, I.WARD, 3340])
    assert I.WARD not in bought(p)
    # 빌드를 다 채우면 남은 골드로 역할에 맞는 엘릭서(가방이 꽉 차도 사서 바로 마신다)
    full = [2523, 3085, 3031, 3006, 3036, 3072]
    p = I.plan_buy(NAME["징크스"], "adc", full, full + [3340], 900, X.make_context(35))
    assert bought(p) == {2140}, p["buy"]                       # 분노의 영약(AD)
    tank = [3068, 3047, 3075, 3110, 3143, 6665]
    p = I.plan_buy(NAME["말파이트"], "top", tank, tank, 700, X.make_context(35))
    assert bought(p) == {2138}, p["buy"]                       # 강철의 영약


def test_buy_dp_matches_brute_force():
    rng = random.Random(3)
    for _ in range(300):
        groups = [[(rng.choice([4, 12, 14, 32, 52]), rng.choice([-2, -1, 0, 1, 1, 2]), float(rng.randint(1, 50)), None)
                   for _ in range(rng.randint(1, 4))] for _ in range(rng.randint(1, 4))]
        gold, free = rng.choice([0, 300, 800, 1500, 3000]), rng.randint(0, 6)
        pick, v = I._buy_dp(groups, gold, free)
        best = 0.0
        for combo in itertools.product(*[[None] + list(range(len(g))) for g in groups]):
            s, g, val, ok = free, gold // I.GOLD_UNIT, 0.0, True
            for n, j in enumerate(combo):
                if j is None:
                    continue
                u, ds, x, _ = groups[n][j]
                s, g, val = s - ds, g - u, val + x
                if g < 0 or s < 0 or s > 6:
                    ok = False
                    break
            if ok:
                best = max(best, val)
        assert abs(v - best) < 1e-6, (groups, gold, free, pick, v, best)
        assert abs(sum(groups[n][j][2] for n, j in pick) - v) < 1e-6


def test_plan_buy_never_worse_than_dp_any_champion():
    # 모든 챔피언 × 여러 가방·골드: exact ≥ dp, 드는 골드 ≤ 가진 골드 + 판 돈, 칸 ≤ 6
    rng = random.Random(11)
    items = I.data()["items"]
    parts = [i for i, it in items.items() if it["kind"] == "part" and it["to"] and it["price"] <= 1300]
    champs = I.champion_list()
    for n, c in enumerate(champs[::6]):
        lane = rng.choice(["top", "jungle", "mid", "adc", "support"])
        inv = rng.sample(parts, rng.randint(0, 4)) + [3340]
        gold = rng.choice([300, 900, 1600, 2600, 4000])
        ctx = X.make_context(rng.choice([5, 14, 28]), rng.choice([None, -.6, .6]), (), team("아트록스", "소라카", "제드"),
                             team("아트록스"))
        b = I.plan_build(c["id"], lane, None, ctx, inv)
        p = I.plan_buy(c["id"], lane, b["items"], inv, gold, ctx)
        assert p["exact"]["value"] >= p["dp"]["value"] - 1, (c["name"], p)
        back = sum(int(items[s["id"]]["price"] * I.SELL_BACK) for s in p["sell"] if s["id"] in items)
        assert sum(x["cost"] for x in p["buy"]) <= gold + back, (c["name"], gold, p["buy"])


def test_overlay_uses_tree():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    O.TREE_OVERRIDE = {(NAME["징크스"], "adc"): TREES["징크스"]}
    try:
        a = O.advise(O.DEMO)
    finally:
        O.TREE_OVERRIDE = None
    assert a["source"] == "opgg" and a["build"][0] == 2523
    assert 3123 in {b["id"] for b in a["buy"]}          # 맞라인 소라카 → 처형인의 대검
    assert "칸이 모자라" not in O.as_text(a)


# ── 롤 클라이언트(챔프 선택 → 상점 추천 탭) ─────────────────────────

def _overlay():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    import lcu as L
    return O, L


def test_lcu_lockfile_and_select():
    O, L = _overlay()
    assert L.parse_lockfile("LeagueClient:1234:54321:abc-DEF_1:https") == (54321, "abc-DEF_1", "https")
    assert L.parse_lockfile("") is None and L.parse_lockfile("a:b:c") is None
    sel = L.read_select(O.DEMO_SESSION)
    assert sel["champion"] == NAME["징크스"] and sel["lane"] == "adc" and sel["locked"]
    assert len(sel["allies"]) == 4 and len(sel["enemies"]) == 5 and sel["foes"] == []
    # 고민 중(championPickIntent) · 라인 없는 판 · 서포터(utility)
    s = {"localPlayerCellId": 1, "myTeam": [{"cellId": 1, "championId": 0, "championPickIntent": 89,
                                             "assignedPosition": "utility"}], "theirTeam": [], "actions": []}
    sel = L.read_select(s)
    assert sel["champion"] == 89 and sel["lane"] == "support" and not sel["locked"]
    s["myTeam"][0].update(championPickIntent=0, assignedPosition="")
    assert L.read_select(s) is None
    s["myTeam"][0]["championId"] = 89
    assert L.read_select(s)["lane"] is None
    # 상대 라인이 보이는 판이면 맞라인(바텀은 둘)
    s = {"localPlayerCellId": 0, "myTeam": [{"cellId": 0, "championId": 222, "assignedPosition": "bottom"}],
         "theirTeam": [{"championId": 119, "assignedPosition": "bottom"}, {"championId": 16, "assignedPosition": "utility"},
                       {"championId": 238, "assignedPosition": "middle"}]}
    assert [f["id"] for f in L.read_select(s)["foes"]] == [119, 16]


def test_item_set_shape_and_merge():
    O, L = _overlay()
    jinx = NAME["징크스"]
    ctx = X.make_context(None, None, (), team("아트록스", "소라카", "제드", "드레이븐", "카직스"))
    plan_ = I.plan_build(jinx, "adc", TREES["징크스"], ctx)
    parts = I.situational_parts(jinx, "adc", ctx, plan_["items"])
    assert 3123 in [p for p, _ in parts]                       # 회복형 상대: 처형인의 대검
    s = L.make_item_set(jinx, "adc", plan_, TREES["징크스"], parts)
    assert s["uid"] == L.TIERGG_UID and s["associatedChampions"] == [jinx] and s["associatedMaps"] == [11]
    assert len(s["title"]) <= 75 and "징크스" in s["title"]
    blocks = {b["type"].split(" (")[0]: b["items"] for b in s["blocks"]}
    assert blocks["시작 아이템"] == [{"id": "1086", "count": 1}, {"id": "2003", "count": 2}]   # 물약 둘은 한 칸에 2
    assert [x["id"] for x in blocks["빌드 순서"]] == [str(i) for i in plan_["items"]]
    assert all(isinstance(x["id"], str) and x["count"] >= 1 for b in s["blocks"] for x in b["items"])
    assert {"id": "2055", "count": 1} in blocks["소모품"]
    # 합치기: 사용자가 만든 세트는 그대로, 예전 Tier.gg 세트는 바꾸고, 우리 것이 맨 앞
    cur = {"accountId": 7, "itemSets": [{"uid": "mine", "title": "내 세트"}, {"uid": L.TIERGG_UID, "title": "옛것"}]}
    got = L.merge_sets(cur, s)
    assert [x["uid"] for x in got["itemSets"]] == [L.TIERGG_UID, "mine"] and got["accountId"] == 7
    assert got["itemSets"][0]["title"] == s["title"] and not any(k.startswith("_") for k in got["itemSets"][0])
    assert L.merge_sets(None, s)["itemSets"][0]["uid"] == L.TIERGG_UID


def test_watcher_pushes_on_champ_select():
    O, L = _overlay()
    O.TREE_OVERRIDE = {(NAME["징크스"], "adc"): TREES["징크스"]}
    try:
        fake = O.FakeClient()
        w = O.Watcher(lambda: None, lambda: fake)
        a = w()
        assert a["mode"] == "select" and a["champion"] == "징크스" and fake.puts == 1
        assert [x["uid"] for x in fake.sets["itemSets"]] == [L.TIERGG_UID, "mine"]
        assert "추천 탭에 넣었어요" in O.as_text(a)
        w.last_try = 0
        w()
        assert fake.puts == 1                                  # 같은 빌드면 다시 쓰지 않는다
        # 챔프 선택이 아니면 기다림, 클라이언트가 꺼져 있어도 기다림
        assert "기다리는" in O.Watcher(lambda: None, lambda: O.FakeClient(phase="Lobby"))()
        assert "기다리는" in O.Watcher(lambda: None, lambda: None)()
        # 끄면 안 쓴다
        fake2 = O.FakeClient()
        O.Watcher(lambda: None, lambda: fake2, push=False)()
        assert fake2.puts == 0
        # 게임이 열려 있으면 게임 추천이 먼저
        assert "buy" in O.Watcher(lambda: O.DEMO, lambda: O.FakeClient())()
        # 지우기: 우리 세트만
        assert L.remove_item_set(fake) and [x["uid"] for x in fake.sets["itemSets"]] == ["mine"]
    finally:
        O.TREE_OVERRIDE = None


def test_app_status_and_args():
    """Tier.gg 앱: 작은 창이 남기는 상태(앱 창의 아이템 추천 탭이 읽는다) 와 앱 옵션 나누기."""
    import json, os, sys, tempfile
    O, L = _overlay()
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
    import tiergg_app as A
    O.TREE_OVERRIDE = {(NAME["징크스"], "adc"): TREES["징크스"]}
    try:
        st = O.status_of(O.advise(O.DEMO))
        assert st["mode"] == "game" and st["gold"] == 1400 and {b["id"] for b in st["buy"]} >= {3123}
        sel = O.status_of(O.Watcher(lambda: None, lambda: O.FakeClient())())
        assert sel["mode"] == "select" and sel["build"][0] == 2523 and "추천 탭" in sel["status"]
        assert O.status_of("게임을 기다리는 중이에요") == {"mode": "wait", "text": "게임을 기다리는 중이에요"}
        # 파일로 남기고 앱 Api 가 읽는다
        path = os.path.join(tempfile.mkdtemp(), "status.json")
        O.STATUS_FILE, O._last_status = path, None
        O.write_status(O.advise(O.DEMO))
        assert json.load(open(path, encoding="utf-8"))["champion"] == "징크스"
        old = A.STATUS
        A.STATUS = path
        api = A.Api(A.Overlay([]), None)                   # 업데이트는 이 시험에서 안 씀
        got = api.status()
        assert got["mode"] == "game" and got["overlay"] is False      # 이 시험에서는 작은 창 프로세스를 안 켰다
        A.STATUS = os.path.join(os.path.dirname(path), "none.json")
        assert api.status()["mode"] == "wait"
        A.STATUS = old
    finally:
        O.TREE_OVERRIDE, O.STATUS_FILE = None, None
    # 앱 옵션은 꺼내고 나머지(작은 창 옵션) 는 넘긴다
    v, rest = A._take(["--demo", "--web-url", "http://x/", "--no-itemset"], "--web-url", True)
    assert v == "http://x/" and rest == ["--demo", "--no-itemset"]
    assert A._take(["--overlay", "--demo"], "--overlay") == (True, ["--demo"])
    assert A._take(["--demo"], "--overlay") == (None, ["--demo"])
    # 앱 창이 꺼지면 작은 창도 끈다
    O.PARENT_PID = os.getpid()
    assert not O.parent_gone()
    O.PARENT_PID = 2 ** 22 + 12345                                     # 없는 프로세스
    assert O.parent_gone()
    O.PARENT_PID = None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)


# ── 게임 중 라인 가리기(플레이 시험 2026-11-13: 베인을 미드로, 맞라인을 트위스티드 페이트로 잘못 봄) ──
def _p(name, pos="", smite=False):
    cid = NAME[name]
    sp = {"summonerSpellOne": {"displayName": "강타", "rawDisplayName": "GeneratedTip_SummonerSpell_SummonerSmite_DisplayName"}} if smite \
        else {"summonerSpellOne": {"displayName": "점멸", "rawDisplayName": "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName"}}
    return {"id": cid, "api_lane": X.LIVE_LANE.get(pos), "smite": smite, "summonerSpells": sp}


SHARES = {str(NAME[n]): v for n, v in {
    "베인": {"adc": .7, "top": .3}, "아리": {"mid": 1.0}, "리 신": {"jungle": 1.0}, "가렌": {"top": .9, "mid": .1},
    "레오나": {"support": 1.0}, "트위스티드 페이트": {"mid": 1.0}, "징크스": {"adc": 1.0}, "말파이트": {"top": .8, "mid": .1, "jungle": .1},
    "쓰레쉬": {"support": 1.0}, "제드": {"mid": .9, "jungle": .1}}.items()}


def test_assign_lanes_fixes_wrong_api_positions():
    team = [_p("베인", "MIDDLE"), _p("아리", "BOTTOM"), _p("리 신", "", smite=True), _p("가렌", "TOP"), _p("레오나", "UTILITY")]
    assert X.assign_lanes(team, SHARES) == ["adc", "mid", "jungle", "top", "support"]
    # 역할로만 어림해도(라인 비율 없음) 강타는 정글, 원딜은 바텀
    assert X.assign_lanes(team, None)[:3] == ["adc", "mid", "jungle"]
    # 챔프 선택에서 받은 내 라인이 가장 세다(베인 탑)
    assert X.assign_lanes(team, SHARES, {0: "top"})[0] == "top"


def test_from_live_lane_opponent_by_assignment():
    import copy, sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    g = copy.deepcopy(O.DEMO)
    # 데모(징크스 바텀) 의 내 칸과 적 칸 position 을 비우고 섞어도 맞라이너는 드레이븐
    for p in g["allPlayers"]:
        p["position"] = ""
    live = X.from_live(g)
    assert live["lane"] == "adc" and live["opponent"] == "드레이븐"
    # 챔프 선택에서 미드로 받았으면 미드(맞라이너는 적 미드)
    live = X.from_live(g, "mid")
    assert live["lane"] == "mid" and live["opponent"] != "드레이븐"


def test_item_set_has_component_paths():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import lcu as L
    plan = {"items": [3153, 3006, 3124, 3031], "source": "opgg", "picks": []}
    s = L.make_item_set(NAME["베인"], "adc", plan)
    first = next(b for b in s["blocks"] if b["type"].startswith("1번째"))
    assert [int(x["id"]) for x in first["items"]] == [1036, 1053, 1042, 1043, 1037]     # 롱소드 → 흡혈의 낫 → 단검 → 곡궁 → 곡괭이
    assert not any("광전사" in b["type"] for b in s["blocks"])                        # 신발은 빼고


def test_spell_hints_and_lane_pick():
    import copy, sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    # 순간이동은 탑 쪽으로: 베인(탑·원딜) 과 루시안(원딜·미드) 이 같이 있으면 순간이동 든 베인이 탑
    tp = _p("베인", "MIDDLE")
    tp["tp"] = True
    team = [tp, _p("아리", "MIDDLE"), _p("리 신", "", smite=True), _p("징크스", "BOTTOM"), _p("레오나", "UTILITY")]
    assert X.assign_lanes(team, SHARES)[0] == "top"
    # 작은 창에서 고른 라인이 가장 세다(데모 징크스를 탑으로 고르면 탑, 맞라이너는 적 탑)
    O.TREE_OVERRIDE = {}
    try:
        g = copy.deepcopy(O.DEMO)
        a = O.advise(g)
        O.LANE_PICK.update(champ=a["champion_id"], lane="top")
        b = O.advise(g)
        assert b["lane"] == "top" and b["lane_picked"] and b["opponent"] != "드레이븐"
        assert O._situation(b).startswith("탑 ·")
    finally:
        O.LANE_PICK.clear()
        O.TREE_OVERRIDE = None


# ── 상점에 오면 작은 창 띄우기(tools/shop_watch.py) ──
def _shop_rows():
    import gzip, os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests_data", "shop_game_2026-11-13.jsonl.gz")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(l) for l in f]


def _shop_changes(rows):
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import shop_watch as SW
    w, out, prev = SW.ShopWatch(), [], None
    for r in rows:
        on = w.update(r)
        if prev is not None and on != prev:
            out.append((r["t"], on))
        prev = on
    return out


def test_shop_watch_real_game():
    """실제 게임(2026-11-13, 30분): 귀환 11번·죽음 2번에 띄우고, 우물을 나가면 2초 안에 내리고, 라인 이속 버프에는 안 띄운다."""
    ch = _shop_changes(_shop_rows())
    shown = [t for t, on in ch if on]
    want = [174.3, 322.8, 437.6, 514.5, 716.7, 773.5, 878.7, 1006.7, 1125.7, 1287.3, 1432.6, 1560.0, 1595.0]
    assert len(shown) == len(want) and all(abs(a - b) < 1.0 for a, b in zip(shown, want)), shown
    hidden = [t for t, on in ch if not on]
    # 우물 이속에서 떨어지기 시작한 때(기록) 와 내린 때
    left = {174.3: 182.1, 1125.7: 1141.8}
    for s, l in left.items():
        h = next(t for t in hidden if t > s)
        assert l <= h <= l + 2.0, (s, h)


def test_shop_watch_speed_buffs_are_not_shop():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import shop_watch as SW
    def run(seq):
        w = SW.ShopWatch()
        return [w.update(r) for r in seq]
    lane = [{"t": 100 + k * .5, "gold": 500, "hp": 1500, "maxhp": 2000, "ms": 400, "dead": False, "items": [1055]} for k in range(80)]
    # 마스터 이 R: 1.45배 7초, 싸우며 체력이 줆 → 상점 아님
    yi = [dict(r, t=140 + k * .5, ms=580, hp=1500 - k * 20) for k, r in enumerate(lane[:14])]
    assert not any(run(lane + yi))
    # 헤카림 E: 이속이 계속 오름(고정 아님) + 스킬로 체력 회복 조금 → 상점 아님
    he = [dict(r, t=140 + k * .5, ms=400 + k * 40, hp=1500 + k * 10) for k, r in enumerate(lane[:8])]
    assert not any(run(lane + he))
    # 체력이 꽉 찬 채 귀환: 우물 이속 1.77배가 3초 고정이면 우물
    full = [dict(r, hp=2000) for r in lane]
    home = [dict(r, t=140 + k * .5, ms=708, hp=2000) for k, r in enumerate(lane[:10])]
    assert run(full + home)[-1]


def test_starter_is_doran_for_laners():
    """첫 템은 도란(2026-11-13 플레이 시험: 천 갑옷을 추천했다). 정글 펫, 서폿 세계 지도집. 템이 있거나 3분 뒤면 안 함."""
    DOR = set(I.DORANS)
    for name in ("징크스", "아리", "말파이트", "가렌", "제드"):
        lane = LANE_OF[name]
        for tree in (TREES[name], None, {"starter": [1082, 2003]}):     # 템트리 시작템·없음·도란이 아닌 시작템(암흑의 인장)
            got = I.starter_buy(NAME[name], lane, tree, [3340], 500, 0.1)
            assert got and got[0]["id"] in DOR, (name, tree, got)
            assert sum(x["cost"] for x in got) <= 500 and all(x["id"] in DOR or x["id"] == 2003 for x in got)
    assert I.starter_buy(NAME["리 신"], "jungle", {"starter": [1101, 2003]}, [], 500, 0)[0]["id"] == 1101
    assert I.starter_buy(NAME["레오나"], "support", TREES["레오나"], [], 500, 0)[0]["id"] == 3865
    assert I.starter_buy(NAME["징크스"], "adc", None, [1055], 500, 0.5) is None
    assert I.starter_buy(NAME["징크스"], "adc", None, [], 500, 3.5) is None
    # 오버레이도: 게임 시작 데모(가방 비고 0분) 면 도란 + 물약
    import copy, sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import item_overlay as O
    O.TREE_OVERRIDE = {(NAME["징크스"], "adc"): TREES["징크스"]}
    try:
        g = copy.deepcopy(O.DEMO)
        g["gameData"] = {"gameTime": 5, "mapNumber": 11}
        g["activePlayer"]["currentGold"] = 500
        for p in g["allPlayers"]:
            p["items"] = []
        a = O.advise(g)
        assert a["buy"][0]["id"] in DOR and a["reasons"][0].startswith("게임 시작")
    finally:
        O.TREE_OVERRIDE = None


# ── 귀환키로 미리 띄우기(tools/recall_watch.py) ──
def test_recall_keys_from_lol_config():
    import sys, os, tempfile
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import recall_watch as R
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "Config"))
    with open(os.path.join(d, "Config", "input.ini"), "w", encoding="utf-8") as f:
        f.write("[GameEvents]\nevtUseItem7=[Shift][h],[b]\nevtPlayerMoveClick=[Button 2]\nevtCastSpell1=[q]\n"
                "evtCastAvatarSpell2=[f]\nevtUseItem1=[1]\n")
    k = R.load_keys(d)
    assert k["recall"] == [ord("H"), ord("B")] and {0x02, ord("Q"), ord("F"), ord("1")} <= set(k["cancel"])
    assert R.load_keys(os.path.join(d, "없음"))["recall"] == [ord("B")]      # 설정이 없으면 기본 b


def test_recall_watch_shows_and_cancels():
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import recall_watch as R
    w = R.RecallWatch(R.DEFAULT)
    B, Q, RMB = ord("B"), ord("Q"), 0x02
    w.press(B, 0); w.health(1000, 0.5); w.health(1010, 1.0)
    assert w.active(5.0)                                   # 귀환 중(체력이 차는 건 괜찮다)
    w.press(RMB, 5.5)
    assert not w.active(5.6) and "키" in w.reason          # 움직여서 끊김
    w.press(B, 10); w.health(1000, 10.5); w.health(950, 11)
    assert not w.active(11.1) and "맞음" in w.reason        # 맞아서 끊김
    w.press(B, 20)
    assert w.active(28) and not w.active(29.6)             # 8초 + 여유가 지나도 우물에 안 오면 끊긴 것
    w.press(Q, 30)
    assert not w.active(30.1)                              # 귀환 중이 아니면 다른 키는 아무 일 없음


def test_recall_key_loop_only_when_lol_in_front():
    import sys, os, threading, time
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import recall_watch as R
    w = R.RecallWatch(R.DEFAULT)
    held, front, done = set(), [False], [False]
    th = threading.Thread(target=R.key_loop, args=(w, lambda: done[0], 0.01, lambda k: k in held, lambda: front[0]))
    th.start()
    try:
        held.add(ord("B")); time.sleep(0.08)
        assert not w.active(time.monotonic())             # 롤이 맨 앞이 아니면(채팅 앱에서 b) 무시
        held.clear(); front[0] = True; time.sleep(0.05)
        held.add(ord("B")); time.sleep(0.08)
        assert w.active(time.monotonic())                 # 롤에서 귀환키
        held.add(0x02); time.sleep(0.08)
        assert not w.active(time.monotonic())             # 오른쪽 클릭(이동) → 끊김
    finally:
        done[0] = True
        th.join()
