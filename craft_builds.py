"""장인 빌드(AP 바루스·AP 코그모 ...): 내가 산 템이 OP.GG 템트리에서 많이 벗어나면 장인 템트리로 바꿔 추천한다.

기본은 언제나 OP.GG 템트리(item_tree.fetch). 아래 두 조건을 다 넘을 때만 장인 빌드로 바꾼다.
  장인 골드  가방에서 그 장인 빌드에만 들어가는 템(완성템·재료)에 쓴 골드  ≥ MIN_GOLD
  OP.GG 골드 가방에서 OP.GG 빌드에만 들어가는 템에 쓴 골드                  × RATIO ≤ 장인 골드
  둘 다에 들어가는 템(신발 장화·공용 재료)·시작템은 어느 쪽에도 세지 않는다.
  예) 바루스가 증폭의 고서·쓸데없이 큰 지팡이(1835) 를 샀고 OP.GG 템(곡괭이 ...)이 없다 → AP 바루스

한 번 바꾸면 그 판은 계속 장인 빌드(tools/item_overlay.CRAFT_SEEN). 재료를 완성하면 재료가 사라져도 완성템이 남아 다시 셀 수 있다.

목록에 없는 장인 빌드는 자동으로(auto_detect): OP.GG 빌드 밖에서 산 템을 하나씩 AP·치명·물리 관통·온힛·브루저·탱커로 나눠
골드가 6할 넘게 한쪽이고 그게 챔피언 원래 성향(OP.GG 코어의 성향) 과 다르면, 그 성향으로 바꾼 스탯 잣대로 빌드를 짠다.
가진·만드는 중인 템이 코어 앞에 온다. 손으로 넣은 CRAFTS 가 맞으면 그쪽이 먼저(순서까지 검증된 것).

장인 빌드 넣기: CRAFTS 에 한 줄. tree 는 item_tree.shape 와 같은 모양(core 3개 순서대로, 4·5·6번째 후보 [(번호, 몫)]).
style 은 챔피언의 역할·피해 유형을 바꿔서 items.weights 가 그 빌드의 스탯(주문력 ...)을 아끼게 한다.
"""
import items as I

MIN_GOLD = 1100          # 고서 하나(400)·잘못 산 재료 하나로는 안 바꾼다. 쓸데없이 큰 지팡이(1200) 하나면 넘는다
RATIO = 1.5              # OP.GG 쪽 템도 샀으면 그보다 1.5배 넘게 장인 쪽에 썼을 때만

AP = {"roles": ["mage", "marksman"], "damage": "magic"}
LETHAL = {"roles": ["assassin", "marksman"], "damage": "physical"}

