"""연습장 스킬 이펙트를 롤 클라이언트의 파티클 정의 그대로 뽑는다. 개발자 PC 에서 한 번 돌리는 도구.

롤이 설치된 PC 의 챔피언 WAD(Game/DATA/FINAL/Champions/<챔피언>.wad.client) 에서 스킨 bin(skin0 과 거기 링크된 bin) 을 읽어
스킬이 쓰는 파티클 시스템(VfxSystemDefinitionData) 을 찾고, 그 발생기(emitter) 들의 값을 화면(static/dodge-vfx.js) 이
읽기 좋은 모양으로 줄여 static/dodge/vfx/fx.json 에 적는다. 이름은 tools/lolbin.py 가 CommunityDragon 해시 사전으로 되돌린다.

  텍스처: CommunityDragon 이 PNG 로 풀어 둔 것을 받아 webp 로(static/dodge/vfx/t/<번호>.webp, 긴 변 512 까지)
  메시(.scb): WAD 에서 읽어 fx.json 안에(위치·UV)

어느 스킬이 어느 이펙트를 쓰는지는 롤 데이터의 키(스킬의 mMissileEffectKey·mHitEffectKey, 스킨의 resourceMap) 를 보고
아래 SKILLS 에 적었다. 발생기 값의 뜻은 LeagueToolkit lol-meta-wiki(github.com/LeagueToolkit/lol-meta-wiki) 를 따른다.

  python tools/lol_vfx.py
"""
import io
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request

from PIL import Image

import champ_models as cm
import lolbin

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "dodge", "vfx")
WAD_DIR = r"C:\Riot Games\League of Legends\Game\DATA\FINAL\Champions"
CDRAGON = "https://raw.communitydragon.org/latest/game/"
TEX_MAX = 512

