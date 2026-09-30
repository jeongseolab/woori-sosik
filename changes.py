"""바뀐 게 있는지 알려 주는 지문(stamp).

화면은 한 번 받은 것을 기억해 두고 다시 받지 않는다(app.js 의 load).
그 대신 1분마다 이 지문만 받아 보고, 지난번과 다른 항목만 다시 받는다.
DB 만 읽고 OP.GG 는 부르지 않아서 가볍다.

항목(값은 짧은 글자. 뜻은 없고 같은지만 본다):
  rooms       내가 들어간 방 목록(번호·이름)
  room:ID     그 방 사람들
  dodge:ID    그 방 사람들의 무빙 기록(판수·마지막 판 시각)
  games:ID    그 방 사람들의 쌓인 경기(판수·마지막 경기 시각). 누가 새 판을 하면 바뀐다
  me:dodge    내 무빙 기록
  me:games    내 쌓인 경기
"""
from database import get_conn
from opgg import RIFT_TYPES
from ranking import DODGE_VERSION


def _marks(n):
    return ",".join("?" * n)


def stamp(user):
    conn = get_conn()
    try:
        rooms = conn.execute(
            "SELECT r.id, r.name FROM rooms r JOIN room_members m ON m.room_id = r.id"
            " WHERE m.account_id = ? ORDER BY r.id", (user["id"],)).fetchall()
        out = {"rooms": ";".join("%s:%s" % (r["id"], r["name"]) for r in rooms)}

        def dodge_mark(ids):
            row = conn.execute(
                "SELECT COUNT(*) AS n, MAX(played_at) AS last FROM dodge_runs"
                " WHERE ver = ? AND account_id IN (%s)" % _marks(len(ids)),
                (DODGE_VERSION, *ids)).fetchone()
            return "%s/%s" % (row["n"], row["last"])

        def games_mark(puuids):
            row = conn.execute(
                "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM match_rows"
                " WHERE game_type IN (?, ?, ?) AND puuid IN (%s)" % _marks(len(puuids)),
                (*RIFT_TYPES, *puuids)).fetchone()
            return "%s/%s" % (row["n"], row["last"])

        for r in rooms:
            members = conn.execute(
                "SELECT a.id, a.puuid, a.riot_key FROM room_members m JOIN accounts a ON a.id = m.account_id"
                " WHERE m.room_id = ? ORDER BY m.joined_at, a.id", (r["id"],)).fetchall()
            ids = [m["id"] for m in members]
            # 닉네임을 바꾼 사람도 바뀐 것으로 친다
            out["room:%s" % r["id"]] = ";".join("%s:%s" % (m["id"], m["riot_key"]) for m in members)
            out["dodge:%s" % r["id"]] = dodge_mark(ids)
            out["games:%s" % r["id"]] = games_mark([m["puuid"] for m in members])

        out["me:dodge"] = dodge_mark([user["id"]])
        out["me:games"] = games_mark([user["puuid"]])
        return out
    finally:
        conn.close()
