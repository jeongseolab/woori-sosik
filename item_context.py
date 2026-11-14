"""게임 상황 → 아이템 추천기(items.py) 의 ctx.

두 곳에서 쓴다.
  - 오버레이(tools/item_overlay.py): 롤 Live Client Data API 의 allgamedata 를 통째로 넘긴다(from_live).
    시간·내 골드·가방·10명의 챔피언·아이템·KDA·CS·레벨이 다 있다
  - 웹 화면(/api/items/build): 사람이 넣은 시간·라인전 상태·아군·적 챔피언 번호만(make_context)

ctx 칸의 뜻과 그걸로 값을 어떻게 바꾸는지는 items.apply_context.
판단은 누구나 볼 수 있는 정보만 쓴다(Tab 점수판에 나오는 아이템·KDA·CS). 적의 골드·쿨타임 같은 숨은 정보는 쓰지 않는다.
"""
import itertools
import math

import items as I

# 회복이 커서 상대가 치유 감소(중상) 를 사는 챔피언(롤 클라이언트 별칭).
# 롤 자료에는 "회복" 표시가 없어서 손으로 고른다: 스킬로 크게 회복하거나(아트록스·블라디미르) 아군을 크게 치유하는(소라카·유미)
HEALERS = {
    "Aatrox", "Soraka", "Yuumi", "Vladimir", "Sylas", "DrMundo", "Warwick", "Swain", "Nami", "Sona",
    "Olaf", "Fiora", "Illaoi", "Trundle", "Gwen", "Viego", "Belveth", "Briar", "Nidalee", "Senna",
    "Kayn", "Milio", "FiddleSticks", "Kindred", "Nasus", "Samira", "Seraphine", "Ivern", "Volibear", "Taric",
}
# 주로 피할 수 있는 논타겟 스킬로 딜·CC 를 넣는 챔피언(신발을 1코어 전에 완성할지 본다. items.boots_first)
SKILLSHOTS = {
    "Ahri", "Amumu", "Anivia", "Ashe", "Aurora", "Bard", "Blitzcrank", "Brand", "Caitlyn", "Cassiopeia",
    "Chogath", "Diana", "Draven", "Elise", "Ezreal", "Heimerdinger", "Hwei", "Jayce", "Jhin", "Kalista",
    "Karma", "Karthus", "LeeSin", "Lissandra", "Lux", "Mel", "Morgana", "Nautilus", "Neeko", "Nidalee",
    "Pyke", "Qiyana", "Senna", "Seraphine", "Sivir", "Smolder", "Swain", "Syndra", "Taliyah", "Thresh",
    "Varus", "Velkoz", "Viktor", "Xerath", "Zed", "Ziggs", "Zoe", "Zyra",
}
DODGE_LANE, DODGE_OTHER = 1.0, .4     # 피할 스킬 점수: 맞라인 적 하나 1, 다른 적 하나 0.4
LIVE_LANE = {"TOP": "top", "JUNGLE": "jungle", "MIDDLE": "mid", "BOTTOM": "adc", "UTILITY": "support"}


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def _champ(cid):
    return I.data()["champions"].get(int(cid)) if cid is not None else None


def _item_gold(ids):
    items = I.data()["items"]
    return sum(items[i]["price"] for i in ids or () if i in items)


def _item_split(ids):
    """아이템 스탯으로 본 AD 몫(0~1)·방어 스탯 합. 아이템이 없으면 (None, 0)."""
    d = I.data()
    ad = ap = defense = 0.0
    for i in ids or ():
        st = d["items"].get(i, {}).get("stats", {})
        ad += st.get("ad", 0) * d["gold"]["ad"] + st.get("lethality", 0) * d["gold"]["lethality"]
        ap += st.get("ap", 0) * d["gold"]["ap"]
        defense += st.get("armor", 0) + st.get("mr", 0)
    return (ad / (ad + ap) if ad + ap > 0 else None), defense


