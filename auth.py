"""로그인/계정.

아이디는 Riot ID(이름#태그) 다. 가입할 때 OP.GG 에 정말 있는 계정인지 확인하고
그 계정의 puuid 를 같이 저장한다.

비밀번호를 그대로 저장하면 DB 를 여는 순간 전부 보인다.
그래서 소금(salt)을 섞어 해시로 바꿔 저장하고, 맞는지는 해시끼리 비교한다.
원래 비밀번호는 어디에도 남지 않는다.

나중에 Riot 공식 로그인(RSO) 승인을 받으면 check_login 자리만 바꾸면 된다.
나머지 코드는 start_session / who_is 만 쓴다.

닉네임이 바뀌면:
  Riot 계정은 이름을 바꿔도 puuid 가 그대로다. 새 이름으로 로그인하면 riot_key 로는
  못 찾지만, OP.GG 에서 새 이름의 puuid 를 받아 그 puuid 의 계정과 비밀번호를 맞춰 본다.
  맞으면 check_by_puuid 가 그 계정을 돌려주고, 사용자가 "예" 하면 rename_account 로 고친다.
"""
import hashlib
import hmac
import secrets
from datetime import datetime

from database import get_conn


# 해시를 몇 번 돌릴지. 높을수록 무차별 대입이 느려진다
_ROUNDS = 200_000


def riot_key(game_name: str, tagline: str) -> str:
    """대소문자와 공백을 무시한 비교용 이름. 'Hide on bush#KR1' -> 'hideonbush#kr1'"""
    return (game_name.replace(" ", "") + "#" + tagline.replace(" ", "")).lower()


def split_riot_id(text: str):
    """'이름#태그' 를 (이름, 태그) 로 나눈다. 모양이 틀리면 None."""
    name, sep, tag = (text or "").strip().rpartition("#")
    name, tag = name.strip(), tag.strip()
    if not sep or not name or not tag:
        return None
    return name, tag


def _hash_pw(password: str, salt: str) -> str:
    """비밀번호 + 소금 -> 해시. 같은 입력이면 항상 같은 값이 나온다."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _ROUNDS
    ).hex()


def _public(row):
    return {"id": row["id"], "game_name": row["game_name"],
            "tagline": row["tagline"], "puuid": row["puuid"],
            "riot_id": row["game_name"] + "#" + row["tagline"]}


def _free_riot_key(conn, key: str, puuid: str):
    """그 이름을 쥐고 있는 다른 사람(puuid 가 다른 계정) 에게서 이름을 뗀다.

    닉네임을 바꾼 사람의 옛 이름이 계정 표에 남아 있으면, 그 이름을 새로 가져간
    사람이 가입도 로그인도 못 한다. 부르는 쪽이 OP.GG 에서 "지금 이 이름은 puuid 사람" 임을
    확인한 뒤에만 부른다. 뗀 자리에는 '#' 없는 표식을 넣어 진짜 이름과 겹치지 않게 한다.
    """
    rows = conn.execute(
        "SELECT id, puuid FROM accounts WHERE riot_key = ? AND puuid <> ?", (key, puuid)
    ).fetchall()
    for row in rows:
        conn.execute("UPDATE accounts SET riot_key = ? WHERE id = ?",
                     ("renamed:" + row["puuid"], row["id"]))


def create_account(game_name: str, tagline: str, puuid: str, password: str):
    """계정을 만든다. 이미 가입된 Riot 계정이면 None 을 돌려준다.

    puuid 는 방금 OP.GG 에서 확인한 값이라, 같은 이름을 쥔 옛 계정은 이름을 떼어 준다.
    """
    salt = secrets.token_hex(16)
    conn = get_conn()
    try:
        _free_riot_key(conn, riot_key(game_name, tagline), puuid)
        cursor = conn.execute(
            "INSERT INTO accounts (riot_key, game_name, tagline, puuid,"
            " pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (riot_key(game_name, tagline), game_name, tagline, puuid,
             _hash_pw(password, salt), salt, datetime.now().isoformat()),
        )
        conn.commit()
        return cursor.lastrowid
    except Exception as e:
        # 겹친 것(UNIQUE)만 조용히 None 을 준다.
        # 그 밖의 고장은 삼키면 "이미 가입된 계정" 으로 잘못 보이므로 다시 던진다
        text = (str(e) + type(e).__name__).lower()
        if "unique" in text or "duplicate" in text:
            return None
        raise
    finally:
        conn.close()


def check_login(riot_id: str, password: str):
    """맞으면 계정 정보를, 틀리면 None 을 돌려준다."""
    parts = split_riot_id(riot_id)
    row = None
    if parts:
        conn = get_conn()
        row = conn.execute(
            "SELECT * FROM accounts WHERE riot_key = ?", (riot_key(*parts),)
        ).fetchone()
        conn.close()

    if row is None:
        # 없는 이름이어도 똑같이 시간을 쓴다.
        # 응답이 빨리 오는 것만으로 "그 이름은 없구나" 를 알 수 있기 때문
        _hash_pw(password or "", "dummy")
        return None

    got = _hash_pw(password or "", row["pw_salt"])
    # 글자를 하나씩 비교하면 몇 글자까지 맞았는지가 시간으로 새어 나간다
    if not hmac.compare_digest(got, row["pw_hash"]):
        return None
    return _public(row)


def check_by_puuid(puuid: str, password: str):
    """puuid 로 계정을 찾아 비밀번호를 맞춰 본다. 닉네임을 바꾼 사람을 찾을 때 쓴다."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM accounts WHERE puuid = ?", (puuid,)).fetchone()
    conn.close()
    if row is None:
        _hash_pw(password or "", "dummy")
        return None
    got = _hash_pw(password or "", row["pw_salt"])
    if not hmac.compare_digest(got, row["pw_hash"]):
        return None
    return _public(row)


