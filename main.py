"""Tier.gg API.

  - 로그인/가입: Riot ID + 비밀번호
  - 나만의 티어표: 내가 한 챔피언만으로 OP 1명 + 1~5티어
  - 그룹방: 초대 코드로 모인 친구들끼리 지표를 나란히 본다
  - 듀오 궁합: 같이 한 판을 찾아 승률·지표를 정리한다
  - 연습장: 스킬샷 피하기 기록과 그룹방 순위, 주간 랭킹

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

import changes
import duo
import opgg
import ranking
import tierlist
from auth import (check_by_puuid, check_login, create_account, end_session,
                  find_account, puuid_of, rename_account, riot_key, split_riot_id,
                  start_session, who_is)
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
    path = request.url.path
    if path.startswith("/dodge/") and response.status_code in (200, 304):
        if "v" in request.query_params:
            # 연습장 모델(?v=파일 내용 해시): 내용이 바뀌면 주소가 바뀌니 다시 물어볼 필요가 없다
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        elif path.startswith(_DODGE_KEEP) and not path.endswith(".json"):
            # 이펙트 텍스처·뼈대 메시·효과음(목록 json 은 빼고): 한 번 만든 파일은 고치지 않고 새 번호·새 이름으로 더한다(tools/lol_vfx.py·lol_sfx.py).
            # 연습장을 열 때마다 수백 개를 하나씩 다시 물어보느라 로딩이 몇 초 걸려서, 하루는 묻지 않고 그 뒤에는 쓰면서 뒤에서 확인한다
            response.headers.setdefault("Cache-Control", "public, max-age=86400, stale-while-revalidate=2592000")
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


_DODGE_KEEP = ("/dodge/vfx/t/", "/dodge/vfx/skin/", "/dodge/sfx/")


@app.exception_handler(opgg.NotFound)
async def _not_found(_, exc):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(opgg.Renamed)
async def _renamed(_, exc):
    # 화면이 "다시 로그인" 을 권할 수 있게 따로 알린다
    return JSONResponse(status_code=409, content={"detail": str(exc), "renamed": True})


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


def _puuid_for(name, tag, user):
    """그 이름이 가입한 사람이면 puuid. 본인 확인(opgg.profile_of) 에 쓴다."""
    if riot_key(name, tag) == riot_key(user["game_name"], user["tagline"]):
        return user["puuid"]
    return puuid_of(name, tag)


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
        raise HTTPException(status_code=409, detail="이미 가입된 LOL 계정입니다. 로그인해 주세요."
                            " 닉네임을 바꿨다면 새 닉네임으로 로그인하면 옮겨 드려요")

    return {"token": start_session(account_id), "user": find_account(account_id)}


class LoginIn(SignupIn):
    # 닉네임 변경 확인 창에서 "예" 를 누르고 다시 보낼 때 true
    confirm_rename: bool = False


@app.post("/api/login")
async def login(body: LoginIn):
    user = await asyncio.to_thread(check_login, body.riot_id, body.password)
    if user is not None:
        user = await _fix_spelling(user)
        return {"token": start_session(user["id"]), "user": user}

    moved = await _renamed_account(body.riot_id, body.password)
    if moved is None:
        # 아이디가 틀렸는지 비번이 틀렸는지 알려주지 않는다
        raise HTTPException(status_code=401, detail="LOL ID 나 비밀번호가 틀렸습니다")

    old, now = moved
    new_id = now["game_name"] + "#" + now["tagline"]
    if not body.confirm_rename:
        # 비밀번호까지 맞은 본인에게만 옛 닉네임을 보여 주고 바꿀지 묻는다
        return JSONResponse(status_code=409, content={
            "detail": "닉네임이 바뀌었는지 확인해 주세요",
            "rename": {"old": old["riot_id"], "new": new_id}})
    user = await asyncio.to_thread(
        rename_account, old["id"], now["puuid"], now["game_name"], now["tagline"])
    return {"token": start_session(user["id"]), "user": user}


async def _fix_spelling(user):
    """라이엇에서 대소문자만 바꾼 경우(Hide on bush -> HIDE ON BUSH) 표기를 맞춘다.

    riot_key 는 대소문자를 무시해서 로그인은 되지만, 화면에는 옛 표기가 남는다.
    OP.GG 가 알려 준 정확한 표기와 다르면 조용히 고친다. OP.GG 가 안 되면 그냥 둔다.
    """
    try:
        now = await opgg.profile(user["game_name"], user["tagline"])
    except opgg.OpggError:
        return user
    same_person = now["puuid"] == user["puuid"]
    spelled = (now["game_name"], now["tagline"]) != (user["game_name"], user["tagline"])
    if not (same_person and spelled):
        return user
    return await asyncio.to_thread(
        rename_account, user["id"], now["puuid"], now["game_name"], now["tagline"])


async def _renamed_account(riot_id, password):
    """새 닉네임으로 들어온 사람인지 본다. 맞으면 (옛 계정, 지금 OP.GG 프로필).

    새 닉네임은 계정 표에 없지만 puuid 는 그대로다. OP.GG 에서 새 닉네임의 puuid 를 받아
    그 puuid 로 가입한 계정이 있고 비밀번호도 맞는지 본다.
    """
    parts = split_riot_id(riot_id)
    if parts is None:
        return None
    try:
        # 이름 주인이 막 바뀌었을 수 있어서 들고 있던 것 말고 새로 묻는다
        now = await opgg.profile(*parts, fresh=True)
    except opgg.OpggError:
        return None
    old = await asyncio.to_thread(check_by_puuid, now["puuid"], password)
    if old is None or riot_key(old["game_name"], old["tagline"]) == riot_key(*parts):
        return None
    return old, now


@app.post("/api/logout")
def logout(authorization: str = Header(None)):
    end_session(_token(authorization))
    return {"ok": True}


@app.get("/api/me")
def me(authorization: str = Header(None)):
    return {"user": who_is(_token(authorization))}


@app.get("/api/stamp")
def stamp(authorization: str = Header(None)):
    """바뀐 게 있는지 보는 지문. 화면이 1분마다 부른다(DB 만 읽는다, changes.py)."""
    return changes.stamp(_need_login(authorization))


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
    return await tierlist.build(name, tag, fresh, _puuid_for(name, tag, user))


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
async def room_detail(room_id: int, fresh: bool = False, lite: bool = False,
                      authorization: str = Header(None)):
    """방 사람들의 지표를 나란히. 방에 들어온 사람만 볼 수 있다.

    lite=1 이면 OP.GG 를 부르지 않고 사람 목록만 바로 준다.
    """
    user = _need_login(authorization)
    room = _room_row(room_id)
    ids = _member_ids(room_id)
    if room is None or user["id"] not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")

    accounts = [a for a in (find_account(i) for i in ids) if a]
    head = {"id": room["id"], "name": room["name"], "code": room["code"],
            "owner_id": room["owner_id"], "me": user["id"]}
    if lite:
        # 화면이 먼저 뜨도록 사람 목록만. 카드는 /member/{id} 로 한 명씩 받는다
        return {**head, "members": [{"account_id": a["id"], "riot_id": a["riot_id"],
                                     "game_name": a["game_name"]} for a in accounts]}
    members = await asyncio.gather(*[_member_card(a, fresh) for a in accounts])
    return {**head, "members": members}


async def _member_card(acc, fresh=False):
    """그룹방 카드 한 장. OP.GG 가 실패하면 error 만 담아 돌려준다."""
    try:
        board = await tierlist.build(acc["game_name"], acc["tagline"], fresh, acc["puuid"])
    except opgg.Renamed:
        return {"account_id": acc["id"], "riot_id": acc["riot_id"],
                "game_name": acc["game_name"], "renamed": True,
                "error": "닉네임이 바뀐 것 같아요. 본인이 새 닉네임으로 로그인하면 다시 보여요"}
    except opgg.OpggError as e:
        return {"account_id": acc["id"], "riot_id": acc["riot_id"],
                "game_name": acc["game_name"], "error": str(e)}

    # 방 화면에는 그림과 이름만 있으면 된다(판 기록까지 보내면 무거워진다)
    def slim(c):
        return {"id": c["id"], "name": c["name"], "image": c["image"],
                "score": c["score"], "perf": (c.get("perf") or {}).get("overall")}
    return {**board["player"], "account_id": acc["id"],
            "op": slim(board["op"]) if board["op"] else None,
            "tiers": {t: [slim(c) for c in cs] for t, cs in board["tiers"].items()},
            "bracket": board["bracket"]}


@app.get("/api/rooms/{room_id}/member/{account_id}")
async def room_member(room_id: int, account_id: int, fresh: bool = False,
                      authorization: str = Header(None)):
    """그룹방 카드 한 장. 나도 그 사람도 이 방에 있어야 볼 수 있다."""
    user = _need_login(authorization)
    ids = _member_ids(room_id)
    if user["id"] not in ids or account_id not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")
    acc = find_account(account_id)
    if acc is None:
        raise HTTPException(status_code=404, detail="그 사람을 찾지 못했습니다")
    return await _member_card(acc, fresh)


@app.get("/api/rooms/{room_id}/members")
def room_members(room_id: int, authorization: str = Header(None)):
    """방 사람들의 Riot ID 만. 듀오 화면에서 친구를 고를 때 쓴다."""
    user = _need_login(authorization)
    ids = _member_ids(room_id)
    if user["id"] not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")
    return {"members": [a["riot_id"] for a in (find_account(i) for i in ids) if a]}


def _room_accounts(room_id, user):
    """방 사람들의 계정. 내가 그 방에 없으면 404."""
    ids = _member_ids(room_id)
    if user["id"] not in ids:
        raise HTTPException(status_code=404, detail="방을 찾지 못했습니다")
    return [a for a in (find_account(i) for i in ids) if a]


@app.get("/api/rooms/{room_id}/dodge")
def room_dodge(room_id: int, authorization: str = Header(None)):
    """방 사람들의 스킬샷 피하기 순위. DB 만 읽어서 바로 나온다."""
    user = _need_login(authorization)
    return {**ranking.dodge_board(_room_accounts(room_id, user)), "me": user["id"]}


@app.get("/api/rooms/{room_id}/weekly")
def room_weekly(room_id: int, authorization: str = Header(None)):
    """이번 주 방 사람들의 성적. 쌓아 둔 경기만 읽는다(OP.GG 는 안 부른다)."""
    user = _need_login(authorization)
    return {**ranking.weekly(_room_accounts(room_id, user)), "me": user["id"]}


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
    return await duo.compare(a_name, a_tag, b_name, b_tag, fresh,
                             _puuid_for(a_name, a_tag, user), _puuid_for(b_name, b_tag, user))


# ── 연습장: 스킬샷 피하기 ────────────────────────────────

class DodgeEnd(BaseModel):
    run: str
    ms: int
    dodged: int = 0
    ver: int | str = 1      # 게임 버전 "20.0.0"(예전 화면은 정수, 아주 예전 화면은 보내지 않는다 = 1)
    mode: str = "normal"   # normal | hard


@app.post("/api/dodge/start")
def dodge_start(authorization: str = Header(None)):
    """판을 시작할 때 표를 끊는다. 끝났을 때 이 표로 기록이 말이 되는지 본다."""
    user = _need_login(authorization)
    return {"run": ranking.start_run(user["id"])}


@app.post("/api/dodge/finish")
def dodge_finish(body: DodgeEnd, authorization: str = Header(None)):
    user = _need_login(authorization)
    try:
        return ranking.finish_run(user["id"], body.run, body.ms, body.dodged, body.ver, body.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/dodge/me")
def dodge_me(authorization: str = Header(None)):
    return ranking.my_dodge(_need_login(authorization)["id"])


# 이 줄은 항상 맨 아래! 위의 주소들을 먼저 찾고, 없으면 static 을 내려준다
app.mount("/", StaticFiles(directory=os.path.join(HERE, "static"), html=True),
          name="static")