# 연습장 스킬(static/dodge.js 의 SKILLS 이름) → 챔피언과 때마다 켜는 이펙트(resourceMap 의 키).
#   cast: 시전이 끝날 때 시전자에게, mis: 투사체에 붙어 날아감, hit: 맞은 자리,
#   warn: 시전하는 동안(투사체·레이저는 시전자에서 앞으로, 장판은 그 자리) 이나 장판이 터지기 전 경고,
#   land: 장판 자리에 시전이 끝날 때(초가스 Q 가시처럼 스스로 때를 맞추는 것), boom: 장판이 터질 때,
#   beam: 시전자 → 끝점 빔, split: 갈라진 투사체. 투사체 이펙트(mis) 의 빔 끝은 시전자다(쓰레쉬 Q 사슬)
# 적 쪽 색(빨강) 이 따로 있으면 그것을 쓴다(연습장의 스킬은 모두 적 스킬)
SKILLS = {
    "모르가나 Q": ("morgana", {"cast": ["Morgana_Q_Cas"], "mis": ["Morgana_Q_Mis"], "hit": ["Morgana_Q_Tar"]}),
    "럭스 Q": ("lux", {"cast": ["Lux_Q_cas"], "mis": ["Lux_Q_mis"], "hit": ["Lux_Q_tar"]}),
    "자이라 E": ("zyra", {"cast": ["Zyra_E_Cas"], "mis": ["Zyra_E_cas_02"], "hit": ["Zyra_E_tar"]}),
    "니달리 Q": ("nidalee", {"cast": ["Nidalee_Q_Cas"], "mis": ["Nidalee_Q_Mis"], "hit": ["Nidalee_Q_Tar"]}),
    "브랜드 Q": ("brand", {"mis": ["Brand_Q_Blaze_mis"], "hit": ["Brand_Q_Blaze_tar"]}),
    "아리 E": ("ahri", {"cast": ["Ahri_E_cas"], "mis": ["Ahri_E_mis"], "hit": ["Ahri_E_tar"]}),
    "벨코즈 Q": ("velkoz", {"cast": ["Velkoz_Q_cas"], "mis": ["Velkoz_Q_Mis"], "split": ["Velkoz_Q_Split_mis"],
                          "splitfx": ["Velkoz_Q_SplitExplosion"], "hit": ["Velkoz_Q_Missile_Tar"]}),
    "제라스 E": ("xerath", {"mis": ["Xerath_E_mis"], "hit": ["Xerath_E_tar"]}),
    "이즈리얼 Q": ("ezreal", {"cast": ["Ezreal_Q_bow01"], "mis": ["Ezreal_Q_mis"], "hit": ["Ezreal_Q_tar"]}),
    "레오나 E": ("leona", {"mis": ["Leona_E_mis_weapon"], "hit": ["Leona_E_tar"]}),
    "베이가 Q": ("veigar", {"cast": ["Veigar_Q_Cas"], "mis": ["Veigar_Q_mis"], "hit": ["Veigar_Q_tar"]}),
    "블리츠크랭크 Q": ("blitzcrank", {"cast": ["Blitzcrank_Q_cas"], "mis": ["Blitzcrank_Q_mis"], "back": ["Blitzcrank_Q_mis_return"]}),
    "쓰레쉬 Q": ("thresh", {"mis": ["Thresh_Q_whip_beam"], "hit": ["Thresh_Q_stab_tar"]}),
    "징크스 W": ("jinx", {"warn": ["Jinx_W_Beam"], "cast": ["Jinx_W_Cas"], "mis": ["Jinx_W_Mis"], "hit": ["Jinx_W_Tar"]}),
    "애쉬 R": ("ashe", {"mis": ["Ashe_R_mis"], "hit": ["Ashe_R_Tar"]}),
    "카서스 Q": ("karthus", {"warn": ["Karthus_Q_Ring_red", "Karthus_Q_Point_red"], "boom": ["Karthus_Q_Explosion"]}),
    "브랜드 W": ("brand", {"warn": ["Brand_W_POF_charge"], "boom": ["Brand_W_POF_tar"]}),
    "초가스 Q": ("chogath", {"warn": ["Chogath_Q_Enemy_team"], "boom": ["Chogath_Q_cas"]}),
    "베이가 W": ("veigar", {"cast": ["Veigar_W_cas"], "warn": ["Veigar_W_cas_red"], "boom": ["Veigar_W_aoe_explosionRed"]}),
    "신드라 Q": ("syndra", {"warn": ["Syndra_Q_aoe_gather_enemy"], "boom": ["Syndra_Q_aoe_explode"]}),
    "제라스 W": ("xerath", {"cast": ["Xerath_W_cas"], "warn": ["Xerath_W_aoe_red"], "boom": ["Xerath_W_aoe_explosion"]}),
    "벨코즈 E": ("velkoz", {"warn": ["Velkoz_E_AOE_red"], "boom": ["Velkoz_E_explo"]}),
    "레오나 R": ("leona", {"cast": ["Leona_R_cas"], "warn": ["Leona_R_hit_aoe_red"], "boom": ["Leona_R_hit_impact"]}),
    "진 W": ("jhin", {"cast": ["Jhin_W_cas"], "warn": ["Jhin_W_charging"], "beam": ["Jhin_W_beam"], "hit": ["Jhin_W_hit_tar"]}),
    "럭스 R": ("lux", {"cast": ["Lux_R_cas"], "beam": ["Lux_R_mis_beam", "Lux_R_mis_beam_middle"], "hit": ["Lux_R_tar"]}),
    "베이가 E": ("veigar", {"cast": ["Veigar_E_cas"], "warn": ["Veigar_E_Warning_Red"], "cage": ["Veigar_E_cage_Red"]}),
}

