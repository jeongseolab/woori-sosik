"""롤 클라이언트의 PROP bin(ritobin) 을 읽어 이름 붙은 dict 로 바꾼다. 개발자 PC 에서만 쓰는 도구(lol_vfx.py·lol_sfx.py 가 쓴다).

bin 안의 이름(필드·타입·항목·링크) 은 FNV-1a(소문자) 해시라서, CommunityDragon 이 모아 둔 해시 사전
(https://raw.communitydragon.org/data/hashes/lol/hashes.{binfields,bintypes,binentries,binhashes}.txt) 으로 되돌린다.
사전은 처음 쓸 때 tools/.cache/ 에 받아 둔다(저장소에는 넣지 않는다).
"""
import os
import struct
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
HASHES = "https://raw.communitydragon.org/data/hashes/lol/hashes.%s.txt"
_names = {}


def fnv1a(s):
    h = 0x811c9dc5
    for c in s.lower().encode():
        h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
    return h


def names(kind):
    """kind: binfields·bintypes·binentries·binhashes → {해시: 이름}"""
    if kind not in _names:
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, "hashes.%s.txt" % kind)
        if not os.path.exists(path):
            req = urllib.request.Request(HASHES % kind, headers={"User-Agent": "tiergg-tools/1.0"})
            with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
                f.write(r.read())
        d = {}
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                h, _, n = line.rstrip("\n").partition(" ")
                if n:
                    d[int(h, 16)] = n
        _names[kind] = d
    return _names[kind]


class _R:
    def __init__(self, d):
        self.d, self.p = d, 0

    def u(self, f):
        v = struct.unpack_from("<" + f, self.d, self.p)
        self.p += struct.calcsize("<" + f)
        return v if len(v) > 1 else v[0]

    def string(self):
        n = self.u("H")
        v = self.d[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return v


# 롤 bin 의 값 종류(새 번호. 옛 bin 은 18 이후 번호가 다르지만 지금 클라이언트는 모두 새 번호)
_SIMPLE = {1: "B", 2: "b", 3: "B", 4: "h", 5: "H", 6: "i", 7: "I", 8: "q", 9: "Q", 10: "f",
           11: "2f", 12: "3f", 13: "4f", 14: "16f", 15: "4B"}


class Bin:
    def __init__(self):
        self.F, self.T, self.E, self.H = names("binfields"), names("bintypes"), names("binentries"), names("binhashes")

    def _value(self, r, t):
        if t == 0:
            return None
        if t in _SIMPLE:
            v = r.u(_SIMPLE[t])
            if t == 1:
                return bool(v)
            return list(v) if isinstance(v, tuple) else v
        if t == 16:
            return r.string()
        if t == 17:      # hash
            h = r.u("I")
            return self.H.get(h, "{%08x}" % h)
        if t == 18:      # file(xxh64)
            return "{%016x}" % r.u("Q")
        if t in (0x80, 0x81):          # list, list2
            et = r.u("B"); r.u("I"); n = r.u("I")
            return [self._value(r, et) for _ in range(n)]
        if t in (0x82, 0x83):          # pointer, embed
            h = r.u("I")
            if h == 0:
                return None
            r.u("I"); n = r.u("H")
            o = {"__type": self.T.get(h, "{%08x}" % h)}
            for _ in range(n):
                fh = r.u("I"); ft = r.u("B")
                o[self.F.get(fh, "{%08x}" % fh)] = self._value(r, ft)
            return o
        if t == 0x84:    # link
            h = r.u("I")
            return self.E.get(h, "{%08x}" % h)
        if t == 0x85:    # option
            et = r.u("B"); n = r.u("B")
            return self._value(r, et) if n else None
        if t == 0x86:    # map
            kt = r.u("B"); vt = r.u("B"); r.u("I"); n = r.u("I")
            out = {}
            for _ in range(n):
                k = self._value(r, kt)
                out[str(k)] = self._value(r, vt)
            return out
        if t == 0x87:    # flag
            return bool(r.u("B"))
        raise ValueError("모르는 값 종류 %d (자리 %d)" % (t, r.p))

    def parse(self, data):
        """bin 바이트 → ({항목 이름: dict}, [링크된 bin 경로])"""
        r = _R(data)
        if data[:4] == b"PTCH":
            r.p = 16
        assert data[r.p:r.p + 4] == b"PROP", data[:4]
        r.p += 4
        ver = r.u("I")
        links = [r.string() for _ in range(r.u("I"))] if ver >= 2 else []
        types = [r.u("I") for _ in range(r.u("I"))]
        out = {}
        for ty in types:
            size = r.u("I"); start = r.p
            h = r.u("I"); n = r.u("H")
            o = {"__type": self.T.get(ty, "{%08x}" % ty)}
            try:
                for _ in range(n):
                    fh = r.u("I"); ft = r.u("B")
                    o[self.F.get(fh, "{%08x}" % fh)] = self._value(r, ft)
            except (ValueError, struct.error) as e:
                o["__err"] = str(e)
            r.p = start + size
            out[self.E.get(h, "{%08x}" % h)] = o
        return out, links
