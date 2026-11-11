"""app/updater.py 시험. python -m pytest test_updater.py"""
import hashlib
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import updater as U  # noqa: E402


def rel(tag, *assets, draft=False):
    return {"tag_name": tag, "draft": draft, "assets": [
        {"name": n, "size": s, "digest": "sha256:" + d, "browser_download_url": "http://x/" + tag + "/" + n}
        for n, s, d in assets]}


def test_versions():
    assert U.newer("1.1.10", "1.1.9")
    assert U.newer("1.2", "1.1.9")
    assert not U.newer("1.1.1", "1.1.1")
    assert not U.newer("x", "1.0.0")


def test_pick_release_newest_for_os():
    rels = [rel("app-v1.1.1", ("Tier.gg.exe", 1, "a"), ("Tier.gg.zip", 2, "b")),
            rel("app-v1.3.0", ("Tier.gg.zip", 3, "c")),            # Windows 파일 없음
            rel("app-v1.2.0", ("Tier.gg.exe", 4, "d")),
            rel("app-v9.0.0", ("Tier.gg.exe", 5, "e"), draft=True),
            rel("v2.0", ("Tier.gg.exe", 6, "f"))]                   # app-v 아님
    w = U.pick_release(rels, "win32")
    assert (w["version"], w["size"], w["sha256"]) == ("1.2.0", 4, "d")
    assert U.pick_release(rels, "darwin")["version"] == "1.3.0"
    assert U.pick_release([], "win32") is None


def test_target_path():
    assert U.target_path("win32", r"C:\a\Tier.gg.exe").endswith("Tier.gg.exe")
    assert U.target_path("darwin", "/Applications/Tier.gg.app/Contents/MacOS/Tier.gg").replace("\\", "/").endswith("/Applications/Tier.gg.app")
    assert U.target_path("win32", r"C:\py\python") is None


def test_swap_windows_and_cleanup(tmp_path):
    exe = tmp_path / "Tier.gg.exe"
    exe.write_bytes(b"old")
    new = tmp_path / "new.exe"
    new.write_bytes(b"new")
    U.swap_windows(str(exe), str(new))
    assert exe.read_bytes() == b"new" and (tmp_path / "Tier.gg.exe.old").read_bytes() == b"old"
    U.cleanup(str(exe))
    assert not (tmp_path / "Tier.gg.exe.old").exists()


@pytest.fixture
def server(tmp_path):
    root = tmp_path / "srv"
    root.mkdir()

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield root, "http://127.0.0.1:%d/" % httpd.server_port
    httpd.shutdown()


def make_updater(tmp_path, base, payload, digest=None, size=None):
    exe = tmp_path / "app" / "Tier.gg.exe"
    exe.parent.mkdir()
    exe.write_bytes(b"old version")
    feed = [{"tag_name": "app-v1.2.0", "assets": [{
        "name": "Tier.gg.exe", "size": len(payload) if size is None else size,
        "digest": "sha256:" + (digest or hashlib.sha256(payload).hexdigest()),
        "browser_download_url": base + "Tier.gg.exe"}]}]
    u = U.Updater("1.1.1", str(tmp_path / "data"), frozen=True, platform="win32", executable=str(exe),
                  http_get=lambda url: feed)
    return u, exe


def test_run_once_downloads_and_swaps(tmp_path, server):
    root, base = server
    payload = b"brand new exe" * 1000
    (root / "Tier.gg.exe").write_bytes(payload)
    u, exe = make_updater(tmp_path, base, payload)
    st = u.run_once()
    assert st["state"] == "ready" and st["latest"] == "1.2.0"
    assert exe.read_bytes() == payload
    assert u.run_once()["state"] == "ready"           # 두 번 받지 않는다


def test_bad_digest_keeps_old(tmp_path, server):
    root, base = server
    (root / "Tier.gg.exe").write_bytes(b"tampered")
    u, exe = make_updater(tmp_path, base, b"tampered", digest="0" * 64)
    st = u.run_once()
    assert st["state"] == "error" and st["url"]
    assert exe.read_bytes() == b"old version"
    assert not os.listdir(tmp_path / "data" / "update")   # 받다 만 파일도 남기지 않는다


def test_latest_and_dev(tmp_path):
    feed = [rel("app-v1.1.1", ("Tier.gg.exe", 1, "a"))]
    u = U.Updater("1.1.1", str(tmp_path), frozen=True, platform="win32", executable=str(tmp_path / "T.exe"),
                  http_get=lambda url: feed)
    assert u.run_once()["state"] == "latest"
    dev = U.Updater("1.0.0", str(tmp_path), frozen=False, platform="win32", http_get=lambda url: feed)
    assert dev.run_once()["state"] == "manual"


def test_offline(tmp_path):
    def boom(url):
        raise OSError("no net")
    u = U.Updater("1.1.1", str(tmp_path), frozen=True, platform="win32", executable=str(tmp_path / "T.exe"),
                  http_get=boom)
    assert u.run_once()["state"] == "error"
