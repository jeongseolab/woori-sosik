"""아이템 추천기: 챔피언이 아끼는 스탯으로 아이템 값을 매기고, 칸 수와 골드 안에서 가장 좋은 빌드를 고른다.

자료는 static/items/data.json(롤 클라이언트에서 tools/lol_items.py 가 굽는다). 서버는 인터넷 없이 이것만 읽는다.

값 매기기
  - 스탯 1 의 골드 값(gold_values): 재료 아이템 값에서 바로 구한다. 롱소드 350골드에 공격력 10 → 공격력 1 = 35골드.
    스탯이 둘인 재료는 이미 아는 스탯 값을 빼고 남은 하나를 푼다(톱날 단검 → 물리 관통력). 패치가 바뀌어도 다시 구우면 맞는다
  - 챔피언이 그 스탯을 얼마나 아끼는지(weights, 0~1): 롤 클라이언트의 역할(원딜·마법사·암살자·전사·탱커·서포터),
    피해 종류(AD·AP), 내구도, 원거리 여부와 라인으로 정한다
  - 아이템 값 = Σ 스탯 양 × 골드 값 × 아끼는 정도. "이 챔피언에게 쓸모 있는 골드" 다

빌드 찾기(세 가지를 같이 돌려 서로 맞춰 본다)
  - dp: 묶음 배낭. dp[칸][골드] = 그 칸 수·골드 안에서 가장 큰 값. 묶음(신발·히드라·광휘 ...) 마다 하나만 고른다.
    choice[묶음][칸][골드] 에 무엇을 골랐는지 적어 두고 거꾸로 따라가 빌드를 되찾는다. 골드는 25 단위(올림)
  - greedy: 골드당 값(가성비) 순으로 넣을 수 있는 대로. 빠르지만 틀릴 수 있다(비교용)
  - exact: dp·가성비 상위 후보만 남겨 itertools.combinations 로 전부 따진다. 여기서는 더하기로 안 되는 것까지 본다
    (치명타 확률 100% 상한, 라바돈의 주문력 +30%). 최종 추천은 이것
"""
import functools
import itertools
import json
import math
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(HERE, "static", "items", "data.json")

GOLD_UNIT = 25           # dp 표의 골드 칸 하나. 아이템 값은 거의 25 의 배수(삼위일체 3333 은 3350 으로 본다)
MAX_BUDGET = 20000       # 6칸 다 채워도 2만이 안 넘는다. 이보다 크면 "골드 제한 없음"
SHORTLIST = 18           # exact 가 따질 전설 후보 수. C(18,5) = 8568 가지 × 신발
CRIT_CAP = 100

# 재료에서 풀어도 되는 스탯. 나머지(이동 속도 %·흡혈 ...) 는 재료에 고유 효과가 섞여 풀면 너무 비싸게 나온다
# (에테르 환영에서 이동 속도 1% 를 풀면 72골드). 그런 스탯은 아래 값(롤 위키 골드 효율 기준값 근처) 을 쓴다
SOLVABLE = ("lethality", "armorpen", "mpen")
FALLBACK_GOLD = {"msp": 39.5, "mpenp": 45, "hsp": 50, "omnivamp": 40, "tenacity": 15,
                 "critdmg": 25, "gp10": 0, "lifesteal": 37.5, "mpen": 30, "lethality": 30,
                 "armorpen": 40, "mp5": 4, "hp5": 3}
# 서포터가 사는 아이템(금지된 우상 계열·주변 아군에게 주는 오라) 은 스탯보다 고유 효과로 산다.
# 그 몫을 값의 이만큼(아끼는 정도 "utility" 를 곱해서) 더한다
UTILITY_SHARE = .35

# 역할마다 스탯을 아끼는 정도(0~1). 처음 역할은 그대로, 두 번째 역할은 0.6 배로 섞는다(둘 중 큰 값)
ROLE_WEIGHTS = {
    "marksman": {"ad": 1, "as": 1, "crit": 1, "critdmg": .9, "armorpen": .8, "lethality": .35,
                 "lifesteal": .6, "omnivamp": .3, "ms": .6, "msp": .6, "ah": .3,
                 "hp": .2, "armor": .15, "mr": .15},
    "mage": {"ap": 1, "ah": .8, "mpen": 1, "mpenp": 1, "mana": .35, "mp5": .2,
             "hp": .25, "armor": .2, "mr": .2, "ms": .5, "msp": .5},
    "assassin": {"ad": 1, "ap": 1, "lethality": 1, "mpen": 1, "mpenp": .8, "armorpen": .6,
                 "ah": .7, "ms": .6, "msp": .7, "hp": .2, "omnivamp": .3},
    "fighter": {"ad": .9, "ap": .9, "hp": .8, "ah": .8, "armor": .5, "mr": .5, "as": .35,
                "omnivamp": .6, "lifesteal": .4, "tenacity": .5, "ms": .5, "msp": .5,
                "armorpen": .5, "lethality": .4, "hp5": .2},
    "tank": {"hp": 1, "armor": 1, "mr": 1, "ah": .8, "ms": .5, "msp": .5, "tenacity": .7,
             "hp5": .4, "ad": .1, "ap": .2, "mana": .1},
    "support": {"ah": 1, "hsp": 1, "mp5": .8, "hp": .5, "armor": .4, "mr": .4, "ap": .6,
                "ms": .6, "msp": .6, "mana": .3, "utility": 1},
}
PHYSICAL = ("ad", "lethality", "armorpen", "crit", "critdmg", "lifesteal")
MAGIC = ("ap", "mpen", "mpenp")
DEFENSE = ("hp", "armor", "mr")

STAT_KO = {
    "ad": "공격력", "ap": "주문력", "hp": "체력", "armor": "방어력", "mr": "마법 저항력",
    "as": "공격 속도", "crit": "치명타 확률", "critdmg": "치명타 피해량", "ah": "스킬 가속",
    "mana": "마나", "mp5": "마나 재생", "hp5": "체력 재생", "lethality": "물리 관통력",
    "armorpen": "방어구 관통력", "lifesteal": "생명력 흡수", "omnivamp": "모든 피해 흡혈",
    "hsp": "회복·보호막", "tenacity": "강인함", "gp10": "골드 획득", "ms": "이동 속도",
    "msp": "이동 속도 %", "mpen": "마법 관통력", "mpenp": "마법 관통력 %",
    "utility": "아군 지원 효과",
}

_data = None


