"""Tier.gg 앱(Windows·macOS 데스크톱) = Tier.gg 웹의 모든 기능 + 게임 중 아이템 추천.

켜면 두 가지가 같이 돈다
  - 앱 창: Tier.gg 웹(https://tier-gg.onrender.com) 을 그대로 띄운다(pywebview: Windows 는 Edge WebView2, macOS 는 WKWebView).
    티어표·그룹방·듀오·연습장을 웹과 똑같이 쓰고, 로그인은 앱 안에 저장된다. 주소에 ?app=1 을 붙여서
    웹이 "앱 안" 인 줄 알고 아이템 추천 탭을 내려받기 안내 대신 지금 상태 화면으로 바꾼다
  - 작은 창(아이템 추천): tools/item_overlay.py 를 따로 띄운다. 챔프 선택 → 상점 추천 탭, 게임 중 → 이번에 살 것.
    tkinter 와 웹 창은 둘 다 메인 스레드를 써야 해서 프로세스를 나눈다. 작은 창은 지금 상태를 status.json 에 남기고,
    앱 창의 웹이 window.pywebview.api.status() 로 읽는다. 앱 창을 닫으면 작은 창도 꺼진다

  python app/tiergg_app.py                              # 개발 중에 그대로
  python app/tiergg_app.py --web-url http://localhost:8765/   # 내 PC 서버로
  python app/tiergg_app.py --overlay-only               # 예전처럼 작은 창만
  python app/tiergg_app.py --update-feed URL            # 업데이트 확인을 다른 주소로(시험용)
  python app/build.py                                   # 실행 파일 만들기

작은 창의 옵션(--demo, --demo-select, --no-itemset, --game ...) 은 그대로 넘긴다.
"""
import json
import os
import subprocess
import sys

APP_VERSION = "1.2.12"
WEB_URL = "https://tier-gg.onrender.com/"
WINDOW_TITLE = "Tier.gg"        # 앱 창·작은 창 제목(작업 표시줄·Dock 에 보이는 이름)

FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    ROOT = sys._MEIPASS                    # 묶은 실행 파일이 풀린 곳(items.py·static/items 가 여기 있다)
else:
    ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "app"))

import logging  # noqa: E402

import item_tree  # noqa: E402
import updater  # noqa: E402

log = logging.getLogger("tiergg.app")
DATA_DIR = item_tree._cache_dir()          # Windows %APPDATA%\TierGG, macOS ~/Library/Application Support/TierGG
STATUS = os.path.join(DATA_DIR, "status.json")


