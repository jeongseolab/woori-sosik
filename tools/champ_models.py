"""연습장(스킬샷 피하기) 의 3D 챔피언 모델을 만든다. 개발자 PC 에서 한 번 돌리는 도구다(서버는 안 쓴다).

롤이 설치된 PC 의 게임 파일(Game/DATA/FINAL/Champions/<챔피언>.wad.client) 에서
모델(.skn) · 뼈대(.skl) · 애니메이션(.anm) 을 꺼내고, 텍스처는 CommunityDragon 이 PNG 로 풀어 둔 것을 받는다.
뼈대와 애니메이션은 CommunityDragon 에 없어서 게임 파일이 있어야 한다.

애니메이션은 브라우저가 계산하지 않아도 되게 프레임마다 "스킨 행렬"(관절의 전역 행렬 × 바인드 역행렬) 로
미리 구워 둔다. 화면은 정점마다 이 행렬 네 개를 가중치로 섞기만 한다.

결과(static/dodge/models/):
  <키>.bin   모델 + 구운 애니메이션(아래 형식)
  <키>.webp  텍스처
  index.json { 키: { "h": 체력바를 띄울 높이(유닛), "anims": [...] } }   키는 챔피언 영문 이름 소문자(ezreal, chogath)

.bin 형식(리틀 엔디언)
  "LMDL" u32 버전(1)
  u32 정점 수 V, u32 인덱스 수 I, u32 영향 뼈 수 B, u32 애니메이션 수 A
  f32 키(체력바 높이: 머리 관절 + 35, 없으면 정점 높이 95% · × skinScale), f32 skinScale
  f32 위치[V×3]          바인드 자세(롤 모델 좌표: y 가 위)
  u16 UV[V×2]            0~65535
  u8 뼈[V×4], u8 가중치[V×4](합 255)
  u16 인덱스[I] (+ 4바이트 맞춤)
  애니메이션 A 개: char 이름[12], f32 fps, u32 프레임 수 F, f16 행렬[F×B×12] (3×4, 행 우선) (+ 4바이트 맞춤)

쓰는 법:
  pip install xxhash zstandard numpy pillow
  python tools/champ_models.py                      # 연습장에 나오는 챔피언(스킬 쓰는 적) + 이즈리얼
  python tools/champ_models.py ahri jinx            # 고른 챔피언만(내 챔피언으로 쓰려면)
  python tools/champ_models.py --all                # 모든 챔피언
  python tools/champ_models.py --game "D:/Riot Games/League of Legends"
"""
import argparse
import io
import json
import math
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import xxhash
import zstandard
from PIL import Image

CDRAGON = "https://raw.communitydragon.org/latest/"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "dodge", "models")
# 연습장에서 스킬을 쓰는 챔피언(static/dodge.js 의 SKILLS) 과 그 스킬(Q=1 … R=4)
CASTERS = {"morgana": [1], "lux": [1, 4], "zyra": [3], "nidalee": [1], "brand": [1, 2], "ahri": [3],
           "velkoz": [1, 3], "xerath": [2, 3], "ezreal": [1], "leona": [3, 4], "veigar": [1, 2, 3],
           "blitzcrank": [1], "thresh": [1], "jinx": [2], "ashe": [4], "karthus": [1], "chogath": [1],
           "syndra": [1], "jhin": [2]}
FPS = 15
TEX_SIZE = 512


# ── WAD ──
class Wad:
    def __init__(self, path):
        self.f = open(path, "rb")
        magic, major, _minor = struct.unpack("<2sBB", self.f.read(4))
        if magic != b"RW" or major < 3:
            raise ValueError("모르는 WAD 형식")
        self.f.read(256 + 8)
        count = struct.unpack("<I", self.f.read(4))[0]
        self.entries = {}
        for _ in range(count):
            h, off, csize, size, tb, _dup, _sub, _chk = struct.unpack("<QIIIBBHQ", self.f.read(32))
            self.entries[h] = (off, csize, size, tb & 0xF)

    @staticmethod
    def key(path):
        return xxhash.xxh64(path.lower().encode()).intdigest()

    def has(self, path):
        return self.key(path) in self.entries

    def read(self, path):
        off, csize, size, kind = self.entries[self.key(path)]
        self.f.seek(off)
        data = self.f.read(csize)
        if kind == 0:
            return data
        if kind in (3, 4):
            i = data.find(b"\x28\xb5\x2f\xfd")      # 여러 토막이면 앞에 압축 안 한 토막이 붙어 있을 수 있다
            return data[:max(0, i)] + zstandard.ZstdDecompressor().decompress(data[i:], max_output_size=size)
        raise ValueError("모르는 압축 %d" % kind)


