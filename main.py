from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import os

# 서버를 어느 폴더에서 켜든 파일을 찾을 수 있게, 이 파일 위치를 기준으로 잡는다
HERE = os.path.dirname(os.path.abspath(__file__))

from auth import (check_login, create_user, end_session, ensure_admin,
                  start_session, who_is)
from censor import find_blocked, mask
from database import get_conn, init_db
from meal import router as meal_router


# ── 관리자 ───────────────────────────────────────────────
# 관리자는 남의 포스트잇도 뗄 수 있다.
# 열쇠는 코드에 박아 두면 화면 소스만 봐도 들통나므로 파일/환경변수에서 읽는다.
# admin_key.txt 를 만들어 아무 문장이나 한 줄 적어 두면 그게 열쇠가 된다.
def _load_admin_key():
    key = os.environ.get("MEMO_ADMIN_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.join(HERE, "admin_key.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


ADMIN_KEY = _load_admin_key()


def _is_admin(token):
    """로그인 표를 보고 관리자인지 확인한다.

    예전엔 열쇠 한 줄로 했는데, 이제 계정으로 한다.
    열쇠(admin_key.txt)는 첫 관리자 계정의 비밀번호로만 쓴다."""
    user = who_is(token)
    return bool(user and user["is_admin"])


app = FastAPI(title="우리 학교 API")

init_db()

# 관리자 계정을 한 번 만들어 둔다.
# 이름은 admin, 비밀번호는 admin_key.txt 에 적힌 값.
# 이미 있으면 그대로 두므로 비밀번호를 바꿔도 덮어쓰지 않는다
if ADMIN_KEY:
    _made = ensure_admin("admin", ADMIN_KEY)
    if _made:
        print("[알림] 관리자 계정을 만들었습니다 -> 아이디: admin")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(meal_router)


class MemoIn(BaseModel):
    title: str
    content: str
    # 로그인했으면 이 표를 보낸다. 게스트면 비어 있다
    token: str | None = None
    # 브라우저가 만들어 보내는 "내 것" 표시. 이게 맞아야 뗄 수 있다
    owner_token: str | None = None


def _may_touch(row, token, owner_token):
    """이 메모를 고치거나 뗄 수 있는 사람인지 본다."""
    user = who_is(token)

    # 관리자는 전부 가능
    if user and user["is_admin"]:
        return True

    # 로그인한 사람은 자기 계정으로 쓴 글이면 가능 (기기가 바뀌어도 된다)
    if user and row["author_id"] and row["author_id"] == user["id"]:
        return True

    # 게스트는 예전처럼 브라우저 번호가 맞아야 한다.
    # 단, 계정 글은 브라우저 번호로 못 건드린다
    if row["author_id"]:
        return False

    return bool(row["owner_token"]) and row["owner_token"] == owner_token


def _censor(title: str, content: str):
    """막을 말이 있으면 400 으로 돌려보내고, 가벼운 건 ** 로 덮어서 준다."""
    hits = find_blocked(title) + find_blocked(content)
    if hits:
        raise HTTPException(status_code=400, detail="그런 말은 붙일 수 없습니다")
    return mask(title), mask(content)


@app.post("/memos", status_code=201)
def create_memo(memo: MemoIn):
    title, content = _censor(memo.title, memo.content)
    now = datetime.now().isoformat()

    # 로그인했으면 이름을 남기고, 게스트면 비워 둔다
    user = who_is(memo.token)
    author = user["username"] if user else None
    author_id = user["id"] if user else None

    conn = get_conn()
    cursor = conn.execute(
        "INSERT INTO memos (title, content, created_at, owner_token, author, author_id)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (title, content, now, memo.owner_token, author, author_id),
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()

    return {
        "id": new_id,
        "title": title,
        "content": content,
        "created_at": now,
        "likes": 0,
        "author": author,
    }


def _public(row):
    """화면에 내보낼 메모. owner_token 은 남한테 보이면 안 되니 뺀다."""
    memo = dict(row)
    memo.pop("owner_token", None)
    # 계정 번호는 화면에서 쓸 일이 없다. 이름만 내보낸다
    memo.pop("author_id", None)
    return memo


@app.get("/memos")
def read_memos(keyword: str = None):
    conn = get_conn()

    if keyword:
        rows = conn.execute(
            "SELECT * FROM memos WHERE title LIKE ? ORDER BY id DESC",
            (f"%{keyword}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM memos ORDER BY id DESC"
        ).fetchall()

    conn.close()
    return [_public(row) for row in rows]


@app.get("/memos/{memo_id}")
def read_memo(memo_id: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM memos WHERE id = ?", (memo_id,)
    ).fetchone()
    conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="그런 메모 없습니다")

    return _public(row)


@app.post("/memos/{memo_id}/like")
def like_memo(memo_id: int):
    return _change_likes(memo_id, +1)


@app.delete("/memos/{memo_id}/like")
def unlike_memo(memo_id: int):
    return _change_likes(memo_id, -1)


def _change_likes(memo_id: int, amount: int):
    """좋아요를 amount 만큼 더한다. 0 밑으로는 안 내려가게 막는다."""
    conn = get_conn()
    cursor = conn.execute(
        "UPDATE memos SET likes = MAX(0, likes + ?) WHERE id = ?",
        (amount, memo_id),
    )
    conn.commit()

    if cursor.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="그런 메모 없습니다")

    row = conn.execute(
        "SELECT likes FROM memos WHERE id = ?", (memo_id,)
    ).fetchone()
    conn.close()

    return {"id": memo_id, "likes": row["likes"]}


@app.put("/memos/{memo_id}")
def update_memo(memo_id: int, new_data: MemoIn):
    title, content = _censor(new_data.title, new_data.content)

    conn = get_conn()
    row = conn.execute(
        "SELECT owner_token, author_id FROM memos WHERE id = ?", (memo_id,)
    ).fetchone()

    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="그런 메모 없습니다")

    # 떼기와 같은 규칙: 내가 붙인 것만 고칠 수 있다 (관리자는 예외)
    if not _may_touch(row, new_data.token, new_data.owner_token):
        conn.close()
        raise HTTPException(status_code=403, detail="내가 붙인 포스트잇만 고칠 수 있습니다")

    conn.execute(
        "UPDATE memos SET title = ?, content = ? WHERE id = ?",
        (title, content, memo_id),
    )
    conn.commit()
    conn.close()

    return {"id": memo_id, "title": title, "content": content}