def _log_to_file():
    """창만 있는 앱이라 오류가 안 보인다. app.log 에 남긴다(문제를 알릴 때 이 파일을 보내면 된다)."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        logging.basicConfig(filename=os.path.join(DATA_DIR, "app.log"), level=logging.INFO, encoding="utf-8",
                            format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    except OSError:
        pass


def _take(argv, flag, has_value=False):
    """argv 에서 우리 옵션을 꺼낸다(나머지는 작은 창에 넘긴다). → (값 또는 True/None, 남은 argv)"""
    if flag not in argv:
        return None, argv
    i = argv.index(flag)
    if has_value:
        return (argv[i + 1] if i + 1 < len(argv) else None), argv[:i] + argv[i + 2:]
    return True, argv[:i] + argv[i + 1:]


class Overlay:
    """작은 창(아이템 추천) 프로세스. 꺼졌으면(오른쪽 클릭으로 닫음) 앱 창에서 다시 켤 수 있다."""

    def __init__(self, passthrough):
        self.passthrough, self.p = passthrough, None

    def cmd(self):
        me = [sys.executable] if FROZEN else [sys.executable, os.path.abspath(__file__)]
        return me + ["--overlay", "--status-file", STATUS, "--parent-pid", str(os.getpid())] + self.passthrough

    def running(self):
        return self.p is not None and self.p.poll() is None

    def start(self):
        if self.running():
            return False
        for f in (STATUS, STATUS + ".show"):  # 예전 판의 상태·보이기 요청을 남기지 않게
            try:
                os.remove(f)
            except OSError:
                pass
        self.p = subprocess.Popen(self.cmd())
        log.info("작은 창 켬 pid=%s", self.p.pid)
        return True

    def stop(self):
        if self.running():
            self.p.terminate()


class Api:
    """앱 창의 웹이 부르는 것(window.pywebview.api.*). 값은 JSON 으로 넘어간다."""

    def __init__(self, overlay, upd):
        self._overlay, self._upd = overlay, upd
        self._window = None

    def info(self):
        return {"version": APP_VERSION, "os": sys.platform, "overlay": self._overlay.running(), "updater": True}

    def update_state(self):
        """{state: idle|checking|latest|downloading|ready|manual|error, current, latest?, url?, reason?}"""
        return self._upd.snapshot()

    def restart(self):
        """받아 둔 새 버전으로 다시 켠다."""
        if not self._upd.relaunch():
            return False
        self._overlay.stop()
        if self._window is not None:
            self._window.destroy()
        return True

    def status(self):
        try:
            with open(STATUS, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {"mode": "wait", "text": "작은 창을 켜는 중이에요"}
        st["overlay"] = self._overlay.running()
        return st

    def show_overlay(self):
        """작은 창을 보이게: 꺼졌으면 켜고, "−" 로 숨겼으면 다시 보이라고 한다(앱 창이 맨 앞으로 올 때 웹이 부른다)."""
        if self._overlay.start():
            return True
        try:
            with open(STATUS, encoding="utf-8") as f:
                hidden = json.load(f).get("hidden")
        except (OSError, ValueError):
            hidden = False
        if hidden:
            with open(STATUS + ".show", "w") as f:
                f.write("1")
        return bool(hidden)


# 서버가 자고 있으면(무료 서버) 첫 화면까지 30초쯤 걸린다. 그동안 빈 창 대신 보여 준다
SPLASH = """<!doctype html><meta charset="utf-8"><title>Tier.gg</title>
<style>html,body{margin:0;height:100%%;background:#0f1b33;color:#eaf0fa;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif}
main{height:100%%;display:grid;place-content:center;justify-items:center;gap:14px;text-align:center}
svg{width:64px;height:64px;animation:b 1.2s ease-in-out infinite alternate}@keyframes b{to{transform:translateY(-6px)}}
p{margin:0;color:#9aabc9;font-size:14px}b{font-size:20px}</style>
<main><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f0b429"/><rect x="6" y="7" width="20" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="13.75" width="14" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="20.5" width="8" height="4.5" rx="2" fill="#0f1b33"/></svg>
<b>Tier.gg를 여는 중이에요</b><p>서버가 쉬고 있었다면 30초쯤 걸려요</p></main>
<script>setTimeout(function(){location.replace(%s)},150)</script>"""


def _on_activate(cb):
    """Windows: 앱 창이 맨 앞으로 올 때(Form.Activated) cb. 웹의 focus 이벤트는 창을 바꿔 올 때 오지 않아서 창 쪽에서 듣는다.
    pywebview 의 창(BrowserForm) 이 이미 Activated 를 듣고 있어서 그 함수에 덧붙인다(창을 만들기 전에 부른다).
    macOS 는 웹(app-ui.js) 의 focus 로 한다."""
    if not sys.platform.startswith("win"):
        return
    try:
        from webview.platforms import winforms
        form = winforms.BrowserView.BrowserForm
        orig = form.on_activated

        def on_activated(self, *a):
            orig(self, *a)
            _quiet(cb)
        form.on_activated = on_activated
    except Exception:
        log.exception("앱 창 Activated 연결 실패")


def _quiet(cb):
    try:
        if cb():
            log.info("앱 창이 맨 앞으로 와서 작은 창을 다시 보임")
    except Exception:
        log.exception("작은 창 다시 보이기 실패")


def run_app(web_url, passthrough, update_feed=None):
    import webview
    overlay = Overlay(passthrough)
    upd = updater.Updater(APP_VERSION, DATA_DIR, feed=update_feed)
    upd.start()
    api = Api(overlay, upd)
    url = web_url + ("&" if "?" in web_url else "?") + "app=1"
    window = webview.create_window(WINDOW_TITLE, html=SPLASH % json.dumps(url), js_api=api,
                                   width=1280, height=860, min_size=(900, 600), background_color="#0f1b33")
    api._window = window
    # 작은 창은 앱 창이 뜬 뒤에 켠다(같이 켜면 둘이 CPU 를 나눠 써서 앱 창이 늦게 뜬다).
    # 그 뒤로는 앱 창이 맨 앞으로 올 때마다 숨긴(−)·닫은 작은 창을 다시 보인다
    window.events.shown += lambda: overlay.start()
    _on_activate(lambda: overlay.p is not None and api.show_overlay())     # 처음 켤 때는 shown 이 켠다
    log.info("Tier.gg 앱 %s 시작 %s", APP_VERSION, url)
    try:
        # private_mode=False: 로그인(웹의 localStorage) 을 앱 데이터 폴더에 남긴다
        webview.start(private_mode=False, storage_path=os.path.join(DATA_DIR, "web"))
    finally:
        overlay.stop()
    return window


def main():
    argv = sys.argv[1:]
    if "--version" in argv:
        print(APP_VERSION)
        return
    _log_to_file()
    overlay_child, argv = _take(argv, "--overlay")
    overlay_only, argv = _take(argv, "--overlay-only")
    web_url, argv = _take(argv, "--web-url", True)
    update_feed, argv = _take(argv, "--update-feed", True)
    if overlay_child or overlay_only:
        import item_overlay
        item_overlay.APP_NAME = WINDOW_TITLE
        sys.argv = [sys.argv[0]] + argv
        item_overlay.main()
        return
    run_app(web_url or WEB_URL, argv, update_feed)


if __name__ == "__main__":
    main()
