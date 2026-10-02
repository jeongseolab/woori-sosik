"""연습장 스킬 소리를 롤 클라이언트의 효과음 그대로 뽑는다. 개발자 PC 에서 한 번 돌리는 도구.

롤의 효과음은 Wwise 사운드 뱅크에 있다(챔피언 WAD 의 assets/sounds/wwise2016/sfx/characters/<챔피언>/skins/base/
<챔피언>_base_sfx_events.bnk·_audio.bnk). 이벤트 이름(Play_sfx_Lux_LuxLightBinding_OnCast 등) 의 FNV-1 해시로 이벤트를 찾고,
이벤트 → 동작(Play) → 소리(또는 무작위·전환 컨테이너 안의 소리들) → wem(소리 파일) 을 따라간다.
wem(Wwise Vorbis) 은 vgmstream-cli 로 풀고 ogg(Vorbis) 로 다시 줄인다(static/dodge/sfx/lol/<이벤트>_<번호>.ogg).

어떤 소리를 쓰는지:
  - 파티클이 켜질 때 롤이 내는 소리: fx.json 의 시스템마다 sound(tools/lol_vfx.py 가 적는다)
  - 스킬을 쓸 때·투사체가 나갈 때 소리: 아래 CAST(롤 스킬 스크립트 이름으로 된 이벤트)

  pip install soundfile
  python tools/lol_sfx.py --vgmstream <vgmstream-cli.exe 경로>
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile

import soundfile as sf

import champ_models as cm
import lol_vfx

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "dodge", "sfx", "lol")
FX = os.path.join(HERE, "..", "static", "dodge", "vfx", "fx.json")
VARIANTS = 3            # 무작위 컨테이너에서 많아야 이만큼 뽑는다
LAYERS = 3              # 한 이벤트가 함께 울리는 겹은 많아야 이만큼

# 스킬을 쓸 때(cast)·투사체가 나갈 때(launch) 롤이 내는 이벤트
CAST = {
    "모르가나 Q": ["Play_sfx_Morgana_MorganaQ_OnCast"],
    "럭스 Q": ["Play_sfx_Lux_LuxLightBinding_OnCast"],
    "자이라 E": ["Play_sfx_Zyra_ZyraE_OnCast"],
    "니달리 Q": ["Play_sfx_Nidalee_JavelinToss_OnCast"],
    "브랜드 Q": ["Play_sfx_Brand_BrandQ_OnCast"],
    "아리 E": ["Play_sfx_Ahri_AhriE_OnCast"],
    "벨코즈 Q": ["Play_sfx_Velkoz_VelkozQ_OnCast"],
    "제라스 E": ["Play_sfx_Xerath_XerathMageSpear_OnCast"],
    "이즈리얼 Q": ["Play_sfx_Ezreal_EzrealQ_OnCast"],
    "레오나 E": ["Play_sfx_Leona_LeonaZenithBlade_OnCast"],
    "베이가 Q": ["Play_sfx_Veigar_VeigarBalefulStrike_OnCast"],
    "블리츠크랭크 Q": ["Play_sfx_Blitzcrank_RocketGrab_OnCast"],
    "쓰레쉬 Q": ["Play_sfx_Thresh_ThreshQ_OnCast"],
    "징크스 W": ["Play_sfx_Jinx_JinxW_OnCast"],
    "애쉬 R": ["Play_sfx_Ashe_EnchantedCrystalArrow_OnCast"],
    "카서스 Q": ["Play_sfx_Karthus_KarthusLayWasteA1_OnCast"],
    "브랜드 W": ["Play_sfx_Brand_BrandW_OnCast"],
    "초가스 Q": ["Play_sfx_Chogath_Rupture_OnCast"],
    "베이가 W": ["Play_sfx_Veigar_VeigarDarkMatter_OnCast"],
    "신드라 Q": ["Play_sfx_Syndra_SyndraQSpell_buffactivate"],
    "제라스 W": ["Play_sfx_Xerath_XerathArcaneBarrage2_OnCast"],
    "벨코즈 E": ["Play_sfx_Velkoz_VelkozE_OnCast"],
    "레오나 R": ["Play_sfx_Leona_LeonaSolarFlare_OnCast"],
    "진 W": ["Play_sfx_Jhin_JhinW_OnCast"],
    "럭스 R": ["Play_sfx_Lux_LuxR_OnCast"],
    "베이가 E": ["Play_sfx_Veigar_VeigarEventHorizon_OnCast"],
}


# 투사체가 나갈 때(launch)·내가 맞았을 때(hit)·장판이 터질 때(boom). 롤은 스킬 스크립트가 이 이벤트를 부른다.
# 이펙트에 소리가 붙어 있는 것(fx.json 의 sound) 은 이펙트가 켜질 때 나므로 여기 적지 않는다
LAUNCH = {
    "모르가나 Q": ["Play_sfx_Morgana_MorganaQ_OnMissileLaunch"],
    "럭스 Q": ["Play_sfx_Lux_LuxLightBindingDummy_OnMissileLaunch"],
    "자이라 E": ["Play_sfx_Zyra_ZyraE_OnMissileLaunch"],
    "이즈리얼 Q": ["Play_sfx_Ezreal_EzrealQ_OnMissileLaunch"],
    "베이가 Q": ["Play_sfx_Veigar_VeigarBalefulStrikeMis_OnMissileLaunch"],
    "제라스 E": ["Play_sfx_Xerath_XerathMageSpearMissile_OnMissileLaunch"],
    "블리츠크랭크 Q": ["Play_sfx_Blitzcrank_RocketGrabMissile_OnMissileLaunch"],
    "아리 E": ["Play_sfx_Ahri_AhriEMissile_OnMissileLaunch"],
    "징크스 W": ["Play_sfx_Jinx_JinxWMissile_OnMissileLaunch"],
    "레오나 E": ["Play_sfx_Leona_LeonaZenithBladeMissile_OnMissileLaunch"],
}
HIT = {
    "모르가나 Q": ["Play_sfx_Morgana_MorganaQ_OnHit"],
    "럭스 Q": ["Play_sfx_Lux_LuxLightBindingMis_OnBuffActivate"],
    "자이라 E": ["Play_sfx_Zyra_ZyraEHold_OnBuffActivate"],
    "이즈리얼 Q": ["Play_sfx_Ezreal_EzrealQ_OnHit"],
    "베이가 Q": ["Play_sfx_Veigar_VeigarBalefulStrikeMis_OnHit"],
    "제라스 E": ["Play_sfx_Xerath_XerathMageSpearMissile_hitchamp"],
    "블리츠크랭크 Q": ["Play_sfx_Blitzcrank_RocketGrabMissile_OnHit"],
    "벨코즈 E": ["Play_sfx_Velkoz_VelkozEStun_OnBuffActivate"],
    "카서스 Q": ["Play_sfx_Karthus_KarthusLayWasteSoundDummy_hitsingle"],
}
BOOM = {
    "카서스 Q": ["Play_sfx_Karthus_KarthusLayWasteSoundDummy_buffactivate"],
}


def fnv1(name):
    """Wwise 이름 해시(FNV-1 32비트, 소문자)"""
    h = 2166136261
    for c in name.lower().encode():
        h = (h * 16777619) & 0xFFFFFFFF
        h ^= c
    return h


def sections(data):
    """Wwise 뱅크 → {마디 이름: 바이트}"""
    out, o = {}, 0
    while o + 8 <= len(data):
        tag = data[o:o + 4].decode("latin1"); size = struct.unpack_from("<I", data, o + 4)[0]
        out[tag] = data[o + 8:o + 8 + size]
        o += 8 + size
    return out


def var_int(d, o):
    """Wwise 의 가변 길이 정수(7비트씩, 높은 자리부터)"""
    v = 0
    while True:
        b = d[o]; o += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, o


class Bank:
    """events.bnk 의 HIRC(이벤트·동작·소리·컨테이너) 와 audio.bnk 의 wem 들"""

    def __init__(self, events, audio):
        hi = sections(events).get("HIRC", b"")
        self.objs = {}
        n = struct.unpack_from("<I", hi, 0)[0]
        o = 4
        for _ in range(n):
            t, size = struct.unpack_from("<BI", hi, o)
            oid = struct.unpack_from("<I", hi, o + 5)[0]
            self.objs[oid] = (t, hi[o + 9:o + 5 + size])
            o += 5 + size
        # 오디오 뱅크(소리 객체가 이쪽 HIRC 에 있을 때도 있다) 와 wem
        sa = sections(audio)
        if "HIRC" in sa:
            n = struct.unpack_from("<I", sa["HIRC"], 0)[0]
            o = 4
            for _ in range(n):
                t, size = struct.unpack_from("<BI", sa["HIRC"], o)
                oid = struct.unpack_from("<I", sa["HIRC"], o + 5)[0]
                self.objs.setdefault(oid, (t, sa["HIRC"][o + 9:o + 5 + size]))
                o += 5 + size
        self.wems = {}
        didx, data = sa.get("DIDX", b""), sa.get("DATA", b"")
        for k in range(len(didx) // 12):
            wid, off, size = struct.unpack_from("<III", didx, k * 12)
            self.wems[wid] = data[off:off + size]

    def event(self, name):
        """이벤트 이름 → 겹(Play 동작) 마다 후보 wem id 들. 겹은 함께 울리고, 한 겹 안의 후보(무작위 컨테이너) 는 하나만 고른다"""
        ob = self.objs.get(fnv1(name))
        if not ob or ob[0] != 4:
            return []
        d = ob[1]
        n, o = var_int(d, 0)
        if n > 64:                                  # 옛 형식(u32 개수)
            n = struct.unpack_from("<I", d, 0)[0]; o = 4
        acts = struct.unpack_from("<%dI" % n, d, o)
        layers = []
        for a in acts:
            at = self.objs.get(a)
            if not at or at[0] != 3:
                continue
            kind, target = struct.unpack_from("<HI", at[1], 0)
            if kind >> 8 != 0x04:                   # Play 만(멈춤·볼륨 조절 등은 뺀다)
                continue
            alts = list(dict.fromkeys(self.sounds(target, 0)))
            if alts and alts not in layers:
                layers.append(alts)
        return layers

    def sounds(self, oid, depth):
        """객체 → wem id 들. 소리면 그 원본, 컨테이너면 안에 든 객체들을 따라간다"""
        ob = self.objs.get(oid)
        if not ob or depth > 6:
            return []
        t, d = ob
        if t == 2:                                  # 소리: 플러그인 u32, 스트림 u8, 원본 id u32
            sid = struct.unpack_from("<I", d, 5)[0]
            return [sid] if sid in self.wems else []
        if t in (5, 6, 9):                          # 무작위·순서 / 전환 / 섞기 컨테이너: 자식 목록을 따라간다
            out = []
            for v in self.children(oid, d):
                out += self.sounds(v, depth + 1)
            return out
        return []

    def children(self, oid, d):
        """컨테이너의 자식 목록(u32 개수 + u32 id 들). 앞쪽의 NodeBaseParams 는 버전마다 길이가 달라서
        '개수 N 뒤에 알려진 소리·컨테이너 id 가 N 개 이어지는 곳' 중 마지막(자식 목록은 끝 쪽에 있다) 을 쓴다.
        부모 id(DirectParentID) 는 개수 없이 혼자 있어서 걸리지 않는다"""
        best = []
        for k in range(0, len(d) - 7):
            n = struct.unpack_from("<I", d, k)[0]
            if not 1 <= n <= 64 or k + 4 + n * 4 > len(d):
                continue
            ids = struct.unpack_from("<%dI" % n, d, k + 4)
            if all(v != oid and v in self.objs and self.objs[v][0] in (2, 5, 6, 9) for v in ids):
                best = list(ids)
        return best


def decode(vgm, wem):
    """wem 바이트 → (샘플, 샘플링 주파수)"""
    with tempfile.TemporaryDirectory() as td:
        src, dst = os.path.join(td, "a.wem"), os.path.join(td, "a.wav")
        open(src, "wb").write(wem)
        subprocess.run([vgm, "-o", dst, src], check=True, capture_output=True)
        data, sr = sf.read(dst, dtype="float32")
    return data, sr


MAX_SEC = 3.0           # 이보다 긴 소리(돌아가는 반복음) 는 자르고 끝을 줄여 끝낸다


def save(path, data, sr):
    """ogg(Vorbis) 로 적는다. 한 번에 길게 쓰면 libsndfile 의 Vorbis 인코더가 스택을 넘치니 조금씩 나눠 쓴다"""
    n = min(len(data), int(sr * MAX_SEC))
    data = data[:n].copy()
    if len(data) == int(sr * MAX_SEC):
        fade = int(sr * 0.3)
        ramp = [1 - i / fade for i in range(fade)]
        for i, g in enumerate(ramp):
            data[n - fade + i] *= g
    ch = 1 if data.ndim == 1 else data.shape[1]
    with sf.SoundFile(path, "w", samplerate=sr, channels=ch, format="OGG", subtype="VORBIS") as f:
        for i in range(0, len(data), 4096):
            f.write(data[i:i + 4096])


def mine_events(champ):
    """내 챔피언의 칸(0~3) → 그 스킬을 쓸 때 롤이 내는 이벤트들(Play_sfx_<챔피언>_<스킬 스크립트 이름>_OnCast)"""
    d, w = lol_vfx.load(champ)
    root = next((v for k, v in d.items() if k.endswith("CharacterRecords/Root")), None)
    if not root:
        return {}, w
    evs = []
    for v in d.values():
        sap = v.get("skinAudioProperties") if isinstance(v, dict) else None
        if sap:
            for bu in sap.get("bankUnits") or []:
                if "SFX" in (bu.get("name") or "").upper():
                    evs += bu.get("events") or []
    out = {}
    for slot, kind in lol_vfx.mine_skills().get(champ, []):
        spells = root.get("spells") or []
        if slot >= len(spells):
            continue
        name = spells[slot].split("/")[-1].lower()
        got = [e for e in evs if e.lower().startswith("play_") and e.lower().endswith("_%s_oncast" % name)]
        if not got:
            got = [e for e in evs if e.lower().startswith("play_") and ("_%s_" % name) in e.lower() and "cast" in e.lower()][:1]
        if got:
            out[str(slot)] = got[:2]
    return out, w


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--vgmstream", required=True, help="vgmstream-cli.exe 경로(github.com/vgmstream/vgmstream)")
    a = ap.parse_args()
    fx = json.load(open(FX, encoding="utf-8"))
    # 챔피언마다 필요한 이벤트
    want = {}
    for skill, (champ, _) in lol_vfx.SKILLS.items():
        want.setdefault(champ, set()).update(CAST.get(skill, []) + LAUNCH.get(skill, []) + HIT.get(skill, []) + BOOM.get(skill, []))
        for part in fx["skills"].get(skill, {}).values():
            for sysname in part:
                snd = (fx["systems"].get(sysname) or {}).get("sound")
                if snd:
                    want[champ].add(snd)
    os.makedirs(OUT, exist_ok=True)
    table = {}
    for champ, events in sorted(want.items()):
        f = next(x for x in os.listdir(lol_vfx.WAD_DIR) if x.lower() == champ + ".wad.client")
        w = cm.Wad(os.path.join(lol_vfx.WAD_DIR, f))
        base = "assets/sounds/wwise2016/sfx/characters/%s/skins/base/%s_base_sfx_" % (champ, champ)
        bank = Bank(w.read(base + "events.bnk"), w.read(base + "audio.bnk"))
        for ev in sorted(events):
            layers = []
            for li, alts in enumerate(bank.event(ev)[:LAYERS]):
                files = []
                for wid in alts[:VARIANTS]:
                    try:
                        data, sr = decode(a.vgmstream, bank.wems[wid])
                    except (subprocess.CalledProcessError, RuntimeError) as e:
                        print("  못 풂:", ev, wid, e, file=sys.stderr)
                        continue
                    if len(data) < sr * 0.03:         # 빈 소리(0초 자리표시) 는 뺀다
                        continue
                    name = "%s_%d%s.ogg" % (ev.lower(), li, "abc"[len(files)])
                    save(os.path.join(OUT, name), data, sr)
                    files.append(name)
                if files:
                    layers.append(files)
            print(champ, ev, [len(x) for x in layers], flush=True)
            if layers:
                table[ev] = layers
    # 내 챔피언 스킬 소리
    mine = {}
    for champ in sorted(lol_vfx.mine_skills()):
        try:
            slots, w = mine_events(champ)
        except (StopIteration, KeyError, OSError) as e:
            print("  못 읽음:", champ, e, file=sys.stderr)
            continue
        if not slots:
            continue
        base = "assets/sounds/wwise2016/sfx/characters/%s/skins/base/%s_base_sfx_" % (champ, champ)
        try:
            bank = Bank(w.read(base + "events.bnk"), w.read(base + "audio.bnk"))
        except KeyError:
            continue
        for slot, events in slots.items():
            for ev in events:
                if ev in table:
                    continue
                layers = []
                for li, alts in enumerate(bank.event(ev)[:LAYERS]):
                    files = []
                    for wid in alts[:VARIANTS]:
                        try:
                            data, sr = decode(a.vgmstream, bank.wems[wid])
                        except (subprocess.CalledProcessError, RuntimeError):
                            continue
                        if len(data) < sr * 0.03:
                            continue
                        name = "%s_%d%s.ogg" % (ev.lower(), li, "abc"[len(files)])
                        save(os.path.join(OUT, name), data, sr)
                        files.append(name)
                    if files:
                        layers.append(files)
                if layers:
                    table[ev] = layers
        mine[champ] = {k: [e for e in v if e in table] for k, v in slots.items() if any(e in table for e in v)}
        print("내 챔피언", champ, mine[champ], flush=True)
    with open(os.path.join(OUT, "sfx.json"), "w", encoding="utf-8") as fo:
        json.dump({"cast": CAST, "launch": LAUNCH, "hit": HIT, "boom": BOOM, "mine": mine, "events": table}, fo, ensure_ascii=False, separators=(",", ":"))
    print("이벤트", len(table), "파일", sum(len(f) for v in table.values() for f in v))


if __name__ == "__main__":
    main()