# 내 챔피언 스킬(static/dodge.js 의 MOBILITY 칸) 의 이펙트. 롤은 스킬 스크립트가 이펙트를 켜는데 스크립트는 클라이언트에 없어서,
# 그 스킬 애니메이션(SpellN) 에 박힌 이펙트 이벤트 + 이름 규칙(<챔피언>_<칸 글자>_<뒷말>) 으로 고른다.
#   cast: 쓸 때 내 몸에, dash: 돌진하는 동안 몸에 붙어서, land: 내려앉을 때, buf: 이속·보호막·투명이 걸린 동안 몸에
MINE_PARTS = {"cast": r"(_cas|_cast|_activate|_portal_entrance|castbody)(_\d+)?$", "dash": r"(dash|trail|jump|leap)",
              "land": r"(land|arrive|_exit|portal_exit)", "buf": r"(buf|buff|shield|stealth|invisibility|speed)(_\d+)?$"}
MINE_SKIP = r"(red|green|_ally|_enemy|indicator|warning|avatar|_tar|_sfx|audio|_vo|_ult|water|snow|lvl\d|_child|minion|death|recall|emote)"


# 이름 규칙에 안 걸리는 것: (챔피언, 칸) → 부분별 키(규칙으로 찾은 것에 더한다)
MINE_EXTRA = {
    ("ekko", 2): {"cast": ["Ekko_E_Vanish"], "dash": ["Ekko_E_Roll_Blur"], "land": ["Ekko_E_Appear"]},
    ("ekko", 3): {"cast": ["Ekko_R_Disappear"], "land": ["Ekko_R_Tar_Impact"]},
    ("galio", 2): {"cast": ["Galio_E_Cas_Dust"], "dash": ["Galio_E_Wings"], "land": ["Galio_E_Cas_DropFlash"]},
    ("kalista", 0): {"cast": ["Kalista_Q_mis_Precast"], "mis": ["Kalista_Q_mis"]},
    ("lulu", 1): {"cast": ["Lulu_W_cas_buf_hand"], "buf": ["Lulu_W_tar_01"]},
    ("lulu", 2): {"cast": ["Lulu_Pix_E_Teleport"]},
    ("lux", 1): {"buf": ["Lux_W_tar_shield"]},
    ("riven", 2): {"buf": ["Riven_E_Shield"]},
    ("zoe", 3): {"cast": ["Zoe_R_portal_entrance"], "land": ["Zoe_R_portal_exit"]},
    ("pyke", 1): {"buf": ["Pyke_W_EyeGlow"]},
    ("shaco", 0): {"cast": ["Shaco_Q_poof"]},
    ("vladimir", 1): {"buf": ["Vladimir_W_buf"]},
    ("yasuo", 1): {"cast": ["Yasuo_W_windwall_activate"], "wall": ["Yasuo_W_windwall5"]},
    ("samira", 1): {"buf": ["Samira_W_Zone"]},
    ("tryndamere", 2): {"dash": ["Tryndamere_E_Slash"]},
    ("tryndamere", 3): {"buf": ["Tryndamere_R_buf_01", "Tryndamere_R_glow_01"]},
    ("sivir", 2): {"buf": ["Sivir_E_shield"]},
    ("sivir", 3): {"buf": ["Sivir_R_buf"]},
    ("ornn", 2): {"dash": ["Ornn_E_feet_spin"], "land": ["Ornn_E_Explosion"]},
    ("rammus", 0): {"buf": ["Rammus_Q_AOE"]},
    ("shen", 2): {"dash": ["Shen_E_mis"]},
    ("twitch", 0): {"cast": ["Twitch_Q_Bamf"], "buf": ["Twitch_Q_Haste"]},
    ("udyr", 2): {"buf": ["Udyr_PhoenixStance"]},
    # 나피리 W 는 롤 스킬 이름이 NaafiriR(무리의 부름) 이라 이펙트도 Naafiri_R_* (Naafiri_W_* 는 옛 W, 챔피언에게 돌진)
    ("naafiri", 1): {"cast": ["Naafiri_R_Transform"], "buf": ["Naafiri_R_Buff", "Naafiri_R_Movespeed"]},
    ("naafiri", 2): {"land": ["Naafiri_E_SecondHit"]},
    ("volibear", 0): {"buf": ["Volibear_Q_ShieldRune_L"]},
}


