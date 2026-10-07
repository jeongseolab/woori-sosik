"""연습장 HUD 의 챔피언 목록·스킬 이름·스킬 아이콘을 static/dodge/ 에 둔다(게임을 열 때 CommunityDragon 을 기다리지 않게).

  python champ_icons.py

- static/dodge/champs.json: {별칭(소문자): {"id", "name", "spells": [Q, W, E, R 한국어 이름]}}
  (CommunityDragon ko_kr champion-summary·champions/<id>.json. 받은 것은 tools/.cache 에 둔다)
- static/dodge/icons/<별칭>.webp: Q W E R 아이콘 64px 을 가로로 붙인 한 장(256×64).
  그림은 로컬 롤 WAD 의 .dds/.tex 에서 풀고, 없으면 CommunityDragon png 를 받는다
- static/dodge/icons/summoner_*.png: 연습장 소환사 주문(점멸·유체화·정화) 아이콘

CommunityDragon 은 느릴 때(요청마다 20초) 가 있어 여럿을 한꺼번에 받는다.
"""
import io, json, os, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import champ_models as cm

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "dodge")
CACHE = os.path.join(HERE, ".cache", "champ_icons")
KO = "plugins/rcp-be-lol-game-data/global/ko_kr/v1/"
SIZE = 64
SUMMONERS = ["summoner_flash", "summoner_haste", "summoner_boost"]


def cached_json(path):
    f = os.path.join(CACHE, path.replace("/", "_"))
    if os.path.exists(f):
        return json.load(open(f, encoding="utf-8"))
    d = cm.get_json(path)
    os.makedirs(CACHE, exist_ok=True)
    json.dump(d, open(f, "w", encoding="utf-8"), ensure_ascii=False)
    return d


def icon(path):
    """abilityIconPath("/lol-game-data/assets/ASSETS/....png") → 64px 그림. 못 구하면 None"""
    rel = path.split("/lol-game-data/assets/", 1)[-1].lower()
    for ext in (".dds", ".tex"):
        b = cm.local_file(rel[:-4] + ext)
        if b:
            return cm.decode_tex(b).convert("RGBA")
    try:
        return Image.open(io.BytesIO(cm.get_bytes("plugins/rcp-be-lol-game-data/global/default/" + rel))).convert("RGBA")
    except Exception as e:      # 한 칸이 안 돼도 나머지는 만든다(그 칸은 비운다)
        print("  아이콘 못 구함:", rel, e, file=sys.stderr)
        return None


def one(c):
    key = str(c["alias"]).lower()
    d = cached_json(KO + "champions/%d.json" % c["id"])
    spells = [next((s for s in d.get("spells") or [] if s.get("spellKey") == k), {}) for k in "qwer"]
    sheet = Image.new("RGBA", (SIZE * 4, SIZE))
    for i, s in enumerate(spells):
        im = icon(s["abilityIconPath"]) if s.get("abilityIconPath") else None
        if im:
            sheet.paste(im.resize((SIZE, SIZE), Image.LANCZOS), (i * SIZE, 0))
    sheet.save(os.path.join(OUT, "icons", key + ".webp"), "WEBP", quality=90)
    return key, {"id": c["id"], "name": c["name"], "spells": [s.get("name") or "" for s in spells]}


def main():
    os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)
    summary = cached_json(KO + "champion-summary.json")
    # 이벤트용 항목(jade_ahri 처럼 밑줄이 든 것) 은 챔피언이 아니라서 뺀다
    champs = [c for c in summary if 0 < c["id"] < 10000 and "_" not in str(c["alias"])]
    with ThreadPoolExecutor(16) as ex:
        out = dict(sorted(ex.map(one, champs)))
    for n in SUMMONERS:
        with open(os.path.join(OUT, "icons", n + ".png"), "wb") as f:
            f.write(cm.get_bytes("plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/" + n + ".png"))
    with open(os.path.join(OUT, "champs.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(len(out), "명")


if __name__ == "__main__":
    main()
