"""귀환키로 작은 창을 미리 띄우고, 귀환이 끊기면 내린다.

롤 창이 맨 앞일 때만 키가 눌렸는지 읽는다(GetAsyncKeyState, 읽기만: 게임에 키를 보내거나 무엇을 바꾸지 않는다).
키는 롤 설정(Config/input.ini) 대로: 귀환 evtUseItem7(기본 b), 끊는 키는 이동(evtPlayerMoveClick, 기본 오른쪽 클릭)·
스킬(evtCastSpell1~4)·소환사 주문(evtCastAvatarSpell1~2)·아이템(evtUseItem1~6).
귀환이 끊긴 것: 끊는 키를 누름, 체력이 깎임(맞으면 끊긴다), 귀환 시간(8초) + 여유가 지나도 우물에 오지 않음.
우물에 오면 shop_watch 가 이어받는다.
"""
import os
import re
import sys
import time

RECALL_SECONDS = 8.0
MARGIN = 1.5                # 귀환이 끝나고 우물 감지(0.5초마다) 가 잡을 때까지

VK = {"button 1": 0x01, "button 2": 0x02, "button 3": 0x04, "button 4": 0x05, "button 5": 0x06,
      "space": 0x20, "tab": 0x09, "return": 0x0D, "enter": 0x0D}
for _i in range(1, 13):
    VK["f%d" % _i] = 0x6F + _i
DEFAULT = {"recall": [ord("B")], "cancel": [0x02] + [ord(c) for c in "QWERDF123567"]}


def _vk(name):
    """input.ini 의 키 이름 하나 → 가상 키 코드(모르면 None)."""
    n = name.strip().lower()
    if n in VK:
        return VK[n]
    if len(n) == 1 and (n.isalnum()):
        return ord(n.upper())
    return None


def _keys(value):
    """'[b]' · '[Shift][q],[x]' → 마지막 키들([b] · [q, x]). 조합키는 마지막 키만 본다."""
    out = []
    for combo in value.split(","):
        parts = re.findall(r"\[([^\]]+)\]", combo)
        k = _vk(parts[-1]) if parts else None
        if k is not None:
            out.append(k)
    return out


def load_keys(game_dir=None):
    """롤 설정 → {recall: [키], cancel: [키]}. 못 읽으면 기본값."""
    path = os.path.join(game_dir or r"C:\Riot Games\League of Legends", "Config", "input.ini")
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return {k: list(v) for k, v in DEFAULT.items()}
    ev = dict(re.findall(r"^(evt\w+)=(.*)$", text, re.M))
    recall = _keys(ev.get("evtUseItem7", "")) or list(DEFAULT["recall"])
    cancel = []
    for name in (["evtPlayerMoveClick"] + ["evtCastSpell%d" % i for i in range(1, 5)]
                 + ["evtCastAvatarSpell1", "evtCastAvatarSpell2"] + ["evtUseItem%d" % i for i in range(1, 7)]):
        cancel += _keys(ev.get(name, ""))
    if not ev.get("evtPlayerMoveClick"):
        cancel.append(0x02)
    return {"recall": recall, "cancel": [k for k in dict.fromkeys(cancel) if k not in recall]}


class RecallWatch:
    """키 눌림(새로 눌린 것만) 과 체력으로 '귀환 중' 을 정한다. 시간은 time.monotonic 기준."""

    def __init__(self, keys):
        self.keys = keys
        self.since = None           # 귀환을 시작한 때
        self.hp = None
        self.reason = ""

    def press(self, vk, now):
        if vk in self.keys["recall"]:
            self.since, self.hp, self.reason = now, None, "귀환키"
        elif vk in self.keys["cancel"] and self.since is not None:
            self.since, self.reason = None, "귀환 끊김(키)"

    def health(self, hp, now):
        """체력이 깎이면 귀환이 끊긴다."""
        if self.since is None:
            return
        if self.hp is not None and hp < self.hp - 1:
            self.since, self.reason = None, "귀환 끊김(맞음)"
        self.hp = hp

    def active(self, now):
        if self.since is not None and now - self.since > RECALL_SECONDS + MARGIN:
            self.since, self.reason = None, "귀환 끊김(시간)"
        return self.since is not None

    def clear(self):
        self.since, self.hp = None, None


def lol_foreground():
    """롤 게임 창(RiotWindowClass) 이 맨 앞인가."""
    if not sys.platform.startswith("win"):
        return False
    import ctypes
    from ctypes import wintypes as W
    u = ctypes.WinDLL("user32")
    u.GetForegroundWindow.restype = W.HWND
    u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
    buf = ctypes.create_unicode_buffer(64)
    h = u.GetForegroundWindow()
    return bool(h) and u.GetClassNameW(h, buf, 64) > 0 and buf.value == "RiotWindowClass"


def _async_key():
    import ctypes
    u = ctypes.WinDLL("user32")
    u.GetAsyncKeyState.restype = ctypes.c_short
    return lambda k: bool(u.GetAsyncKeyState(k) & 0x8000)


def key_loop(watch, stop=lambda: False, period=0.025, is_down=None, foreground=None):
    """롤 창이 맨 앞일 때 귀환키·끊는 키가 새로 눌렸는지 period 초마다 본다(Windows).
    is_down·foreground: 시험에서 바꿔 끼운다(진짜 키를 보내면 사용자 창에 입력되니)."""
    if is_down is None:
        if not sys.platform.startswith("win"):
            return
        is_down = _async_key()
    foreground = foreground or lol_foreground
    vks = list(dict.fromkeys(watch.keys["recall"] + watch.keys["cancel"]))
    down = {k: False for k in vks}
    while not stop():
        fg = foreground()
        now = time.monotonic()
        for k in vks:
            d = fg and is_down(k)
            if d and not down[k]:
                watch.press(k, now)
            down[k] = d
        time.sleep(period)
