"""연습장 전체 화면 바닥(static/dodge/rift.webp) 굽기.

진짜 소환사의 협곡 지형을 롤 카메라 그대로 그린 그림 한 장을 만든다.
  1) 로컬 롤 설치의 Map11.wad.client 에서 data/maps/mapgeometry/map11/base_srx.mapgeo(버전 18) 를 꺼내
     바탕 층(layer bit0) 모델만 재질별로 모은다(용 영혼 지형 층은 뺀다)
  2) 재질 → 텍스처는 CommunityDragon 의 base_srx.materials.bin.json, 텍스처 PNG 도 CommunityDragon 에서 받는다
  3) 미드 1차 포탑 두 개(turret skin02 = SRUAP_Turret 모델) 를 제자리에 세운다(포탑은 지형이 아니라 따로 있는 오브젝트)
  4) tools/rift_bake.html(three.js) 을 헤드리스 크롬으로 열어 롤 카메라(56° 내려다봄, 줌 2250) 로 그리고 webp 로 저장

dodge.js 의 RIFT_BAKE(w, h, f) 와 경기장 가운데(협곡 7400, 7400) 를 여기 값과 맞춰야 한다.

  python tools/rift_bake.py [--work 작업폴더] [--top]     (--top: 자리 확인용으로 위에서 본 그림도 저장)
필요: numpy xxhash zstandard pillow playwright(chromium)
"""
import argparse
import asyncio
import base64
import collections
import functools
import http.server
import json
import math
import os
import shutil
import struct
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from champ_models import Wad, read_skn  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_WAD = r"C:\Riot Games\League of Legends\Game\DATA\FINAL\Maps\Shipping\Map11.wad.client"
CD = "https://raw.communitydragon.org/latest/game/"
CENTER = (7400, 7400)          # 경기장 가운데가 놓이는 협곡 좌표(미드 한가운데, 문양 자리)
GROUND = 43.79                 # 그 자리 바닥 높이
CAM_D = 2250                   # 롤 최대 줌 거리
W, H, F = 4400, 2400, 1600     # 그림 크기와 초점 거리(픽셀). 1080p 전체 화면에서 0.93 배로 그려진다
TURRETS = [  # 이름, 자리, 텍스처, 바라보는 쪽
    ("TURRET_chaos", (8955, 8510), "sruap_turret_chaos1_tx_cm.png", (-1, -1)),
    ("TURRET_order", (5846, 6396), "sruap_turret_chaos1_tx_cm_blue.png", (1, 1)),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 tiergg-rift-bake"})   # 기본 UA 는 403
    return urllib.request.urlopen(req, timeout=120).read()


# ── mapgeo(버전 17·18) ──
class R:
    def __init__(self, d):
        self.d, self.p = d, 0

    def u(self, f):
        v = struct.unpack_from("<" + f, self.d, self.p)
        self.p += struct.calcsize("<" + f)
        return v if len(v) > 1 else v[0]

    def s32(self):
        n = self.u("I")
        v = self.d[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return v


def parse_mapgeo(d):
    r = R(d)
    assert r.u("4s") == b"OEGM"
    ver = r.u("I")
    if ver < 17:
        raise ValueError("버전 17 이상만 읽는다: %d" % ver)
    for _ in range(r.u("I")):
        r.u("I"); r.s32()
    decls = []
    for _ in range(r.u("I")):
        r.u("I")
        ec = r.u("I")
        decls.append([r.u("II") for _ in range(ec)])
        r.p += 8 * (15 - ec)
    vbs = []
    for _ in range(r.u("I")):
        r.p += 1
        sz = r.u("I")
        vbs.append(r.p)
        r.p += sz
    ibs = []
    for _ in range(r.u("I")):
        r.p += 1
        sz = r.u("I")
        ibs.append(np.frombuffer(d, np.uint16, sz // 2, r.p))
        r.p += sz
    models = []
    for _ in range(r.u("I")):
        vc, vbc, vd = r.u("III")
        vbids = [r.u("i") for _ in range(vbc)]
        _ic, ibid = r.u("II")
        layer = r.u("B")
        r.u("I")                     # 버킷 격자 해시
        if ver >= 18:
            r.u("I")                 # 18 에서 늘어난 u32(쓰지 않음)
        subs = []
        for _ in range(r.u("I")):
            r.u("I")
            name = r.s32()
            a, c, _mn, _mx = r.u("IIII")
            subs.append((name, a, c))
        r.u("B"); r.u("6f")
        mtx = r.u("16f")
        r.u("B"); r.u("B"); r.u("H")
        for _ in range(2):           # 구운 빛, 고정 빛
            r.s32(); r.u("4f")
        for _ in range(r.u("I")):
            r.u("I"); r.s32()
        r.u("4f")
        models.append(dict(vc=vc, vd=vd, vbids=vbids, ibid=ibid, layer=layer, subs=subs, mtx=mtx))
    return decls, vbs, ibs, models


SIZE = {0: 4, 1: 8, 2: 12, 3: 16, 4: 4, 5: 4, 6: 4}


def texture_of(mat):
    vals = mat.get("samplerValues", [])
    for s in vals:
        if s.get("TextureName") == "DiffuseTexture" and s.get("texturePath"):
            return s["texturePath"]
    return next((s["texturePath"] for s in vals if s.get("texturePath")), None)


def png_name(tex):
    return "tex/" + os.path.basename(tex).rsplit(".", 1)[0] + ".png"


def build_scene(work):
    d = Wad(MAP_WAD).read("data/maps/mapgeometry/map11/base_srx.mapgeo")
    mats = json.loads(get(CD + "data/maps/mapgeometry/map11/base_srx.materials.bin.json"))
    decls, vbs, ibs, models = parse_mapgeo(d)
    groups = collections.defaultdict(lambda: {"pos": [], "uv": [], "idx": [], "n": 0})
    for mo in models:
        if not mo["layer"] & 1:
            continue
        pos = uv = None
        for i, vb in enumerate(mo["vbids"]):
            el, off = {}, 0
            for name, fmt in decls[mo["vd"] + i]:
                el[name] = off
                off += SIZE[fmt]
            raw = np.frombuffer(d, np.uint8, off * mo["vc"], vbs[vb]).reshape(mo["vc"], off)
            if 0 in el:
                pos = raw[:, el[0]:el[0] + 12].copy().view(np.float32).reshape(-1, 3)
            if 7 in el:
                uv = raw[:, el[7]:el[7] + 8].copy().view(np.float32).reshape(-1, 2)
        if pos is None:
            continue
        m = np.array(mo["mtx"], np.float32).reshape(4, 4)
        pos = (np.c_[pos, np.ones(len(pos), np.float32)] @ m)[:, :3].astype(np.float32)
        if uv is None:
            uv = np.zeros((len(pos), 2), np.float32)
        for name, a, c in mo["subs"]:
            g = groups[name]
            g["pos"].append(pos); g["uv"].append(uv)
            g["idx"].append(ibs[mo["ibid"]][a:a + c].astype(np.uint32) + g["n"])
            g["n"] += len(pos)
    parts = []
    for name, g in groups.items():
        mat = mats.get(name, {})
        tex = texture_of(mat)
        shader = [p["shader"] for t in mat.get("techniques", []) for p in t.get("passes", [])]
        parts.append(dict(name=name, tex=tex, file=png_name(tex) if tex else None, shader=shader,
                          P=np.concatenate(g["pos"]), U=np.concatenate(g["uv"]), I=np.concatenate(g["idx"])))
    # 포탑: 서 있는 몸통(Base·Stage·Cloth)만. 부서진 조각·잔해는 뺀다
    tb = CD + "assets/characters/turret/skins/skin02/"
    skn = read_skn(get(tb + "turret_skin02.skn"))
    os.makedirs(os.path.join(work, "tex"), exist_ok=True)
    for name, (x, z), tex, face in TURRETS:
        open(os.path.join(work, "tex", tex), "wb").write(get(tb + tex))
        th = math.atan2(face[0], face[1])
        c, s = math.cos(th), math.sin(th)
        P, U, I, n = [], [], [], 0
        for sub in skn["subs"]:
            if not sub["name"].lower().startswith(("base", "stage", "cloth")):
                continue
            v = skn["pos"][sub["vstart"]:sub["vstart"] + sub["vcount"]]
            P.append(np.c_[v[:, 0] * c + v[:, 2] * s + x, v[:, 1] + GROUND, -v[:, 0] * s + v[:, 2] * c + z].astype(np.float32))
            U.append(skn["uv"][sub["vstart"]:sub["vstart"] + sub["vcount"]])
            I.append(skn["idx"][sub["istart"]:sub["istart"] + sub["icount"]].astype(np.uint32) - sub["vstart"] + n)
            n += sub["vcount"]
        parts.append(dict(name=name, tex=tex, file="tex/" + tex, shader=["TURRET"],
                          P=np.concatenate(P), U=np.concatenate(U).astype(np.float32), I=np.concatenate(I)))
    blob, meta = bytearray(), []
    for p in parts:
        e = dict(name=p["name"], tex=p["tex"], file=p["file"], shader=p["shader"], n=len(p["P"]), ni=len(p["I"]))
        for k, a in (("pos", p["P"]), ("uv", p["U"]), ("idx", p["I"])):
            while len(blob) % 4:
                blob.append(0)
            e[k] = len(blob)
            blob += a.tobytes()
        meta.append(e)
    open(os.path.join(work, "scene.bin"), "wb").write(blob)
    json.dump(meta, open(os.path.join(work, "scene.json"), "w", encoding="utf-8"), ensure_ascii=False)

    def fetch(tex):
        fn = os.path.join(work, png_name(tex))
        if not os.path.exists(fn):
            open(fn, "wb").write(get(CD + tex.lower().rsplit(".", 1)[0] + ".png"))
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(fetch, sorted({p["tex"] for p in parts if p["tex"] and p["shader"] != ["TURRET"]})))
    shutil.copy(os.path.join(os.path.dirname(__file__), "rift_bake.html"), os.path.join(work, "bake.html"))


async def shoot(port, query, w, h):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        pg = await b.new_page(viewport={"width": w, "height": h})
        await pg.goto(f"http://127.0.0.1:{port}/bake.html?{query}")
        await pg.wait_for_function("window.done === true", timeout=600000)
        data = await pg.evaluate("document.querySelector('canvas').toDataURL('image/png')")
        await b.close()
    return base64.b64decode(data.split(",")[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.path.join(ROOT, ".rift-bake"))
    ap.add_argument("--top", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    build_scene(a.work)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=a.work)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    cx, cz = CENTER
    png = asyncio.run(shoot(port, f"mode=lol&w={W}&h={H}&cx={cx}&cz={cz}&gh={GROUND}&d={CAM_D}&f={F}", W, H))
    open(os.path.join(a.work, "rift.png"), "wb").write(png)
    out = os.path.join(ROOT, "static", "dodge", "rift.webp")
    Image.open(os.path.join(a.work, "rift.png")).convert("RGB").save(out, quality=82, method=6)
    print("저장:", out, os.path.getsize(out) // 1024, "KB")
    if a.top:
        open(os.path.join(a.work, "top.png"), "wb").write(
            asyncio.run(shoot(port, f"mode=top&w=1600&h=1600&cx={cx}&cz={cz}&half=2000", 1600, 1600)))
    srv.shutdown()


if __name__ == "__main__":
    main()
