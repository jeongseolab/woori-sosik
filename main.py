"""Tier.gg API.

  - 로그인/가입: Riot ID + 비밀번호
  - 나만의 티어표: 내가 한 챔피언만으로 OP 1명 + 1~5티어
  - 그룹방: 초대 코드로 모인 친구들끼리 지표를 나란히 본다
  - 듀오 궁합: 같이 한 판을 찾아 승률·지표를 정리한다

로그인 표(token) 는 Authorization: Bearer <token> 머리글로 받는다.
"""
import asyncio
import os
import secrets
from datetime import datetime

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import duo
import opgg
import tierlist
from auth import (check_login, create_account, end_session, find_account,
                  split_riot_id, start_session, who_is)
from database import get_conn, init_db

# 서버를 어느 폴더에서 켜든 파일을 찾을 수 있게, 이 파일 위치를 기준으로 잡는다
HERE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="Tier.gg")
init_db()


@app.middleware("http")
async def _always_fresh(request, call_next):
    """화면 파일(html/css/js) 은 브라우저가 매번 새 버전인지 물어보게 한다.

    이게 없으면 브라우저가 예전 app.js 를 저장해 두고 계속 써서,
    새로 배포해도 폰에서는 옛 화면이 나왔다. 바뀌지 않았으면 304 로 짧게 끝난다.
    """
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.exception_handler(opgg.NotFound)
async def _not_found(_, exc):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(opgg.OpggError)
async def _opgg_down(_, exc):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


def _token(authorization):
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def _need_login(authorization):
    user = who_is(_token(authorization))
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return user


def _riot_id_or_400(text):
    parts = split_riot_id(text)
    if parts is None:
        raise HTTPException(status_code=400, detail="LOL ID 는 닉네임과 태그(# 뒤)를 모두 적어 주세요")
    return parts


@app.get("/api/health")
def health():
    """깨우기 신호용. DB 와 OP.GG 는 건드리지 않는다.

    GitHub Actions 가 10분마다 불러서 Render 무료 서버가 잠들지 않게 한다.
    DB 까지 깨우면 Neon 무료 사용 시간이 줄어서 일부러 아무것도 안 한다.
    """
    return {"ok": True}


# ── 로그인 ───────────────────────────────────────────────

class SignupIn(BaseModel):
    riot_id: str
    password: str


@app.post("/api/signup")
async def signup(body: SignupIn):
    name, tag = _riot_id_or_400(body.riot_id)
    if len(body.password or "") < 6:
        raise HTTPException(status_code=400, detail="비밀번호는 6글자 이상이어야 합니다")

    # 정말 있는 계정인지 OP.GG 에 물어보고, 대소문자까지 정확한 이름으로 저장한다
    p = await opgg.profile(name, tag, fresh=True)
    # 비밀번호 해시는 일부러 느리다. 그동안 다른 요청이 멈추지 않게 따로 돌린다
    account_id = await asyncio.to_thread(
        create_account, p["game_name"], p["tagline"], p["puuid"], body.password)
    if account_id is None:
        raise HTTPException(status_code=409, detail="이미 가입된 LOL 계정입니다. 로그인해 주세요")

    return {"token": start_session(account_id), "user": find_account(account_id)}


@app.post("/api/login")
def login(body: SignupIn):
    user = check_login(body.riot_id, body.password)
    if user is None:
        # 아이디가 틀렸는지 비번이 틀렸는지 알려주지 않는다
        raise HTTPException(status_code=401, detail="LOL ID 나 비밀번호가 틀렸습니다")
    return {"token": start_session(user["id"]), "user": user}


@app.post("/api/logout")
def logout(authorization: str = Header(None)):
    end_session(_token(authorization))
    return {"ok": True}


@app.get("/api/me")
def me(authorization: str = Header(None)):
    return {"user": who_is(_token(authorization))}


# ── 티어표 ───────────────────────────────────────────────

@app.get("/api/tierlist")
async def get_tierlist(riot_id: str = None, fresh: bool = False,
                       authorization: str = Header(None)):
    """riot_id 가 없으면 내 티어표."""
    user = _need_login(authorization)
    if riot_id:
        name, tag = _riot_id_or_400(riot_id)
    else:
        name, tag = user["game_name"], user["tagline"]
    return await tierlist.build(name, tag, fresh)


# ── 그룹방 ───────────────────────────────────────────────

class RoomIn(BaseModel):
    name: str


class JoinIn(BaseModel):
    code: str


