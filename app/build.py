"""Tier.gg 앱 실행 파일 만들기. 그 OS 에서 돌려야 그 OS 용이 나온다(PyInstaller 는 다른 OS 용을 못 만든다).

  pip install pyinstaller==6.11.1 pillow httpx==0.28.1 pywebview==5.3.2
  python app/build.py

  Windows → dist/Tier.gg.exe (파일 하나, 설치 없이 실행)
  macOS   → dist/Tier.gg.zip (Tier.gg.app 을 묶은 것. 풀어서 응용 프로그램 폴더로)
받은 사람의 PC 에서도 파일·앱 이름이 "Tier.gg" 로 보이게 이 이름 그대로 릴리스에 올린다

GitHub 에 app-v1.0.0 같은 태그를 올리면 .github/workflows/app.yml 이 두 OS 에서 이걸 돌려 릴리스에 올린다.
웹의 다운로드 버튼은 그 릴리스를 가리킨다(main.py 의 /api/app/latest).
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

# GitHub 의 Windows 서버는 출력이 cp1252 라 한글을 찍다가 멈춘다(앱은 다 만들었는데 실패로 끝남). UTF-8 로
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
APP_FILE = "Tier.gg"           # 실행 파일·.app 이름(받은 사람이 보는 이름)
ROOT = os.path.abspath(os.path.join(HERE, ".."))
BUILD = os.path.join(ROOT, "build", "app")
DIST = os.path.join(ROOT, "dist")


def make_icon():
    """웹 로고(금색 칸 + 남색 막대 셋) 를 그대로 그린다. → (png, ico)"""
    os.makedirs(BUILD, exist_ok=True)
    n = 1024
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = n / 32
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=8 * u, fill="#f0b429")
    for x, y, w in ((6, 7, 20), (6, 13.75, 14), (6, 20.5, 8)):
        d.rounded_rectangle((x * u, y * u, (x + w) * u, (y + 4.5) * u), radius=2 * u, fill="#0f1b33")
    png = os.path.join(BUILD, "icon.png")
    ico = os.path.join(BUILD, "icon.ico")
    im.save(png)
    im.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return png, ico


def main():
    png, ico = make_icon()
    windows = sys.platform.startswith("win")
    sep = os.pathsep
    args = [sys.executable, "-m", "PyInstaller", os.path.join(HERE, "tiergg_app.py"),
            "--name", APP_FILE, "--windowed", "--noconfirm", "--clean",
            "--paths", ROOT, "--paths", os.path.join(ROOT, "tools"),
            "--add-data", os.path.join(ROOT, "static", "items") + sep + "static/items",
            "--hidden-import", "item_overlay", "--hidden-import", "lcu", "--hidden-import", "item_tree",
            # 앱 창(웹) 은 pywebview. Windows 는 Edge WebView2(pythonnet), macOS 는 WKWebView(pyobjc)
            "--collect-all", "webview",
            # 서버(웹) 쪽만 쓰는 것은 빼서 크기를 줄인다
            "--exclude-module", "fastapi", "--exclude-module", "uvicorn", "--exclude-module", "psycopg",
            "--exclude-module", "PIL", "--exclude-module", "numpy",
            "--icon", ico if windows else png,
            "--distpath", DIST, "--workpath", BUILD, "--specpath", BUILD]
    if windows:
        args.append("--onefile")
    else:
        args += ["--osx-bundle-identifier", "gg.tier.app"]
    subprocess.run(args, check=True, cwd=ROOT)
    if windows:
        out = os.path.join(DIST, APP_FILE + ".exe")
    else:
        out = os.path.join(DIST, APP_FILE + ".zip")
        # ditto 는 .app 안의 권한·링크를 지킨 채로 묶는다(zip 명령은 깨뜨릴 수 있다)
        subprocess.run(["ditto", "-c", "-k", "--keepParent", os.path.join(DIST, APP_FILE + ".app"), out], check=True)
    print("만듦:", out, "%.1fMB" % (os.path.getsize(out) / 1e6))


if __name__ == "__main__":
    main()