# ── 읽기 도구 ──
class R:
    def __init__(self, data, pos=0):
        self.d, self.p = data, pos

    def u(self, fmt):
        v = struct.unpack_from("<" + fmt, self.d, self.p)
        self.p += struct.calcsize("<" + fmt)
        return v if len(v) > 1 else v[0]


def elf_hash(name):
    h = 0
    for ch in name.lower():
        h = ((h << 4) + ord(ch)) & 0xFFFFFFFF
        high = h & 0xF0000000
        if high:
            h ^= high >> 24
        h &= ~high & 0xFFFFFFFF
    return h


def read_skn(data):
    r = R(data)
    magic, major, _minor = r.u("IHH")
    if magic != 0x00112233:
        raise ValueError("skn 이 아님")
    subs = []
    for _ in range(r.u("I")):
        name = r.d[r.p:r.p + 64].split(b"\0")[0].decode(); r.p += 64
        vs, vc, is_, ic = r.u("IIII")
        subs.append(dict(name=name, istart=is_, icount=ic))
    if major == 4:
        r.u("I")
    icount, vcount = r.u("II")
    vsize = 52
    if major == 4:
        vsize, _vtype = r.u("II")
        r.u("10f")
    idx = np.frombuffer(data, "<u2", icount, r.p).copy()
    r.p += icount * 2
    raw = np.frombuffer(data, np.uint8, vcount * vsize, r.p).reshape(vcount, vsize)
    return dict(subs=subs, idx=idx,
                pos=raw[:, 0:12].copy().view("<f4").reshape(-1, 3),
                bones=raw[:, 12:16].copy(),
                weights=raw[:, 16:32].copy().view("<f4").reshape(-1, 4),
                uv=raw[:, 44:52].copy().view("<f4").reshape(-1, 2))


def read_skl(data):
    r = R(data)
    _size, token = r.u("II")
    if token != 0x22FD4FC3:
        return read_skl_legacy(data)
    r.u("I"); r.u("H")
    jcount = r.u("H")
    icount = r.u("I")
    joints_off, _jidx, infl_off = r.u("3i")
    joints = []
    for i in range(jcount):
        jr = R(data, joints_off + i * 100)
        _flags, _jid, parent, _pad = jr.u("HhhH")
        jr.u("If")
        t, s, q = jr.u("3f"), jr.u("3f"), jr.u("4f")
        jr.u("3f"); jr.u("3f"); jr.u("4f")
        at = jr.p
        s0 = at + jr.u("i")
        joints.append(dict(parent=parent, name=data[s0:data.index(b"\0", s0)].decode(), t=t, s=s, r=q))
    return dict(joints=joints, influences=list(struct.unpack_from("<%dh" % icount, data, infl_off)))


def read_skl_legacy(data):
    if data[:8] != b"r3d2sklt":
        raise ValueError("skl 이 아님")
    r = R(data, 8)
    version = r.u("I")
    r.u("I")
    joints = []
    for i in range(r.u("I")):
        name = data[r.p:r.p + 32].split(b"\0")[0].decode(); r.p += 32
        parent = r.u("i")
        r.u("f")
        m = np.eye(4)
        m[:3, :] = np.array(r.u("12f")).reshape(3, 4)
        joints.append(dict(parent=parent, name=name, gm=m))
    infl = list(range(len(joints)))
    if version == 2:
        n = r.u("I")
        infl = list(struct.unpack_from("<%dI" % n, data, r.p))
    return dict(joints=joints, influences=infl, legacy=True)


def qmat(q):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def trs(t, q, s):
    m = np.eye(4)
    m[:3, :3] = qmat(q) * np.array(s)[None, :]
    m[:3, 3] = t
    return m


def slerp(a, b, k):
    a, b = np.array(a, float), np.array(b, float)
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + (b - a) * k
        return q / np.linalg.norm(q)
    th = math.acos(min(1.0, d))
    return (a * math.sin((1 - k) * th) + b * math.sin(k * th)) / math.sin(th)


