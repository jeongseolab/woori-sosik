"""아이템 추천기(items.py)가 쓸 아이템·챔피언 자료를 static/items/ 에 굽는다. 개발 PC 전용(롤이 깔려 있어야 한다).

  python tools/lol_items.py                      # 기본 설치 폴더
  python tools/lol_items.py --game "D:/Riot Games/League of Legends"

롤 클라이언트의 게임 자료 플러그인(Plugins/rcp-be-lol-game-data/*.wad) 에서 바로 읽는다. 인터넷은 쓰지 않는다.
- static/items/data.json
    patch: 롤 버전("16.22")
    items: {번호: {name, price(전체 값), cost(조합 값), from, to, stats{스탯: 값}, kind, group}}
      kind: legendary(완성 전설) · boots(2·3단계 신발) · part(재료) — 소환사의 협곡 상점에서 살 수 있는 것만
      group: 같이 사면 고유 효과가 겹쳐 쓸모없는 묶음(히드라·광휘·여신의 눈물 ...). 한 묶음에서 하나만 산다
    champions: {번호: {key(영문 별칭), name, roles, damage(physical·magic·mixed), ranged, style{damage, durability, ...}}}
    consumables: {번호: {name, price}} — 추천기가 따로 다루는 소모품(제어 와드·물약·엘릭서). items 에는 넣지 않는다
      (재료·완성품 계산에 섞이지 않게). --consumables-only 로 이미 구운 data.json 에 이것만 덧붙일 수 있다
- static/items/icons/<번호>.png: 아이템 아이콘 64px(웹 화면과 오버레이가 같이 쓴다. tkinter 가 webp 를 못 읽어 png)

스탯은 items.json 에 숫자 칸이 없어서 설명의 <stats> 칸("공격력 <attention>75</attention>") 을 읽는다.
"""
import argparse
import io
import json
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from champ_models import Wad  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# 제어 와드·체력 물약·충전형 물약·강철/마법/분노의 비약(엘릭서)
CONSUMABLE_IDS = (2055, 2003, 2031, 2138, 2139, 2140)
OUT = os.path.join(HERE, "..", "static", "items")
BASE = "plugins/rcp-be-lol-game-data/global/"
ICON = 64

# 설명의 스탯 이름 → 추천기의 스탯 키. 값 끝에 % 가 붙는지에 따라 다른 스탯인 것(이동 속도·마법 관통력)은 (이름, %) 로
STAT_NAMES = {
    "공격력": "ad", "주문력": "ap", "체력": "hp", "방어력": "armor", "마법 저항력": "mr",
    "공격 속도": "as", "치명타 확률": "crit", "치명타 피해량": "critdmg", "스킬 가속": "ah",
    "마나": "mana", "기본 마나 재생": "mp5", "기본 체력 재생": "hp5",
    "물리 관통력": "lethality", "방어구 관통력": "armorpen",
    "생명력 흡수": "lifesteal", "모든 피해 흡혈": "omnivamp", "체력 회복 및 보호막": "hsp",
    "강인함": "tenacity", "10초당 골드": "gp10",
    ("이동 속도", False): "ms", ("이동 속도", True): "msp",
    ("마법 관통력", False): "mpen", ("마법 관통력", True): "mpenp",
}

# 고유 효과가 겹치지 않는 묶음. 이 재료로 만드는 완성 아이템끼리는 하나만 산다(롤 상점도 대부분 막는다)
GROUP_PARTS = {
    3077: "hydra",       # 티아맷: 굶주린·거대한·불경한 히드라, 발걸음 분쇄기
    3057: "sheen",       # 광휘의 검: 삼위일체·리치베인·얼어붙은 건틀릿 ... (주문검)
    3070: "tear",        # 여신의 눈물: 마나무네·대천사·혹한의 손길
    3155: "lifeline",    # 주문포식자: 맬모셔스
    3035: "whisper",     # 최후의 속삭임: 필멸자·도미닉·세릴다
    3916: "grievous",    # 망각의 구: 모렐로노미콘
    3123: "grievous",    # 처형인의 대검: 필멸자·화공 펑크
    3076: "grievous",    # 덤불 조끼: 가시 갑옷
    3114: "idol",        # 금지된 우상: 구원·미카엘·새벽심장 ... (치유·보호막 강화는 겹치지 않는다)
}
# 재료로 묶이지 않지만 롤에서 하나만 사는 것
GROUP_ITEMS = {
    3026: "lifeline", 3053: "lifeline", 6673: "lifeline",   # 수호 천사·스테락·불멸의 철갑궁(생명선)
    3156: "lifeline",
    6609: "grievous",
}


