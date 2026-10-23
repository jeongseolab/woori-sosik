"""21.0.0 에 더한 챔피언(champ_models.NEW21) 처럼 내 챔피언을 새로 더할 때, 그 챔피언의 스킬 이펙트·소리만 뽑아 덧붙인다.
lol_vfx.py·lol_sfx.py 를 다시 돌리면 모든 것을 새로 만들지만, 이 도구는 기존 것(텍스처 번호·소리 표) 을 그대로 두고 뒤에 붙인다.

  python lol_add_mine.py --vgmstream <vgmstream-cli.exe> [챔피언 ...]     (챔피언을 비우면 NEW21 에서 스킬이 있는 챔피언 모두)
  python lol_add_mine.py --vgmstream <vgmstream-cli.exe> --enemy "요네 Q3"   (적 스킬을 더할 때. lol_vfx.SKILLS·lol_sfx 표에 먼저 적는다)
  python lol_add_mine.py --vgmstream <vgmstream-cli.exe> --global           (공용 이펙트·소리: 기절·둔화, 소환사 주문·레벨 업·사망 …)

- 이펙트: static/dodge/vfx/mine/<챔피언>.json. 텍스처는 lol_vfx.Pack 이 t/index.json 의 원본 경로로 같은 번호를 쓰고,
  새 텍스처만 다음 번호부터 받아 fx.json 의 textures 목록·t/index.json 을 늘린다(번호는 빈틈없이 이어진다)
- 소리: static/dodge/sfx/lol/sfx.json 의 mine·events 에 더한다(기존 이벤트는 다시 풀지 않는다)
"""
import argparse, json, os, subprocess, sys
import champ_models as cm
import lol_sfx as ls
import lol_vfx as lv


def add_vfx(champs):
    fxp, ixp = os.path.join(lv.OUT, "fx.json"), os.path.join(lv.OUT, "t", "index.json")
    fx = json.load(open(fxp, encoding="utf-8"))
    ix = json.load(open(ixp, encoding="utf-8"))
    n0 = len(fx["textures"])
    assert n0 == len(ix) and all(str(i) in ix for i in range(n0)), "텍스처 번호가 이어져 있지 않다"
    pack = lv.Pack()
    assert pack.next == n0, (pack.next, n0)
    mine = lv.mine_skills()
    for champ in champs:
        slots = mine.get(champ) or []
        if not slots:
            continue
        try:
            d, w = lv.load(champ)
        except (StopIteration, KeyError, OSError) as e:
            print("  못 읽음:", champ, e, file=sys.stderr)
            continue
        sub = lv.Pack.__new__(lv.Pack)
        sub.systems, sub.meshes = {}, {}
        sub.textures, sub.keep, sub.next = pack.textures, pack.keep, pack.next
        rmap = lv.resource_map(d)
        plan = {slot: lv.mine_parts(d, champ, slot, kind) for slot, kind in slots}
        paths = set()
        for pp in plan.values():
            for keys in pp.values():
                for k in keys:
                    k = k[0] if isinstance(k, list) else k
                    if rmap.get(k) in d:
                        lv.collect(d[rmap[k]], paths)
        lv.prefetch(paths)
        parts = {}
        for slot, _kind in slots:
            got = {}
            for part, keys in plan[slot].items():
                if part == "anim":
                    names = [n for n in ([sub.add_system(d, w, rmap[k]), *rest] for k, *rest in keys) if n[0]]
                else:
                    names = [n for n in (sub.add_system(d, w, rmap[k]) for k in keys) if n]
                if names:
                    got[part] = names
            if got:
                parts[str(slot)] = got
        pack.next = sub.next
        subsys = {k: v for k, v in sub.systems.items() if v}
        subm = sorted((m for m in sub.meshes.values() if m["i"] is not None), key=lambda m: m["i"])
        with open(os.path.join(lv.OUT, "mine", champ + ".json"), "w", encoding="utf-8") as f:
            json.dump({"slots": parts, "systems": subsys, "meshes": [{k: v for k, v in m.items() if k != "i"} for m in subm]},
                      f, ensure_ascii=False, separators=(",", ":"))
        print("이펙트", champ, {k: list(v) for k, v in parts.items()}, flush=True)
    new = sorted((t for t in pack.textures.values() if t.get("i") is not None and t["i"] >= n0), key=lambda t: t["i"])
    for t in new:
        fx["textures"].append([t["w"], t["h"]])
        ix[str(t["i"])] = t["src"]
    with open(fxp, "w", encoding="utf-8") as f:
        json.dump(fx, f, ensure_ascii=False, separators=(",", ":"))
    with open(ixp, "w", encoding="utf-8") as f:
        json.dump(ix, f, ensure_ascii=False, indent=0)
    print("새 텍스처", len(new), "→ 모두", len(fx["textures"]))


