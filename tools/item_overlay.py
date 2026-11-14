"""게임 중 롤 화면 위에 "지금 살 것" 을 띄우는 작은 창. 내 PC 에서 롤을 켠 채로 돌린다(서버는 필요 없다).

  python tools/item_overlay.py            # 창으로 띄우기
  python tools/item_overlay.py --text     # 창 없이 콘솔에 글로(창이 안 뜨는 PC·확인용)
  python tools/item_overlay.py --demo     # 롤 없이 가짜 게임(징크스, 1400골드, 롱소드) 으로 보기

- 롤이 게임 중에 켜 두는 Live Client Data API(https://127.0.0.1:2999/liveclientdata/allgamedata) 를 2초마다 읽는다.
  내 PC 안에서만 열리는 주소라 인터넷으로 나가는 것은 없다. 인증서가 롤이 스스로 만든 것이라 확인은 끈다(127.0.0.1 만)
- 내 챔피언·라인으로 OP.GG 템트리(item_tree.fetch, 12시간 저장) 를 받아 items.plan_build 로 6칸 빌드를 정하고,
  가방·골드·상황으로 items.plan_buy(이번 귀환에 살 하위템 묶음, dp + 완전 탐색) 를 부른다.
  OP.GG 에 닿지 않으면 스탯 값만으로 짠 빌드(recommend) 로 대신한다
- 게임 전(챔프 선택): 롤 클라이언트(tools/lcu.py) 에서 내 픽·라인·양 팀을 읽어 빌드를 정하고 상점 "추천" 탭에
  "Tier.gg · 챔피언 라인" 세트로 넣는다(전체 화면에서도 상점에 보인다). --no-itemset 으로 끄고, --remove-itemset 으로 지운다
- 창: 테두리 없이 늘 위, 조금 투명. 끌어서 옮기고, 오른쪽 클릭으로 닫는다.
  롤을 "전체 화면" 으로 켜면 다른 창이 위에 못 뜬다. 롤 설정 → 비디오 → 창 모드를 "테두리 없음" 으로
- 라이엇 정책: 아이템 추천처럼 누구나 볼 수 있는 정보를 보여 주는 것은 허용(Porofessor 등과 같은 종류).
  적의 쿨타임·보이지 않는 정보는 다루지 않는다
"""
import argparse
import json
import os
import ssl
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import item_context as X  # noqa: E402
import item_tree as T  # noqa: E402
import recall_watch  # noqa: E402
import shop_watch  # noqa: E402
import items as I  # noqa: E402
import lcu as L  # noqa: E402

LIVE = "https://127.0.0.1:2999/liveclientdata/allgamedata"
POLL = 2.0
# 아이콘은 items.py 가 읽는 자료 옆에 있다(앱으로 묶어도 같은 자리)
ICONS = os.path.join(os.path.dirname(I.DATA_PATH), "icons")
APP_NAME = "Tier.gg"
# Tier.gg 앱(app/tiergg_app.py) 이 이 창을 따로 띄울 때 넘겨준다.
#   STATUS_FILE: 지금 보여 주는 것을 JSON 으로 남긴다(앱 창의 "아이템 추천" 탭이 읽는다)
#   PARENT_PID: 앱 창 프로세스. 그게 꺼지면 이 창도 끈다(한 파일 exe 는 끄라고 해도 자식이 남을 수 있다)
STATUS_FILE = None
PARENT_PID = None
# 작은 창의 "−" 로 숨겼는가. 숨겨도 챔프 선택 → 상점 추천 탭 넣기는 그대로 한다(창만 안 보인다).
# 다시 보이기: 앱 창을 맨 앞으로 가져오면 앱이 STATUS_FILE + ".show" 를 만든다(show_requested), 또는 챔프 선택·게임이 시작될 때
HIDDEN = False


def show_file():
    return STATUS_FILE + ".show" if STATUS_FILE else None


def show_requested():
    """앱이 다시 보이라고 했으면 그 표시를 지우고 True."""
    f = show_file()
    if not f or not os.path.exists(f):
        return False
    try:
        os.remove(f)
    except OSError:
        pass
    return True


def _pid_alive(pid):
    if sys.platform.startswith("win"):
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))         # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259               # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def parent_gone():
    return bool(PARENT_PID) and not _pid_alive(PARENT_PID)


