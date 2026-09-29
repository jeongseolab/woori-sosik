"""저장소.

집에서는 SQLite(mytier.db 파일) 를, 인터넷에 올리면 PostgreSQL 을 쓴다.
DATABASE_URL 이 있으면 Postgres, 없으면 예전처럼 파일이다.

왜 둘 다 되게 했나:
  무료 서버는 껐다 켜지면 폴더가 초기화돼서 파일이 날아간다.
  그래서 계정과 방은 서버 바깥(Postgres) 에 둔다.
  집에서 연습할 때까지 Postgres 를 깔게 하면 번거로우니 파일도 그대로 둔다.

나머지 코드는 이 파일만 보고 쓰므로 고칠 필요가 없다.
물음표(?) 로 쓴 질의를 Postgres 용(%s) 으로 여기서 바꿔 준다.
"""
import os
import re
import sqlite3

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# 파일로 쓸 때의 위치.
# 예전 게시판의 memo.db 와 섞이지 않게 새 파일을 쓴다
DB_NAME = os.environ.get("MYTIER_DB_PATH") or "mytier.db"

# INSERT 뒤에 새 번호(id) 를 돌려받아야 하는 표.
# 번호 칸이 없는 표에 RETURNING id 를 붙이면 오류가 나서 따로 적어 둔다
_TABLES_WITH_ID = ("ACCOUNTS", "ROOMS")


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
    # Postgres 의 REAL 은 소수 6자리뿐이라 1.7e9 같은 시각이 2분 단위로 뭉개진다
    sql = sql.replace(" REAL", " DOUBLE PRECISION")
    return sql


class _Cursor:
    """SQLite 커서처럼 보이게 감싼 것. execute 가 자기 자신을 돌려준다."""

    def __init__(self, cursor, last_id=None):
        self._c = cursor
        # psycopg 커서에는 값을 붙일 수 없어서(__slots__) 여기에 들고 있는다
        self._last_id = last_id

    def fetchone(self):
        return self._c.fetchone()

    def fetchall(self):
        return self._c.fetchall()

    def __iter__(self):
        return iter(self._c.fetchall())

    @property
    def lastrowid(self):
        # Postgres 는 lastrowid 가 없어서 RETURNING id 로 받아 둔 값을 쓴다
        return self._last_id

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

        # INSERT 뒤에 붙은 번호를 알아야 하는 자리가 있다(새 계정, 새 방)
        upper = sql.lstrip().upper()
        wants_id = (upper.startswith("INSERT")
                    and "RETURNING" not in upper
                    and any("INTO " + t + " " in upper for t in _TABLES_WITH_ID))
        if wants_id:
            sql = sql.rstrip().rstrip(";") + " RETURNING id"

        cur.execute(sql, params)

        last_id = None
        if wants_id:
            row = cur.fetchone()
            if row is not None:
                # dict_row 라 이름으로 꺼내지만, 혹시 튜플이면 첫 칸을 쓴다
                last_id = row["id"] if isinstance(row, dict) else row[0]

        return _Cursor(cur, last_id)

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

    # ── 계정 ────────────────────────────────────────────
    # 아이디는 Riot ID(이름#태그) 다. riot_key 는 대소문자·공백을 정리한 값이라
    # "Hide on bush#KR1" 과 "hideonbush#kr1" 이 같은 계정으로 잡힌다.
    # puuid 는 Riot 계정의 진짜 번호라, 이름을 바꿔도 같은 사람임을 알 수 있다
    conn.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            riot_key   TEXT NOT NULL UNIQUE,
            game_name  TEXT NOT NULL,
            tagline    TEXT NOT NULL,
            puuid      TEXT NOT NULL UNIQUE,
            pw_hash    TEXT NOT NULL,
            pw_salt    TEXT NOT NULL,
            created_at TEXT
        )
    """)

    # 로그인하면 표를 하나 끊어 준다. 브라우저는 이 번호만 들고 다닌다
    conn.execute("""
        CREATE TABLE IF NOT EXISTS account_sessions (
            token      TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL,
            created_at TEXT
        )
    """)

    # ── 그룹방 ──────────────────────────────────────────
    # code 는 초대할 때 나눠 주는 짧은 암호다
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            code       TEXT NOT NULL UNIQUE,
            owner_id   INTEGER NOT NULL,
            created_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS room_members (
            room_id    INTEGER NOT NULL,
            account_id INTEGER NOT NULL,
            joined_at  TEXT,
            PRIMARY KEY (room_id, account_id)
        )
    """)

    # ── OP.GG 에서 받은 것 ──────────────────────────────
    # 같은 걸 자꾸 물어보지 않게 잠깐 들고 있는 곳
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_cache (
            key      TEXT PRIMARY KEY,
            value    TEXT NOT NULL,
            saved_at REAL NOT NULL
        )
    """)

    # 경기 기록. OP.GG 는 한 번에 최근 20판만 주므로
    # 올 때마다 쌓아 두면 듀오 궁합에 쓸 판이 점점 늘어난다
    conn.execute("""
        CREATE TABLE IF NOT EXISTS match_rows (
            puuid      TEXT NOT NULL,
            game_id    TEXT NOT NULL,
            created_at TEXT,
            game_type  TEXT,
            champion   TEXT,
            position   TEXT,
            team_key   TEXT,
            result     TEXT,
            kills      INTEGER,
            deaths     INTEGER,
            assists    INTEGER,
            op_score   REAL,
            length_sec INTEGER,
            champion_id INTEGER,
            cs         INTEGER,
            PRIMARY KEY (puuid, game_id)
        )
    """)
    # 예전에 만든 표에는 없는 칸을 채워 넣는다
    columns = _columns(conn, "match_rows")
    if "champion_id" not in columns:
        conn.execute("ALTER TABLE match_rows ADD COLUMN champion_id INTEGER")
    if "cs" not in columns:
        conn.execute("ALTER TABLE match_rows ADD COLUMN cs INTEGER")

    conn.commit()
    conn.close()
