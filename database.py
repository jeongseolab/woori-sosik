import os
import sqlite3

# 어디에 저장할지.
# 인터넷에 올리면 서버가 껐다 켜질 때마다 폴더가 초기화되는 곳이 많다.
# 그런 데서는 MEMO_DB_PATH 로 '안 지워지는 칸(디스크)' 을 가리켜 준다.
# 아무것도 안 정하면 예전처럼 옆에 있는 memo.db 를 쓴다
DB_NAME = os.environ.get("MEMO_DB_PATH") or "memo.db"


def _ensure_folder():
    """저장할 폴더가 없으면 만든다."""
    folder = os.path.dirname(os.path.abspath(DB_NAME))
    if folder:
        os.makedirs(folder, exist_ok=True)


def get_conn():
    _ensure_folder()
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row      # 딕셔너리처럼 쓰게 해줌
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memos (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            content      TEXT NOT NULL,
            created_at   TEXT,
            likes        INTEGER NOT NULL DEFAULT 0,
            owner_token  TEXT,
            author       TEXT,
            author_id    INTEGER
        )
    """)

    # 예전에 만든 memo.db 에 없는 칸은 여기서 채워 넣는다
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(memos)")]
    if "created_at" not in columns:
        conn.execute("ALTER TABLE memos ADD COLUMN created_at TEXT")
    if "likes" not in columns:
        conn.execute("ALTER TABLE memos ADD COLUMN likes INTEGER NOT NULL DEFAULT 0")
    # 누가 쓴 포스트잇인지 표시. 이 칸이 비어 있는(= 이 기능 전에 쓴) 메모는 아무도 못 뗀다
    # 로그인해서 쓴 글은 계정에 묶어 둔다.
    # 브라우저 번호는 기기를 바꾸면 사라지지만 계정은 남는다
    if "author" not in columns:
        conn.execute("ALTER TABLE memos ADD COLUMN author TEXT")
    if "author_id" not in columns:
        conn.execute("ALTER TABLE memos ADD COLUMN author_id INTEGER")
    if "owner_token" not in columns:
        conn.execute("ALTER TABLE memos ADD COLUMN owner_token TEXT")

    # ── 계정 ────────────────────────────────────────────
    # 비밀번호는 그대로 두지 않고 해시로 바꿔 저장한다.
    # memo.db 가 공유 폴더에 있어서 파일만 열어도 다 보이기 때문
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT NOT NULL UNIQUE,
            pw_hash    TEXT NOT NULL,
            pw_salt    TEXT NOT NULL,
            is_admin   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )
    """)

    # 로그인하면 여기에 표를 하나 끊어 준다. 브라우저는 이 번호만 들고 다닌다
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            created_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)

    conn.commit()
    conn.close()