def add_sfx(champs, vgm):
    p = os.path.join(ls.OUT, "sfx.json")
    j = json.load(open(p, encoding="utf-8"))
    table, mine = j["events"], j["mine"]
    for champ in champs:
        try:
            slots, w = ls.mine_events(champ)
        except (StopIteration, KeyError, OSError) as e:
            print("  못 읽음:", champ, e, file=sys.stderr)
            continue
        if not slots:
            continue
        base = "assets/sounds/wwise2016/sfx/characters/%s/skins/base/%s_base_sfx_" % (champ, champ)
        try:
            bank = ls.Bank(w.read(base + "events.bnk"), w.read(base + "audio.bnk"))
        except KeyError:
            continue
        for events in slots.values():
            for ev in events:
                if ev in table:
                    continue
                layers = []
                for li, alts in enumerate(bank.event(ev)[:ls.LAYERS]):
                    files = []
                    for wid in alts[:ls.VARIANTS]:
                        try:
                            data, sr = ls.decode(vgm, bank.wems[wid])
                        except (subprocess.CalledProcessError, RuntimeError):
                            continue
                        if len(data) < sr * 0.03:
                            continue
                        name = "%s_%d%s.ogg" % (ev.lower(), li, "abc"[len(files)])
                        ls.save(os.path.join(ls.OUT, name), data, sr)
                        files.append(name)
                    if files:
                        layers.append(files)
                if layers:
                    table[ev] = layers
        got = {k: [e for e in v if e in table] for k, v in slots.items() if any(e in table for e in v)}
        if got:
            mine[champ] = got
        print("소리", champ, got, flush=True)
    with open(p, "w", encoding="utf-8") as fo:
        json.dump(j, fo, ensure_ascii=False, separators=(",", ":"))


def add_enemy_vfx(skills):
    """적 스킬(lol_vfx.SKILLS 의 이름) 의 이펙트를 fx.json 의 skills·systems·meshes 에 더한다. 텍스처·메시 번호는 뒤에 이어 붙인다"""
    fxp, ixp = os.path.join(lv.OUT, "fx.json"), os.path.join(lv.OUT, "t", "index.json")
    fx = json.load(open(fxp, encoding="utf-8"))
    ix = json.load(open(ixp, encoding="utf-8"))
    m0 = len(fx["meshes"])
    pack = lv.Pack()
    n0 = pack.next          # 새 텍스처는 이 번호부터(지운 옛 그림 자리는 비어 있을 수 있다)
    for skill in skills:
        champ, parts = lv.SKILLS[skill]
        d, w = lv.load(champ)
        rmap = lv.resource_map(d)
        paths = set()
        for keys in parts.values():
            for k in keys:
                if rmap.get(k) in d:
                    lv.collect(d[rmap[k]], paths)
        lv.prefetch(paths)
        sub = lv.Pack.__new__(lv.Pack)
        sub.systems, sub.meshes = {}, {}
        sub.textures, sub.keep, sub.next = pack.textures, pack.keep, pack.next
        out = {}
        for part, keys in parts.items():
            names = []
            for k in keys:
                if not rmap.get(k):
                    print("  키 없음:", skill, k, file=sys.stderr)
                    continue
                got = sub.add_system(d, w, rmap[k])
                if got:
                    names.append(got)
            out[part] = names
        pack.next = sub.next
        # 이 묶음의 메시 번호(못 읽은 것은 번호만 차지한다) → fx.json 메시 목록 뒤 번호
        ok = sorted((m for m in sub.meshes.values() if m["i"] is not None), key=lambda m: m["i"])
        remap = {m["i"]: m0 + k for k, m in enumerate(ok)}
        for name, sy in sub.systems.items():
            if not sy or name in fx["systems"]:
                continue
            for e in sy["emitters"]:
                if isinstance(e.get("primitive"), dict) and e["primitive"].get("mesh") is not None:
                    e["primitive"]["mesh"] = remap[e["primitive"]["mesh"]]
            fx["systems"][name] = sy
        fx["meshes"] += [{k: v for k, v in m.items() if k != "i"} for m in ok]
        m0 += len(ok)
        fx["skills"][skill] = out
        print("적 이펙트", skill, {k: len(v) for k, v in out.items()}, flush=True)
    new = sorted((t for t in pack.textures.values() if t.get("i") is not None and t["i"] >= n0), key=lambda t: t["i"])
    for t in new:
        fx["textures"].append([t["w"], t["h"]])
        ix[str(t["i"])] = t["src"]
    with open(fxp, "w", encoding="utf-8") as f:
        json.dump(fx, f, ensure_ascii=False, separators=(",", ":"))
    with open(ixp, "w", encoding="utf-8") as f:
        json.dump(ix, f, ensure_ascii=False, indent=0)
    print("새 텍스처", len(new), "→ 모두", len(fx["textures"]))


