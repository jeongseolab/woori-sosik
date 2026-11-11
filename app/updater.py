"""Tier.gg 앱 자동 업데이트.

앱을 켜면 뒤에서 GitHub 의 가장 최근 app-v* 릴리스를 보고, 지금보다 새 버전이면
  1) 이 OS 의 파일(Tier.gg.exe / Tier.gg.zip) 을 앱 데이터 폴더에 받고
  2) GitHub 이 알려 주는 sha256 과 크기가 맞는지 확인한 뒤(중간에 끊기거나 바뀐 파일은 버린다)
  3) 지금 실행 파일 자리에 새 파일을 넣어 둔다
그다음부터 켜면 새 버전이다. 앱 창에는 "다시 시작하면 바뀌어요" 띠가 뜨고, 누르면 바로 새 버전으로 다시 켠다.
게임 중에 갑자기 꺼지면 안 되니까 스스로 다시 켜지는 않는다.

  Windows: 돌고 있는 exe 는 지울 수 없지만 이름은 바꿀 수 있다. Tier.gg.exe → Tier.gg.exe.old 로 비키고 새 파일을
           Tier.gg.exe 로 넣는다. .old 는 다음에 켤 때 지운다
  macOS:   zip 을 ditto 로 풀고 Tier.gg.app 을 Tier.gg.app.old 로 비킨 뒤 새 .app 을 넣는다.
           다운로드 폴더에서 바로 연 앱(App Translocation, 읽기 전용) 은 바꿀 수 없어서 응용 프로그램 폴더로 옮기라고 알린다

개발 중(python 으로 실행) 에는 바꿀 실행 파일이 없으니 확인만 하고 아무것도 안 한다.
"""
import hashlib
import logging
import os
import shutil
import subprocess
import sys
import threading
import time

log = logging.getLogger("tiergg.update")

REPO = "jeongseolab/woori-sosik"
FEED = "https://api.github.com/repos/%s/releases?per_page=20" % REPO
ASSET = {"win32": "Tier.gg.exe", "darwin": "Tier.gg.zip"}
RECHECK = 6 * 3600              # 오래 켜 두면 6시간마다 다시 본다
UA = "TierGG-App-Updater"


def parse_version(v):
    """'1.2.10' → (1, 2, 10). 숫자가 아니면 None."""
    try:
        return tuple(int(x) for x in str(v).strip().lstrip("v").split("."))
    except ValueError:
        return None


def newer(a, b):
    """a 가 b 보다 새 버전인가."""
    pa, pb = parse_version(a), parse_version(b)
    return pa is not None and pb is not None and pa > pb


def pick_release(releases, platform=None):
    """릴리스 목록(GitHub API) 에서 이 OS 파일이 붙은 가장 새 app-v* → {version, url, size, sha256} 또는 None."""
    name = ASSET.get(platform or sys.platform)
    best = None
    for rel in releases or []:
        tag = str(rel.get("tag_name", ""))
        if rel.get("draft") or rel.get("prerelease") or not tag.startswith("app-v"):
            continue
        ver = tag[5:]
        if parse_version(ver) is None:
            continue
        for a in rel.get("assets") or []:
            if a.get("name") != name:
                continue
            digest = str(a.get("digest") or "")
            cand = {"version": ver, "url": a.get("browser_download_url"), "size": a.get("size"),
                    "sha256": digest[7:] if digest.startswith("sha256:") else None}
            if cand["url"] and (best is None or newer(ver, best["version"])):
                best = cand
    return best


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def target_path(platform=None, executable=None):
    """바꿔 넣을 것: Windows 는 exe, macOS 는 .app 폴더. 못 찾으면 None."""
    platform = platform or sys.platform
    exe = os.path.abspath(executable or sys.executable)
    if platform == "win32":
        return exe if exe.lower().endswith(".exe") else None
    if platform == "darwin":
        # …/Tier.gg.app/Contents/MacOS/Tier.gg
        app = os.path.dirname(os.path.dirname(os.path.dirname(exe)))
        return app if app.endswith(".app") else None
    return None


def cleanup(target):
    """지난번 업데이트에서 비켜 둔 옛 파일을 지운다(그 앱이 다 꺼졌으면 지워진다)."""
    if not target:
        return
    old = target + ".old"
    try:
        if os.path.isdir(old):
            shutil.rmtree(old)
        elif os.path.exists(old):
            os.remove(old)
    except OSError as e:
        log.info("옛 파일은 다음에 지움: %s", e)


def swap_windows(target, new_file):
    """돌고 있는 exe 를 .old 로 비키고 새 exe 를 그 자리에. 중간에 실패하면 원래대로."""
    old = target + ".old"
    if os.path.exists(old):
        os.remove(old)                       # 지난번 것(못 지웠으면 여기서 OSError → 이번엔 포기)
    os.replace(target, old)
    try:
        os.replace(new_file, target)
    except OSError:
        os.replace(old, target)
        raise


def swap_macos(target, new_zip, work):
    """zip 을 풀어 .app 을 바꾼다. ditto 는 .app 안의 권한·링크를 그대로 푼다."""
    unpack = os.path.join(work, "unpacked")
    shutil.rmtree(unpack, ignore_errors=True)
    subprocess.run(["ditto", "-x", "-k", new_zip, unpack], check=True, capture_output=True)
    new_app = os.path.join(unpack, os.path.basename(target))
    if not os.path.isdir(new_app):
        raise OSError("zip 안에 %s 가 없음" % os.path.basename(target))
    old = target + ".old"
    shutil.rmtree(old, ignore_errors=True)
    os.rename(target, old)
    try:
        shutil.move(new_app, target)
    except OSError:
        shutil.rmtree(target, ignore_errors=True)
        os.rename(old, target)
        raise
    # 우리가 직접 받은 파일이라 격리 표시는 없지만, 혹시 붙었으면 뗀다(안 떼면 다음 실행 때 경고)
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", target], capture_output=True)
    shutil.rmtree(unpack, ignore_errors=True)


