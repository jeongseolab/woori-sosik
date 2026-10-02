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
//
// 모드: 노멀(맞으면 목숨만 준다, 맞은 뒤 1초 무적) · 하드(무적 없이 스킬의 CC 를 예외 없이 당한다).
// 하드 모드의 CC 는 applyCC 에 스킬마다 적었다. 값은 롤 클라이언트 데이터(16.19 의 DataValues),
// 데이터에 없는 것은 롤 위키·나무위키. 스킬 레벨은 게임이 흐를수록 오른다(내 레벨 3마다 1, 13레벨에 5).
// CC 규칙(나무위키 "군중제어기"): 기절·속박·매혹·공중에 뜸 중에는 점멸을 못 쓴다(유체화·정화는 된다).
// 둔화는 가장 센 것 하나만, 이동 속도는 110 아래로 안 내려간다(매혹의 둔화는 예외).
// 정화는 공중에 뜸을 뺀 CC 를 풀고 3초 동안 강인함 75%(그 사이 새 CC 의 지속 시간이 1/4).
// 공중에 뜸은 강인함·정화가 안 통한다.
//
// 그림은 dodge-gl.js 의 WebGL 층을 거친다(빛 번짐·충격파 왜곡·노이즈 침식 파티클). 못 쓰면 2D 로 그린다.