def data():
    global _data
    if _data is None:
        with open(DATA_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        raw["items"] = {int(k): v for k, v in raw["items"].items()}
        raw["champions"] = {int(k): v for k, v in raw["champions"].items()}
        raw["consumables"] = {int(k): v for k, v in (raw.get("consumables") or {}).items()}
        raw["gold"] = gold_values(raw["items"])
        _data = raw
    return _data


def gold_values(items):
    """스탯 1 의 골드 값. 재료(완성품 아님) 의 값에서 푼다."""
    # 재료(다른 아이템이 되는 것) 만. 완성품은 고유 효과 값이 섞여 있어 스탯 값을 풀면 틀린다
    parts = [it for it in items.values() if it["kind"] == "part" and it["stats"] and it["to"]]
    known = {}
    # 스탯이 하나뿐인 기본 재료(롱소드·루비 수정 ...) 부터. 같은 스탯이 여럿이면 가장 싼 값(가장 효율 좋은 기본템)
    for it in parts:
        if len(it["stats"]) == 1 and not it["from"]:
            (s, v), = it["stats"].items()
            known[s] = min(known.get(s, 1e9), it["price"] / v)
    # 모르는 스탯이 하나 남은 재료로 그 스탯을 푼다. 여러 번 돌면 하나씩 풀린다
    for _ in range(3):
        solved = {}
        for it in parts:
            unknown = [s for s in it["stats"] if s not in known]
            if len(unknown) == 1 and unknown[0] in SOLVABLE:
                rest = it["price"] - sum(known[s] * v for s, v in it["stats"].items() if s in known)
                if rest > 0:
                    solved.setdefault(unknown[0], []).append(rest / it["stats"][unknown[0]])
        if not solved:
            break
        for s, vals in solved.items():
            known[s] = sorted(vals)[len(vals) // 2]
    for s, g in FALLBACK_GOLD.items():
        known.setdefault(s, g)
    return {s: round(g, 2) for s, g in known.items()}


# ── 챔피언이 아끼는 스탯 ─────────────────────────────────

def weights(champion, lane=None):
    roles = champion.get("roles") or ["fighter"]
    w = {}
    for i, role in enumerate(roles[:2]):
        scale = 1 if i == 0 else .6
        for s, v in ROLE_WEIGHTS.get(role, {}).items():
            w[s] = max(w.get(s, 0), v * scale)
    if lane == "support" and "support" not in roles:
        for s, v in ROLE_WEIGHTS["support"].items():
            w[s] = max(w.get(s, 0), v * .6)
    if lane == "support" or roles[0] == "support":
        # 서포터는 골드가 적고 관통력보다 아군을 돕는 쪽에 쓴다
        for s in ("mpen", "mpenp", "lethality", "armorpen", "crit"):
            if s in w:
                w[s] *= .3
    dmg = champion.get("damage")
    if dmg == "physical":
        for s in MAGIC:
            w[s] = w.get(s, 0) * .05
    elif dmg == "magic":
        for s in PHYSICAL:
            w[s] = w.get(s, 0) * .05
        w["as"] = w.get("as", 0) * .3
    durability = (champion.get("style") or {}).get("durability") or 2
    for s in DEFENSE:
        w[s] = w.get(s, 0) * (.7 + .15 * durability)
    if champion.get("ranged"):
        w["tenacity"] = w.get("tenacity", 0) * .6
    return {s: round(min(v, 1), 3) for s, v in w.items() if v > .01}


# 금지된 우상 계열 말고 서포터가 아군을 위해 사는 것. 롤 태그(Aura) 로 고르면 태양불꽃 방패·얼어붙은 심장까지 들어와서 번호로 정한다
SUPPORT_ITEMS = {
    2065,   # 슈렐리아의 군가
    3190,   # 강철의 솔라리 펜던트
    3109,   # 기사의 맹세
    3050,   # 지크의 융합
    6617,   # 월석 재생기
    6620,   # 헬리아의 메아리
    4005,   # 제국의 명령
    2524,   # 밴들파이프
    3222,   # 미카엘의 축복
}


def is_utility(item_id):
    item = data()["items"][item_id]
    return item.get("group") == "idol" or item_id in SUPPORT_ITEMS


def _stat_value(item_id, w, gold):
    return sum(n * gold.get(s, 0) * w.get(s, 0) for s, n in data()["items"][item_id]["stats"].items())


def item_value(item_id, w, gold, bonus=None):
    """아이템 값 = 스탯 값 + 고유 효과 몫(bonus).

    bonus: {번호: (몫, 스탯을 봐야 하는가)}. 몫 × 아이템 값만큼 더한다.
    스탯을 봐야 하는 것(중상·생존 아이템) 은 그 챔피언에게 스탯이 쓸모 있는 만큼만 더한다
    (상대가 회복형이라고 원딜에게 가시 갑옷을 사라고 하지 않게: 원딜에게 가시 갑옷 스탯은 값의 2할 남짓).
    """
    item = data()["items"][item_id]
    v = _stat_value(item_id, w, gold)
    share, scaled = (bonus or {}).get(item_id, (0, False))
    if share:
        fit = min(1.0, v / (item["price"] * .8)) if scaled else 1.0
        v += item["price"] * share * fit
    return v


def base_bonus(w):
    """챔피언만 보고 정하는 고유 효과 몫: 서포터 아이템."""
    if not w.get("utility"):
        return {}
    return {i: (UTILITY_SHARE * w["utility"], False) for i in data()["items"] if is_utility(i)}


# ── 게임 상황으로 값 바꾸기 ──────────────────────────────
# ctx(item_context.make_context 가 만든다. 모르는 칸은 없음):
#   t       게임 시간(분)            lane    라인전 상태 -1(밀림) ~ +1(앞섬)
#   e_ad    적 피해 중 AD 비중 0~1   e_tank  적 단단함 0~1     e_heal 적 회복 0~1
#   e_cc    적 CC 0~1                e_burst 적 순간 피해(암살자·폭딜 마법사) 0~1
#   a_front 아군 앞라인 0~1          heal_names 적 회복 챔피언 이름(이유 글에만)

OFFENSE = ("ad", "ap", "as", "crit", "critdmg", "lethality", "armorpen", "mpen", "mpenp")
SUSTAIN = ("lifesteal", "omnivamp", "hp5", "mp5", "mana")
GRIEVOUS_ITEMS = {3033, 3075, 3165, 6609}          # 필멸자의 운명·가시 갑옷·모렐로노미콘·화공 펑크 사슬검
SURVIVE_ITEMS = {3157, 3026, 3102, 3156, 3053, 3814, 6673}   # 존야·수호 천사·밴시·맬모셔스·스테락·밤의 끝자락·불멸의 철갑궁
CLEANSE_ITEMS = {3139}                              # 헤르메스의 시미터(정화)
CARRY_ROLES = ("marksman", "mage", "assassin")


def phase(t):
    """게임 시간(분) → (라인전 몫, 조합 몫). 시간을 모르면 (0.5, 1).

    라인전 몫: 12분까지 1, 22분에 0. 라인전 상태·유지력·가성비 순서에 곱한다
    조합 몫: 0분 0.5 → 15~25분 1(한타가 잦아짐) → 그 뒤 천천히 0.7. 후반에는 챔피언에 맞는 완성 템이 중심이고 조합은 거든다
    """
    if t is None:
        return .5, 1.0
    lane_w = 1.0 if t <= 12 else max(0.0, 1 - (t - 12) / 10)
    comp_w = .5 + .5 * min(1.0, t / 15) if t <= 25 else max(.7, 1 - (t - 25) * .03)
    return lane_w, comp_w


def _pct(x):
    return "%+d%%" % round(x * 100)


def apply_context(w, champ, ctx):
    """ctx 로 아끼는 정도와 고유 효과 몫을 바꾼다. → (w, w_now, bonus, 가성비 순서 몫, 이유 목록)

    w: 완성 빌드(6칸) 를 고르는 잣대. 챔피언 + 적·아군 조합 + 라인전 상태의 절반(앞서고 밀린 것은 오래 간다)
    w_now: 사는 순서·첫 템을 정하는 잣대. w 에 라인전 몫(유지력·라인전 상태 나머지 절반) 을 더 얹는다.
    라인전 유지력을 완성 빌드에 넣으면 다리우스가 피바라기를 사는 것처럼 후반에 안 맞는 템이 섞여서 둘을 나눈다.
    """
    w, bonus, why = dict(w), base_bonus(w), []
    if not ctx:
        return w, dict(w), bonus, 0.0, why
    t, s = ctx.get("t"), ctx.get("lane")
    L, C = phase(t)
    roles = champ.get("roles") or ["fighter"]
    durability = (champ.get("style") or {}).get("durability") or 2
    carry = roles[0] in CARRY_ROLES
    front = roles[0] in ("tank", "fighter") or durability >= 3

    def mul(stats, k):
        for st in stats:
            if w.get(st):
                w[st] *= k

    def add(st, x):
        w[st] = w.get(st, 0) + x

    if t is not None:
        if L >= .5:
            why.append("라인전 %d분: 사는 순서는 유지력(흡혈·재생·마나 %s)과 골드 대비 효율이 좋은 템 먼저" % (t, _pct(.6 * L)))
        elif t >= 25:
            why.append("후반 %d분: 한타 위주라 %s에게 맞는 완성 템 중심" % (t, champ["name"]))
    eff = .35 * L
    lane_moves = []         # (스탯들, 곱) — 완성 빌드에는 √(곱) 만큼(절반), 지금 사는 순서에는 곱 그대로

    if s is not None and L > 0:
        if s > .15:
            lane_moves.append((OFFENSE, 1 + .25 * L * s))
            why.append("라인전 앞섬: 공격 템 가치 %s(굴리기)" % _pct(.25 * L * s))
        elif s < -.15:
            k = .5 * L * -s
            for st in ("hp", "armor", "mr"):
                add(st, .1 * L * -s)
            lane_moves.append((("hp", "armor", "mr"), 1 + k))
            eff += .5 * L * -s
            why.append("라인전 밀림: 방어 가치 %s, 싸고 빨리 완성되는 템 먼저" % _pct(k))
    for stats, k in lane_moves:
        mul(stats, math.sqrt(k))

    e_ad, e_burst = ctx.get("e_ad"), ctx.get("e_burst") or 0
    if e_ad is not None:
        threat = C * (.5 + .5 * e_burst + .3 * max(0.0, -(s or 0)) * L)
        add("armor", .5 * threat * e_ad)
        add("mr", .5 * threat * (1 - e_ad))
        if e_ad >= .65:
            why.append("적 피해 %d%%가 AD: 방어력 가치 ↑" % round(e_ad * 100))
        elif e_ad <= .35:
            why.append("적 피해 %d%%가 AP: 마법 저항력 가치 ↑" % round((1 - e_ad) * 100))
    tank = ctx.get("e_tank") or 0
    if tank:
        mul(("armorpen", "mpenp"), 1 + .8 * C * tank)
        mul(("lethality", "mpen"), 1 - .35 * C * tank)
        if tank >= .3:
            why.append("적이 단단함: %% 관통력 가치 %s, 고정 관통력 %s" % (_pct(.8 * C * tank), _pct(-.35 * C * tank)))
    heal = ctx.get("e_heal") or 0
    if heal:
        for i in GRIEVOUS_ITEMS:
            bonus[i] = (bonus.get(i, (0, True))[0] + .4 * C * heal, True)
        if heal >= .3:
            names = ", ".join(ctx.get("heal_names") or ())
            why.append("적 회복%s: 치유 감소(중상) 아이템 우선" % (" (" + names + ")" if names else ""))
    cc = ctx.get("e_cc") or 0
    if cc:
        add("tenacity", .6 * C * cc)
        for i in CLEANSE_ITEMS:
            bonus[i] = (.25 * C * cc, True)
        if cc >= .5:
            why.append("적 CC 많음: 강인함 가치 ↑")
    if e_burst and durability <= 2:
        for i in SURVIVE_ITEMS:
            bonus[i] = (bonus.get(i, (0, True))[0] + .3 * C * e_burst, True)
        if e_burst >= .4:
            why.append("적 순간 피해가 큼: 존야·수호 천사 같은 생존 아이템 우선")
    fr = ctx.get("a_front")
    if fr is not None:
        if front and fr < .34:
            mul(("hp", "armor", "mr"), 1 + .35 * C)
            why.append("아군 앞라인이 없음: %s가 더 단단하게" % champ["name"])
        elif carry and fr >= .67:
            mul(("hp", "armor", "mr"), 1 - .25 * C)
            mul(OFFENSE, 1 + .1 * C)
            why.append("아군 앞라인이 든든함: 방어보다 공격에 투자")
    now = dict(w)
    lane_ad = ctx.get("e_ad_lane")
    if lane_ad is not None and L > 0:
        # 라인전 동안 맞라인 피해에 맞춘 방어(도란 + 마법무효화의 망토 같은 것). 지금 사는 것에만
        k = .6 * L * (1 + max(0.0, -(s or 0)))
        now["armor"] = now.get("armor", 0) + k * lane_ad
        now["mr"] = now.get("mr", 0) + k * (1 - lane_ad)
        names = ", ".join(ctx.get("lane_names") or ())
        if lane_ad <= .35:
            why.append("맞라인 AP(%s): 라인전 동안 마법 저항력 하위템 가치 ↑" % names)
        elif lane_ad >= .65 and L >= .5:
            why.append("맞라인 AD(%s): 라인전 동안 방어력 하위템 가치 ↑" % names)
    for st in SUSTAIN:
        if now.get(st):
            now[st] *= 1 + .6 * L
    for stats, k in lane_moves:
        for st in stats:
            if now.get(st):
                now[st] *= math.sqrt(k)
    clean = lambda d: {k: round(v, 3) for k, v in d.items() if v > .01}  # noqa: E731
    return clean(w), clean(now), bonus, min(eff, .9), why


def freeze(ctx):
    """ctx(dict) → lru_cache 에 넣을 수 있는 묶음. 값은 반올림해 비슷한 상황끼리 기억을 같이 쓴다."""
    if not ctx:
        return ()
    out = []
    for k, v in sorted(ctx.items()):
        if v is None:
            continue
        if k == "t":
            v = int(v)
        elif isinstance(v, float):
            v = round(v * 20) / 20
        elif isinstance(v, list):
            v = tuple(v)
        out.append((k, v))
    return tuple(out)


# ── 빌드 찾기 ────────────────────────────────────────────

def _units(price):
    return -(-price // GOLD_UNIT)


NONE = float("-inf")


def build_dp(cands, budget, slots, must=None):
    """묶음 배낭. cands: [(번호, 값, 골드, 묶음)]. 묶음마다 하나만. must 묶음(신발) 은 꼭 하나. → (번호 목록, 값)

    dp[k][g]: 묶음을 앞에서부터 보면서, 아이템 k 개 이하·골드 g 칸 이하로 얻는 가장 큰 값.
    choice[n][k][g]: n 번째 묶음에서 그 칸에 무엇을 넣었는지(-1 은 안 넣음). 3차원이어야 거꾸로 따라갈 수 있다
    (한 줄 dp 를 덮어쓰며 채우면 마지막 줄만 남아서 무엇을 골랐는지 잃는다).
    must 묶음은 맨 먼저 넣고, 그 묶음에서 아무것도 안 넣은 칸은 "불가능"(-∞) 으로 지운다.
    """
    G = _units(budget)
    groups = {}
    for c in cands:
        groups.setdefault(c[3] or ("solo", c[0]), []).append(c)
    must_first = must in groups
    groups = ([groups.pop(must)] if must_first else []) + list(groups.values())
    dp = [[0.0] * (G + 1) for _ in range(slots + 1)]
    choice = []
    for n, group in enumerate(groups):                     # 묶음
        pick = [[-1] * (G + 1) for _ in range(slots + 1)]
        for k in range(slots, 0, -1):                      # 칸(거꾸로: 같은 묶음을 두 번 넣지 않게)
            row, prev = dp[k], dp[k - 1]
            for g in range(G, -1, -1):                     # 골드(거꾸로)
                best, who = row[g], -1
                for j, (_, v, price, _) in enumerate(group):
                    u = _units(price)
                    if u <= g and prev[g - u] + v > best:
                        best, who = prev[g - u] + v, j
                if who >= 0:
                    row[g], pick[k][g] = best, who
        if n == 0 and must_first:
            for k in range(slots + 1):
                for g in range(G + 1):
                    if pick[k][g] < 0:
                        dp[k][g] = NONE
        choice.append(pick)
    if dp[slots][G] == NONE:
        return [], 0.0
    # 거꾸로 따라가기: 마지막 묶음부터, 그 칸에서 무엇을 넣었으면 그만큼 칸과 골드를 돌려받는다
    k, g, chosen = slots, G, []
    for n in range(len(groups) - 1, -1, -1):
        j = choice[n][k][g]
        if j >= 0:
            item = groups[n][j]
            chosen.append(item[0])
            k, g = k - 1, g - _units(item[2])
    return chosen[::-1], dp[slots][G]


def build_greedy(cands, budget, slots, must=None):
    """가성비(골드당 값) 순으로 넣는다. 빠르지만 비싼 핵심 아이템을 놓칠 수 있다. must 묶음은 가성비 1등을 먼저."""
    left, used, chosen = budget, set(), []
    ranked = sorted(cands, key=lambda c: c[1] / c[2], reverse=True)
    first = [c for c in ranked if c[3] == must and c[2] <= budget][:1] if must else []
    for item_id, v, price, group in first + ranked:
        if len(chosen) == slots:
            break
        if v <= 0 or price > left or (group and group in used):
            continue
        chosen.append(item_id)
        left -= price
        if group:
            used.add(group)
    return chosen


def _whole_value(ids, w, gold, bonus=None):
    items = data()["items"]
    total = {}
    for i in ids:
        for s, v in items[i]["stats"].items():
            total[s] = total.get(s, 0) + v
    if "crit" in total:
        total["crit"] = min(total["crit"], CRIT_CAP)
    if 3089 in ids and "ap" in total:
        total["ap"] *= 1.3
    v = sum(n * gold.get(s, 0) * w.get(s, 0) for s, n in total.items())
    if bonus:   # 고유 효과 몫은 아이템마다 따로(스탯 합과 상관없다)
        v += sum(item_value(i, w, gold, bonus) - _stat_value(i, w, gold) for i in ids if i in bonus)
    return v


def true_value(ids, w, gold, kept=(), bonus=None):
    """더하기로 안 되는 것까지 본 값: 치명타 확률은 100% 까지만, 라바돈은 주문력 +30%.

    kept(이미 가진 것) 가 있으면 그것과 합친 값에서 가진 것만의 값을 뺀, 새로 사는 몫이다.
    """
    kept = list(kept)
    return _whole_value(kept + list(ids), w, gold, bonus) - (_whole_value(kept, w, gold, bonus) if kept else 0)


def build_exact(cands, budget, slots, w, gold, kept=(), must_boots=False, seed=(), bonus=None):
    """후보를 줄여 itertools.combinations 로 전부 따진다. → (번호 목록, 값, 따진 경우의 수)

    seed(dp·greedy 가 고른 것) 는 꼭 후보에 넣는다. 그래서 이 답은 dp·greedy 보다 나쁠 수 없다.
    """
    boots = [c for c in cands if c[3] == "boots"]
    others = sorted((c for c in cands if c[3] != "boots"), key=lambda c: c[1], reverse=True)
    # 값이 큰 것 + 가성비 좋은 것을 같이 남긴다(골드가 빠듯하면 싼 게 낫다)
    by_eff = sorted(others, key=lambda c: c[1] / c[2], reverse=True)
    must_keep = [c for c in others if c[0] in set(seed)]
    keep = {c[0]: c for c in must_keep}
    for c in others[:SHORTLIST * 2 // 3] + by_eff:
        if len(keep) >= max(SHORTLIST, len(must_keep)):
            break
        keep.setdefault(c[0], c)
    short = sorted(keep.values(), key=lambda c: c[1], reverse=True)
    best, best_v, tried = [], -1.0, 0
    boot_opts = boots if must_boots and boots else [None] + boots
    for boot in boot_opts:
        n_slots = slots - (1 if boot else 0)
        b_price = boot[2] if boot else 0
        for n in range(n_slots, -1, -1):
            found = False
            for combo in itertools.combinations(short, n):
                tried += 1
                price = b_price + sum(c[2] for c in combo)
                if price > budget:
                    continue
                groups = [c[3] for c in combo if c[3]]
                if len(groups) != len(set(groups)):
                    continue
                ids = [c[0] for c in combo] + ([boot[0]] if boot else [])
                v = true_value(ids, w, gold, kept, bonus)
                found = True
                if v > best_v:
                    best, best_v = ids, v
            if budget >= MAX_BUDGET and found:
                break   # 골드 제한이 없으면 칸을 다 채우는 쪽만 보면 된다(값은 0 이상이라 비워서 나아지지 않는다)
    return best, best_v, tried


def order(ids, values, eff=0.0):
    """사는 순서: 첫 템 → 신발 → 나머지.

    eff(0~1, 라인전일수록·밀릴수록 크다) 만큼 골드 대비 값(가성비) 을 섞어 줄 세운다. 0 이면 값이 큰 순(후반: 핵심 템 먼저),
    1 이면 가성비 순(라인전에서 밀릴 때: 빨리 완성되는 템 먼저). 가성비는 전설 평균 값(2800) 에 맞춰 같은 잣대로 섞는다.
    """
    items = data()["items"]

    def key(i):
        v = values.get(i, 0)
        return v * (1 - eff) + eff * v / items[i]["price"] * 2800
    rest = sorted(ids, key=key, reverse=True)
    boots = [i for i in rest if items[i]["kind"] == "boots"]
    core = [i for i in rest if items[i]["kind"] != "boots"]
    return core[:1] + boots + core[1:]


def recommend(champion_id, lane=None, budget=None, slots=6, owned=(), boots=True, ctx=None):
    """빌드 추천. owned: 이미 가진 아이템 번호(전설·신발은 빌드에 그대로 두고 남은 칸을 채운다).

    한 번에 0.3~0.4초 걸려서 같은 물음은 기억해 둔 답을 준다(자료는 서버가 켜진 동안 바뀌지 않는다).
    돌려준 dict 는 여럿이 같이 쓰니 고치지 않는다. ctx: 게임 상황(item_context.make_context). 없으면 챔피언만 본다.
    """
    # None 만 "제한 없음". 0·10 골드도 진짜 예산이다(예전엔 0 으로 내려 버림 → 제한 없음으로 바뀌었다)
    if budget is not None and budget < MAX_BUDGET:
        budget = max(0, int(budget)) // GOLD_UNIT * GOLD_UNIT
    else:
        budget = None
    return _recommend(int(champion_id), lane, budget, max(1, min(6, int(slots))),
                      tuple(sorted(int(i) for i in owned)), bool(boots), freeze(ctx))


@functools.lru_cache(maxsize=512)
def _recommend(champion_id, lane, budget, slots, owned, boots, ctx):
    owned, ctx = list(owned), dict(ctx)
    d = data()
    items, gold = d["items"], d["gold"]
    champ = d["champions"].get(int(champion_id))
    if champ is None:
        raise KeyError("모르는 챔피언입니다")
    budget = MAX_BUDGET if budget is None or budget >= MAX_BUDGET else max(0, int(budget))
    w, w_now, bonus, eff, why = apply_context(weights(champ, lane), champ, ctx)

    kept = [i for i in owned if i in items and items[i]["kind"] in ("legendary", "boots", "boots3")]
    taken_groups = {items[i]["group"] for i in kept if items[i].get("group")}
    free = max(0, slots - len(kept))
    has_boots = any(items[i]["kind"].startswith("boots") for i in kept)

    values = {i: item_value(i, w, gold, bonus) for i in items}
    # 사는 순서는 지금(라인전) 잣대로. 라인전이 아니면 w 와 같다
    values_now = values if w_now == w else {i: item_value(i, w_now, gold, bonus) for i in items}
    cands = [(i, values[i], it["price"], it.get("group")) for i, it in items.items()
             if it["kind"] in ("legendary", "boots") and i not in kept and values[i] > 0
             and not (it.get("group") and it["group"] in taken_groups)]
    if not boots or has_boots:
        cands = [c for c in cands if c[3] != "boots"]
    # 신발은 꼭 하나(카시오페아처럼 신발을 못 사는 챔피언·신발을 끈 경우는 빼고). 6칸을 다 전설로 채우는 게
    # 스탯 값으로는 더 크지만, 실제로는 신발이 싸고 이동 속도가 커서 누구나 산다
    must = "boots" if boots and not has_boots and free > 0 else None
    # 가장 싼 신발도 못 사는 예산이면 신발을 꼭 넣으라는 조건 때문에 빈 빌드가 된다. 그땐 조건을 푼다
    if must and not any(c[3] == "boots" and c[2] <= budget for c in cands):
        must = None

    t0 = time.perf_counter()
    dp_ids, _ = build_dp(cands, budget, free, must)
    t1 = time.perf_counter()
    gr_ids = build_greedy(cands, budget, free, must)
    t2 = time.perf_counter()
    ex_ids, _, tried = build_exact(cands, budget, free, w, gold, kept, bool(must), dp_ids + gr_ids, bonus)
    t3 = time.perf_counter()

    def pack(ids, ms):
        full = order(ids, values_now, eff)
        return {"items": [_item_out(i, values[i]) for i in full],
                "price": sum(items[i]["price"] for i in full),
                "value": round(sum(values[i] for i in full)),
                "true_value": round(true_value(full, w, gold, kept, bonus)),
                "ms": round(ms * 1000, 1)}

    return {
        "patch": d["patch"],
        "champion": {"id": int(champion_id), "key": champ["key"], "name": champ["name"],
                     "roles": champ["roles"], "damage": champ["damage"]},
        "lane": lane, "budget": budget if budget < MAX_BUDGET else None, "slots": slots,
        "owned": [_item_out(i, values.get(i, 0)) for i in kept],
        "weights": sorted(({"stat": s, "name": STAT_KO.get(s, s), "w": v, "gold": gold.get(s)}
                           for s, v in w.items() if v >= .1), key=lambda x: -x["w"]),
        "best": pack(ex_ids, t3 - t2),
        "dp": pack(dp_ids, t1 - t0),
        "greedy": pack(gr_ids, t2 - t1),
        "exact_tried": tried,
        "reasons": why,
        "context": {k: v for k, v in ctx.items() if k not in ("heal_names", "heal_lane_names", "lane_names")},
        "candidates": len(cands),
    }


def item_out(i):
    """화면에 보낼 아이템 한 칸(값 없이)."""
    it = data()["items"][i]
    return {"id": i, "name": it["name"], "price": it["price"], "kind": it["kind"], "stats": it["stats"]}


def _item_out(i, value):
    it = data()["items"][i]
    return {"id": i, "name": it["name"], "price": it["price"], "value": round(value),
            "kind": it["kind"], "stats": it["stats"]}


# ── 지금 살 것 ────────────────────────────────────────────

def _remaining(i, pool):
    """i 를 완성하는 데 남은 골드. pool(가진 재료 번호 목록) 에서 쓴 재료는 꺼낸다."""
    it = data()["items"][i]
    if i in pool:
        pool.remove(i)
        return 0
    return it["cost"] + sum(_remaining(f, pool) for f in it["from"])


def next_buy(build_ids, inventory, gold, limit=2):
    """빌드 순서대로, 지금 골드로 살 수 있는 것. 완성이 안 되면 그 아이템의 재료 중 살 수 있는 가장 비싼 것.

    inventory: 지금 가방의 아이템 번호(재료 포함). 돌려주는 것: [{id, name, cost, toward}]
    """
    items = data()["items"]
    pool = [i for i in inventory if i in items]
    out, left = [], gold
    todo = list(build_ids)
    for t in build_ids:                 # 이미 다 만든 것은 빼고, 그 자리는 가방에서 꺼낸다
        if t in pool:
            pool.remove(t)
            todo.remove(t)
    while todo:
        # 이미 시작한 아이템을 먼저 마친다(장화·단검을 들고 있는데 다른 전설부터 사라고 하지 않게). 없으면 빌드 순서 그대로
        target = next((t for t in todo if _started(t, pool)), todo[0])
        todo.remove(target)
        trial = list(pool)
        need = _remaining(target, trial)
        if need <= left:
            out.append({"id": target, "name": items[target]["name"], "cost": need, "toward": None})
            left -= need
            pool = trial
        else:
            part = _best_part(target, pool, left)
            if part:
                out.append({"id": part[0], "name": items[part[0]]["name"], "cost": part[1],
                            "toward": items[target]["name"]})
                left -= part[1]
            break       # 핵심을 다 맞추기 전에는 다음 아이템으로 넘어가지 않는다
        if len(out) >= limit:
            break
    return out


STARTED_SHARE = .3


def _started(target, pool):
    """가방의 재료로 target 을 이미 꽤 만들어 둔 것인가. 시작템 롱소드 하나(350) 로 3300 짜리를 "시작했다" 고 보지 않게
    재료 값이 target 값의 30% 이상일 때만. 신발은 장화만 있어도(신발 칸은 하나라 다른 데 쓸 데가 없다).
    재료가 앞에서 다른 아이템에 쓰였으면 pool 에서 빠져 있어 더는 시작한 것이 아니다."""
    items = data()["items"]
    tree, left, have = _tree(target), list(pool), 0
    for p in pool:
        if p in tree and p in left:
            left.remove(p)
            have += items[p]["price"]
    if items[target]["kind"] == "boots" and 1001 in pool:
        return True
    return have >= items[target]["price"] * STARTED_SHARE


def _tree(i):
    """i 를 만드는 데 들어가는 모든 재료 번호."""
    items, out, stack = data()["items"], set(), list(data()["items"][i]["from"])
    while stack:
        p = stack.pop()
        if p not in out:
            out.add(p)
            stack.extend(items[p]["from"])
    return out


def _best_part(target, pool, gold):
    """target 의 재료 나무에서 지금 살 수 있고(가진 하위 재료를 써서) 가장 비싼 것 → (번호, 드는 골드)."""
    items = data()["items"]
    best = None
    # 가진 재료는 하나씩 꺼내 가며 걷는다. 같은 재료가 둘 드는 아이템(지배자의 피갑옷 = 땅굴 채굴기 × 2) 에서
    # 하나만 가졌을 때 두 번째를 "가졌다" 고 건너뛰지 않게
    local = list(pool)
    stack = list(items[target]["from"])
    while stack:
        p = stack.pop()
        if p in local:
            local.remove(p)
            continue
        need = _remaining(p, list(local))
        if need <= gold and (best is None or items[p]["price"] > items[best[0]]["price"]):
            best = (p, need)
        stack.extend(items[p]["from"])
    return best


# ── 템트리 + 상황 → 완성 빌드 ────────────────────────────
# 우선순위(위가 먼저):
#   1. 챔피언 템트리(OP.GG 코어 순서) — 코어 3개와 그 순서는 바꾸지 않는다
#   2. 챔피언에 맞는가 — 아이템 값이 그 챔피언의 스탯 가중치(weights) 로 매겨져서 마법사에게 방어 템은 값이 낮다
#   3. 시간·라인전 — 이번 귀환에 살 하위템(plan_buy) 에서 본다. 완성 빌드에는 넣지 않는다
#   4. 조합 — 신발과 4·5·6번째를 OP.GG 후보 안에서 고르거나, 후보 밖 템(중상·생존) 이 이 몫을 넘을 만큼 좋을 때만 바꾼다
TREE_PRIOR = .35          # OP.GG 후보는 값 × (1 + 0.35 + 0.5 × 픽률). 후보 밖 템은 이 몫을 넘어야 들어온다
TREE_SLOTS = ("fourth", "fifth", "sixth")


def _tree_score(i, values, pick=None):
    v = values.get(i, 0)
    return v if pick is None else v * (1 + TREE_PRIOR + .5 * pick)


def plan_build(champion_id, lane, tree, ctx=None, owned=()):
    """OP.GG 템트리를 뼈대로 6칸 빌드를 정한다. → {items: [번호 순서대로], picks: [{id, slot, note}], reasons, source}

    tree: item_tree.fetch 의 dict. None 이면 스탯 값만으로 고른 recommend() 의 빌드를 쓴다(source "value").
    owned: 가방. 이미 가진 전설·신발은 그대로 두고 그 칸을 뺀다(OP.GG 에 없는 템을 샀어도).
    """
    d = data()
    items, gold = d["items"], d["gold"]
    champ = d["champions"][int(champion_id)]
    w, _, bonus, _, why = apply_context(weights(champ, lane), champ, ctx)
    kept = [i for i in owned if i in items and items[i]["kind"] in ("legendary", "boots", "boots3")]
    if not tree or not tree.get("core"):
        r = recommend(champion_id, lane, None, 6, owned, ctx=ctx)
        ids = [x["id"] for x in r["owned"]] + [x["id"] for x in r["best"]["items"]]
        return {"items": ids, "picks": [{"id": i, "slot": "value", "note": None} for i in ids],
                "reasons": list(r["reasons"]), "source": "value"}

    values = {i: item_value(i, w, gold, bonus) for i, it in items.items() if it["kind"] in ("legendary", "boots")}
    chosen, picks, groups = [], [], set()

    def free(i):
        it = items.get(i)
        return it and i not in chosen and not (it.get("group") and it["group"] in groups)

    def take(i, slot, note=None):
        chosen.append(i)
        picks.append({"id": i, "slot": slot, "note": note})
        if items[i].get("group"):
            groups.add(items[i]["group"])

    has_boots = any(items[i]["kind"].startswith("boots") for i in kept)
    for i in kept:                       # 가진 것의 묶음(신발·히드라 ...) 은 이미 찼다
        if items[i].get("group"):
            groups.add(items[i]["group"])

    for n, i in enumerate(tree["core"][:3]):
        if i in kept:
            chosen.append(i)
            picks.append({"id": i, "slot": "core%d" % (n + 1), "note": None})
        elif free(i) and items[i]["kind"] == "legendary":
            take(i, "core%d" % (n + 1))
        if n == 0 and not has_boots:
            # 신발은 첫 코어 다음(OP.GG 도 대부분 이 순서). OP.GG 신발 + 상황이 확실히 다른 신발을 원할 때만 바꾼다
            base = next((b for b in tree.get("boots") or () if b in values), None)
            opts = [(_tree_score(b, values, 1.0 if b == base else None), b) for b in values if items[b]["kind"] == "boots"]
            if opts:
                best = max(opts)[1]
                note = None
                if base and best != base:
                    note = "OP.GG %s 대신(상황)" % items[base]["name"]
                take(best, "boots", note)

    # 4·5·6번째: 그 칸의 OP.GG 후보(픽률 몫을 얹어) 와 상황 템(조합 몫이 있는 것) 중 가장 좋은 것.
    # 순서는 칸 그대로라 피바라기가 5번째 후보면 라인전이어도 5번째에 둔다(앞당기지 않는다)
    extras = [i for i in bonus if i in values and items[i]["kind"] == "legendary" and bonus[i][0] > 0
              and not is_utility(i)]
    seen = [i for k in TREE_SLOTS for i, _ in tree.get(k) or ()]
    for k in TREE_SLOTS:
        if len(chosen) + len([i for i in kept if i not in chosen]) >= 6:
            break
        opts = [(_tree_score(i, values, p), i, True) for i, p in tree.get(k) or () if free(i)]
        if not opts:     # 후보가 없는 칸(서포터 6번째 등): 다른 칸의 후보에서
            opts = [(_tree_score(i, values, 0), i, True) for i in seen if free(i)]
        opts += [(_tree_score(i, values), i, False) for i in extras if free(i)]
        if not opts:
            opts = [(values[i], i, False) for i in values if items[i]["kind"] == "legendary" and free(i)]
        if not opts:
            break
        _, i, from_tree = max(opts)
        top = next((j for j, _ in tree.get(k) or () if free(j)), None)
        note = None
        if not from_tree:
            note = "OP.GG 후보 밖, 상대 조합 때문에"
        elif top is not None and i != top:
            note = "OP.GG %s 대신(상황)" % items[top]["name"]
        take(i, k, note)

    # 가진 것 중 빌드에 없는 전설은 앞에(이미 칸을 차지했다). 6칸이 넘으면 뒤에서 자른다
    extra_kept = [i for i in kept if i not in chosen]
    order_ids = extra_kept + chosen
    order_ids = order_ids[:6]
    picks = [{"id": i, "slot": "owned", "note": None} for i in extra_kept] + picks
    picks = [p for p in picks if p["id"] in order_ids]
    for p in picks:
        if p["note"]:
            why.append("%s: %s" % (items[p["id"]]["name"], p["note"]))
    return {"items": order_ids, "picks": picks, "reasons": why, "source": tree.get("source", "opgg")}


# ── 지금 살 것: 이번 귀환에 무엇을 살까(하위템 단위) ───────
# OP.GG 는 완성템 순서만 알려 준다. 완성템 하나에는 하위템이 여럿이고 성능이 다르다(무한의 대검 = B.F. 대검·곡괭이·망토).
# 또 다른 템의 하위템을 먼저 올렸다가(처형인의 대검·망각의 구·덤불 조끼 ...) 원래 코어로 돌아가는 일도 잦다.
# 그래서 이번 골드·빈 칸으로 살 "묶음" 을 고르는 것을 배낭 문제로 푼다.
#
#   묶음(그룹) = 빌드의 아직 못 만든 아이템 하나. 그 안의 선택지 = 완성하기 / 아직 없는 재료들을 하나씩 (안 삼·통째·그 재료의 하위 하나)
#   + "돌아가기" 그룹 하나: 빌드 밖 하위템(상황 효과가 있는 것). 한 번 귀환에 하나까지
#   값 = 지금 효과(그 하위템 스탯 × 지금 잣대 + 고유 효과) + 진행 몫(쓴 골드 × 그 아이템이 빌드에서 얼마나 가까운가)
#        + 완성하면 파워 스파이크 몫 - 완성하며 없어지는 재료의 스탯
#   dp[빈 칸][골드] 를 그룹마다 갱신, choice[그룹][빈 칸][골드] 로 되찾는다. 완성하면 재료가 빠져 칸이 늘 수 있다(-칸)
#   exact: 앞쪽 그룹만 남겨 itertools.product 로 다 따진다. dp 가 못 하는 것(시작템 팔아 칸 만들기, 치명타 100% 상한,
#   칸 순서와 상관없는 계산) 까지 본다. dp 답을 꼭 넣어서 dp 보다 나쁠 수 없다

TRINKETS = {3340, 3363, 3364, 3330, 3513}             # 장신구 칸(아이템 칸을 차지하지 않는다)
SELLABLE = {1054, 1055, 1056, 1083, 2003, 2031}       # 칸이 모자라면 팔아도 되는 시작템: 도란 3종·수확의 낫·물약
SELL_BACK = .4
LINK = (1.0, .6, .4, .3, .25, .2)                    # 빌드에서 몇 번째 남은 아이템의 재료인가 → 진행 몫
DETOUR_LINK = .1                                     # 빌드 밖 하위템
SPIKE = .3                                           # 완성 몫(완성템의 고유 효과·파워 스파이크): 값 × 0.3 × 가까움
PASSIVE_GOLD = 1000                                  # 하위템 고유 효과 몫 1 의 골드
# 하위템 자체에 상황 효과가 있는 것: 처형인의 대검·망각의 구·덤불 조끼(중상), 수은 장식띠(정화)
PART_PASSIVE = {3123: "heal", 3916: "heal", 3076: "heal", 3140: "cc"}
# 고유 효과는 없지만 라인전 방어로 잠깐 돌아가는 기본 하위템: 천 갑옷·마법무효화의 망토
DETOUR_BASICS = {1029: "armor", 1033: "mr"}
EPIC_SHARE = .15                                     # 중간 재료의 고유 효과 몫(그 재료 스탯 값의 15%)
SLOT_COST = 60                                       # 가방 한 칸을 더 쓰는 값(롱소드 셋보다 톱날 단검 하나)
PART_FIT = .35                                       # 고유 효과 하위템을 "먼저 올리기" 후보로 볼 적합도 바닥
TREE_FLOOR = .7                                      # 빌드 아이템 재료를 볼 때 그 아이템 스탯의 가중치 바닥
# 소모품(data.json 의 consumables. items 와 따로 둔다). 값은 "그 골드로 다른 걸 사는 것보다 나은가" 의 대략
WARD = 2055
WARD_VALUE = {"support": 320, "jungle": 260}          # 제어 와드 75골드. 다른 라인은 6분부터 150
ELIXIRS = {"tank": 2138, "fighter": 2138, "magic": 2139, "physical": 2140}   # 강철·마법·분노의 영약
ELIXIR_VALUE = 650                                    # 빌드를 다 채운 뒤(500골드)
EXACT_GROUPS = 4                                     # exact 가 다 따질 그룹 수(앞쪽 아이템 + 돌아가기)
EXACT_KEEP = 7                                       # 그룹마다 남길 선택지 수


def _passive_shares(ctx):
    """ctx → 하위템 고유 효과 몫. heal: 라인전 맞라인 회복(지금) + 팀 회복(한타). cc: 적 CC."""
    L, C = phase((ctx or {}).get("t"))
    ctx = ctx or {}
    return {"heal": .9 * L * (ctx.get("e_heal_lane") or 0) + .35 * C * (ctx.get("e_heal") or 0),
            "cc": .4 * C * (ctx.get("e_cc") or 0) * ((ctx.get("e_burst") or 0) + .5)}


def _unit_value(i, wt, gold, bonus, shares, w_fit=None):
    """아이템 하나의 지금 값: 재료면 스탯 + 고유 효과 몫(챔피언이 그 스탯을 쓰는 만큼만), 완성템이면 item_value.

    w_fit: "이 챔피언이 쓰는 템인가" 를 볼 잣대(라인전 방어로 올린 가중치 말고 원래 가중치).
    안 그러면 드레이븐 상대로 방어력 가치가 오른 원딜에게 덤불 조끼(중상) 가 맞는 템처럼 보인다.
    """
    it = data()["items"][i]
    if it["kind"] != "part":
        return item_value(i, wt, gold, bonus)
    v = _stat_value(i, wt, gold)
    if it["from"]:
        # 중간 재료(톱날 단검·B.F. 대검 아닌 조합 재료): 고유 효과가 붙고 칸을 아낀다. 낱개 셋보다 하나를
        v += EPIC_SHARE * min(v, it["price"])
    kind = PART_PASSIVE.get(i)
    if kind and shares.get(kind):
        fit = min(1.0, _stat_value(i, w_fit or wt, gold) / (it["price"] * .8))
        v += PASSIVE_GOLD * shares[kind] * fit
    return v


def _ways(i, pool, depth=0):
    """i 를 향해 이번에 살 수 있는 방법들 [(산 것들, 드는 골드, 쓴 가방 재료)]. 빈 방법은 뺀다. pool 은 안 바꾼다.

    완성하기(가방 재료를 쓰고 모자란 값만) 하나 + 아직 없는 재료마다 (안 삼 / 통째로 / 그 재료의 방법 하나) 를 곱한 것.
    """
    items = data()["items"]
    trial = list(pool)
    cost = _remaining(i, trial)
    used = list(pool)
    for x in trial:
        used.remove(x)
    out = [((i,), cost, tuple(used))]
    if depth >= 2 or not items[i]["from"]:
        return out
    loc = list(pool)
    per_child = []
    for c in items[i]["from"]:
        if c in loc:            # 이미 가진 재료
            loc.remove(c)
            continue
        per_child.append([None] + _ways(c, loc, depth + 1))
    combos = [((), 0, ())]
    for opts in per_child:
        nxt = []
        for bought, cost, used in combos:
            for o in opts:
                if o is None:
                    nxt.append((bought, cost, used))
                else:
                    nxt.append((bought + o[0], cost + o[1], used + o[2]))
        combos = nxt[:256]
    out += [c for c in combos if c[0]]
    return out


def _claim(targets, pool):
    """가방 재료를 빌드 아이템에 나눠 준다(같은 재료를 두 아이템이 쓰지 않게). 이미 시작한 것이 먼저 가져간다."""
    left, mine = list(pool), {}
    order_ = sorted(targets, key=lambda t: (not _started(t, left), targets.index(t)))
    for t in order_:
        tree, got = _tree(t), []
        for p in list(left):
            if p in tree:
                # 실제로 쓰이는 만큼만(같은 재료 둘이 드는 템은 둘까지)
                trial = got + [p]
                if _remaining(t, list(trial)) < _remaining(t, list(got)):
                    got.append(p)
                    left.remove(p)
        mine[t] = got
    return mine, left


def _buy_dp(groups, budget, free):
    """그룹 배낭. groups: [[(골드 칸, 칸 변화, 값, 무엇)]]. 그룹마다 하나 이하. → (고른 것 [(그룹, 번호)], 값)

    dp[s][g]: 지금까지 본 그룹으로 빈 칸 s·남은 골드 g 칸에 닿았을 때의 가장 큰 값(못 닿으면 -inf).
    choice[n][s][g] = (고른 번호, 이전 s, 이전 g). 칸 변화가 음수(완성하며 재료가 빠짐) 일 수 있어서
    "남은 것" 을 상태로 두고 앞으로 채운다.
    """
    G = max(0, int(budget)) // GOLD_UNIT
    S = 6
    dp = [[NONE] * (G + 1) for _ in range(S + 1)]
    dp[min(S, max(0, free))][G] = 0.0
    choice = []
    for group in groups:
        new = [row[:] for row in dp]
        pick = [[None] * (G + 1) for _ in range(S + 1)]
        for s in range(S + 1):
            for g in range(G + 1):
                base = dp[s][g]
                if base == NONE:
                    continue
                for j, (u, ds, v, _) in enumerate(group):
                    s2, g2 = s - ds, g - u
                    if g2 < 0 or s2 < 0 or s2 > S:
                        continue
                    if base + v > new[s2][g2]:
                        new[s2][g2] = base + v
                        pick[s2][g2] = (j, s, g)
        dp = new
        choice.append(pick)
    best, at = NONE, None
    for s in range(S + 1):
        for g in range(G + 1):
            if dp[s][g] > best:
                best, at = dp[s][g], (s, g)
    out, (s, g) = [], at
    for n in range(len(groups) - 1, -1, -1):
        p = choice[n][s][g]
        if p is not None:
            out.append((n, p[0]))
            s, g = p[1], p[2]
    return out[::-1], best


def plan_buy(champion_id, lane, build, inventory, gold, ctx=None):
    """이번 귀환에 살 것. build: plan_build 의 items(순서대로). inventory: 가방 번호(재료·시작템·물약·장신구 포함).

    → {buy: [{id, name, cost, toward, why}], sell: [번호], value, dp: {...}, exact: {...}, reasons: [...]}
    """
    d = data()
    items, gold_v = d["items"], d["gold"]
    champ = d["champions"][int(champion_id)]
    w_base = weights(champ, lane)           # "이 챔피언이 쓰는 템인가"(고유 효과 몫의 적합도) 는 상황 없이 본다
    w, w_now, bonus, _, _ = apply_context(w_base, champ, ctx)
    ctx = ctx or {}
    L, _ = phase(ctx.get("t"))
    rho = .25 + .35 * (1 - L)               # 진행 몫: 후반일수록 "코어를 빨리 완성" 이 중요하다
    # 코어 지연 비용: 앞쪽 아이템이 아닌 곳에 쓴 골드만큼 코어 완성이 늦어진다(쓴 골드 × (1 - 가까움) × 이만큼)
    delay = .15 + .15 * (1 - L)
    shares = _passive_shares(ctx)
    gold = max(0, int(gold))

    bag = [i for i in inventory if i not in TRINKETS]
    known = [i for i in bag if i in items]
    finished = set(i for i in known if items[i]["kind"] in ("legendary", "boots", "boots3"))
    has_boots = any(items[i]["kind"].startswith("boots") for i in finished)
    targets = [t for t in build if t in items and t not in finished
               and not (has_boots and items[t]["kind"] == "boots")]
    mine, spare = _claim(targets, [i for i in known if i not in finished])
    free = 6 - len(bag)

    def wt_for(j, t):
        # 앞쪽 두 아이템만 지금(라인전) 잣대. 피바라기처럼 뒤 순서 템의 재료는 라인전 흡혈로 앞당기지 않는다
        wt = dict(w_now if j <= 1 else w)
        # 템트리가 고른 아이템의 스탯은 이 챔피언이 쓰는 스탯이다(우선순위 1). 우리 가중치가 낮게 봐도
        # (다리우스의 요우무 → 물리 관통력) 그 재료를 못 사는 일이 없게 바닥을 깐다
        # 코어(앞 세 칸) 만. 6번째 템의 스탯까지 바닥을 깔면 9분에 6번째 템 재료를 사러 간다
        if j <= 2:
            for s in items[t]["stats"]:
                wt[s] = max(wt.get(s, 0), TREE_FLOOR)
        return wt

    # 먼저 올리기 후보: 지금 효과가 있는 하위템(중상·정화·라인전 방어). 빌드 앞쪽 두 아이템의 재료면 그 그룹에서 보고,
    # 뒤쪽 아이템의 재료(징크스의 필멸자의 운명 ← 처형인의 대검)이거나 빌드 밖이면 "먼저 올리기" 그룹에서 지금 잣대로 본다
    near = set().union(*(_tree(t) | {t} for t in targets[:2])) if targets else set()
    # 고유 효과 하위템은 그 챔피언이 그 스탯을 쓸 때만(원딜에게 덤불 조끼 X). situational_parts 와 같은 기준
    def fits(p):
        return _stat_value(p, w_base, gold_v) / (items[p]["price"] * .8) >= PART_FIT
    early = {p for p, kind in list(PART_PASSIVE.items()) + list(DETOUR_BASICS.items())
             if p not in near and p not in known and (p not in PART_PASSIVE or (shares.get(kind) and fits(p)))}

    groups = []
    for j, t in enumerate(targets[:len(LINK)]):
        wt, link = wt_for(j, t), LINK[j]
        opts = []
        for bought, cost, used in _ways(t, mine[t]):
            if cost > gold or (j >= 2 and early.intersection(bought)):
                continue
            v = sum(_unit_value(b, wt, gold_v, bonus, shares, w_base) for b in bought)
            v -= sum(_unit_value(u, wt, gold_v, bonus, shares, w_base) for u in used)
            v += rho * cost * link - delay * cost * (1 - link)
            if t in bought:
                v += SPIKE * items[t]["price"] * link
            v -= SLOT_COST * (len(bought) - len(used))
            opts.append((_units(cost), len(bought) - len(used), v, (t, bought, cost, used, False)))
        if opts:
            groups.append(opts)

    # 소모품: 제어 와드(가방에 없으면), 엘릭서(빌드를 다 채웠으면). 그룹 하나씩, 칸을 하나 쓴다
    cons = d["consumables"]
    t_now = ctx.get("t")
    ward_v = WARD_VALUE.get(lane, 150 if t_now is None or t_now >= 6 else 0)
    if WARD in cons and WARD not in bag and ward_v and cons[WARD]["price"] <= gold:
        groups.append([(_units(cons[WARD]["price"]), 1, ward_v, (None, (WARD,), cons[WARD]["price"], (), "use"))])
    if not targets:
        role = (champ.get("roles") or ["fighter"])[0]
        ex = ELIXIRS.get(role) or ELIXIRS.get(champ.get("damage")) or 2140
        if ex in cons and cons[ex]["price"] <= gold:
            # 사서 바로 마신다(칸을 남기지 않는다)
            groups.append([(_units(cons[ex]["price"]), 0, ELIXIR_VALUE, (None, (ex,), cons[ex]["price"], (), "use"))])

    detour = []
    for p in sorted(early):
        trial = list(spare)                 # 빌드에 안 쓰이는 가방 재료(롱소드 → 처형인의 대검)
        cost = _remaining(p, trial)
        used = list(spare)
        for x in trial:
            used.remove(x)
        if cost > gold:
            continue
        # 뒤쪽 빌드 아이템의 재료면 그 아이템의 가까움만큼 진행 몫, 빌드 밖이면 조금만
        host = next((t for t in targets[2:len(LINK)] if p in _tree(t)), None)
        link = LINK[targets.index(host)] if host is not None else DETOUR_LINK
        v = (_unit_value(p, w_now, gold_v, bonus, shares, w_base) + rho * cost * link - delay * cost * (1 - link)
             - sum(_stat_value(u, w_now, gold_v) for u in used) - SLOT_COST * (1 - len(used)))
        detour.append((_units(cost), 1 - len(used), v, (host, (p,), cost, tuple(used), True)))
    if detour:
        groups.append(detour)

    t0 = time.perf_counter()
    dp_pick, dp_v = _buy_dp(groups, gold, free)
    t1 = time.perf_counter()
    ex_pick, ex_v, tried = _buy_exact(groups, gold, bag, dp_pick, w_now, gold_v)
    t2 = time.perf_counter()

    passive_ko = {"heal": "치유 감소", "cc": "정화"}

    def out(pick):
        buy = []
        for n, j in pick:
            t, bought, _, used, early_ = groups[n][j][3]
            if early_ == "use":
                b = bought[0]
                buy.append({"id": b, "name": cons[b]["name"], "cost": cons[b]["price"], "toward": None,
                            "why": "시야(제어 와드)" if b == WARD else "빌드를 다 채워서 남은 골드로(사서 바로 마시기)"})
                continue
            left = list(used)               # 가방 재료는 산 것들이 차례로 쓴다(드는 골드를 나눠 보이려고)
            for b in bought:
                toward = None if b == t else items[t]["name"] if t is not None else \
                    next((items[x]["name"] for x in items[b]["to"] if x in items), None)
                why = None
                if early_:
                    effect = ("지금 효과(%s)" % passive_ko[PART_PASSIVE[b]] if b in PART_PASSIVE
                              else "라인전 방어(%s)" % ", ".join(ctx.get("lane_names") or ()))
                    why = ("빌드 밖이지만 " if t is None else "%s의 재료를 먼저: " % items[t]["name"]) + effect
                buy.append({"id": b, "name": items[b]["name"], "cost": _remaining(b, left),
                            "toward": toward, "why": why})
        # 완성하는 것 먼저, 그다음 재료
        return sorted(buy, key=lambda b: b["toward"] is not None)

    best_buy = out(ex_pick[0])
    reasons = [b["name"] + ": " + b["why"] for b in best_buy if b["why"] and b["id"] not in cons]
    return {"buy": best_buy, "sell": [{"id": s, "name": items[s]["name"] if s in items else cons.get(s, {}).get("name", str(s))}
                                       for s in ex_pick[1]],
            "value": round(ex_v), "targets": targets,
            "dp": {"buy": out(dp_pick), "value": round(dp_v if dp_v != NONE else 0), "ms": round((t1 - t0) * 1000, 1)},
            "exact": {"value": round(ex_v), "tried": tried, "ms": round((t2 - t1) * 1000, 1)},
            "reasons": reasons}


def situational_parts(champion_id, lane, ctx=None, build=()):
    """상황 때문에 먼저 올릴 만한 하위템 [(번호, 이유)]. 챔프 선택에서 상점 추천 탭에 넣을 때 쓴다(가방·골드를 모를 때).

    plan_buy 의 "먼저 올리기" 와 같은 기준: 고유 효과 몫(중상·정화) 이 있고 그 챔피언이 그 스탯을 쓰는 것,
    맞라인 피해 종류에 맞는 천 갑옷·마법무효화의 망토. 빌드 앞 두 아이템의 재료는 빼고(이미 그 칸에 보인다)
    """
    d = data()
    items, gold_v = d["items"], d["gold"]
    champ = d["champions"][int(champion_id)]
    ctx = ctx or {}
    w_base = weights(champ, lane)
    shares = _passive_shares(ctx)
    near = set().union(*(_tree(t) | {t} for t in list(build)[:2])) if build else set()
    ko = {"heal": "치유 감소", "cc": "정화"}
    out = []
    for p, kind in PART_PASSIVE.items():
        if p in near or not shares.get(kind):
            continue
        fit = _stat_value(p, w_base, gold_v) / (items[p]["price"] * .8)
        if shares[kind] >= .15 and fit >= PART_FIT:
            out.append((p, ko[kind]))
    lane_ad = ctx.get("e_ad_lane")
    if lane_ad is not None:
        p = 1029 if lane_ad >= .65 else 1033 if lane_ad <= .35 else None
        if p and p not in near:
            out.append((p, "맞라인 %s" % ("AD" if p == 1029 else "AP")))
    return out


def _buy_exact(groups, gold, bag, seed, w_now, gold_v):
    """앞쪽 그룹을 itertools.product 로 다 따진다. → ((고른 것, 팔 것), 값, 따진 수)

    dp 와 같은 값에 더해: 칸 수는 다 산 뒤의 칸만 본다(순서 상관없이), 칸이 모자라면 시작템을 팔아(40% 돌려받음)
    칸과 골드를 만든다(그만큼 시작템 스탯은 잃는다), 치명타 확률은 100% 까지만 친다.
    """
    items = data()["items"]
    seed_by = {n: j for n, j in seed}
    # 다 따질 그룹: 앞쪽 아이템 몇 개 + 돌아가기 그룹(마지막, 있으면). 나머지 그룹은 dp 가 고른 것 하나만(안 삼/그것)
    has_detour = bool(groups) and groups[-1][0][3][4] is True
    n_items = len(groups) - (1 if has_detour else 0)
    full = list(range(min(n_items, EXACT_GROUPS - (1 if has_detour else 0))))
    if has_detour:
        full.append(len(groups) - 1)
    keep = sorted(set(full) | set(seed_by))
    choices = []
    for n in keep:
        if n in full:
            ranked = sorted(range(len(groups[n])), key=lambda j: -groups[n][j][2])[:EXACT_KEEP]
            if n in seed_by and seed_by[n] not in ranked:
                ranked.append(seed_by[n])
        else:
            ranked = [seed_by[n]]
        choices.append([None] + ranked)
    crit_have = sum(items[i]["stats"].get("crit", 0) for i in bag if i in items)
    sellable = [i for i in bag if i in SELLABLE]
    best, best_v, tried = ((), ()), NONE, 0
    for combo in itertools.product(*choices):
        tried += 1
        pick = [(n, j) for n, j in zip(keep, combo) if j is not None]
        cost = sum(groups[n][j][3][2] for n, j in pick)
        slots = len(bag) + sum(groups[n][j][1] for n, j in pick)
        v = sum(groups[n][j][2] for n, j in pick)
        sold = []
        if slots > 6:
            need = slots - 6
            if need > len(sellable):
                continue
            sold = sorted(sellable, key=lambda i: items[i]["price"] if i in items else 0)[:need]
            back = sum(int(items[i]["price"] * SELL_BACK) for i in sold if i in items)
            v -= sum(_stat_value(i, w_now, gold_v) for i in sold if i in items)
        else:
            back = 0
        if cost > gold + back:
            continue
        crit = crit_have + sum(items[b]["stats"].get("crit", 0) for n, j in pick for b in groups[n][j][3][1] if b in items)
        if crit > CRIT_CAP:
            v -= (crit - CRIT_CAP) * gold_v.get("crit", 0) * w_now.get("crit", 0)
        if v > best_v:
            best, best_v = (pick, sold), v
    if best_v == NONE:
        best_v = 0.0
    return best, best_v, tried


# ── tier-gg 와 잇기 ───────────────────────────────────────

def champion_list():
    return sorted(({"id": i, "key": c["key"], "name": c["name"], "roles": c["roles"]}
                   for i, c in data()["champions"].items()), key=lambda c: c["name"])


def usual_gold(rows, champion_id):
    """내 경기(stored_matches) 에서 이 챔피언으로 한 판에 번 골드 평균. 와드·물약 몫(10%) 을 뺀 값을 빌드 예산으로."""
    games = [r for r in rows if r.get("champion_id") == int(champion_id) and r.get("gold")]
    if not games:
        return None
    avg = sum(r["gold"] for r in games) / len(games)
    mins = [r["length_sec"] / 60 for r in games if r.get("length_sec")]
    return {"games": len(games), "avg_gold": round(avg),
            "budget": int(avg * 0.9) // 50 * 50,
            "avg_min": round(sum(mins) / len(mins), 1) if mins else None}
