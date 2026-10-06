"""21.0.0 에 더한 챔피언(champ_models.NEW21) 처럼 내 챔피언을 새로 더할 때, 그 챔피언의 스킬 이펙트·소리만 뽑아 덧붙인다.
lol_vfx.py·lol_sfx.py 를 다시 돌리면 모든 것을 새로 만들지만, 이 도구는 기존 것(텍스처 번호·소리 표) 을 그대로 두고 뒤에 붙인다.

  python lol_add_mine.py --vgmstream <vgmstream-cli.exe> [챔피언 ...]     (챔피언을 비우면 NEW21 에서 스킬이 있는 챔피언 모두)

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
                    names = [n for n in ([sub.add_system(d, w, rmap[k]), tt] for k, tt in keys) if n[0]]
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
        assert t["i"] == len(fx["textures"]), (t["i"], len(fx["textures"]))
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("champions", nargs="*")
    ap.add_argument("--vgmstream", help="vgmstream-cli.exe 경로(없으면 소리는 건너뛴다)")
    a = ap.parse_args()
    champs = [c.lower() for c in a.champions] or [c for c, v in cm.NEW21.items() if v]
    add_vfx(champs)
    if a.vgmstream:
        add_sfx(champs, a.vgmstream)


if __name__ == "__main__":
    main()
