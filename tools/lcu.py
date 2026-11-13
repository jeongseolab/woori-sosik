"""롤 클라이언트(LCU) 와 잇기: 챔프 선택을 읽고, 빌드를 인게임 상점의 "추천" 탭(아이템 세트) 에 넣는다.

오버레이(tools/item_overlay.py) 가 게임 밖(로비·챔프 선택) 에서 쓴다. 내 PC 안에서만 오가는 요청이다.

- 연결: 롤 클라이언트가 켜져 있으면 설치 폴더에 lockfile("LeagueClient:pid:포트:비밀번호:https") 이 생긴다.
  https://127.0.0.1:포트 에 riot:비밀번호 로 묻는다(인증서는 롤이 스스로 만든 것이라 127.0.0.1 에서만 확인을 끈다)
- 챔프 선택: GET /lol-champ-select/v1/session
    localPlayerCellId 로 myTeam 에서 나를 찾는다. championId(확정·선택 중) 가 0 이면 championPickIntent(고민 중)
    assignedPosition: top·jungle·middle·bottom·utility(일반 게임·사용자 설정 게임은 빈 칸 → 라인 모름)
    theirTeam: 상대가 고른 챔피언. 랭크에서는 상대 라인(assignedPosition) 이 비어 있어 맞라인은 모른다
- 아이템 세트: GET/PUT /lol-item-sets/v1/item-sets/{summonerId}/sets (summonerId 는 /lol-summoner/v1/current-summoner)
    통째로 읽고 통째로 쓴다. 우리 세트는 uid 하나(TIERGG_UID) 로만 쓰고, 사용자가 만든 다른 세트는 그대로 둔다.
    세트 모양({uid, title, associatedChampions, associatedMaps, blocks[{type, items[{id: "번호", count}]}]}) 과 주소는
    롤 클라이언트의 아이템 세트 화면(rcp-fe-lol-collections) 이 쓰는 것과 같다
- 라이엇 정책: 아이템 세트를 넣는 것은 OP.GG·Porofessor 같은 앱도 하는 것. 챔프 선택에서 고르기·밴 같은 자동 조작은 하지 않는다
"""
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))   # items·item_context

GAME_DIRS = (r"C:\Riot Games\League of Legends", r"D:\Riot Games\League of Legends",
             "/Applications/League of Legends.app/Contents/LoL")     # macOS
TIERGG_UID = str(uuid.uuid5(uuid.NAMESPACE_URL, "https://tier.gg/item-set"))   # 늘 같은 uid → 덮어쓴다
POSITION = {"top": "top", "jungle": "jungle", "middle": "mid", "mid": "mid", "bottom": "adc",
            "utility": "support", "support": "support"}
LANE_KO = {"top": "탑", "jungle": "정글", "mid": "미드", "adc": "원딜", "support": "서폿"}
SR = 11            # 소환사의 협곡 지도 번호


def parse_lockfile(text):
    """"LeagueClient:1234:54321:비밀번호:https" → (포트, 비밀번호, 프로토콜). 모양이 다르면 None."""
    parts = (text or "").strip().split(":")
    if len(parts) < 5 or not parts[2].isdigit():
        return None
    return int(parts[2]), parts[3], parts[4]


def find_lockfile(game_dir=None):
    for d in ([game_dir] if game_dir else []) + list(GAME_DIRS):
        p = os.path.join(d, "lockfile")
        if os.path.exists(p):
            return p
    return None


class Client:
    def __init__(self, port, password, protocol="https"):
        self.base = "%s://127.0.0.1:%d" % (protocol, port)
        self.auth = "Basic " + base64.b64encode(("riot:" + password).encode()).decode()
        self.ssl = ssl.create_default_context()
        self.ssl.check_hostname = False
        self.ssl.verify_mode = ssl.CERT_NONE         # 롤이 스스로 서명한 인증서. 127.0.0.1 에만 쓴다

    def _req(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Authorization": self.auth, "Accept": "application/json",
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=2, context=self.ssl) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:           # 챔프 선택이 아닐 때 세션 등
                return None
            raise
        return json.loads(raw) if raw else None

    def get(self, path):
        return self._req("GET", path)

    def put(self, path, body):
        return self._req("PUT", path, body)


def connect(game_dir=None):
    """클라이언트가 켜져 있으면 Client, 아니면 None. 클라이언트를 다시 켜면 포트·비밀번호가 바뀌어 매번 읽는다."""
    path = find_lockfile(game_dir)
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            got = parse_lockfile(f.read())
    except OSError:                     # 클라이언트가 쥐고 있어 잠깐 못 읽을 수 있다
        return None
    return Client(*got) if got else None


def read_select(session):
    """챔프 선택 세션 → {champion, lane, locked, allies, enemies, foes}. 아직 챔피언이 없으면 None."""
    if not session:
        return None
    me_cell = session.get("localPlayerCellId")
    mine = session.get("myTeam") or []
    me = next((p for p in mine if p.get("cellId") == me_cell), None)
    if not me:
        return None
    champ = me.get("championId") or me.get("championPickIntent") or 0
    if not champ:
        return None
    lane = POSITION.get((me.get("assignedPosition") or "").lower())
    allies = [{"id": p["championId"]} for p in mine if p is not me and p.get("championId")]
    theirs = session.get("theirTeam") or []
    enemies = [{"id": p["championId"]} for p in theirs if p.get("championId")]
    # 상대 라인이 보이는 판(일부 모드) 이면 맞라인도
    from item_context import LANE_FOES
    foes = [{"id": p["championId"]} for p in theirs if p.get("championId")
            and POSITION.get((p.get("assignedPosition") or "").lower()) in LANE_FOES.get(lane, ())]
    # 확정했는지: 내 pick 행동이 completed
    locked = any(a.get("actorCellId") == me_cell and a.get("type") == "pick" and a.get("completed")
                 for turn in session.get("actions") or [] for a in turn)
    return {"champion": int(champ), "lane": lane, "locked": locked, "allies": allies, "enemies": enemies,
            "foes": foes}