(function () {
  // 게임 규칙이 바뀌면 올린다. 서버는 같은 버전의 기록끼리만 순위를 매긴다
  const VERSION = 10;

  const ARENA = { w: 1400, h: 900 };
  const CHAMP = { radius: 65, speed: 335 };
  const STEP = 1 / 240;
  const FAR = 4000;            // 경기장보다 긴 사거리(레이저 등)
  // 소환사 주문. 아이콘·실제 쿨타임(점멸 300초, 유체화 240초) 은 롤 데이터(summoner-spells.json),
  // 점멸 거리 400·유체화 이속(+24~48%) 은 롤 위키. 쿨타임과 유체화 지속 시간은 이 게임에 맞게 줄였다
  const ICONS = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d/";
  // 정화: 쿨타임 240초(롤 데이터), 공중에 뜸·제압을 뺀 CC 를 풀고 3초 동안 강인함 75%(14.10 패치, 나무위키).
  // 쿨타임은 유체화(실제 240초) 와 같게 20초로 줄였다
  const SPELLS = [
    { id: "flash", name: "점멸", cd: 15, range: 400, icon: ICONS + "summoner_flash.png",
      desc: "커서 쪽으로 짧은 거리(400)를 순간이동합니다. 기절·속박·매혹·공중에 뜸 중에는 못 써요." },
    { id: "ghost", name: "유체화", cd: 20, last: 3, bonus: 0.4, icon: ICONS + "summoner_haste.png",
      desc: "3초 동안 이동 속도가 40% 오릅니다." },
    { id: "cleanse", name: "정화", cd: 20, last: 3, tenacity: 0.75, icon: ICONS + "summoner_boost.png",
      desc: "공중에 뜸을 뺀 모든 CC 를 풀고, 3초 동안 강인함 75%를 얻습니다. 노멀 모드에는 CC 가 없어요." },
  ];
  const spellById = id => SPELLS.find(sp => sp.id === id);

  // 내 챔피언의 이동기(tools/champ_models.py 의 MOBILITY·PASSIVE 와 같은 42명). 그 칸만 켜지고 나머지 칸은 어둡다.
  // 여러 칸을 쓰는 챔피언(암베사 Q·W·E) 은 배열로 적는다
  //   slot: 0~3(Q W E R). kind: blink(순간이동) | dash(돌진)
  //   range: 최대 거리. min: 커서가 더 가까워도 이만큼은 간다. fixed: 늘 range 만큼. back: 커서 반대쪽으로(뒤로 뛰기)
  //   speed: 돌진 속도(유닛/초) 또는 dur: 걸리는 시간(초). untarget: 이 초 동안 스킬이 통과(피즈 E)
  //   windup: 시전 시간. 이 동안 제자리에서 스킬 동작을 하고 그 뒤에 움직인다(방향은 누른 순간에 정해진다)
  //   ret: 이 초 뒤 제자리로 돌아온다(조이 R). recall: 이 초 안에 다시 누르면 처음 자리로 돌아간다(르블랑 W)
  //   recast: 스킬이 통과하는 동안 한 번 더 누르면 또 뛴다 {range, dur}(피즈 E 의 두 번째 뛰기)
  //   stealth: 이 초 동안 투명. 적은 마지막으로 본 자리를 노린다. haste: 그동안 이동 속도 +비율.
  //   realm: 오로라 W 처럼 "다른 차원" 에 들어간 연출(화면 색이 바뀐다)
  //   charges·gap·window: window 초 안에 gap 초 간격으로 charges 번(아리 R). dirs: 위·아래·왼쪽·오른쪽 방향마다 쿨타임이 따로(벨베스 Q)
  //   unstoppable: 돌진 중에 맞아도 CC 를 받지 않는다(말파이트 R). dashAnim: 돌진 중 3D 동작(없으면 그 스킬 동작)
  //   passive: 스킬을 쓰면 패시브 돌진이 따라 나오는 챔피언(칼리스타·암베사). 설명에 "패시브" 를 붙인다
  //   steady: 시전 중에도 CC 로 끊기지 않고 저지 불가(암베사 R). anim: 시전 동작(없으면 spell1~4). desc: 설명을 통째로
  //   amb: 암베사 스킬(q·w·e·r). 시전·돌진·도착 때 그 스킬의 효과를 낸다(ambStrike·ambLand)
  //   cd: 롤 최대 레벨 쿨타임(기본 스킬 5레벨, 궁극기 3레벨). 게임에서는 skillCd() 로 4~20초 안으로 맞춘다
  //   src: 거리·속도의 출처. data = 롤 클라이언트 데이터(CommunityDragon, 2026-10-02 받음.
  //   DashSpeed·DashDistance·castRangeDisplayOverride 등), 추정 = 데이터에 없어(챔피언 스크립트 안의 값) 롤 지식으로 적은 값.
  //   "DashBonusSpeed"·"DashSpeedRatio" 는 이동 속도에 더하는 값이라 CHAMP.speed 를 더했다
  const MOBILITY = {
    ezreal: { slot: 2, kind: "blink", range: 475, windup: 0.25, cd: 14, src: "data(windup: spellCastTime)" },
    lucian: { slot: 2, kind: "dash", range: 425, min: 200, speed: 1350, cd: 14, src: "data" },
    graves: { slot: 2, kind: "dash", range: 375, min: 275, speed: 750, cd: 12, src: "data" },
    vayne: { slot: 0, kind: "dash", range: 300, fixed: true, speed: 900, cd: 2, src: "range: data, speed: 추정" },
    corki: { slot: 1, kind: "dash", range: 600, min: 300, speed: 650 + CHAMP.speed, cd: 12, src: "data" },
    tristana: { slot: 1, kind: "dash", range: 900, speed: 1100, cd: 14, src: "range: data, speed: 추정" },
    gragas: { slot: 2, kind: "dash", range: 600, fixed: true, speed: 900, cd: 12, src: "data" },
    gnar: { slot: 2, kind: "dash", range: 475, dur: 0.6, cd: 12, src: "data(TravelTime)" },
    kindred: { slot: 0, kind: "dash", range: 340, fixed: true, speed: 500, cd: 9, src: "data" },
    caitlyn: { slot: 2, kind: "dash", range: 390, fixed: true, back: true, speed: 1000, cd: 8, src: "추정" },
    ahri: { slot: 3, kind: "dash", range: 500, speed: 1200, charges: 3, gap: 1, window: 10, cd: 100, src: "data" },
    fizz: { slot: 2, kind: "dash", range: 400, dur: 0.25, untarget: 0.75, recast: { range: 400, dur: 0.25 }, cd: 8,
            src: "range·recast.range: data(FizzE·FizzETwo), dur·untarget: 추정" },
    riven: { slot: 2, kind: "dash", range: 250, fixed: true, speed: 1450, cd: 6, src: "data(missileSpeed)" },
    sejuani: { slot: 0, kind: "dash", range: 625, fixed: true, speed: 1000, cd: 12, src: "data" },
    malphite: { slot: 3, kind: "dash", range: 1000, speed: 1835, unstoppable: true, cd: 100, src: "range: data, speed: 추정" },
    sylas: { slot: 2, kind: "dash", range: 400, speed: 1450, cd: 9, src: "추정" },
    zeri: { slot: 2, kind: "dash", range: 300, fixed: true, speed: 900, cd: 18, src: "range: data, speed: 추정" },
    tryndamere: { slot: 2, kind: "dash", range: 650, speed: 1300, cd: 8, src: "range: data, speed: 추정" },
    renekton: { slot: 2, kind: "dash", range: 450, fixed: true, speed: 750, cd: 10, src: "data" },
    ornn: { slot: 2, kind: "dash", range: 650, fixed: true, speed: 1600, cd: 12, src: "data" },
    rakan: { slot: 1, kind: "dash", range: 650, speed: 1700, cd: 10, src: "data" },
    aatrox: { slot: 2, kind: "dash", range: 300, min: 75, speed: 800, cd: 5, src: "data" },
    kled: { slot: 2, kind: "dash", range: 550, fixed: true, speed: 600, cd: 9, src: "data" },
    kayn: { slot: 0, kind: "dash", range: 350, fixed: true, speed: 1000, cd: 5, src: "range: data, speed: 추정" },
    khazix: { slot: 2, kind: "dash", range: 700, speed: 1000, cd: 12, src: "range: data, speed: 추정" },
    naafiri: { slot: 2, kind: "dash", range: 450, min: 250, speed: 900, cd: 7, src: "data" },
    aurora: { slot: 1, kind: "dash", range: 300, fixed: true, speed: 350 + CHAMP.speed, stealth: 1.6, haste: 0.4, realm: true, cd: 18,
              src: "data(JumpDistance·DashBonusSpeed·InvisDuration·MoveSpeedBonus)" },
    belveth: { slot: 0, kind: "dash", range: 400, fixed: true, speed: 850, dirs: 4, cd: 1, src: "data" },
    gwen: { slot: 2, kind: "dash", range: 350, fixed: true, speed: 800, cd: 11, src: "data" },
    fiora: { slot: 0, kind: "dash", range: 400, speed: 1000, cd: 6, src: "추정" },
    pyke: { slot: 2, kind: "dash", range: 550, fixed: true, speed: 1000, cd: 11, src: "range: data, speed: 추정" },
    shen: { slot: 2, kind: "dash", range: 600, min: 300, speed: 800 + CHAMP.speed, cd: 10, src: "data" },
    urgot: { slot: 2, kind: "dash", range: 450, fixed: true, speed: 1200, cd: 14, src: "data" },
    galio: { slot: 2, kind: "dash", range: 650, min: 250, speed: 1400, cd: 7, src: "range: data, speed: 추정" },
    zoe: { slot: 3, kind: "blink", range: 575, ret: 1, cd: 5, src: "range: data, ret: 추정" },
    kassadin: { slot: 3, kind: "blink", range: 500, cd: 2, src: "data" },
    shaco: { slot: 0, kind: "blink", range: 400, windup: 0.125, stealth: 3.5, cd: 11, src: "data(PseudoCastTime·StealthDuration)" },
    leblanc: { slot: 1, kind: "dash", range: 600, speed: 1450, recall: 4, cd: 10, src: "range·recall: data(SnapbackTimeAllowed), speed: 추정" },
    ekko: { slot: 2, kind: "dash", range: 350, fixed: true, speed: 1150, cd: 7, src: "range: data, speed: 추정" },
    akali: { slot: 2, kind: "dash", range: 400, fixed: true, back: true, speed: 1000, cd: 10, src: "range: data, speed: 추정" },
    // 패시브 돌진: 칼리스타는 Q(꿰뚫기) 를 던진 뒤 커서 쪽으로 뛴다(전투 태세). 거리는 신발에 따라 달라서 데이터에 없다
    kalista: { slot: 0, kind: "dash", range: 250, dur: 0.3, windup: 0.25, dashAnim: "dash", passive: true, cd: 9,
               src: "cd·windup: data, range·dur: 추정" },
    // 암베사: 스킬을 쓰면 시전이 끝난 뒤 패시브(용견의 걸음) 로 커서 쪽 175~350 을 0.3초에 돌진한다(AmbessaPassive Buffer_Dash_*).
    // 스킬마다 자기 효과(amb, 아래 "암베사" 부분) 와 자기 돌진 동작(passivedash_spell*.anm) 이 있다. 값은 롤 클라이언트 데이터(AmbessaQ1·Q2·W·E·R)
    ambessa: [
      { slot: 0, kind: "dash", range: 350, min: 175, dur: 0.3, windup: 0.25, passive: true, amb: "q", anim: "spell1", dashAnim: "dash1", cd: 10,
        desc: "교활한 일격: 앞쪽 반원(375) 을 휩쓸고 커서 쪽으로 돌진. 적을 맞히면 4초 안에 한 번 더 눌러 앞으로 내려찍는다(파열의 강타)",
        src: "data(AmbessaQ1·Q2 mCastTime·castRange, AmbessaQ Swap_Duration·Swap_Static_Cooldown), 내려찍기 폭: 추정" },
      { slot: 1, kind: "dash", range: 350, min: 175, dur: 0.3, windup: 0.225, passive: true, amb: "w", anim: "spell2", dashAnim: "dash2", cd: 14,
        desc: "거부: 1.5초 동안 보호막(스킬 한 번을 막는다). 0.5초 동안 버티며 그사이 돌진해(0.225초 뒤) 내려앉으며 둘레 325 를 내리친다. 버티는 동안 막으면 더 세게",
        src: "data(Dash_Delay·Buff_Duration·Shield_Duration·castRange), 보호막이 스킬 한 번을 막는 것: 추정(롤은 피해량만큼)" },
      { slot: 2, kind: "dash", range: 350, min: 175, dur: 0.3, windup: 0.225, passive: true, amb: "e", anim: "spell3", dashAnim: "dash3", cd: 9,
        desc: "열상: 사슬을 휘둘러 둘레 325 를 베고(맞은 적 1초 둔화) 커서 쪽으로 돌진, 내려앉으며 한 번 더 벤다",
        src: "data(spellCastTime·castRange·Slow_Amount·Slow_Duration)" },
      { slot: 3, kind: "blink", range: 1250, windup: 0.7, unstoppable: true, steady: true, amb: "r", anim: "spell4", cd: 100,
        desc: "공개 처형: 0.7초 동안 커서 쪽 1250 줄을 겨눈 뒤(저지 불가) 줄 안에서 가장 먼 적 뒤로 순간이동해 0.75초 제압, 내려찍어 기절. "
          + "제압된 적은 시전이 끊긴다. 적이 없으면 짧게 돌진",
        src: "data(AmbessaR castRange·mCastTime·Suppress_Duration·Stun_Duration), 줄 폭·적이 없을 때 돌진: 추정" },
    ],
  };
  // 그 챔피언의 이동기 칸들(없으면 빈 배열)
  const skillsOf = key => { const v = MOBILITY[String(key).toLowerCase()]; return !v ? [] : Array.isArray(v) ? v : [v]; };
  // 고를 수 있는 내 챔피언은 이동기와 그 3D 동작이 다 들어간 이 42명. 키(소문자) → OP.GG·모델에 쓰는 이름(첫 글자만 대문자)
  const champAlias = k => k[0].toUpperCase() + k.slice(1);
  const champName = key => CHAMP_NAMES[String(key).toLowerCase()] || key;
  // 롤 쿨타임 그대로면 궁극기(100초) 는 한 판에 한 번, 벨베스 Q(1초) 는 쉬지 않고 쓴다. 소환사 주문(15·20초) 쪽으로 맞춘다
  const skillCd = sk => Math.min(20, Math.max(4, sk.cd));
  // 시작 창·칸 설명에 쓰는 한 줄
  function skillText(sk) {
    if (sk.desc) return sk.desc;
    const how = sk.kind === "blink" ? `커서 쪽으로 최대 ${sk.range} 순간이동`
      : sk.back ? `커서 반대쪽으로 ${sk.range} 뛰어 물러남`
      : `커서 쪽으로 ${sk.fixed ? "" : "최대 "}${sk.range} 돌진`;
    return (sk.passive ? "패시브: " : "") + how
      + (sk.ret ? `, ${sk.ret}초 뒤 제자리로` : "") + (sk.recall ? `. ${sk.recall}초 안에 다시 누르면 처음 자리로` : "")
      + (sk.untarget ? ", 그동안 스킬이 통과" : "") + (sk.recast ? ". 그사이 다시 누르면 한 번 더" : "")
      + (sk.stealth ? `. ${sk.stealth}초 동안 투명(적은 마지막으로 본 자리를 노린다)` : "")
      + (sk.haste ? `, 이동 속도 +${Math.round(sk.haste * 100)}%` : "")
      + (sk.charges ? `, ${sk.window}초 안에 ${sk.charges}번` : "")
      + (sk.dirs ? ". 네 방향마다 쿨타임이 따로" : "") + (sk.unstoppable ? ". 돌진 중에는 CC 를 받지 않음" : "");
  }

  // 조작 설정: 이동 방식(mouse | wasd), 모드(normal | hard), 모드마다 주문 두 칸(slots: [앞 키 칸, 뒤 키 칸]).
  // 롤처럼 칸을 눌러 주문을 바꾼다(spellPopup). 브라우저에 기억한다
  const CONTROL_KEY = "tiergg-dodge-controls";
  const DEFAULT_SLOTS = { normal: ["ghost", "flash"], hard: ["cleanse", "flash"] };
  function loadControls() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CONTROL_KEY) || "{}") || {}; } catch {}
    const ok = v => Array.isArray(v) && v.length === 2 && v[0] !== v[1] && v.every(spellById);
    const slots = {};
    for (const m of ["normal", "hard"]) slots[m] = ok(c.slots && c.slots[m]) ? c.slots[m].slice() : DEFAULT_SLOTS[m].slice();
    // champ: 시작 창에서 고른 내 챔피언(MOBILITY 의 키). 없으면 myChamp() 의 기본값
    return { move: c.move === "wasd" ? "wasd" : "mouse", mode: c.mode === "hard" ? "hard" : "normal", slots,
             champ: MOBILITY[c.champ] ? c.champ : null };
  }
  function saveControls(c) { try { localStorage.setItem(CONTROL_KEY, JSON.stringify(c)); } catch {} }
  // 이번 판의 주문 두 개(앞 키 칸, 뒤 키 칸 순서)
  function spellsOf(c) { return c.slots[c.mode]; }
  // 이동 방식에 따른 주문 두 키
  function keyPair(move) { return move === "wasd" ? ["V", "F"] : ["D", "F"]; }
  // 스킬 Q W E R 칸의 입력 코드와 화면에 보일 글자. WASD 는 W 가 이동이라 Q·W 를 우클릭·왼쪽 Shift 로 옮긴다.
  // "Mouse2" 는 우클릭을 뜻하는 이 게임만의 코드(키보드 e.code 에는 없다)
  function skillKeys(move) { return move === "wasd" ? ["Mouse2", "ShiftLeft", "KeyE", "KeyR"] : ["KeyQ", "KeyW", "KeyE", "KeyR"]; }
  function skillLabels(move) { return move === "wasd" ? ["Mb2", "Shift", "E", "R"] : ["Q", "W", "E", "R"]; }
  function spellKeys(c) {
    const [a, b] = keyPair(c.move), [s1, s2] = spellsOf(c);
    return { [s1]: a, [s2]: b };
  }
  const HP_MAX = 1500;            // 체력(한 번 맞을 때마다 HP_MAX / LIVES)
  // 연속으로 피한 수에 따라 롤 안내 문구와 아나운서 음성(롤의 연속 처치 순서 그대로)
  const SPREES = [[20, "학살 중입니다!", "spree1"], [40, "미쳐 날뛰고 있습니다!", "spree2"],
                  [60, "도저히 막을 수 없습니다!", "spree3"], [80, "전설의 출현!", "spree4"]];

  // 가끔 스킬(rare: 애쉬 R, 럭스 R) 이 나올 확률(둘을 합쳐서). 나머지는 열린 스킬 중에서 똑같은 확률로 고른다
  const RARE_CHANCE = 0.03;
  const LIVES = 3;
  const SAFE_AFTER_HIT = 1.0;
  // 3D 모델이 도는 모양: [남은 각도를 줄이는 빠르기(/초), 가장 느린 빠르기(라디안/초)].
  // 남은 각도에 비례해 돌아서 처음엔 빠르고 끝은 부드럽게 멈춘다. 판정용 facing 은 바로 바뀌고, 보이는 각도만 따라간다
  const TURN = [22, Math.PI * 3];
  // WASD 로 갈 때 이동 방향이 키 방향으로 휘어 도는 모양(마우스로 커서를 돌리며 갈 때처럼 360도로 이어진다)
  const STEER = [16, Math.PI * 4];
  // 멈추기 직전 이만큼(초) 안에 바뀐 방향은 버린다. 대각선으로 가다 두 키를 조금 다르게 떼도 대각선을 보고 선다
  const STOP_GRACE = 0.08;
  // a 에서 want 쪽으로 짧은 길로 dt 초 동안 돈 각도(how: TURN·STEER)
  function turnToward(a, want, dt, how) {
    const d = ((want - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const step = Math.max(Math.abs(d) * (1 - Math.exp(-how[0] * dt)), how[1] * dt);
    return Math.abs(d) <= step ? want : a + Math.sign(d) * step;
  }
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

  // ── 효과층(dodge-gl.js) 에 그리는 스킬 효과. 그림일 뿐 판정과는 상관없다 ──
  // Riot 의 VFX 원칙(판정이 먼저 읽혀야 한다, 주·보조 형태, 예고 → 터짐 →흩어짐) 을 따른다.
  // 투사체: glow 머리 둘레 빛 · core 머리 속 · trail [색, 폭(반지름 배), 길이(초)] 리본 꼬리 ·
  //   motes 날아가며 흘리는 파티클 [{every 몇 초마다, shape, color→color1, add 빛(1)/연기(0), size [최소, 최대],
  //   grow 끝 크기 배, life, drift 흩어지는 속도, back 뒤로 밀리는 비율, vz 위로, grav 중력, erode 침식으로 사라짐, stretch 늘어진 불티}]
  // 장판: zone { rune 마법진, motes 차오르는 동안 솟는 것, boom 터질 때 { pillar 빛기둥 색, h 높이, smoke 연기 색,
  //   debris 파편 색, sparks 불티 색, rays 햇살, souls 영혼 } }
  const GFX = {
    "모르가나 Q": { glow: "#7048e8", core: "#e5dbff", trail: ["#9775fa", 1, 0.3], hit: "#b197fc",
      motes: [{ every: 0.02, shape: "smoke", color: "#5f3dc4", color1: "#1a0b2e", add: 0, a: 0.5, size: [50, 80], grow: 1.5, life: 0.5, drift: 30, back: 0.1, erode: 1 },
              { every: 0.03, shape: "dot", color: "#d0bfff", size: [14, 26], life: 0.45, drift: 90 }] },
    "럭스 Q": { glow: "#fab005", core: "#fffbe6", trail: ["#ffe066", 1.1, 0.25], hit: "#ffe066", flare: 1,
      motes: [{ every: 0.02, shape: "star", color: "#fff3bf", color1: "#fab005", size: [26, 46], life: 0.5, drift: 60 },
              { every: 0.012, shape: "dot", color: "#ffe066", size: [12, 22], life: 0.35, drift: 120 }] },
    "자이라 E": { glow: "#2f9e44", core: "#d3f9d8", hit: "#69db7c",
      motes: [{ every: 0.03, shape: "leaf", color: "#69db7c", color1: "#2b8a3e", add: 0, size: [18, 30], life: 0.9, drift: 70, vz: 160, grav: 400, spin: 8 },
              { every: 0.05, shape: "dot", color: "#f783ac", size: [10, 18], life: 0.5, drift: 50, vz: 60 }] },
    "니달리 Q": { glow: "#8ce99a", core: "#f4fce3", trail: ["#d8f5a2", 0.45, 0.18], hit: "#8ce99a",
      motes: [{ every: 0.04, shape: "leaf", color: "#94d82d", color1: "#5c940d", add: 0, size: [14, 22], life: 0.6, drift: 40, vz: 80, grav: 200, spin: 10 }] },
    "브랜드 Q": { glow: "#ff6b00", core: "#fff3bf", trail: ["#ff922b", 1.1, 0.22], hit: "#ff922b",
      motes: [{ every: 0.008, shape: "flame", color: "#ffe066", color1: "#e03131", size: [40, 70], grow: 0.3, life: 0.35, drift: 50, back: 0.15, vz: 140, erode: 1 },
              { every: 0.04, shape: "smoke", color: "#3a2a20", color1: "#0d0806", add: 0, a: 0.45, size: [40, 70], grow: 1.6, life: 0.5, drift: 30, vz: 90, erode: 1 },
              { every: 0.02, shape: "spark", color: "#ffd43b", color1: "#ff6b00", size: [10, 16], life: 0.5, drift: 260, vz: 220, grav: 600, stretch: 0.05 }] },
    "아리 E": { glow: "#f06595", core: "#fff0f6", trail: ["#faa2c1", 1, 0.25], hit: "#faa2c1",
      motes: [{ every: 0.045, shape: "heart", color: "#ffdeeb", color1: "#f06595", size: [20, 34], life: 0.7, drift: 50, vz: 120 },
              { every: 0.02, shape: "dot", color: "#fcc2d7", size: [10, 18], life: 0.4, drift: 90 }] },
    "벨코즈 Q": { glow: "#9775fa", core: "#f3f0ff", trail: ["#d0bfff", 0.8, 0.2], hit: "#d0bfff", flare: 1,
      motes: [{ every: 0.015, shape: "dot", color: "#e5dbff", color1: "#7048e8", size: [14, 24], life: 0.4, drift: 110 },
              { every: 0.06, shape: "ring", color: "#b197fc", size: [40, 50], grow: 2, life: 0.35, drift: 0 }] },
    "제라스 E": { glow: "#4c6ef5", core: "#edf2ff", trail: ["#91a7ff", 0.9, 0.22], hit: "#91a7ff", flare: 1,
      motes: [{ every: 0.012, shape: "spark", color: "#dbe4ff", color1: "#4c6ef5", size: [10, 16], life: 0.25, drift: 300, stretch: 0.04 },
              { every: 0.04, shape: "swirl", color: "#748ffc", size: [50, 70], life: 0.35, drift: 0, spin: 12 }] },
    "이즈리얼 Q": { glow: "#fab005", core: "#ffffff", trail: ["#ffd43b", 0.6, 0.16], hit: "#ffd43b", flare: 1,
      motes: [{ every: 0.012, shape: "spark", color: "#fff3bf", color1: "#f59f00", size: [10, 16], life: 0.3, drift: 200, back: 0.2, stretch: 0.05 }] },
    "레오나 E": { glow: "#f59f00", core: "#fff9db", trail: ["#ffd43b", 1.3, 0.2], hit: "#ffd43b", flare: 1,
      motes: [{ every: 0.02, shape: "star", color: "#fff3bf", color1: "#f59f00", size: [24, 40], life: 0.4, drift: 70 }] },
    "베이가 Q": { glow: "#7048e8", core: "#f3f0ff", trail: ["#9775fa", 1.1, 0.25], hit: "#b197fc",
      motes: [{ every: 0.014, shape: "dot", color: "#d0bfff", color1: "#5f3dc4", size: [16, 28], life: 0.45, drift: 80 },
              { every: 0.04, shape: "star", color: "#e5dbff", size: [20, 30], life: 0.35, drift: 60 }] },
    "블리츠크랭크 Q": { glow: "#ff922b", core: "#fff4e6", hit: "#ffc078",
      motes: [{ every: 0.025, shape: "smoke", color: "#adb5bd", color1: "#495057", add: 0, size: [30, 50], grow: 1.8, life: 0.5, drift: 30, vz: 60, erode: 1 },
              { every: 0.03, shape: "spark", color: "#ffd8a8", size: [8, 12], life: 0.3, drift: 200, stretch: 0.04 }] },
    "쓰레쉬 Q": { glow: "#12b886", core: "#e6fcf5", trail: ["#63e6be", 0.7, 0.2], hit: "#63e6be",
      motes: [{ every: 0.02, shape: "smoke", color: "#38d9a9", color1: "#087f5b", size: [40, 70], grow: 1.5, life: 0.5, drift: 40, vz: 50, erode: 1 }] },
    "징크스 W": { glow: "#f06595", core: "#ffffff", trail: ["#fcc2d7", 0.5, 0.18], hit: "#f783ac", flare: 1,
      motes: [{ every: 0.006, shape: "spark", color: "#ffffff", color1: "#f06595", size: [8, 12], life: 0.2, drift: 300, stretch: 0.03 }] },
    "애쉬 R": { glow: "#4dabf7", core: "#e7f5ff", trail: ["#a5d8ff", 1.2, 0.35], hit: "#a5d8ff",
      motes: [{ every: 0.012, shape: "shard", color: "#e7f5ff", color1: "#4dabf7", size: [20, 36], life: 0.6, drift: 120, vz: 60, grav: 200, spin: 6 },
              { every: 0.02, shape: "smoke", color: "#d0ebff", color1: "#74c0fc", size: [60, 100], grow: 1.6, life: 0.7, drift: 30, erode: 1 }] },

    "카서스 Q": { zone: { rune: 1, motes: { shape: "smoke", color: "#b2f2bb", color1: "#2b8a3e", size: [30, 50], life: 0.6, vz: 160, erode: 1 },
      boom: { pillar: "#8ce99a", h: 380, sparks: "#d3f9d8", souls: "#b2f2bb" } } },
    "브랜드 W": { zone: { motes: { shape: "flame", color: "#ffd43b", color1: "#e03131", size: [30, 50], life: 0.45, vz: 220, erode: 1 },
      boom: { pillar: "#ff6b00", h: 620, smoke: "#2b1a10", sparks: "#ffa94d", flames: 1 } } },
    "초가스 Q": { zone: { motes: { shape: "smoke", color: "#8d6e4a", color1: "#3b2a1a", add: 0, size: [30, 50], life: 0.5, vz: 60, erode: 1 },
      boom: { smoke: "#5c4630", debris: "#a9e34b", sparks: "#d8f5a2" } } },
    "베이가 W": { zone: { rune: 1, motes: { shape: "dot", color: "#b197fc", size: [14, 24], life: 0.5, vz: 200 },
      boom: { pillar: "#7950f2", h: 500, smoke: "#1a0b2e", sparks: "#d0bfff" } } },
    "신드라 Q": { zone: { rune: 1, motes: { shape: "dot", color: "#eebefa", size: [14, 22], life: 0.4, vz: 120 },
      boom: { sparks: "#f3d9fa", debris: "#cc5de8" } } },
    "제라스 W": { zone: { rune: 1, motes: { shape: "spark", color: "#bac8ff", size: [10, 16], life: 0.35, vz: 400, stretch: 0.04 },
      boom: { pillar: "#748ffc", h: 900, sparks: "#dbe4ff" } } },
    "벨코즈 E": { zone: { rune: 1, motes: { shape: "dot", color: "#e599f7", size: [14, 22], life: 0.4, vz: 160 },
      boom: { pillar: "#cc5de8", h: 420, debris: "#e599f7", sparks: "#f3d9fa" } } },
    "레오나 R": { zone: { rune: 1, motes: { shape: "star", color: "#fff3bf", size: [20, 34], life: 0.5, vz: 90 },
      boom: { pillar: "#fab005", h: 1100, sparks: "#fff3bf", rays: 1 } } },
  };
  const gfxOf = s => GFX[s.name.replace(" (갈라짐)", "")] || {};

  // 캔버스에 그리는 초상화는 CommunityDragon 의 챔피언 아이콘(CORS 허용)을 crossOrigin 으로 받는다.
  // CORS 없는 그림(OP.GG) 을 캔버스에 그리면 캔버스가 "오염" 돼서 효과층(WebGL) 이 그 캔버스를 못 올린다.
  // 아이콘은 숫자 ID 로만 있어서 이름 → ID 표(champion-summary.json) 를 한 번 받는다. 받기 전에는 원으로 그린다
  const CD_ROOT = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/";
  const CDRAGON = CD_ROOT + "v1/";
  const CHAMP_IDS = {}, CHAMP_NAMES = {};      // 소문자 이름(alias) → 숫자 ID, 한국어 이름
  let idsAsked = null;
  // 받은 뒤(또는 못 받은 뒤) 풀리는 약속을 돌려준다. 못 받으면 다음에 다시 받는다
  function loadChampIds() {
    if (!idsAsked) {
      idsAsked = fetch(CD_ROOT.replace("/default/", "/ko_kr/") + "v1/champion-summary.json")
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(list => {
          list.forEach(c => { if (c.id > 0) { const k = String(c.alias).toLowerCase(); CHAMP_IDS[k] = c.id; CHAMP_NAMES[k] = c.name; } });
          preload();
        })
        .catch(() => { idsAsked = null; });
    }
    return idsAsked;
  }
  // HUD 스킬 칸(Q W E R) 아이콘과 한국어 이름. 챔피언 JSON(ko_kr) 의 abilityIconPath("/lol-game-data/assets/ASSETS/...")를
  // CD_ROOT + "assets/..."(소문자) 로 바꾼다. 챔피언마다 한 번만 받고, 못 받으면 null(칸에 글자만)
  const SKILL_ICONS = new Map();
  function skillIcons(key) {
    return loadChampIds().then(() => {
      const id = CHAMP_IDS[String(key).toLowerCase()];
      if (!id) return null;
      if (!SKILL_ICONS.has(id)) {
        SKILL_ICONS.set(id, fetch(CD_ROOT.replace("/default/", "/ko_kr/") + "v1/champions/" + id + ".json")
          .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(d => ["q", "w", "e", "r"].map(k => {
            const s = (d.spells || []).find(x => x.spellKey === k) || {};
            return { icon: s.abilityIconPath ? CD_ROOT + s.abilityIconPath.replace(/^\/lol-game-data\/assets\//i, "").toLowerCase() : "",
                     name: s.name || "" };
          }))
          .catch(() => { SKILL_ICONS.delete(id); return null; }));
      }
      return SKILL_ICONS.get(id);
    });
  }
  const IMG = {};
  const NO_IMG = new Image();      // 아직 ID 를 모를 때(그리는 쪽이 원으로 대신한다)
  function champImage(key) {
    const id = CHAMP_IDS[String(key).toLowerCase()];
    if (!id) return NO_IMG;
    if (!IMG[id]) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = CDRAGON + "champion-icons/" + id + ".png";
      IMG[id] = img;
    }
    return IMG[id];
  }
  // 3D 챔피언 모델(tools/champ_models.py 가 롤 게임 파일에서 만든 것). 목록에 있는 챔피언만 3D 로, 나머지는 초상화로 그린다
  const MODELS = "dodge/models/";
  let modelIndex = null, modelAsked = null;
  function loadModelIndex() {
    if (!modelAsked) {
      modelAsked = fetch(MODELS + "index.json").then(r => (r.ok ? r.json() : {})).then(d => { modelIndex = d || {}; }, () => { modelIndex = {}; });
    }
    return modelAsked;
  }
  const modelKey = champ => String(champ || "").toLowerCase();
  // HUD(DOM) 초상화는 캔버스가 아니라서 OP.GG 그림을 그대로 쓴다
  const hudFace = key => "https://opgg-static.akamaized.net/meta/images/lol/latest/champion/" + key + ".png";
  // 게임이 시작되기 전에 미리 받아 둔다. 못 받아도 원으로 그린다
  function preload() { loadChampIds(); SKILLS.forEach(s => champImage(s.champ)); }

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
    // 암베사(tools/fx_atlas.py 가 붙인다). 휘두르기 텍스처(q_slash·q_body·e_ring·w_shock) 는 롤처럼 부채꼴 띠에 입힌다(ambArc)
    amb_w_ring: [0, 1570, 256, 256],
    amb_r_decal: [258, 1570, 256, 256],
    amb_r_marker: [516, 1570, 256, 256],
    amb_q_sweet: [260, 1828, 256, 128],
    amb_w_shock: [518, 1828, 256, 128],
    amb_r_lines: [774, 1570, 128, 256],
    amb_q_tar: [0, 1828, 128, 256],
    amb_e_trail: [130, 1828, 128, 256],
    amb_q_slash: [776, 1828, 128, 128],
    amb_q_body: [0, 2086, 128, 128],
    amb_q_crescent: [130, 2086, 128, 128],
    amb_q_chain: [260, 2086, 128, 128],
    amb_q2_impact: [390, 2086, 128, 128],
    amb_q2_wave: [520, 2086, 128, 128],
    amb_q2_explo: [650, 2086, 128, 128],
    amb_q2_swipe: [780, 2086, 128, 128],
    amb_w_shield: [0, 2216, 128, 128],
    amb_w_flash: [130, 2216, 128, 128],
    amb_w_wind: [260, 2216, 128, 128],
    amb_e_ring: [390, 2216, 128, 128],
    amb_e_edge: [520, 2216, 128, 128],
    amb_r_impact: [650, 2216, 128, 128],
    amb_r_residual: [780, 2216, 128, 128],
    amb_dash: [0, 2346, 128, 128],
    amb_motes: [130, 2346, 128, 128],
    amb_q2_decal: [260, 2346, 64, 128],
  };
  const fxImg = new Image(), groundImg = new Image();
  let fxReady = false, groundReady = false;
  const onFx = new Set();     // 그림 한 장을 다 받으면 부를 것(효과층이 텍스처로 올린다)
  function loadArt() {
    if (fxImg.src) return;
    fxImg.onload = () => { fxReady = true; onFx.forEach(f => f()); };
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
      // 정화: 맑게 올라가는 종소리. CC 에 걸림: 둔탁하게 묶이는 소리
      else if (kind === "cleanse") { tone("sine", 660, 1320, 0.25, 0.09); tone("triangle", 990, 1980, 0.3, 0.06, 0.05); noise(0.3, 0.04, 6000, 2500); }
      // 암베사: 칼날이 바람을 가르는 소리, 땅을 내려찍는 소리, 금속 막, 사슬, 처형 전의 낮은 울림
      else if (kind === "ambSlash") { noise(0.2, 0.07, 3200, 600); tone("sawtooth", 520, 160, 0.14, 0.03); }
      else if (kind === "ambSlam") { noise(0.4, 0.1, 700, 70); tone("sine", 120, 38, 0.4, 0.16); }
      else if (kind === "ambShield") { tone("triangle", 880, 1320, 0.18, 0.06); tone("sine", 440, 660, 0.25, 0.05); noise(0.15, 0.03, 5000, 2500); }
      else if (kind === "ambWhip") { noise(0.3, 0.07, 1800, 4200); tone("square", 300, 900, 0.12, 0.02, 0.05); }
      else if (kind === "ambR") { tone("sawtooth", 80, 140, 0.7, 0.05); noise(0.7, 0.04, 300, 1200); }
      else if (kind === "cc") { tone("square", 220, 110, 0.14, 0.06); noise(0.18, 0.06, 1200, 300); }
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
              <div class="lol-slots">
              <div class="lol-skills">
                ${[0, 1, 2, 3].map(i => `
                  <button type="button" class="lol-skill off" data-skill="${i}" data-letter="${"QWER"[i]}">
                    <img alt=""><i></i><b></b><kbd></kbd>
                  </button>`).join("")}
              </div>
              <div class="lol-spells">
                ${[0, 1].map(i => `
                  <button type="button" class="lol-spell" data-slot="${i}">
                    <img alt=""><i></i><b></b><kbd></kbd>
                  </button>`).join("")}
              </div>
              </div>
              <div class="lol-hp"><i data-hud="hpfill"></i><span data-hud="hptext"></span></div>
            </div>
          </div>
        </div>
        <div class="dodge-over" data-over></div>
        <div class="lol-loading" data-loading>
          <div class="lol-loading-ring"><b>L</b><span>로딩 중</span><div class="lol-loading-bar"><i data-loading-fill></i></div></div>
        </div>
      </div>`;
    const canvas = root.querySelector(".lol-view > canvas");
    const mainCtx = canvas.getContext("2d");
    // 지금 그리는 2D 캔버스. 효과층이 있으면 바닥(bg) 과 선 것들(fg) 두 장에 나눠 그리고 효과층이 합친다
    let ctx = mainCtx;
    let fxgl = window.DodgeGL ? DodgeGL.create(canvas) : null;
    const fx2d = window.DodgeGL ? DodgeGL.canvas2d(fxImg) : null;
    const bgCv = document.createElement("canvas"), fgCv = document.createElement("canvas");
    const bgx = bgCv.getContext("2d"), fgx = fgCv.getContext("2d");
    const atlasUp = () => { if (fxgl) fxgl.setAtlas(fxImg); };
    if (fxReady) atlasUp();
    onFx.add(atlasUp);
    const view = root.querySelector(".lol-view");
    const mini = root.querySelector(".lol-minimap");
    const mctx = mini.getContext("2d");
    const banner = root.querySelector("[data-banner]");
    const soundBtn = root.querySelector("[data-sound]");
    const volInput = root.querySelector("[data-volume]");
    const volText = root.querySelector("[data-volume-text]");
    let opFace = opts.champ || "Ezreal";       // 앱이 넘긴 챔피언(티어표의 OP. setChamp 로 늦게 올 수 있다)
    let faceKey = "Ezreal";                      // 내 챔피언(그릴 때마다 champImage 로 찾는다. ID 표가 늦게 와도 바로 바뀐다)
    const over = root.querySelector("[data-over]");
    const hud = name => root.querySelector(`[data-hud="${name}"]`);
    const skillBtns = [...root.querySelectorAll("[data-skill]")];
    preload();
    loadArt();
    // 3D 모델을 판 시작 전에 미리 받아 둔다. 처음 나올 때 받기 시작하면 일찍 나오는 챔피언(모르가나·초가스 등) 은
    // 다 받기 전까지 초상화로 보인다
    // 연습장을 열면 규칙 화면보다 먼저 롤 로딩 화면을 띄우고, 모델을 다 받을 때까지 시작을 막는다.
    // 받은 모델은 dodge-gl.js 가 페이지에 남겨 둬서 티어표·그룹방에 갔다 와도 다시 받지 않는다(그때는 곧바로 끝난다)
    let loading = true;
    const loadingEl = root.querySelector("[data-loading]"), loadingFill = root.querySelector("[data-loading-fill]");
    root.classList.add("dodge-loading");
    const loaded = () => { loading = false; loadingEl.hidden = true; root.classList.remove("dodge-loading"); };
    // 아직 안 받은 모델이 있으면 로딩 화면을 띄우고 받는다(시작 창에서 내 챔피언을 바꿨을 때도)
    function ensureModels(champs) {
      return loadModelIndex().then(() => {
        if (!fxgl) return;          // WebGL 이 없으면 초상화로 그리니 받을 것이 없다
        const keys = [...new Set(champs.map(modelKey))].filter(k => modelIndex[k] && !fxgl.model(k));
        if (!keys.length) return;
        loading = true;
        loadingEl.hidden = false;
        root.classList.add("dodge-loading");
        let done = 0;
        const tick = () => { loadingFill.style.width = done / keys.length * 100 + "%"; };
        tick();
        return Promise.all(keys.map(k => fxgl.loadModel(k, MODELS, modelIndex[k].v).catch(() => null).then(() => { done++; tick(); })));
      }).then(loaded);
    }
    // 연습장에 들어온 것 자체가 클릭이라 소리를 미리 받아 풀어 둔다(첫 판 "환영합니다" 부터 나오게)
    if (soundOn()) loadSamples();

    let state = "ready";       // ready | play | over
    let t = 0, dodged = 0, acc = 0, last = 0, nextCast = 0, raf = 0;
    let player, target, casters, missiles, zones, flashes;
    let lives, hits, safe, lastHit, dead;
    let fx, parts, shake, hurt;          // 그림 효과(판정과 상관없음)
    let waves, ca, deadFx;               // 효과층: 충격파 왜곡, 색수차, 죽은 뒤 회색이 되는 정도
    let cds, ghostLeft, cursor, facing, prevFacing, facingAt, viewAngle, steer, level, pops, lastSpree, lastMark;
    let mode, spells;                    // 이번 판의 모드(normal | hard) 와 주문 두 개
    let effects, tenacity, ablaze, marked, tethers;   // 하드 모드 CC(applyCC)
    let cdLeft, cdMax, dirLeft, charges, dash, untarget, ret, recall, pole;   // 내 챔피언 이동기(useSkill)
    let hidden, seen, haste, realm, skillAt, skillUsed;
    let amb, act;      // 암베사 스킬 상태, 내 3D 동작을 정해 두는 것(act: {anim, t0, hold, until})
    let bannerTimer = 0, overTimer = 0;
    let controls = loadControls();
    // 내 챔피언: 시작 창에서 고른 챔피언. 고른 적이 없으면 앱이 넘긴 챔피언이 고를 수 있는 42명 안에 있을 때 그 챔피언, 아니면 이즈리얼
    const myChamp = () => controls.champ || (MOBILITY[modelKey(opFace)] ? modelKey(opFace) : "ezreal");
    faceKey = champAlias(myChamp());
    // 고를 수 있는 챔피언과 적 챔피언의 모델을 처음 열 때 한꺼번에 받는다(다음부터는 브라우저 저장소에서 읽는다).
    // 그래서 시작 창에서 챔피언을 바꿀 때는 로딩이 없다
    ensureModels([faceKey, ...SKILLS.map(s => s.champ), ...Object.keys(MOBILITY)]);
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
      fx = [];           // 퍼지는 고리·그을린 자리 등 2D 효과
      parts = [];        // 파티클(효과층에 그린다. emit)
      waves = [];        // 충격파 왜곡(바닥 좌표)
      ca = 0;            // 색수차(맞은 순간 1)
      deadFx = 0;
      shake = 0;         // 화면 흔들림 남은 시간
      hurt = 0;          // 맞았을 때 붉은 테두리 남은 시간
      lives = LIVES;
      hits = [];         // 맞은 스킬 이름(끝 화면에 보여 준다)
      safe = 0;          // 남은 무적 시간
      lastHit = null;
      dead = false;
      t = 0; dodged = 0; acc = 0;
      nextCast = 0.8;          // 시작하고 잠깐은 숨 돌릴 틈
      mode = controls.mode;
      spells = spellsOf(controls);
      cds = { flash: 0, ghost: 0, cleanse: 0 };   // 소환사 주문 남은 쿨타임
      effects = [];            // 걸린 CC {type: stun | root | charm | air | slow, start, end, skill, ...}
      tenacity = -1;           // 정화의 강인함이 끝나는 시각
      ablaze = -1;             // 브랜드 불길이 끝나는 시각(그 안에 브랜드 Q 를 맞으면 기절)
      marked = -1;             // 진 W 표식이 끝나는 시각(맞은 뒤 4초. 그 안에 진 W 를 맞으면 속박)
      tethers = [];            // 블리츠·쓰레쉬 사슬 {c, skill, until}
      ghostLeft = 0;           // 유체화 남은 시간
      cdLeft = [0, 0, 0, 0];   // 칸(Q W E R) 마다 이동기 남은 쿨타임과 그 쿨타임의 처음 길이(칸의 부채꼴)
      cdMax = [1, 1, 1, 1];
      dirLeft = [0, 0, 0, 0];  // 방향마다 따로인 쿨타임(벨베스 Q. 위·오른쪽·아래·왼쪽)
      charges = null;          // 여러 번 쓰는 이동기(아리 R) {slot, left, until}
      dash = null;             // 시전 중·돌진 중·순간이동 직전 {sk, fx, fy, tx, ty, t0(움직이기 시작), dur, blink, again}
      untarget = -1;           // 이 시각까지 스킬이 통과(피즈 E)
      ret = null;              // 돌아올 자리와 시각(조이 R) {x, y, at}
      recall = null;           // 다시 누르면 돌아갈 자리(르블랑 W) {slot, x, y, until}
      pole = null;             // 한 번 더 뛸 수 있는 동안(피즈 E) {until}
      hidden = -1;             // 이 시각까지 투명(적은 seen 을 노린다)
      seen = null;
      haste = null;            // 이동기의 이동 속도 증가 {pct, until}
      realm = null;            // 오로라 W 의 "다른 차원" {from, until}
      skillAt = -9;            // 이동기를 쓴 시각과 그 이동기(3D 동작)
      skillUsed = null;
      amb = { q2: null, shield: null, brace: null, arcs: [], aimR: null };
      act = null;
      cursor = null;          // 마우스가 가리키는 바닥(점멸 방향)
      facing = { x: 0, y: -1 };    // 마지막으로 움직인 방향(커서가 없을 때 점멸 방향)
      prevFacing = null;       // 바로 전 방향과 바뀐 시각(STOP_GRACE)
      facingAt = 0;
      viewAngle = -Math.PI / 2;    // 3D 모델이 지금 보는 각도(facing 을 TURN 으로 따라간다)
      steer = null;            // WASD 로 가는 중: { a: 지금 이동 각도, want: 키 방향, prev: 바로 전 키 방향, at: 바뀐 시각 }
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
      bgCv.width = fgCv.width = canvas.width;
      bgCv.height = fgCv.height = canvas.height;
      if (fxgl) fxgl.resize(VW, VH, DPR);
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
    function castFrom(skill, aim, me) {
      const tries = Array.from({ length: 24 }, edgePoint);
      if (skill.kind === "line" || skill.kind === "beam") {
        const reach = Math.min(skill.range, FAR);
        const good = tries.filter(p => { const d = dist(p, me); return d >= Math.min(600, reach * 0.6) && d <= reach; });
        if (good.length) return good[Math.floor(Math.random() * good.length)];
        return tries.reduce((a, b) => (dist(b, me) > dist(a, me) ? b : a));
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
      // 내가 투명하면(오로라 W·샤코 Q) 마지막으로 본 자리를 노린다. 움직임도 모르니 앞질러 노리지 못한다
      const me = hidden > t && seen ? { x: seen.x, y: seen.y, vx: 0, vy: 0 } : player;
      let aim = { x: me.x, y: me.y }, at0;
      if (ground) {
        // 바닥 스킬은 노릴 곳을 먼저 정하고, 거기가 사거리 안에 드는 자리에서 쏜다
        if (lead) {
          const ahead = skill.cast + skill.delay;
          aim = { x: me.x + me.vx * ahead, y: me.y + me.vy * ahead };
        }
        // 감옥은 실제 베이가처럼 대개 테두리를 내 몸에 걸치게 쓴다(안으로 들어가거나 밖으로 나가야 산다).
        // 가끔은 나를 한가운데 가둔다
        if (skill.kind === "cage" && Math.random() < 0.7) {
          const a = Math.random() * Math.PI * 2;
          aim = { x: aim.x + Math.cos(a) * skill.radius, y: aim.y + Math.sin(a) * skill.radius };
        }
        at0 = castFrom(skill, aim, me);
      } else {
        at0 = castFrom(skill, aim, me);
        if (lead) {
          const ahead = skill.cast + (skill.kind === "line" ? dist(at0, me) / skill.speed : 0);
          aim = { x: me.x + me.vx * ahead, y: me.y + me.vy * ahead };
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
      model(skill.champ);       // 3D 모델이 있으면 받기 시작(다 받기 전엔 초상화)
      skillSound(skill, "cast");
      if (c.wind <= 0) release(c);
    }

    // ── 하드 모드 CC ──
    // 스킬 레벨: 내 레벨 3마다 하나(1~3레벨은 1, 13레벨부터 5). 적도 나와 같이 자란다고 본다
    const rank = () => Math.min(5, 1 + Math.floor((level - 1) / 3));
    const byRank = v => (Array.isArray(v) ? v[rank() - 1] : v);
    // 지금 걸려 있는 그 종류의 CC(여럿이면 가장 늦게 끝나는 것)
    function cc(type) {
      let best = null;
      for (const e of effects) if (e.type === type && e.start <= t && e.end > t && (!best || e.end > best.end)) best = e;
      return best;
    }
    // 이동 불가 효과(기절·속박·매혹·공중에 뜸). 이 동안은 점멸을 못 쓴다
    const held = () => cc("air") || cc("stun") || cc("charm") || cc("root");
    // CC 를 건다. 공중에 뜸 말고는 정화의 강인함만큼 짧아진다. 롤 위키: 강인함으로는 0.5초 밑으로 안 줄어든다.
    // at 초 뒤부터 걸 수도 있다(초가스 Q 의 뒤따르는 둔화)
    function addCC(type, dur, s, extra = {}, at = 0) {
      if (type !== "air" && tenacity > t) dur = Math.max(Math.min(dur, 0.5), dur * (1 - spellById("cleanse").tenacity));
      const e = { type, start: t + at, end: t + at + dur, skill: s, ...extra };
      effects.push(e);
      if (type !== "slow" && at === 0) target = null;     // 롤처럼 이동 명령이 끊긴다
      return e;
    }
    // 사슬(블리츠·쓰레쉬): 시전자에서 나까지. on 이 풀리면(정화) 같이 끊긴다
    function tie(c, s, dur, on) {
      if (!c) return;
      c.fade = Math.max(c.fade, dur + 0.3);
      tethers.push({ c, skill: s, until: t + dur, on });
    }

    // 맞은 스킬의 CC. 값은 롤 클라이언트 데이터(16.19 DataValues), 없는 것은 롤 위키·나무위키.
    // how: { m 투사체, c 시전자, d 장판 가운데까지 거리 }
    function applyCC(s, how) {
      const from = how.c || (how.m && { x: how.m.ox, y: how.m.oy });
      const flown = how.m ? how.m.flown : 0;
      const center = how.d != null && s.inner && how.d < s.inner + CHAMP.radius;   // 중심부에 몸이 걸쳤다
      let got = true;
      switch (s.name.replace(" (갈라짐)", "")) {
        case "모르가나 Q": addCC("root", byRank([2, 2.25, 2.5, 2.75, 3]), s); break;
        case "럭스 Q": addCC("root", 2, s); break;
        case "자이라 E": addCC("root", byRank([1, 1.25, 1.5, 1.75, 2]), s); break;
        // 레오나 E: 속박 0.5초, 레오나가 내 뒤 225 로 돌진한다
        case "레오나 E": addCC("root", 0.5, s); if (how.c) leonaDash(how.c); break;
        // 진 W: 표식(최근 4초 안에 맞음) 이 있을 때만 속박
        case "진 W": if (marked > t) addCC("root", byRank([1.25, 1.5, 1.75, 2, 2.25]), s); else got = false; break;
        // 아리 E: 매혹. 65% 느려진 채 아리 쪽으로 걸어간다
        case "아리 E": addCC("charm", byRank([1.2, 1.35, 1.5, 1.65, 1.8]), s, { from, slow: 0.65 }); break;
        case "베이가 E": addCC("stun", byRank([1.5, 1.75, 2, 2.25, 2.5]), s); break;
        // 날아간 거리에 비례. 제라스 E 는 데이터 이름 그대로 0.5 + 100 유닛마다 0.17 을 0.75~2.25 로 자른다
        case "제라스 E": addCC("stun", Math.min(2.25, Math.max(0.75, 0.5 + 0.17 * flown / 100)), s); break;
        // 애쉬 R 1~3.5초. 최대가 되는 거리는 클라이언트 데이터·롤 위키에 없어서 1500 유닛으로 잡았다(추정)
        case "애쉬 R": addCC("stun", 1 + 2.5 * Math.min(1, flown / 1500), s); break;
        // 브랜드: 스킬에 맞으면 4초 동안 불길. 불길이 있을 때 Q 에 맞으면 기절 1.75초
        case "브랜드 Q": if (ablaze > t) addCC("stun", 1.75, s); else got = false; ablaze = t + 4; break;
        case "브랜드 W": ablaze = t + 4; got = false; break;
        case "블리츠크랭크 Q": {
          // 기절 0.65초, 블리츠 앞 75 까지 끌려간다(롤 위키: 내 중심이 블리츠 앞 75 에 온다.
          // 끌려가는 동안 공중에 뜸, 최대 1초). 끌려가는 속도는 데이터·위키에 없어서 손 속도(1800) 로 잡았다(추정)
          addCC("stun", 0.65, s);
          if (how.c) {
            const c = how.c, d = dist(player, c) || 1, gap = 75;
            const to = { x: c.x + (player.x - c.x) / d * gap, y: c.y + (player.y - c.y) / d * gap };
            addCC("air", 1, s, { pull: to, speed: 1800 });
            tie(c, s, 1, null);
          }
          break;
        }
        case "쓰레쉬 Q": {
          // 기절 1.5초 + 공중에 뜸 0.4초. 기절 중 0.1초·0.7초에 한 번씩 쓰레쉬 쪽으로 끌어당긴다
          const st = addCC("stun", 1.5, s, { tugs: how.c || from });
          addCC("air", 0.4, s);
          tie(how.c, s, st.end - t, st);
          break;
        }
        // 초가스 Q: 공중에 뜸 1초, 그 뒤 둔화 60% 1.5초
        case "초가스 Q": addCC("air", 1, s, { lift: 1 }); addCC("slow", 1.5, s, { pct: 0.6 }, 1); break;
        // 벨코즈 E: 공중에 뜸 + 기절 0.75초
        case "벨코즈 E": addCC("air", 0.75, s, { lift: 1 }); break;
        // 벨코즈 Q(갈라진 것도): 둔화 70% 가 지속 시간에 걸쳐 0 으로
        case "벨코즈 Q": addCC("slow", byRank([1, 1.4, 1.8, 2.2, 2.6]), s, { pct: 0.7, to: 0 }); break;
        case "징크스 W": addCC("slow", 2, s, { pct: byRank([0.4, 0.5, 0.6, 0.7, 0.8]) }); break;
        // 제라스 W: 둔화 25% 2.5초. 중심부는 60~80% 에서 25% 로 줄어든다
        case "제라스 W":
          if (center) addCC("slow", 2.5, s, { pct: byRank([0.6, 0.65, 0.7, 0.75, 0.8]), to: 0.25 });
          else addCC("slow", 2.5, s, { pct: 0.25 });
          break;
        // 레오나 R: 모두 둔화 80%, 중심부는 기절도(둘 다 1.75초. 롤 위키)
        case "레오나 R": addCC("slow", 1.75, s, { pct: 0.8 }); if (center) addCC("stun", 1.75, s); break;
        default: got = false;
      }
      marked = t + 4;          // 진의 표식은 맞을 때마다 4초(진 W 자신을 판정한 뒤에)
      if (got) { sfx("cc"); ccFx(s); }
    }

    // 레오나가 내 뒤 225 로 돌진한다(그림. 레오나 초상화가 옮겨 간다)
    function leonaDash(c) {
      const d = dist(player, c) || 1;
      const to = { x: player.x + (player.x - c.x) / d * 225, y: player.y + (player.y - c.y) / d * 225 };
      to.x = Math.min(ARENA.w, Math.max(0, to.x));
      to.y = Math.min(ARENA.h, Math.max(0, to.y));
      c.dash = { fx: c.x, fy: c.y, tx: to.x, ty: to.y, t0: t, dur: 0.2 };
      c.fade = Math.max(c.fade, 1.2);
    }

    // 소환사 주문
    function useSpell(id) {
      if (state !== "play" || !spells.includes(id)) return;
      const sp = spellById(id);
      if (cds[id] > 0) { sfx("deny"); return; }
      // 이동 불가 효과 중에는 점멸을 못 쓴다
      if (id === "flash" && held()) { sfx("deny"); return; }
      cds[id] = sp.cd;
      if (id === "flash") {
        // 커서 쪽으로 최대 400
        const { dx, dy, len } = aim(sp.range);
        const from = { x: player.x, y: player.y };
        Object.assign(player, inArena(player.x + dx * len, player.y + dy * len));
        target = null;
        flashFx(from, player);
        fx.push({ kind: "ring", x: player.x, y: player.y, r: CHAMP.radius + 20, color: "#ffe066", life: 0.35, max: 0.35 });
        sfx("flash");
      } else if (id === "ghost") {
        ghostLeft = sp.last;
        sfx("ghost");
      } else if (id === "cleanse") {
        // 공중에 뜸 말고 지금 걸린 CC 를 모두 푼다(쓰레쉬 사슬도 끊긴다). 그 뒤 3초 동안 강인함 75%
        effects = effects.filter(e => e.type === "air" || e.start > t);
        tenacity = t + sp.last;
        cleanseFx();
        sfx("cleanse");
      }
    }

    // 커서 쪽 방향과 거리(최대 range, 최소 min. fixed 면 늘 range). 커서를 모르면(휴대폰·WASD) 가던 방향으로 range
    function aim(range, min = 0, fixed = false) {
      let dx = facing.x, dy = facing.y, len = range;
      if (cursor) {
        const d = Math.hypot(cursor.x - player.x, cursor.y - player.y);
        if (d > 1) { dx = (cursor.x - player.x) / d; dy = (cursor.y - player.y) / d; if (!fixed) len = Math.max(min, Math.min(range, d)); }
      }
      return { dx, dy, len };
    }
    const inArena = (x, y) => ({ x: Math.min(ARENA.w - CHAMP.radius, Math.max(CHAMP.radius, x)),
                                 y: Math.min(ARENA.h - CHAMP.radius, Math.max(CHAMP.radius, y)) });
    // 내 챔피언의 이동기 칸들
    const mySkills = () => skillsOf(modelKey(faceKey));
    // 방향 번호: 위 0, 오른쪽 1, 아래 2, 왼쪽 3(벨베스 Q)
    const dirOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));

    // 이동기. 점멸처럼 이동 불가 효과 중에는 못 쓰고, 시전·돌진 중에도 못 쓴다
    function useSkill(i) {
      const sk = mySkills().find(x => x.slot === i);
      if (state !== "play" || !sk) return;
      if (held() || dash) { sfx("deny"); return; }
      if (sk.amb) { ambCast(sk, i); return; }
      // 르블랑 W: 정해진 시간 안에 다시 누르면 처음 자리로(쿨타임과 상관없이)
      if (recall && recall.slot === i) {
        const from = { x: player.x, y: player.y };
        player.x = recall.x; player.y = recall.y;
        recall = null;
        target = null;
        skillAt = t; skillUsed = sk;
        flashFx(from, player, LEBLANC_FX);
        sfx("flash");
        return;
      }
      // 피즈 E: 첫 번째로 뛰어 장대 위에 있는 동안(스킬이 통과) 한 번 더 뛴다. 내려오면 통과도 끝난다
      if (sk.recast && pole && t < pole.until) {
        pole = null;
        const { dx, dy, len } = aim(sk.recast.range);
        go(sk, dx, dy, len, { dur: sk.recast.dur, again: true });
        return;
      }
      const { dx, dy, len } = aim(sk.range, sk.min, sk.fixed || sk.back);
      const dir = dirOf(sk.back ? -dx : dx, sk.back ? -dy : dy);
      if (sk.dirs ? dirLeft[dir] > 0 : cdLeft[i] > 0) { sfx("deny"); return; }
      // 쿨타임: 여러 번 쓰는 것은 마지막 번(또는 window 가 끝날 때, step) 에 돌기 시작한다
      if (sk.dirs) {
        dirLeft[dir] = cdMax[i] = skillCd(sk);
      } else if (sk.charges) {
        if (!charges) charges = { slot: i, left: sk.charges, until: t + sk.window };
        charges.left -= 1;
        cdMax[i] = cdLeft[i] = charges.left > 0 ? sk.gap : skillCd(sk);
        if (charges.left <= 0) charges = null;
      } else {
        cdMax[i] = cdLeft[i] = skillCd(sk);
      }
      go(sk, dx, dy, len, { wind: sk.windup || 0 });
    }
    // 움직임을 예약한다. 시전 시간(wind) 동안은 제자리에서 스킬 동작, 그 뒤 돌진하거나 순간이동(step)
    function go(sk, dx, dy, len, o) {
      if (sk.back) { dx = -dx; dy = -dy; }
      const to = inArena(player.x + dx * len, player.y + dy * len);
      const d = Math.hypot(to.x - player.x, to.y - player.y);
      const blink = sk.kind === "blink";
      dash = { sk, fx: player.x, fy: player.y, tx: to.x, ty: to.y, t0: t + (o.wind || 0), blink, again: !!o.again,
               dur: blink ? 0 : Math.max(0.05, o.dur || sk.dur || d / sk.speed) };
      target = null;
      skillAt = t; skillUsed = sk;
      facing = sk.back ? { x: -dx, y: -dy } : { x: dx, y: dy };     // 뒤로 뛸 때는 커서 쪽을 본 채로
      if (dash.t0 <= t) moveStarts(dash);
    }
    // 움직이기 시작할 때: 통과·되돌아가기 표식
    function moveStarts(m) {
      m.started = true;
      const sk = m.sk;
      if (!m.blink) sfx("ghost");
      if (sk.untarget && !m.again) { untarget = t + sk.untarget; if (sk.recast) pole = { until: untarget }; }
      if (sk.recall) recall = { slot: sk.slot, x: m.fx, y: m.fy, until: t + sk.recall };
      if (sk.amb) ambStrike(m);
    }
    // 도착했을 때: 순간이동 효과, 조이 R 돌아오기, 투명·다른 차원
    function moveEnds(m) {
      const sk = m.sk;
      if (sk.amb) ambLand(m);
      else if (m.blink) { flashFx({ x: m.fx, y: m.fy }, player); sfx("flash"); }
      if (m.again) { untarget = t; pole = null; }
      if (sk.ret) ret = { x: m.fx, y: m.fy, at: t + sk.ret };
      if (sk.stealth) {
        hidden = t + sk.stealth;
        // 순간이동(샤코 Q) 은 사라진 자리를, 뛰어간 것(오로라 W) 은 내려앉은 자리를 마지막으로 본다
        seen = m.blink ? { x: m.fx, y: m.fy } : { x: player.x, y: player.y };
        if (sk.haste) haste = { pct: sk.haste, until: hidden };
        if (sk.realm) { realm = { from: t, until: hidden }; flashGround(player.x, player.y, 150, "#9775fa", 0.5); }
      }
    }

    // ── 암베사 ──
    // 롤 순서 그대로: 누르면 시전 동작(windup) → 스킬이 나가고(ambStrike) → 용견의 걸음으로 돌진 → 내려앉음(ambLand).
    // 적은 경기장 가장자리에서 시전 중인 챔피언(casters). 맞히면 하얗게 번쩍이고, R 은 제압해 시전을 끊는다
    const AMB = { gold: "#ffd8a8", orange: "#ff922b", ember: "#fd7e14", red: "#e8590c", blood: "#c92a2a", dark: "#5c2b12" };
    const ambQ2 = () => amb.q2 && t < amb.q2.until && t >= amb.q2.ready;
    function ambCast(sk, i) {
      const q2 = sk.amb === "q" && ambQ2();
      if (cdLeft[i] > 0 && !q2) { sfx("deny"); return; }
      if (q2) amb.q2 = null;
      cdMax[i] = cdLeft[i] = skillCd(sk);
      if (sk.amb === "r") {
        // R: 겨누는 0.7초 동안 제자리(저지 불가). 방향은 누른 순간 커서 쪽
        const { dx, dy } = aim(sk.range, 0, true);
        dash = { sk, fx: player.x, fy: player.y, tx: player.x, ty: player.y, t0: t + sk.windup, blink: true, dur: 0, dx, dy };
        target = null;
        skillAt = t; skillUsed = sk;
        facing = { x: dx, y: dy };
        act = { anim: sk.anim, t0: t, hold: t + sk.windup, until: t + sk.windup };
        amb.aimR = { dx, dy, from: t, until: t + sk.windup };
        sfx("ambR");
        return;
      }
      const { dx, dy, len } = aim(sk.range, sk.min);
      go(sk, dx, dy, len, { wind: sk.windup });
      dash.q2 = q2;
      dash.a = Math.atan2(dy, dx);      // 스킬은 커서 쪽으로 나가고, 돌진(용견의 걸음) 도 커서 쪽
      act = { anim: q2 ? "spell1b" : sk.anim, t0: t, hold: t + sk.windup, until: t + sk.windup };
      if (sk.amb === "w") {
        amb.shield = { until: t + 1.5 };
        amb.brace = { until: t + 0.5, parried: false };
        emit({ x: player.x, y: player.y, ground: 1, size: 70, size1: 150, color: "#ffffff", color1: AMB.gold, shape: "amb_w_shield", life: 0.35, a: 0.9 });
        sfx("ambShield");
      } else {
        sfx("ghost");
      }
    }
    // 적 고르기: 둘레 r 안, line 이면 그 선분에서 hw 안. dir 를 주면 그 방향 앞쪽만. 제압된 적은 빼고
    function ambTargets(x, y, r, o = {}) {
      return casters.filter(c => {
        if (c.supUntil > t) return false;
        const dx = c.x - x, dy = c.y - y;
        if (o.dir != null && dx * Math.cos(o.dir) + dy * Math.sin(o.dir) <= -CHAMP.radius) return false;     // 등 뒤는 안 맞는다
        if (o.line) return segDist(c, o.line[0], o.line[1]) < o.hw + CHAMP.radius;
        return Math.hypot(dx, dy) <= r + CHAMP.radius;
      });
    }
    function ambHit(c, color = AMB.orange) {
      c.ambHit = t;
      burst(c.x, c.y, 90, color, 16, 380);
      emit({ x: c.x, y: c.y, z: 90, size: 150, size1: 60, color: "#ffffff", color1: color, shape: "amb_q_tar", life: 0.3 });
    }
    // 휘두른 자국: 부채꼴 띠(바닥 위 z 높이) 에 휘두르기 텍스처를 입힌다. 텍스처 가로가 휘두르는 방향, 세로가 밖→안.
    // sweep 초 동안 a0 에서 a1 까지 펼쳐진다(drawAmb). uFix 면 텍스처의 세로 한 줄만 쓴다(둥근 빛을 띠 모양 그대로 고르게 깔 때)
    function ambArc(o) {
      const life = o.life || 0.4;
      amb.arcs.push({ z: 0, add: 1, a: 1, sweep: 0.12, col: "#ffffff", grow: 0, ...o, max: life, born: t });
    }
    // 스킬이 나가는 순간(시전 끝, 돌진 시작)
    function ambStrike(m) {
      const sk = m.sk, x = player.x, y = player.y, a = m.a;
      if (sk.amb !== "r") {
        act = { anim: m.q2 ? "dash1b" : sk.dashAnim, t0: t, hold: t + m.dur, until: t + m.dur + 0.45 };
        ambDashFx(m);
      }
      if (sk.amb === "q" && !m.q2) {
        // 교활한 일격: 앞쪽 반원(375). 끝자락이 더 아프다(sweetspot). 적을 맞히면 0.5초 뒤부터 4초 동안 파열의 강타
        const R = 375;
        ambArc({ x, y, r0: R * 0.35, r1: R * 1.05, a0: a - Math.PI / 2, a1: a + Math.PI / 2, f: "amb_q_slash", life: 0.45, sweep: 0.24, trail: 2.2, z: 40 });
        ambArc({ x, y, r0: R * 0.55, r1: R * 1.12, a0: a - Math.PI / 2, a1: a + Math.PI / 2, f: "amb_q_body", col: AMB.gold, life: 0.4, sweep: 0.22, trail: 1.6, z: 55, a: 0.8 });
        ambArc({ x, y, r0: R * 0.2, r1: R, a0: a - Math.PI / 2, a1: a + Math.PI / 2, f: "glow", uFix: 0.5, col: AMB.ember, life: 0.5, sweep: 0.2, a: 0.55 });
        for (let k = -2; k <= 2; k++) {
          const b = a + k * 0.55;
          emit({ x: x + Math.cos(b) * R * 0.92, y: y + Math.sin(b) * R * 0.92, ground: 1, size: 70, size1: 95, color: "#ffffff", color1: AMB.gold,
                 shape: "amb_q_sweet", rot: b + Math.PI / 2, life: 0.7, add: 0.4, a: 0.8, erode: 1 });
        }
        wave(x + Math.cos(a) * R * 0.5, y + Math.sin(a) * R * 0.5, 60, R, 0.35, 10);
        const got = ambTargets(x, y, R, { dir: a });
        got.forEach(c => ambHit(c));
        if (got.length) {
          amb.q2 = { ready: t + 0.5, until: t + 4 };
          cdMax[sk.slot] = cdLeft[sk.slot] = 0.5;
        }
        sfx("ambSlash");
      } else if (sk.amb === "q") {
        // 파열의 강타: 앞으로 375 를 내려찍는다(폭 200 추정)
        const L = 375, end = inArena(x + Math.cos(a) * L, y + Math.sin(a) * L);
        ambArc({ x, y, r0: 40, r1: L, a0: a - 0.16, a1: a + 0.16, f: "amb_q2_swipe", col: AMB.gold, life: 0.35, sweep: 0.06, z: 30 });
        for (let k = 0; k < 5; k++) {
          const u = (k + 0.5) / 5;
          emit({ x: x + Math.cos(a) * L * u, y: y + Math.sin(a) * L * u, ground: 1, size: 70, size1: 80, color: "#ffffff", color1: AMB.gold,
                 shape: "amb_q2_decal", rot: a + Math.PI / 2, life: 1.1, add: 0, a: 0.9, erode: 1 });
        }
        emit({ x: end.x, y: end.y, z: 40, size: 200, size1: 280, color: "#fff3bf", color1: AMB.red, shape: "amb_q2_impact", life: 0.4 });
        emit({ x: end.x, y: end.y, z: 30, size: 240, size1: 300, color: "#ffffff", color1: AMB.ember, shape: "amb_q2_explo", life: 0.45 });
        emit({ x: end.x, y: end.y, ground: 1, size: 110, size1: 230, color: AMB.gold, color1: AMB.red, shape: "amb_q2_wave", rot: a + Math.PI / 2, life: 0.4 });
        burst(end.x, end.y, 30, AMB.orange, 22, 420);
        wave(end.x, end.y, 40, 300, 0.45, 18);
        shake = Math.max(shake, 0.12);
        ambTargets(x, y, 0, { line: [{ x, y }, end], hw: 100, dir: a }).forEach(c => ambHit(c, AMB.red));
        sfx("ambSlam");
      } else if (sk.amb === "e") {
        ambWhip(x, y, a, 1);
      } else if (sk.amb === "w") {
        // 버티기(0.5초) 가 돌진에 이어진다. 바람이 몸으로 모인다
        for (let k = 0; k < 6; k++) {
          const b = Math.random() * Math.PI * 2;
          emit({ x: x + Math.cos(b) * 140, y: y + Math.sin(b) * 140, z: rand(30, 120), vx: -Math.cos(b) * 380, vy: -Math.sin(b) * 380,
                 size: 90, size1: 30, color: "#ffffff", color1: AMB.gold, shape: "amb_w_wind", life: 0.35, a: 0.6, drag: 2 });
        }
      } else if (sk.amb === "r") {
        // 겨눈 줄(1250, 폭 300 추정) 안에서 가장 먼 적 뒤로 순간이동해 제압. 없으면 커서 쪽으로 짧게 돌진(추정)
        const ex = x + m.dx * sk.range, ey = y + m.dy * sk.range;
        amb.aimR = null;
        const along = c => (c.x - x) * m.dx + (c.y - y) * m.dy;
        const far = ambTargets(x, y, 0, { line: [{ x, y }, { x: ex, y: ey }], hw: 150, dir: Math.atan2(m.dy, m.dx) }).reduce((b, c) => (!b || along(c) > along(b) ? c : b), null);
        if (far) {
          const to = inArena(far.x + m.dx * 110, far.y + m.dy * 110);
          m.tx = to.x; m.ty = to.y; m.victim = far;
          facing = { x: -m.dx, y: -m.dy };       // 뒤에 내려서 적을 본다
          viewAngle = Math.atan2(-m.dy, -m.dx);
        } else {
          const to = inArena(x + m.dx * 350, y + m.dy * 350);
          m.blink = false; m.dur = 0.3; m.tx = to.x; m.ty = to.y;
          act = { anim: "miss4", t0: t, hold: t + 0.3, until: t + 0.8 };
          ambDashFx(m);
        }
        // 지나간 자리에 핏빛 잔상
        emit({ x, y, z: 80, line: [x, y, m.tx, m.ty], size: 90, size1: 10, color: "#ffffff", color1: AMB.blood, shape: "spark", life: 0.35 });
        emit({ x, y, z: 80, size: 200, size1: 60, color: AMB.gold, color1: AMB.blood, shape: "star", life: 0.3, spin: 3 });
      }
    }
    // 내려앉는 순간
    function ambLand(m) {
      const sk = m.sk, x = player.x, y = player.y;
      if (sk.amb === "w") {
        // 거부: 둘레 325 를 내리친다. 버티는 동안 스킬을 막았으면(응수) 더 세게(HighDamageMultiplier 1.5)
        const big = amb.brace && amb.brace.parried ? 1.5 : 1, R = 325;
        amb.brace = null;
        emit({ x, y, ground: 1, size: R * 0.6, size1: R * 1.25, color: "#ffffff", color1: AMB.orange, shape: "amb_w_ring", life: 0.55, add: 0.6 });
        ambArc({ x, y, r0: R * 0.75, r1: R * 1.15, a0: 0, a1: Math.PI * 2, f: "amb_w_shock", col: AMB.gold, life: 0.5, sweep: 0.001, rep: 5, grow: 0.5 });
        emit({ x, y, ground: 1, size: R * 0.8, size1: R * 0.9, color: "#ffffff", color1: AMB.dark, shape: "amb_r_residual", life: 1.2, add: 0, a: 0.75, erode: 1 });
        emit({ x, y, z: 60, size: 220 * big, size1: 320 * big, color: "#fff3bf", color1: AMB.ember, shape: "amb_w_flash", life: 0.35 });
        emit({ x, y, pillar: 300 * big, size: 160, size1: 60, color: "#ffffff", color1: AMB.orange, shape: "beam", life: 0.35 });
        burst(x, y, 30, AMB.orange, Math.round(26 * big), 520);
        ambRocks(x, y, 10);
        wave(x, y, 60, R * 1.6 * big, 0.5, 16 * big);
        shake = Math.max(shake, 0.15 * big);
        ambTargets(x, y, R).forEach(c => ambHit(c));
        sfx("ambSlam");
      } else if (sk.amb === "e") {
        // 용견의 걸음을 E 로 시작하면 내려앉으며 한 번 더 벤다
        ambWhip(x, y, m.a + Math.PI, 0.85);
      } else if (sk.amb === "r" && m.victim) {
        // 공개 처형: 제압(0.75초) 한 적을 내려찍어 기절(0.4초). 시전 중이었으면 끊긴다
        const c = m.victim;
        c.supUntil = t + 0.75;
        c.stunUntil = t + 1.15;
        if (c.wind > 0) { c.wind = 0; c.cancelled = true; }
        c.fade = Math.max(c.fade, 1.6);
        act = { anim: "hit4", t0: t - 0.2, hold: t + 0.75, until: t + 1.3 };     // 첫 0.2초는 몸이 뒤에서 날아오는 자세라 건너뛴다
        amb.slam = { c, at: t + 0.75 };
        emit({ x: c.x, y: c.y, z: 150, size: 180, size1: 120, color: "#ffffff", color1: AMB.blood, shape: "amb_r_marker", life: 0.75 });
        flashGround(c.x, c.y, 120, AMB.blood, 0.4);
        sfx("ambSlash");
      }
    }
    function ambRocks(x, y, n) {
      for (let i = 0; i < n; i++) {
        const b = Math.random() * Math.PI * 2, v = rand(150, 420);
        emit({ x, y, z: 10, vx: Math.cos(b) * v, vy: Math.sin(b) * v, vz: rand(300, 700), grav: 1600, size: rand(16, 30),
               color: "#ffffff", color1: AMB.dark, shape: "shard", add: 0.3, life: rand(0.5, 0.85), spin: rand(-10, 10) });
      }
    }
    // 열상: 사슬을 한 바퀴 휘둘러 둘레 325 를 벤다(맞은 적은 1초 둔화)
    function ambWhip(x, y, a, k) {
      const R = 325;
      ambArc({ x, y, r0: R * 0.45, r1: R * 1.08, a0: a, a1: a + Math.PI * 2, f: "amb_e_ring", col: AMB.gold, life: 0.42, sweep: 0.3, trail: 3.2, z: 50, a: 0.9 * k });
      ambArc({ x, y, r0: R * 0.82, r1: R * 1.04, a0: a, a1: a + Math.PI * 2, f: "amb_q_chain", life: 0.4, sweep: 0.3, trail: 2.4, z: 60, add: 0, a: k });
      ambArc({ x, y, r0: R * 0.2, r1: R, a0: a, a1: a + Math.PI * 2, f: "glow", uFix: 0.5, col: AMB.ember, life: 0.5, sweep: 0.25, a: 0.5 * k });
      for (let i = 0; i < 6; i++) {
        const b = a + i * Math.PI / 3;
        emit({ x: x + Math.cos(b) * R * 0.8, y: y + Math.sin(b) * R * 0.8, z: 55, vx: -Math.sin(b) * 500, vy: Math.cos(b) * 500,
               size: 120, size1: 60, color: "#ffffff", color1: AMB.orange, shape: "amb_e_edge", rot: b, life: 0.3, drag: 2 });
      }
      burst(x, y, 50, AMB.orange, 12, 380);
      ambTargets(x, y, R).forEach(c => { ambHit(c); c.slowUntil = t + 1; });
      sfx("ambWhip");
    }
    // 용견의 걸음: 바닥에 금빛 화살표가 돌진 방향으로 흐르고, 지나간 자리에 불씨
    function ambDashFx(m) {
      const dx = m.tx - m.fx, dy = m.ty - m.fy, a = Math.atan2(dy, dx);
      for (let k = 0; k < 3; k++) {
        const u = (k + 1) / 4;
        emit({ x: m.fx + dx * u, y: m.fy + dy * u, ground: 1, size: 55, size1: 70, color: "#ffffff", color1: AMB.gold, shape: "amb_dash",
               rot: a + Math.PI / 2, life: 0.3 + k * 0.08, a: 0.85 });
      }
      for (let k = 0; k < 10; k++) {
        const u = Math.random();
        emit({ x: m.fx + dx * u + rand(-25, 25), y: m.fy + dy * u + rand(-25, 25), z: rand(20, 120), vz: rand(30, 120),
               size: rand(30, 50), size1: 6, color: AMB.gold, color1: AMB.red, shape: "amb_motes", life: rand(0.4, 0.7), drag: 1 });
      }
      emit({ x: m.fx, y: m.fy, ground: 1, size: 60, size1: 110, color: AMB.gold, color1: AMB.dark, shape: "ring", life: 0.3, erode: 1 });
    }
    // 매 틀: 파열의 강타 시간이 지나면 쿨타임. 보호막·버티기 끝, R 내려찍기, 보호막 빛
    function ambTick() {
      if (amb.q2 && t >= amb.q2.until) {
        amb.q2 = null;
        const q = mySkills().find(x => x.amb === "q");
        if (q) cdMax[q.slot] = cdLeft[q.slot] = skillCd(q);
      }
      if (amb.shield && t >= amb.shield.until) amb.shield = null;
      if (amb.brace && t >= amb.brace.until && !(dash && dash.sk.amb === "w")) amb.brace = null;
      if (amb.slam && t >= amb.slam.at) {
        const c = amb.slam.c;
        amb.slam = null;
        emit({ x: c.x, y: c.y, ground: 1, size: 170, size1: 210, color: "#ffffff", color1: AMB.dark, shape: "amb_r_decal", life: 1.6, add: 0, erode: 1 });
        emit({ x: c.x, y: c.y, z: 40, size: 200, size1: 300, color: "#ffffff", color1: AMB.blood, shape: "amb_r_impact", life: 0.4 });
        emit({ x: c.x, y: c.y, pillar: 420, size: 170, size1: 50, color: "#ffffff", color1: AMB.blood, shape: "beam", life: 0.4 });
        burst(c.x, c.y, 30, AMB.red, 30, 560);
        ambRocks(c.x, c.y, 14);
        wave(c.x, c.y, 50, 420, 0.55, 24);
        shake = Math.max(shake, 0.3);
        ambHit(c, AMB.blood);
        sfx("ambSlam");
      }
      // 보호막: 몸 둘레로 금빛이 피어오르고, 버티는 동안은 바람이 감긴다
      if (amb.shield && !(t - (amb.shield.fxAt || -1) < 0.06)) {
        amb.shield.fxAt = t;
        const b = Math.random() * Math.PI * 2;
        emit({ x: player.x + Math.cos(b) * 60, y: player.y + Math.sin(b) * 60, z: rand(20, 140), vz: 60, size: 26, size1: 6,
               color: "#ffffff", color1: AMB.gold, shape: "glow", life: 0.5 });
        if (amb.brace) emit({ x: player.x, y: player.y, z: 80, size: 170, size1: 120, color: "#ffffff", color1: AMB.gold, shape: "amb_w_wind", life: 0.25, a: 0.45 });
      }
      if (amb.arcs.length) amb.arcs = amb.arcs.filter(o => t - o.born < o.max);
    }
    // 보호막이 스킬 하나를 막는다(맞은 것을 없던 일로). 버티는 동안 막으면 응수(더 센 내려찍기)
    function ambBlock() {
      if (!amb.shield || t >= amb.shield.until) return false;
      amb.shield = null;
      if (amb.brace) amb.brace.parried = true;
      emit({ x: player.x, y: player.y, z: 90, size: 200, size1: 260, color: "#ffffff", color1: AMB.gold, shape: "amb_w_shield", life: 0.3 });
      burst(player.x, player.y, 90, AMB.gold, 20, 420);
      wave(player.x, player.y, 40, 220, 0.35, 10);
      pops.push({ x: player.x, y: player.y, text: "막음", color: AMB.gold, life: 1, max: 1 });
      sfx("ambShield");
      return true;
    }

    // 화면 가운데 안내 문구(롤의 알림처럼 잠깐 떴다 사라진다)
    function announce(text, kind = "gold", ms = 1800, voice = "") {
      banner.innerHTML = "<b>" + esc(text) + "</b>";
      banner.className = "lol-banner show " + kind;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.className = "lol-banner"; }, ms);
      if (kind !== "death" && !(voice && sample(voice, 0.7))) sfx("announce");
    }

    // 맞았다. 무적 중이면 없던 일로(false). 목숨을 다 잃으면 끝.
    // 하드 모드는 무적이 없고, 맞은 스킬의 CC 를 그대로 당한다(how: applyCC 참고)
    function hit(s, how = {}) {
      if (dead || untarget > t || (mode !== "hard" && safe > 0)) return false;
      if (ambBlock()) return true;         // 막았다: 투사체·장판은 맞은 것처럼 끝나지만 목숨은 그대로
      lives -= 1;
      hits.push(s.name);
      lastHit = s;
      safe = mode === "hard" ? 0 : SAFE_AFTER_HIT;
      shake = 0.25;
      hurt = 0.4;
      hitFx(s);
      // 롤처럼 머리 위로 피해 숫자(마법 피해는 보라)
      pops.push({ x: player.x, y: player.y, text: String(Math.round(HP_MAX / LIVES)), life: 1, max: 1 });
      sfx("hit");
      skillSound(s, "hit");
      if (lives === 1) announce("체력이 낮습니다", "warn");
      if (lives <= 0) dead = true;
      // 말파이트 R 처럼 저지 불가인 돌진 중에는 CC 를 받지 않는다(암베사 R 은 겨눌 때부터)
      else if (mode === "hard" && !(dash && (dash.started || dash.sk.steady) && dash.sk.unstoppable)) applyCC(s, how);
      return true;
    }

    // 벨코즈 Q 가 갈라진다: 그 자리에서 양옆 직각으로 하나씩
    function splitMissile(m) {
      const sp = m.skill.split;
      const piece = { ...m.skill, name: m.skill.name + " (갈라짐)", speed: sp.speed, radius: sp.radius, range: sp.range, split: null };
      for (const side of [1, -1]) {
        missiles.push({ skill: piece, x: m.x, y: m.y, ox: m.x, oy: m.y, dx: -m.dy * side, dy: m.dx * side, speed: sp.speed, left: sp.range, flown: 0, caster: m.caster });
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
      castFx(c);
      if (s.kind === "line") {
        missiles.push({ skill: s, x: c.x, y: c.y, ox: c.x, oy: c.y, dx: c.dx, dy: c.dy, speed: s.speed, left: s.range, flown: 0, caster: c });
      } else if (s.kind === "circle") {
        // 벨코즈 E 처럼 멀리 던질수록 늦는 건, 가장 짧은 지연으로 자리를 잡고(더 넉넉한 쪽) 지연은 그 자리로 다시 잰다
        const at = fairSpot(c.aim, s, s.delay, c);
        const delay = s.delayFar ? s.delay + (s.delayFar - s.delay) * Math.min(1, dist(c, at) / s.range) : s.delay;
        zones.push({ skill: s, x: at.x, y: at.y, wait: delay, total: delay });
      } else if (s.kind === "cage") {
        zones.push({ skill: s, x: c.aim.x, y: c.aim.y, wait: s.delay, total: s.delay, up: 0 });
      } else if (s.kind === "beam") {
        const a = { x: c.x, y: c.y }, b = { x: c.x + c.dx * s.range, y: c.y + c.dy * s.range };
        if (!(segDist(player, a, b) < CHAMP.radius + s.radius && hit(s, { c }))) dodged += 1;
        flashes.push({ skill: s, a, b, left: 0.35, max: 0.35 });
        beamFx(s, a, b);
      }
    }

    // ── 한 걸음(1/240초) ──
    function step(dt) {
      t += dt;
      safe = Math.max(0, safe - dt);

      // 소환사 주문 쿨타임, 유체화
      for (const sp of SPELLS) cds[sp.id] = Math.max(0, cds[sp.id] - dt);
      ghostLeft = Math.max(0, ghostLeft - dt);
      // 이동기 쿨타임. 여러 번 쓰는 것을 다 안 쓰고 window 가 지나면 그때부터 쿨타임
      for (let i = 0; i < 4; i++) { cdLeft[i] = Math.max(0, cdLeft[i] - dt); dirLeft[i] = Math.max(0, dirLeft[i] - dt); }
      if (charges && t >= charges.until) {
        const sk = mySkills().find(x => x.slot === charges.slot);
        cdMax[charges.slot] = cdLeft[charges.slot] = skillCd(sk);
        charges = null;
      }
      if (recall && t >= recall.until) recall = null;
      if (pole && t >= pole.until) pole = null;
      if (haste && t >= haste.until) haste = null;
      ambTick();
      // 르블랑 W·조이 R 이 돌아갈 자리는 바닥에 보라 표식이 숨 쉰다
      for (const m of [recall, ret]) {
        if (m && !(t - (m.fxAt || -1) < 0.3)) {
          m.fxAt = t;
          emit({ x: m.x, y: m.y, ground: 1, size: 60, size1: 95, color: "#f3d9fa", color1: m === recall ? "#9c36b5" : "#cc5de8", shape: "ring", life: 0.6, a: 0.85 });
        }
      }
      // 다른 차원(오로라 W): 몸 둘레로 영혼 빛이 피어오른다
      if (realm && t < realm.until && !(t - (realm.fxAt || -1) < 0.05)) {
        realm.fxAt = t;
        emit({ x: player.x + rand(-45, 45), y: player.y + rand(-45, 45), z: rand(10, 110), vz: 90, size: 22, size1: 4,
               color: "#ffffff", color1: "#9775fa", shape: "glow", life: 0.7 });
      }
      // 조이 R: 정해진 시간 뒤 제자리로(CC 중이어도)
      if (ret && t >= ret.at) {
        const from = { x: player.x, y: player.y };
        player.x = ret.x; player.y = ret.y;
        ret = null;
        dash = null;
        target = null;
        flashFx(from, player);
      }
      const base = CHAMP.speed * (ghostLeft > 0 ? 1 + spellById("ghost").bonus : 1) * (haste ? 1 + haste.pct : 1);
      // 둔화: 가장 센 것 하나만. 줄어드는 둔화(to) 는 시간에 따라 pct → to. 이동 속도는 110 아래로 안 내려간다
      let slow = 0;
      for (const e of effects) {
        if (e.type !== "slow" || e.start > t || e.end <= t) continue;
        slow = Math.max(slow, e.to == null ? e.pct : e.pct + (e.to - e.pct) * (t - e.start) / (e.end - e.start));
      }
      const spd = slow > 0 ? Math.max(110, base * (1 - slow)) : base;
      const air = cc("air"), stun = cc("stun"), root = cc("root"), charm = cc("charm");

      // 이동: CC 가 먼저. 없으면 WASD 가 눌려 있으면 그쪽으로, 아니면 찍은 곳으로
      let mx = 0, my = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) my -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) my += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
      let steering = false;       // 이번 틀에 WASD 로 갔는지
      const toward = (p, v) => {
        const dx = p.x - player.x, dy = p.y - player.y, d = Math.hypot(dx, dy);
        if (d <= v * dt) { player.vx = player.vy = 0; player.x = p.x; player.y = p.y; return true; }
        player.vx = dx / d * v; player.vy = dy / d * v;
        return false;
      };
      if (dash && t < dash.t0 && !dash.sk.steady && (stun || root || air || charm)) {
        // 시전 중에 CC 를 맞으면 끊긴다(쿨타임은 그대로 돈다)
        dash = null;
      }
      if (dash) {
        // 이동기: 시전 시간에는 제자리, 그 뒤 정해진 시간 동안 곧게 가거나 순간이동. 돌진 중에 걸린 CC 는 끝난 뒤에 느낀다
        player.vx = player.vy = 0;
        if (t >= dash.t0) {
          if (!dash.started) moveStarts(dash);
          const k = dash.dur ? Math.min(1, (t - dash.t0) / dash.dur) : 1;
          player.x = dash.fx + (dash.tx - dash.fx) * k;
          player.y = dash.fy + (dash.ty - dash.fy) * k;
          if (k >= 1) { const m = dash; dash = null; moveEnds(m); }
        }
      } else if (air && air.pull) {
        // 블리츠 Q: 블리츠 앞까지 끌려간다. 닿으면 공중에 뜸이 끝난다
        if (toward(air.pull, air.speed)) air.end = t;
      } else if (stun || root || air) {
        player.vx = player.vy = 0;
        // 쓰레쉬 Q: 기절한 뒤 0.1초·0.7초에 한 번씩 0.15초 동안 쓰레쉬 쪽으로 끌려간다.
        // 롤 위키도 "짧은 거리" 라고만 해서 한 번에 100 으로 잡았다(추정).
        // 쓰레쉬와 가까우면(200 안) 끌지 않는다
        const since = stun && stun.tugs ? t - stun.start : -1;
        if ((since >= 0.1 && since < 0.25) || (since >= 0.7 && since < 0.85)) {
          if (dist(player, stun.tugs) > 200) toward(stun.tugs, 100 / 0.15);
        }
      } else if (charm) {
        // 매혹: 시전자 쪽으로 느리게 걸어간다(매혹의 둔화는 110 밑으로도 내려간다)
        target = null;
        toward(charm.from, base * (1 - charm.slow));
      } else if (mx || my) {
        // 이동 방향은 키 방향으로 빠르게 휘어 돈다(서 있다가 누르면 바로 그쪽으로)
        target = null;
        steering = true;
        const want = Math.atan2(my, mx);
        if (!steer) steer = { a: want, want, prev: null, at: 0 };
        else if (want !== steer.want) { steer.prev = steer.want; steer.at = t; steer.want = want; }
        steer.a = turnToward(steer.a, want, dt, STEER);
        player.vx = Math.cos(steer.a) * spd;
        player.vy = Math.sin(steer.a) * spd;
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
      if (steering) {
        facing = { x: Math.cos(steer.a), y: Math.sin(steer.a) };
        prevFacing = null;
      } else if (steer) {
        // WASD 를 뗐다(또는 CC·이동기로 끊겼다): 휘어 돌던 중이어도 마지막 키 방향을 보고 선다
        const a = steer.prev != null && t - steer.at < STOP_GRACE ? steer.prev : steer.want;
        facing = { x: Math.cos(a), y: Math.sin(a) };
        steer = null;
      }
      if (steering) {
        // 위에서 정했다
      } else if (player.vx || player.vy) {
        const n = Math.hypot(player.vx, player.vy);
        const f = { x: player.vx / n, y: player.vy / n };
        if (f.x !== facing.x || f.y !== facing.y) { prevFacing = facing; facingAt = t; }
        facing = f;
      } else if (prevFacing) {
        if (t - facingAt < STOP_GRACE) facing = prevFacing;
        prevFacing = null;
      }
      viewAngle = turnToward(viewAngle, Math.atan2(facing.y, facing.x), dt, TURN);
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
        if (c.dash && c.supUntil > t) c.dash.t0 += dt;     // 제압(암베사 R) 중에는 돌진이 멈춘다
        if (c.dash) {
          // 레오나 E 돌진
          const k = Math.min(1, (t - c.dash.t0) / c.dash.dur);
          c.x = c.dash.fx + (c.dash.tx - c.dash.fx) * k;
          c.y = c.dash.fy + (c.dash.ty - c.dash.fy) * k;
          if (k >= 1) c.dash = null;
        }
      }
      casters = casters.filter(c => c.wind > 0 || c.fade > 0);
      // 끝난 CC·사슬은 버린다(정화로 풀린 기절에 걸린 사슬도)
      effects = effects.filter(e => e.end > t);
      tethers = tethers.filter(x => x.until > t && (!x.on || effects.includes(x.on)) && (x.skill.champ !== "Blitzcrank" || cc("air")));
      if (dead) return;

      // 투사체. 갈라지면 새로 생기는 게 있어서 지금 있는 것만 돈다
      for (const m of [...missiles]) {
        if (m.skill.accel) m.speed = Math.min(m.skill.maxSpeed, m.speed + m.skill.accel * dt);
        const d = m.speed * dt;
        m.x += m.dx * d; m.y += m.dy * d;
        m.left -= d; m.flown += d;
        const reach = CHAMP.radius + m.skill.radius;
        if ((m.x - player.x) ** 2 + (m.y - player.y) ** 2 < reach * reach && hit(m.skill, { m, c: m.caster })) {
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
            if (d < s.radius + CHAMP.radius && hit(s, { d })) { if (dead) return; }
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
          if (!z.struck && Math.abs(d - s.radius) < CHAMP.radius && hit(s, { d })) {
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

    // ── 파티클(효과층에 그린다) ──
    // 바닥 좌표(x, y) 와 높이 z 에서 움직이고 흐려지거나 침식된다. 그림일 뿐 판정과 상관없다
    //   size→size1 크기(유닛), color→color1, a 진하기, add 1 빛(더하기) · 0 연기(반투명), shape 모양,
    //   drag 공기 저항, grav 중력, spin 회전, stretch 속도 방향으로 늘이기(불티), ground 바닥에 눕힘,
    //   erode 노이즈로 갉아먹히며 사라짐, pillar 빛기둥(높이), line 두 점을 잇는 빛줄기
    const RGB = new Map();
    function rgb(hex) {
      let c = RGB.get(hex);
      if (!c) {
        const n = parseInt(hex.slice(1, 7), 16);
        c = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
        RGB.set(hex, c);
      }
      return c;
    }
    const rand = (a, b) => a + Math.random() * (b - a);
    function emit(p) {
      if (parts.length > 2600) parts.splice(0, parts.length - 2600);
      p.z = p.z || 0; p.vx = p.vx || 0; p.vy = p.vy || 0; p.vz = p.vz || 0;
      p.max = p.life;
      p.size1 = p.size1 == null ? p.size : p.size1;
      p.c0 = rgb(p.color || "#ffffff");
      p.c1 = rgb(p.color1 || p.color || "#ffffff");
      p.a = p.a == null ? 1 : p.a;
      p.add = p.add == null ? 1 : p.add;
      // 하트는 똑바로 선다
      p.rot = p.rot == null ? (p.shape === "heart" ? 0 : Math.random() * Math.PI * 2) : p.rot;
      p.nu = Math.random(); p.nv = Math.random();     // 침식 노이즈 자리(파티클마다 다르게)
      parts.push(p);
      return p;
    }
    // 표의 파티클 하나(GFX 의 motes) 를 (x, y, z) 에서. dir: 날아가는 방향과 속도(뒤로 밀리는 몫)
    function mote(d, x, y, z, dir) {
      const a = Math.random() * Math.PI * 2, v = (d.drift || 0) * Math.random();
      const back = d.back && dir ? -dir.v * d.back : 0;
      emit({ x: x + rand(-8, 8), y: y + rand(-8, 8), z,
             vx: Math.cos(a) * v + (dir ? dir.x * back : 0), vy: Math.sin(a) * v + (dir ? dir.y * back : 0),
             vz: (d.vz || 0) * (0.6 + Math.random() * 0.8),
             life: d.life * (0.7 + Math.random() * 0.6), size: rand(d.size[0], d.size[1]),
             size1: rand(d.size[0], d.size[1]) * (d.grow == null ? 0.3 : d.grow),
             color: d.color, color1: d.color1, add: d.add, a: d.a, shape: d.shape, grav: d.grav, drag: 1.5,
             spin: d.spin ? rand(-d.spin, d.spin) : 0, stretch: d.stretch, erode: d.erode });
    }

    // 파편 n 개를 (x, y, z) 에서 사방으로(불티처럼 늘어진다)
    function burst(x, y, z, color, n, speed) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
        emit({ x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 150 + Math.random() * 350, grav: 1400,
               life: 0.4 + Math.random() * 0.35, size: 9 + Math.random() * 8, size1: 2, color: "#ffffff", color1: color,
               shape: "spark", stretch: 0.045, drag: 1 });
      }
    }
    // 화면이 굴절되는 충격파(바닥 좌표). amp: 처음 세기(px)
    function wave(x, y, r0, r1, life, amp) { waves.push({ x, y, r0, r1, life, max: life, amp }); }
    // 바닥에 확 퍼지는 빛 + 고리
    function flashGround(x, y, r, color, life = 0.35) {
      emit({ x, y, ground: 1, size: r * 1.3, size1: r * 1.6, color: "#ffffff", color1: color, shape: "glow", life, a: 0.9 });
      emit({ x, y, ground: 1, size: r * 0.7, size1: r * 1.25, color, shape: "ring", life: life * 1.3, a: 0.9, erode: 1 });
    }

    // 장판이 터짐: 빛기둥 + 퍼지는 고리 + 파편 + 그을린 바닥(초가스 Q 는 가시가 솟는다). 스킬마다 GFX 의 boom
    function boom(x, y, r, color, s) {
      fx.push({ kind: "ring", x, y, r, color, life: 0.35, max: 0.35 });
      fx.push({ kind: "shock", x, y, r, color, life: 0.45, max: 0.45 });
      fx.push({ kind: "scorch", x, y, r, color, art: s && ZONE_ART[s.name], life: 0.9, max: 0.9 });
      if (s && s.name === "초가스 Q") fx.push({ kind: "spikes", x, y, r, color, life: 0.7, max: 0.7, seed: Math.random() * 6 });
      const b = ((s && gfxOf(s).zone) || {}).boom || { pillar: color, h: 420, sparks: color };
      flashGround(x, y, r, color);
      wave(x, y, r * 0.4, r * 2.2, 0.55, Math.min(26, 8 + r / 14));
      if (b.pillar) {
        emit({ x, y, pillar: b.h, size: r * 1.1, size1: r * 0.35, color: "#ffffff", color1: b.pillar, shape: "beam", life: 0.5, a: 1 });
        emit({ x, y, pillar: b.h * 0.8, size: r * 0.4, size1: r * 0.1, color: "#ffffff", shape: "beam", life: 0.3, a: 1 });
      }
      if (b.sparks) burst(x, y, 20, b.sparks, Math.round(r / 6), r * 1.8);
      if (b.smoke) {
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.8;
          emit({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, z: 20, vx: Math.cos(a) * 80, vy: Math.sin(a) * 80, vz: rand(40, 120),
                 size: rand(80, 120), size1: rand(140, 200), color: b.smoke, add: 0, a: 0.45, shape: "smoke", life: rand(0.5, 0.8), erode: 1, drag: 1.2 });
        }
      }
      if (b.debris) {
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2, v = rand(150, 420);
          emit({ x, y, z: 10, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rand(350, 750), grav: 1600, size: rand(18, 34),
                 color: "#ffffff", color1: b.debris, shape: "shard", add: 0.6, life: rand(0.6, 0.9), spin: rand(-10, 10) });
        }
      }
      if (b.souls) {
        for (let i = 0; i < 6; i++) {
          emit({ x: x + rand(-r, r) * 0.5, y: y + rand(-r, r) * 0.5, z: 10, vz: rand(220, 380), size: rand(50, 80), size1: 20,
                 color: "#ffffff", color1: b.souls, shape: "smoke", life: rand(0.6, 0.9), erode: 1, drag: 0.5 });
        }
      }
      if (b.flames) {
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.7;
          emit({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, z: 0, vz: rand(250, 600), size: rand(60, 110), size1: 20,
                 color: "#fff3bf", color1: "#e03131", shape: "flame", life: rand(0.4, 0.7), erode: 1, drag: 0.8 });
        }
      }
      if (b.rays) emit({ x, y, ground: 1, size: r * 1.6, size1: r * 2.4, color: "#fff9db", color1: "#fab005", shape: "rays", life: 0.6, a: 1, spin: 0.6 });
    }

    // 적이 시전을 끝낸 순간: 초상화 앞에서 번쩍
    function castFx(c) {
      const g = gfxOf(c.skill);
      emit({ x: c.x, y: c.y, z: PORTRAIT_Z, size: 90, size1: 150, color: "#ffffff", color1: g.glow || c.skill.color, shape: "star", life: 0.25 });
    }
    // 레이저가 친 순간: 쏜 자리 섬광, 선을 따라 불티, 끝까지 퍼지는 충격
    function beamFx(s, a, b) {
      const lux = s.name === "럭스 R";
      emit({ x: a.x, y: a.y, z: 60, size: lux ? 260 : 140, size1: 40, color: "#ffffff", color1: s.color, shape: "star", life: 0.35 });
      const L = Math.min(FAR, 2400);
      for (let i = 0; i < (lux ? 50 : 24); i++) {
        const k = Math.random() * L, side = rand(-1, 1) * s.radius;
        emit({ x: a.x + (b.x - a.x) * k / FAR - (b.y - a.y) / FAR * side, y: a.y + (b.y - a.y) * k / FAR + (b.x - a.x) / FAR * side, z: 60,
               vx: rand(-60, 60), vy: rand(-60, 60), vz: rand(60, 260), size: rand(10, 18), size1: 2, color: "#ffffff", color1: s.color,
               shape: "spark", stretch: 0.05, life: rand(0.3, 0.6), grav: 300 });
      }
    }
    // 내가 맞았을 때: 스킬 색 불티 + 섬광 + 바닥 고리 + 작은 충격파 + 색수차
    function hitFx(s) {
      const col = gfxOf(s).hit || s.color;
      burst(player.x, player.y, 90, col, 30, 460);
      emit({ x: player.x, y: player.y, z: 90, size: 130, size1: 190, color: "#ffffff", color1: col, shape: "glow", life: 0.22, a: 0.55 });
      emit({ x: player.x, y: player.y, z: 90, size: 160, size1: 80, color: "#ffffff", color1: col, shape: "star", life: 0.18, spin: 3, a: 0.7 });
      flashGround(player.x, player.y, 90, col, 0.25);
      wave(player.x, player.y, 40, 260, 0.4, 14);
      ca = 1;
    }
    // 점멸: 출발점과 도착점에 노란 섬광, 그 사이를 빛줄기가 잇는다. pal 로 색을 바꾼다(르블랑 W 돌아가기는 보라)
    const FLASH_FX = { main: "#ffd43b", deep: "#fab005", soft: "#fff3bf", spark: "#ffe066", line: "#fff9db" };
    const LEBLANC_FX = { main: "#da77f2", deep: "#9c36b5", soft: "#f3d9fa", spark: "#e599f7", line: "#f8f0fc" };
    function flashFx(from, to, pal = FLASH_FX) {
      for (const p of [from, to]) {
        emit({ x: p.x, y: p.y, z: 70, size: 170, size1: 60, color: "#ffffff", color1: pal.main, shape: "star", life: 0.3, spin: 4 });
        emit({ x: p.x, y: p.y, ground: 1, size: 80, size1: 150, color: pal.soft, color1: pal.deep, shape: "ring", life: 0.35, erode: 1 });
        burst(p.x, p.y, 60, pal.spark, 12, 240);
      }
      emit({ x: from.x, y: from.y, z: 70, line: [from.x, from.y, to.x, to.y], size: 60, size1: 10, color: pal.line, color1: pal.deep, shape: "spark", life: 0.25 });
    }
    // 정화: 발밑에서 맑은 빛이 퍼지고 반짝이가 솟는다
    function cleanseFx() {
      flashGround(player.x, player.y, 140, "#99e9f2", 0.45);
      emit({ x: player.x, y: player.y, z: 80, size: 260, size1: 120, color: "#ffffff", color1: "#66d9e8", shape: "glow", life: 0.35 });
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, d = rand(20, 90);
        emit({ x: player.x + Math.cos(a) * d, y: player.y + Math.sin(a) * d, z: rand(0, 60), vz: rand(200, 420), size: rand(18, 30), size1: 4,
               color: "#ffffff", color1: "#66d9e8", shape: "star", life: rand(0.5, 0.8), spin: 4, drag: 1 });
      }
      wave(player.x, player.y, 30, 220, 0.35, 9);
    }
    // CC 에 걸린 순간: 종류마다 다른 표시(롤은 기절에 별, 속박에 사슬·덩굴, 매혹에 하트, 공중에 뜸에 먼지)
    function ccFx(s) {
      const col = gfxOf(s).hit || s.color;
      if (cc("air")) {
        for (let i = 0; i < 16; i++) {
          const a = i / 16 * Math.PI * 2;
          emit({ x: player.x + Math.cos(a) * 50, y: player.y + Math.sin(a) * 50, z: 5, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, vz: 40,
                 size: rand(50, 80), size1: 130, color: "#a68a64", color1: "#4a3b2a", add: 0, a: 0.6, shape: "smoke", life: 0.6, erode: 1, drag: 3 });
        }
      }
      emit({ x: player.x, y: player.y, ground: 1, size: 90, size1: 170, color: "#ffffff", color1: col, shape: "rune", life: 0.5, spin: 2, erode: 1 });
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

    // ── 3D 챔피언 ──
    // 모델이 있으면(효과층 + 목록에 있는 챔피언 + 다 받음) 초상화 대신 3D 로 그린다. 없으면 받기 시작만 한다
    function model(champ) {
      const key = modelKey(champ);
      if (!fxgl || !modelIndex || !modelIndex[key]) return null;
      const md = fxgl.model(key);
      if (!md) fxgl.loadModel(key, MODELS, modelIndex[key].v);
      return md ? modelIndex[key] : null;
    }
    // 스킬 이름의 마지막 글자(Q W E R) → 롤 애니메이션 이름(spell1 … spell4)
    const spellAnim = s => "spell" + ("QWER".indexOf(s.name.replace(" (갈라짐)", "").slice(-1)) + 1);
    let animClock = 0;      // 실제 시간(애니메이션이 게임이 끝나도 흐르게)
    // 효과층에 넘길 3D 챔피언들
    function modelActors() {
      const out = [];
      if (!player) return out;
      if (model(faceKey)) {
        const moving = (player.vx || player.vy) && !(mode === "hard" && held());
        // 이동기를 쓰면 그 스킬 동작(spell1~4) 을 한 번. 돌진이 길면 돌진이 끝날 때까지.
        // 돌진 동작이 따로 있으면(칼리스타 패시브) 시전 뒤 돌진하는 동안은 그 동작
        const sk = skillUsed, since = t - skillAt;
        const acting = act && t < act.until && (t < act.hold || !moving);
        const casting = !acting && sk && (dash || since < 0.5);
        const leaping = casting && dash && dash.started && sk.dashAnim;
        out.push({ key: modelKey(faceKey), x: player.x, y: player.y, z: lift(), angle: viewAngle,
                   anim: acting ? act.anim : leaping ? sk.dashAnim : casting ? "spell" + (sk.slot + 1) : moving ? "run" : "idle",
                   time: acting ? t - act.t0 : leaping ? t - dash.t0 : casting ? since : animClock, loop: !casting && !acting,
                   // 투명하면 내 화면에서만 흐리게 보인다(롤에서 내 챔피언이 반투명해지는 것처럼)
                   alpha: hidden > t ? 0.35 : untarget > t ? 0.4 : safe > 0 && Math.floor(safe * 10) % 2 ? 0.45 : 1,
                   tint: hurt > 0 ? [1, 1, 1, hurt / 0.4 * 0.55] : realm && t < realm.until ? [0.6, 0.5, 1, 0.35]
                     : ghostLeft > 0 ? [0.4, 0.85, 0.95, 0.22] : null });
      }
      for (const c of casters) {
        if (!model(c.skill.champ)) continue;
        const since = c.skill.cast - c.wind;            // 시전을 시작한 뒤 흐른 시간(풀린 뒤에도 계속 는다)
        const casting = c.wind > 0 || c.fade > 0.25;
        const froze = c.stunUntil > t, struck = t - (c.ambHit || -9);
        out.push({ key: modelKey(c.skill.champ), x: c.x, y: c.y, z: c.supUntil > t ? 25 : 0, angle: Math.atan2(c.dy, c.dx),
                   anim: froze || c.cancelled ? "idle" : c.dash ? "run" : casting ? spellAnim(c.skill) : "idle",
                   time: froze || c.cancelled ? 0 : c.dash ? animClock : Math.max(0, since + (c.wind > 0 ? 0 : 0.5 - c.fade)),
                   loop: !!c.dash, alpha: c.wind > 0 ? 1 : Math.min(1, Math.max(0, c.fade / 0.5)),
                   tint: struck < 0.25 ? [1, 1, 1, (0.25 - struck) / 0.25 * 0.7] : froze ? [0.75, 0.1, 0.05, 0.35] : null });
      }
      return out;
    }

    // ── 효과층에 쿼드 쌓기 ──
    // FX(): 지금 쓰는 그리개. WebGL 이면 묶음에 쌓았다가 frame() 에서 한 번에, 아니면 2D 로 바로 그린다
    const FX = () => (fxgl ? fxgl : fx2d);
    const ATLAS_FR = new Map();
    // 모양(dodge-gl.js 의 SHAPES) 이나 롤 그림(FX_MAP) 의 텍스처 자리
    function frameOf(name) {
      const R = FX();
      if (!R) return null;
      if (R.frames[name]) return R.frames[name];
      if (!fxReady || !FX_MAP[name]) return null;
      let f = ATLAS_FR.get(name);
      if (!f) {
        const [x, y, w, h] = FX_MAP[name], iw = fxImg.naturalWidth, ih = fxImg.naturalHeight;
        f = { tex: 0, u0: x / iw, v0: y / ih, u1: (x + w) / iw, v1: (y + h) / ih };
        ATLAS_FR.set(name, f);
      }
      return f;
    }
    const sub = (f, u0, v0, u1, v1) => ({ tex: f.tex, u0: f.u0 + (f.u1 - f.u0) * u0, v0: f.v0 + (f.v1 - f.v0) * v0,
                                          u1: f.u0 + (f.u1 - f.u0) * u1, v1: f.v0 + (f.v1 - f.v0) * v1 });
    const mixC = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    // 화면에 세운 회전 사각형(가운데 cx, cy)
    function rq(L, f, cx, cy, w, h, rot, col, a, add = 1, erode = 0, nz = 0, nuv = null) {
      if (!f || a <= 0.004 || w < 0.5) return;
      const c = Math.cos(rot), s = Math.sin(rot), hw = w / 2, hh = h / 2;
      L.quad([cx - hw * c + hh * s, cy - hw * s - hh * c, cx + hw * c + hh * s, cy + hw * s - hh * c,
              cx + hw * c - hh * s, cy + hw * s + hh * c, cx - hw * c - hh * s, cy - hw * s + hh * c], f, col, a, add, erode, nz, nuv);
    }
    // a → b 로 늘인 사각형(텍스처 가로가 길이 방향. 불티·빛줄기)
    function seg(L, f, ax, ay, bx, by, w, col, a, add = 1) {
      if (!f || a <= 0.004) return;
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1, nx = -dy / d * w / 2, ny = dx / d * w / 2;
      L.quad([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], f, col, a, add);
    }
    // 위(top) → 아래(bot) 로 세운 사각형(텍스처 세로가 길이 방향. 빛기둥·리본 꼬리). 폭은 양 끝 따로
    function segV(L, f, top, bot, w0, w1, col, a, add = 1, erode = 0, nz = 0, nuv = null) {
      if (!f || a <= 0.004) return;
      const dx = bot.x - top.x, dy = bot.y - top.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
      L.quad([top.x - nx * w0 / 2, top.y - ny * w0 / 2, top.x + nx * w0 / 2, top.y + ny * w0 / 2,
              bot.x + nx * w1 / 2, bot.y + ny * w1 / 2, bot.x - nx * w1 / 2, bot.y - ny * w1 / 2], f, col, a, add, erode, nz, nuv);
    }
    // 바닥에 눕힌 그림(가운데 x, y, 반지름 r). 크면 원근의 휨이 보여서 2×2, 4×4 로 잘라 편다
    function floorQ(L, f, x, y, r, rot, col, a, add = 1, erode = 0, nz = 0, ns = 1, no = null) {
      if (!f || a <= 0.004 || r <= 0) return;
      const n = r > 260 ? 4 : r > 110 ? 2 : 1, c = Math.cos(rot) * r, s = Math.sin(rot) * r;
      const P = [];
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const u = -1 + 2 * i / n, v = -1 + 2 * j / n;
        P.push(proj(x + c * u - s * v, y + s * u + c * v));
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const p00 = P[j * (n + 1) + i], p10 = P[j * (n + 1) + i + 1], p11 = P[(j + 1) * (n + 1) + i + 1], p01 = P[(j + 1) * (n + 1) + i];
        const nuv = no ? [no[0] + ns * i / n, no[1] + ns * j / n, no[0] + ns * (i + 1) / n, no[1] + ns * (j + 1) / n] : null;
        L.quad([p00.x, p00.y, p10.x, p10.y, p11.x, p11.y, p01.x, p01.y], sub(f, i / n, j / n, (i + 1) / n, (j + 1) / n), col, a, add, erode, nz, nuv);
      }
    }
    // 경기장 안으로 자른 선분(레이저가 경기장 밖 허공에 그려지지 않게)
    function clipArena(a, b) {
      let t0 = 0, t1 = 1;
      const dx = b.x - a.x, dy = b.y - a.y;
      for (const [p, q] of [[-dx, a.x], [dx, ARENA.w - a.x], [-dy, a.y], [dy, ARENA.h - a.y]]) {
        if (p === 0) { if (q < 0) return null; continue; }
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
      }
      if (t0 >= t1) return null;
      return [{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }];
    }
    // 바닥에서 z 높이에 눕힌 띠 a → b(반쪽 폭 hw). 텍스처 세로가 길이 방향, 노이즈가 길이 방향으로 흐른다
    function band(L, f, a, b, hw, z, col, al, add = 1, erode = 0, nz = 0, flow = 0) {
      const cut = clipArena(a, b);
      if (!cut || !f || al <= 0.004) return;
      [a, b] = cut;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len * hw, ny = dx / len * hw;
      const n = Math.max(1, Math.ceil(len / 150));
      const P = (x, y) => (z ? upright(x, y, z) : proj(x, y));
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const x0 = a.x + dx * t0, y0 = a.y + dy * t0, x1 = a.x + dx * t1, y1 = a.y + dy * t1;
        const q0 = P(x0 - nx, y0 - ny), q1 = P(x0 + nx, y0 + ny), q2 = P(x1 + nx, y1 + ny), q3 = P(x1 - nx, y1 - ny);
        L.quad([q0.x, q0.y, q1.x, q1.y, q2.x, q2.y, q3.x, q3.y], sub(f, 0, 0.2 + 0.4 * t0, 1, 0.2 + 0.4 * t1), col, al, add, erode, nz,
               [0, len * t0 / 400 - flow, 0.5, len * t1 / 400 - flow]);
      }
    }

    // 파티클을 쌓는다. ground: 바닥에 눕는 것만, 아니면 공중의 것만
    function drawParts(L, ground) {
      for (const p of parts) {
        if (!!p.ground !== ground) continue;
        const f = frameOf(p.shape || "dot");
        if (!f) continue;
        const k = Math.min(1, 1 - p.life / p.max);
        const size = p.size + (p.size1 - p.size) * k;
        const er = p.erode ? Math.pow(k, 1.3) * 0.95 : 0;
        const a = p.a * Math.min(1, k / 0.06 + 0.15) * (p.erode ? 1 : 1 - k * k);
        const col = mixC(p.c0, p.c1, k);
        const nuv = er ? [p.nu, p.nv, p.nu + 0.4, p.nv + 0.4] : null;
        if (ground) {
          floorQ(L, f, p.x, p.y, size, p.rot, col, a, p.add, er, er ? 0.3 : 0, 0.4, nuv && [p.nu, p.nv]);
        } else if (p.pillar) {
          const b = proj(p.x, p.y, 0), tp = upright(p.x, p.y, p.pillar * (0.55 + 0.45 * Math.sqrt(k)));
          segV(L, f, tp, b, size * b.k * 0.6, size * b.k, col, a, p.add, 0, 0.5, [0, -k * 2, 1, 1 - k * 2]);
        } else if (p.line) {
          const A = upright(p.line[0], p.line[1], p.z), B = upright(p.line[2], p.line[3], p.z);
          seg(L, f, A.x, A.y, B.x, B.y, size * A.k, col, a, p.add);
        } else {
          const q = upright(p.x, p.y, p.z), w = size * q.k;
          if (p.stretch) {
            const q2 = upright(p.x - p.vx * p.stretch, p.y - p.vy * p.stretch, p.z - p.vz * p.stretch);
            const L2 = Math.hypot(q.x - q2.x, q.y - q2.y);
            if (L2 > w) { seg(L, f, q2.x, q2.y, q.x, q.y, w * 0.6, col, a, p.add); continue; }
          }
          rq(L, f, q.x, q.y, w, w, p.rot, col, a, p.add, er, er ? 0.25 : 0, nuv);
        }
      }
    }

    // 투사체: 리본 꼬리 + 둘레 빛 + 속 + 반짝임. 생김새(롤 그림) 는 drawMissile 이 2D 로 그린다
    function missileFx(L, m, now) {
      const s = m.skill, g = gfxOf(s), zh = s.look === "vines" ? 18 : MISSILE_Z;
      const p = upright(m.x, m.y, zh), r = s.radius * p.k;
      if (g.trail && m.hist && m.hist.length > 1) {
        const pts = m.hist.concat([{ x: m.x, y: m.y }]).map(q => upright(q.x, q.y, zh));
        const n = pts.length - 1, col = rgb(g.trail[0]), white = rgb("#ffffff"), beam = frameOf("beam");
        for (let i = 0; i < n; i++) {
          const ta = i / n, tb = (i + 1) / n, w = s.radius * g.trail[1] * 2 * p.k;
          const nuv = [0, ta * 2 - now * 3, 1, tb * 2 - now * 3];
          segV(L, sub(beam, 0, 0.2, 1, 0.65), pts[i], pts[i + 1], w * (0.2 + 0.8 * ta), w * (0.2 + 0.8 * tb), col, Math.pow(tb, 1.2) * 0.9, 1, 0, 0.5, nuv);
          segV(L, sub(beam, 0, 0.2, 1, 0.65), pts[i], pts[i + 1], w * 0.3 * ta, w * 0.3 * tb, white, Math.pow(tb, 2) * 0.8, 1);
        }
      }
      let k = 1;
      if (m.splitIn != null) k = 1 + 0.7 * (1 - Math.max(0, m.splitIn) / s.split.telegraph);
      const gc = rgb(g.glow || s.color), cc0 = rgb(g.core || "#ffffff");
      rq(L, frameOf("dot"), p.x, p.y, r * 3.4 * k, r * 3.4 * k, 0, gc, 0.2, 1);
      rq(L, frameOf("glow"), p.x, p.y, r * 1.7 * k, r * 1.7 * k, 0, cc0, 0.38, 1);
      if (g.flare || m.splitIn != null) rq(L, frameOf("star"), p.x, p.y, r * 3.4 * k, r * 3.4 * k, now * 1.7, cc0, 0.45, 1);
    }

    // 지금 걸린 CC 의 이름(롤처럼 머리 위 이름 자리에 뜬다) 과 남은 비율
    const CC_NAMES = [["air", "공중에 뜸"], ["stun", "기절"], ["charm", "매혹"], ["root", "속박"]];
    function ccLabel() {
      if (mode !== "hard") return null;
      for (const [type, text] of CC_NAMES) {
        const e = cc(type);
        if (e) return { text, frac: (e.end - t) / (e.end - e.start) };
      }
      return null;
    }
    // 공중에 뜬 높이(그림). 끌려가는 동안은 살짝, 띄우는 스킬은 포물선
    function lift() {
      const e = mode === "hard" && cc("air");
      if (!e) return 0;
      if (e.pull) return 50;
      return (e.lift ? 170 : 70) * Math.sin(Math.PI * Math.min(1, (t - e.start) / (e.end - e.start)));
    }

    // 바닥 층: 장판이 차오르는 빛, 레이저가 지나간 바닥, 투사체가 바닥에 비치는 빛, 발밑 표시, 바닥 파티클
    function buildGround(L) {
      const now = performance.now() / 1000;
      for (const z of zones) {
        const s = z.skill, col = rgb(s.color), zg = gfxOf(s).zone || {};
        if (s.kind === "circle" && z.wait > 0) {
          const p = 1 - z.wait / z.total;
          floorQ(L, frameOf("disc"), z.x, z.y, s.radius, 0, col, 0.08 + 0.22 * p, 1, (1 - p) * 0.55, 0.9, 1.6, [now * 0.06, now * 0.09]);
          if (zg.rune) floorQ(L, frameOf("rune"), z.x, z.y, s.radius * 1.05, now * 0.5, col, 0.2 + 0.5 * p, 1);
          floorQ(L, frameOf("ring"), z.x, z.y, s.radius * 1.25, 0, col, 0.25 + 0.6 * p * p, 1);
          if (s.inner) floorQ(L, frameOf("ring"), z.x, z.y, s.inner * 1.25, 0, mixC(col, [1, 1, 1], 0.5), 0.4 + 0.5 * p, 1);
        } else if (s.kind === "cage" && z.formed) {
          const a = z.done != null ? Math.max(0, z.done / 0.3) : 1;
          floorQ(L, frameOf("ring"), z.x, z.y, s.radius * 1.25, 0, col, 0.7 * a, 1);
          floorQ(L, frameOf("disc"), z.x, z.y, s.radius, now * 0.2, col, 0.1 * a, 1, 0.3, 0.9, 1.6, [now * 0.04, -now * 0.05]);
        }
      }
      for (const f of flashes) {
        const al = Math.max(0, f.left / f.max), col = rgb(f.skill.color);
        band(L, frameOf("beam"), f.a, f.b, f.skill.radius * (1.6 + (1 - al) * 0.6), 0, col, al * 0.8, 1, (1 - al) * 0.7, 0.7, now * 3);
      }
      for (const m of missiles) {
        const g = gfxOf(m.skill);
        floorQ(L, frameOf("glow"), m.x, m.y, m.skill.radius * 2.6, 0, rgb(g.glow || m.skill.color), 0.3, 1);
      }
      if (mode === "hard" && player) {
        const root = cc("root");
        if (root) floorQ(L, frameOf("rune"), player.x, player.y, 100, now * 1.2, rgb(gfxOf(root.skill).hit || root.skill.color), 0.55, 1);
        if (cc("slow")) floorQ(L, frameOf("swirl"), player.x, player.y, 85, -now * 3, rgb("#74c0fc"), 0.55, 1);
        if (tenacity > t) floorQ(L, frameOf("ring"), player.x, player.y, 110, 0, rgb("#99e9f2"), 0.35 + 0.15 * Math.sin(now * 8), 1);
      }
      drawAmb(L, true, now);
      drawParts(L, true);
    }

    // 암베사 그림. ground: 바닥 층(휘두른 자국 중 바닥에 붙은 것, R 겨누는 줄, 둔화된 적) / 공중 층(공중 휘두르기, 보호막)
    function drawAmb(L, ground, now) {
      if (!amb || !player) return;
      // 2D 로 물러났을 때는 띠 조각 사이 이음매가 갈라져 보여서 휘두른 자국은 빼고 파티클만 둔다
      for (const o of fxgl ? amb.arcs : []) {
        if ((o.z === 0) !== ground) continue;
        const f = frameOf(o.f);
        if (!f) continue;
        const age = t - o.born, k = age / o.max, g = 1 + o.grow * k, span = o.a1 - o.a0, dir = Math.sign(span) || 1;
        const r0 = o.r0 * g, r1 = o.r1 * g, al = o.a * (1 - k * k), col = rgb(o.col);
        const P = (a, r) => (o.z ? upright(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r, o.z) : proj(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r));
        // trail 이 있으면 휘두르는 머리(텍스처 오른쪽 끝) 가 a0 에서 a1 너머까지 sweep 초에 지나가고 꼬리가 trail 만큼 따른다.
        // 없으면 a0 에서 a1 까지 펼쳐지며 텍스처를 rep 번 되풀이한다(고리)
        let from, to, uOf;
        if (o.trail) {
          const head = o.a0 + (span + o.trail * 0.5 * dir) * Math.min(1, age / o.sweep);
          const lo = Math.min(o.a0, o.a1), hi = Math.max(o.a0, o.a1), cl = a => Math.min(hi, Math.max(lo, a));
          from = cl(head - o.trail * dir); to = cl(head);
          uOf = a => 1 - (head - a) * dir / o.trail;
        } else {
          from = o.a0; to = o.a0 + span * Math.min(1, age / o.sweep);
          uOf = a => (a - o.a0) / span * (o.rep || 1);
        }
        if (Math.abs(to - from) < 1e-3) continue;
        const per = o.rep ? Math.ceil(Math.abs(span) / o.rep / 0.15) : 0;
        const n = o.rep ? per * Math.round(Math.abs(to - from) / Math.abs(span) * o.rep) || per : Math.max(2, Math.ceil(Math.abs(to - from) / 0.15));
        for (let i = 0; i < n; i++) {
          const aA = from + (to - from) * i / n, aB = from + (to - from) * (i + 1) / n;
          // 되풀이 경계에서 칸 밖을 읽지 않게 한 조각은 한 칸 안에서만
          let uA = o.uFix != null ? o.uFix : uOf(aA), uB = o.uFix != null ? o.uFix : uOf(aB);
          const tile = Math.floor(Math.min(uA, uB) + 1e-6);
          uA -= tile; uB -= tile;
          uA = Math.min(1, uA); uB = Math.min(1, uB);
          const p0 = P(aA, r1), p1 = P(aB, r1), p2 = P(aB, r0), p3 = P(aA, r0);
          L.quad([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y], sub(f, Math.max(0, uA), 0, Math.max(0, uB), 1), col, al, o.add);
        }
      }
      if (ground) {
        // R: 겨누는 줄(1250, 폭 300). 양쪽 가장자리에 핏빛 금이 서고, 줄 안에서 가장 먼 적 머리 위에 표식
        const r = amb.aimR;
        if (r && t < r.until) {
          const p = (t - r.from) / (r.until - r.from), a = { x: player.x, y: player.y }, b = { x: player.x + r.dx * 1250, y: player.y + r.dy * 1250 };
          band(L, frameOf("beam"), a, b, 150, 0, rgb(AMB.blood), 0.18 + 0.2 * p, 1);
          band(L, frameOf("amb_r_lines"), a, b, 150, 0, rgb("#ff8787"), 0.5 + 0.5 * p, 1, 0, 0, now * 0.6);
          const along = c => (c.x - a.x) * r.dx + (c.y - a.y) * r.dy;
          const far = ambTargets(a.x, a.y, 0, { line: [a, b], hw: 150, dir: Math.atan2(r.dy, r.dx) }).reduce((m, c) => (!m || along(c) > along(m) ? c : m), null);
          if (far) floorQ(L, frameOf("ring"), far.x, far.y, 110, 0, rgb(AMB.blood), 0.5 + 0.4 * Math.sin(now * 14), 1);
        }
        for (const c of casters) {
          if (c.slowUntil > t) floorQ(L, frameOf("swirl"), c.x, c.y, 90, -now * 3, rgb(AMB.orange), 0.5 * (c.slowUntil - t), 1);
          if (c.supUntil > t) floorQ(L, frameOf("rune"), c.x, c.y, 120, now * 2, rgb(AMB.blood), 0.6, 1);
        }
      } else {
        // W 보호막: 몸을 감싼 금빛 막. 사라지기 직전에 깜빡인다
        const sh = amb.shield;
        if (sh && t < sh.until) {
          const q = upright(player.x, player.y, 95), left = sh.until - t, w = 230 * q.k * (1 + 0.04 * Math.sin(now * 9));
          const al = left < 0.3 ? 0.5 * (Math.floor(left * 20) % 2) : 0.55;
          rq(L, frameOf("amb_w_shield"), q.x, q.y, w, w * 1.1, 0, rgb(AMB.gold), al, 1);
          rq(L, frameOf("glow"), q.x, q.y, w * 0.9, w, 0, rgb(AMB.orange), al * 0.25, 1);
        }
        const r = amb.aimR;
        if (r && t < r.until) {
          const q = upright(player.x, player.y, 120), p = (t - r.from) / (r.until - r.from);
          rq(L, frameOf("amb_r_marker"), q.x, q.y, 260 * q.k * (0.6 + 0.4 * p), 260 * q.k * (0.6 + 0.4 * p), 0, rgb("#ffffff"), 0.4 + 0.4 * p, 1);
        }
      }
    }

    // 공중 층: 파티클, 투사체 빛, 레이저 빛줄기, 시전 중 모이는 빛, 사슬, CC 표시
    function buildAir(L) {
      const now = performance.now() / 1000;
      drawParts(L, false);
      drawAmb(L, false, now);
      for (const m of missiles) missileFx(L, m, now);
      for (const f of flashes) {
        const al = Math.max(0, f.left / f.max), col = rgb(f.skill.color), w = f.skill.radius;
        band(L, frameOf("beam"), f.a, f.b, w * 1.2, 60, col, al, 1, 0, 0.4, now * 4);
        band(L, frameOf("beam"), f.a, f.b, w * 0.35, 60, rgb("#ffffff"), al, 1);
      }
      for (const c of casters) {
        if (c.wind <= 0 || !c.skill.cast) continue;
        const p = 1 - c.wind / c.skill.cast, head = upright(c.x, c.y, PORTRAIT_Z), col = rgb(gfxOf(c.skill).glow || c.skill.color);
        rq(L, frameOf("glow"), head.x, head.y, 260 * head.k * (0.5 + 0.7 * p), 260 * head.k * (0.5 + 0.7 * p), 0, col, 0.55 * p, 1);
        rq(L, frameOf("rune"), head.x, head.y, 170 * head.k, 170 * head.k, now * 2, col, 0.5 * p, 1);
      }
      // 레오나 R: 하늘에서 햇빛 한 줄기가 내려와 점점 굵어진다
      for (const z of zones) {
        if (z.skill.name !== "레오나 R" || z.wait <= 0) continue;
        const p = 1 - z.wait / z.total, b = proj(z.x, z.y), tp = upright(z.x, z.y, 1400);
        segV(L, frameOf("beam"), tp, b, 30 * b.k * p, 90 * b.k * p, rgb("#ffe066"), 0.6 * p, 1, 0, 0.5, [0, -now, 1, 1 - now]);
      }
      // 사슬: 시전자에서 나까지 고리를 잇는다
      for (const x of tethers) {
        const from = upright(x.c.x, x.c.y, 80), to = upright(player.x, player.y, 80 + lift());
        const col = rgb(gfxOf(x.skill).hit || x.skill.color), d = Math.hypot(to.x - from.x, to.y - from.y);
        seg(L, frameOf("spark"), from.x, from.y, to.x, to.y, 40 * from.k, col, 0.6, 1);
        const n = Math.max(2, Math.floor(d / (22 * from.k))), ang = Math.atan2(to.y - from.y, to.x - from.x);
        for (let i = 0; i <= n; i++) {
          rq(L, frameOf("chain"), from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n,
             30 * from.k, 15 * from.k, ang + (i % 2) * 0.3, [0.85, 0.9, 0.9], 0.9, 0.3);
        }
      }
      if (mode === "hard" && player) {
        const L0 = lift(), head = upright(player.x, player.y, PORTRAIT_Z + 70 + L0);
        if (cc("stun") || cc("air")) {
          for (let i = 0; i < 3; i++) {
            const a = now * 5 + i * Math.PI * 2 / 3;
            rq(L, frameOf("star"), head.x + Math.cos(a) * 46 * head.k, head.y + Math.sin(a) * 13 * head.k, 40 * head.k, 40 * head.k, now * 3,
               rgb("#ffe066"), 0.95, 1);
          }
        }
        const root = cc("root");
        if (root) {
          const col = rgb(gfxOf(root.skill).hit || root.skill.color);
          for (const h of [35, 95]) {
            const q = upright(player.x, player.y, h + L0);
            rq(L, frameOf("ring"), q.x, q.y, 150 * q.k, 46 * q.k, 0, col, 0.6, 1);
          }
        }
        if (cc("charm")) {
          const q = upright(player.x, player.y, PORTRAIT_Z + L0);
          rq(L, frameOf("glow"), q.x, q.y, 220 * q.k, 220 * q.k, 0, rgb("#f06595"), 0.35, 1);
        }
      }
    }

    // 충격파를 화면 좌표로(원근 때문에 세로로 눌린 타원)
    function screenWaves() {
      return waves.slice(-8).map(w => {
        const k = 1 - w.life / w.max, r = w.r0 + (w.r1 - w.r0) * (1 - (1 - k) * (1 - k));
        const c = proj(w.x, w.y), ex = proj(w.x + r, w.y), y1 = proj(w.x, w.y + r), y0 = proj(w.x, w.y - r);
        const rx = Math.max(1, Math.abs(ex.x - c.x)), ry = Math.abs(y1.y - y0.y) / 2;
        return { x: c.x, y: c.y, r: rx, amp: w.amp * (1 - k), th: Math.max(10, rx * 0.22), sq: Math.max(0.2, ry / rx) };
      });
    }

    // 그림 효과만 흘러간다(실제 시간). 게임이 끝나도 파편은 마저 떨어진다
    function tickFx(dt) {
      for (const f of fx) f.life -= dt;
      fx = fx.filter(f => f.life > 0);
      for (const p of parts) {
        if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k; }
        if (p.grav) p.vz -= p.grav * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.grav && p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; }
        if (p.spin) p.rot += p.spin * dt;
        p.life -= dt;
      }
      parts = parts.filter(p => p.life > 0);
      for (const w of waves) w.life -= dt;
      waves = waves.filter(w => w.life > 0);
      for (const p of pops) p.life -= dt;
      pops = pops.filter(p => p.life > 0);
      ca = Math.max(0, ca - dt * 2.5);
      deadFx = state === "over" ? Math.min(1, deadFx + dt / 0.6) : 0;
      shake = Math.max(0, shake - dt);
      hurt = Math.max(0, hurt - dt);
      animClock += dt;
      if (state !== "play" || !player) return;

      // 투사체: 지나온 길(리본 꼬리) 을 적어 두고, 표의 파티클을 흘린다
      const now = performance.now() / 1000;
      for (const m of missiles) {
        const g = gfxOf(m.skill);
        (m.hist = m.hist || []).push({ x: m.x, y: m.y, at: now });
        const keep = g.trail ? g.trail[2] : 0.2;
        while (m.hist.length > 2 && now - m.hist[0].at > keep) m.hist.shift();
        const zh = m.skill.look === "vines" ? 18 : MISSILE_Z;
        (g.motes || []).forEach((d, i) => {
          m.acc = m.acc || [];
          m.acc[i] = (m.acc[i] || 0) + dt;
          while (m.acc[i] >= d.every) { m.acc[i] -= d.every; mote(d, m.x, m.y, zh, { x: m.dx, y: m.dy, v: m.speed }); }
        });
      }
      // 장판: 차오르는 동안 안에서 솟는 것이 점점 많아진다. 감옥은 테두리를 따라 보랏빛이 솟는다
      for (const z of zones) {
        const s = z.skill, zd = (gfxOf(s).zone || {}).motes;
        if (s.kind === "circle" && z.wait > 0 && zd) {
          const p = 1 - z.wait / z.total;
          z.acc = (z.acc || 0) + dt * (20 + 90 * p) * s.radius / 220;
          while (z.acc >= 1) {
            z.acc -= 1;
            const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * s.radius * 0.9;
            mote({ ...zd, drift: 20 }, z.x + Math.cos(a) * d, z.y + Math.sin(a) * d, 0);
          }
        } else if (s.kind === "cage" && z.formed && z.done == null) {
          z.acc = (z.acc || 0) + dt * 70;
          while (z.acc >= 1) {
            z.acc -= 1;
            const a = Math.random() * Math.PI * 2;
            emit({ x: z.x + Math.cos(a) * s.radius, y: z.y + Math.sin(a) * s.radius, z: rand(0, 40), vz: rand(120, 260),
                   size: rand(14, 26), size1: 4, color: "#e5dbff", color1: "#7048e8", shape: "dot", life: rand(0.5, 0.9) });
          }
        }
      }
      // 시전 중: 스킬 색 빛이 초상화로 빨려 들어간다. 레오나 E 돌진은 금빛 자취
      for (const c of casters) {
        if (c.wind > 0 && c.skill.cast > 0) {
          c.acc = (c.acc || 0) + dt * 40;
          while (c.acc >= 1) {
            c.acc -= 1;
            const a = Math.random() * Math.PI * 2, r = rand(90, 140);
            emit({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.5, z: PORTRAIT_Z + rand(-40, 40),
                   vx: -Math.cos(a) * r * 3.2, vy: -Math.sin(a) * r * 1.6, size: rand(10, 18), size1: 4,
                   color: "#ffffff", color1: gfxOf(c.skill).glow || c.skill.color, shape: "dot", life: 0.3 });
          }
        }
        if (c.dash) emit({ x: c.x, y: c.y, z: PORTRAIT_Z, size: 70, size1: 20, color: "#fff3bf", color1: "#f59f00", shape: "glow", life: 0.25 });
      }
      // 내 상태: 유체화(푸른 자취), 둔화(발밑 자국), 불길(불꽃), 매혹(하트)
      const moving = player.vx || player.vy;
      const every = (key, sec, fn) => { player[key] = (player[key] || 0) + dt; while (player[key] >= sec) { player[key] -= sec; fn(); } };
      if (ghostLeft > 0 && moving) {
        every("ghostAcc", 0.03, () => emit({ x: player.x + rand(-30, 30), y: player.y + rand(-30, 30), z: rand(10, 120), vz: 60,
          size: rand(40, 60), size1: 10, color: "#c5f6fa", color1: "#1098ad", shape: "smoke", life: 0.5, erode: 1 }));
      }
      if (mode === "hard") {
        if (cc("slow") && moving) {
          every("slowAcc", 0.14, () => emit({ x: player.x - player.vx * 0.12, y: player.y - player.vy * 0.12, ground: 1,
            size: 40, size1: 55, color: "#a5d8ff", color1: "#1c7ed6", shape: "swirl", life: 0.9, a: 0.8, erode: 1 }));
        }
        if (ablaze > t) {
          every("fireAcc", 0.04, () => emit({ x: player.x + rand(-35, 35), y: player.y + rand(-35, 35), z: rand(20, 140), vz: rand(120, 220),
            size: rand(30, 50), size1: 8, color: "#ffe066", color1: "#e03131", shape: "flame", life: rand(0.3, 0.5), erode: 1 }));
        }
        if (cc("charm")) {
          every("charmAcc", 0.16, () => emit({ x: player.x + rand(-30, 30), y: player.y + rand(-30, 30), z: PORTRAIT_Z + 40, vz: 140,
            size: rand(24, 34), size1: 10, color: "#ffdeeb", color1: "#f06595", shape: "heart", life: 0.7, rot: 0 }));
        }
      }
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

    // 머리 위 체력바. ally 면 초록(나), 아니면 빨강(적). frac: 남은 체력 비율, segs: 칸 수.
    // cc: 걸린 CC { text, frac }. 롤처럼 이름 자리에 CC 이름이 뜨고, 체력바 아래 선이 남은 시간만큼 줄어든다
    function healthBar(x, y, frac, ally, lv, name, segs = 3, cc = null) {
      const u = U(), w = 96 * u, h = 11 * u, box = 16 * u;
      const left = x - w / 2 + box / 2;
      if (cc) name = cc.text;
      if (name) {
        ctx.font = (cc ? "800 " : "600 ") + Math.max(9, (cc ? 14 : 12) * u) + "px 'IBM Plex Sans KR', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0, 0, 0, .6)";
        ctx.fillText(name, x + 1, y - h - 4 * u + 1);
        ctx.fillStyle = cc ? "#ffd43b" : ally ? "#f0e6d2" : "#ffb4b4";
        ctx.fillText(name, x, y - h - 4 * u);
      }
      if (cc) {
        ctx.fillStyle = "#010a13";
        ctx.fillRect(left - u, y + 3 * u, w - box + 2 * u, 4 * u);
        ctx.fillStyle = "#f0e6d2";
        ctx.fillRect(left, y + 4 * u, (w - box) * Math.max(0, cc.frac), 2 * u);
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
      // 3D 모델이 있으면 효과층이 그린다. 여기서는 모델 머리 위 체력바만
      const md = model(faceKey);
      if (md) {
        const top = upright(player.x, player.y, md.h + 25 + lift());
        healthBar(top.x, top.y, Math.max(0, lives) / LIVES, true, level, opts.name || "나", LIVES, ccLabel());
        return;
      }
      // 내 챔피언 초상화가 받침대 위에 선다. 적과 같은 모양, 테두리만 금색.
      // 공중에 뜨면 초상화가 떠오른다
      const base = proj(player.x, player.y, 0), head = upright(player.x, player.y, PORTRAIT_Z + lift());
      const r = 46 * head.k;
      const blink = safe > 0 && Math.floor(safe * 10) % 2;
      ctx.globalAlpha = blink || hidden > t ? 0.4 : 1;
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
      const face = champImage(faceKey);
      if (face.complete && face.naturalWidth) ctx.drawImage(face, head.x - r, head.y - r, r * 2, r * 2);
      else { ctx.fillStyle = "#f0b429"; ctx.fillRect(head.x - r, head.y - r, r * 2, r * 2); }
      ctx.restore();
      if (ghostLeft > 0) glow("#66d9e8", 16);
      ctx.strokeStyle = dead ? "#ff6b6b" : "#c8aa6e";
      ctx.lineWidth = Math.max(2, 5 * head.k);
      ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.stroke();
      noGlow();
      ctx.globalAlpha = 1;
      healthBar(head.x, head.y - r - 8 * U(), Math.max(0, lives) / LIVES, true, level, opts.name || "나", LIVES, ccLabel());
    }

    function drawCaster(c) {
      const alpha = c.wind > 0 ? 1 : Math.max(0, c.fade / 0.5);
      const md = model(c.skill.champ);
      if (md) {
        // 3D 모델은 효과층이 그린다. 머리 위 체력바와 시전 중 차오르는 테두리 대신 막대만
        const top = upright(c.x, c.y, md.h + 25);
        ctx.globalAlpha = Math.min(1, alpha);
        healthBar(top.x, top.y, 1, false, level, c.skill.name.split(" ")[0], 5);
        if (c.wind > 0 && c.skill.cast > 0) {
          const u = U(), w = 80 * u, p = 1 - c.wind / c.skill.cast;
          ctx.fillStyle = "#010a13";
          ctx.fillRect(top.x - w / 2, top.y + 4 * u, w, 5 * u);
          ctx.fillStyle = c.skill.color;
          ctx.fillRect(top.x - w / 2, top.y + 4 * u, w * p, 5 * u);
        }
        ctx.globalAlpha = 1;
        return;
      }
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
      healthBar(head.x, head.y - r - 10 * U(), 1, false, level, c.skill.name.split(" ")[0], 5);
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
      // 지나온 길의 옅은 꼬리(효과층이 있으면 그쪽의 리본 꼬리가 대신한다)
      const trail = (len, width, color, alpha = 0.35) => {
        if (fxgl) return;
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
        if (art.trail && !fxgl) {
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

    // 2D 로 그리는 롤 그림 효과(초가스 Q 가시, 하늘에서 떨어지는 베이가 W·생기는 신드라 Q 구체).
    // 빛기둥·불티·파편은 효과층 파티클(emit) 이 그린다
    function drawEffects() {
      ctx.globalCompositeOperation = "lighter";
      if (fxReady) {
        for (const f of fx) {
          const a = f.life / f.max;
          if (f.kind === "spikes") {
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
        ctx.strokeStyle = p.color ? "#2b1404" : "#1a0b2e";
        ctx.strokeText(p.text, q.x, q.y);
        ctx.fillStyle = p.color || "#c084fc";
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

    // 효과층이 있으면: 바닥(bg) · 선 것들(fg) 을 2D 로 따로 그리고, 효과층이 파티클·왜곡·번짐을 더해 합친다.
    // 위의 입력용 캔버스는 투명하게 비워 둔다. 효과층이 없으면 예전처럼 한 장에 그리고 파티클은 2D 로
    function draw(fdt) {
      if (fdt) tickFx(fdt);
      if (fxgl && !fxgl.ok()) { fxgl.canvas.remove(); fxgl = null; }    // WebGL 이 끊기면 2D 로
      const R = FX(), gl = !!fxgl;
      const sm = shake > 0 ? 10 * shake / 0.25 : 0;
      const sx = (Math.random() - 0.5) * sm, sy = (Math.random() - 0.5) * sm;
      ctx = gl ? bgx : mainCtx;
      if (!gl && R) R.use(ctx);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, VW, VH);
      ctx.save();
      if (!gl && sm) ctx.translate(sx, sy);
      drawGround();
      if (player) drawDecals();
      if (gl) {
        ctx.restore();
        ctx = fgx;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, VW, VH);
        ctx.save();
      }
      if (player) {
        if (R) buildGround(R.ground);
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
        if (R) buildAir(R.air);
        drawPops();
      }
      ctx.restore();
      ctx = mainCtx;
      const low = player && lives === 1 && state === "play" ? 0.18 + 0.1 * Math.sin(performance.now() / 250) : 0;
      if (gl) {
        fxgl.frame({ bg: bgCv, fg: fgCv, waves: player ? screenWaves() : [], shake: { x: sx, y: sy },
                     ca: ca, dead: deadFx, hurt: hurt / 0.4, low,
                     actors: modelActors(), cam: { S, OX, OY, FOCAL, CAM_D, COS, SIN, W2: ARENA.w / 2, H2: ARENA.h / 2 } });
        mainCtx.setTransform(1, 0, 0, 1, 0, 0);
        mainCtx.clearRect(0, 0, canvas.width, canvas.height);
      }
      drawMinimap();
      if (gl) return;

      // 체력이 한 칸 남으면 화면 가장자리가 계속 붉게 숨 쉰다(롤의 낮은 체력)
      if (low) {
        const a = low;
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
      const blocked = state === "play" && held();
      root.querySelectorAll("[data-slot]").forEach(b => {
        const sp = spellById(b.dataset.spell);
        if (!sp) return;
        paintCd(b, cds[sp.id], sp.cd);
        b.classList.toggle("active", (sp.id === "ghost" && ghostLeft > 0) || (sp.id === "cleanse" && tenacity > t));
        // CC 때문에 못 쓰는 주문(이동 불가 중의 점멸) 은 어둡게
        b.classList.toggle("locked", sp.id === "flash" && !!blocked);
      });
      for (const sk of mySkills()) {
        const b = skillBtns[sk.slot];
        // 벨베스 Q 는 지금 커서가 가리키는 방향의 쿨타임
        const left = sk.dirs ? (cursor ? dirLeft[dirOf(cursor.x - player.x, cursor.y - player.y)] : Math.min(...dirLeft)) : cdLeft[sk.slot];
        paintCd(b, left, cdMax[sk.slot]);
        // 쓰는 중(시전·돌진·스킬 통과·투명·돌아갈 수 있음·남은 횟수가 있음) 은 빛나고, CC 중에는 잠긴다
        const using = (dash && dash.sk === sk) || (recall && recall.slot === sk.slot) || (sk.untarget && untarget > t)
          || (sk.stealth && hidden > t) || (sk.ret && ret) || (charges && charges.slot === sk.slot)
          || (sk.amb === "w" && amb.shield) || (sk.amb === "q" && amb.q2);
        b.classList.toggle("active", !!using);
        b.classList.toggle("locked", !!blocked);
        // 다시 누를 수 있으면(르블랑 W·피즈 E) 쿨타임이 돌아도 밝게
        b.classList.toggle("recast", !dash && !!((recall && recall.slot === sk.slot) || (sk.recast && pole) || (sk.amb === "q" && ambQ2())));
      }
      // 오로라 W: 다른 차원에 들어가면 화면 색이 바뀐다
      view.classList.toggle("realm", !!(realm && t < realm.until && state === "play"));
    }
    // 쿨타임은 시계 방향으로 걷히는 그림자와 남은 초
    function paintCd(b, left, max) {
      b.querySelector("i").style.background = left > 0
        ? "conic-gradient(rgba(1, 10, 19, .78) " + (left / max * 360) + "deg, transparent 0)" : "none";
      b.querySelector("b").textContent = left > 0 ? Math.ceil(left) : "";
    }
    // HUD 주문 칸에 이번 판의 주문 두 개를 넣는다(키 순서대로)
    function paintSpells() {
      const k = spellKeys(controls);
      const ids = spellsOf(controls);
      root.querySelectorAll("[data-slot]").forEach((b, i) => {
        const sp = spellById(ids[i]);
        b.dataset.spell = sp.id;
        b.querySelector("img").src = sp.icon;
        b.querySelector("img").alt = sp.name;
        b.querySelector("kbd").textContent = k[sp.id];
        b.title = sp.name + " (" + k[sp.id] + ")";
      });
    }
    // HUD 스킬 칸: 키 글자와 내 챔피언의 Q W E R 아이콘·이름. 이동기 칸만 켜고 나머지는 롤의 "못 씀" 처럼 어둡게.
    // 아이콘은 늦게 오므로 그사이 챔피언이 바뀌었으면 버린다
    let skillNames = null;     // 내 챔피언의 Q W E R 한국어 이름(받기 전엔 null)
    function paintSkills() {
      const champ = faceKey, sks = mySkills(), labels = skillLabels(controls.move);
      const show = list => {
        if (champ !== faceKey) return;
        skillNames = list && list.map(x => x.name);
        skillBtns.forEach((b, i) => {
          const img = b.querySelector("img"), sk = sks.find(x => x.slot === i), on = !!sk;
          const name = (list && list[i].name) || "QWER"[i] + " 스킬";
          if (list && list[i].icon) { img.src = list[i].icon; b.classList.remove("noimg"); }
          else { img.removeAttribute("src"); b.classList.add("noimg"); }
          b.classList.toggle("off", !on);
          b.querySelector("kbd").textContent = labels[i];
          b.title = name + " (" + labels[i] + ") · " + (on ? skillText(sk) + ". 쿨타임 " + skillCd(sk) + "초" : "연습장에서는 못 써요");
        });
      };
      show(null);
      skillIcons(champ).then(show);
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
      if (loading) return;      // 모델을 다 받을 때까지(로딩 화면) 기다린다
      reset();
      paintSpells();
      paintSkills();
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
      const result = { ms: Math.round(t * 1000), dodged, by: lastHit.name, ver: VERSION, mode };
      clearTimeout(overTimer);
      overTimer = setTimeout(() => showOver(`
        <h2>처치당했습니다</h2>
        <p class="note">${mode === "hard" ? "하드 모드 · " : ""}마지막 스킬: ${esc(lastHit.name)} · 레벨 ${level}</p>
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
      // 우클릭은 Q 스킬(커서 쪽으로 나가야 하니 커서를 먼저 갱신)
      if (controls.move === "wasd" && e.pointerType === "mouse") {
        cursor = toArena(e);
        if (e.button === 2) useSkill(0);
        return;
      }
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
      const si = skillKeys(controls.move).indexOf(e.code);
      if (si >= 0 && state === "play") {
        e.preventDefault();
        if (!e.repeat) useSkill(si);
      } else if (sp && state === "play") {
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
    root.querySelectorAll("[data-slot]").forEach(b => b.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      useSpell(b.dataset.spell);
    }));
    skillBtns.forEach((b, i) => b.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      useSkill(i);
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
    root.querySelector('[data-hud="face"]').src = hudFace(faceKey);

    reset();
    fit();
    paintSpells();
    paintSkills();
    hudUpdate();

    // 시작 창. 모드·이동 방식·주문을 고르면 바로 다시 그린다
    function showIntro() {
      const keys2 = keyPair(controls.move);
      const [s1, s2] = spellsOf(controls).map(spellById);
      const k = spellKeys(controls);
      const hard = controls.mode === "hard";
      const on = v => (v ? "true" : "false");
      showOver(`
      <h2>스킬샷 피하기</h2>
      <p>사방에서 날아오는 스킬을 피해 오래 버티세요. ${LIVES}번 맞으면 처치당해요.
        ${hard ? "하드 모드는 무적이 없고, 스킬의 CC 를 그대로 당해요." : `맞은 뒤 ${SAFE_AFTER_HIT}초는 무적이에요.`}</p>
      <div class="dodge-setup">
        <div><span>챔피언</span>
          <div class="spell-pick">
            <button type="button" class="champ-slot" data-champ-pick aria-haspopup="dialog"
                    title="${esc(champName(faceKey))} · 눌러서 바꾸기" aria-label="내 챔피언 ${esc(champName(faceKey))}, 눌러서 바꾸기">
              <img src="${hudFace(faceKey)}" alt=""><b>${esc(champName(faceKey))}</b>
            </button>
            <small>눌러서 바꿔요</small>
          </div></div>
        <div><span>모드</span>
          <div class="seg dodge-seg" role="group" aria-label="모드">
            <button type="button" data-mode="normal" aria-selected="${on(!hard)}">노멀</button>
            <button type="button" data-mode="hard" aria-selected="${on(hard)}">하드 (CC)</button>
          </div></div>
        <div><span>이동 방식</span>
          <div class="seg dodge-seg" role="group" aria-label="이동 방식">
            <button type="button" data-move="mouse" aria-selected="${on(controls.move === "mouse")}">마우스 클릭</button>
            <button type="button" data-move="wasd" aria-selected="${on(controls.move === "wasd")}">WASD</button>
          </div></div>
        <div><span>소환사 주문</span>
          <div class="spell-pick" role="group" aria-label="소환사 주문">
            ${[s1, s2].map((sp, i) => `
              <button type="button" class="spell-slot" data-slot-pick="${i}" title="${sp.name} (${keys2[i]}) · 눌러서 바꾸기"
                      aria-haspopup="dialog" aria-label="${keys2[i]} 칸 ${sp.name}, 눌러서 바꾸기">
                <img src="${sp.icon}" alt=""><kbd>${keys2[i]}</kbd>
              </button>`).join("")}
            <small>칸을 눌러 바꿔요</small>
          </div></div>
      </div>
      <ul class="dodge-keys">
        <li><b>투사체</b> 바닥 그림자가 실제 판정이에요. 옆으로 갈라지는 것도 있어요</li>
        <li><b>장판</b> 바닥 원이 다 차면 터져요</li>
        <li><b>레이저</b> 깜빡이는 선이 보이면 곧 그 선 전체를 쳐요</li>
        <li><b>감옥</b> 창살에 닿으면 맞아요. 안에 갇히면 닿지 않게 버티세요</li>
      </ul>
      ${hard ? `<ul class="dodge-keys">
        <li><b>CC</b> 기절·속박·공중에 뜸은 못 움직이고, 매혹은 아리 쪽으로 끌려가요. 그동안 점멸을 못 써요</li>
        <li><b>둔화</b> 가장 센 둔화 하나만 걸려요. 진 W 는 맞은 지 4초 안이면 속박, 브랜드 Q 는 불붙어 있으면 기절</li>
        <li><b>정화</b> 공중에 뜸만 빼고 CC 를 풀고, 3초 동안 새 CC 가 1/4 로 짧아져요</li>
        <li><b>스킬 레벨</b> 3레벨마다 올라서 CC 가 점점 길어져요(13레벨부터 최대)</li>
      </ul>` : ""}
      <ul class="dodge-keys">
        ${controls.move === "mouse"
          ? `<li><b>우클릭</b> 찍은 곳으로 이동 (누른 채 끌면 계속 따라가요)</li>`
          : `<li><b>WASD</b> 누른 쪽으로 이동 (방향키도 돼요). 마우스는 점멸·이동기 방향만 정해요</li>`}
        ${mySkills().length ? mySkills().map((sk, n, all) => `<li><b>${skillLabels(controls.move)[sk.slot]}</b> ${skillNames && skillNames[sk.slot] ? esc(skillNames[sk.slot]) + ". " : ""}${skillText(sk)}. 쿨타임 ${skillCd(sk)}초${n === all.length - 1 ? " (나머지 스킬 칸은 못 써요)" : ""}</li>`).join("")
          : `<li><b>${skillLabels(controls.move).join(" ")}</b> 스킬 칸. 이 챔피언은 연습장에서 쓸 이동기가 없어요</li>`}
        <li><b>${k[s1.id]} · ${k[s2.id]}</b> ${s1.name} · ${s2.name}. 쿨타임 ${s1.cd}초 · ${s2.cd}초
          (점멸은 커서 쪽 400, 유체화는 3초 동안 이동 속도 +40%)</li>
        <li><b>휴대폰</b> 화면을 누른 곳으로 이동, 주문·스킬은 아래 칸을 눌러요</li>
      </ul>
      <p class="note">이동 속도 ${CHAMP.speed}. 스킬 수치·CC·그림은 롤 클라이언트, 소리는 롤 위키 것이에요.</p>
      <div class="dodge-actions"><button type="button" data-start>시작 <small>Space</small></button>${opts.links || ""}</div>`);
      const pick = fn => btn => btn.onclick = () => {
        fn(btn);
        saveControls(controls);
        keys.clear();
        reset();          // 모드·주문이 바뀌면 HUD 도 새 주문으로
        paintSpells();
        paintSkills();
        hudUpdate();
        showIntro();
        if (opts.onMode) opts.onMode(controls.mode);
      };
      over.querySelectorAll("[data-mode]").forEach(pick(btn => { controls.mode = btn.dataset.mode; }));
      over.querySelectorAll("[data-move]").forEach(pick(btn => { controls.move = btn.dataset.move; }));
      over.querySelectorAll("[data-slot-pick]").forEach(btn => btn.onclick = e => { e.stopPropagation(); spellPopup(btn, pick); });
      over.querySelector("[data-champ-pick]").onclick = e => { e.stopPropagation(); champPopup(e.currentTarget, pick); };
    }

    // 내 챔피언 고르기: 이동기와 그 3D 동작이 있는 챔피언(MOBILITY).
    // 칸에 올리면 아래에 그 챔피언의 이동기 설명. 바깥을 누르거나 Esc 면 닫힌다
    function champPopup(btn, pick) {
      const card = over.querySelector(".dodge-card");
      card.querySelectorAll(".spell-pop").forEach(x => x.remove());
      const list = Object.keys(MOBILITY).sort((a, b) => champName(a).localeCompare(champName(b), "ko"));
      const pop = document.createElement("div");
      pop.className = "spell-pop champ-pop";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", "내 챔피언 고르기");
      pop.innerHTML = `
        <div class="spell-pop-grid">
          ${list.map(k => `
            <button type="button" data-champ-choose="${k}" aria-pressed="${myChamp() === k}" aria-label="${esc(champName(k))}">
              <img src="${hudFace(champAlias(k))}" alt="" loading="lazy"></button>`).join("")}
        </div>
        <div class="spell-pop-info"></div>`;
      const info = pop.querySelector(".spell-pop-info");
      const show = k => {
        info.innerHTML = `<b>${esc(champName(k))}</b>
          ${skillsOf(k).map(sk => `<p>${skillLabels(controls.move)[sk.slot]} · ${skillText(sk)}. 쿨타임 ${skillCd(sk)}초</p>`).join("")}`;
      };
      show(myChamp());
      card.appendChild(pop);
      // 누른 칸 바로 아래에 띄운다(챔피언 칸은 시작 창 맨 위라 위에는 자리가 없다)
      const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(card.clientWidth - pop.offsetWidth - 8, br.left - cr.left)) + "px";
      pop.style.top = (br.bottom - cr.top + card.scrollTop + 8) + "px";
      const outside = e => { if (!pop.contains(e.target)) close(); };
      const esc2 = e => { if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); } };
      function close() {
        pop.remove();
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", esc2, true);
      }
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc2, true);
      pop.querySelectorAll("[data-champ-choose]").forEach(b => {
        const k = b.dataset.champChoose;
        b.title = champName(k);
        b.onmouseenter = b.onfocus = () => show(k);
        pick(() => {
          controls.champ = k;
          close();
          applyFace();
        })(b);
      });
      pop.querySelector('[aria-pressed="true"]').focus();
    }

    // 롤의 소환사 주문 고르기: 칸을 누르면 그 칸 위에 주문 목록이 뜨고, 고르면 그 칸이 바뀐다.
    // 다른 칸에 있는 주문을 고르면 롤처럼 두 칸이 서로 바뀐다. 바깥을 누르거나 Esc 면 닫힌다
    function spellPopup(btn, pick) {
      const card = over.querySelector(".dodge-card");
      card.querySelectorAll(".spell-pop").forEach(x => x.remove());
      const i = +btn.dataset.slotPick, slots = controls.slots[controls.mode];
      const pop = document.createElement("div");
      pop.className = "spell-pop";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", "소환사 주문 고르기");
      pop.innerHTML = `
        <div class="spell-pop-grid">
          ${SPELLS.map(sp => `
            <button type="button" data-spell-choose="${sp.id}" aria-pressed="${sp.id === slots[i]}"
                    class="${sp.id === slots[1 - i] ? "other" : ""}" aria-label="${sp.name}">
              <img src="${sp.icon}" alt=""></button>`).join("")}
        </div>
        <div class="spell-pop-info"></div>`;
      const info = pop.querySelector(".spell-pop-info");
      const show = sp => {
        info.innerHTML = `<b>${sp.name}</b> <small>재사용 대기시간 ${sp.cd}초</small><p>${sp.desc}</p>`;
      };
      show(spellById(slots[i]));
      card.appendChild(pop);
      // 누른 칸 바로 위에 띄운다(카드 안에서. 카드는 스크롤될 수 있다). 위에 자리가 없으면 아래에
      const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect();
      const top = br.top - cr.top + card.scrollTop;
      pop.style.left = Math.max(8, Math.min(card.clientWidth - pop.offsetWidth - 8, br.left - cr.left + br.width / 2 - pop.offsetWidth / 2)) + "px";
      pop.style.top = (top - pop.offsetHeight - 8 >= card.scrollTop ? top - pop.offsetHeight - 8 : top + br.height + 8) + "px";
      const outside = e => { if (!pop.contains(e.target)) close(); };
      const esc = e => { if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); } };
      function close() {
        pop.remove();
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", esc, true);
      }
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
      pop.querySelectorAll("[data-spell-choose]").forEach(b => {
        const sp = spellById(b.dataset.spellChoose);
        b.onmouseenter = b.onfocus = () => show(sp);
        pick(() => {
          const j = slots.indexOf(sp.id);
          if (j === 1 - i) slots[j] = slots[i];     // 다른 칸의 주문이면 서로 바꾼다
          slots[i] = sp.id;
          close();
        })(b);
      });
      pop.querySelector('[aria-pressed="true"]').focus();
    }
    showIntro();
    // 한국어 챔피언 이름이 시작 창보다 늦게 오면 시작 창을 다시 그린다(고르기 목록이 열려 있을 때는 두고)
    loadChampIds().then(() => { if (over.querySelector("[data-champ-pick]") && !over.querySelector(".spell-pop")) showIntro(); });

    // 내 챔피언을 정한 대로 바꾼다(초상화·스킬 칸·3D 모델)
    function applyFace() {
      faceKey = champAlias(myChamp());
      root.querySelector('[data-hud="face"]').src = hudFace(faceKey);
      paintSkills();
      ensureModels([faceKey]);
    }

    function setBest(text) { hud("best").innerHTML = text || ""; }

    // 내 챔피언을 나중에 바꾼다(티어표를 늦게 받았을 때)
    // 시작 창에서 직접 고른 챔피언이 있으면 그쪽이 먼저다(고를 수 있는 42명 밖의 챔피언이면 이즈리얼)
    function setChamp(key, name) {
      if (key) { opFace = key; if (!controls.champ) applyFace(); }
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
      onFx.delete(atlasUp);
      if (fxgl) { fxgl.destroy(); fxgl = null; }
    }

    return { destroy, setBest, setChamp, mode: () => controls.mode };
  }

  window.DodgeGame = { mount, fmt, SKILLS, VERSION };
})();