# 챔피언 key(data.json champions.key) → 장인 빌드들. lanes 가 None 이면 어느 라인이든
CRAFTS = {
    "Varus": [
        {"key": "ap_varus", "name": "AP 바루스", "lanes": None, "style": AP,
         "tree": {"core": [6655, 4645, 3089], "boots": [3020],
                  "fourth": [(3135, .5), (4646, .3)], "fifth": [(3157, .4), (3102, .3), (3135, .2)],
                  "sixth": [(3135, .3), (3157, .3), (3102, .2)]}},
        {"key": "lethal_varus", "name": "치명 바루스", "lanes": None, "style": LETHAL,
         "tree": {"core": [3142, 6697, 6676], "boots": [3158],
                  "fourth": [(3179, .4), (6694, .3)], "fifth": [(3814, .3), (6694, .3), (3026, .2)],
                  "sixth": [(3026, .3), (3814, .3), (3156, .2)]}},
    ],
    "KogMaw": [
        {"key": "ap_kogmaw", "name": "AP 코그모", "lanes": None, "style": AP,
         "tree": {"core": [3118, 4645, 3089], "boots": [3020],
                  "fourth": [(3135, .5), (6653, .2)], "fifth": [(3157, .4), (3102, .3), (3135, .2)],
                  "sixth": [(3135, .3), (3157, .3), (3102, .2)]}},
    ],
    "Twitch": [
        {"key": "ap_twitch", "name": "AP 트위치", "lanes": None, "style": AP,
         "tree": {"core": [3115, 4633, 3089], "boots": [3020],
                  "fourth": [(3135, .5), (4645, .3)], "fifth": [(3157, .4), (3102, .3)],
                  "sixth": [(3135, .3), (3157, .3), (3102, .2)]}},
    ],
    "Tristana": [
        {"key": "ap_tristana", "name": "AP 트리스타나", "lanes": None, "style": AP,
         "tree": {"core": [6655, 4646, 3089], "boots": [3020],
                  "fourth": [(4645, .5), (3135, .3)], "fifth": [(3135, .4), (3157, .3)],
                  "sixth": [(3157, .3), (3102, .3)]}},
    ],
    "Ezreal": [
        {"key": "ap_ezreal", "name": "AP 이즈리얼", "lanes": None, "style": AP,
         "tree": {"core": [3003, 6655, 3100], "boots": [3020],
                  "fourth": [(3089, .5), (4645, .3)], "fifth": [(3135, .4), (3157, .3)],
                  "sixth": [(3135, .3), (3102, .3)]}},
    ],
}


def _tree_items(tree):
    """템트리의 완성템(신발 빼고) 번호들."""
    out = set((tree or {}).get("core") or ())
    for k in I.TREE_SLOTS:
        out.update(i for i, _ in (tree or {}).get(k) or ())
    return out


def _footprint(ids):
    """완성템과 그 재료 전부. 장화·시작템은 뺀다(누구나 산다)."""
    items = I.data()["items"]
    out = set()
    for i in ids:
        if i in items:
            out.add(i)
            out |= I._tree(i)
    return out - {I.BOOTS1} - set(I.SELLABLE) - set(I.DORANS)


def spent(craft, meta_tree, inventory):
    """→ (장인 쪽 골드, OP.GG 쪽 골드). 둘 다에 들어가는 템은 안 센다."""
    items = I.data()["items"]
    mine = _footprint(_tree_items(craft["tree"]))
    meta = _footprint(_tree_items(meta_tree))
    c = m = 0
    for i in inventory:
        if i not in items:
            continue
        if i in mine and i not in meta:
            c += items[i]["price"]
        elif i in meta and i not in mine:
            m += items[i]["price"]
    return c, m


def detect(champion_id, lane, meta_tree, inventory):
    """가방이 OP.GG 빌드에서 많이 벗어나 장인 빌드 쪽이면 그 장인 빌드 dict, 아니면 None."""
    champ = I.data()["champions"].get(int(champion_id))
    best = None
    for craft in CRAFTS.get((champ or {}).get("key"), ()):
        if craft["lanes"] and lane not in craft["lanes"]:
            continue
        c, m = spent(craft, meta_tree, inventory)
        if c >= MIN_GOLD and c >= RATIO * m and (best is None or c > best[0]):
            best = (c, m, craft)
    if best is None:
        return None
    c, m, craft = best
    return {**craft, "spent": c, "meta_spent": m}


def find(key, champion_id=None, lane=None, inventory=()):
    """key → 장인 빌드. 자동("auto:ap" ...) 이면 지금 가방으로 템트리를 다시 짠다(산 템이 코어 앞에 오게)."""
    if key.startswith("auto:") and champion_id is not None:
        arch = key[5:]
        champ = I.data()["champions"][int(champion_id)]
        return {"key": key, "name": "%s %s(자동)" % (ARCH_KO[arch], champ["name"]), "lanes": None, "auto": True,
                "arch": arch, "style": auto_style(champion_id, arch),
                "tree": auto_tree(champion_id, lane, arch, inventory)}
    return next((c for cs in CRAFTS.values() for c in cs if c["key"] == key), None)


