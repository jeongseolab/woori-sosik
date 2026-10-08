"""연습장 로딩 화면의 챔피언 카드 그림(롤 로딩 일러스트, 기본 스킨) 을 static/dodge/loading/ 에 둔다.

  python champ_loadscreens.py

- static/dodge/loading/<별칭>.webp: 롤 로딩 화면 그림(308×560) 을 절반(154×280) 으로 줄인 것
  (로딩 화면에 뜨는 챔피언만 그때 받으니 장당 작게 둔다)
- 그림 경로는 champ_icons.py 가 tools/.cache 에 받아 둔 챔피언 JSON 의 skins[0].loadScreenPath.
  그림은 로컬 롤 WAD 의 .tex/.dds 에서 풀고, 없으면 CommunityDragon 에서 받는다
"""
import io, json, os, sys
from PIL import Image
import champ_models as cm
from champ_icons import cached_json, KO, OUT

SIZE = (154, 280)


def art(path):
    rel = path.split("/lol-game-data/assets/", 1)[-1].lower()
    stem = rel.rsplit(".", 1)[0]
    # 새 챔피언은 "LockeLoadScreen_0.Locke.jpg" 처럼 이름이 한 번 더 붙어 있고 WAD 에는 그것을 뗀 이름으로 들어 있다
    for s in (stem, stem.rsplit(".", 1)[0]):
        for ext in (".tex", ".dds"):
            b = cm.local_file(s + ext)
            if b:
                return cm.decode_tex(b).convert("RGB")
    return Image.open(io.BytesIO(cm.get_bytes("plugins/rcp-be-lol-game-data/global/default/" + rel))).convert("RGB")


def one(item):
    key, c = item
    d = cached_json(KO + "champions/%d.json" % c["id"])
    try:
        im = art(d["skins"][0]["loadScreenPath"])
    except Exception as e:      # 한 명이 안 돼도 나머지는 만든다(그 카드는 초상화로 대신한다)
        print("  그림 못 구함:", key, e, file=sys.stderr)
        return 0
    im.resize(SIZE, Image.LANCZOS).save(os.path.join(OUT, "loading", key + ".webp"), "WEBP", quality=72, method=6)
    return 1


def main():
    os.makedirs(os.path.join(OUT, "loading"), exist_ok=True)
    champs = json.load(open(os.path.join(OUT, "champs.json"), encoding="utf-8"))
    print(sum(map(one, champs.items())), "명")      # WAD 를 한 파일씩 열어 읽으니 차례로


if __name__ == "__main__":
    main()