def mine_skills():
    """static/dodge.js 의 MOBILITY 표 → {챔피언: [(칸, kind)]}"""
    src = open(os.path.join(HERE, "..", "static", "dodge.js"), encoding="utf-8").read()
    tbl = src[src.index("const MOBILITY = {"):src.index("const skillsOf")]
    out, cur = {}, None
    for line in tbl.splitlines():
        m = re.match(r"^    (\w+): [\[{]", line)
        if m:
            cur = m.group(1)
            out.setdefault(cur, [])
        if cur:
            for sm in re.finditer(r'slot: (\d), kind: "(\w+)"', line):
                out[cur].append((int(sm.group(1)), sm.group(2)))
    return out


def mine_parts(d, champ, slot, kind):
    """한 칸에 켤 이펙트 키들 {cast, dash, land, buf, anim: [[키, 초]]}"""
    rmap = resource_map(d)
    L = "QWER"[slot]
    keys = [k for k in rmap if re.search(r"_%s(_|\d)" % L, k) and not re.search(MINE_SKIP, k, re.I)]
    out = {}
    for part, pat in MINE_PARTS.items():
        got = [k for k in keys if re.search(pat, k, re.I)]
        if part == "dash" and kind != "dash":
            got = []
        if got:
            out[part] = got[:4]
    # 애니메이션 SpellN 에 박힌 이펙트(프레임 → 초, 30fps)
    anim = []
    for v in d.values():
        if isinstance(v, dict) and "mClipDataMap" in v:
            for clip, cd in (v.get("mClipDataMap") or {}).items():
                if clip.lower() != "spell%d" % (slot + 1):
                    continue
                for ev in (cd.get("mEventDataMap") or {}).values():
                    if isinstance(ev, dict) and ev.get("__type") == "ParticleEventData" and ev.get("mEffectKey") in rmap:
                        if not re.search(MINE_SKIP, ev["mEffectKey"], re.I):
                            anim.append([ev["mEffectKey"], round((ev.get("mStartFrame") or 0) / 30, 3)])
    if anim:
        out["anim"] = anim[:4]
    for part, keys in MINE_EXTRA.get((champ, slot), {}).items():
        out[part] = list(dict.fromkeys(out.get(part, []) + [k for k in keys if k in rmap]))
    return out


# 발생기에서 화면이 쓰는 값만 남긴다(이름은 bin 그대로). 값-with-dynamics 는 아래 val() 로 줄인다
KEEP = """rate lifetime particleLifetime particleLinger emitterLinger timeBeforeFirstEmission isSingleParticle period
timeActiveDuringPeriod bindWeight isEmitterSpace EmitterPosition SpawnShape birthVelocity velocity birthAcceleration acceleration
worldAcceleration birthDrag drag birthOrbitalVelocity birthRotation0 rotation0 birthRotationalVelocity0 birthRotationalAcceleration
birthScale0 scale0 isUniformScale birthColor Color particleColorTexture colorLookUpScales colorLookUpOffsets colorLookUpTypeX
colorLookUpTypeY texture textureMult texDiv numFrames frameRate birthFrameRate startFrame isRandomStartFrame uvScale birthUVOffset
uvRotation birthUvRotateRate birthUvScrollRate particleUVScrollRate emitterUvScrollRate uvScrollClamp primitive blendMode pass alphaRef
isGroundLayer isLocalOrientation particleIsLocalOrientation isDirectionOriented directionVelocityScale directionVelocityMinScale
alphaErosionDefinition paletteDefinition childParticleSetDefinition hasPostRotateOrientation postRotateOrientationAxis
disableBackfaceCull TextureFlipU TextureFlipV texAddressModeBase uvMode emitterName rateByVelocityFunction isFollowingTerrain""".split()


