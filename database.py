"""저장소.

집에서는 SQLite(memo.db 파일) 를, 인터넷에 올리면 PostgreSQL 을 쓴다.
DATABASE_URL 이 있으면 Postgres, 없으면 예전처럼 파일이다.

왜 둘 다 되게 했나:
  무료 서버는 껐다 켜지면 폴더가 초기화돼서 memo.db 가 날아간다.
  그래서 글은 서버 바깥(Postgres) 에 둔다.
  집에서 연습할 때까지 Postgres 를 깔게 하면 번거로우니 파일도 그대로 둔다.

나머지 코드(main.py, auth.py) 는 이 파일만 보고 쓰므로 고칠 필요가 없다.
물음표(?) 로 쓴 질의를 Postgres 용(%s) 으로 여기서 바꿔 준다.
"""
import os
import re
import sqlite3

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# 파일로 쓸 때의 위치
DB_NAME = os.environ.get("MEMO_DB_PATH") or "memo.db"


# ── Postgres 와 SQLite 의 말투 차이를 메우는 부분 ──────────

# 글자 사이의 물음표만 %s 로 바꾼다.
# 따옴표 안('...') 에 있는 물음표는 진짜 물음표이므로 건드리면 안 된다
_QMARK = re.compile(r"'[^']*'|\?")


def _to_pg(sql: str) -> str:
    """?  ->  %s  (따옴표 안은 그대로 둔다)"""
    return _QMARK.sub(lambda m: m.group(0) if m.group(0).startswith("'") else "%s", sql)


def _to_pg_types(sql: str) -> str:
    """표를 만드는 문장을 Postgres 말투로 바꾼다."""
    sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    return sql


class _Cursor:
    """SQLite 커서처럼 보이게 감싼 것. execute 가 자기 자신을 돌려준다."""

    def __init__(self, cursor):
        self._c = cursor

    def fetchone(self):
        return self._c.fetchone()

    def fetchall(self):
        return self._c.fetchall()

    def __iter__(self):
        return iter(self._c.fetchall())

    @property
    def lastrowid(self):
        # Postgres 는 lastrowid 가 없어서 RETURNING id 로 받아 둔 값을 쓴다
        return getattr(self._c, "_last_id", None)

    @property
    def rowcount(self):
        return self._c.rowcount


class _PgConn:
    """psycopg 연결을 sqlite3 연결처럼 쓰게 감싼다."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        sql = _to_pg(_to_pg_types(sql))
        cur = self._conn.cursor()

        # INSERT 뒤에 붙은 번호를 알아야 하는 자리가 있다.
        # memos(새 메모 번호) 와 users(새 계정 번호) 둘 다 쓴다.
        # sessions 는 번호가 없는 표라 빼야 한다(RETURNING id 를 붙이면 오류)
        upper = sql.lstrip().upper()
        wants_id = (upper.startswith("INSERT")
                    and "RETURNING" not in upper
                    and ("INTO MEMOS" in upper or "INTO USERS" in upper))
        if wants_id:
            sql = sql.rstrip().rstrip(";") + " RETURNING id"

        cur.execute(sql, params)

        if wants_id:
            row = cur.fetchone()
            cur._last_id = row["id"] if row else None

        return _Cursor(cur)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_conn():
    if IS_POSTGRES:
        import psycopg
        from psycopg.rows import dict_row
        return _PgConn(psycopg.connect(DATABASE_URL, row_factory=dict_row))

    _ensure_folder()
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row      # 딕셔너리처럼 쓰게 해줌
    return conn


def _ensure_folder():
    """저장할 폴더가 없으면 만든다."""
    folder = os.path.dirname(os.path.abspath(DB_NAME))
    if folder:
        os.makedirs(folder, exist_ok=True)


def _columns(conn, table):
    """그 표에 어떤 칸이 있는지 이름만 뽑는다."""
    if IS_POSTGRES:
        rows = conn.execute(
            "SELECT column_name AS name FROM information_schema.columns"
            " WHERE table_name = ?", (table,)
        ).fetchall()
    else:
        rows = conn.execute("PRAGMA table_info(%s)" % table).fetchall()
    return [row["name"] for row in rows]


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
    columns = _columns(conn, "memos")
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
