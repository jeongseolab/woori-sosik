"""상점을 쓸 수 있는지(우물·죽음) 를 롤 Live Client API 값으로 가린다. 작은 창을 자동으로 띄우고 내리는 데 쓴다.

롤 API 에는 "상점 범위 안" 표시도, 챔피언 위치도 없다. 2026-11-13 실제 게임(봇전, 30분) 을 0.5초마다 적어 보고 정한 신호:
  - 우물: 이동 속도가 평소의 1.5~1.8배(536~732) 로 뛰고 우물 안에서는 같은 값으로 고정(서 있어도 걸어도, 25초 동안 732.4).
    체력이 깎인 채 들어오면 0.5초마다 최대 체력의 3~10% 씩 찬다(healthRegenRate 값은 그대로라 체력이 실제로 오르는 것을 본다)
  - 우물을 나감: 이동 속도가 고정값에서 떨어져 몇 초에 걸쳐 평소로 줄어든다
  - 라인의 이속 버프(스킬·유체화·신발): 1.3배 안팎으로 잠깐, 곧 줄어든다. 우물처럼 체력이 연달아 크게 차지 않는다
  - 죽어 있을 때는 늘 살 수 있다. 템을 사거나 팔면(가방이 바뀌고 골드가 그만큼 움직임) 상점에 있다는 확실한 증거
그래서 이속 하나로 가리지 않는다(이속 버프 챔피언): 이속 + 우물 회복, 또는 이속이 오래 고정, 또는 사고팔기·죽음.
"""
import statistics

HIGH = 1.42         # 평소 이속의 이만큼 넘으면 '우물 이속'. 기록: 우물 1.52~1.77배, 부활 직후 1.44배,
                    # 우물을 나간 뒤 남는 이속 1.36~1.39배(약 14초), 라인의 이속 버프 1.3배 안팎
HEAL = 0.04         # 1초에 최대 체력의 이만큼 넘게 차면 '우물 회복'
HOLD = 3.0          # 체력이 꽉 차 회복이 안 보여도, 이속이 HOLD_HIGH 배 넘게 이만큼(초) 고정이고 체력이 안 줄면 우물
HOLD_HIGH = 1.5     # 마스터 이 R(최대 1.45배, 7초) 같은 고정 이속 버프와 가르려고. 귀환한 우물은 1.52배 이상
LEAVE = 1.0         # 우물 이속에서 떨어진 상태가 이만큼(초) 이어지면 나간 것(나가면 2초 동안 줄다가 1.4배쯤에 머문다)
START = 20.0        # 게임 시작 뒤 이만큼(초) 은 우물에서 시작


class ShopWatch:
    def __init__(self):
        self.reset()

    def reset(self):
        self.in_shop = False
        self.lane_ms = []          # 상점 밖에서 본 이속
        self.prev = None
        self.plateau = None        # (이속, 시작 시각): 같은 이속이 이어진 구간
        self.fountain = None       # 우물 안의 이속(이 값에서 떨어지면 나간 것)
        self.away = None           # 우물 이속에서 떨어진 시각
        self.reason = ""

    def _base(self):
        """평소 이속: 최근 상점 밖 이속 중 가장 자주 나온 값(싸움 중 둔화·버프에 흔들리지 않게 중앙값 대신)."""
        recent = [round(x) for x in self.lane_ms[-120:]]
        if not recent:
            return None
        return max(set(recent), key=lambda v: (recent.count(v), -v))

    def update(self, s):
        """s: {t, gold, hp, maxhp, ms, dead, items}. 돌려줌: 지금 상점을 쓸 수 있나(bool)."""
        p, self.prev = self.prev, s
        if p is not None and s["t"] < p["t"] - 1:          # 새 게임(시간이 거꾸로)
            self.reset()
            p, self.prev = None, s
        t, ms = s["t"], s["ms"]
        if s.get("dead"):
            self.fountain = None
            return self._set(True, "죽음")
        # 같은 이속이 이어진 구간(±1%)
        if self.plateau and abs(ms - self.plateau[0]) <= self.plateau[0] * 0.01 and s["hp"] >= self.plateau[2] - 1:
            held = t - self.plateau[1]
        else:
            self.plateau, held = (ms, t, s["hp"]), 0.0
        base = self._base()
        high = base is not None and ms >= base * HIGH
        dt = (t - p["t"]) if p else 0
        healing = bool(p and 0 < dt <= 1.5 and s["maxhp"] and not p.get("dead") and s["maxhp"] == p["maxhp"]
                       and (s["hp"] - p["hp"]) / dt >= HEAL * s["maxhp"])
        traded = bool(p and s["items"] != p["items"] and not p.get("dead")
                      and (s["gold"] < p["gold"] - 1 or s["gold"] > p["gold"] + 50))
        respawned = bool(p and p.get("dead"))
        if t < START:
            self.fountain = ms
            return self._set(True, "게임 시작")
        if not self.in_shop:
            why = ("부활" if respawned else "사고팖" if traded else "우물 회복" if high and healing
                   else "우물 이속" if base and ms >= base * HOLD_HIGH and held >= HOLD else None)
            if why:
                self.fountain = ms
                return self._set(True, why)
            self.lane_ms.append(ms)
            return False
        # 상점 안: 우물 이속(들어올 때 값, 신발을 사면 바뀐 값) 에 머물면 그대로
        if traded or (high and held >= 1.0):
            self.fountain = ms                       # 이속 템을 샀거나 우물 안에서 값이 바뀜
        if traded or healing or (self.fountain and ms >= self.fountain * 0.97):
            self.away = None
            return True
        if self.away is None:
            self.away = t
        if t - self.away >= LEAVE:
            return self._set(False, "우물을 나감")
        return True

    def _set(self, on, why):
        if on != self.in_shop:
            self.reason = why
        self.in_shop = on
        if on:
            self.away = None
        return on
