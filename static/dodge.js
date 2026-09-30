// 스킬샷 피하기. 서버 없이 이 파일만으로 돈다(기록 저장만 app.js 가 서버에 보낸다).
//
// 거리와 속도는 롤의 게임 단위(유닛) 그대로 쓰고, 그릴 때만 화면 크기에 맞춰 줄인다.
//   - 내 챔피언: 판정 반지름 65(데이터에 따로 없는 챔피언의 기본값. 블리츠·초가스는 80, 베이가는 55),
//     이동 속도 335(챔피언 기본 이동 속도 baseMoveSpeed 는 325~345, 그 가운데 값)
//   - 맞았는지: 스킬 판정(투사체 원, 장판 원, 레이저 띠, 감옥 테두리)과 내 판정 원이 겹치면 맞은 것
//   - 목숨 LIVES 개. 다 잃으면 끝. 맞은 뒤 SAFE_AFTER_HIT 초는 무적(스킬 두 개에 한꺼번에 목숨 둘을 잃지 않게).
//     스킬 하나는 한 번만 때린다(맞힌 투사체는 사라지고, 감옥은 한 번 스턴하면 끝)
// 빠른 투사체(초당 3300)가 한 프레임에 나를 뛰어넘지 않게, 1/240초씩 잘게 나눠 움직인다.
//
// 화면은 유사 3D 다. 판정과 움직임은 모두 바닥(2D) 에서 하고, 그릴 때만 롤 기본 카메라처럼
// 비스듬히 내려다보는 원근으로 옮긴다(proj). 우클릭한 화면 위치는 거꾸로 바닥 좌표로 되돌린다(unproj).
// 투사체는 공중에 떠서 날아가지만 바닥에 보이는 그림자 원이 실제 판정이다.
//
// 스킬 값의 출처(SKILLS 표의 src):
//   file  롤 클라이언트의 챔피언 데이터 파일(CommunityDragon 이 푼 characters/*.bin.json, 16.19)
//         속도 = missileSpeed(mMissileSpec), 반지름 = mLineWidth, 사거리 = castRange,
//         시전 시간 = mCastTime(없으면 spellCastTime), 장판 반지름 = castRadius
//   wiki  데이터 파일에 없는 값(장판 지연 시간 몇 개 등). 공식 롤 위키(Meraki 가 정리한 것) 값
// 스킬을 고칠 때는 이 표만 바꾸면 된다.
//
// 조작: 우클릭(누른 채 끌면 계속 따라감) 또는 WASD·방향키. 휴대폰은 화면을 누르면 이동.
// WASD 는 e.code 로 읽는다. 한글 입력 상태에서도 ㅈㅁㄴㅇ 이 아니라 WASD 로 잡힌다.

