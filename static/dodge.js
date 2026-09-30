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
// 화면은 롤 인터페이스를 흉내 낸다: 아래 가운데 HUD(초상화·체력·소환사 주문), 위 시계·전적,
// 오른쪽 아래 미니맵, 머리 위 체력바, 안내 문구(환영·연속 회피·처치당함), 죽으면 회색 화면.
//
// 조작: 우클릭(누른 채 끌면 계속 따라감) 또는 WASD·방향키. 휴대폰은 화면을 누르면 이동.
// 시작 전에 이동 방식(마우스 클릭 / WASD) 과 소환사 주문 배치를 고른다.
// 주문 키는 마우스면 롤 기본 D/F, WASD 면 D 가 이동이라 V/F. 점멸을 두 키 중 어디에 둘지도 고른다.
// WASD 는 e.code 로 읽는다. 한글 입력 상태에서도 ㅈㅁㄴㅇ 이 아니라 WASD 로 잡힌다.

(function () {
  // 게임 규칙이 바뀌면 올린다. 서버는 같은 버전의 기록끼리만 순위를 매긴다
  const VERSION = 6;

  const ARENA = { w: 1400, h: 900 };
  const CHAMP = { radius: 65, speed: 335 };
  const STEP = 1 / 240;
  const FAR = 4000;            // 경기장보다 긴 사거리(레이저 등)
  // 소환사 주문. 아이콘·실제 쿨타임(점멸 300초, 유체화 240초) 은 롤 데이터(summoner-spells.json),
  // 점멸 거리 400·유체화 이속(+24~48%) 은 롤 위키. 쿨타임과 유체화 지속 시간은 이 게임에 맞게 줄였다
  const ICONS = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/";
  const SPELLS = [
    { id: "flash", name: "점멸", cd: 15, range: 400, icon: ICONS + "summoner_flash.png" },
    { id: "ghost", name: "유체화", cd: 20, last: 3, bonus: 0.4, icon: ICONS + "summoner_haste.png" },
  ];

  // 조작 설정: 이동 방식(mouse | wasd) 과 점멸을 두 키 중 앞 키에 둘지(flashFirst). 브라우저에 기억한다
  const CONTROL_KEY = "tiergg-dodge-controls";
  function loadControls() {
    try {
      const c = JSON.parse(localStorage.getItem(CONTROL_KEY) || "{}");
      return { move: c.move === "wasd" ? "wasd" : "mouse", flashFirst: !!c.flashFirst };
    } catch { return { move: "mouse", flashFirst: false }; }
  }
  function saveControls(c) { try { localStorage.setItem(CONTROL_KEY, JSON.stringify(c)); } catch {} }
  // 이동 방식에 따른 주문 두 키
  function keyPair(move) { return move === "wasd" ? ["V", "F"] : ["D", "F"]; }
  function spellKeys(c) {
    const [a, b] = keyPair(c.move);
    return c.flashFirst ? { flash: a, ghost: b } : { flash: b, ghost: a };
  }
  const HP_MAX = 1500;            // 체력(한 번 맞을 때마다 HP_MAX / LIVES)
  // 연속으로 피한 수에 따라 롤 안내 문구
  const SPREES = [[20, "학살 중입니다!"], [40, "도저히 막을 수 없습니다!"], [60, "미쳐 날뛰고 있습니다!"], [80, "전설의 출현!"]];

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

  // ── 효과음: 소리 파일 없이 WebAudio 로 짧게 만든다. 끌 수 있고 브라우저에 기억한다 ──
  const SOUND_KEY = "tiergg-dodge-sound";
  let audio = null;
  function soundOn() { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } }
  function setSound(on) { try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch {} }
  function sfx(kind) {
    if (!soundOn()) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const now = audio.currentTime;
      const out = audio.createGain();
      out.connect(audio.destination);
      const tone = (type, f0, f1, dur, vol, delay = 0) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, now + delay);
        o.frequency.exponentialRampToValueAtTime(f1, now + delay + dur);
        g.gain.setValueAtTime(vol, now + delay);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
        o.connect(g); g.connect(out);
        o.start(now + delay); o.stop(now + delay + dur + 0.02);
      };
      if (kind === "hit") { tone("square", 180, 60, 0.18, 0.12); tone("sine", 90, 40, 0.25, 0.2); }
      else if (kind === "flash") { tone("sine", 400, 1400, 0.16, 0.12); tone("triangle", 900, 2400, 0.12, 0.06, 0.03); }
      else if (kind === "ghost") { tone("sine", 300, 700, 0.3, 0.08); }
      else if (kind === "level") { tone("triangle", 660, 990, 0.12, 0.07); tone("triangle", 990, 1320, 0.16, 0.06, 0.1); }
      else if (kind === "announce") { tone("sine", 523, 523, 0.25, 0.06); tone("sine", 784, 784, 0.35, 0.05, 0.12); }
      else if (kind === "death") { tone("sawtooth", 300, 70, 0.9, 0.08); tone("sine", 150, 50, 1.1, 0.12); }
      else if (kind === "deny") { tone("square", 160, 150, 0.08, 0.05); }
    } catch {}
  }

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
        <span data-hud="best"></span>
        <button type="button" class="ghost dodge-sound" data-sound aria-pressed="true">효과음 켜짐</button>
      </div>
      <div class="dodge-stage">
        <div class="lol-view">
          <canvas aria-label="스킬샷 피하기 게임 화면"></canvas>
          <div class="lol-top"><b data-hud="clock">00:00</b></div>
          <div class="lol-score">
            <span title="피한 스킬"><i class="ico-dodge"></i><b data-hud="dodged">0</b></span>
            <span title="맞은 횟수"><i class="ico-hit"></i><b data-hud="hitcount">0</b></span>
          </div>
          <div class="lol-banner" data-banner></div>
          <canvas class="lol-minimap" aria-hidden="true"></canvas>
          <div class="lol-hud">
            <div class="lol-face"><img data-hud="face" alt=""><span data-hud="level">1</span></div>
            <div class="lol-main">
              <div class="lol-spells">
                ${SPELLS.map(sp => `
                  <button type="button" class="lol-spell" data-spell="${sp.id}" title="${sp.name}">
                    <img src="${sp.icon}" alt="${sp.name}"><i></i><b></b><kbd></kbd>
                  </button>`).join("")}
              </div>
              <div class="lol-hp"><i data-hud="hpfill"></i><span data-hud="hptext"></span></div>
            </div>
          </div>
        </div>
        <div class="dodge-over" data-over></div>
      </div>`;
    const canvas = root.querySelector(".lol-view > canvas");
    const ctx = canvas.getContext("2d");
    const view = root.querySelector(".lol-view");
    const mini = root.querySelector(".lol-minimap");
    const mctx = mini.getContext("2d");
    const banner = root.querySelector("[data-banner]");
    const soundBtn = root.querySelector("[data-sound]");
    let face = champImage(opts.champ || "Ezreal");
    const over = root.querySelector("[data-over]");
    const hud = name => root.querySelector(`[data-hud="${name}"]`);
    preload();

    let state = "ready";       // ready | play | over
    let t = 0, dodged = 0, acc = 0, last = 0, nextCast = 0, raf = 0;
    let player, target, casters, missiles, zones, flashes;
    let lives, hits, safe, lastHit, dead;
    let fx, parts, shake, hurt;          // 그림 효과(판정과 상관없음)
    let cds, ghostLeft, cursor, facing, level, pops, lastSpree, lastMark;
    let bannerTimer = 0, overTimer = 0;
    let controls = loadControls();
    const keyOf = id => spellKeys(controls)[id];
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
      cds = { flash: 0, ghost: 0 };   // 소환사 주문 남은 쿨타임
      ghostLeft = 0;           // 유체화 남은 시간
      cursor = null;           // 마우스가 가리키는 바닥(점멸 방향)
      facing = { x: 0, y: -1 };    // 마지막으로 움직인 방향(커서가 없을 때 점멸 방향)
      level = 1;
      pops = [];               // 떠오르는 피해 숫자
      lastSpree = 0;
      lastMark = 0;
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
      // 폭을 다시 재기 전에 지난번에 박아 둔 폭을 푼다(안 풀면 창을 줄여도 예전 폭 그대로 잰다)
      view.style.width = "";
      canvas.style.width = "0px";
      const stage = view.parentElement;
      const room = Math.max(220, window.innerHeight - Math.max(0, stage.getBoundingClientRect().top + window.scrollY) - 16);
      // 배율 1 로 경기장 네 귀퉁이(와 먼 쪽 위로 선 것들) 가 화면 어디에 오는지 본다
      S = 1; OX = 0; OY = 0;
      const side = 70;
      const pts = [[0, 0, 0], [ARENA.w, 0, 0], [-side, ARENA.h, 0], [ARENA.w + side, ARENA.h, 0], [-side, 0, 240], [ARENA.w + side, 0, 240]]
        .map(([x, y, z]) => proj(x, y, z));
      const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
      const pad = 12;
      // 아래 HUD·미니맵이 경기장을 가리지 않게 화면 폭의 HUD_ROOM 만큼 아래를 비워 둔다
      // 휴대폰에서는 주문 칸이 손가락 크기라 HUD 가 상대적으로 커서 더 비운다
      const HUD_ROOM = stage.clientWidth < 600 ? 0.2 : 0.12;
      S = Math.min((stage.clientWidth - pad * 2) / (maxX - minX), (room - pad * 2) / ((maxY - minY) + HUD_ROOM * (maxX - minX)));
      VW = Math.floor(Math.min(stage.clientWidth, (maxX - minX) * S + pad * 2));
      VH = Math.floor((maxY - minY) * S + pad * 2 + HUD_ROOM * VW);
      OX = VW / 2 - (minX + maxX) / 2 * S;
      OY = pad - minY * S;
      DPR = window.devicePixelRatio || 1;
      canvas.style.width = VW + "px";
      canvas.style.height = VH + "px";
      canvas.width = Math.round(VW * DPR);
      canvas.height = Math.round(VH * DPR);
      // HUD 는 화면 폭에 맞춰 줄고 는다(1000px 폭일 때 --u = 1px)
      view.style.width = VW + "px";
      view.style.setProperty("--u", (VW / 1000).toFixed(4) + "px");
      const mw = Math.round(Math.max(90, VW * 0.17)), mh = Math.round(mw * ARENA.h / ARENA.w);
      mini.style.width = mw + "px";
      mini.style.height = mh + "px";
      mini.width = Math.round(mw * DPR);
      mini.height = Math.round(mh * DPR);
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

    // 소환사 주문
    function useSpell(id) {
      if (state !== "play") return;
      const sp = SPELLS.find(x => x.id === id);
      if (cds[id] > 0) { sfx("deny"); return; }
      cds[id] = sp.cd;
      if (id === "flash") {
        // 커서 쪽으로 최대 400. 커서를 모르면(휴대폰·WASD) 가던 방향으로
        let dx = facing.x, dy = facing.y, len = sp.range;
        if (cursor) {
          const d = Math.hypot(cursor.x - player.x, cursor.y - player.y);
          if (d > 1) { dx = (cursor.x - player.x) / d; dy = (cursor.y - player.y) / d; len = Math.min(sp.range, d); }
        }
        const from = { x: player.x, y: player.y };
        player.x = Math.min(ARENA.w - CHAMP.radius, Math.max(CHAMP.radius, player.x + dx * len));
        player.y = Math.min(ARENA.h - CHAMP.radius, Math.max(CHAMP.radius, player.y + dy * len));
        target = null;
        burst(from.x, from.y, 60, "#ffe066", 16, 260);
        burst(player.x, player.y, 60, "#fff3bf", 16, 260);
        fx.push({ kind: "ring", x: player.x, y: player.y, r: CHAMP.radius + 20, color: "#ffe066", life: 0.35, max: 0.35 });
        sfx("flash");
      } else if (id === "ghost") {
        ghostLeft = sp.last;
        sfx("ghost");
      }
    }

    // 화면 가운데 안내 문구(롤의 알림처럼 잠깐 떴다 사라진다)
    function announce(text, kind = "gold", ms = 1800) {
      banner.innerHTML = "<b>" + esc(text) + "</b>";
      banner.className = "lol-banner show " + kind;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.className = "lol-banner"; }, ms);
      if (kind !== "death") sfx("announce");
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
      // 롤처럼 머리 위로 피해 숫자(마법 피해는 보라)
      pops.push({ x: player.x, y: player.y, text: String(Math.round(HP_MAX / LIVES)), life: 1, max: 1 });
      sfx("hit");
      if (lives === 1) announce("체력이 낮습니다", "warn");
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

      // 소환사 주문 쿨타임, 유체화
      for (const sp of SPELLS) cds[sp.id] = Math.max(0, cds[sp.id] - dt);
      ghostLeft = Math.max(0, ghostLeft - dt);
      const ghost = SPELLS.find(sp => sp.id === "ghost");
      const spd = CHAMP.speed * (ghostLeft > 0 ? 1 + ghost.bonus : 1);

      // 이동: WASD 가 눌려 있으면 그쪽으로, 아니면 찍은 곳으로
      let mx = 0, my = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) my -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) my += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
      if (mx || my) {
        target = null;
        const n = Math.hypot(mx, my);
        player.vx = mx / n * spd;
        player.vy = my / n * spd;
      } else if (target) {
        const dx = target.x - player.x, dy = target.y - player.y;
        const d = Math.hypot(dx, dy);
        if (d <= spd * dt) {
          player.x = target.x; player.y = target.y;
          player.vx = player.vy = 0;
          if (!holding) target = null;
        } else {
          player.vx = dx / d * spd;
          player.vy = dy / d * spd;
        }
      } else {
        player.vx = player.vy = 0;
      }
      if (player.vx || player.vy) {
        const n = Math.hypot(player.vx, player.vy);
        facing = { x: player.vx / n, y: player.vy / n };
      }
      player.x = Math.min(ARENA.w - CHAMP.radius, Math.max(CHAMP.radius, player.x + player.vx * dt));
      player.y = Math.min(ARENA.h - CHAMP.radius, Math.max(CHAMP.radius, player.y + player.vy * dt));

      // 레벨: 8초마다 하나씩(18까지). 롤처럼 레벨 업 효과
      const lv = Math.min(18, 1 + Math.floor(t / 8));
      if (lv > level) {
        level = lv;
        sfx("level");
        fx.push({ kind: "ring", x: player.x, y: player.y, r: CHAMP.radius + 30, color: "#f0e6d2", life: 0.6, max: 0.6 });
      }
      // 30초마다 생존 안내, 연속으로 피한 수에 따라 롤 안내 문구
      if (Math.floor(t / 30) > lastMark) { lastMark = Math.floor(t / 30); announce(lastMark * 30 + "초 생존!", "gold"); }
      for (const [n, text] of SPREES) {
        if (dodged >= n && lastSpree < n) { lastSpree = n; announce(text, "spree"); }
      }

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
      for (const p of pops) p.life -= dt;
      pops = pops.filter(p => p.life > 0);
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
    // 협곡 바닥 질감을 한 번만 만들어 둔다(풀밭 얼룩, 돌길, 가장자리 수풀). 바닥 좌표 절반 크기
    const TEX = (() => {
      const c = document.createElement("canvas");
      c.width = ARENA.w / 2; c.height = ARENA.h / 2;
      const g = c.getContext("2d");
      const W = c.width, H = c.height;
      g.fillStyle = "#1f3a2b";
      g.fillRect(0, 0, W, H);
      // 풀밭 얼룩
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 900; i++) {
        g.fillStyle = ["#24442f", "#1a3325", "#2a4a31", "#203d2a", "#2f5236"][Math.floor(rnd() * 5)];
        g.globalAlpha = 0.5;
        g.beginPath(); g.arc(rnd() * W, rnd() * H, 2 + rnd() * 9, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      // 가운데를 가로지르는 돌길(협곡의 미드 라인처럼 대각선)
      g.save();
      g.translate(W / 2, H / 2);
      g.rotate(-Math.atan2(H, W));
      g.fillStyle = "#5b5140";
      g.fillRect(-W, -34, W * 2, 68);
      for (let x = -W; x < W; x += 22) {
        for (const y of [-26, -4, 18]) {
          g.fillStyle = ["#6b604c", "#4f4636", "#756a55"][Math.floor(rnd() * 3)];
          g.fillRect(x + rnd() * 6, y + rnd() * 4, 16 + rnd() * 6, 10 + rnd() * 4);
        }
      }
      g.restore();
      // 강: 반대 대각선으로 얕은 물
      g.save();
      g.translate(W / 2, H / 2);
      g.rotate(Math.atan2(H, W));
      const river = g.createLinearGradient(0, -40, 0, 40);
      river.addColorStop(0, "rgba(40, 90, 110, 0)");
      river.addColorStop(0.5, "rgba(50, 110, 130, .55)");
      river.addColorStop(1, "rgba(40, 90, 110, 0)");
      g.fillStyle = river;
      g.fillRect(-W, -40, W * 2, 80);
      g.restore();
      // 가장자리 수풀
      for (let i = 0; i < 160; i++) {
        const edge = Math.floor(rnd() * 4);
        const x = edge === 0 ? rnd() * 26 : edge === 1 ? W - rnd() * 26 : rnd() * W;
        const y = edge === 2 ? rnd() * 26 : edge === 3 ? H - rnd() * 26 : rnd() * H;
        if (edge < 2 || edge >= 2) {
          g.fillStyle = ["#13301d", "#1b3f24", "#0f2818"][Math.floor(rnd() * 3)];
          g.beginPath(); g.arc(x, y, 6 + rnd() * 10, 0, Math.PI * 2); g.fill();
        }
      }
      // 가장자리를 어둡게
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.65);
      v.addColorStop(0, "rgba(0, 0, 0, 0)");
      v.addColorStop(1, "rgba(0, 0, 0, .45)");
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
      return c;
    })();

    function drawGround() {
      const bg = ctx.createLinearGradient(0, 0, 0, VH);
      bg.addColorStop(0, "#010a13");
      bg.addColorStop(1, "#06141d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, VW, VH);

      // 질감을 가로 띠로 잘라 원근에 맞게 깐다(한 줄 안에서는 가로 배율이 같아서 띠로 충분하다)
      ctx.save();
      arenaPath();
      ctx.clip();
      const N = 60, th = TEX.height / N;
      for (let i = 0; i < N; i++) {
        const y0 = ARENA.h * i / N, y1 = ARENA.h * (i + 1) / N;
        const a = proj(0, y0), b = proj(ARENA.w, y0), c = proj(0, y1), d = proj(ARENA.w, y1);
        const left = Math.min(a.x, c.x), right = Math.max(b.x, d.x);
        ctx.drawImage(TEX, 0, i * th, TEX.width, th + 0.5, left, a.y, right - left, c.y - a.y + 0.8);
      }
      ctx.restore();

      arenaPath();
      ctx.strokeStyle = "rgba(200, 170, 110, .55)";
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
    const U = () => VW / 1000;       // HUD 크기 단위(화면 폭 1000 일 때 1)

    // 머리 위 체력바. ally 면 초록(나), 아니면 빨강(적). frac: 남은 체력 비율, segs: 칸 수
    function healthBar(x, y, frac, ally, lv, name, segs = 3) {
      const u = U(), w = 96 * u, h = 11 * u, box = 16 * u;
      const left = x - w / 2 + box / 2;
      if (name) {
        ctx.font = "600 " + Math.max(9, 12 * u) + "px 'IBM Plex Sans KR', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0, 0, 0, .6)";
        ctx.fillText(name, x + 1, y - h - 4 * u + 1);
        ctx.fillStyle = ally ? "#f0e6d2" : "#ffb4b4";
        ctx.fillText(name, x, y - h - 4 * u);
      }
      ctx.fillStyle = "#010a13";
      ctx.fillRect(left - 2 * u, y - h - 2 * u, w - box + 4 * u, h + 4 * u);
      ctx.fillStyle = "#1e2328";
      ctx.fillRect(left, y - h, w - box, h);
      ctx.fillStyle = ally ? "#1fa33a" : "#c8352f";
      ctx.fillRect(left, y - h, (w - box) * Math.max(0, frac), h);
      ctx.fillStyle = "rgba(255, 255, 255, .25)";
      ctx.fillRect(left, y - h, (w - box) * Math.max(0, frac), h * 0.35);
      ctx.strokeStyle = "#010a13";
      ctx.lineWidth = Math.max(1, 1.5 * u);
      for (let i = 1; i < segs; i++) {
        const sx = left + (w - box) * i / segs;
        ctx.beginPath(); ctx.moveTo(sx, y - h); ctx.lineTo(sx, y); ctx.stroke();
      }
      // 레벨 칸
      ctx.fillStyle = "#010a13";
      ctx.fillRect(x - w / 2 - box / 2, y - h - 4 * u, box + 2 * u, h + 8 * u);
      ctx.strokeStyle = "#c8aa6e";
      ctx.lineWidth = Math.max(1, 1.2 * u);
      ctx.strokeRect(x - w / 2 - box / 2, y - h - 4 * u, box + 2 * u, h + 8 * u);
      ctx.fillStyle = "#f0e6d2";
      ctx.font = "700 " + Math.max(8, 11 * u) + "px 'IBM Plex Sans KR', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(lv), x - w / 2 + u, y - 1 * u);
    }
    function drawShadow(x, y, r) {
      groundCircle(x, y, r, 0, 24);
      ctx.fillStyle = "rgba(0, 0, 0, .4)";
      ctx.fill();
    }

    function drawPlayer() {
      // 내 챔피언(티어표 OP 챔피언) 초상화가 받침대 위에 선다. 적과 같은 모양, 테두리만 금색
      const base = proj(player.x, player.y, 0), head = upright(player.x, player.y, PORTRAIT_Z);
      const r = 46 * head.k;
      const blink = safe > 0 && Math.floor(safe * 10) % 2;
      ctx.globalAlpha = blink ? 0.4 : 1;
      if (ghostLeft > 0) {
        // 유체화: 뒤로 잔상이 남고 푸르게 빛난다
        for (let i = 3; i >= 1; i--) {
          const q = upright(player.x - player.vx * 0.05 * i, player.y - player.vy * 0.05 * i, PORTRAIT_Z);
          ctx.globalAlpha = 0.15 * (4 - i);
          ctx.fillStyle = "#66d9e8";
          ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = blink ? 0.4 : 1;
      }
      ctx.strokeStyle = "rgba(200, 170, 110, .8)";
      ctx.lineWidth = Math.max(1, 6 * base.k);
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(head.x, head.y + r); ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.clip();
      if (face.complete && face.naturalWidth) ctx.drawImage(face, head.x - r, head.y - r, r * 2, r * 2);
      else { ctx.fillStyle = "#f0b429"; ctx.fillRect(head.x - r, head.y - r, r * 2, r * 2); }
      ctx.restore();
      if (ghostLeft > 0) glow("#66d9e8", 16);
      ctx.strokeStyle = dead ? "#ff6b6b" : "#c8aa6e";
      ctx.lineWidth = Math.max(2, 5 * head.k);
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.stroke();
      noGlow();
      ctx.globalAlpha = 1;
      healthBar(head.x, head.y - r - 8 * U(), Math.max(0, lives) / LIVES, true, level, opts.name || "나", LIVES);
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
      healthBar(head.x, head.y - r - 10 * U(), 1, false, 18, c.skill.name.split(" ")[0], 5);
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

    // 떠오르는 피해 숫자(마법 피해 보라)
    function drawPops() {
      const u = U();
      for (const p of pops) {
        const a = p.life / p.max, q = upright(p.x, p.y, PORTRAIT_Z + 80 + (1 - a) * 120);
        ctx.globalAlpha = Math.min(1, a * 1.6);
        ctx.font = "800 " + Math.round(26 * u * (1 + (1 - a) * 0.2)) + "px 'IBM Plex Sans KR', sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = Math.max(2, 4 * u);
        ctx.strokeStyle = "#1a0b2e";
        ctx.strokeText(p.text, q.x, q.y);
        ctx.fillStyle = "#c084fc";
        ctx.fillText(p.text, q.x, q.y);
      }
      ctx.globalAlpha = 1;
    }

    // 미니맵: 경기장 전체를 위에서. 나는 금테 초록, 적은 빨강
    function drawMinimap() {
      const w = mini.width / DPR, h = mini.height / DPR, k = w / ARENA.w;
      mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      mctx.drawImage(TEX, 0, 0, w, h);
      mctx.fillStyle = "rgba(1, 10, 19, .25)";
      mctx.fillRect(0, 0, w, h);
      for (const z of zones) {
        mctx.globalAlpha = 0.5;
        mctx.strokeStyle = z.skill.color;
        mctx.lineWidth = 1.5;
        mctx.beginPath(); mctx.arc(z.x * k, z.y * k, z.skill.radius * k, 0, Math.PI * 2); mctx.stroke();
      }
      mctx.globalAlpha = 1;
      for (const m of missiles) {
        mctx.fillStyle = m.skill.color;
        mctx.beginPath(); mctx.arc(m.x * k, m.y * k, Math.max(1.5, m.skill.radius * k), 0, Math.PI * 2); mctx.fill();
      }
      for (const c of casters) {
        mctx.fillStyle = "#e03131";
        mctx.strokeStyle = "#010a13";
        mctx.lineWidth = 1;
        mctx.beginPath(); mctx.arc(c.x * k, c.y * k, 4, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
      }
      if (player) {
        mctx.fillStyle = "#1fa33a";
        mctx.strokeStyle = "#f0e6d2";
        mctx.lineWidth = 1.5;
        mctx.beginPath(); mctx.arc(player.x * k, player.y * k, 5, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
      }
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
        drawPops();
      }
      ctx.restore();
      drawMinimap();

      // 체력이 한 칸 남으면 화면 가장자리가 계속 붉게 숨 쉰다(롤의 낮은 체력)
      if (player && lives === 1 && state === "play") {
        const a = 0.18 + 0.1 * Math.sin(performance.now() / 250);
        const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.4, VW / 2, VH / 2, Math.max(VW, VH) * 0.72);
        g.addColorStop(0, "rgba(160, 0, 0, 0)");
        g.addColorStop(1, "rgba(160, 0, 0, " + a.toFixed(3) + ")");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, VW, VH);
      }

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
      const sec = Math.floor(t);
      hud("clock").textContent = String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
      hud("dodged").textContent = dodged;
      hud("hitcount").textContent = hits.length;
      const hp = Math.max(0, lives) * HP_MAX / LIVES;
      hud("hpfill").style.width = (hp / HP_MAX * 100) + "%";
      hud("hptext").textContent = Math.round(hp) + " / " + HP_MAX;
      hud("level").textContent = level;
      for (const sp of SPELLS) {
        const b = root.querySelector('[data-spell="' + sp.id + '"]');
        const left = cds[sp.id];
        // 쿨타임은 시계 방향으로 걷히는 그림자와 남은 초
        b.querySelector("i").style.background = left > 0
          ? "conic-gradient(rgba(1, 10, 19, .78) " + (left / sp.cd * 360) + "deg, transparent 0)" : "none";
        b.querySelector("b").textContent = left > 0 ? Math.ceil(left) : "";
        b.classList.toggle("active", sp.id === "ghost" && ghostLeft > 0);
      }
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
      clearTimeout(overTimer);
      canvas.classList.remove("dead");
      announce("소환사의 협곡에 오신 것을 환영합니다", "welcome", 2200);
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
      canvas.classList.add("dead");
      announce("처치당했습니다", "death", 1600);
      sfx("death");
      const result = { ms: Math.round(t * 1000), dodged, by: lastHit.name, ver: VERSION };
      clearTimeout(overTimer);
      overTimer = setTimeout(() => showOver(`
        <h2>처치당했습니다</h2>
        <p class="note">마지막 스킬: ${esc(lastHit.name)} · 레벨 ${level}</p>
        <p class="dodge-score">${fmt(t)}</p>
        <p class="note">피한 스킬 ${dodged}개 · 맞은 스킬 ${hits.map(esc).join(" → ")}</p>
        <div data-extra></div>
        <div class="dodge-actions">
          <button type="button" data-start>다시 하기 <small>Space</small></button>
          <button type="button" data-setup>조작 바꾸기</button>
          ${opts.links || ""}
        </div>`), 1300);
      if (opts.onEnd) {
        // 결과 창이 늦게 뜨므로 저장 결과는 창이 뜬 뒤에 넣는다
        const saved = Promise.resolve(opts.onEnd(result));
        setTimeout(() => saved.then(html => {
          const slot = over.querySelector("[data-extra]");
          if (html && slot) slot.innerHTML = html;
        }, () => {}), 1350);
      }
    }

    function showOver(html) {
      over.innerHTML = `<div class="dodge-card">${html}</div>`;
      over.hidden = false;
      const b = over.querySelector("[data-start]");
      if (b) b.onclick = start;
      const setup = over.querySelector("[data-setup]");
      if (setup) setup.onclick = () => showIntro();
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // ── 입력 ──
    function onPointerDown(e) {
      if (state !== "play") return;
      e.preventDefault();
      // WASD 방식이면 마우스 클릭으로는 움직이지 않는다(커서는 점멸 방향으로만). 터치는 늘 움직인다
      if (controls.move === "wasd" && e.pointerType === "mouse") { cursor = toArena(e); return; }
      // 우클릭이 기본. 왼쪽 클릭·터치도 받아 준다(트랙패드·휴대폰)
      holding = true;
      target = toArena(e);
      canvas.setPointerCapture?.(e.pointerId);
    }
    function onPointerMove(e) {
      cursor = toArena(e);                  // 점멸은 커서 쪽으로
      if (holding && state === "play") target = cursor;
    }
    function onPointerUp() { holding = false; }
    const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    function onKeyDown(e) {
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      const sp = SPELLS.find(x => "Key" + keyOf(x.id) === e.code);
      if (sp && state === "play") {
        e.preventDefault();
        if (!e.repeat) useSpell(sp.id);
      } else if (controls.move === "wasd" && MOVE_KEYS.includes(e.code)) {
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
    // HUD 의 주문 칸은 눌러도 쓴다(휴대폰)
    root.querySelectorAll("[data-spell]").forEach(b => b.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      useSpell(b.dataset.spell);
    }));
    const paintSound = () => {
      const on = soundOn();
      soundBtn.textContent = on ? "효과음 켜짐" : "효과음 꺼짐";
      soundBtn.setAttribute("aria-pressed", String(on));
    };
    soundBtn.onclick = () => { setSound(!soundOn()); paintSound(); };
    paintSound();
    root.querySelector('[data-hud="face"]').src = face.src;

    reset();
    fit();
    hudUpdate();
    // HUD 주문 칸의 키 글자
    function paintKeys() {
      for (const sp of SPELLS) {
        const b = root.querySelector('[data-spell="' + sp.id + '"]');
        b.querySelector("kbd").textContent = keyOf(sp.id);
        b.title = sp.name + " (" + keyOf(sp.id) + ")";
      }
    }

    // 시작 창. 이동 방식과 주문 배치를 고르면 바로 다시 그린다
    function showIntro() {
      const [a, b] = keyPair(controls.move);
      const k = spellKeys(controls);
      const on = v => (v ? "true" : "false");
      showOver(`
      <h2>스킬샷 피하기</h2>
      <p>사방에서 날아오는 스킬을 피해 오래 버티세요. ${LIVES}번 맞으면 처치당해요. 맞은 뒤 ${SAFE_AFTER_HIT}초는 무적이에요.</p>
      <div class="dodge-setup">
        <div><span>이동 방식</span>
          <div class="seg dodge-seg" role="group" aria-label="이동 방식">
            <button type="button" data-move="mouse" aria-selected="${on(controls.move === "mouse")}">마우스 클릭</button>
            <button type="button" data-move="wasd" aria-selected="${on(controls.move === "wasd")}">WASD</button>
          </div></div>
        <div><span>소환사 주문</span>
          <div class="seg dodge-seg" role="group" aria-label="소환사 주문 배치">
            <button type="button" data-order="first" aria-selected="${on(controls.flashFirst)}">점멸 ${a} · 유체화 ${b}</button>
            <button type="button" data-order="second" aria-selected="${on(!controls.flashFirst)}">유체화 ${a} · 점멸 ${b}</button>
          </div></div>
      </div>
      <ul class="dodge-keys">
        <li><b>투사체</b> 바닥 그림자가 실제 판정이에요. 옆으로 갈라지는 것도 있어요</li>
        <li><b>장판</b> 바닥 원이 다 차면 터져요</li>
        <li><b>레이저</b> 깜빡이는 선이 보이면 곧 그 선 전체를 쳐요</li>
        <li><b>감옥</b> 창살에 닿으면 맞아요. 안에 갇히면 닿지 않게 버티세요</li>
      </ul>
      <ul class="dodge-keys">
        ${controls.move === "mouse"
          ? `<li><b>우클릭</b> 찍은 곳으로 이동 (누른 채 끌면 계속 따라가요)</li>`
          : `<li><b>WASD</b> 누른 쪽으로 이동 (방향키도 돼요). 마우스는 점멸 방향만 정해요</li>`}
        <li><b>${k.flash} · ${k.ghost}</b> 점멸(커서 쪽 400) · 유체화. 쿨타임 ${SPELLS.map(sp => sp.cd + "초").join(" · ")}</li>
        <li><b>휴대폰</b> 화면을 누른 곳으로 이동, 주문은 아래 칸을 눌러요</li>
      </ul>
      <p class="note">이동 속도 ${CHAMP.speed}. 스킬 수치는 롤 클라이언트 데이터 그대로예요.</p>
      <div class="dodge-actions"><button type="button" data-start>시작 <small>Space</small></button>${opts.links || ""}</div>`);
      over.querySelectorAll("[data-move]").forEach(btn => btn.onclick = () => {
        controls.move = btn.dataset.move;
        saveControls(controls);
        keys.clear();
        paintKeys();
        showIntro();
      });
      over.querySelectorAll("[data-order]").forEach(btn => btn.onclick = () => {
        controls.flashFirst = btn.dataset.order === "first";
        saveControls(controls);
        paintKeys();
        showIntro();
      });
    }
    paintKeys();
    showIntro();

    function setBest(text) { hud("best").innerHTML = text || ""; }

    // 내 챔피언을 나중에 바꾼다(티어표를 늦게 받았을 때)
    function setChamp(key, name) {
      if (key) { face = champImage(key); root.querySelector('[data-hud="face"]').src = face.src; }
      if (name) opts.name = name;
    }

    function destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(bannerTimer);
      clearTimeout(overTimer);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", fit);
    }

    return { destroy, setBest, setChamp };
  }

  window.DodgeGame = { mount, fmt, SKILLS, VERSION };
})();