def _block(title, ids, counts=None):
    """아이템 번호 목록 → 블록. 같은 번호는 묶어서 count 로(물약 2개)."""
    seen = {}
    for i in ids:
        seen[i] = seen.get(i, 0) + 1
    return {"type": title, "items": [{"id": str(i), "count": (counts or {}).get(i, n)} for i, n in seen.items()]}


def parts_path(item_id, items):
    """완성템 → 사는 순서의 하위템(하위템의 하위템부터). 몰락한 왕의 검 → 롱소드, 흡혈의 낫, 단검, 곡선 활, 곡괭이"""
    out = []
    for c in (items.get(item_id) or {}).get("from") or ():
        out += parts_path(c, items)
        out.append(c)
    return out


def make_item_set(champion_id, lane, plan, tree=None, parts=(), title=None):
    """빌드 → 아이템 세트. plan: items.plan_build 결과, tree: OP.GG 템트리(시작템·다른 후보), parts: [(번호, 이유)].

    블록(상점 추천 탭에 위에서부터): 시작 아이템 / 빌드 순서 / 상황 하위템 / 다른 후보 / 소모품
    """
    import items as I
    d = I.data()
    known = set(d["items"]) | set(d["consumables"])
    champ = d["champions"][int(champion_id)]
    blocks = []
    starter = [i for i in (tree or {}).get("starter") or () if i in known]
    if starter:
        blocks.append(_block("시작 아이템", starter))
    reasons = {p["id"]: p["note"] for p in plan.get("picks") or ()}
    build = [i for i in plan["items"] if i in known]
    blocks.append(_block("빌드 순서 (Tier.gg%s)" % (" · OP.GG 코어" if plan.get("source") == "opgg" else ""), build))
    # 앞 완성템 셋(신발 빼고) 의 하위템을 사는 순서로. 상점 추천 탭은 완성템만 보여서 귀환 때 단검·롱소드부터 무엇을 살지 몰랐다
    core = [i for i in build if (d["items"][i].get("from") and "Boots" not in (d["items"][i].get("tags") or ()))][:3]
    for k, i in enumerate(core):
        path = [c for c in parts_path(i, d["items"]) if c in known]
        if path:
            blocks.append(_block("%d번째 %s 하위템 (이 순서로)" % (k + 1, d["items"][i]["name"]), path))
    if parts:
        blocks.append(_block("상황: 먼저 올릴 하위템 (%s)" % ", ".join(sorted({r for _, r in parts})),
                             [p for p, _ in parts if p in known]))
    alts = []
    for k in ("fourth", "fifth", "sixth"):
        for i, _ in (tree or {}).get(k) or ():
            if i in known and i not in build and i not in alts:
                alts.append(i)
    if alts:
        blocks.append(_block("다른 후보 (OP.GG 4~6번째)", alts))
    cons = [i for i in (2055, 2003) if i in known]
    if cons:
        blocks.append(_block("소모품", cons))
    swapped = [d["items"][i]["name"] for i, n in reasons.items() if n and i in d["items"]]
    name = title or "Tier.gg · %s %s" % (champ["name"], LANE_KO.get(lane, ""))
    return {"uid": TIERGG_UID, "title": name.strip()[:75], "associatedChampions": [int(champion_id)],
            "associatedMaps": [SR], "blocks": blocks, "map": "any", "mode": "any", "type": "custom",
            "sortrank": 0, "priority": False, "isGlobalForMaps": False, "isGlobalForChampions": False,
            "preferredItemSlots": [], "_swapped": swapped}


def merge_sets(current, item_set):
    """지금 세트 묶음(GET 결과) 에 우리 세트를 넣는다. 예전 우리 세트(같은 uid) 만 바꾸고 나머지는 그대로."""
    cur = dict(current or {})
    sets = [s for s in cur.get("itemSets") or [] if s.get("uid") != TIERGG_UID]
    clean = {k: v for k, v in item_set.items() if not k.startswith("_")}
    cur["itemSets"] = [clean] + sets          # 맨 앞(추천 탭에서 먼저 보이게)
    cur["timestamp"] = int(time.time() * 1000)
    return cur


def push_item_set(client, item_set):
    """클라이언트에 우리 세트를 저장한다. → summonerId. 실패하면 예외."""
    me = client.get("/lol-summoner/v1/current-summoner") or {}
    sid = me.get("summonerId")
    if not sid:
        raise RuntimeError("소환사 정보를 못 받았어요(로그인 전?)")
    path = "/lol-item-sets/v1/item-sets/%d/sets" % sid
    client.put(path, merge_sets(client.get(path), item_set))
    return sid


def remove_item_set(client):
    """우리 세트만 지운다(python tools/item_overlay.py --remove-itemset)."""
    me = client.get("/lol-summoner/v1/current-summoner") or {}
    sid = me.get("summonerId")
    if not sid:
        return False
    path = "/lol-item-sets/v1/item-sets/%d/sets" % sid
    cur = dict(client.get(path) or {})
    before = len(cur.get("itemSets") or [])
    cur["itemSets"] = [s for s in cur.get("itemSets") or [] if s.get("uid") != TIERGG_UID]
    if len(cur["itemSets"]) != before:
        cur["timestamp"] = int(time.time() * 1000)
        client.put(path, cur)
    return len(cur["itemSets"]) != before