(function () {
  // 게임 규칙이 바뀌면 올린다. 서버는 같은 버전의 기록끼리만 순위를 매긴다
  const VERSION = 5;

  const ARENA = { w: 1400, h: 900 };
  const CHAMP = { radius: 65, speed: 335 };
  const STEP = 1 / 240;
  const FAR = 4000;            // 경기장보다 긴 사거리(레이저 등)
  // 가끔 스킬(rare: 애쉬 R, 럭스 R) 이 나올 확률(둘을 합쳐서). 나머지는 열린 스킬 중에서 똑같은 확률로 고른다
  const RARE_CHANCE = 0.03;
  const LIVES = 3;
  const SAFE_AFTER_HIT = 1.0;
  // 바닥 표시를 보고 움직이기 시작하기까지 걸리는 시간(사람의 반응 시간).
  // 장판은 표시가 뜬 뒤 이만큼 늦게 움직여도 빠져나갈 수 있는 자리로 찍는다
  const REACT = 0.25;

  // kind: line(투사체) circle(지연 장판) beam(지연 레이저) cage(감옥)
  // look: 투사체 생김새(그림만). 판정은 모두 앞쪽 원(반지름 radius) 하나다
  //   orb 구슬(기본) · vines 바닥을 기는 덩굴 · spear 창 · fire 화염구 · heart 하트 · bolt 짧은 광탄
  //   blade 칼날 · hook 사슬 달린 갈고리 · zap 가늘고 긴 전격 · arrow 거대한 화살
  // inner: 장판 중심부 반지름(file castRadius). 그림으로만 구분한다(맞는 건 바깥 원 기준 그대로)
  // from: 몇 초부터 나오는지. rare: 가끔만
  const SKILLS = [
    // ── 투사체 (전부 file) ──
    { kind: "line", name: "모르가나 Q", champ: "Morgana", cast: 0.25, speed: 1200, radius: 70, range: 1300, color: "#b197fc", from: 0 },
    { kind: "line", name: "럭스 Q", champ: "Lux", cast: 0.25, speed: 1200, radius: 70, range: 1300, color: "#ffe066", from: 0 },
    { kind: "line", name: "자이라 E", champ: "Zyra", cast: 0.25, speed: 1150, radius: 70, range: 1150, color: "#69db7c", from: 0, look: "vines" },
    { kind: "line", name: "니달리 Q", champ: "Nidalee", cast: 0.25, speed: 1300, radius: 40, range: 1500, color: "#8ce99a", from: 8, look: "spear" },
    { kind: "line", name: "브랜드 Q", champ: "Brand", cast: 0.25, speed: 1600, radius: 60, range: 1100, color: "#ff8787", from: 8, look: "fire" },
    { kind: "line", name: "아리 E", champ: "Ahri", cast: 0.25, speed: 1550, radius: 60, range: 1000, color: "#faa2c1", from: 15, look: "heart" },
    // 벨코즈 Q 는 내 옆을 지날 때(벨코즈가 다시 눌러서) 또는 사거리 끝에서 양옆 직각으로 갈라진다.
    // 갈라지기 telegraph 초 전부터 구슬이 부풀며 번쩍인다(SplitTelegraphTime). 롤처럼 갈라질 경로는 안 보여 준다.
    // 갈라진 것은 VelkozQMissileSplit
    { kind: "line", name: "벨코즈 Q", champ: "Velkoz", cast: 0.251, speed: 1300, radius: 50, range: 1100, color: "#d0bfff", from: 15,
      split: { speed: 2100, radius: 45, range: 1100, telegraph: 0.25 } },
    { kind: "line", name: "제라스 E", champ: "Xerath", cast: 0.25, speed: 1400, radius: 60, range: 1125, color: "#91a7ff", from: 15 },
    { kind: "line", name: "이즈리얼 Q", champ: "Ezreal", cast: 0.25, speed: 2000, radius: 60, range: 1200, color: "#74c0fc", from: 25, look: "bolt" },
    { kind: "line", name: "레오나 E", champ: "Leona", cast: 0.25, speed: 2000, radius: 70, range: 900, color: "#ffd43b", from: 25, look: "blade" },
    { kind: "line", name: "베이가 Q", champ: "Veigar", cast: 0.25, speed: 2200, radius: 70, range: 1050, color: "#9775fa", from: 25 },
    { kind: "line", name: "블리츠크랭크 Q", champ: "Blitzcrank", cast: 0.25, speed: 1800, radius: 70, range: 1080, color: "#ffc078", from: 35, look: "hook" },
    { kind: "line", name: "쓰레쉬 Q", champ: "Thresh", cast: 0.5, speed: 1900, radius: 70, range: 1100, color: "#63e6be", from: 35, look: "hook" },
    { kind: "line", name: "징크스 W", champ: "Jinx", cast: 0.6, speed: 3300, radius: 60, range: 1500, color: "#f783ac", from: 50, look: "zap" },
    // 애쉬 R 은 1500 에서 시작해 초당 200 씩 빨라져 2100 까지(AcceleratingMovement)
    { kind: "line", name: "애쉬 R", champ: "Ashe", cast: 0.25, speed: 1500, accel: 200, maxSpeed: 2100, radius: 130, range: FAR, color: "#a5d8ff", from: 50, rare: true, look: "arrow" },

    // ── 지연 장판: 시전 → 바닥에 표시 → delay 초 뒤 터짐 ──
    { kind: "circle", name: "카서스 Q", champ: "Karthus", cast: 0.25, delay: 0.528, radius: 160, range: 875, color: "#b2f2bb", from: 0, src: "delay: wiki" },
    { kind: "circle", name: "브랜드 W", champ: "Brand", cast: 0.25, delay: 0.627, radius: 240, range: 900, color: "#ff922b", from: 0, src: "delay: wiki" },
    { kind: "circle", name: "초가스 Q", champ: "Chogath", cast: 0.5, delay: 0.627, radius: 230, range: 950, color: "#a9e34b", from: 8, src: "cast, delay: wiki" },
    { kind: "circle", name: "베이가 W", champ: "Veigar", cast: 0.25, delay: 1.2, radius: 225, range: 950, color: "#7950f2", from: 8 },
    { kind: "circle", name: "신드라 Q", champ: "Syndra", cast: 0, delay: 0.6, radius: 180, range: 800, color: "#e599f7", from: 15, src: "cast(없음), delay: wiki" },
    { kind: "circle", name: "제라스 W", champ: "Xerath", cast: 0.25, delay: 0.5, radius: 250, inner: 100, range: 1000, color: "#748ffc", from: 15 },
    // 벨코즈 E 는 멀리 던질수록 늦게 떨어진다: 0.25초(가까이) ~ 0.55초(사거리 끝)
    { kind: "circle", name: "벨코즈 E", champ: "Velkoz", cast: 0.25, delay: 0.25, delayFar: 0.55, radius: 225, range: 800, color: "#cc5de8", from: 25 },
    { kind: "circle", name: "레오나 R", champ: "Leona", cast: 0.25, delay: 0.625, radius: 300, inner: 120, range: 1200, color: "#fab005", from: 25, src: "delay: wiki" },

    // ── 지연 레이저: 시전하는 동안 가는 선이 보이고, 끝나는 순간 선 전체를 친다 ──
    { kind: "beam", name: "진 W", champ: "Jhin", cast: 0.75, radius: 40, range: FAR, color: "#ff6b6b", from: 35 },
    // 럭스 R 반지름은 데이터 LuxR 의 mLineWidth(190). 시전 시간은 데이터에 없어 위키 값(1초)
    { kind: "beam", name: "럭스 R", champ: "Lux", cast: 1.0, radius: 190, range: FAR, color: "#fff3bf", from: 50, rare: true, src: "cast: wiki" },

    // ── 감옥: 시전 → delay 초 뒤 테두리가 서고 last 초 동안 남는다. 테두리에 닿으면 맞은 것 ──
    { kind: "cage", name: "베이가 E", champ: "Veigar", cast: 0.25, delay: 0.5, last: 3, radius: 390, range: 700, color: "#845ef7", from: 35, src: "last: wiki" },
  ];

  const IMG = {};
  function champImage(key) {
    if (!IMG[key]) {
      const img = new Image();
      img.src = "https://opgg-static.akamaized.net/meta/images/lol/latest/champion/" + key + ".png";
      IMG[key] = img;
    }
    return IMG[key];
  }
  // 게임이 시작되기 전에 미리 받아 둔다. 못 받아도 원으로 그린다
  function preload() { SKILLS.forEach(s => champImage(s.champ)); }

  // 시간이 갈수록 자주, 더 영리하게 쏜다
  function castGap(t) { return Math.max(0.34, 1.25 * Math.pow(0.97, t / 2)); }
  function leadChance(t) { return Math.min(0.45, t / 150); }

  function fmt(sec) {
    const s = Math.floor(sec), cs = Math.floor((sec - s) * 100);
    return s + "." + String(cs).padStart(2, "0") + "초";
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // 점 p 에서 선분 ab 까지의 거리
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
  }

  function mount(root, opts = {}) {
    root.innerHTML = `
      <div class="dodge-hud">
        <span>버틴 시간 <b data-hud="time">0.00초</b></span>
        <span>목숨 <b data-hud="lives" class="dodge-lives"></b></span>
        <span>피한 스킬 <b data-hud="dodged">0</b></span>
        <span data-hud="best"></span>
      </div>
      <div class="dodge-stage">
        <canvas aria-label="스킬샷 피하기 게임 화면"></canvas>
        <div class="dodge-over" data-over></div>
      </div>`;
    const canvas = root.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const over = root.querySelector("[data-over]");
    const hud = name => root.querySelector(`[data-hud="${name}"]`);
    preload();

    let state = "ready";       // ready | play | over
    let t = 0, dodged = 0, acc = 0, last = 0, nextCast = 0, raf = 0;
    let player, target, casters, missiles, zones, flashes;
    let lives, hits, safe, lastHit, dead;
    let fx, parts, shake, hurt;          // 그림 효과(판정과 상관없음)
    const keys = new Set();
    let holding = false;

    function reset() {
      player = { x: ARENA.w / 2, y: ARENA.h / 2, vx: 0, vy: 0 };
      target = null;
      casters = [];      // 시전 중인 적
      missiles = [];     // 날아가는 투사체
      zones = [];        // 바닥 장판·감옥
      flashes = [];      // 레이저가 지나간 자리(그림만)
      fx = [];           // 빛기둥·퍼지는 고리
      parts = [];        // 튀는 파편
      shake = 0;         // 화면 흔들림 남은 시간
      hurt = 0;          // 맞았을 때 붉은 테두리 남은 시간
      lives = LIVES;
      hits = [];         // 맞은 스킬 이름(끝 화면에 보여 준다)
      safe = 0;          // 남은 무적 시간
      lastHit = null;
      dead = false;
      t = 0; dodged = 0; acc = 0;
      nextCast = 0.8;          // 시작하고 잠깐은 숨 돌릴 틈
    }

    // ── 유사 3D 시점 ──
    // 카메라는 경기장 가운데를 PITCH 만큼 내려다본다. 판정에는 쓰지 않고 그릴 때만 쓴다
    const PITCH = 56 * Math.PI / 180;
    const CAM_D = 2300, FOCAL = 1500;
    const COS = Math.cos(PITCH), SIN = Math.sin(PITCH);
    let S = 1, OX = 0, OY = 0, VW = 0, VH = 0, DPR = 1;   // 배율·원점·화면 크기(CSS 픽셀)

    // 바닥 좌표(x, y) 와 높이 z -> 화면 좌표. k: 그 깊이에서 1유닛이 몇 픽셀인지
    function proj(x, y, z = 0) {
      const dy = (y - ARENA.h / 2) - CAM_D * COS, dz = z - CAM_D * SIN;
      const yc = -dy * SIN + dz * COS;
      const zc = -dy * COS - dz * SIN;
      const k = FOCAL / zc * S;
      return { x: OX + (x - ARENA.w / 2) * k, y: OY - yc * k, k };
    }

    // 서 있는 것(캐릭터·초상화·투사체) 은 롤처럼 화면에서 똑바로 세운다.
    // 그냥 proj 로 높이를 올리면 원근 때문에 화면 가장자리에서 가운데 쪽으로 기울어 보인다
    function upright(x, y, h) {
      const b = proj(x, y, 0);
      return { x: b.x, y: b.y - h * COS * b.k, k: b.k };
    }

    // 화면 좌표 -> 바닥 좌표. 카메라에서 그 점으로 뻗은 선이 바닥과 만나는 곳
    function unproj(sx, sy) {
      const vx = (sx - OX) / S, vy = (sy - OY) / S;
      const tt = CAM_D * SIN / (vy * COS + FOCAL * SIN);
      return { x: ARENA.w / 2 + vx * tt, y: ARENA.h / 2 + CAM_D * COS + tt * (vy * SIN - FOCAL * COS) };
    }

    // ── 화면 크기 ──
    function fit() {
      // 가로는 칸에 꽉 차게, 단 세로가 창 안에 다 들어오게 줄인다(게임 중에 스크롤하면 안 되니까)
      const stage = canvas.parentElement;
      const room = Math.max(220, window.innerHeight - Math.max(0, stage.getBoundingClientRect().top + window.scrollY) - 16);
      // 배율 1 로 경기장 네 귀퉁이(와 먼 쪽 위로 선 것들) 가 화면 어디에 오는지 본다
      S = 1; OX = 0; OY = 0;
      const side = 70;
      const pts = [[0, 0, 0], [ARENA.w, 0, 0], [-side, ARENA.h, 0], [ARENA.w + side, ARENA.h, 0], [-side, 0, 240], [ARENA.w + side, 0, 240]]
        .map(([x, y, z]) => proj(x, y, z));
      const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
      const pad = 12;
      S = Math.min((stage.clientWidth - pad * 2) / (maxX - minX), (room - pad * 2) / (maxY - minY));
      VW = Math.floor(Math.min(stage.clientWidth, (maxX - minX) * S + pad * 2));
      VH = Math.floor((maxY - minY) * S + pad * 2);
      OX = VW / 2 - (minX + maxX) / 2 * S;
      OY = pad - minY * S;
      DPR = window.devicePixelRatio || 1;
      canvas.style.width = VW + "px";
      canvas.style.height = VH + "px";
      canvas.width = Math.round(VW * DPR);
      canvas.height = Math.round(VH * DPR);
      draw(0);
    }

    function toArena(e) {
      const r = canvas.getBoundingClientRect();
      const p = unproj(e.clientX - r.left, e.clientY - r.top);
      // 경기장 밖을 찍으면 가장자리까지만 간다
      return { x: Math.min(ARENA.w, Math.max(0, p.x)), y: Math.min(ARENA.h, Math.max(0, p.y)) };
    }

    // ── 스킬 고르기 ──
    function pickSkill() {
      let open = SKILLS.filter(s => s.from <= t);
      // 감옥은 한 번에 하나만
      if (zones.some(z => z.skill.kind === "cage") || casters.some(c => c.skill.kind === "cage")) {
        open = open.filter(s => s.kind !== "cage");
      }
      const rare = open.filter(s => s.rare);
      if (rare.length && Math.random() < RARE_CHANCE) return rare[Math.floor(Math.random() * rare.length)];
      const common = open.filter(s => !s.rare);
      return common[Math.floor(Math.random() * common.length)];
    }

    function edgePoint() {
      // 테두리 위의 아무 점
      const p = Math.random() * 2 * (ARENA.w + ARENA.h);
      if (p < ARENA.w) return { x: p, y: 0 };
      if (p < ARENA.w + ARENA.h) return { x: ARENA.w, y: p - ARENA.w };
      if (p < 2 * ARENA.w + ARENA.h) return { x: p - ARENA.w - ARENA.h, y: ARENA.h };
      return { x: 0, y: p - 2 * ARENA.w - ARENA.h };
    }

    // 쏘는 사람 자리. 롤에서처럼 사거리 끝 가까이에서 쏘게 한다.
    // 투사체·레이저: 나와의 거리가 사거리의 60~100% 인 곳을 먼저 고른다(너무 가까우면 못 피한다)
    // 장판·감옥: 노리는 곳이 사거리 안에 드는 곳
    function castFrom(skill, aim) {
      const tries = Array.from({ length: 24 }, edgePoint);
      if (skill.kind === "line" || skill.kind === "beam") {
        const reach = Math.min(skill.range, FAR);
        const good = tries.filter(p => { const d = dist(p, player); return d >= Math.min(600, reach * 0.6) && d <= reach; });
        if (good.length) return good[Math.floor(Math.random() * good.length)];
        return tries.reduce((a, b) => (dist(b, player) > dist(a, player) ? b : a));
      }
      const inRange = tries.filter(p => dist(p, aim) <= skill.range);
      if (inRange.length) return inRange[Math.floor(Math.random() * inRange.length)];
      return tries.reduce((a, b) => (dist(b, aim) < dist(a, aim) ? b : a));
    }

    function cast() {
      const skill = pickSkill();
      if (!skill) return;
      // 롤처럼 누르는 순간 노리는 곳이 정해진다. 가끔은 내가 갈 곳을 앞질러 노린다
      const ground = skill.kind === "circle" || skill.kind === "cage";
      const lead = Math.random() < leadChance(t);
      let aim = { x: player.x, y: player.y }, at0;
      if (ground) {
        // 바닥 스킬은 노릴 곳을 먼저 정하고, 거기가 사거리 안에 드는 자리에서 쏜다
        if (lead) {
          const ahead = skill.cast + skill.delay;
          aim = { x: player.x + player.vx * ahead, y: player.y + player.vy * ahead };
        }
        // 감옥은 실제 베이가처럼 대개 테두리를 내 몸에 걸치게 쓴다(안으로 들어가거나 밖으로 나가야 산다).
        // 가끔은 나를 한가운데 가둔다
        if (skill.kind === "cage" && Math.random() < 0.7) {
          const a = Math.random() * Math.PI * 2;
          aim = { x: aim.x + Math.cos(a) * skill.radius, y: aim.y + Math.sin(a) * skill.radius };
        }
        at0 = castFrom(skill, aim);
      } else {
        at0 = castFrom(skill, aim);
        if (lead) {
          const ahead = skill.cast + (skill.kind === "line" ? dist(at0, player) / skill.speed : 0);
          aim = { x: player.x + player.vx * ahead, y: player.y + player.vy * ahead };
        }
      }
      const d = dist(aim, at0) || 1;
      const c = { skill, x: at0.x, y: at0.y, dx: (aim.x - at0.x) / d, dy: (aim.y - at0.y) / d, wind: skill.cast, fade: 0.5 };
      if (ground) {
        // 사거리보다 멀리는 못 찍는다(롤도 사거리 끝으로 당겨진다)
        const r = Math.min(d, skill.range);
        c.aim = { x: at0.x + c.dx * r, y: at0.y + c.dy * r };
      }
      casters.push(c);
      if (c.wind <= 0) release(c);
    }

    // 맞았다. 무적 중이면 없던 일로(false). 목숨을 다 잃으면 끝
    function hit(s) {
      if (safe > 0 || dead) return false;
      lives -= 1;
      hits.push(s.name);
      lastHit = s;
      safe = SAFE_AFTER_HIT;
      shake = 0.25;
      hurt = 0.4;
      burst(player.x, player.y, 90, s.color, 26, 420);
      if (lives <= 0) dead = true;
      return true;
    }

    // 벨코즈 Q 가 갈라진다: 그 자리에서 양옆 직각으로 하나씩
    function splitMissile(m) {
      const sp = m.skill.split;
      const piece = { ...m.skill, name: m.skill.name + " (갈라짐)", speed: sp.speed, radius: sp.radius, range: sp.range, split: null };
      for (const side of [1, -1]) {
        missiles.push({ skill: piece, x: m.x, y: m.y, ox: m.x, oy: m.y, dx: -m.dy * side, dy: m.dx * side, speed: sp.speed, left: sp.range, flown: 0 });
      }
      burst(m.x, m.y, MISSILE_Z, m.skill.color, 14, 300);
    }

    // 장판을 찍을 자리. 수치(반지름·지연 시간)는 그대로 두고 찍는 자리만 사람처럼 한다.
    // 정중앙에 찍으면 브랜드 W(반지름 240, 0.627초) 같은 건 표시를 보자마자 달려도 못 나간다
    // (305 유닛을 가야 하는데 0.627초에 216 유닛). 그래서 표시가 뜬 뒤 REACT 초 늦게 움직여도
    // 딱 빠져나갈 만큼만 내 자리에서 비껴 찍는다. 원은 여전히 내 몸에 걸쳐서 움직이지 않으면 맞는다
    function fairSpot(aim, s, delay, c) {
      const need = s.radius + CHAMP.radius - CHAMP.speed * Math.max(0, delay - REACT);
      const d = dist(aim, player);
      if (d >= need) return aim;
      let ux, uy;
      if (d > 1) { ux = (aim.x - player.x) / d; uy = (aim.y - player.y) / d; }
      else { const a = Math.random() * Math.PI * 2; ux = Math.cos(a); uy = Math.sin(a); }
      const spot = { x: player.x + ux * need, y: player.y + uy * need };
      // 사거리 밖이면 쏘는 사람 쪽으로 당긴다(롤도 사거리 끝으로 당겨진다)
      const r = dist(spot, c);
      if (r > s.range) {
        spot.x = c.x + (spot.x - c.x) / r * s.range;
        spot.y = c.y + (spot.y - c.y) / r * s.range;
      }
      return spot;
    }

    // 시전이 끝난 순간
    function release(c) {
      const s = c.skill;
      if (s.kind === "line") {
        missiles.push({ skill: s, x: c.x, y: c.y, ox: c.x, oy: c.y, dx: c.dx, dy: c.dy, speed: s.speed, left: s.range, flown: 0 });
      } else if (s.kind === "circle") {
        // 벨코즈 E 처럼 멀리 던질수록 늦는 건, 가장 짧은 지연으로 자리를 잡고(더 넉넉한 쪽) 지연은 그 자리로 다시 잰다
        const at = fairSpot(c.aim, s, s.delay, c);
        const delay = s.delayFar ? s.delay + (s.delayFar - s.delay) * Math.min(1, dist(c, at) / s.range) : s.delay;
        zones.push({ skill: s, x: at.x, y: at.y, wait: delay, total: delay });
      } else if (s.kind === "cage") {
        zones.push({ skill: s, x: c.aim.x, y: c.aim.y, wait: s.delay, total: s.delay, up: 0 });
      } else if (s.kind === "beam") {
        const a = { x: c.x, y: c.y }, b = { x: c.x + c.dx * s.range, y: c.y + c.dy * s.range };
        if (!(segDist(player, a, b) < CHAMP.radius + s.radius && hit(s))) dodged += 1;
        flashes.push({ skill: s, a, b, left: 0.35 });
      }
    }

    // ── 한 걸음(1/240초) ──
    function step(dt) {
      t += dt;
      safe = Math.max(0, safe - dt);

      // 이동: WASD 가 눌려 있으면 그쪽으로, 아니면 찍은 곳으로
      let mx = 0, my = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) my -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) my += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
      if (mx || my) {
        target = null;
        const n = Math.hypot(mx, my);
        player.vx = mx / n * CHAMP.speed;
        player.vy = my / n * CHAMP.speed;
      } else if (target) {
        const dx = target.x - player.x, dy = target.y - player.y;
        const d = Math.hypot(dx, dy);
        if (d <= CHAMP.speed * dt) {
          player.x = target.x; player.y = target.y;
          player.vx = player.vy = 0;
          if (!holding) target = null;
        } else {
          player.vx = dx / d * CHAMP.speed;
          player.vy = dy / d * CHAMP.speed;
        }
      } else {
        player.vx = player.vy = 0;
      }
      player.x = Math.min(ARENA.w - CHAMP.radius, Math.max(CHAMP.radius, player.x + player.vx * dt));
      player.y = Math.min(ARENA.h - CHAMP.radius, Math.max(CHAMP.radius, player.y + player.vy * dt));

      // 시전
      nextCast -= dt;
      if (nextCast <= 0) {
        cast();
        // 40초가 넘으면 가끔 두 명이 같이 쏜다
        if (t > 40 && Math.random() < Math.min(0.35, (t - 40) / 120)) cast();
        nextCast = castGap(t);
      }
      for (const c of casters) {
        if (c.wind > 0) {
          c.wind -= dt;
          if (c.wind <= 0) release(c);
        } else {
          c.fade -= dt;
        }
      }
      casters = casters.filter(c => c.wind > 0 || c.fade > 0);
      if (dead) return;

      // 투사체. 갈라지면 새로 생기는 게 있어서 지금 있는 것만 돈다
      for (const m of [...missiles]) {
        if (m.skill.accel) m.speed = Math.min(m.skill.maxSpeed, m.speed + m.skill.accel * dt);
        const d = m.speed * dt;
        m.x += m.dx * d; m.y += m.dy * d;
        m.left -= d; m.flown += d;
        const reach = CHAMP.radius + m.skill.radius;
        if ((m.x - player.x) ** 2 + (m.y - player.y) ** 2 < reach * reach && hit(m.skill)) {
          m.gone = true;          // 맞힌 투사체는 사라진다
          if (dead) return;
          continue;
        }
        const sp = m.skill.split;
        if (sp) {
          if (m.splitIn == null) {
            // along: 내가 이 투사체 길 옆으로 가장 가까워지는 곳까지 남은 거리. 거기서 가르면 갈라진 것이 나를 향한다
            // side: 그곳에서 나와 투사체 길 사이 거리. 이대로 가도 맞을 거리면 가르지 않는다(벨코즈도 그냥 맞힌다)
            const along = (player.x - m.x) * m.dx + (player.y - m.y) * m.dy;
            const side = Math.abs((player.x - m.x) * m.dy - (player.y - m.y) * m.dx);
            const soon = sp.telegraph * m.speed;
            const miss = side > CHAMP.radius + m.skill.radius;
            if ((miss && along >= 0 && along <= soon) || m.left <= soon) m.splitIn = sp.telegraph;
          } else {
            m.splitIn -= dt;
            if (m.splitIn <= 0) { splitMissile(m); m.gone = true; }
          }
        }
      }
      const pad = 200;
      const alive = [];
      for (const m of missiles) {
        if (m.gone) continue;
        const out = m.x < -pad || m.y < -pad || m.x > ARENA.w + pad || m.y > ARENA.h + pad;
        if (m.left <= 0 || out) dodged += 1; else alive.push(m);
      }
      missiles = alive;

      // 장판·감옥
      for (const z of zones) {
        const s = z.skill;
        if (z.done != null) continue;      // 이미 끝나서 사라지는 중
        const d = dist(z, player);
        if (z.wait > 0) {
          z.wait -= dt;
          if (z.wait > 0) continue;
          if (s.kind === "circle") {
            // 터지는 순간 원 안에 몸이 조금이라도 걸치면 맞는다
            z.done = 0.3;          // 터진 자리를 잠깐 보여 준다
            boom(z.x, z.y, s.radius, s.color);
            if (d < s.radius + CHAMP.radius && hit(s)) { if (dead) return; }
            else dodged += 1;
            continue;
          }
        }
        if (s.kind === "cage") {
          // 테두리에 몸이 닿으면 맞는다. 안에 갇혔으면 테두리에 닿지 않게 버텨야 한다
          if (!z.formed) { z.formed = true; fx.push({ kind: "ring", x: z.x, y: z.y, r: s.radius, color: s.color, life: 0.4, max: 0.4 }); }
          if (!z.struck && Math.abs(d - s.radius) < CHAMP.radius && hit(s)) {
            z.struck = true;        // 감옥은 한 번만 스턴한다
            if (dead) return;
          }
          z.up += dt;
          if (z.up >= s.last) { z.done = 0.3; if (!z.struck) dodged += 1; }
        }
      }
      for (const z of zones) if (z.done != null) z.done -= dt;
      zones = zones.filter(z => z.done == null || z.done > 0);
      for (const f of flashes) f.left -= dt;
      flashes = flashes.filter(f => f.left > 0);
    }

    // ── 그리기 ──
    const MISSILE_Z = 90;          // 투사체가 떠서 나는 높이
    const BODY_H = 190;            // 내 캐릭터 키
    const PORTRAIT_Z = 150;        // 적 초상화 높이

    // 파편 n 개를 (x, y, z) 에서 사방으로
    function burst(x, y, z, color, n, speed) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
        parts.push({ x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 150 + Math.random() * 350,
                     life: 0.45 + Math.random() * 0.3, max: 0.75, color, size: 6 + Math.random() * 8 });
      }
    }

    // 장판이 터짐: 빛기둥 + 퍼지는 고리 + 파편
    function boom(x, y, r, color) {
      fx.push({ kind: "pillar", x, y, r, color, life: 0.4, max: 0.4 });
      fx.push({ kind: "ring", x, y, r, color, life: 0.35, max: 0.35 });
      burst(x, y, 20, color, Math.round(r / 8), r * 1.6);
    }

    // 바닥에 누운 원(투영한 다각형). 원근 때문에 앞쪽이 크게 보인다
    function groundCircle(x, y, r, z = 0, n = 56) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = i / n * Math.PI * 2;
        const p = proj(x + Math.cos(a) * r, y + Math.sin(a) * r, z);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      ctx.closePath();
    }

    // 바닥에 누운 띠(레이저, 덩굴). a -> b, 반쪽 폭 r
    function groundBand(a, b, r) {
      const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1;
      const nx = -dy / n * r, ny = dx / n * r;
      const q = [proj(a.x + nx, a.y + ny), proj(b.x + nx, b.y + ny), proj(b.x - nx, b.y - ny), proj(a.x - nx, a.y - ny)];
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    }

    function arenaPath() {
      const q = [proj(0, 0), proj(ARENA.w, 0), proj(ARENA.w, ARENA.h), proj(0, ARENA.h)];
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    }

    function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
    function noGlow() { ctx.shadowBlur = 0; }

    // 그림 효과만 흘러간다(실제 시간). 게임이 끝나도 파편은 마저 떨어진다
    function tickFx(dt) {
      for (const f of fx) f.life -= dt;
      fx = fx.filter(f => f.life > 0);
      for (const p of parts) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vz -= 1400 * dt;
        if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; }
        p.life -= dt;
      }
      parts = parts.filter(p => p.life > 0);
      // 브랜드 Q 는 날아가며 불티를 흘린다
      if (state === "play") {
        for (const m of missiles) {
          if (m.skill.look !== "fire" || Math.random() > dt * 40) continue;
          parts.push({ x: m.x - m.dx * 20, y: m.y - m.dy * 20, z: MISSILE_Z, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 120,
                       vz: 80 + Math.random() * 120, life: 0.35, max: 0.35, color: Math.random() < 0.5 ? "#ffa94d" : "#ffe066", size: 7 + Math.random() * 6 });
        }
      }
      shake = Math.max(0, shake - dt);
      hurt = Math.max(0, hurt - dt);
    }

    // ── 바닥 ──
    function drawGround() {
      const bg = ctx.createLinearGradient(0, 0, 0, VH);
      bg.addColorStop(0, "#050a14");
      bg.addColorStop(1, "#0a1424");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, VW, VH);

      // 협곡 바닥 느낌: 가운데가 밝고 가장자리가 어두운 청록
      const c = proj(ARENA.w / 2, ARENA.h / 2);
      const g = ctx.createRadialGradient(c.x, c.y, 10, c.x, c.y, VW * 0.6);
      g.addColorStop(0, "#1b3a3f");
      g.addColorStop(1, "#0c1a24");
      arenaPath();
      ctx.fillStyle = g;
      ctx.fill();

      ctx.strokeStyle = "rgba(160, 200, 190, .07)";
      ctx.lineWidth = 1;
      for (let x = 100; x < ARENA.w; x += 100) {
        const a = proj(x, 0), b = proj(x, ARENA.h);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (let y = 100; y < ARENA.h; y += 100) {
        const a = proj(0, y), b = proj(ARENA.w, y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      arenaPath();
      ctx.strokeStyle = "rgba(240, 180, 41, .35)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ── 바닥에 깔리는 표시들(경기장 밖으로 삐져나가지 않게 잘라서) ──
    function drawDecals() {
      ctx.save();
      arenaPath();
      ctx.clip();

      for (const z of zones) {
        const s = z.skill;
        if (s.kind === "circle") {
          if (z.done != null) continue;          // 터진 뒤는 빛기둥·고리가 대신한다
          const p = 1 - Math.max(0, z.wait) / z.total;
          // 안쪽이 터질 때까지 차오르고, 테두리는 처음부터 또렷하게
          groundCircle(z.x, z.y, s.radius);
          ctx.fillStyle = s.color + "22";
          ctx.fill();
          groundCircle(z.x, z.y, s.radius * p);
          ctx.fillStyle = s.color + "55";
          ctx.fill();
          groundCircle(z.x, z.y, s.radius);
          glow(s.color, 12);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 3;
          ctx.stroke();
          noGlow();
          if (s.inner) {
            // 중심부(제라스 W·레오나 R 은 가운데가 더 세다). 맞는 범위는 바깥 원 그대로
            groundCircle(z.x, z.y, s.inner, 0, 36);
            ctx.fillStyle = s.color + "33";
            ctx.fill();
            ctx.setLineDash([8, 6]);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else if (s.kind === "cage") {
          const forming = z.wait > 0;
          ctx.globalAlpha = z.done != null ? Math.max(0, z.done / 0.3) : 1;
          groundCircle(z.x, z.y, s.radius);
          if (forming) {
            ctx.setLineDash([10, 10]);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = s.color + "1c";
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }

      // 레이저 경고선: 시전하는 동안 가늘게 깜빡인다
      for (const c of casters) {
        if (c.skill.kind !== "beam" || c.wind <= 0) continue;
        const a = { x: c.x, y: c.y }, b = { x: c.x + c.dx * FAR, y: c.y + c.dy * FAR };
        groundBand(a, b, c.skill.radius);
        ctx.fillStyle = c.skill.color + "18";
        ctx.fill();
        groundBand(a, b, 6);
        ctx.fillStyle = c.skill.color + (Math.floor(t * 12) % 2 ? "cc" : "77");
        ctx.fill();
      }

      // 자이라 E: 머리가 지나간 바로 뒤에 덩굴이 솟았다가 금방 사그라든다(바닥에 붙어 있다).
      // 쏜 자리부터 끝까지 다 그리면 사거리(1150) 전체가 한 줄로 보여서 실제보다 길어 보인다
      const VINE = 380;
      for (const m of missiles) {
        if (m.skill.look !== "vines") continue;
        const len = Math.min(VINE, Math.hypot(m.x - m.ox, m.y - m.oy));
        const steps = 8;
        for (let i = 0; i < steps; i++) {
          // 뒤로 갈수록 가늘고 옅게
          const a = { x: m.x - m.dx * len * (i + 1) / steps, y: m.y - m.dy * len * (i + 1) / steps };
          const b = { x: m.x - m.dx * len * i / steps, y: m.y - m.dy * len * i / steps };
          const fade = 1 - i / steps;
          ctx.globalAlpha = fade;
          groundBand(a, b, m.skill.radius * 0.35 * (0.5 + 0.5 * fade));
          ctx.fillStyle = "#2b8a3e";
          ctx.fill();
          groundBand(a, b, m.skill.radius * 0.12);
          ctx.fillStyle = "#8ce99a";
          ctx.fill();
        }
        // 가시 달린 잎: 길 양옆으로 번갈아. 머리가 지나간 거리로 자리를 잡아서 따라 움직이지 않는다
        for (let d = Math.floor(m.flown / 55) * 55, i = 0; d > m.flown - len; d -= 55, i++) {
          const back = m.flown - d;
          const side = Math.floor(d / 55) % 2 ? 1 : -1;
          ctx.globalAlpha = Math.max(0, 1 - back / len);
          const lx = m.x - m.dx * back - m.dy * side * m.skill.radius * 0.45;
          const ly = m.y - m.dy * back + m.dx * side * m.skill.radius * 0.45;
          groundCircle(lx, ly, 16, 0, 10);
          ctx.fillStyle = "#40c057";
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // 투사체의 바닥 그림자 = 실제 판정 원. 내 발밑 초록 링(65) 과 이 원이 겹치면 맞는다
      for (const m of missiles) {
        groundCircle(m.x, m.y, m.skill.radius, 0, 28);
        ctx.fillStyle = "rgba(0, 0, 0, .4)";
        ctx.fill();
        ctx.strokeStyle = m.skill.color + "cc";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 레이저가 지나간 자리
      for (const f of flashes) {
        const a = Math.max(0, f.left / 0.35);
        ctx.globalCompositeOperation = "lighter";
        groundBand(f.a, f.b, f.skill.radius * (1 + (1 - a) * 0.4));
        ctx.fillStyle = f.skill.color + Math.round(a * 200).toString(16).padStart(2, "0");
        glow(f.skill.color, 30);
        ctx.fill();
        groundBand(f.a, f.b, f.skill.radius * 0.35);
        ctx.fillStyle = "#ffffff" + Math.round(a * 230).toString(16).padStart(2, "0");
        ctx.fill();
        noGlow();
        ctx.globalCompositeOperation = "source-over";
      }

      // 퍼지는 고리
      for (const f of fx) {
        if (f.kind !== "ring") continue;
        const a = f.life / f.max;
        groundCircle(f.x, f.y, f.r * (1 + (1 - a) * 0.25));
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = a;
        ctx.lineWidth = 2 + 6 * a;
        glow(f.color, 16);
        ctx.stroke();
        noGlow();
        ctx.globalAlpha = 1;
      }

      // 내 발밑 초록 링, 적 발밑 빨간 링(롤처럼)
      groundCircle(player.x, player.y, CHAMP.radius);
      ctx.strokeStyle = safe > 0 ? "#ffa8a8" : "#51cf66";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      for (const c of casters) {
        ctx.globalAlpha = c.wind > 0 ? 1 : Math.max(0, c.fade / 0.5);
        groundCircle(c.x, c.y, 60, 0, 32);
        ctx.strokeStyle = "#ff4d4f";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 찍은 곳(초록 클릭 표시): 찍은 순간 크게 떴다 줄어든다
      if (target && state === "play") {
        groundCircle(target.x, target.y, 26, 0, 24);
        ctx.strokeStyle = "#69db7c";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 서 있는 것들 ──
    function drawShadow(x, y, r) {
      groundCircle(x, y, r, 0, 24);
      ctx.fillStyle = "rgba(0, 0, 0, .4)";
      ctx.fill();
    }

    function drawPlayer() {
      // 원기둥 몸통 + 둥근 머리. 높이는 실제로 z 를 올려서 원근에 맞게 줄어든다
      const base = proj(player.x, player.y, 0);
      const neck = upright(player.x, player.y, BODY_H * 0.7);
      const head = upright(player.x, player.y, BODY_H * 0.86);
      const w = 30 * base.k, wn = 22 * neck.k, hr = 24 * head.k;
      ctx.globalAlpha = safe > 0 && Math.floor(safe * 10) % 2 ? 0.35 : 1;
      const main = dead ? "#ff6b6b" : "#f0b429";
      const body = ctx.createLinearGradient(base.x - w, 0, base.x + w, 0);
      body.addColorStop(0, "#7a4d00");
      body.addColorStop(0.45, main);
      body.addColorStop(1, "#7a4d00");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(base.x - w, base.y);
      ctx.lineTo(neck.x - wn, neck.y);
      ctx.ellipse(neck.x, neck.y, wn, wn * 0.4, 0, Math.PI, 0, false);
      ctx.lineTo(base.x + w, base.y);
      ctx.ellipse(base.x, base.y, w, w * 0.4, 0, 0, Math.PI, false);
      ctx.closePath();
      ctx.fill();
      const hg = ctx.createRadialGradient(head.x - hr * 0.35, head.y - hr * 0.35, hr * 0.1, head.x, head.y, hr);
      hg.addColorStop(0, "#fff3bf");
      hg.addColorStop(1, main);
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(head.x, head.y, hr, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    function drawCaster(c) {
      const alpha = c.wind > 0 ? 1 : Math.max(0, c.fade / 0.5);
      const base = proj(c.x, c.y, 0), head = upright(c.x, c.y, PORTRAIT_Z);
      const r = 44 * head.k;
      ctx.globalAlpha = alpha;
      // 받침대
      ctx.strokeStyle = "rgba(255, 77, 79, .7)";
      ctx.lineWidth = Math.max(1, 6 * base.k);
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(head.x, head.y + r); ctx.stroke();
      // 초상화
      const img = champImage(c.skill.champ);
      ctx.save();
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.clip();
      if (img.complete && img.naturalWidth) ctx.drawImage(img, head.x - r, head.y - r, r * 2, r * 2);
      else { ctx.fillStyle = "#2b4270"; ctx.fillRect(head.x - r, head.y - r, r * 2, r * 2); }
      ctx.restore();
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = Math.max(1.5, 4 * head.k);
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.stroke();
      // 시전 중: 테두리가 스킬 색으로 차오르고 빛난다
      if (c.wind > 0 && c.skill.cast > 0) {
        const p = 1 - c.wind / c.skill.cast;
        glow(c.skill.color, 14);
        ctx.strokeStyle = c.skill.color;
        ctx.lineWidth = Math.max(2, 7 * head.k);
        ctx.beginPath(); ctx.arc(head.x, head.y, r + 5 * head.k, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
        noGlow();
      }
      ctx.globalAlpha = 1;
    }

    // 투사체 생김새. 판정은 모두 앞쪽 원(반지름 s.radius) 하나고, 이건 그림일 뿐이다.
    // 밝게 꽉 찬 부분이 판정 크기와 같고, 그 바깥 빛번짐은 옅게만 둔다
    function drawMissile(m) {
      const s = m.skill, look = s.look || "orb";
      const zh = look === "vines" ? 18 : MISSILE_Z;
      const p = upright(m.x, m.y, zh);
      // 화면에서 날아가는 방향과, 그 방향으로 1유닛이 몇 픽셀인지(원근 때문에 바닥 방향과 조금 다르다)
      const q = upright(m.x + m.dx * 100, m.y + m.dy * 100, zh);
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      const fw = Math.hypot(q.x - p.x, q.y - p.y) / 100;
      const r = s.radius * p.k;

      // 사슬: 쏜 사람에서 갈고리까지
      if (look === "hook") {
        const o = upright(m.ox, m.oy, zh);
        ctx.strokeStyle = "#adb5bd";
        ctx.lineWidth = Math.max(1.5, 6 * p.k);
        ctx.setLineDash([Math.max(3, 14 * p.k), Math.max(2, 8 * p.k)]);
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.globalCompositeOperation = "lighter";

      // 판정 크기의 빛 구슬(여러 모양의 머리에 공통으로 쓴다). a: 전체 진하기
      const core = (rad, c1, c2, halo = 1.5, a = 1) => {
        ctx.globalAlpha = 0.22 * a;
        ctx.fillStyle = c2;
        ctx.beginPath(); ctx.arc(0, 0, rad * halo, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = a;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
        g.addColorStop(0, c1);
        g.addColorStop(0.55, c2);
        g.addColorStop(1, c2 + "cc");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      };
      // 지나온 길의 옅은 꼬리
      const trail = (len, width, color, alpha = 0.35) => {
        const g = ctx.createLinearGradient(-len * fw, 0, 0, 0);
        g.addColorStop(0, color + "00");
        g.addColorStop(1, color);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-len * fw, 0); ctx.lineTo(0, -width); ctx.lineTo(0, width);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      };

      if (look === "orb") {
        trail(Math.min(m.flown, s.radius * 5), r * 0.8, s.color);
        // 벨코즈 Q: 갈라지기 직전 부풀며 번쩍인다(경로는 안 보여 준다)
        let rad = r;
        if (m.splitIn != null) {
          const tt = 1 - Math.max(0, m.splitIn) / s.split.telegraph;
          rad = r * (1 + 0.45 * tt);
          ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(tt * Math.PI * 3));
          ctx.fillStyle = "#ffffff";
          ctx.beginPath(); ctx.arc(0, 0, rad * 1.25, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        core(rad, "#ffffff", s.color);
      } else if (look === "fire") {
        trail(Math.min(m.flown, s.radius * 6), r * 0.9, "#ff922b", 0.5);
        const flick = 1 + (Math.random() - 0.5) * 0.12;
        core(r * flick, "#fff3bf", "#ff6b00", 1.7);
      } else if (look === "bolt") {
        // 짧고 굵은 광탄: 머리의 원이 판정, 뒤로 길게 빛이 끌린다
        trail(Math.min(m.flown, 260), r * 0.7, s.color, 0.6);
        core(r, "#ffffff", s.color, 1.3);
      } else if (look === "heart") {
        trail(Math.min(m.flown, s.radius * 4), r * 0.6, s.color, 0.3);
        ctx.rotate(-ang);                        // 하트는 늘 똑바로 선다
        const hs = r * 1.05;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.moveTo(0, hs * 0.75);
        ctx.bezierCurveTo(-hs * 1.3, -hs * 0.1, -hs * 0.6, -hs * 1.05, 0, -hs * 0.45);
        ctx.bezierCurveTo(hs * 0.6, -hs * 1.05, hs * 1.3, -hs * 0.1, 0, hs * 0.75);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(-hs * 0.3, -hs * 0.45, hs * 0.18, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (look === "spear") {
        // 니달리 Q: 긴 자루와 창날. 판정 원(작다) 은 창끝에 있다
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "#a9754f";
        ctx.lineWidth = Math.max(2, 9 * p.k);
        ctx.beginPath(); ctx.moveTo(-190 * fw, 0); ctx.lineTo(0, 0); ctx.stroke();
        ctx.fillStyle = "#e9ecef";
        ctx.beginPath(); ctx.moveTo(r * 1.1, 0); ctx.lineTo(-r * 0.8, -r * 0.7); ctx.lineTo(-r * 0.8, r * 0.7); ctx.closePath(); ctx.fill();
        ctx.globalCompositeOperation = "lighter";
        core(r, "#ffffff", s.color, 1.2, 0.3);
      } else if (look === "blade") {
        // 레오나 E: 앞으로 날아가는 해의 칼날
        trail(Math.min(m.flown, 220), r * 0.8, s.color, 0.45);
        const g = ctx.createLinearGradient(-r, 0, r, 0);
        g.addColorStop(0, s.color + "00");
        g.addColorStop(0.7, s.color);
        g.addColorStop(1, "#ffffff");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(r * 1.1, 0);
        ctx.quadraticCurveTo(r * 0.2, -r * 1.3, -r * 1.2, -r * 0.9);
        ctx.quadraticCurveTo(-r * 0.2, 0, -r * 1.2, r * 0.9);
        ctx.quadraticCurveTo(r * 0.2, r * 1.3, r * 1.1, 0);
        ctx.fill();
      } else if (look === "hook") {
        // 블리츠는 금빛 주먹, 쓰레쉬는 초록 낫
        ctx.globalCompositeOperation = "source-over";
        if (s.champ === "Blitzcrank") {
          ctx.fillStyle = "#e8a33d";
          ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#ffd8a8";
          for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(r * 0.7, i * r * 0.45, r * 0.28, 0, Math.PI * 2); ctx.fill(); }
        } else {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = Math.max(2, r * 0.3);
          ctx.beginPath(); ctx.arc(-r * 0.2, 0, r * 0.85, -Math.PI * 0.75, Math.PI * 0.35); ctx.stroke();
        }
        ctx.globalCompositeOperation = "lighter";
        core(r, "#ffffff", s.color, 1.2, 0.2);
      } else if (look === "zap") {
        // 징크스 W: 아주 빠른 가는 전격. 뒤로 길게 번개가 남는다
        const len = Math.min(m.flown, 700);
        const bolt = () => {
          ctx.beginPath(); ctx.moveTo(-len * fw, 0);
          for (let x = -len * fw; x < 0; x += 16) ctx.lineTo(x, (Math.random() - 0.5) * r * 0.5);
          ctx.lineTo(0, 0);
        };
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(1.5, r * 0.28);
        glow(s.color, 12);
        bolt(); ctx.stroke();
        noGlow();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#fff0f6";
        ctx.lineWidth = Math.max(1, r * 0.08);
        bolt(); ctx.stroke();
        core(r * 0.9, "#ffffff", s.color, 1.2);
      } else if (look === "arrow") {
        // 애쉬 R: 거대한 얼음 화살. 판정 원(큰 원) 은 화살촉 쪽에 있다
        trail(Math.min(m.flown, 500), r * 0.5, "#d0ebff", 0.3);
        ctx.globalCompositeOperation = "source-over";
        // 자루
        const shaft = ctx.createLinearGradient(-r * 4.5 * fw, 0, -r * 0.4, 0);
        shaft.addColorStop(0, "#74c0fc00");
        shaft.addColorStop(1, "#a5d8ff");
        ctx.fillStyle = shaft;
        ctx.beginPath();
        ctx.moveTo(-r * 0.4, -r * 0.12); ctx.lineTo(-r * 4.5 * fw, -r * 0.05);
        ctx.lineTo(-r * 4.5 * fw, r * 0.05); ctx.lineTo(-r * 0.4, r * 0.12);
        ctx.closePath(); ctx.fill();
        // 깃: 자루 끝 양옆
        ctx.fillStyle = "#4dabf7";
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(-r * 2.6 * fw, 0); ctx.lineTo(-r * 3.4 * fw, side * r * 0.45); ctx.lineTo(-r * 3.1 * fw, 0);
          ctx.closePath(); ctx.fill();
        }
        // 촉: 얼음 결정
        const head = ctx.createLinearGradient(-r * 0.7, 0, r * 1.1, 0);
        head.addColorStop(0, "#339af0");
        head.addColorStop(0.6, "#a5d8ff");
        head.addColorStop(1, "#e7f5ff");
        ctx.fillStyle = head;
        ctx.beginPath();
        ctx.moveTo(r * 1.1, 0); ctx.lineTo(-r * 0.2, -r * 0.5); ctx.lineTo(-r * 0.7, 0); ctx.lineTo(-r * 0.2, r * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "#e7f5ff";
        ctx.lineWidth = Math.max(1, r * 0.04);
        ctx.stroke();
        ctx.globalCompositeOperation = "lighter";
        core(r, "#ffffff", s.color, 1.2, 0.18);
      } else if (look === "vines") {
        // 덩굴 끝의 꽃봉오리(바닥 가까이)
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#2f9e44";
        for (let i = 0; i < 5; i++) {
          const a = i / 5 * Math.PI * 2;
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, r * 0.5, r * 0.25, a, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = "#f783ac";
        ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // 감옥 창살. 뒤쪽(먼 쪽) 과 앞쪽을 나눠 그려서 안에 선 사람이 창살 사이로 보이게 한다
    function drawCageBars(front) {
      for (const z of zones) {
        if (z.skill.kind !== "cage" || z.wait > 0) continue;
        const s = z.skill, n = 28, hgt = 170;
        const a = z.done != null ? Math.max(0, z.done / 0.3) : 1;
        ctx.globalAlpha = a;
        glow(s.color, 10);
        ctx.strokeStyle = s.color;
        for (let i = 0; i < n; i++) {
          const ang = i / n * Math.PI * 2;
          if ((Math.sin(ang) > 0) !== front) continue;
          const x = z.x + Math.cos(ang) * s.radius, y = z.y + Math.sin(ang) * s.radius;
          const b = proj(x, y, 0), tp = proj(x, y, hgt);
          ctx.lineWidth = Math.max(1.5, 7 * b.k);
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
        }
        // 위 테두리
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= 56; i++) {
          const ang = i / 56 * Math.PI;
          const start = front ? 0 : Math.PI;
          const q = proj(z.x + Math.cos(start + ang) * s.radius, z.y + Math.sin(start + ang) * s.radius, hgt);
          if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        }
        ctx.stroke();
        noGlow();
        ctx.globalAlpha = 1;
      }
    }

    function drawEffects() {
      ctx.globalCompositeOperation = "lighter";
      for (const f of fx) {
        if (f.kind !== "pillar") continue;
        const a = f.life / f.max;
        const b = proj(f.x, f.y, 0), tp = proj(f.x, f.y, 420 * (1.2 - a));
        const w = f.r * b.k * (0.6 + 0.4 * a);
        const g = ctx.createLinearGradient(0, b.y, 0, tp.y);
        g.addColorStop(0, f.color + "cc");
        g.addColorStop(1, f.color + "00");
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(b.x - w, b.y); ctx.lineTo(tp.x - w * 0.5, tp.y); ctx.lineTo(tp.x + w * 0.5, tp.y); ctx.lineTo(b.x + w, b.y);
        ctx.closePath();
        ctx.fill();
      }
      for (const p of parts) {
        const q = proj(p.x, p.y, p.z);
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(q.x, q.y, p.size * q.k, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    function draw(fdt) {
      if (fdt) tickFx(fdt);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, VW, VH);
      ctx.save();
      if (shake > 0) {
        const m = 10 * shake / 0.25;
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      }
      drawGround();
      if (player) {
        drawDecals();
        drawCageBars(false);
        // 먼 것(y 가 작은 것) 부터 그려야 앞의 것이 뒤의 것을 가린다
        const actors = [
          ...casters.map(c => ({ y: c.y, draw: () => drawCaster(c) })),
          ...missiles.map(m => ({ y: m.y, draw: () => drawMissile(m) })),
          { y: player.y, draw: () => { drawShadow(player.x, player.y, 45); drawPlayer(); } },
        ].sort((a, b) => a.y - b.y);
        actors.forEach(a => a.draw());
        drawCageBars(true);
        drawEffects();
      }
      ctx.restore();

      // 맞았을 때 화면 가장자리가 붉게
      if (hurt > 0) {
        const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.7);
        g.addColorStop(0, "rgba(255, 40, 40, 0)");
        g.addColorStop(1, "rgba(255, 40, 40, " + (0.55 * hurt / 0.4).toFixed(3) + ")");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, VW, VH);
      }
    }

    function hudUpdate() {
      hud("time").textContent = fmt(t);
      hud("dodged").textContent = dodged;
      hud("lives").textContent = "♥".repeat(Math.max(0, lives)) + "♡".repeat(LIVES - Math.max(0, lives));
    }

    // ── 흐름 ──
    function loop(now) {
      raf = requestAnimationFrame(loop);
      // 다른 탭에 갔다 오면 한꺼번에 흐르지 않게 한 번에 최대 0.1초만 진행.
      // 시작 직후 첫 프레임은 시각이 시작 시각보다 조금 앞설 수 있어서 0 아래로는 안 간다
      const fdt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      acc += fdt;
      last = now;
      while (acc >= STEP && state === "play") {
        acc -= STEP;
        step(STEP);
        if (dead) { end(); break; }
      }
      draw(fdt);
      hudUpdate();
    }

    function start() {
      reset();
      state = "play";
      over.hidden = true;
      canvas.focus({ preventScroll: true });
      if (opts.onStart) opts.onStart();
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }

    function end() {
      state = "over";
      keys.clear();
      holding = false;
      const result = { ms: Math.round(t * 1000), dodged, by: lastHit.name, ver: VERSION };
      showOver(`
        <h2>${esc(lastHit.name)}에 마지막 목숨을 잃었어요</h2>
        <p class="dodge-score">${fmt(t)}</p>
        <p class="note">피한 스킬 ${dodged}개 · 맞은 스킬 ${hits.map(esc).join(" → ")}</p>
        <div data-extra></div>
        <div class="dodge-actions">
          <button type="button" data-start>다시 하기 <small>Space</small></button>
          ${opts.links || ""}
        </div>`);
      if (opts.onEnd) {
        Promise.resolve(opts.onEnd(result)).then(html => {
          const slot = over.querySelector("[data-extra]");
          if (html && slot) slot.innerHTML = html;
        }, () => {});
      }
    }

    function showOver(html) {
      over.innerHTML = `<div class="dodge-card">${html}</div>`;
      over.hidden = false;
      const b = over.querySelector("[data-start]");
      if (b) b.onclick = start;
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // ── 입력 ──
    function onPointerDown(e) {
      if (state !== "play") return;
      // 우클릭이 기본. 왼쪽 클릭·터치도 받아 준다(트랙패드·휴대폰)
      e.preventDefault();
      holding = true;
      target = toArena(e);
      canvas.setPointerCapture?.(e.pointerId);
    }
    function onPointerMove(e) {
      if (holding && state === "play") target = toArena(e);
    }
    function onPointerUp() { holding = false; }
    const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    function onKeyDown(e) {
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      if (MOVE_KEYS.includes(e.code)) {
        e.preventDefault();
        if (state === "play") keys.add(e.code);
      } else if ((e.code === "Space" || e.code === "Enter") && state !== "play") {
        e.preventDefault();
        start();
      }
    }
    function onKeyUp(e) { keys.delete(e.code); }
    function onBlur() { keys.clear(); holding = false; }

    canvas.tabIndex = 0;
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", fit);

    reset();
    fit();
    hudUpdate();
    showOver(`
      <h2>스킬샷 피하기</h2>
      <p>사방에서 날아오는 스킬을 피해 오래 버티세요. 목숨 ${LIVES}개, 맞은 뒤 ${SAFE_AFTER_HIT}초는 무적이에요.</p>
      <ul class="dodge-keys">
        <li><b>투사체</b> 바닥 그림자가 실제 판정이에요. 옆으로 갈라지는 것도 있어요</li>
        <li><b>장판</b> 바닥 원이 다 차면 터져요</li>
        <li><b>레이저</b> 깜빡이는 선이 보이면 곧 그 선 전체를 쳐요</li>
        <li><b>감옥</b> 창살에 닿으면 맞아요. 안에 갇히면 닿지 않게 버티세요</li>
      </ul>
      <ul class="dodge-keys">
        <li><b>우클릭</b> 찍은 곳으로 이동 (누른 채 끌면 계속 따라가요)</li>
        <li><b>WASD</b> 누른 쪽으로 바로 이동 (방향키도 돼요)</li>
        <li><b>휴대폰</b> 화면을 누른 곳으로 이동</li>
      </ul>
      <p class="note">이동 속도 ${CHAMP.speed}. 스킬 수치는 롤 클라이언트 데이터 그대로예요.</p>
      <div class="dodge-actions"><button type="button" data-start>시작 <small>Space</small></button>${opts.links || ""}</div>`);

    function setBest(text) { hud("best").innerHTML = text || ""; }

    function destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", fit);
    }

    return { destroy, setBest };
  }

  window.DodgeGame = { mount, fmt, SKILLS, VERSION };
})();