def rename_account(account_id: int, puuid: str, game_name: str, tagline: str):
    """계정의 닉네임을 새 것으로 바꾼다. puuid 는 OP.GG 에서 방금 확인한 값이다."""
    conn = get_conn()
    key = riot_key(game_name, tagline)
    _free_riot_key(conn, key, puuid)
    conn.execute(
        "UPDATE accounts SET riot_key = ?, game_name = ?, tagline = ? WHERE id = ?",
        (key, game_name, tagline, account_id))
    conn.commit()
    conn.close()
    return find_account(account_id)


def puuid_of(game_name: str, tagline: str):
    """가입한 사람이면 그 계정의 puuid, 아니면 None."""
    conn = get_conn()
    row = conn.execute("SELECT puuid FROM accounts WHERE riot_key = ?",
                       (riot_key(game_name, tagline),)).fetchone()
    conn.close()
    return row["puuid"] if row else None


def start_session(account_id: int) -> str:
    """로그인 표를 끊어 준다. 이 번호가 곧 신분증이 된다."""
    token = secrets.token_urlsafe(32)
    conn = get_conn()
    conn.execute(
        "INSERT INTO account_sessions (token, account_id, created_at) VALUES (?, ?, ?)",
        (token, account_id, datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()
    return token


def end_session(token: str):
    """로그아웃. 표를 버린다."""
    if not token:
        return
    conn = get_conn()
    conn.execute("DELETE FROM account_sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()


def who_is(token: str):
    """표를 보고 누구인지 알려준다. 로그인 안 했으면 None."""
    if not token:
        return None
    conn = get_conn()
    row = conn.execute(
        "SELECT a.* FROM account_sessions s"
        " JOIN accounts a ON a.id = s.account_id WHERE s.token = ?",
        (token,),
    ).fetchone()
    conn.close()
    return _public(row) if row else None


def find_account(account_id: int):
    conn = get_conn()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    conn.close()
    return _public(row) if row else None