def add_enemy_sfx(skills, vgm):
    """적 스킬의 소리(lol_sfx 의 CAST·LAUNCH·HIT·BOOM·READY 와 그 이펙트에 붙은 소리) 를 sfx.json 에 더한다"""
    p = os.path.join(ls.OUT, "sfx.json")
    j = json.load(open(p, encoding="utf-8"))
    fx = json.load(open(os.path.join(lv.OUT, "fx.json"), encoding="utf-8"))
    tables = {"cast": ls.CAST, "launch": ls.LAUNCH, "hit": ls.HIT, "boom": ls.BOOM, "ready": ls.READY}
    for skill in skills:
        champ = lv.SKILLS[skill][0]
        want = set()
        for key, tb in tables.items():
            if skill in tb:
                j.setdefault(key, {})[skill] = tb[skill]
                want.update(tb[skill])
        for names in fx["skills"].get(skill, {}).values():
            for n in names:
                snd = (fx["systems"].get(n) or {}).get("sound")
                if snd:
                    want.add(snd)
        _d, w = lv.load(champ)
        base = "assets/sounds/wwise2016/sfx/characters/%s/skins/base/%s_base_sfx_" % (champ, champ)
        bank = ls.Bank(w.read(base + "events.bnk"), w.read(base + "audio.bnk"))
        for ev in sorted(want - set(j["events"])):
            layers = []
            for li, alts in enumerate(bank.event(ev)[:ls.LAYERS]):
                files = []
                for wid in alts[:ls.VARIANTS]:
                    try:
                        data, sr = ls.decode(vgm, bank.wems[wid])
                    except (subprocess.CalledProcessError, RuntimeError):
                        continue
                    if len(data) < sr * 0.03:
                        continue
                    name = "%s_%d%s.ogg" % (ev.lower(), li, "abc"[len(files)])
                    ls.save(os.path.join(ls.OUT, name), data, sr)
                    files.append(name)
                if files:
                    layers.append(files)
            if layers:
                j["events"][ev] = layers
            print("적 소리", skill, ev, [len(x) for x in layers], flush=True)
    with open(p, "w", encoding="utf-8") as fo:
        json.dump(j, fo, ensure_ascii=False, separators=(",", ":"))


# 챔피언 스킬이 아닌 이펙트(Global.wad 의 Shared 공용 bin): 연습장 이름 → 롤 시스템. 기절(머리 위 별)·둔화(발밑 물결)
GLOBAL_WAD = r"C:\Riot Games\League of Legends\Game\DATA\FINAL\Global.wad.client"
SHARED_BIN = 0x5a791d818ae738a6      # Shared/Spells·Shared/Particles 가 든 bin(경로는 해시로만 알려져 있다)
GLOBAL_FX = {"stun": "Shared/Particles/LOC_Stun", "slow": "Shared/Particles/Global_Slow"}