def _room_row(room_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    conn.close()
    return row


def _member_ids(room_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT account_id FROM room_members WHERE room_id = ? ORDER BY joined_at",
        (room_id,)).fetchall()
    conn.close()
    return [r["account_id"] for r in rows]


def _add_member(room_id, account_id):
    conn = get_conn()
    conn.execute(
        "INSERT INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)"
        " ON CONFLICT (room_id, account_id) DO NOTHING",
        (room_id, account_id, datetime.now().isoformat()))
    conn.commit()
    conn.close()


@app.get("/api/rooms")
def my_rooms(authorization: str = Header(None)):
    user = _need_login(authorization)
    conn = get_conn()
    rows = conn.execute(
        "SELECT r.id, r.name, r.code, r.owner_id,"
        " (SELECT COUNT(*) FROM room_members m2 WHERE m2.room_id = r.id) AS members"
        " FROM rooms r JOIN room_members m ON m.room_id = r.id"
        " WHERE m.account_id = ? ORDER BY r.id DESC", (user["id"],)).fetchall()
    conn.close()
    return {"rooms": [dict(r) for r in rows]}


@app.post("/api/rooms", status_code=201)
def create_room(body: RoomIn, authorization: str = Header(None)):
    user = _need_login(authorization)
    name = (body.name or "").strip()
    if not 1 <= len(name) <= 30:
        raise HTTPException(status_code=400, detail="방 이름은 1~30글자로 지어 주세요")

    # 헷갈리는 글자(0/O, 1/I) 는 뺀 6글자 코드
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(5):
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        conn = get_conn()
        try:
            cur = conn.execute(
                "INSERT INTO rooms (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)",
                (name, code, user["id"], datetime.now().isoformat()))
            conn.commit()
        except Exception as e:
            # 코드가 겹쳤으면(UNIQUE) 새로 뽑는다. 다른 고장은 그대로 알린다
            text = (str(e) + type(e).__name__).lower()
            if "unique" not in text and "duplicate" not in text:
                raise
            continue
        finally:
            conn.close()
        room_id = cur.lastrowid
        _add_member(room_id, user["id"])
        return {"id": room_id, "name": name, "code": code}
    raise HTTPException(status_code=500, detail="방 코드를 만들지 못했습니다. 다시 시도해 주세요")


@app.post("/api/rooms/join")
def join_room(body: JoinIn, authorization: str = Header(None)):
    user = _need_login(authorization)
    conn = get_conn()
    row = conn.execute("SELECT * FROM rooms WHERE code = ?",
                       ((body.code or "").strip().upper(),)).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="그 코드의 방이 없습니다. 코드를 다시 확인해 주세요")
    _add_member(row["id"], user["id"])
    return {"id": row["id"], "name": row["name"], "code": row["code"]}


@app.get("/api/rooms/{room_id}")
async def room_detail(room_id: int, fresh: bool = False, authorization: str = Header(None)):
    """방 사람들의 지표를 나란히. 방에 들어온 사람만 볼 수 있다."""
    user = _need_login(authorization)
    room = _room_row(room_id)
    ids = _member_ids(room_id)
    if room is None or user["id"] not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")

    accounts = [a for a in (find_account(i) for i in ids) if a]

    async def one(acc):
        try:
            board = await tierlist.build(acc["game_name"], acc["tagline"], fresh)
        except opgg.OpggError as e:
            return {"account_id": acc["id"], "riot_id": acc["riot_id"], "error": str(e)}
        # 방 화면에는 그림과 이름만 있으면 된다(판 기록까지 보내면 무거워진다)
        def slim(c):
            return {"id": c["id"], "name": c["name"], "image": c["image"],
                    "score": c["score"], "perf": (c.get("perf") or {}).get("overall")}
        return {**board["player"], "account_id": acc["id"],
                "op": slim(board["op"]) if board["op"] else None,
                "tiers": {t: [slim(c) for c in cs] for t, cs in board["tiers"].items()},
                "bracket": board["bracket"]}

    members = await asyncio.gather(*[one(a) for a in accounts])
    return {"id": room["id"], "name": room["name"], "code": room["code"],
            "owner_id": room["owner_id"], "me": user["id"], "members": members}


@app.get("/api/rooms/{room_id}/members")
def room_members(room_id: int, authorization: str = Header(None)):
    """방 사람들의 Riot ID 만. 듀오 화면에서 친구를 고를 때 쓴다."""
    user = _need_login(authorization)
    ids = _member_ids(room_id)
    if user["id"] not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")
    return {"members": [a["riot_id"] for a in (find_account(i) for i in ids) if a]}


@app.delete("/api/rooms/{room_id}/me")
def leave_room(room_id: int, authorization: str = Header(None)):
    """방에서 나간다. 마지막 사람이 나가면 방도 없앤다."""
    user = _need_login(authorization)
    conn = get_conn()
    conn.execute("DELETE FROM room_members WHERE room_id = ? AND account_id = ?",
                 (room_id, user["id"]))
    left = conn.execute("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?",
                        (room_id,)).fetchone()
    if left["n"] == 0:
        conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 듀오 궁합 ────────────────────────────────────────────

@app.get("/api/duo")
async def duo_check(partner: str, me_id: str = None, fresh: bool = False,
                    authorization: str = Header(None)):
    """나(또는 me_id) 와 partner 의 궁합."""
    user = _need_login(authorization)
    b_name, b_tag = _riot_id_or_400(partner)
    if me_id:
        a_name, a_tag = _riot_id_or_400(me_id)
    else:
        a_name, a_tag = user["game_name"], user["tagline"]
    if (a_name + "#" + a_tag).replace(" ", "").lower() == (b_name + "#" + b_tag).replace(" ", "").lower():
        raise HTTPException(status_code=400, detail="다른 사람의 Riot ID 를 넣어 주세요")
    return await duo.compare(a_name, a_tag, b_name, b_tag, fresh)


# 이 줄은 항상 맨 아래! 위의 주소들을 먼저 찾고, 없으면 static 을 내려준다
app.mount("/", StaticFiles(directory=os.path.join(HERE, "static"), html=True),
          name="static")