def load(champ):
    """챔피언의 스킨 bin 들 → ({항목 이름: dict}, WAD)"""
    B = lolbin.Bin()
    f = next(x for x in os.listdir(WAD_DIR) if x.lower() == champ + ".wad.client")
    w = cm.Wad(os.path.join(WAD_DIR, f))
    skin, links = B.parse(w.read("data/characters/%s/skins/skin0.bin" % champ))
    d = dict(skin)
    for p in links:
        if w.has(p):
            d.update(B.parse(w.read(p))[0])
    return d, w


def val(v):
    """ValueFloat·ValueVector3·ValueColor·IntegratedValue* → {c, t, v, r}(비면 None)"""
    if not isinstance(v, dict):
        return v
    out = {}
    if v.get("constantValue") is not None:
        out["c"] = v["constantValue"]
    d = v.get("dynamics")
    if isinstance(d, dict):
        if d.get("times"):
            out["t"] = d["times"]
            out["v"] = d.get("values")
        tabs = d.get("probabilityTables")
        if tabs:
            out["r"] = [[t.get("keyTimes"), t.get("keyValues")] if t and t.get("keyTimes") else None for t in tabs]
    return out or None


def simplify(o):
    """bin dict 을 재귀로 줄인다: Value* 는 val(), 그 밖의 dict 은 __type 을 T 로"""
    if isinstance(o, dict):
        t = o.get("__type", "")
        if t.startswith("Value") or t.startswith("IntegratedValue"):
            return val(o)
        out = {k: simplify(x) for k, x in o.items() if k != "__type"}
        if t:
            out["T"] = t
        return out
    if isinstance(o, list):
        return [simplify(x) for x in o]
    return o