class Updater:
    """state: idle → checking → (latest | downloading → ready) 또는 error / manual.
    웹(앱 창) 이 Api.update_state() 로 읽어 띠를 그린다."""

    def __init__(self, current, data_dir, feed=None, frozen=None, platform=None, executable=None, http_get=None):
        self.current = current
        self.work = os.path.join(data_dir, "update")
        self.feed = feed or FEED
        self.frozen = getattr(sys, "frozen", False) if frozen is None else frozen
        self.platform = platform or sys.platform
        self.target = target_path(self.platform, executable) if self.frozen else None
        self._get = http_get
        self.lock = threading.Lock()
        self.state = {"state": "idle", "current": current}

    # ── 상태 ─────────────────────────────────────────────
    def _set(self, **kw):
        with self.lock:
            self.state = {"current": self.current, **kw}
        log.info("업데이트 %s", self.state)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    # ── 받기 ─────────────────────────────────────────────
    def _client(self):
        import httpx
        return httpx.Client(timeout=httpx.Timeout(15, read=60), follow_redirects=True, headers={"User-Agent": UA})

    def latest(self):
        if self._get:
            return pick_release(self._get(self.feed), self.platform)
        with self._client() as c:
            r = c.get(self.feed, headers={"Accept": "application/vnd.github+json"})
            r.raise_for_status()
            return pick_release(r.json(), self.platform)

    def download(self, rel, dest):
        part = dest + ".part"
        with self._client() as c, c.stream("GET", rel["url"]) as r:
            r.raise_for_status()
            with open(part, "wb") as f:
                for chunk in r.iter_bytes(1 << 16):
                    f.write(chunk)
        size = os.path.getsize(part)
        if rel.get("size") and size != rel["size"]:
            os.remove(part)
            raise OSError("크기가 다름 %s != %s" % (size, rel["size"]))
        if rel.get("sha256") and sha256_of(part) != rel["sha256"]:
            os.remove(part)
            raise OSError("sha256 이 다름")
        os.replace(part, dest)
        return dest

    # ── 한 번 돌기 ───────────────────────────────────────
    def run_once(self):
        cleanup(self.target)
        if self.state.get("state") == "ready":
            return self.snapshot()
        self._set(state="checking")
        try:
            rel = self.latest()
        except Exception as e:                       # 인터넷이 없거나 GitHub 이 막았거나: 다음에
            log.warning("업데이트 확인 실패: %s", e)
            self._set(state="error", error="확인 실패")
            return self.snapshot()
        if not rel or not newer(rel["version"], self.current):
            self._set(state="latest")
            return self.snapshot()
        if not self.target:                          # 개발 중
            self._set(state="manual", latest=rel["version"], reason="dev", url=rel["url"])
            return self.snapshot()
        if "AppTranslocation" in self.target or not os.access(os.path.dirname(self.target), os.W_OK):
            # macOS 다운로드 폴더에서 바로 연 앱, 또는 쓸 수 없는 폴더(Program Files 등)
            self._set(state="manual", latest=rel["version"], url=rel["url"],
                      reason="translocated" if "AppTranslocation" in self.target else "readonly")
            return self.snapshot()
        self._set(state="downloading", latest=rel["version"])
        try:
            os.makedirs(self.work, exist_ok=True)
            got = self.download(rel, os.path.join(self.work, ASSET[self.platform]))
            if self.platform == "win32":
                swap_windows(self.target, got)
            else:
                swap_macos(self.target, got, self.work)
                os.remove(got)
        except Exception as e:
            log.exception("업데이트 실패")
            self._set(state="error", latest=rel["version"], error=str(e)[:200], url=rel["url"])
            return self.snapshot()
        self._set(state="ready", latest=rel["version"])
        return self.snapshot()

    def start(self):
        """뒤에서 지금 한 번, 그 뒤 RECHECK 마다."""
        def loop():
            time.sleep(3)                            # 첫 화면이 먼저 뜨게
            while True:
                if self.run_once().get("state") == "ready":
                    return
                time.sleep(RECHECK)
        threading.Thread(target=loop, name="updater", daemon=True).start()

    def relaunch(self):
        """새 버전을 띄운다(지금 앱은 부른 쪽이 닫는다). → 띄웠는가"""
        if self.snapshot().get("state") != "ready" or not self.target:
            return False
        # PyInstaller 로 묶은 앱은 환경 변수로 "이미 풀어 둔 폴더" 를 물려준다. 그대로 넘기면 새 버전이 옛 버전의
        # 풀린 폴더를 쓰다가, 옛 앱이 꺼지며 그 폴더를 지울 때 파일이 사라진다. 새로 풀게 한다(PyInstaller 6.9+)
        env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT="1")
        if self.platform == "win32":
            flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            subprocess.Popen([self.target] + sys.argv[1:], creationflags=flags, close_fds=True, cwd=os.path.dirname(self.target), env=env)
        else:
            # -n: 지금 것이 아직 떠 있어도 새로 하나 연다
            subprocess.Popen(["open", "-n", self.target] + (["--args"] + sys.argv[1:] if sys.argv[1:] else []), env=env)
        log.info("새 버전으로 다시 켬 %s", self.target)
        return True
