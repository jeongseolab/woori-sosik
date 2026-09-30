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
// 그림과 소리는 롤 것을 가져다 쓴다(ART 아래 설명). 못 받으면 직접 그린 그림·합성음으로 돈다.
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
  // 연속으로 피한 수에 따라 롤 안내 문구와 아나운서 음성(롤의 연속 처치 순서 그대로)
  const SPREES = [[20, "학살 중입니다!", "spree1"], [40, "미쳐 날뛰고 있습니다!", "spree2"],
                  [60, "도저히 막을 수 없습니다!", "spree3"], [80, "전설의 출현!", "spree4"]];

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

  // ── 스킬 그림 표(롤 텍스처. 그림만이고 판정과는 상관없다) ──
  // 투사체: 앞쪽이 +x 인 틀에서 그린다. 크기는 판정 반지름의 몇 배인지.
  //   trail [스프라이트, 색, 꼬리 길이(유닛), 폭(반지름의 몇 배)] 없으면 색 번짐 꼬리
  //   under/over [스프라이트, 색, 크기, 앞뒤 자리(반지름 배), 도는 방식(spin 빙글 · jitter 매번 · up 똑바로)]
  //   keep: 직접 그린 모양(창 자루, 주먹, 화살대)도 같이 그린다
  const MISSILE_ART = {
    "모르가나 Q": { trail: ["morg_chain", "#b197fc", 320, 0.9], over: [["morg_core", null, 3.2]] },
    "럭스 Q": { under: [["glow", "#fab005", 2.2]], over: [["lux_shape", "#ffe066", 2.8, -0.4], ["glow", "#ffffff", 1]] },
    "니달리 Q": { keep: true, under: [["nida_glow", null, 4.2, -1.6]], over: [["nida_tip", "#e9fac8", 2.6, 0.1]] },
    "브랜드 Q": { under: [["glow", "#ff6b00", 3.6]], over: [["brand_flame", "#ffa94d", 3, 0, "spin"], ["glow", "#fff3bf", 1.3]] },
    "아리 E": { trail: ["ahri_trail", "#faa2c1", 260, 1.4], over: [["ahri_heart", null, 2.5, 0, "up"]] },
    "벨코즈 Q": { under: [["glow", "#9775fa", 3.2]], over: [["vel_ring", null, 2.8, 0, "spin"], ["glow", "#ffffff", 1]] },
    "제라스 E": { trail: ["veig_trail", "#748ffc", 260, 1.2], under: [["glow", "#4c6ef5", 3]], over: [["veig_ball", "#bac8ff", 2.3, 0, "spin"]] },
    "이즈리얼 Q": { trail: ["ez_trail", null, 320, 0.6], under: [["glow", "#ffd43b", 2.6]], over: [["ez_spark", "#fff3bf", 2.4, 0, "spin"], ["glow", "#ffffff", 1.1]] },
    "레오나 E": { under: [["glow", "#f59f00", 1.8]], over: [["leo_sword", null, 5.2, -1.2]] },
    "베이가 Q": { trail: ["veig_trail", "#9775fa", 280, 1.4], under: [["glow", "#7048e8", 3]], over: [["veig_soft", "#d0bfff", 2.2], ["glow", "#ffffff", 0.9]] },
    "블리츠크랭크 Q": { keep: true, under: [["glow", "#ffa94d", 3]] },
    "쓰레쉬 Q": { under: [["glow", "#20c997", 2.6]], over: [["thresh_head", "#96f2d7", 2.6]] },
    "징크스 W": { trail: ["jinx_trail", "#f783ac", 650, 1], over: [["jinx_bolt", "#fcc2d7", 2.6, 0, "jitter"], ["glow", "#ffffff", 1.3]] },
    "애쉬 R": { keep: true, trail: ["ashe_tr", null, 500, 0.4], over: [["ashe_ice", "#d0ebff", 2.4], ["ashe_shape", "#a5d8ff", 2.6, 0.2]] },
  };
  // 장판: 바닥에 눕혀 깐다. [스프라이트, 색, fit(텍스처 안에서 고리가 차지하는 반지름 비율), 도는 빠르기, 진하기]
  //   ring 테두리(처음부터) · fill 가운데서 차오름 · inner 중심부(s.inner) · late 터지기 직전·그을린 자리
  //   sky 하늘에서 떨어지는 것(fall) 이나 그 자리에 생기는 구체(rise)
  const ZONE_ART = {
    "카서스 Q": { ring: ["kar_ring", null, 0.88], fill: ["kar_burn", null, 0.52], late: ["kar_cracks", "#b2f2bb", 0.54] },
    "브랜드 W": { ring: ["brand_ring", "#ffa94d", 0.94], fill: ["brand_cracks", null, 0.84], late: ["brand_lava", null, 0.9] },
    "초가스 Q": { ring: ["cho_crack", null, 0.9], fill: ["glow", "#a9e34b", 0.68] },
    "베이가 W": { ring: ["veig_floor", "#7950f2", 0.82, 0, 0.55], fill: ["veig_soft", "#9775fa", 0.56, 0, 0.45], sky: ["veig_ball", "#b197fc", "fall"] },
    "신드라 Q": { ring: ["syn_ring", "#e599f7", 0.85, 1.5], fill: ["glow", "#cc5de8", 0.68], sky: ["syn_orb", "#eebefa", "rise"] },
    "제라스 W": { ring: ["vel_aoe", "#91a7ff", 0.78], fill: ["glow", "#748ffc", 0.68], inner: ["leo_in", "#bac8ff", 0.58, 1] },
    "벨코즈 E": { ring: ["vel_aoe", "#e599f7", 0.78], fill: ["vel_cracks", null, 0.72] },
    "레오나 R": { ring: ["leo_out", "#ffd43b", 0.65, 0.3], fill: ["glow", "#fab005", 0.68], inner: ["leo_in", "#ffe066", 0.58, -0.8] },
  };
  // 레이저: tele 시전 중 경고선, fire 쏜 순간. [스프라이트, 색, 폭(판정 반지름의 몇 배), 진하기, 가운데 토막만(mid)]
  const BEAM_ART = {
    "진 W": { tele: ["jhin_ind", null, 1, 1], fire: ["jhin_beam", null, 1.8, 1] },
    "럭스 R": { fire: ["lux_beam", "#fcc419", 1.2, 0.5, true] },   // 경고선은 직접 그린 띠(텍스처는 줄무늬가 진다)
  };

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

  // ── 롤 그림·소리 ──
  // 그림: 롤 클라이언트의 파티클 텍스처(CommunityDragon 이 푼 game/assets/characters/*/skins/base/particles/*.png)
  //   를 한 장(dodge/fx.webp) 으로 묶었다. 흰 텍스처는 여기서 스킬 색을 곱해 입힌다(spr).
  //   바닥은 소환사의 협곡 미드 라인 바닥 텍스처(maps/kitpieces/srx/base/textures/terrain_midlane_ground_a.png) 를 잘랐다
  // 소리: 롤 위키(wiki.leagueoflegends.com) 에 올라온 효과음·아나운서 음성(dodge/sfx/*.ogg).
  //   위키에 기본 스킨 효과음이 있는 스킬(럭스·베이가·초가스), 점멸·유체화, 아나운서만 진짜 소리고 나머지는 합성음
  const ART = "dodge/";
  // 스프라이트 자리 [x, y, 폭, 높이]. 날아가는 것은 앞쪽이 오른쪽(+x) 을 보게 돌려 두었다
  const FX_MAP = {
    ahri_heart: [776, 774, 128, 128],
    ahri_trail: [630, 1292, 256, 86],
    ashe_ice: [754, 1032, 128, 128],
    ashe_shape: [0, 1387, 128, 83],
    ashe_tr: [884, 1032, 128, 128],
    brand_cracks: [258, 0, 256, 256],
    brand_flame: [646, 774, 128, 128],
    brand_lava: [516, 0, 256, 256],
    brand_ring: [0, 0, 256, 256],
    cho_crack: [0, 774, 256, 256],
    cho_spike: [260, 1162, 48, 128],
    ez_spark: [711, 1387, 64, 64],
    ez_trail: [453, 1387, 256, 64],
    glow: [387, 1387, 64, 64],
    jhin_beam: [258, 1292, 370, 88],
    jhin_ind: [0, 1538, 512, 31],
    jinx_bolt: [624, 1032, 128, 128],
    jinx_trail: [0, 1472, 256, 64],
    kar_burn: [0, 1162, 128, 128],
    kar_cracks: [516, 516, 256, 256],
    kar_ring: [258, 516, 256, 256],
    kar_shock: [130, 1162, 128, 128],
    leo_in: [130, 1032, 128, 128],
    leo_out: [516, 258, 256, 256],
    leo_sword: [505, 1472, 128, 51],
    lux_beam: [258, 774, 256, 176],
    lux_shape: [888, 1292, 128, 85],
    morg_chain: [514, 1538, 128, 29],
    morg_core: [516, 774, 128, 128],
    nida_glow: [257, 1387, 128, 69],
    nida_tip: [130, 1387, 125, 76],
    syn_orb: [310, 1162, 128, 128],
    syn_ring: [440, 1162, 128, 128],
    thresh_chain: [258, 1472, 245, 57],
    thresh_head: [520, 1032, 102, 128],
    veig_ball: [390, 1032, 128, 128],
    veig_floor: [0, 516, 256, 256],
    veig_soft: [260, 1032, 128, 128],
    veig_trail: [570, 1162, 256, 101],
    veig_wall: [0, 1292, 256, 93],
    vel_aoe: [0, 258, 256, 256],
    vel_cracks: [258, 258, 256, 256],
    vel_ring: [0, 1032, 128, 128],
  };
  const fxImg = new Image(), groundImg = new Image();
  let fxReady = false, groundReady = false;
  function loadArt() {
    if (fxImg.src) return;
    fxImg.onload = () => { fxReady = true; };
    groundImg.onload = () => { groundReady = true; };
    fxImg.src = ART + "fx.webp";
    groundImg.src = ART + "ground.jpg";
  }
  // 스프라이트 한 칸을 떼어 둔다. color 를 주면 그 색을 곱해 입힌다(흰 텍스처용). 한 번 만든 건 다시 쓴다
  const SPR = new Map();
  function spr(name, color) {
    const key = name + (color || "");
    let c = SPR.get(key);
    if (c) return c;
    const [x, y, w, h] = FX_MAP[name];
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.drawImage(fxImg, x, y, w, h, 0, 0, w, h);
    if (color) {
      g.globalCompositeOperation = "multiply";
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(fxImg, x, y, w, h, 0, 0, w, h);
    }
    SPR.set(key, c);
    return c;
  }

  // ── 효과음: 위키의 진짜 소리를 먼저, 없거나 못 풀면(오프라인·구형 사파리) WebAudio 합성음.
  // 켜고 끄기와 볼륨(0~100%) 을 브라우저에 기억한다. 모든 소리는 master 하나를 거쳐 나가서 볼륨을 바꾸면 나는 중인 소리도 바로 바뀐다 ──
  const SOUND_KEY = "tiergg-dodge-sound";
  const VOLUME_KEY = "tiergg-dodge-volume";
  let audio = null, master = null;
  function soundOn() { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } }
  function setSound(on) { try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch {} }
  function volume() {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY));
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
    } catch { return 0.7; }
  }
  function setVolume(v) {
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {}
    if (master) master.gain.value = v;
  }
  function ensureAudio() {
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        master = audio.createGain();
        master.gain.value = volume();
        master.connect(audio.destination);
      }
      if (audio.state === "suspended") audio.resume().catch(() => {});
    } catch {}
    return audio;
  }
  const SAMPLES = ["flash", "ghost", "welcome", "slain", "spree1", "spree2", "spree3", "spree4",
                   "lux_q", "lux_q_hit", "lux_r", "lux_r_beam", "veigar_q", "veigar_q_hit", "veigar_w", "veigar_w_hit",
                   "veigar_e", "veigar_e_form", "cho_q"];
  const buffers = {};
  let samplesAsked = false;
  function loadSamples() {
    if (samplesAsked || !ensureAudio()) return;
    samplesAsked = true;
    for (const name of SAMPLES) {
      fetch(ART + "sfx/" + name + ".ogg")
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(b => new Promise((ok, no) => audio.decodeAudioData(b, ok, no)))
        .then(buf => { buffers[name] = buf; }, () => {});
    }
  }
  // 받아 둔 진짜 소리를 튼다. 없으면 false(부른 쪽이 합성음으로 대신한다)
  function sample(name, vol = 0.5) {
    if (!soundOn() || !audio || !buffers[name]) return false;
    if (volume() <= 0) return true;          // 볼륨 0 이면 조용히(합성음으로 대신하지도 않는다)
    try {
      const src = audio.createBufferSource(), g = audio.createGain();
      src.buffer = buffers[name];
      g.gain.value = vol;
      src.connect(g); g.connect(master);
      src.start();
      return true;
    } catch { return false; }
  }
  // 스킬별 진짜 소리. cast 누르는 순간, release 날아가거나 장판이 생길 때, land 장판이 터질 때,
  // form 감옥이 설 때, hit 내가 맞았을 때
  const SKILL_SFX = {
    "럭스 Q": { release: "lux_q", hit: "lux_q_hit" },
    "럭스 R": { cast: "lux_r", release: "lux_r_beam" },
    "베이가 Q": { release: "veigar_q", hit: "veigar_q_hit" },
    "베이가 W": { release: "veigar_w", land: "veigar_w_hit" },
    "베이가 E": { release: "veigar_e", form: "veigar_e_form" },
    "초가스 Q": { release: "cho_q" },
  };
  function skillSound(s, when) {
    const name = (SKILL_SFX[s.name] || {})[when];
    if (name && sample(name, 0.4)) return;
    // 진짜 소리가 없는 스킬: 투사체는 바람 가르는 소리, 장판은 터지는 소리(작게)
    if (when === "release" && s.kind === "line") sfx("whoosh");
    else if (when === "land") sfx("thump");
  }

  function sfx(kind) {
    if (!soundOn() || volume() <= 0) return;
    if ((kind === "flash" || kind === "ghost") && sample(kind, 0.5)) return;
    try {
      ensureAudio();
      const now = audio.currentTime;
      const out = audio.createGain();
      out.connect(master);
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
      // 거른 잡음(바람 소리·폭발)
      const noise = (dur, vol, f0, f1) => {
        const len = Math.floor(audio.sampleRate * dur), b = audio.createBuffer(1, len, audio.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const n = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
        n.buffer = b;
        f.type = "bandpass";
        f.frequency.setValueAtTime(f0, now);
        f.frequency.exponentialRampToValueAtTime(f1, now + dur);
        g.gain.setValueAtTime(vol, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        n.connect(f); f.connect(g); g.connect(out);
        n.start(now);
      };
      if (kind === "hit") { tone("square", 180, 60, 0.18, 0.12); tone("sine", 90, 40, 0.25, 0.2); }
      else if (kind === "flash") { tone("sine", 400, 1400, 0.16, 0.12); tone("triangle", 900, 2400, 0.12, 0.06, 0.03); }
      else if (kind === "ghost") { tone("sine", 300, 700, 0.3, 0.08); }
      else if (kind === "level") { tone("triangle", 660, 990, 0.12, 0.07); tone("triangle", 990, 1320, 0.16, 0.06, 0.1); }
      else if (kind === "announce") { tone("sine", 523, 523, 0.25, 0.06); tone("sine", 784, 784, 0.35, 0.05, 0.12); }
      else if (kind === "death") { tone("sawtooth", 300, 70, 0.9, 0.08); tone("sine", 150, 50, 1.1, 0.12); }
      else if (kind === "deny") { tone("square", 160, 150, 0.08, 0.05); }
      else if (kind === "whoosh") { noise(0.22, 0.05, 2400, 700); }
      else if (kind === "thump") { noise(0.3, 0.08, 500, 90); tone("sine", 110, 45, 0.3, 0.1); }
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
        <label class="dodge-volume" title="효과음 볼륨">
          <span>볼륨</span>
          <input type="range" min="0" max="100" step="5" data-volume aria-label="효과음 볼륨">
          <b data-volume-text></b>
        </label>
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
    const volInput = root.querySelector("[data-volume]");
    const volText = root.querySelector("[data-volume-text]");
    let face = champImage(opts.champ || "Ezreal");
    const over = root.querySelector("[data-over]");
    const hud = name => root.querySelector(`[data-hud="${name}"]`);
    preload();
    loadArt();
    // 연습장에 들어온 것 자체가 클릭이라 소리를 미리 받아 풀어 둔다(첫 판 "환영합니다" 부터 나오게)
    if (soundOn()) loadSamples();

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
      skillSound(skill, "cast");
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
    function announce(text, kind = "gold", ms = 1800, voice = "") {
      banner.innerHTML = "<b>" + esc(text) + "</b>";
      banner.className = "lol-banner show " + kind;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.className = "lol-banner"; }, ms);
      if (kind !== "death" && !(voice && sample(voice, 0.7))) sfx("announce");
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
      fx.push({ kind: "spark", x: player.x, y: player.y, color: s.color, life: 0.35, max: 0.35 });
      // 롤처럼 머리 위로 피해 숫자(마법 피해는 보라)
      pops.push({ x: player.x, y: player.y, text: String(Math.round(HP_MAX / LIVES)), life: 1, max: 1 });
      sfx("hit");
      skillSound(s, "hit");
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
      skillSound(s, "release");
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
      for (const [n, text, voice] of SPREES) {
        if (dodged >= n && lastSpree < n) { lastSpree = n; announce(text, "spree", 1800, voice); }
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
            boom(z.x, z.y, s.radius, s.color, s);
            skillSound(s, "land");
            if (d < s.radius + CHAMP.radius && hit(s)) { if (dead) return; }
            else dodged += 1;
            continue;
          }
        }
        if (s.kind === "cage") {
          // 테두리에 몸이 닿으면 맞는다. 안에 갇혔으면 테두리에 닿지 않게 버텨야 한다
          if (!z.formed) {
            z.formed = true;
            fx.push({ kind: "ring", x: z.x, y: z.y, r: s.radius, color: s.color, life: 0.4, max: 0.4 });
            skillSound(s, "form");
          }
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

    // 장판이 터짐: 빛기둥 + 퍼지는 고리 + 파편 + 그을린 바닥(초가스 Q 는 가시가 솟는다)
    function boom(x, y, r, color, s) {
      fx.push({ kind: "pillar", x, y, r, color, life: 0.4, max: 0.4 });
      fx.push({ kind: "ring", x, y, r, color, life: 0.35, max: 0.35 });
      fx.push({ kind: "shock", x, y, r, color, life: 0.45, max: 0.45 });
      fx.push({ kind: "scorch", x, y, r, color, art: s && ZONE_ART[s.name], life: 0.9, max: 0.9 });
      if (s && s.name === "초가스 Q") fx.push({ kind: "spikes", x, y, r, color, life: 0.7, max: 0.7, seed: Math.random() * 6 });
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

    // ── 롤 텍스처 깔기 ──
    // 바닥에 눕힌 스프라이트: 바닥 (x, y) 가운데, 반지름 r(유닛) 인 정사각형을 원근에 맞춰 편다.
    // 원 하나 크기에서는 원근의 휨이 작아서 평행사변형(아핀 변환) 으로 충분하다
    function floorSprite(img, x, y, r, rot = 0, alpha = 1) {
      if (r <= 0 || alpha <= 0) return;
      const c = proj(x, y), cs = Math.cos(rot) * r, sn = Math.sin(rot) * r;
      const u = proj(x + cs, y + sn), v = proj(x - sn, y + cs);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.transform(u.x - c.x, u.y - c.y, v.x - c.x, v.y - c.y, c.x, c.y);
      ctx.drawImage(img, -1, -1, 2, 2);
      ctx.restore();
    }
    // 바닥에 눕힌 띠(a -> b, 반쪽 폭 hw). 길면 원근 때문에 휘니 150 유닛씩 잘라 편다.
    // 조각마다 이미지를 그리면 조각 가장자리가 흐려져 이음매에 줄이 진다. 그래서 반복 무늬(pattern) 로 조각 사각형을 칠한다.
    // mid 면 텍스처의 가운데 토막만 이어 붙인다(길이 방향 양끝이 옅어지는 텍스처가 토막마다 되풀이되지 않게)
    const PATTERN = new Map();
    function floorStrip(img, a, b, hw, alpha = 1, mid = false) {
      let pat = PATTERN.get(img);
      if (!pat) { pat = ctx.createPattern(img, "repeat"); PATTERN.set(img, pat); }
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * hw, ny = dx / len * hw;
      const n = Math.max(1, Math.ceil(len / 150)), W = img.width, H = img.height;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pat;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const x0 = a.x + dx * t0, y0 = a.y + dy * t0, x1 = a.x + dx * t1, y1 = a.y + dy * t1;
        const o = proj(x0 + nx, y0 + ny), e = proj(x1 + nx, y1 + ny), q = proj(x0 - nx, y0 - ny), w = proj(x1 - nx, y1 - ny);
        // 무늬: 조각 평행사변형(o, e, q) 에 텍스처의 [sx, sx + sw] × [0, H] 가 오게. 칠하는 건 원근 그대로의 네 귀퉁이라
        // 옆 조각과 모서리가 딱 맞는다(평행사변형 그대로 칠하면 원근 때문에 틈이 벌어진다)
        const sx = mid ? W * 0.4 : W * t0, sw = mid ? W * 0.2 : W * (t1 - t0);
        pat.setTransform(new DOMMatrix([e.x - o.x, e.y - o.y, q.x - o.x, q.y - o.y, o.x, o.y]).scale(1 / sw, 1 / H).translate(-sx, 0));
        ctx.beginPath();
        ctx.moveTo(o.x, o.y); ctx.lineTo(e.x, e.y); ctx.lineTo(w.x, w.y); ctx.lineTo(q.x, q.y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    // 화면에 세운 스프라이트(가운데 x, y, 폭 w). 높이는 텍스처 비율대로
    function standSprite(img, x, y, w, alpha = 1, rot = 0) {
      if (w <= 0 || alpha <= 0) return;
      const h = w * img.height / img.width;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      if (rot) ctx.rotate(rot);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
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
      // 협곡 미드 라인 바닥(받기 전이나 못 받으면 직접 그린 바닥)
      const src = groundReady ? groundImg : TEX;
      const N = 60, th = src.height / N;
      for (let i = 0; i < N; i++) {
        const y0 = ARENA.h * i / N, y1 = ARENA.h * (i + 1) / N;
        const a = proj(0, y0), b = proj(ARENA.w, y0), c = proj(0, y1), d = proj(ARENA.w, y1);
        const left = Math.min(a.x, c.x), right = Math.max(b.x, d.x);
        ctx.drawImage(src, 0, i * th, src.width, th + 0.5, left, a.y, right - left, c.y - a.y + 0.8);
      }
      if (groundReady) {
        // 스킬 빛이 잘 보이게 바닥을 조금 어둡게, 가장자리는 더(롤 화면 가장자리의 그늘처럼)
        const m = proj(ARENA.w / 2, ARENA.h / 2);
        const v = ctx.createRadialGradient(m.x, m.y, VW * 0.15, m.x, m.y, VW * 0.62);
        v.addColorStop(0, "rgba(1, 10, 19, .12)");
        v.addColorStop(1, "rgba(1, 10, 19, .5)");
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, VW, VH);
      }
      ctx.restore();

      arenaPath();
      ctx.strokeStyle = "rgba(200, 170, 110, .55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 롤 텍스처로 그린 장판(ZONE_ART). 텍스처의 고리가 실제 판정 원에 맞게 크기를 맞추고(fit),
    // 판정 원은 가는 선으로 한 번 더 긋는다
    function drawZoneArt(z, s, p, art) {
      const now = performance.now() / 1000;
      const lay = (spec, r, alpha) => {
        if (!spec) return;
        const [name, color, fit, spin = 0, k = 1] = spec;
        floorSprite(spr(name, color), z.x, z.y, r / fit, spin * now, alpha * k);
      };
      ctx.globalCompositeOperation = "lighter";
      lay(art.fill, s.radius * Math.max(0.05, p), 0.35 + 0.55 * p);
      lay(art.ring, s.radius, 0.6 + 0.4 * p);
      if (s.inner) lay(art.inner, s.inner, 0.5 + 0.5 * p);
      lay(art.late, s.radius, Math.max(0, p * 2 - 1));
      ctx.globalCompositeOperation = "source-over";
      groundCircle(z.x, z.y, s.radius);
      ctx.strokeStyle = s.color + "99";
      ctx.lineWidth = 1.5;
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
          const art = fxReady && ZONE_ART[s.name];
          if (art) { drawZoneArt(z, s, p, art); continue; }
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
          if (!forming && fxReady) {
            // 베이가 E: 감옥 안 바닥이 보랏빛으로 물든다
            ctx.globalCompositeOperation = "lighter";
            floorSprite(spr("veig_floor", "#845ef7"), z.x, z.y, s.radius / 0.82, 0, ctx.globalAlpha * 0.6);
            ctx.globalCompositeOperation = "source-over";
          }
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
        const art = fxReady && BEAM_ART[c.skill.name];
        if (art && art.tele) {
          const [name, color, wide, k, mid] = art.tele;
          ctx.globalCompositeOperation = "lighter";
          floorStrip(spr(name, color), a, b, c.skill.radius * wide, k * (Math.floor(t * 12) % 2 ? 0.95 : 0.55), mid);
          ctx.globalCompositeOperation = "source-over";
          continue;
        }
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
        const art = fxReady && BEAM_ART[f.skill.name];
        if (art) {
          const [name, color, wide, k, mid] = art.fire;
          floorStrip(spr(name, color), f.a, f.b, f.skill.radius * wide * (1 + (1 - a) * 0.3), a * k, mid);
        }
        else {
          groundBand(f.a, f.b, f.skill.radius * (1 + (1 - a) * 0.4));
          ctx.fillStyle = f.skill.color + Math.round(a * 200).toString(16).padStart(2, "0");
          glow(f.skill.color, 30);
          ctx.fill();
        }
        groundBand(f.a, f.b, f.skill.radius * 0.35);
        ctx.fillStyle = "#ffffff" + Math.round(a * 230).toString(16).padStart(2, "0");
        ctx.fill();
        noGlow();
        ctx.globalCompositeOperation = "source-over";
      }

      // 장판이 터진 자리: 퍼지는 충격파와 잠깐 남는 그을린 바닥
      if (fxReady) {
        ctx.globalCompositeOperation = "lighter";
        for (const f of fx) {
          const a = f.life / f.max;
          if (f.kind === "shock") floorSprite(spr("kar_shock", f.color), f.x, f.y, f.r * (0.9 + (1 - a) * 0.6) / 0.6, 0, a);
          if (f.kind === "scorch") {
            const late = f.art && f.art.late;
            if (late) floorSprite(spr(late[0], late[1]), f.x, f.y, f.r / late[2], 0, a * 0.8);
            else floorSprite(spr("kar_cracks", f.color), f.x, f.y, f.r * 0.9 / 0.54, 0, a * 0.7);
          }
        }
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

      // 사슬: 쏜 사람에서 갈고리까지. 쓰레쉬는 초록 빛 사슬(롤 텍스처)
      if (look === "hook") {
        const o = upright(m.ox, m.oy, zh);
        if (fxReady && s.champ === "Thresh") {
          const L = Math.hypot(p.x - o.x, p.y - o.y), W = Math.max(6, 30 * p.k);
          ctx.save();
          ctx.translate(o.x, o.y);
          ctx.rotate(Math.atan2(p.y - o.y, p.x - o.x));
          ctx.globalCompositeOperation = "lighter";
          ctx.drawImage(spr("thresh_chain"), 0, -W / 2, L, W);
          ctx.restore();
        } else {
          ctx.strokeStyle = "#adb5bd";
          ctx.lineWidth = Math.max(1.5, 6 * p.k);
          ctx.setLineDash([Math.max(3, 14 * p.k), Math.max(2, 8 * p.k)]);
          ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          ctx.setLineDash([]);
        }
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

      // 직접 그린 모양(텍스처를 못 받았을 때, 또는 keep 인 스킬의 몸통)
      const drawLook = () => {
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
      };

      // 롤 텍스처로 그린 모양(MISSILE_ART)
      const art = fxReady && MISSILE_ART[s.name.replace(" (갈라짐)", "")];
      if (art) {
        // 벨코즈 Q: 갈라지기 직전 부풀며 번쩍인다(경로는 안 보여 준다)
        let k = 1;
        if (m.splitIn != null) {
          const tt = 1 - Math.max(0, m.splitIn) / s.split.telegraph;
          k = 1 + 0.45 * tt;
          ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(tt * Math.PI * 3));
          ctx.fillStyle = "#ffffff";
          ctx.beginPath(); ctx.arc(0, 0, r * k * 1.25, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (art.trail) {
          const [name, color, len, wide] = art.trail;
          const L = Math.min(m.flown, len) * fw, H = r * wide * 2, img = spr(name, color), W = img.width;
          // 머리에서 멀어질수록 옅게(네 토막)
          for (let i = 0; i < 4 && L > 1; i++) {
            ctx.globalAlpha = 1 - i * 0.25;
            ctx.drawImage(img, W * (3 - i) / 4, 0, W / 4, img.height, -L * (i + 1) / 4, -H / 2, L / 4 + 0.5, H);
          }
          ctx.globalAlpha = 1;
        } else {
          trail(Math.min(m.flown, s.radius * 5), r * 0.8, s.color);
        }
        const now = performance.now() / 1000;
        const put = list => (list || []).forEach(([name, color, size, dx = 0, mode = ""]) => {
          const rot = mode === "spin" ? now * 6 : mode === "jitter" ? Math.random() * Math.PI * 2 : mode === "up" ? -ang : 0;
          standSprite(spr(name, color), dx * r, 0, r * size * k, 1, rot);
        });
        put(art.under);
        if (art.keep) drawLook();
        else core(r * k, "#ffffff", s.color, 1.1, 0.3);     // 판정 크기의 옅은 구슬(바닥 그림자가 진짜 판정)
        ctx.globalCompositeOperation = "lighter";
        put(art.over);
      } else {
        drawLook();
      }
      ctx.restore();
    }

    // 감옥 창살. 뒤쪽(먼 쪽) 과 앞쪽을 나눠 그려서 안에 선 사람이 창살 사이로 보이게 한다
    function drawCageBars(front) {
      for (const z of zones) {
        if (z.skill.kind !== "cage" || z.wait > 0) continue;
        const s = z.skill, n = 28, hgt = 170;
        const a = z.done != null ? Math.max(0, z.done / 0.3) : 1;
        if (fxReady) {
          // 테두리를 따라 세운 에너지 벽. 앞쪽 반과 뒤쪽 반을 따로 그린다
          const img = spr("veig_wall"), W = img.width;
          ctx.globalCompositeOperation = "lighter";
          for (let i = 0; i < n; i++) {
            const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
            if ((Math.sin((a0 + a1) / 2) > 0) !== front) continue;
            const x0 = z.x + Math.cos(a0) * s.radius, y0 = z.y + Math.sin(a0) * s.radius;
            const x1 = z.x + Math.cos(a1) * s.radius, y1 = z.y + Math.sin(a1) * s.radius;
            const o = proj(x0, y0, hgt), e = proj(x1, y1, hgt), q = proj(x0, y0, 0);
            ctx.save();
            ctx.globalAlpha = a * 0.9;
            ctx.transform(e.x - o.x, e.y - o.y, q.x - o.x, q.y - o.y, o.x, o.y);
            ctx.drawImage(img, (i % 4) * W / 4, 0, W / 4, img.height, 0, 0, 1.03, 1);
            ctx.restore();
          }
          ctx.globalCompositeOperation = "source-over";
        }
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
        if (fxReady) {
          const b = proj(f.x, f.y, 0), w = f.r * 1.5 * b.k * (0.5 + 0.5 * a), h = 520 * b.k * (1.25 - a);
          ctx.globalAlpha = a * 0.9;
          ctx.drawImage(spr("glow", f.color), b.x - w / 2, b.y - h, w, h * 1.15);
          ctx.drawImage(spr("glow", "#ffffff"), b.x - w / 5, b.y - h * 0.9, w / 2.5, h);
          continue;
        }
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
      if (fxReady) {
        for (const f of fx) {
          const a = f.life / f.max;
          if (f.kind === "spark") {
            // 맞은 자리의 불꽃(이즈리얼 Q 적중 텍스처를 스킬 색으로)
            const q = upright(f.x, f.y, 100);
            standSprite(spr("ez_spark", f.color), q.x, q.y, 320 * q.k * (1.3 - 0.5 * a), a, f.x);
          } else if (f.kind === "spikes") {
            // 초가스 Q: 땅에서 가시가 솟았다가 가라앉는다
            ctx.globalCompositeOperation = "source-over";
            const img = spr("cho_spike", "#d8f5a2");
            const rise = Math.min(1, (1 - a) * 6) * Math.min(1, a * 2.5);
            for (let i = 0; i < 9; i++) {
              const ang = f.seed + i * 2.4, rr = f.r * (0.15 + 0.7 * ((i * 37) % 10) / 10);
              const b = proj(f.x + Math.cos(ang) * rr, f.y + Math.sin(ang) * rr, 0);
              const H = 260 * b.k * rise * (0.7 + 0.3 * ((i * 53) % 7) / 7), W = H * img.width / img.height * 1.4;
              // 텍스처가 옅어서 두 번 겹쳐 진하게
              if (H > 1) { ctx.drawImage(img, b.x - W / 2, b.y - H, W, H); ctx.drawImage(img, b.x - W / 2, b.y - H, W, H); }
            }
            ctx.globalCompositeOperation = "lighter";
          }
        }
        // 하늘에서 떨어지는 암흑 물질(베이가 W), 그 자리에 생기는 구체(신드라 Q)
        for (const z of zones) {
          const art = ZONE_ART[z.skill.name];
          if (!art || !art.sky || z.wait <= 0) continue;
          const pr = 1 - z.wait / z.total, [name, color, how] = art.sky;
          if (how === "fall") {
            const q = upright(z.x, z.y, 40 + 1100 * Math.pow(1 - pr, 1.3));
            standSprite(spr("glow", color), q.x, q.y, z.skill.radius * 1.4 * q.k, 0.7);
            standSprite(spr(name, color), q.x, q.y, z.skill.radius * 0.8 * q.k, 1, pr * 8);
          } else {
            const q = upright(z.x, z.y, 70);
            standSprite(spr(name, color), q.x, q.y, z.skill.radius * 0.9 * q.k * pr, pr);
          }
        }
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
      mctx.drawImage(groundReady ? groundImg : TEX, 0, 0, w, h);
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
      ensureAudio();
      announce("소환사의 협곡에 오신 것을 환영합니다", "welcome", 2200, "welcome");
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
      setTimeout(() => sample("slain", 0.7), 350);   // "당신은 처치당했습니다!"(아나운서)
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
      volInput.value = Math.round(volume() * 100);
      volText.textContent = volInput.value + "%";
      volInput.disabled = !on;
    };
    // 슬라이더를 미는 동안 바로 바뀌고, 놓으면 점멸 소리로 크기를 들려 준다
    volInput.oninput = () => { setVolume(volInput.value / 100); volText.textContent = volInput.value + "%"; };
    volInput.onchange = () => { ensureAudio(); loadSamples(); sfx("flash"); };
    soundBtn.onclick = () => { setSound(!soundOn()); paintSound(); if (soundOn()) loadSamples(); };
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
      <p class="note">이동 속도 ${CHAMP.speed}. 스킬 수치·그림은 롤 클라이언트, 소리는 롤 위키 것이에요.</p>
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