def enemy_profile(enemies):
    """적 목록 [{id, items?, kills?, deaths?}] → e_ad·e_tank·e_heal·e_cc·e_burst·heal_names.

    잘 크는 적(킬이 많고 아이템 골드가 많은) 일수록 크게 센다: 0.5~2 배.
    """
    rows = []
    golds = [_item_gold(e.get("items")) for e in enemies]
    avg_gold = sum(golds) / len(golds) if golds else 0
    for e, g in zip(enemies, golds):
        c = _champ(e.get("id"))
        if not c:
            continue
        wt = _clamp(1 + .12 * ((e.get("kills") or 0) - (e.get("deaths") or 0)), .5, 2)
        if avg_gold > 0:
            wt *= .6 + .4 * g / avg_gold
        base_ad = {"physical": 1.0, "magic": 0.0}.get(c["damage"], .5)
        item_ad, defense = _item_split(e.get("items"))
        ad = base_ad if item_ad is None or g < 1500 else .5 * base_ad + .5 * item_ad
        style = c.get("style") or {}
        tank = 1.0 if c["roles"][:1] == ["tank"] else .6 if style.get("durability") == 3 else 0.0
        if defense >= 120:
            tank = max(tank, .7)
        burst = 1.0 if c["roles"][:1] in (["assassin"], ["mage"]) and style.get("damage") == 3 else 0.0
        rows.append((wt, ad, tank, c["key"] in HEALERS, style.get("crowdControl") or 0, burst, c["name"]))
    if not rows:
        return {}
    total = sum(r[0] for r in rows)
    avg = lambda k: sum(r[0] * r[k] for r in rows) / total  # noqa: E731
    healers = [r for r in rows if r[3]]
    return {
        "e_ad": avg(1),
        "e_tank": _clamp(avg(2) * 1.6),                    # 탱커 한 명(5명 중) ≈ 0.3, 둘이면 0.6
        "e_heal": _clamp(sum(r[0] for r in healers) / 2),  # 회복형 둘이면 가득
        "e_cc": _clamp((avg(4) - 1.6) / 1.0),              # 챔피언 CC 1~3 의 평균. 보통 팀 1.9 → 0.3
        "e_burst": _clamp(avg(5) * 1.6),
        "heal_names": [r[6] for r in healers],
    }


def ally_front(allies):
    """아군(나 빼고) [{id}] → 앞라인 0~1. 탱커나 단단한(내구도 3) 챔피언 하나 ≈ 0.67, 둘이면 1."""
    n = 0
    for a in allies:
        c = _champ(a.get("id"))
        if c and (c["roles"][:1] == ["tank"] or (c.get("style") or {}).get("durability") == 3):
            n += 1
    return _clamp(n / 1.5)


def lane_score(me, opp):
    """맞라이너와 비교한 라인전 상태 -1(크게 밀림) ~ +1(크게 앞섬).

    me·opp: {cs, level, kills, deaths, item_gold}. CS 20 개·아이템 1000 골드·킬 차이 2·레벨 1.5 가 대략 한 칸.
    골드는 아이템만 본다(상대의 쓰지 않은 골드는 점수판에 안 나온다).
    """
    def d(k):
        return (me.get(k) or 0) - (opp.get(k) or 0)
    kd = ((me.get("kills") or 0) - (me.get("deaths") or 0)) - ((opp.get("kills") or 0) - (opp.get("deaths") or 0))
    s = (.35 * math.tanh(d("cs") / 20) + .25 * math.tanh(d("item_gold") / 1000)
         + .25 * math.tanh(kd / 2) + .15 * math.tanh(d("level") / 1.5))
    return round(_clamp(s * 1.2, -1, 1), 2)


def make_context(t=None, lane=None, allies=(), enemies=(), lane_opps=()):
    """시간(분)·라인전 상태·아군·적·맞라인 적 → ctx. 모르는 것은 비워 둔다(그 기준은 쓰지 않는다).

    lane_opps: 라인전에서 직접 맞붙는 적(원딜·서포터는 상대 바텀 둘, 정글은 없음). 이 중 회복형이 있으면
    e_heal_lane 이 생긴다. 라인전 동안은 팀 전체의 회복보다 맞라인 회복이 "지금 중상을 사야 하나" 를 정한다.
    """
    ctx = {}
    if t is not None:
        ctx["t"] = max(0.0, float(t))
    if lane is not None:
        ctx["lane"] = _clamp(float(lane), -1, 1)
    if enemies:
        ctx.update(enemy_profile(list(enemies)))
    if allies:
        ctx["a_front"] = ally_front(list(allies))
    foes = [c for c in (_champ(o.get("id")) for o in lane_opps) if c]
    if foes:
        # 맞라인의 피해 종류: 라인전 동안 어느 방어 스탯을 먼저 올릴지(팀 전체 AD 몫과 따로)
        # 딜이 센 쪽을 크게(드레이븐 + 레오나 바텀이면 거의 AD): 챔피언 피해 등급(1~3) 으로 무게를 준다
        wt = [((c.get("style") or {}).get("damage") or 2) for c in foes]
        ctx["e_ad_lane"] = sum(k * {"physical": 1.0, "magic": 0.0}.get(c["damage"], .5)
                               for k, c in zip(wt, foes)) / sum(wt)
        ctx["lane_names"] = [c["name"] for c in foes]
    # 피할 스킬: 맞라인 적은 라인전 내내 스킬을 던지니 크게, 다른 적은 작게
    lane_keys = {c["key"] for c in foes}
    dodge = [c for c in (_champ(e.get("id")) for e in enemies or ()) if c and c["key"] in SKILLSHOTS]
    if dodge:
        ctx["e_dodge"] = sum(DODGE_LANE if c["key"] in lane_keys else DODGE_OTHER for c in dodge)
        ctx["dodge_names"] = [c["name"] for c in sorted(dodge, key=lambda c: c["key"] not in lane_keys)]
    heal_lane = [c["name"] for c in foes if c["key"] in HEALERS]
    if heal_lane:
        ctx["e_heal_lane"] = _clamp(len(heal_lane) / 1.0)
        ctx["heal_lane_names"] = heal_lane
    return ctx