def as_tree(craft, meta_tree):
    """장인 빌드 → plan_build 에 넣을 템트리. 시작템은 OP.GG 것을 그대로(이미 샀다)."""
    t = craft["tree"]
    return {"starter": list((meta_tree or {}).get("starter") or ()), "core": list(t["core"]),
            "boots": list(t.get("boots") or ()),
            **{k: [tuple(x) for x in t.get(k) or ()] for k in I.TREE_SLOTS},
            "source": "craft", "craft": craft["name"], "craft_key": craft["key"], "style": craft["style"],
            "craft_why": ("산 템이 %s 위주" % ARCH_KO[craft["arch"]]) if craft.get("auto") else None}


# ── 자동 장인 빌드: 목록에 없는 것 ────────────────────────
AUTO_SHARE = .6          # OP.GG 밖에서 산 골드 중 한 성향이 이만큼은 돼야
TANK_CARRY = 2           # 딜러 챔피언이 탱커 쪽으로 가려면 MIN_GOLD 의 이만큼
ARCH_KO = {"ap": "AP", "lethal": "물리 관통", "crit": "치명타", "onhit": "온힛", "fighter": "브루저", "tank": "탱커"}
AUTO_CORE = 3
AUTO_LATER = 4           # 4·5·6번째 후보 수


def _no_count():
    """자동 감지에서 안 세는 것: 정글 펫·서폿 퀘스트 템·추천기가 원래 권하는 상황 템(중상·생존·라인전 방어)."""
    items = I.data()["items"]
    out = set(I.JUNGLE_PETS) | set(I.PART_PASSIVE) | set(I.DETOUR_BASICS)
    out |= I.GRIEVOUS_ITEMS | I.SURVIVE_ITEMS | I.CLEANSE_ITEMS
    stack = [I.SUPPORT_START]
    while stack:
        i = stack.pop()
        if i in items and i not in out:
            out.add(i)
            stack.extend(items[i].get("to") or ())
    return out


def archetype(item_id):
    """아이템 하나의 성향(ARCH_KO 의 키) 또는 None(마나·스킬 가속뿐인 템 등)."""
    it = I.data()["items"][item_id]
    g, st = I.data()["gold"], it["stats"]
    val = {s: n * g.get(s, 0) for s, n in st.items()}
    total = sum(val.values()) or 1
    if sum(val.get(s, 0) for s in I.DEFENSE) > .6 * total:
        return "tank"
    ap = sum(val.get(s, 0) for s in I.MAGIC)
    if ap > val.get("ad", 0):
        return "ap"
    if "lethality" in st:
        return "lethal"
    if "crit" in st:
        return "crit"
    if "as" in st:
        return "onhit"
    if "ad" in st:
        return "fighter"
    if sum(val.get(s, 0) for s in I.DEFENSE) > 0:
        return "tank"
    return None


def _profile(ids):
    """성향별 골드(아이템 값으로). → {성향: 골드}."""
    items = I.data()["items"]
    out = {}
    for i in ids:
        a = archetype(i) if i in items else None
        if a:
            out[a] = out.get(a, 0) + items[i]["price"]
    return out


def natural(champion_id, meta_tree):
    """챔피언 원래 성향: OP.GG 코어에서, 없으면 data.json 의 역할·피해 유형으로."""
    prof = _profile((meta_tree or {}).get("core") or ())
    if prof:
        return max(prof, key=prof.get)
    champ = I.data()["champions"][int(champion_id)]
    roles = champ.get("roles") or ["fighter"]
    if champ.get("damage") == "magic" or roles[0] == "mage":
        return "ap"
    return {"tank": "tank", "marksman": "crit", "assassin": "lethal"}.get(roles[0], "fighter")