def status_of(a):
    """보여 주는 것(advise·Watcher 결과) → 앱 창에 넘길 dict."""
    if a is None or isinstance(a, str):
        return {"mode": "wait", "text": a or "불러오는 중이에요"}
    items = I.data()["items"]
    base = {"champion": a["champion"], "lane": a.get("lane"), "build": list(a.get("build") or []),
            "reasons": list(a.get("reasons") or [])[:4], "source": a.get("source")}
    if a.get("mode") == "select":
        return {**base, "mode": "select", "locked": a.get("locked"), "status": a.get("status"),
                "parts": [[p, r] for p, r in a.get("parts") or []],
                "text": "챔프 선택 · %s" % a["champion"]}
    return {**base, "mode": "game", "gold": a.get("gold"), "time": a.get("time"),
            "buy": [{"id": b["id"], "name": b["name"], "cost": b["cost"], "toward": b["toward"]} for b in a["buy"]],
            "sell": [x["name"] for x in a.get("sell") or []], "situation": _situation(a),
            "owned": [i for i in a.get("build") or [] if i in (a.get("owned") or ())],
            "text": "%s · %s골드" % (a["champion"], format(a["gold"], ","))}


_last_status = None


def write_status(a):
    global _last_status
    if not STATUS_FILE:
        return
    st = {**status_of(a), "hidden": HIDDEN}
    if st == _last_status:
        return
    _last_status = st
    try:
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({**st, "at": time.time()}, f, ensure_ascii=False)
        os.replace(tmp, STATUS_FILE)
    except OSError:
        pass

def _demo_player(rid, raw, name, pos, team, items, k, d, cs, lv):
    return {"riotId": rid, "rawChampionName": "game_character_displayname_" + raw, "championName": name,
            "position": pos, "team": team, "level": lv, "items": [{"itemID": i} for i in items],
            "scores": {"kills": k, "deaths": d, "assists": 0, "creepScore": cs}}


# 롤 없이 보기: 9분, 징크스가 라인전에서 조금 밀리고(0/2, CS -18), 적은 AD 암살자 + 회복형
DEMO = {
    "activePlayer": {"currentGold": 1400.0, "riotId": "테스터#KR1"},
    "allPlayers": [
        _demo_player("테스터#KR1", "Jinx", "징크스", "BOTTOM", "ORDER", [1055, 1036, 3340], 0, 2, 62, 7),
        _demo_player("a#1", "Leona", "레오나", "UTILITY", "ORDER", [3876], 0, 1, 8, 6),
        _demo_player("a#2", "Ahri", "아리", "MIDDLE", "ORDER", [1056, 3802], 1, 1, 75, 8),
        _demo_player("a#3", "LeeSin", "리 신", "JUNGLE", "ORDER", [1102, 3134], 1, 0, 50, 7),
        _demo_player("a#4", "Garen", "가렌", "TOP", "ORDER", [1054, 3044], 0, 0, 70, 8),
        _demo_player("e#1", "Draven", "드레이븐", "BOTTOM", "CHAOS", [1055, 1038], 2, 0, 80, 8),
        _demo_player("e#2", "Soraka", "소라카", "UTILITY", "CHAOS", [3877], 0, 0, 10, 6),
        _demo_player("e#3", "Zed", "제드", "MIDDLE", "CHAOS", [1055, 3134], 1, 1, 78, 8),
        _demo_player("e#4", "Khazix", "카직스", "JUNGLE", "CHAOS", [1101, 1036], 1, 0, 52, 7),
        _demo_player("e#5", "Aatrox", "아트록스", "TOP", "CHAOS", [1055, 3044], 0, 0, 72, 8),
    ],
    "gameData": {"mapNumber": 11, "gameTime": 540.0},
}