def quat48(b):
    bits = int.from_bytes(b, "little")
    maxi = (bits >> 45) & 3
    s2 = 1.41421356237
    a, bb, c = [((bits >> sh) & 0x7FFF) / 32767.0 * s2 - 1 / s2 for sh in (30, 15, 0)]
    d = math.sqrt(max(0.0, 1 - (a * a + bb * bb + c * c)))
    return [(d, a, bb, c), (a, d, bb, c), (a, bb, d, c), (a, bb, c, d)][maxi]


# 애니메이션 → ({관절 해시: {"t": [(초, 값)], "r": [...], "s": [...]}}, 길이 초)
def read_anm(data):
    magic, version = data[:8], struct.unpack_from("<I", data, 8)[0]
    if magic == b"r3d2canm":
        return read_canm(data)
    if magic != b"r3d2anmd":
        raise ValueError("anm 이 아님")
    return {5: read_anm_v5, 4: read_anm_v4}.get(version, read_anm_v3)(data)


def _track(out, h):
    return out.setdefault(h, {"t": [], "r": [], "s": []})


def read_anm_v5(data):
    r = R(data, 12)
    r.u("4I")
    tracks, frames = r.u("ii")
    fdur = r.u("f")
    jh, _asset, _time, vec, quat, fr = [o + 12 for o in r.u("6i")]
    vecs = [struct.unpack_from("<3f", data, vec + i * 12) for i in range((quat - vec) // 12)]
    quats = [quat48(data[quat + i * 6:quat + i * 6 + 6]) for i in range((jh - quat) // 6)]
    hashes = struct.unpack_from("<%dI" % tracks, data, jh)
    out = {}
    for f in range(frames):
        for k, h in enumerate(hashes):
            ti, si, ri = struct.unpack_from("<3H", data, fr + (f * tracks + k) * 6)
            o = _track(out, h)
            o["t"].append((f * fdur, vecs[ti])); o["s"].append((f * fdur, vecs[si])); o["r"].append((f * fdur, quats[ri]))
    return out, (frames - 1) * fdur


def read_anm_v4(data):
    r = R(data, 12)
    r.u("4I")
    tracks, frames = r.u("ii")
    fdur = r.u("f")
    _tr, _asset, _time, vec, quat, fr = [o + 12 for o in r.u("6i")]
    vecs = [struct.unpack_from("<3f", data, vec + i * 12) for i in range((quat - vec) // 12)]
    quats = [struct.unpack_from("<4f", data, quat + i * 16) for i in range((fr - quat) // 16)]
    out = {}
    for f in range(frames):
        for k in range(tracks):
            h, ti, si, ri, _ = struct.unpack_from("<IHHHH", data, fr + (f * tracks + k) * 12)
            o = _track(out, h)
            o["t"].append((f * fdur, vecs[ti])); o["s"].append((f * fdur, vecs[si])); o["r"].append((f * fdur, quats[ri]))
    return out, (frames - 1) * fdur


def read_anm_v3(data):
    r = R(data, 12)
    r.u("I")
    tracks, frames, fps = r.u("III")
    out = {}
    for _ in range(tracks):
        name = data[r.p:r.p + 32].split(b"\0")[0].decode(); r.p += 32
        r.u("I")
        o = _track(out, elf_hash(name))
        for f in range(frames):
            q = r.u("4f"); t = r.u("3f")
            o["r"].append((f / fps, q)); o["t"].append((f / fps, t))
    return out, (frames - 1) / fps


def read_canm(data):
    r = R(data, 12)
    r.u("3I")
    jcount, fcount, _jumps = r.u("iii")
    duration, _fps = r.u("ff")
    r.u("6f")
    tmin, tmax, smin, smax = r.u("3f"), r.u("3f"), r.u("3f"), r.u("3f")
    fr, _jc, jh = [o + 12 for o in r.u("3i")]
    hashes = struct.unpack_from("<%dI" % jcount, data, jh)
    out = {}

    def vec(raw, lo, hi):
        return tuple(lo[i] + (hi[i] - lo[i]) * (raw[i] / 65535.0) for i in range(3))
    for i in range(fcount):
        p = fr + i * 10
        key, jt = struct.unpack_from("<HH", data, p)
        o = _track(out, hashes[jt & 0x3FFF])
        tm, kind, val = key / 65535.0 * duration, jt >> 14, data[p + 4:p + 10]
        if kind == 0:
            o["r"].append((tm, quat48(val)))
        elif kind == 1:
            o["t"].append((tm, vec(struct.unpack("<3H", val), tmin, tmax)))
        else:
            o["s"].append((tm, vec(struct.unpack("<3H", val), smin, smax)))
    for o in out.values():
        for k in o:
            o[k].sort(key=lambda x: x[0])
    return out, duration


def sample(keys, tm, quat=False):
    if not keys:
        return None
    if tm <= keys[0][0]:
        return keys[0][1]
    for i in range(1, len(keys)):
        if keys[i][0] >= tm:
            a, b = keys[i - 1], keys[i]
            k = (tm - a[0]) / ((b[0] - a[0]) or 1)
            if quat:
                return tuple(slerp(a[1], b[1], k))
            return tuple(a[1][j] + (b[1][j] - a[1][j]) * k for j in range(3))
    return keys[-1][1]


def binds(skl):
    g = []
    for j in skl["joints"]:
        if skl.get("legacy"):
            g.append(j["gm"])
        else:
            local = trs(j["t"], j["r"], j["s"])
            g.append(local if j["parent"] < 0 else g[j["parent"]] @ local)
    return g


def bake(skl, anim, duration):
    js = skl["joints"]
    bind = binds(skl)
    inv = [np.linalg.inv(b) for b in bind]
    rest = []
    for i, j in enumerate(js):
        if skl.get("legacy"):
            rest.append(np.linalg.inv(bind[j["parent"]]) @ bind[i] if j["parent"] >= 0 else bind[i])
        else:
            rest.append(trs(j["t"], j["r"], j["s"]))
    n = max(1, int(round(duration * FPS)))
    frames = []
    for f in range(n):
        tm = f / FPS
        g = []
        for i, j in enumerate(js):
            tr = anim.get(elf_hash(j["name"]))
            local = rest[i]
            if tr:
                rt = rest[i]
                t = sample(tr["t"], tm) or tuple(rt[:3, 3])
                q = sample(tr["r"], tm, True)
                s = sample(tr["s"], tm) or (1, 1, 1)
                if q is not None:
                    local = trs(t, q, s)
            g.append(local if j["parent"] < 0 else g[j["parent"]] @ local)
        frames.append([(g[ji] @ inv[ji])[:3, :] for ji in skl["influences"]])
    return np.array(frames, dtype=np.float32)


# ── 챔피언 하나 ──
def get_bytes(path, tries=5):
    # 기본 User-Agent 는 CommunityDragon 이 403 으로 막는다. 연달아 받으면 가끔 연결을 끊어서 쉬었다가 다시 받는다
    req = urllib.request.Request(CDRAGON + path, headers={"User-Agent": "tiergg-champ-models/1.0"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError:
            raise
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def get_json(path):
    return json.loads(get_bytes(path))


def fnv1a(name):
    h = 0x811C9DC5
    for ch in name.lower().encode():
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    return h


def clip_path(clips, name, depth=0):
    """클립 이름(또는 "{해시}") 을 따라가 실제 .anm 경로를 찾는다. 이어 붙이기(Sequencer) 는 마지막의 반복 부분,
    겹치기(Parallel) 는 더하기가 아닌 첫 것, 고르기(Selector) 는 첫 후보를 쓴다."""
    if depth > 6 or not name:
        return None
    v = clips.get(name)
    if v is None and name.startswith("{"):
        h = int(name[1:-1], 16)
        v = next((c for k, c in clips.items() if fnv1a(k) == h or k == name), None)
    if not v:
        return None
    kind = v.get("__type")
    if kind == "AtomicClipData":
        return (v.get("mAnimationResourceData") or {}).get("mAnimationFilePath")
    names = v.get("mClipNameList") or [x.get("mClipName") for x in v.get("mSelectorPairDataList") or []]
    if kind == "SequencerClipData":
        names = list(reversed(names))
    elif kind == "ConditionBoolClipData":
        # 대개 "귀환 중이면" 같은 조건이라 거짓 쪽(보통 동작) 을 먼저
        names = [v.get("mFalseConditionClipName"), v.get("mTrueConditionClipName")]
    elif kind == "ConditionFloatClipData":
        # 이동 속도 구간마다 다른 동작(느린·빠른 달리기). 연습장 이동 속도(335) 에 맞는 구간을 먼저
        pairs = sorted(v.get("mConditionFloatPairDataList") or [], key=lambda x: x.get("mValue", 0))
        fit = [x for x in pairs if x.get("mValue", 0) <= 335]
        order = (fit[-1:] + pairs) if fit else pairs
        names = [x.get("mClipName") for x in order]
    elif kind == "ParametricClipData":
        # 이동 방향에 따라 앞·뒤·옆 동작을 섞는다(우르곳). 앞으로 가는 것(Fwd, 또는 값이 0 에 가장 가까운 것) 을 먼저
        pairs = v.get("mParametricPairDataList") or []
        pairs = sorted(pairs, key=lambda x: (0 if "fwd" in str(x.get("mClipName")).lower() else 1, abs(x.get("mValue", 0))))
        names = [x.get("mClipName") for x in pairs]
    for n in names:
        if "additive" in str(n).lower():
            continue
        path = clip_path(clips, n, depth + 1)
        if path:
            return path
    return None


def pick_clip(clips, names, word, avoid=("to", "haste", "fast", "homeguard", "var", "turn", "spell", "attack", "_in_", "out", "additive")):
    """클립 이름 우선순위로 찾고, 없으면 word 로 시작하는 단순한 이름 중 하나."""
    for n in names:
        for k in clips:
            if k.lower() == n.lower():
                path = clip_path(clips, k)
                if path:
                    return path
    cands = sorted(k for k in clips if k.lower().lstrip("raw_").startswith(word)
                   and not any(a in k.lower() for a in avoid))
    for k in cands:
        path = clip_path(clips, k)
        if path:
            return path
    return None


def build(key, wad_dir, spells):
    skin = get_json("game/data/characters/%s/skins/skin0.bin.json" % key)
    sk = next(v for v in skin.values() if isinstance(v, dict) and "skinMeshProperties" in v)
    mesh = sk["skinMeshProperties"]
    graph = sk.get("skinAnimationProperties", {}).get("animationGraphData")
    wads = [f for f in os.listdir(wad_dir) if f.lower() == key + ".wad.client"]
    if not wads:
        raise FileNotFoundError("WAD 없음")
    w = Wad(os.path.join(wad_dir, wads[0]))
    skn = read_skn(w.read(mesh["simpleSkin"]))
    skl = read_skl(w.read(mesh["skeleton"]))
    scale = float(mesh.get("skinScale", 1.0))
    hidden = set(str(mesh.get("initialSubmeshToHide", "")).lower().replace(",", " ").split())
    idx = np.concatenate([skn["idx"][s["istart"]:s["istart"] + s["icount"]] for s in skn["subs"]
                          if s["name"].lower() not in hidden])

    anims = {}
    agraph = get_json("game/" + graph.lower().replace("characters/", "data/characters/", 1) + ".bin.json") if graph else {}
    clips = next((v["mClipDataMap"] for v in agraph.values() if isinstance(v, dict) and "mClipDataMap" in v), {})
    want = {"idle": pick_clip(clips, ["Idle_Base", "Idle1", "Idle", "Idle_In", "Idle01", "Idle1_Base", "RAW_Idle1"], "idle"),
            "run": pick_clip(clips, ["Run_Normal", "Run", "Run_Base", "Run_In", "Run1", "RAW_Run1", "RAW_Run"], "run")}
    for n in spells:
        want["spell%d" % n] = pick_clip(clips, ["Spell%d" % n, "Spell%d_0" % n, "Spell%d_Base" % n], "spell%d" % n,
                                        avoid=("to", "run", "idle", "exit", "out"))
    for name, path in want.items():
        if path and w.has(path):
            a, dur = read_anm(w.read(path))
            anims[name] = bake(skl, a, max(dur, 1 / FPS))

    tex_path = mesh.get("texture")
    if tex_path:
        tex_path = "game/" + tex_path.lower().replace(".tex", ".png").replace(".dds", ".png")
    else:
        # 재질(material) 에만 텍스처가 있는 챔피언(이블린 등): 스킨 폴더에서 기본 색 텍스처(*_tx_cm.png) 를 찾는다
        folder = "game/" + os.path.dirname(mesh["simpleSkin"].lower()) + "/"
        pngs = re.findall(r'href="([^"/]+\.png)"', get_bytes(folder).decode("utf-8", "replace"))
        skip = ("loadscreen", "shade", "mask", "scroll", "_ult", "glow", "_fx", "particle")
        names = [n for n in pngs if not any(k in n.lower() for k in skip) and ("tx" in n.lower() or "_cm" in n.lower())]
        if not names:
            raise FileNotFoundError("텍스처 없음")
        names.sort(key=lambda n: (0 if n.lower().endswith("_tx_cm.png") else 1, len(n)))
        tex_path = folder + names[0]
    tex = Image.open(io.BytesIO(get_bytes(tex_path)))
    tex = tex.convert("RGBA").resize((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
    tex.save(os.path.join(OUT, key + ".webp"), "WEBP", quality=82)

    V, B = len(skn["pos"]), len(skl["influences"])
    # 체력바를 띄울 높이: 머리 관절(바인드 자세) 이 있으면 그 높이 + 여유, 없으면 정점 높이의 95%(정점 85% 보다는 높게).
    # 정점 최대 높이는 쓰레쉬 등불 같은 무기가 섞여 너무 높다
    bind = binds(skl)
    heads = [bind[i][1, 3] for i, j in enumerate(skl["joints"]) if j["name"].lower() in ("head", "c_head", "head_jnt", "c_head_jnt")]
    body = float(np.percentile(skn["pos"][:, 1], 85))       # 초가스처럼 웅크린 체형은 머리보다 등이 높다
    height = max(float(max(heads)) + 35 if heads else float(np.percentile(skn["pos"][:, 1], 95)), body) * scale
    w8 = np.clip(np.round(skn["weights"] * 255), 0, 255).astype(np.uint8)
    w8[:, 0] += (255 - w8.sum(1, dtype=np.int32)).astype(np.uint8)       # 합을 255 로
    buf = io.BytesIO()
    buf.write(b"LMDL" + struct.pack("<I", 1))
    buf.write(struct.pack("<IIIIff", V, len(idx), B, len(anims), height, scale))
    buf.write(skn["pos"].astype("<f4").tobytes())
    buf.write(np.clip(np.round(skn["uv"] * 65535), 0, 65535).astype("<u2").tobytes())
    buf.write(skn["bones"].astype(np.uint8).tobytes())
    buf.write(w8.tobytes())
    buf.write(idx.astype("<u2").tobytes())
    if buf.tell() % 4:
        buf.write(b"\0" * (4 - buf.tell() % 4))
    for name, fr in anims.items():
        buf.write(name.encode().ljust(12, b"\0"))
        buf.write(struct.pack("<fI", FPS, len(fr)))
        buf.write(fr.astype("<f2").tobytes())
        if buf.tell() % 4:
            buf.write(b"\0" * (4 - buf.tell() % 4))
    with open(os.path.join(OUT, key + ".bin"), "wb") as f:
        f.write(buf.getvalue())
    return {"h": round(height, 1), "anims": list(anims)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("champions", nargs="*", help="챔피언 영문 이름(소문자). 비우면 연습장 챔피언")
    ap.add_argument("--all", action="store_true", help="모든 챔피언")
    ap.add_argument("--game", default=r"C:\Riot Games\League of Legends", help="롤 설치 폴더")
    a = ap.parse_args()
    wad_dir = os.path.join(a.game, "Game", "DATA", "FINAL", "Champions")
    os.makedirs(OUT, exist_ok=True)
    if a.all:
        # 이벤트용 항목(jade_ahri 처럼 밑줄이 든 것) 은 챔피언이 아니라서 뺀다
        keys = sorted(str(c["alias"]).lower() for c in get_json(
            "plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json") if 0 < c["id"] < 10000 and "_" not in str(c["alias"]))
    else:
        keys = [k.lower() for k in a.champions] or sorted(CASTERS)
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else {}
    for k in keys:
        try:
            index[k] = build(k, wad_dir, CASTERS.get(k, []))
            print(k, index[k], flush=True)
        except Exception as e:      # 한 챔피언이 안 돼도 나머지는 만든다
            print(k, "실패:", e, file=sys.stderr, flush=True)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(index.items())), f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