def auto_style(champion_id, arch):
    champ = I.data()["champions"][int(champion_id)]
    roles = champ.get("roles") or ["fighter"]
    if arch == "ap":
        return {"roles": ["mage"] + [r for r in roles if r != "mage"][:1], "damage": "magic"}
    if arch == "lethal":
        return {"roles": ["assassin", "marksman" if champ.get("ranged") else "fighter"], "damage": "physical"}
    if arch in ("crit", "onhit"):
        return {"roles": ["marksman", "fighter"], "damage": "physical"}
    if arch == "fighter":
        return {"roles": ["fighter", "assassin"], "damage": "physical"}
    return {"roles": ["tank", "fighter"]}


def auto_detect(champion_id, lane, meta_tree, inventory):
    """목록에 없는 장인 빌드. → 장인 빌드 dict(auto True) 또는 None."""
    items = I.data()["items"]
    meta = _footprint(_tree_items(meta_tree))
    skip = _no_count()
    off, m = [], 0
    for i in inventory:
        if i not in items or items[i]["kind"] not in ("legendary", "part"):
            continue
        if i in meta:
            m += items[i]["price"]
        elif i not in skip and i != I.BOOTS1 and i not in I.SELLABLE and i not in I.DORANS:
            off.append(i)
    prof = _profile(off)
    c = sum(prof.values())
    if c < MIN_GOLD or c < RATIO * m:
        return None
    arch = max(prof, key=prof.get)
    if prof[arch] < AUTO_SHARE * c or arch == natural(champion_id, meta_tree):
        return None
    champ = I.data()["champions"][int(champion_id)]
    # 원딜·마법사·암살자가 방어 재료를 사는 건 대개 상황 대응(탱커 징크스가 아니다). 두 배는 써야 탱커 빌드로
    if arch == "tank" and (champ.get("roles") or ["fighter"])[0] in I.CARRY_ROLES and c < TANK_CARRY * MIN_GOLD:
        return None
    return {"key": "auto:" + arch, "name": "%s %s(자동)" % (ARCH_KO[arch], champ["name"]), "lanes": None,
            "style": auto_style(champion_id, arch), "auto": True, "arch": arch,
            "tree": auto_tree(champion_id, lane, arch, inventory), "spent": c, "meta_spent": m}


def auto_tree(champion_id, lane, arch, inventory):
    """그 성향의 스탯 잣대로 짠 템트리(item_tree.shape 모양). 가진 템 → 만드는 중인 템 → 값 순."""
    items = I.data()["items"]
    style = auto_style(champion_id, arch)
    w = I.weights(I.champ_info(champion_id, style), lane)
    bonus = I.base_bonus(w)
    vals = {i: I.item_value(i, w, I.data()["gold"], bonus) for i, it in items.items()
            if it["kind"] in ("legendary", "boots") and (lane == "support" or not I.is_utility(i))}
    legend = [i for i in vals if items[i]["kind"] == "legendary"]
    pool = [i for i in inventory if i in items and items[i]["kind"] == "part"]
    owned = [i for i in inventory if i in legend and archetype(i) == arch]
    started = sorted((i for i in legend if i not in owned and archetype(i) == arch and I._started(i, pool)),
                     key=vals.get, reverse=True)
    # 나머지는 값과 가성비를 반씩(코어가 3500 짜리부터 몰리지 않게)
    rest = sorted((i for i in legend if i not in owned and i not in started),
                  key=lambda i: vals[i] * .5 + .5 * vals[i] / items[i]["price"] * 2800, reverse=True)
    picked, groups = [], set()
    for i in owned + started[:1] + rest:
        g = items[i].get("group")
        if g and g in groups:
            continue
        picked.append(i)
        if g:
            groups.add(g)
        if len(picked) >= AUTO_CORE + AUTO_LATER:
            break
    boots = max((b for b in vals if items[b]["kind"] == "boots"), key=vals.get, default=None)
    later = [(i, 0.0) for i in picked[AUTO_CORE:]]
    return {"core": picked[:AUTO_CORE], "boots": [boots] if boots else [],
            "fourth": later, "fifth": later, "sixth": later}