def fetch_live():
    """게임 중이면 allgamedata(dict), 아니면 None."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE        # 롤이 스스로 서명한 인증서. 127.0.0.1 에만 쓴다
    try:
        with urllib.request.urlopen(LIVE, timeout=1.5, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None


# 작은 창에서 사용자가 고른 내 라인 {"champ": 챔피언 번호, "lane": 라인}. 라인 퀘스트는 어떤 API 에도 안 나와서(롤 Live API·
# 클라이언트 세션 모두 확인, 2026-11-13) 자동으로 고른 라인이 틀리면 사용자가 한 번 눌러 바꾼다. 게임이 끝나면 지운다
LANE_PICK = {}


def shop_sample(game):
    """allgamedata → shop_watch.ShopWatch.update 에 넣을 값. 나를 못 찾으면 None."""
    try:
        ap = game["activePlayer"]
        st = ap["championStats"]
        me = next(p for p in game.get("allPlayers") or [] if p.get("riotId") == ap.get("riotId"))
        return {"t": float(game["gameData"]["gameTime"]), "gold": float(ap.get("currentGold") or 0),
                "hp": float(st["currentHealth"]), "maxhp": float(st["maxHealth"]), "ms": float(st["moveSpeed"]),
                "dead": bool(me.get("isDead")), "items": sorted(int(i["itemID"]) for i in me.get("items") or [])}
    except (KeyError, TypeError, ValueError, StopIteration):
        return None


def advise(game, my_lane=None):
    """게임 자료 → 보여 줄 것(dict). 협곡이 아니거나 나를 못 찾으면 이유(str).

    시간·라인전 상태(맞라이너와 CS·레벨·킬·아이템 비교)·아군과 적 조합은 item_context.from_live 가 읽는다.
    """
    if not game:
        return "게임을 기다리는 중이에요"
    if (game.get("gameData") or {}).get("mapNumber") not in (11, None):
        return "소환사의 협곡에서만 추천해요"
    # 라인 비율은 OP.GG(12시간 들고 있음). 시험·--demo(TREE_OVERRIDE) 에서는 인터넷 없이 역할로 어림
    shares = None if TREE_OVERRIDE is not None else T.lane_shares()
    live = X.from_live(game, my_lane, shares)
    if isinstance(live, str):
        return live
    if LANE_PICK.get("champ") == live["champion"] and LANE_PICK.get("lane"):
        live = X.from_live(game, LANE_PICK["lane"], shares, force=True)
    inventory, gold, cid, lane, ctx = live["inventory"], live["gold"], live["champion"], live["lane"], live["ctx"]
    tree = tree_of(cid, lane)
    plan = I.plan_build(cid, lane, tree, ctx, inventory)
    buy = I.plan_buy(cid, lane, plan["items"], inventory, gold, ctx)
    start = I.starter_buy(cid, lane, tree, inventory, gold, live["t"])
    if start:                       # 게임 시작: 하위템 대신 시작템(탑·미드·원딜은 도란 템)
        buy = {**buy, "buy": start, "sell": [], "reasons": [start[0]["why"]]}
    have = set(inventory)
    return {"champion": I.data()["champions"][cid]["name"], "champion_id": cid, "lane": lane, "gold": gold,
            "lane_picked": LANE_PICK.get("champ") == cid and bool(LANE_PICK.get("lane")),
            "buy": buy["buy"], "sell": buy["sell"], "build": plan["items"],
            "owned": {i for i in plan["items"] if i in have}, "time": live["t"], "source": plan["source"],
            "lane_state": ctx.get("lane"), "opponent": live["opponent"],
            # 이번에 사는 것의 이유(돌아가기 등) 를 먼저, 그다음 빌드·상황 이유
            "reasons": buy["reasons"] + plan["reasons"]}


def tree_of(cid, lane):
    """OP.GG 템트리. --demo·시험에서는 TREE_OVERRIDE 로 바꿔 끼운다(인터넷 없이)."""
    if TREE_OVERRIDE is not None:
        return TREE_OVERRIDE.get((cid, lane))
    return T.fetch(cid, lane)


TREE_OVERRIDE = None


# ── 챔프 선택(롤 클라이언트) ──────────────────────────────
# 게임이 아직 안 열렸을 때: 클라이언트가 챔프 선택 중이면 내 픽·라인·양 팀으로 빌드를 정하고
# 상점 "추천" 탭(아이템 세트) 에 넣는다. 게임이 열리면 클라이언트가 그 세트를 게임에 가지고 들어간다

PHASE_KO = {"None": "로비 밖", "Lobby": "로비", "Matchmaking": "매칭 중", "ReadyCheck": "수락 대기",
            "InProgress": "게임 로딩 중", "WaitingForStats": "결과 기다리는 중", "EndOfGame": "게임 끝"}


class Watcher:
    """부를 때마다 지금 보여 줄 것: 게임 중이면 advise, 아니면 챔프 선택 화면(+ 상점 추천 탭에 넣기), 아니면 기다림 글."""

    def __init__(self, get_game, get_client, push=True):
        self.get_game, self.get_client, self.push = get_game, get_client, push
        self.last_key, self.last_try, self.status = None, 0.0, None
        self.picked = None          # 챔프 선택에서 본 (내 챔피언 번호, 라인). 게임에 들어가면 내 라인을 이것으로

    def __call__(self):
        game = self.get_game()
        if not game:
            LANE_PICK.clear()           # 게임이 끝나면 고른 라인도 지운다
        if game:
            # 챔프 선택 때 본 챔피언으로 들어온 판이면 그때 받은 라인(이전 판의 것이면 안 쓴다)
            lane = None
            if self.picked:
                me = X.from_live(game)
                if isinstance(me, dict) and me["champion"] == self.picked[0]:
                    lane = self.picked[1]
            return advise(game, lane)
        client = self.get_client()
        if client is None:
            return "게임을 기다리는 중이에요"
        try:
            phase = client.get("/lol-gameflow/v1/gameflow-phase")
            if phase != "ChampSelect":
                self.last_key = None          # 다음 챔프 선택에서 다시 넣는다
                return "게임을 기다리는 중이에요 (%s)" % PHASE_KO.get(phase, phase or "클라이언트")
            sel = L.read_select(client.get("/lol-champ-select/v1/session"))
        except Exception:
            return "게임을 기다리는 중이에요"
        if not sel:
            return "챔프 선택: 챔피언을 고르면 빌드를 준비해요"
        return self.select(client, sel)

    def select(self, client, sel):
        cid, lane = sel["champion"], sel["lane"]
        self.picked = (cid, lane) if lane else None
        if cid not in I.data()["champions"]:
            return "모르는 챔피언이에요. tools/lol_items.py 로 자료를 다시 구워 주세요"
        ctx = X.make_context(None, None, sel["allies"], sel["enemies"], sel["foes"])
        tree = tree_of(cid, lane)
        plan = I.plan_build(cid, lane, tree, ctx)
        parts = I.situational_parts(cid, lane, ctx, plan["items"])
        key = (cid, lane, tuple(plan["items"]), tuple(p for p, _ in parts))
        # 픽을 바꾸거나 상대가 고를 때마다 바뀐다. 너무 자주 쓰지 않게 3초에 한 번까지
        if self.push and key != self.last_key and time.time() - self.last_try >= 3:
            self.last_try = time.time()
            try:
                L.push_item_set(client, L.make_item_set(cid, lane, plan, tree, parts))
                self.last_key, self.status = key, "상점 추천 탭에 넣었어요"
            except Exception as e:
                self.status = "상점 추천 탭에 못 넣었어요: %s" % e
        elif not self.push:
            self.status = "상점에 넣기는 꺼 둠(--no-itemset)"
        return {"mode": "select", "champion": I.data()["champions"][cid]["name"], "lane": lane,
                "locked": sel["locked"], "build": plan["items"], "parts": parts, "source": plan["source"],
                "enemies": len(sel["enemies"]), "status": self.status, "reasons": plan["reasons"]}


# 클라이언트 없이 챔프 선택 보기(--demo-select): 징크스 원딜, 상대는 소라카·아트록스 포함 다섯
DEMO_SESSION = {
    "localPlayerCellId": 3,
    "myTeam": [{"cellId": 0, "championId": 86, "assignedPosition": "top"},
               {"cellId": 1, "championId": 64, "assignedPosition": "jungle"},
               {"cellId": 2, "championId": 103, "assignedPosition": "middle"},
               {"cellId": 3, "championId": 222, "assignedPosition": "bottom"},
               {"cellId": 4, "championId": 89, "assignedPosition": "utility"}],
    "theirTeam": [{"cellId": 5, "championId": 266}, {"cellId": 6, "championId": 121}, {"cellId": 7, "championId": 238},
                  {"cellId": 8, "championId": 119}, {"cellId": 9, "championId": 16}],
    "actions": [[{"actorCellId": 3, "type": "pick", "completed": True, "championId": 222}]],
}


class FakeClient:
    """롤 클라이언트 흉내(--demo-select·시험). 넣은 아이템 세트를 들고 있는다."""

    def __init__(self, session=DEMO_SESSION, phase="ChampSelect"):
        self.session, self.phase = session, phase
        self.sets = {"accountId": 1, "itemSets": [{"uid": "mine", "title": "내가 만든 세트", "blocks": []}],
                     "timestamp": 0}
        self.puts = 0

    def get(self, path):
        if path == "/lol-gameflow/v1/gameflow-phase":
            return self.phase
        if path == "/lol-champ-select/v1/session":
            return self.session
        if path == "/lol-summoner/v1/current-summoner":
            return {"summonerId": 42}
        if path == "/lol-item-sets/v1/item-sets/42/sets":
            return json.loads(json.dumps(self.sets))
        return None

    def put(self, path, body):
        assert path == "/lol-item-sets/v1/item-sets/42/sets"
        self.sets, self.puts = body, self.puts + 1


def _situation(a):
    """머리글 아래 한 줄: 내 라인(눌러서 바꾸기) · 시간 · 맞라이너와 비교."""
    parts = [L.LANE_KO.get(a.get("lane"), "라인 모름") + ("" if a.get("lane_picked") else " ▸"),
             "%d:%02d" % (a["time"] // 1, round(a["time"] % 1 * 60) % 60)]
    s = a.get("lane_state")
    if s is not None and a.get("opponent"):
        word = "앞섬" if s > .15 else "밀림" if s < -.15 else "비슷"
        parts.append("vs %s %s(%+.1f)" % (a["opponent"], word, s))
    return " · ".join(parts)


def as_text(a):
    if isinstance(a, str):
        return a
    items = I.data()["items"]
    if a.get("mode") == "select":
        lines = ["챔프 선택 · %s%s%s" % (a["champion"], " (" + a["lane"] + ")" if a["lane"] else " (라인 모름)",
                                      "" if a["locked"] else " · 고민 중"),
                 "  빌드%s: " % ("" if a["source"] == "opgg" else "(OP.GG 없이)")
                 + " / ".join(items[i]["name"] for i in a["build"])]
        if a["parts"]:
            lines.append("  먼저 올릴 하위템: " + ", ".join("%s(%s)" % (items[p]["name"], r) for p, r in a["parts"]))
        if a.get("status"):
            lines.append("  " + a["status"])
        lines += ["  · " + r for r in a.get("reasons") or []]
        return "\n".join(lines)
    lines = ["%s%s · %d골드 · %s" % (a["champion"], " (" + a["lane"] + ")" if a["lane"] else "", a["gold"], _situation(a))]
    if a["buy"]:
        for b in a["buy"]:
            lines.append("  지금 살 것: %s %d골드%s" % (b["name"], b["cost"], " → " + b["toward"] if b["toward"] else ""))
    else:
        lines.append("  지금 골드로는 다음 재료를 못 사요")
    if a.get("sell"):
        lines.append("  칸이 모자라 팔 것: " + ", ".join(s["name"] for s in a["sell"]))
    lines.append("  빌드%s: " % ("" if a.get("source") == "opgg" else "(OP.GG 없이)") + " / ".join(("✓" if i in a["owned"] else "") + items[i]["name"] for i in a["build"]))
    lines += ["  · " + r for r in a.get("reasons") or []]
    return "\n".join(lines)


def run_text(step, once=False):
    last = None
    while True:
        a = step()
        write_status(a)
        text = as_text(a)
        if text != last:
            print(text, flush=True)
            print("-" * 40, flush=True)
            last = text
        if once or parent_gone():
            return
        time.sleep(POLL)


def _no_activate(root):
    """Windows: 작은 창을 눌러도 포커스를 가져가지 않게(게임 창이 포커스를 잃지 않고, "−" 를 눌러도 앱 창이 '맨 앞으로 왔다' 고
    착각하지 않는다). 끌기·누르기는 그대로 된다."""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        u = ctypes.windll.user32
        root.update_idletasks()
        hwnd = u.GetParent(root.winfo_id()) or root.winfo_id()
        GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW = -20, 0x08000000, 0x00000080
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, u.GetWindowLongW(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    except Exception:
        pass


def _keep_top(root):
    """Windows: 맨 위로 다시 올린다(포커스는 안 가져감). 롤 창이 앞으로 오며 맨 위 자리를 가져가면
    -topmost 를 한 번 켠 것만으로는 작은 창이 롤 뒤로 숨었다(창 모드에서 안 보이던 것)."""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        from ctypes import wintypes as W
        u = ctypes.WinDLL("user32")
        u.GetParent.argtypes, u.GetParent.restype = [W.HWND], W.HWND
        # 창 번호를 HWND 로 넘겨야 한다. 그냥 -1 을 넘기면 64비트에서 32비트 정수로 잘려 "잘못된 창"(1400) 으로 실패했다
        u.SetWindowPos.argtypes = [W.HWND, W.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
        hwnd = u.GetParent(root.winfo_id()) or root.winfo_id()
        HWND_TOPMOST, SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = W.HWND(-1), 0x0001, 0x0002, 0x0010
        u.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
    except Exception:
        pass


def run_window(step, sample=None, game_dir=None):
    """sample: 롤 게임 자료를 돌려주는 함수(0.5초마다 불러 상점을 쓸 수 있는지 본다). None 이면(--demo) 상점 따라 띄우기를 안 한다.
    game_dir: 롤 설치 폴더(귀환키 설정 Config/input.ini 를 읽는다)."""
    import tkinter as tk

    root = tk.Tk()
    root.title(APP_NAME)
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.attributes("-alpha", 0.9)
    BG, FG, MUTED, GOLD = "#0f1b33", "#eaf0fa", "#9aabc9", "#f0b429"
    root.configure(bg=BG, highlightthickness=1, highlightbackground=GOLD)
    root.geometry("+%d+%d" % (root.winfo_screenwidth() - 380, 140))
    font = ("Malgun Gothic", 10)

    top = tk.Frame(root, bg=BG)
    top.pack(fill="x")
    head = tk.Label(top, bg=BG, fg=GOLD, font=("Malgun Gothic", 11, "bold"), anchor="w", padx=10, pady=6)
    head.pack(side="left", fill="x", expand=True)
    # "−": 창을 숨긴다(앱 창을 맨 앞으로 가져오면 다시 보인다)
    hide_btn = tk.Label(top, text="−", bg=BG, fg=MUTED, font=("Malgun Gothic", 12, "bold"), padx=10, cursor="hand2")
    hide_btn.pack(side="right", anchor="n")
    hide_btn.bind("<Enter>", lambda e: hide_btn.config(fg=GOLD))
    hide_btn.bind("<Leave>", lambda e: hide_btn.config(fg=MUTED))
    sub = tk.Label(root, bg=BG, fg=MUTED, font=("Malgun Gothic", 9), anchor="w", padx=10)
    sub.pack(fill="x")
    buy_box = tk.Frame(root, bg=BG, padx=10)
    buy_box.pack(fill="x")
    build_box = tk.Frame(root, bg=BG, padx=10, pady=8)
    build_box.pack(fill="x")
    # 왜 이렇게 골랐는지: 이유 세 개까지(게임 화면을 너무 가리지 않게)
    why = tk.Label(root, bg=BG, fg=MUTED, font=("Malgun Gothic", 9), anchor="w", justify="left",
                   padx=10, wraplength=330)
    why.pack(fill="x", pady=(0, 8))
    icons = {}

    def icon(i, size):
        key = (i, size)
        if key not in icons:
            path = os.path.join(ICONS, "%d.png" % i)
            if not os.path.exists(path):
                return None
            img = tk.PhotoImage(file=path)
            icons[key] = img.subsample(64 // size) if size < 64 else img
        return icons[key]

    # 끌어서 옮기기, 오른쪽 클릭으로 닫기
    drag = {}
    root.bind("<ButtonPress-1>", lambda e: drag.update(x=e.x_root - root.winfo_x(), y=e.y_root - root.winfo_y()))
    root.bind("<B1-Motion>", lambda e: root.geometry("+%d+%d" % (e.x_root - drag["x"], e.y_root - drag["y"])))
    root.bind("<Button-3>", lambda e: root.destroy())

    # shop: 지금 상점을 쓸 수 있나(True/False), 게임이 아니거나 모르면 None. shop_was: 앞에서 본 값(바뀌는 순간만 띄우고 내린다)
    state = {"advice": None, "shown": None, "hidden_mode": None, "shop": None, "shop_was": None}
    watch = shop_watch.ShopWatch()
    recall = recall_watch.RecallWatch(recall_watch.load_keys(game_dir))

    def mode_of(a):
        return a.get("mode") if isinstance(a, dict) else "wait"

    def hide(_e=None):
        global HIDDEN
        HIDDEN = True
        state["hidden_mode"] = mode_of(state["advice"])
        root.withdraw()
        write_status(state["advice"])
        return "break"                  # 끌기(ButtonPress-1) 로 넘기지 않는다

    def show():
        global HIDDEN
        HIDDEN = False
        root.deiconify()
        root.attributes("-topmost", True)
        write_status(state["advice"])

    hide_btn.bind("<ButtonPress-1>", hide)

    # 게임 중 둘째 줄(라인 · 시간 · 맞라이너) 을 누르면 내 라인을 다음 라인으로(탑 → 정글 → 미드 → 원딜 → 서폿)
    def pick_lane(_e=None):
        a = state["advice"]
        if not (isinstance(a, dict) and a.get("mode") != "select"):      # 게임 중(advise 의 dict) 만
            return None
        order = list(X.LANES)
        cur = a.get("lane") if a.get("lane") in order else order[-1]
        LANE_PICK.update(champ=a.get("champion_id"), lane=order[(order.index(cur) + 1) % len(order)])
        try:
            state["advice"] = step()            # 바로 다시 계산해서 보여 준다(2초 기다리지 않게)
            write_status(state["advice"])
        except Exception:
            pass
        return "break"                          # 끌기로 넘기지 않는다
    sub.bind("<ButtonPress-1>", pick_lane)
    sub.config(cursor="hand2")
    show_requested()                    # 지난번에 남은 요청은 버린다
    _no_activate(root)

    # 상점: 귀환·부활로 우물에 오거나 죽으면 띄우고, 우물을 나가면 내린다(tools/shop_watch.py). 2초 추천과 따로 0.5초마다
    def shop_loop():
        while sample is not None:
            try:
                g = sample()
                one = shop_sample(g) if g else None
                if not one:
                    recall.clear()
                    state["shop"] = None
                else:
                    in_shop = watch.update(one)
                    if in_shop or one["dead"]:
                        recall.clear()          # 우물에 왔다(귀환 성공) 또는 죽음: 이제 shop_watch 가 정한다
                    else:
                        recall.health(one["hp"], time.monotonic())
                    # 귀환키를 누른 뒤 귀환이 끊기기 전까지도 띄운다(우물에 오기 전에 미리)
                    state["shop"] = in_shop or recall.active(time.monotonic())
            except Exception:
                state["shop"] = None
            time.sleep(0.5)

    def poll():
        while True:
            try:
                state["advice"] = step()
                write_status(state["advice"])
            except Exception as e:          # 창은 살려 두고 이유만 보여 준다
                state["advice"] = "추천을 못 했어요: %s" % e
            time.sleep(POLL)

    def draw():
        global HIDDEN
        # 그리다 오류가 나도(아이콘 파일이 깨졌다든가) 다음 그리기는 꼭 잡는다. 안 그러면 창이 그 자리에 멈춘다
        if parent_gone():               # 앱 창을 닫았다
            root.destroy()
            return
        shop, was = state["shop"], state["shop_was"]
        state["shop_was"] = shop
        if shop is not None and shop != was and was is not None:
            if shop:                    # 상점에 왔다: "−" 로 숨겼어도 다시 띄운다
                show()
            elif not HIDDEN:            # 상점을 나갔다: 내린다(앱 창을 앞으로 가져오면 다시 보인다)
                HIDDEN = True
                state["hidden_mode"] = "game"
                root.withdraw()
                write_status(state["advice"])
        elif shop is not None and was is None and not shop and not HIDDEN and mode_of(state["advice"]) != "select":
            # 게임에 들어와 처음 본 값이 '상점 밖' 이면(앱을 게임 도중에 켬) 내린 채로 시작
            HIDDEN = True
            state["hidden_mode"] = "game"
            root.withdraw()
        if HIDDEN:
            now = mode_of(state["advice"])
            # 앱 창을 맨 앞으로 가져왔거나, 숨길 때와 달리 챔프 선택·게임이 시작됐으면 다시 보인다
            if show_requested() or (now in ("select", "game") and now != state["hidden_mode"]):
                show()
            else:
                root.after(500, draw)
                return
        else:
            show_requested()            # 보이는 중에 온 요청은 버린다
        _keep_top(root)
        try:
            paint()
        except Exception as e:
            head.config(text="그리지 못했어요: %s" % e, fg=MUTED)
        finally:
            root.after(500, draw)

    def paint():
        a = state["advice"]
        key = as_text(a) if a is not None else None
        if key != state["shown"]:
            state["shown"] = key
            for box in (buy_box, build_box):
                for w in box.winfo_children():
                    w.destroy()
            if a is None or isinstance(a, str):
                head.config(text=a or "불러오는 중…", fg=MUTED)
                sub.config(text="")
                why.config(text="")
            elif a.get("mode") == "select":
                head.config(text="챔프 선택 · %s" % a["champion"], fg=GOLD)
                # 상태(상점에 넣었는지) 는 다음 줄에: 한 줄로 이으면 창 폭을 넘어 잘린다
                sub.config(justify="left", text=" · ".join((L.LANE_KO.get(a["lane"], "라인 모름"),
                                                            "확정" if a["locked"] else "고민 중",
                                                            "적 %d명 공개" % a["enemies"]))
                           + ("\n" + a["status"] if a.get("status") else ""))
                why.config(text="\n".join("· " + r for r in (a.get("reasons") or [])[:3]))
                if a["parts"]:
                    tk.Label(buy_box, text="먼저 올릴 하위템", bg=BG, fg=MUTED, font=font).pack(anchor="w")
                    for p, r in a["parts"]:
                        row = tk.Frame(buy_box, bg=BG)
                        row.pack(fill="x", pady=2)
                        tk.Label(row, image=icon(p, 32), bg=BG).pack(side="left")
                        tk.Label(row, text="%s  (%s)" % (I.data()["items"][p]["name"], r), bg=BG, fg=FG,
                                 font=font).pack(side="left", padx=8)
                for i in a["build"]:
                    tk.Label(build_box, image=icon(i, 32), bg=BG, bd=0, padx=1, pady=1).pack(side="left", padx=2)
                root.update_idletasks()
                why.config(wraplength=max(240, build_box.winfo_reqwidth() - 20))
            else:
                head.config(text="%s · %s골드" % (a["champion"], format(a["gold"], ",")), fg=GOLD)
                sub.config(text=_situation(a))
                why.config(text="\n".join("· " + r for r in (a.get("reasons") or [])[:3]))
                if not a["buy"]:
                    tk.Label(buy_box, text="지금 골드로는 다음 재료를 못 사요", bg=BG, fg=MUTED, font=font).pack(anchor="w")
                for b in a["buy"]:
                    row = tk.Frame(buy_box, bg=BG)
                    row.pack(fill="x", pady=2)
                    tk.Label(row, image=icon(b["id"], 32), bg=BG).pack(side="left")
                    label = "%s  %s골드" % (b["name"], format(b["cost"], ","))
                    if b["toward"]:
                        label += "\n→ " + b["toward"]
                    tk.Label(row, text=label, bg=BG, fg=FG, font=font, justify="left").pack(side="left", padx=8)
                if a.get("sell"):
                    tk.Label(buy_box, text="칸이 모자라 팔 것: " + ", ".join(s["name"] for s in a["sell"]),
                             bg=BG, fg=MUTED, font=font).pack(anchor="w")
                for i in a["build"]:
                    tk.Label(build_box, image=icon(i, 32), bg=GOLD if i in a["owned"] else BG, bd=0,
                             padx=1, pady=1).pack(side="left", padx=2)
                # 이유 글은 아이템 줄 폭에서 줄을 바꾼다(창이 글 길이만큼 넓어지지 않게)
                root.update_idletasks()
                why.config(wraplength=max(240, build_box.winfo_reqwidth() - 20))

    threading.Thread(target=poll, daemon=True).start()
    threading.Thread(target=shop_loop, daemon=True).start()
    if sample is not None:
        threading.Thread(target=recall_watch.key_loop, args=(recall,), daemon=True).start()
    draw()
    root.mainloop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", action="store_true", help="창 없이 콘솔에 글로")
    ap.add_argument("--demo", action="store_true", help="롤 없이 가짜 게임으로")
    ap.add_argument("--once", action="store_true", help="(--text) 한 번만 보여 주고 끝")
    ap.add_argument("--demo-select", action="store_true", help="롤 없이 가짜 챔프 선택으로(상점 세트는 가짜 클라이언트에)")
    ap.add_argument("--no-itemset", action="store_true", help="챔프 선택에서 상점 추천 탭에 넣지 않는다")
    ap.add_argument("--remove-itemset", action="store_true", help="넣어 둔 Tier.gg 아이템 세트를 지우고 끝")
    ap.add_argument("--status-file", help="(Tier.gg 앱) 지금 상태를 남길 JSON 파일")
    ap.add_argument("--parent-pid", type=int, help="(Tier.gg 앱) 이 프로세스가 꺼지면 같이 끈다")
    ap.add_argument("--game", help="롤 설치 폴더(lockfile 을 찾을 곳). 기본 C:/Riot Games/League of Legends")
    args = ap.parse_args()
    global STATUS_FILE, PARENT_PID
    STATUS_FILE, PARENT_PID = args.status_file, args.parent_pid
    if args.remove_itemset:
        client = L.connect(args.game)
        print("지웠어요" if client and L.remove_item_set(client) else "지울 세트가 없거나 클라이언트가 꺼져 있어요")
        return
    if args.demo_select:
        fake = FakeClient()
        step = Watcher(lambda: None, lambda: fake, not args.no_itemset)
    else:
        step = Watcher((lambda: DEMO) if args.demo else fetch_live,
                       (lambda: None) if args.demo else (lambda: L.connect(args.game)), not args.no_itemset)
    if args.text:
        run_text(step, args.once)
    else:
        run_window(step, None if (args.demo or args.demo_select) else fetch_live, args.game)


if __name__ == "__main__":
    main()
