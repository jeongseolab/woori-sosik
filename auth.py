"""로그인/계정.

비밀번호를 그대로 저장하면 memo.db 파일을 여는 순간 전부 보인다.
그래서 소금(salt)을 섞어 해시로 바꿔 저장하고, 맞는지는 해시끼리 비교한다.
원래 비밀번호는 어디에도 남지 않는다.
"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime

from database import get_conn


# 해시를 몇 번 돌릴지. 높을수록 무차별 대입이 느려진다
_ROUNDS = 200_000


def _hash_pw(password: str, salt: str) -> str:
    """비밀번호 + 소금 -> 해시. 같은 입력이면 항상 같은 값이 나온다."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _ROUNDS
    ).hex()


def create_user(username: str, password: str, is_admin: bool = False):
    """계정을 만든다. 이미 있는 이름이면 None 을 돌려준다."""
    username = (username or "").strip()
    if not username or not password:
        return None

    salt = secrets.token_hex(16)
    conn = get_conn()
    try:
        cursor = conn.execute(
            "INSERT INTO users (username, pw_hash, pw_salt, is_admin, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (username, _hash_pw(password, salt), salt,
             1 if is_admin else 0, datetime.now().isoformat()),
        )
        conn.commit()
        return cursor.lastrowid
    except Exception as e:
        # 이름이 겹친 것(UNIQUE)만 조용히 None 을 준다.
        # 그 밖의 고장은 삼키면 "이미 쓰는 아이디" 로 잘못 보이므로 다시 던진다.
        # (예전에 이걸 다 삼켜서, DB 가 고장 난 걸 아이디 중복으로 착각했다)
        text = (str(e) + type(e).__name__).lower()
        if "unique" in text or "duplicate" in text:
            return None
        raise
    finally:
        conn.close()


def check_login(username: str, password: str):
    """맞으면 사용자 정보를, 틀리면 None 을 돌려준다."""
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM users WHERE username = ?", ((username or "").strip(),)
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

    return {"id": row["id"], "username": row["username"],
            "is_admin": bool(row["is_admin"])}


def start_session(user_id: int) -> str:
    """로그인 표를 끊어 준다. 이 번호가 곧 신분증이 된다."""
    token = secrets.token_urlsafe(32)
    conn = get_conn()
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
        (token, user_id, datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()
    return token


def end_session(token: str):
    """로그아웃. 표를 버린다."""
    if not token:
        return
    conn = get_conn()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()


def who_is(token: str):
    """표를 보고 누구인지 알려준다. 게스트면 None."""
    if not token:
        return None

    conn = get_conn()
    row = conn.execute(
        "SELECT u.id, u.username, u.is_admin FROM sessions s"
        " JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    ).fetchone()
    conn.close()

    if row is None:
        return None

    return {"id": row["id"], "username": row["username"],
            "is_admin": bool(row["is_admin"])}


def ensure_admin(username: str, password: str):
    """관리자 계정이 없으면 만든다. 이미 있으면 그대로 둔다."""
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    if row is None:
        return create_user(username, password, is_admin=True)
    return None