class Pack:
    def __init__(self):
        self.systems, self.textures, self.meshes = {}, {}, {}
        try:
            self.done = json.load(open(os.path.join(OUT, "t", "index.json"), encoding="utf-8"))
        except (OSError, ValueError):
            self.done = {}

    def tex(self, path):
        """롤 텍스처 경로 → 번호(받아서 webp 로 적는다). 못 받으면 None"""
        if not path:
            return None
        key = path.lower()
        if key in self.textures:
            return self.textures[key]["i"]
        i = len([t for t in self.textures.values() if t["i"] is not None])
        # 같은 순서로 다시 돌리면 번호도 같다. 이미 적은 그림이 그 텍스처면 다시 받지 않는다(t/index.json)
        made = os.path.join(OUT, "t", "%d.webp" % i)
        if self.done.get(str(i)) == path and os.path.exists(made):
            with Image.open(made) as im:
                self.textures[key] = {"i": i, "w": im.width, "h": im.height, "src": path}
            return i
        url = CDRAGON + key.replace(".tex", ".png").replace(".dds", ".png")
        # 받은 PNG 는 tools/.cache/tex 에 둔다(다시 돌릴 때 안 받게)
        cached = os.path.join(lolbin.CACHE, "tex", key.replace("/", "_").replace(".tex", ".png").replace(".dds", ".png"))
        try:
            if os.path.exists(cached):
                raw = open(cached, "rb").read()
            else:
                req = urllib.request.Request(url, headers={"User-Agent": "tiergg-tools/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    raw = r.read()
                os.makedirs(os.path.dirname(cached), exist_ok=True)
                open(cached, "wb").write(raw)
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
            print("  텍스처 못 받음:", path, e, file=sys.stderr)
            self.textures[key] = {"i": None}
            return None
        k = TEX_MAX / max(img.size)
        if k < 1:
            img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
        os.makedirs(os.path.join(OUT, "t"), exist_ok=True)
        img.save(os.path.join(OUT, "t", "%d.webp" % i), "WEBP", quality=88, method=4)
        self.textures[key] = {"i": i, "w": img.width, "h": img.height, "src": path}
        return i

    def mesh(self, w, path):
        """.scb 메시 → 번호. 삼각형마다 정점 3개(위치 3, UV 2) 로 풀어 둔다"""
        key = path.lower()
        if key in self.meshes:
            return self.meshes[key]["i"]
        i = len(self.meshes)
        try:
            data = w.read(key)
        except KeyError:
            print("  메시 없음:", path, file=sys.stderr)
            self.meshes[key] = {"i": None}
            return None
        self.meshes[key] = {"i": i, **read_scb(data)}
        return i

    def add_system(self, d, w, name, depth=0):
        """파티클 시스템(경로) 을 넣고 그 이름을 돌려준다. 자식 시스템도 따라 넣는다"""
        if name in self.systems or name not in d or depth > 4:
            return name if name in self.systems else None
        s = d[name]
        self.systems[name] = None          # 자식이 부모를 다시 부를 때 멈추게
        rmap = resource_map(d)
        ems = []
        for e in (s.get("complexEmitterDefinitionData") or []) + (s.get("simpleEmitterDefinitionData") or []):
            if not isinstance(e, dict) or e.get("disabled"):
                continue
            if e.get("importance") == 4:            # 낮은 그래픽 설정에서만 보이는 대체 발생기
                continue
            if e.get("distortionDefinition"):       # 화면 일그러짐만 그리는 발생기(색은 안 그린다)
                continue
            filt = e.get("Filtering") or {}
            if filt.get("keywordsRequired"):         # 특정 스킨에서만 켜지는 발생기
                continue
            o = {k: simplify(e[k]) for k in KEEP if k in e}
            o["texture"] = self.tex(e.get("texture"))
            if o["texture"] is None and not e.get("primitive"):
                continue
            if "particleColorTexture" in o:
                o["particleColorTexture"] = self.tex(e["particleColorTexture"])
            tm = e.get("textureMult")
            if isinstance(tm, dict) and tm.get("textureMult"):
                o["textureMult"] = simplify(tm)
                o["textureMult"]["textureMult"] = self.tex(tm["textureMult"])
            ae = e.get("alphaErosionDefinition")
            if isinstance(ae, dict) and ae.get("erosionMapName"):
                o["alphaErosionDefinition"] = simplify(ae)
                o["alphaErosionDefinition"]["erosionMapName"] = self.tex(ae["erosionMapName"])
            pd = e.get("paletteDefinition")
            if isinstance(pd, dict) and pd.get("paletteTexture"):
                o["paletteDefinition"] = simplify(pd)
                o["paletteDefinition"]["paletteTexture"] = self.tex(pd["paletteTexture"])
            pr = e.get("primitive")
            if isinstance(pr, dict):
                p = simplify(pr)
                m = (pr.get("mMesh") or {}).get("mSimpleMeshName")
                if m:
                    if not m.lower().endswith(".scb"):
                        continue                    # 엔진도 .scb 말고는 안 읽는다(.sco 는 아무것도 안 그림)
                    p["mesh"] = self.mesh(w, m)
                    if p["mesh"] is None:
                        continue
                o["primitive"] = p
            cp = e.get("childParticleSetDefinition")
            if isinstance(cp, dict):
                kids = []
                for c in cp.get("childrenIdentifiers") or []:
                    k = c.get("effectKey") or c.get("effectName")
                    path = rmap.get(k, k)
                    got = self.add_system(d, w, path, depth + 1)
                    if got:
                        kids.append(got)
                if kids:
                    o["childParticleSetDefinition"] = {"kids": kids, "onDeath": bool(cp.get("childEmitOnDeath")),
                                                       "chance": val(cp.get("childrenProbability"))}
                else:
                    o.pop("childParticleSetDefinition", None)
            ems.append(o)
        # 이 이펙트가 켜질 때 롤이 내는 소리(Wwise 이벤트 이름. tools/lol_sfx.py 가 소리 파일로 뽑는다)
        snd = s.get("soundOnCreateDefault") or s.get("soundPersistentDefault")
        self.systems[name] = {"emitters": ems, "flags": s.get("flags", 0), **({"sound": snd} if snd else {})}
        return name


def resource_map(d):
    rr = next((v for k, v in d.items() if v.get("__type") == "ResourceResolver" and k.endswith("Skin0/Resources")), None)
    return (rr or {}).get("resourceMap", {})


def read_scb(data):
    """정적 메시(.scb, 'r3d2Mesh') → {pos: [x,y,z,...], uv: [u,v,...]} 삼각형마다 3정점"""
    assert data[:8] == b"r3d2Mesh", data[:8]
    o = 8
    major, minor = struct.unpack_from("<HH", data, o); o += 4
    o += 128                                   # 이름
    nv, nf, flags = struct.unpack_from("<III", data, o); o += 12
    o += 24                                    # 경계 상자
    vtype = 0
    if major == 3 and minor == 2:
        vtype = struct.unpack_from("<I", data, o)[0]; o += 4
    pts = struct.unpack_from("<%df" % (nv * 3), data, o); o += nv * 12
    if vtype == 1:
        o += nv * 4                            # 정점 색
    o += 12                                    # 가운데 점
    pos, uv = [], []
    for _ in range(nf):
        a, b, c = struct.unpack_from("<III", data, o); o += 12
        o += 64                                # 재질 이름
        us = struct.unpack_from("<6f", data, o); o += 24     # u0 u1 u2 v0 v1 v2
        for k, i in enumerate((a, b, c)):
            pos += [round(x, 2) for x in pts[i * 3:i * 3 + 3]]
            uv += [round(us[k], 4), round(us[3 + k], 4)]
    return {"pos": pos, "uv": uv}


def prefetch(paths):
    """텍스처 PNG 를 여럿 한꺼번에 받아 tools/.cache/tex 에 둔다(하나씩 받으면 수백 장에 30분 넘게 걸린다)"""
    from concurrent.futures import ThreadPoolExecutor

    def one(path):
        key = path.lower()
        cached = os.path.join(lolbin.CACHE, "tex", key.replace("/", "_").replace(".tex", ".png").replace(".dds", ".png"))
        if os.path.exists(cached):
            return
        try:
            req = urllib.request.Request(CDRAGON + key.replace(".tex", ".png").replace(".dds", ".png"),
                                         headers={"User-Agent": "tiergg-tools/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            os.makedirs(os.path.dirname(cached), exist_ok=True)
            open(cached, "wb").write(raw)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            pass
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(one, sorted(paths)))


def collect(o, out):
    """bin dict 안의 .tex·.dds 경로를 모두 모은다"""
    if isinstance(o, dict):
        for v in o.values():
            collect(v, out)
    elif isinstance(o, list):
        for v in o:
            collect(v, out)
    elif isinstance(o, str) and o.lower().endswith((".tex", ".dds")):
        out.add(o)


def main():
    # 먼저 쓰일 시스템들의 텍스처를 한꺼번에 받아 둔다
    paths, cache = set(), {}
    for skill, (champ, parts) in SKILLS.items():
        if champ not in cache:
            cache[champ] = load(champ)
        d, _ = cache[champ]
        rmap = resource_map(d)
        for keys in parts.values():
            for k in keys:
                if rmap.get(k) in d:
                    collect(d[rmap[k]], paths)
                    # 자식 시스템까지(한 단계 더)
                    for e in d[rmap[k]].get("complexEmitterDefinitionData") or []:
                        for c in ((e.get("childParticleSetDefinition") or {}).get("childrenIdentifiers") or []):
                            kk = c.get("effectKey") or c.get("effectName")
                            if rmap.get(kk, kk) in d:
                                collect(d[rmap.get(kk, kk)], paths)
    print("텍스처", len(paths), "장 받는 중", flush=True)
    prefetch(paths)
    pack = Pack()
    skills = {}
    for skill, (champ, parts) in SKILLS.items():
        if champ not in cache:
            print(champ, flush=True)
            cache[champ] = load(champ)
        d, w = cache[champ]
        rmap = resource_map(d)
        out = {}
        for part, keys in parts.items():
            names = []
            for k in keys:
                path = rmap.get(k)
                if not path:
                    print("  키 없음:", skill, k, file=sys.stderr)
                    continue
                got = pack.add_system(d, w, path)
                if got:
                    names.append(got)
            out[part] = names
        skills[skill] = out
    systems = {k: v for k, v in pack.systems.items() if v}
    textures = sorted((t for t in pack.textures.values() if t["i"] is not None), key=lambda t: t["i"])
    meshes = sorted((m for m in pack.meshes.values() if m["i"] is not None), key=lambda m: m["i"])
    # 내 챔피언: 챔피언마다 파일 하나(dodge/vfx/mine/<챔피언>.json). 시스템·메시는 그 파일 안에, 텍스처 번호는 함께 쓴다
    os.makedirs(os.path.join(OUT, "mine"), exist_ok=True)
    for champ, slots in sorted(mine_skills().items()):
        try:
            d, w = load(champ)
        except (StopIteration, KeyError, OSError) as e:
            print("  못 읽음:", champ, e, file=sys.stderr)
            continue
        sub = Pack()
        sub.textures, sub.done = pack.textures, pack.done          # 텍스처는 함께(번호가 이어진다)
        rmap = resource_map(d)
        plan = {slot: mine_parts(d, champ, slot, kind) for slot, kind in slots}
        # 쓰일 시스템의 텍스처를 한꺼번에 받아 둔다
        paths = set()
        for pp in plan.values():
            for part, keys in pp.items():
                for k in keys:
                    k = k[0] if isinstance(k, list) else k
                    if rmap.get(k) in d:
                        collect(d[rmap[k]], paths)
        prefetch(paths)
        parts = {}
        for slot, kind in slots:
            pp = plan[slot]
            got = {}
            for part, keys in pp.items():
                if part == "anim":
                    names = [[sub.add_system(d, w, rmap[k]), t] for k, t in keys]
                    names = [n for n in names if n[0]]
                else:
                    names = [n for n in (sub.add_system(d, w, rmap[k]) for k in keys) if n]
                if names:
                    got[part] = names
            if got:
                parts[str(slot)] = got
        subsys = {k: v for k, v in sub.systems.items() if v}
        subm = sorted((m for m in sub.meshes.values() if m["i"] is not None), key=lambda m: m["i"])
        with open(os.path.join(OUT, "mine", champ + ".json"), "w", encoding="utf-8") as f:
            json.dump({"slots": parts, "systems": subsys, "meshes": [{"pos": m["pos"], "uv": m["uv"]} for m in subm]},
                      f, ensure_ascii=False, separators=(",", ":"))
        print("내 챔피언", champ, {k: list(v) for k, v in parts.items()}, flush=True)
    textures = sorted((t for t in pack.textures.values() if t["i"] is not None), key=lambda t: t["i"])
    fx = {"skills": skills, "systems": systems,
          "textures": [[t["w"], t["h"]] for t in textures],
          "meshes": [{"pos": m["pos"], "uv": m["uv"]} for m in meshes]}
    os.makedirs(OUT, exist_ok=True)
    # 번호가 바뀌어 남은 옛 그림은 지운다
    for f in os.listdir(os.path.join(OUT, "t")):
        if f.endswith(".webp") and int(f[:-5]) >= len(textures):
            os.remove(os.path.join(OUT, "t", f))
    with open(os.path.join(OUT, "t", "index.json"), "w", encoding="utf-8") as f:
        json.dump({str(t["i"]): t["src"] for t in textures}, f, ensure_ascii=False, indent=0)
    with open(os.path.join(OUT, "fx.json"), "w", encoding="utf-8") as f:
        json.dump(fx, f, ensure_ascii=False, separators=(",", ":"))
    print("시스템", len(systems), "발생기", sum(len(s["emitters"]) for s in systems.values()),
          "텍스처", len(textures), "메시", len(meshes))


if __name__ == "__main__":
    main()