# 라인전에서 맞붙는 상대 라인. 바텀은 둘이 같이 붙는다
# 정글은 맞라인이 없다(상대 정글과는 가끔 마주칠 뿐이라 라인전 방어·중상 기준에 넣지 않는다)
LANE_FOES = {"top": ("top",), "mid": ("mid",), "jungle": (),
             "adc": ("adc", "support"), "support": ("adc", "support")}


# ── 롤 Live Client Data API ───────────────────────────────

def _cid(raw):
    """rawChampionName("game_character_displayname_Jinx") → 챔피언 번호."""
    alias = (raw or "").rsplit("_", 1)[-1].lower()
    for cid, c in I.data()["champions"].items():
        if c["key"].lower() == alias:
            return cid
    return None


def _spells(p):
    """소환사 주문 이름들(영문 raw 이름 + 표시 이름, 소문자 한 줄)."""
    sp = p.get("summonerSpells") or {}
    return " ".join(" ".join(str(v) for v in (s or {}).values()) for s in sp.values()).lower()


def _has_smite(p):
    return "smite" in _spells(p)


def _player(p):
    sc = p.get("scores") or {}
    inv = [int(x["itemID"]) for x in p.get("items") or [] if x.get("itemID")]
    return {"id": _cid(p.get("rawChampionName")), "items": inv, "kills": sc.get("kills", 0),
            "deaths": sc.get("deaths", 0), "cs": sc.get("creepScore", 0), "level": p.get("level", 1),
            "item_gold": _item_gold(inv), "team": p.get("team"), "api_lane": LIVE_LANE.get(p.get("position") or ""),
            "smite": _has_smite(p), "tp": "teleport" in _spells(p),
            "bot_spell": any(k in _spells(p) for k in ("summonerheal", "summonerbarrier")), "name": p.get("championName")}


# 라인 비율(OP.GG) 이 없을 때 챔피언 역할로 어림한다
_ROLE_LANES = {"marksman": {"adc": .8, "top": .1, "mid": .1}, "support": {"support": .8, "mid": .1, "top": .1},
               "mage": {"mid": .6, "support": .25, "top": .15}, "assassin": {"mid": .5, "jungle": .4, "top": .1},
               "fighter": {"top": .55, "jungle": .35, "mid": .1}, "tank": {"top": .45, "support": .3, "jungle": .25}}
LANES = ("top", "jungle", "mid", "adc", "support")


def _share(cid, shares):
    got = shares.get(str(cid)) if shares else None
    if got:
        return got
    roles = (I.data()["champions"].get(cid) or {}).get("roles") or ()
    out = {}
    for k, r in enumerate(roles[:2]):
        for lane, v in _ROLE_LANES.get(r, {}).items():
            out[lane] = out.get(lane, 0) + v * (1.0 if k == 0 else 0.4)
    return out


