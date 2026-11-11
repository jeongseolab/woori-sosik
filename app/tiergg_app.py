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
  python app/build.py                                   # 실행 파일 만들기

작은 창의 옵션(--demo, --demo-select, --no-itemset, --game ...) 은 그대로 넘긴다.
"""
import json
import os
import subprocess
import sys

APP_VERSION = "1.1.1"
WEB_URL = "https://tier-gg.onrender.com/"
WINDOW_TITLE = "Tier.gg"        # 앱 창·작은 창 제목(작업 표시줄·Dock 에 보이는 이름)

FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    ROOT = sys._MEIPASS                    # 묶은 실행 파일이 풀린 곳(items.py·static/items 가 여기 있다)
else:
    ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import logging  # noqa: E402

import item_tree  # noqa: E402

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
        try:
            os.remove(STATUS)               # 예전 판의 상태를 보여 주지 않게
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

    def __init__(self, overlay):
        self._overlay = overlay

    def info(self):
        return {"version": APP_VERSION, "os": sys.platform, "overlay": self._overlay.running()}

    def status(self):
        try:
            with open(STATUS, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {"mode": "wait", "text": "작은 창을 켜는 중이에요"}
        st["overlay"] = self._overlay.running()
        return st

    def show_overlay(self):
        return self._overlay.start()


# 서버가 자고 있으면(무료 서버) 첫 화면까지 30초쯤 걸린다. 그동안 빈 창 대신 보여 준다
SPLASH = """<!doctype html><meta charset="utf-8"><title>Tier.gg</title>
<style>html,body{margin:0;height:100%%;background:#0f1b33;color:#eaf0fa;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif}
main{height:100%%;display:grid;place-content:center;justify-items:center;gap:14px;text-align:center}
svg{width:64px;height:64px;animation:b 1.2s ease-in-out infinite alternate}@keyframes b{to{transform:translateY(-6px)}}
p{margin:0;color:#9aabc9;font-size:14px}b{font-size:20px}</style>
<main><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f0b429"/><rect x="6" y="7" width="20" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="13.75" width="14" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="20.5" width="8" height="4.5" rx="2" fill="#0f1b33"/></svg>
<b>Tier.gg를 여는 중이에요</b><p>서버가 쉬고 있었다면 30초쯤 걸려요</p></main>
<script>setTimeout(function(){location.replace(%s)},150)</script>"""


def run_app(web_url, passthrough):
    import webview
    overlay = Overlay(passthrough)
    overlay.start()
    url = web_url + ("&" if "?" in web_url else "?") + "app=1"
    window = webview.create_window(WINDOW_TITLE, html=SPLASH % json.dumps(url), js_api=Api(overlay),
                                   width=1280, height=860, min_size=(900, 600), background_color="#0f1b33")
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
    if overlay_child or overlay_only:
        import item_overlay
        item_overlay.APP_NAME = WINDOW_TITLE
        sys.argv = [sys.argv[0]] + argv
        item_overlay.main()
        return
    run_app(web_url or WEB_URL, argv)


if __name__ == "__main__":
    main()