@app.delete("/memos/{memo_id}")
def delete_memo(memo_id: int, owner_token: str = None, token: str = None):
    conn = get_conn()
    row = conn.execute(
        "SELECT owner_token, author_id FROM memos WHERE id = ?", (memo_id,)
    ).fetchone()

    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="그런 메모 없습니다")

    # 화면에서 떼기 버튼을 숨기는 것만으로는 막을 수 없어서 서버에서 한 번 더 확인한다.
    # 주인 표시가 없는 옛날 메모는 관리자만 뗄 수 있다
    if not _may_touch(row, token, owner_token):
        conn.close()
        raise HTTPException(status_code=403, detail="내가 붙인 포스트잇만 뗄 수 있습니다")

    conn.execute("DELETE FROM memos WHERE id = ?", (memo_id,))
    conn.commit()
    conn.close()

    return {"ok": True, "deleted_id": memo_id}


class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/signup")
def signup(body: LoginIn):
    """계정을 만든다. 학생이 직접 만드는 건 항상 일반 계정이다."""
    name = (body.username or "").strip()

    if len(name) < 2:
        raise HTTPException(status_code=400, detail="아이디는 2글자 이상이어야 합니다")
    if len(body.password or "") < 4:
        raise HTTPException(status_code=400, detail="비밀번호는 4글자 이상이어야 합니다")
    # 아이디에도 욕이 들어갈 수 있다
    if find_blocked(name):
        raise HTTPException(status_code=400, detail="그런 아이디는 쓸 수 없습니다")

    # 관리자는 여기서 못 만든다. is_admin 은 항상 꺼진 채로 들어간다
    user_id = create_user(name, body.password, is_admin=False)
    if user_id is None:
        raise HTTPException(status_code=409, detail="이미 쓰는 아이디입니다")

    token = start_session(user_id)
    return {"token": token, "username": name, "is_admin": False}


@app.post("/login")
def login(body: LoginIn):
    user = check_login(body.username, body.password)
    if user is None:
        # 아이디가 틀렸는지 비번이 틀렸는지 알려주지 않는다
        raise HTTPException(status_code=401, detail="아이디나 비밀번호가 틀렸습니다")

    token = start_session(user["id"])
    return {"token": token, "username": user["username"],
            "is_admin": user["is_admin"]}


@app.post("/logout")
def logout(token: str = None):
    end_session(token)
    return {"ok": True}


@app.get("/me")
def me(token: str = None):
    """내가 누구인지 알려준다. 게스트면 user 가 없다."""
    user = who_is(token)
    if user is None:
        return {"user": None, "is_admin": False}
    return {"user": user["username"], "is_admin": user["is_admin"]}


@app.get("/admin/check")
def admin_check(token: str = None):
    """내가 관리자인지 알려준다. 열쇠 자체는 돌려주지 않는다."""
    return {"admin": _is_admin(token)}


# 이 줄은 항상 맨 아래! 위의 주소들을 먼저 찾고, 없으면 static 을 내려준다
app.mount("/", StaticFiles(directory=os.path.join(HERE, "static"), html=True),
          name="static")
