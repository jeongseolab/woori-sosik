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
import threading

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# 파일로 쓸 때의 위치.
# 예전 게시판의 memo.db 와 섞이지 않게 새 파일을 쓴다
DB_NAME = os.environ.get("MYTIER_DB_PATH") or "mytier.db"

# match_rows 에 나중에 붙인 칸. 플레이 점수(perf.py) 에 쓴다
MATCH_EXTRA_COLUMNS = {
    "champion_id": "INTEGER",
    "cs": "INTEGER",
    "gold": "INTEGER",         # 내가 번 골드
    "damage": "INTEGER",       # 챔피언에게 준 피해
    "wards": "INTEGER",        # 와드 설치 + 제어 와드 구매
    "spree": "INTEGER",        # 최다 연속 킬
    "op_rank": "INTEGER",      # 그 판 10명 중 OP.GG 평점 순위
    "early_score": "REAL",     # 14분 무렵 OP.GG 평점(0~10)
    "team_kills": "INTEGER",   # 우리 팀 킬 합(킬 관여율)
    "team_gold": "INTEGER",    # 우리 팀 골드 합(골드 몫)
    "avg_tier": "TEXT",        # 그 판의 평균 티어
}

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
    """psycopg 연결을 sqlite3 연결처럼 쓰게 감싼다.

    연결은 풀(_pool) 에서 빌려 온 것이다. close() 는 끊는 게 아니라 풀에 돌려준다.
    """

    def __init__(self, conn, pool=None):
        self._conn = conn
        self._pool = pool

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
        conn, self._conn = self._conn, None
        if conn is None:
            return                      # 이미 돌려줬다
        if self._pool is None:
            conn.close()
            return
        # 끝내지 않은 일(오류로 중간에 멈춘 것) 이 있으면 되돌린 뒤 돌려준다.
        # 그대로 돌려주면 다음 사람이 망가진 연결을 받는다
        from psycopg.pq import TransactionStatus
        try:
            if conn.info.transaction_status != TransactionStatus.IDLE:
                conn.rollback()
        except Exception:
            pass
        self._pool.putconn(conn)

    def __del__(self):
        # 오류가 나서 close() 를 못 부르고 빠져나간 경우에도 연결을 돌려준다.
        # 안 돌려주면 풀이 비어서 사이트 전체가 멈춘다
        try:
            self.close()
        except Exception:
            pass


# ── 연결 풀 ──────────────────────────────────────────────
# 예전에는 DB 에 한 번 물어볼 때마다 Neon 까지 새로 연결했다(한 번에 0.1~0.3초).
# 티어표 하나에 이런 일이 수십 번이라 화면을 옮길 때마다 느렸다.
# 이제 연결을 몇 개 열어 두고 돌려 쓴다.
#   - 최대 5개. 무료 Neon 의 동시 연결 한도보다 한참 적다
#   - 4분 넘게 안 쓴 연결은 닫는다(min_size=0). 연결을 계속 붙잡고 있으면
#     Neon 이 잠들지 못해 무료 사용 시간을 다 쓴다
#   - 빌려주기 전에 살아 있는지 확인한다. Neon 이 잠들며 끊은 연결을 주지 않게
POOL_MAX = 5
POOL_MAX_IDLE_SEC = 240
_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg.rows import dict_row
                from psycopg_pool import ConnectionPool
                _pool = ConnectionPool(
                    DATABASE_URL, min_size=0, max_size=POOL_MAX,
                    max_idle=POOL_MAX_IDLE_SEC, timeout=20,
                    kwargs={"row_factory": dict_row},
                    check=ConnectionPool.check_connection,
                    open=True, name="tiergg")
    return _pool


def get_conn():
    if IS_POSTGRES:
        pool = _get_pool()
        return _PgConn(pool.getconn(), pool)

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
    # ── 스킬샷 피하기 기록 ─────────────────────────────
    # 판마다 한 줄. 최고 기록과 이번 주 최고 기록을 여기서 뽑는다.
    # played_at 은 초 단위 시각(time.time())
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dodge_runs (
            account_id INTEGER NOT NULL,
            ms         INTEGER NOT NULL,
            dodged     INTEGER,
            played_at  REAL NOT NULL
        )
    """)

    # ver: 게임 규칙 버전(static/dodge.js 의 VERSION). 예전 판은 비어 있다
    if "ver" not in _columns(conn, "dodge_runs"):
        conn.execute("ALTER TABLE dodge_runs ADD COLUMN ver INTEGER")
    # mode: normal | hard(CC 를 당하는 모드). 예전 판은 비어 있고 노멀로 본다
    if "mode" not in _columns(conn, "dodge_runs"):
        conn.execute("ALTER TABLE dodge_runs ADD COLUMN mode TEXT")

    # 예전에 만든 표에는 없는 칸을 채워 넣는다
    columns = _columns(conn, "match_rows")
    for name, kind in MATCH_EXTRA_COLUMNS.items():
        if name not in columns:
            conn.execute("ALTER TABLE match_rows ADD COLUMN %s %s" % (name, kind))

    conn.commit()
    conn.close()
