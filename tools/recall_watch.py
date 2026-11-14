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
        self.blocked = ""           # 키를 못 읽는 이유(롤이 관리자 권한). 작은 창에 보여 준다

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


def foreground_class():
    """맨 앞 창의 클래스 이름(Windows). 없으면 ""."""
    if not sys.platform.startswith("win"):
        return ""
    import ctypes
    from ctypes import wintypes as W
    u = ctypes.WinDLL("user32")
    u.GetForegroundWindow.restype = W.HWND
    u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
    buf = ctypes.create_unicode_buffer(64)
    h = u.GetForegroundWindow()
    return buf.value if h and u.GetClassNameW(h, buf, 64) > 0 else ""


def lol_foreground():
    """롤 게임 창(RiotWindowClass) 이 맨 앞인가."""
    return foreground_class() == "RiotWindowClass"


def _integrity(pid=None):
    """프로세스 무결성 수준(0x2000 보통, 0x3000 높음=관리자). pid 없으면 이 프로세스. 모르면 None."""
    import ctypes
    from ctypes import wintypes as W
    k, a = ctypes.WinDLL("kernel32"), ctypes.WinDLL("advapi32")
    k.OpenProcess.restype = W.HANDLE
    k.GetCurrentProcess.restype = W.HANDLE
    a.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, ctypes.POINTER(W.HANDLE)]
    a.GetTokenInformation.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD)]
    a.GetSidSubAuthorityCount.argtypes, a.GetSidSubAuthorityCount.restype = [ctypes.c_void_p], ctypes.POINTER(ctypes.c_ubyte)
    a.GetSidSubAuthority.argtypes, a.GetSidSubAuthority.restype = [ctypes.c_void_p, W.DWORD], ctypes.POINTER(W.DWORD)
    h = k.GetCurrentProcess() if pid is None else k.OpenProcess(0x1000, False, int(pid))
    if not h:
        return None
    t = W.HANDLE()
    try:
        if not a.OpenProcessToken(h, 0x0008, ctypes.byref(t)):
            return None
        n = W.DWORD()
        a.GetTokenInformation(t, 25, None, 0, ctypes.byref(n))          # TokenIntegrityLevel
        buf = ctypes.create_string_buffer(n.value)
        if not a.GetTokenInformation(t, 25, buf, n, ctypes.byref(n)):
            return None
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        return a.GetSidSubAuthority(sid, a.GetSidSubAuthorityCount(sid)[0] - 1)[0]
    finally:
        if t:
            k.CloseHandle(t)
        if pid is not None:
            k.CloseHandle(h)


BLOCKED = ("롤이 관리자 권한으로 켜져 있어 귀환키를 못 읽어요. "
           "Riot Client 를 그냥(관리자 권한 없이) 다시 켜거나, Tier.gg 를 관리자 권한으로 켜 주세요")


def blocked_by_admin():
    """맨 앞 롤 창이 이 프로세스보다 높은 권한(관리자) 인가. 그러면 Windows(UIPI) 가 키 읽기를 막는다
    (2026-11-14: Riot Client 를 관리자 권한으로 켠 판에서 귀환키가 하나도 안 잡혔다)."""
    if not sys.platform.startswith("win"):
        return False
    import ctypes
    from ctypes import wintypes as W
    u = ctypes.WinDLL("user32")
    u.GetForegroundWindow.restype = W.HWND
    u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
    pid = W.DWORD()
    u.GetWindowThreadProcessId(u.GetForegroundWindow(), ctypes.byref(pid))
    theirs, mine = _integrity(pid.value), _integrity()
    return bool(theirs and mine and theirs > mine)


def _async_key():
    import ctypes
    u = ctypes.WinDLL("user32")
    u.GetAsyncKeyState.restype = ctypes.c_short
    return lambda k: bool(u.GetAsyncKeyState(k) & 0x8000)


def key_loop(watch, stop=lambda: False, period=0.025, is_down=None, foreground=None, log=None, check_admin=None):
    """롤 창이 맨 앞일 때 귀환키·끊는 키가 새로 눌렸는지 period 초마다 본다(Windows).
    is_down·foreground: 시험에서 바꿔 끼운다(진짜 키를 보내면 사용자 창에 입력되니).
    log(글): 시작·오류·롤이 앞이 아니라 귀환키를 무시한 것을 적는다(작은 창은 콘솔이 없어 오류가 안 보인다)."""
    log = log or (lambda msg: None)
    if check_admin is None:
        check_admin = is_down is None                    # 시험(가짜 키) 에서는 권한을 보지 않는다
    if is_down is None:
        if not sys.platform.startswith("win"):
            return
        is_down = _async_key()
    foreground = foreground or lol_foreground
    vks = list(dict.fromkeys(watch.keys["recall"] + watch.keys["cancel"]))
    down = {k: False for k in vks}
    raw = {k: False for k in watch.keys["recall"]}      # 롤이 앞이 아니어도 눌림(무시한 것을 적으려고)
    log("귀환키 감지 시작: 귀환 %s, 끊는 키 %d개" % ([hex(k) for k in watch.keys["recall"]], len(watch.keys["cancel"])))
    was_fg, checked = False, 0.0
    while not stop():
        try:
            fg = foreground()
            # 롤 창이 앞으로 올 때(그리고 30초마다) 롤이 관리자 권한인지 본다
            if fg and check_admin and (not was_fg or time.monotonic() - checked > 30):
                checked = time.monotonic()
                b = blocked_by_admin()
                if b != bool(watch.blocked):
                    watch.blocked = BLOCKED if b else ""
                    log(BLOCKED if b else "롤 권한 문제 없음: 귀환키를 읽을 수 있어요")
            was_fg = fg
            now = time.monotonic()
            for k in vks:
                d = fg and is_down(k)
                if d and not down[k]:
                    watch.press(k, now)
                down[k] = d
            for k in raw:
                d = is_down(k)
                if d and not raw[k] and not fg:
                    log("귀환키를 눌렀지만 롤이 맨 앞이 아니라 무시(맨 앞: %s)" % (foreground_class() or "없음"))
                raw[k] = d
        except Exception as e:                           # 스레드가 죽으면 귀환키가 영영 안 잡힌다. 적고 계속
            log("귀환키 감지 오류: %r" % e)
            time.sleep(1)
        time.sleep(period)