def parse_stats(desc):
    m = re.search(r"<stats>(.*?)</stats>", desc or "")
    stats, unknown = {}, []
    if not m:
        return stats, unknown
    for part in m.group(1).split("<br>"):
        text = re.sub(r"<[^>]+>", "", part).strip()
        if not text:
            continue
        g = re.match(r"^(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*(%?)$", text)
        if not g:
            unknown.append(text)
            continue
        name, value, percent = g.group(1).strip(), float(g.group(2)), bool(g.group(3))
        key = STAT_NAMES.get((name, percent)) or STAT_NAMES.get(name)
        if key is None:
            unknown.append(text)
            continue
        stats[key] = stats.get(key, 0) + value
    return stats, unknown


def patch_of(game_dir):
    try:
        v = json.load(open(os.path.join(game_dir, "Game", "content-metadata.json"), encoding="utf-8"))["version"]
        return ".".join(v.split(".")[:2])
    except (OSError, ValueError, KeyError):
        return "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default=r"C:\Riot Games\League of Legends", help="롤 설치 폴더")
    ap.add_argument("--consumables-only", action="store_true", help="이미 구운 data.json 에 소모품만 덧붙인다")
    args = ap.parse_args()
    plug = os.path.join(args.game, "Plugins", "rcp-be-lol-game-data")
    ko = Wad(os.path.join(plug, "ko_KR-assets.wad"))
    default = Wad(os.path.join(plug, "default-assets2.wad"))

    raw = json.loads(ko.read(BASE + "ko_kr/v1/items.json"))
    by_id = {x["id"]: x for x in raw}

    def save_icon(i, icon_path):
        rel = icon_path.split("/lol-game-data/assets/", 1)[-1].lower()
        path = BASE + "default/" + rel
        if not default.has(path):
            return False
        im = Image.open(io.BytesIO(default.read(path))).convert("RGBA").resize((ICON, ICON), Image.LANCZOS)
        im.save(os.path.join(OUT, "icons", "%d.png" % i), optimize=True)
        return True

    def consumables():
        out = {}
        for i in CONSUMABLE_IDS:
            x = by_id.get(i)
            if x:
                out[str(i)] = {"name": x["name"], "price": x["priceTotal"]}
                save_icon(i, x["iconPath"])
        return out

    if args.consumables_only:
        os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)
        path = os.path.join(OUT, "data.json")
        data = json.load(open(path, encoding="utf-8"))
        data["consumables"] = consumables()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print("소모품", {k: v["name"] for k, v in data["consumables"].items()})
        return

    def in_shop(x):
        # 협곡 상점 물건: 살 수 있고, 특수 모드 번호(1만 넘음)·오른 업그레이드·챔피언 전용이 아니고, 아이템 세트에 보이는 것
        return (x["inStore"] and x["priceTotal"] > 0 and x["id"] < 10000 and x["displayInItemSets"]
                and not x["requiredAlly"] and not x["requiredChampion"] and "Consumable" not in x["categories"]
                and "Trinket" not in x["categories"])

    shop = {i: x for i, x in by_id.items() if in_shop(x)}

    def kind(x):
        if "Boots" in x["categories"] or any("Boots" in by_id.get(f, {}).get("categories", []) for f in x["from"]):
            if not x["from"]:
                return None                                 # 장화(1001) 는 재료
            # 3단계 신발(불멸의 길·신속행진 ...) 은 조합 값 0: 사는 게 아니라 나중에 저절로 오른다. 추천 후보에서 뺀다
            return "boots" if x["price"] > 0 else "boots3"
        if not x["to"] and x["from"] and x["priceTotal"] >= 2000:
            return "legendary"
        return None

    items, unknown = {}, set()
    for i, x in sorted(shop.items()):
        k = kind(x)
        stats, bad = parse_stats(x["description"])
        unknown.update(bad)
        items[i] = {"name": x["name"], "price": x["priceTotal"], "cost": x["price"],
                    "from": [f for f in x["from"] if f in shop], "to": [t for t in x["to"] if t in shop],
                    "stats": stats, "kind": k or "part", "icon": x["iconPath"], "tags": x["categories"]}

    # 3단계 신발(신발 칸이 이미 2단계를 거쳐야 하는 것) 은 2단계와 같은 칸이라 둘 다 신발이다. 재료로만 쓰이면 재료
    # 신발 아닌데 legendary 가 못 된 완성품(2000 미만 완성, 예: 메자이) 은 빼지 않고 part 로 둔다(추천 후보 아님)
    # 한 아이템이 두 묶음에 들면(필멸자의 운명: 최후의 속삭임 + 처형인의 대검) 두 묶음을 하나로 합친다.
    # 추천기의 DP 는 "묶음마다 하나" 로 풀어서 아이템마다 묶음이 하나여야 한다. 조금 더 엄격해지지만(가시 갑옷과 도미닉을 같이 못 삼) 같이 사는 챔피언이 거의 없다
    parent = {}

    def root(g):
        while parent.setdefault(g, g) != g:
            g = parent[g]
        return g

    sets = {}
    for i, it in items.items():
        if it["kind"] in ("legendary", "boots", "boots3"):
            groups = {GROUP_PARTS[p] for p in _parts(i, items) if p in GROUP_PARTS}
            if i in GROUP_ITEMS:
                groups.add(GROUP_ITEMS[i])
            if it["kind"].startswith("boots"):
                groups = {"boots"}
            sets[i] = groups
            first = sorted(groups)[:1]
            for g in groups:
                parent[root(g)] = root(first[0])
    for i, groups in sets.items():
        names = sorted({g for g in parent if root(g) == root(next(iter(groups)))}) if groups else []
        items[i]["group"] = "+".join(names) or None

    champs = {}
    summary = json.loads(ko.read(BASE + "ko_kr/v1/champion-summary.json"))
    for c in summary:
        if not 0 < c["id"] < 10000:      # 60001~ 은 특수 모드용 복제(같은 챔피언이 또 있다)
            continue
        d = json.loads(ko.read(BASE + "ko_kr/v1/champions/%d.json" % c["id"]))
        t = d.get("tacticalInfo") or {}
        champs[c["id"]] = {
            "key": d["alias"], "name": d["name"], "roles": d.get("roles") or [],
            "damage": {"kPhysical": "physical", "kMagic": "magic"}.get(t.get("damageType"), "mixed"),
            "ranged": t.get("attackType") == "ranged",
            "style": d.get("playstyleInfo") or {},
        }

    os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)
    missing = 0
    for i, it in items.items():
        if not save_icon(i, it.pop("icon")):
            missing += 1

    data = {"patch": patch_of(args.game), "items": items, "champions": champs, "consumables": consumables()}
    with open(os.path.join(OUT, "data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    n = {k: sum(1 for it in items.values() if it["kind"] == k) for k in ("legendary", "boots", "part")}
    print("패치 %s · 아이템 %d(전설 %d, 신발 %d, 재료 %d) · 챔피언 %d · 아이콘 없음 %d"
          % (data["patch"], len(items), n["legendary"], n["boots"], n["part"], len(champs), missing))
    if unknown:
        print("못 읽은 스탯 줄:", sorted(unknown))


def _parts(i, items, seen=None):
    """i 를 만드는 데 들어가는 모든 재료 번호(재료의 재료까지)."""
    seen = set() if seen is None else seen
    for f in items.get(i, {}).get("from", []):
        if f not in seen:
            seen.add(f)
            _parts(f, items, seen)
    return seen


if __name__ == "__main__":
    main()