def assign_lanes(team, shares=None, fixed=None):
    """한 팀(최대 5명) → 사람마다 라인. 롤 Live API 의 position 은 일부 큐(일반·빠른 대전 등) 에서 비거나 틀려서
    (베인을 미드로) 그것만 믿지 않고 다섯 자리 배치 중 가장 그럴듯한 것을 고른다.

    점수: 그 챔피언이 그 라인을 가는 비율(OP.GG, log) + API 가 준 라인이면 +2 + 강타면 정글 +6(아니면 -6)
    + 순간이동이면 탑 +1.5 · 회복·방어막이면 원딜 +1 + fixed(사람 번호 → 라인: 작은 창에서 고른 라인·챔프 선택의 내 라인) 이면 +20.
    (2026-11-13 봇전: API 는 탑 베인을 미드로, 우리 팀에 미드 둘·탑 없음. 맞라이너 마오카이를 이 점수로 찾는다)
    """
    fixed = fixed or {}
    n = len(team)
    if not n:
        return []
    def score(k, lane):
        p = team[k]
        sh = _share(p["id"], shares).get(lane, 0.0)
        v = math.log(sh + 0.02)
        if p.get("api_lane") == lane:
            v += 2.0
        if p.get("smite"):
            v += 6.0 if lane == "jungle" else -6.0
        if p.get("tp") and lane == "top":
            v += 1.5
        if p.get("bot_spell") and lane == "adc":
            v += 1.0
        if fixed.get(k) == lane:
            v += 20.0
        return v
    table = [[score(k, l) for l in LANES] for k in range(n)]
    best = max(itertools.permutations(range(len(LANES)), n), key=lambda pm: sum(table[k][pm[k]] for k in range(n)))
    return [LANES[j] for j in best]


def _api_full(team):
    """팀 다섯이 API 라인(라인 퀘스트) 을 겹치지 않게 다 받았나. 그러면 그대로 믿는다(추측하지 않는다)."""
    return len(team) == 5 and sorted(p.get("api_lane") or "" for p in team) == sorted(LANES)


def from_live(game, my_lane=None, shares=None, force=False):
    """allgamedata → {champion, lane, gold, inventory, ctx, opponent}. 나를 못 찾으면 이유(str).

    라인을 정하는 순서: 작은 창에서 사용자가 고른 라인(force=True 인 my_lane) > 롤 API 라인(라인 퀘스트, 팀 다섯이
    겹치지 않게 다 있을 때) > 챔프 선택에서 받은 내 라인(my_lane) > 추측(assign_lanes).
    (2026-11-14: 신드라 미드 퀘스트·API 미드인데 다른 값이 원딜로 덮어써 맞라이너가 루시안으로 나왔다)
    shares: item_tree.lane_shares() (없으면 역할로 어림)
    """
    me_raw = game.get("activePlayer") or {}
    who = me_raw.get("riotId") or me_raw.get("summonerName")
    players = game.get("allPlayers") or []
    mine = next((p for p in players if who and who in (p.get("riotId"), p.get("summonerName"))), None)
    if not mine:
        return "내 챔피언을 찾지 못했어요(관전 중?)"
    me = _player(mine)
    if me["id"] is None:
        return "모르는 챔피언이에요. tools/lol_items.py 로 자료를 다시 구워 주세요"
    others = [_player(p) for p in players if p is not mine]
    allies = [p for p in others if p["team"] == me["team"]]
    enemies = [p for p in others if p["team"] != me["team"]]
    # 라인: 협곡 5:5 이면 팀마다 배치를 고른다. 사람이 모자란 판(사용자 설정 1:1 등) 은 API 가 준 라인만
    full = len(allies) + 1 == 5 and len(enemies) == 5 and all(p["id"] for p in [me] + others)
    if full:
        mine_team = [me] + allies
        if _api_full(mine_team):
            for p in mine_team:
                p["lane"] = p["api_lane"]
            if force and my_lane in LANES:
                me["lane"] = my_lane
        else:
            for p, lane in zip(mine_team, assign_lanes(mine_team, shares, {0: my_lane} if my_lane in LANES else None)):
                p["lane"] = lane
        if _api_full(enemies):
            for p in enemies:
                p["lane"] = p["api_lane"]
        else:
            for p, lane in zip(enemies, assign_lanes(enemies, shares)):
                p["lane"] = lane
    else:
        for p in [me] + others:
            p["lane"] = p["api_lane"]
        if my_lane in LANES:
            me["lane"] = my_lane
    # 맞라이너: 같은 라인의 적. 라인 정보가 없는 판(사용자 설정 게임) 이면 라인전 상태는 모른다
    opp = next((p for p in enemies if me["lane"] and p["lane"] == me["lane"]), None)
    foes = [p for p in enemies if p["lane"] and p["lane"] in LANE_FOES.get(me["lane"], ())]
    t = ((game.get("gameData") or {}).get("gameTime") or 0) / 60
    ctx = make_context(t, lane_score(me, opp) if opp else None, allies, enemies, foes)
    return {"champion": me["id"], "lane": me["lane"], "gold": int(me_raw.get("currentGold") or 0),
            "inventory": me["items"], "ctx": ctx, "opponent": opp and opp["name"], "t": t}