def add_global_vfx():
    """공용 이펙트(GLOBAL_FX) 를 fx.json 의 global·systems·meshes 에 더한다. 텍스처 번호는 뒤에 이어 붙인다"""
    import lolbin
    fxp, ixp = os.path.join(lv.OUT, "fx.json"), os.path.join(lv.OUT, "t", "index.json")
    fx = json.load(open(fxp, encoding="utf-8"))
    ix = json.load(open(ixp, encoding="utf-8"))
    m0 = len(fx["meshes"])
    pack = lv.Pack()
    n0 = pack.next          # 새 텍스처는 이 번호부터(지운 옛 그림 자리는 비어 있을 수 있다)
    w = cm.Wad(GLOBAL_WAD)
    d = dict(lolbin.Bin().parse(w.read_hash(SHARED_BIN))[0])
    paths = set()
    for name in GLOBAL_FX.values():
        lv.collect(d[name], paths)
    lv.prefetch(paths)
    out = {}
    for kind, name in GLOBAL_FX.items():
        got = pack.add_system(d, w, name)
        if got:
            out[kind] = [got]
    ok = sorted((m for m in pack.meshes.values() if m["i"] is not None), key=lambda m: m["i"])
    remap = {m["i"]: m0 + k for k, m in enumerate(ok)}
    for name, sy in pack.systems.items():
        if not sy:
            continue
        for e in sy["emitters"]:
            if isinstance(e.get("primitive"), dict) and e["primitive"].get("mesh") is not None:
                e["primitive"]["mesh"] = remap[e["primitive"]["mesh"]]
        fx["systems"][name] = sy
    fx["meshes"] += [{k: v for k, v in m.items() if k != "i"} for m in ok]
    fx["global"] = out
    new = sorted((t for t in pack.textures.values() if t.get("i") is not None and t["i"] >= n0), key=lambda t: t["i"])
    for t in new:
        fx["textures"].append([t["w"], t["h"]])
        ix[str(t["i"])] = t["src"]
    with open(fxp, "w", encoding="utf-8") as f:
        json.dump(fx, f, ensure_ascii=False, separators=(",", ":"))
    with open(ixp, "w", encoding="utf-8") as f:
        json.dump(ix, f, ensure_ascii=False, indent=0)
    print("공용 이펙트", out, "새 텍스처", len(new))


def add_global_sfx(vgm):
    """챔피언 스킬이 아닌 소리(lol_sfx.GLOBAL: 소환사 주문·레벨 업·사망·보호막 깨짐 …) 를 sfx.json 의 global·events 에 더한다"""
    p = os.path.join(ls.OUT, "sfx.json")
    j = json.load(open(p, encoding="utf-8"))
    w = cm.Wad(ls.COMMON_WAD)
    banks = {}
    out = {}
    for kind, (bank, events) in ls.GLOBAL.items():
        if bank not in banks:
            base = "assets/sounds/wwise2016/sfx/shared/%s_" % bank
            banks[bank] = ls.Bank(w.read(base + "events.bnk"), w.read(base + "audio.bnk"))
        b = banks[bank]
        for ev in events:
            if ev in j["events"]:
                continue
            layers = []
            for li, alts in enumerate(b.event(ev)[:ls.LAYERS]):
                files = []
                for wid in alts[:ls.VARIANTS]:
                    try:
                        data, sr = ls.decode(vgm, b.wems[wid])
                    except (subprocess.CalledProcessError, RuntimeError):
                        continue
                    if len(data) < sr * 0.03:
                        continue
                    name = "%s_%d%s.ogg" % (ev.lower(), li, "abc"[len(files)])
                    ls.save(os.path.join(ls.OUT, name), data, sr)
                    files.append(name)
                if files:
                    layers.append(files)
            if layers:
                j["events"][ev] = layers
            print("공용 소리", kind, ev, [len(x) for x in layers], flush=True)
        got = [e for e in events if e in j["events"]]
        if got:
            out[kind] = got
    j["global"] = out
    with open(p, "w", encoding="utf-8") as fo:
        json.dump(j, fo, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("champions", nargs="*")
    ap.add_argument("--vgmstream", help="vgmstream-cli.exe 경로(없으면 소리는 건너뛴다)")
    ap.add_argument("--enemy", nargs="+", help="챔피언 대신 적 스킬(lol_vfx.SKILLS 의 이름, 예: \"요네 Q3\") 을 더한다")
    ap.add_argument("--global", dest="glob", action="store_true", help="공용 소리(lol_sfx.GLOBAL: 소환사 주문·레벨 업 …) 를 더한다")
    a = ap.parse_args()
    if a.glob:
        add_global_vfx()
        if a.vgmstream:
            add_global_sfx(a.vgmstream)
        return
    if a.enemy:
        add_enemy_vfx(a.enemy)
        if a.vgmstream:
            add_enemy_sfx(a.enemy, a.vgmstream)
        return
    champs = [c.lower() for c in a.champions] or [c for c, v in cm.NEW21.items() if v]
    add_vfx(champs)
    if a.vgmstream:
        add_sfx(champs, a.vgmstream)


if __name__ == "__main__":
    main()
