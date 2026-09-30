// 스킬샷 피하기. 서버 없이 이 파일만으로 돈다(기록 저장만 app.js 가 서버에 보낸다).
//
// 거리와 속도는 롤의 게임 단위(유닛) 그대로 쓰고, 그릴 때만 화면 크기에 맞춰 줄인다.
//   - 내 챔피언: 판정 반지름 65(대부분의 챔피언), 이동 속도 345
//   - 맞았는지: 스킬 판정(투사체 원, 장판 원, 레이저 띠, 감옥 테두리)과 내 판정 원이 겹치면 맞은 것
// 빠른 투사체(초당 3300)가 한 프레임에 나를 뛰어넘지 않게, 1/240초씩 잘게 나눠 움직인다.
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
  const VERSION = 2;

  const ARENA = { w: 1400, h: 900 };
  const CHAMP = { radius: 65, speed: 345 };
  const STEP = 1 / 240;
  const FAR = 4000;            // 경기장보다 긴 사거리(레이저 등)

  // kind: line(투사체) circle(지연 장판) beam(지연 레이저) cage(감옥)
  // from: 몇 초부터 나오는지. rare: 가끔만
  const SKILLS = [
    // ── 투사체 (전부 file) ──
    { kind: "line", name: "모르가나 Q", champ: "Morgana", cast: 0.25, speed: 1200, radius: 70, range: 1300, color: "#b197fc", from: 0 },
    { kind: "line", name: "럭스 Q", champ: "Lux", cast: 0.25, speed: 1200, radius: 70, range: 1300, color: "#ffe066", from: 0 },
    { kind: "line", name: "자이라 E", champ: "Zyra", cast: 0.25, speed: 1150, radius: 70, range: 1150, color: "#69db7c", from: 0 },
    { kind: "line", name: "니달리 Q", champ: "Nidalee", cast: 0.25, speed: 1300, radius: 40, range: 1500, color: "#8ce99a", from: 8 },
    { kind: "line", name: "브랜드 Q", champ: "Brand", cast: 0.25, speed: 1600, radius: 60, range: 1100, color: "#ff8787", from: 8 },
    { kind: "line", name: "아리 E", champ: "Ahri", cast: 0.25, speed: 1550, radius: 60, range: 1000, color: "#faa2c1", from: 15 },
    { kind: "line", name: "벨코즈 Q", champ: "Velkoz", cast: 0.25, speed: 1300, radius: 50, range: 1100, color: "#d0bfff", from: 15 },
    { kind: "line", name: "제라스 E", champ: "Xerath", cast: 0.25, speed: 1400, radius: 60, range: 1125, color: "#91a7ff", from: 15 },
    { kind: "line", name: "이즈리얼 Q", champ: "Ezreal", cast: 0.25, speed: 2000, radius: 60, range: 1200, color: "#74c0fc", from: 25 },
    { kind: "line", name: "레오나 E", champ: "Leona", cast: 0.25, speed: 2000, radius: 70, range: 900, color: "#ffd43b", from: 25 },
    { kind: "line", name: "베이가 Q", champ: "Veigar", cast: 0.25, speed: 2200, radius: 70, range: 1050, color: "#9775fa", from: 25 },
    { kind: "line", name: "블리츠크랭크 Q", champ: "Blitzcrank", cast: 0.25, speed: 1800, radius: 70, range: 1080, color: "#ffc078", from: 35 },
    { kind: "line", name: "쓰레쉬 Q", champ: "Thresh", cast: 0.5, speed: 1900, radius: 70, range: 1100, color: "#63e6be", from: 35 },
    { kind: "line", name: "징크스 W", champ: "Jinx", cast: 0.6, speed: 3300, radius: 60, range: 1500, color: "#f783ac", from: 50 },
    // 애쉬 R 은 1500 에서 시작해 초당 200 씩 빨라져 2100 까지(AcceleratingMovement)
    { kind: "line", name: "애쉬 R", champ: "Ashe", cast: 0.25, speed: 1500, accel: 200, maxSpeed: 2100, radius: 130, range: FAR, color: "#a5d8ff", from: 50, rare: true },

    // ── 지연 장판: 시전 → 바닥에 표시 → delay 초 뒤 터짐 ──
    { kind: "circle", name: "카서스 Q", champ: "Karthus", cast: 0.25, delay: 0.528, radius: 160, range: 875, color: "#b2f2bb", from: 0, src: "delay: wiki" },
    { kind: "circle", name: "브랜드 W", champ: "Brand", cast: 0.25, delay: 0.627, radius: 240, range: 900, color: "#ff922b", from: 0, src: "delay: wiki" },
    { kind: "circle", name: "초가스 Q", champ: "Chogath", cast: 0.5, delay: 0.627, radius: 230, range: 950, color: "#a9e34b", from: 8, src: "cast, delay: wiki" },
    { kind: "circle", name: "베이가 W", champ: "Veigar", cast: 0.25, delay: 1.2, radius: 225, range: 950, color: "#7950f2", from: 8 },
    { kind: "circle", name: "신드라 Q", champ: "Syndra", cast: 0, delay: 0.6, radius: 180, range: 800, color: "#e599f7", from: 15, src: "cast(없음), delay: wiki" },
    { kind: "circle", name: "제라스 W", champ: "Xerath", cast: 0.25, delay: 0.5, radius: 250, range: 1000, color: "#748ffc", from: 15 },
    // 벨코즈 E 는 멀리 던질수록 늦게 떨어진다: 0.25초(가까이) ~ 0.55초(사거리 끝)
    { kind: "circle", name: "벨코즈 E", champ: "Velkoz", cast: 0.25, delay: 0.25, delayFar: 0.55, radius: 225, range: 800, color: "#cc5de8", from: 25 },
    { kind: "circle", name: "레오나 R", champ: "Leona", cast: 0.25, delay: 0.625, radius: 300, range: 1200, color: "#fab005", from: 25, src: "delay: wiki" },

    // ── 지연 레이저: 시전하는 동안 가는 선이 보이고, 끝나는 순간 선 전체를 친다 ──
    { kind: "beam", name: "진 W", champ: "Jhin", cast: 0.75, radius: 40, range: FAR, color: "#ff6b6b", from: 35 },
    { kind: "beam", name: "럭스 R", champ: "Lux", cast: 1.0, radius: 100, range: FAR, color: "#fff3bf", from: 50, rare: true, src: "cast, radius: wiki" },

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
    let player, target, casters, missiles, zones, flashes, hitBy;
    const keys = new Set();
    let holding = false;
    let scale = 1;

    function reset() {
      player = { x: ARENA.w / 2, y: ARENA.h / 2, vx: 0, vy: 0 };
      target = null;
      casters = [];      // 시전 중인 적
      missiles = [];     // 날아가는 투사체
      zones = [];        // 바닥 장판·감옥
      flashes = [];      // 레이저가 지나간 자리(그림만)
      hitBy = null;
      t = 0; dodged = 0; acc = 0;
      nextCast = 0.8;          // 시작하고 잠깐은 숨 돌릴 틈
    }

    // ── 화면 크기 ──
    function fit() {
      // 가로는 칸에 꽉 차게, 단 세로가 창 안에 다 들어오게 줄인다(게임 중에 스크롤하면 안 되니까)
      const stage = canvas.parentElement;
      const room = window.innerHeight - Math.max(0, stage.getBoundingClientRect().top + window.scrollY) - 16;
      const w = Math.floor(Math.min(stage.clientWidth, Math.max(240, room) * ARENA.w / ARENA.h));
      const h = w * ARENA.h / ARENA.w;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      scale = w / ARENA.w;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      draw();
    }

    function toArena(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    }

    // ── 스킬 고르기 ──
    function pickSkill() {
      let open = SKILLS.filter(s => s.from <= t);
      // 감옥은 한 번에 하나만
      if (zones.some(z => z.skill.kind === "cage") || casters.some(c => c.skill.kind === "cage")) {
        open = open.filter(s => s.kind !== "cage");
      }
      const rare = open.filter(s => s.rare);
      if (rare.length && Math.random() < 0.08) return rare[Math.floor(Math.random() * rare.length)];
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

    // 시전이 끝난 순간
    function release(c) {
      const s = c.skill;
      if (s.kind === "line") {
        missiles.push({ skill: s, x: c.x, y: c.y, dx: c.dx, dy: c.dy, speed: s.speed, left: s.range, flown: 0 });
      } else if (s.kind === "circle") {
        const delay = s.delayFar ? s.delay + (s.delayFar - s.delay) * Math.min(1, dist(c, c.aim) / s.range) : s.delay;
        zones.push({ skill: s, x: c.aim.x, y: c.aim.y, wait: delay, total: delay });
      } else if (s.kind === "cage") {
        zones.push({ skill: s, x: c.aim.x, y: c.aim.y, wait: s.delay, total: s.delay, up: 0 });
      } else if (s.kind === "beam") {
        const a = { x: c.x, y: c.y }, b = { x: c.x + c.dx * s.range, y: c.y + c.dy * s.range };
        if (segDist(player, a, b) < CHAMP.radius + s.radius) hitBy = s;
        else dodged += 1;
        flashes.push({ skill: s, a, b, left: 0.25 });
      }
    }

    // ── 한 걸음(1/240초) ──
    function step(dt) {
      t += dt;

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
      if (hitBy) return;

      // 투사체
      for (const m of missiles) {
        if (m.skill.accel) m.speed = Math.min(m.skill.maxSpeed, m.speed + m.skill.accel * dt);
        const d = m.speed * dt;
        m.x += m.dx * d; m.y += m.dy * d;
        m.left -= d; m.flown += d;
        const reach = CHAMP.radius + m.skill.radius;
        if ((m.x - player.x) ** 2 + (m.y - player.y) ** 2 < reach * reach) { hitBy = m.skill; return; }
      }
      const pad = 200;
      const alive = [];
      for (const m of missiles) {
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
            if (d < s.radius + CHAMP.radius) { hitBy = s; return; }
            dodged += 1;
            z.done = 0.3;          // 터진 자리를 잠깐 보여 준다
            continue;
          }
        }
        if (s.kind === "cage") {
          // 테두리에 몸이 닿으면 맞는다. 안에 갇혔으면 테두리에 닿지 않게 버텨야 한다
          if (Math.abs(d - s.radius) < CHAMP.radius) { hitBy = s; return; }
          z.up += dt;
          if (z.up >= s.last) { z.done = 0.3; dodged += 1; }
        }
      }
      for (const z of zones) if (z.done != null) z.done -= dt;
      zones = zones.filter(z => z.done == null || z.done > 0);
      for (const f of flashes) f.left -= dt;
      flashes = flashes.filter(f => f.left > 0);
    }

    // ── 그리기 ──
    function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

    function draw() {
      ctx.clearRect(0, 0, ARENA.w, ARENA.h);
      ctx.fillStyle = "#0b1528";
      ctx.fillRect(0, 0, ARENA.w, ARENA.h);
      ctx.strokeStyle = "rgba(154,171,201,.08)";
      ctx.lineWidth = 2;
      for (let x = 100; x < ARENA.w; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.h); ctx.stroke(); }
      for (let y = 100; y < ARENA.h; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.w, y); ctx.stroke(); }
      if (!player) return;

      // 바닥 장판(아래에 깔리게 먼저)
      for (const z of zones) {
        const s = z.skill;
        if (s.kind === "circle") {
          if (z.done != null) {
            ctx.globalAlpha = Math.max(0, z.done / 0.3);
            ctx.fillStyle = s.color;
            circle(z.x, z.y, s.radius); ctx.fill();
            ctx.globalAlpha = 1;
            continue;
          }
          // 테두리는 처음부터, 안쪽은 터질 때가 다가올수록 차오른다
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 6;
          circle(z.x, z.y, s.radius); ctx.stroke();
          ctx.fillStyle = s.color + "40";
          circle(z.x, z.y, s.radius * (1 - Math.max(0, z.wait) / z.total)); ctx.fill();
        } else if (s.kind === "cage") {
          const forming = z.wait > 0;
          ctx.globalAlpha = z.done != null ? Math.max(0, z.done / 0.3) : 1;
          ctx.strokeStyle = s.color;
          ctx.setLineDash(forming ? [18, 18] : []);
          ctx.lineWidth = forming ? 6 : 16;
          circle(z.x, z.y, s.radius); ctx.stroke();
          ctx.setLineDash([]);
          if (!forming) { ctx.fillStyle = s.color + "18"; circle(z.x, z.y, s.radius); ctx.fill(); }
          ctx.globalAlpha = 1;
        }
      }

      // 레이저: 시전 중에는 가는 경고선, 쏜 뒤에는 굵은 띠
      for (const c of casters) {
        if (c.skill.kind !== "beam" || c.wind <= 0) continue;
        ctx.strokeStyle = c.skill.color + "99";
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + c.dx * FAR, c.y + c.dy * FAR); ctx.stroke();
      }
      for (const f of flashes) {
        ctx.globalAlpha = Math.max(0, f.left / 0.25);
        ctx.strokeStyle = f.skill.color;
        ctx.lineWidth = f.skill.radius * 2;
        ctx.lineCap = "butt";
        ctx.beginPath(); ctx.moveTo(f.a.x, f.a.y); ctx.lineTo(f.b.x, f.b.y); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 찍은 곳 표시(롤의 초록 클릭 표시)
      if (target && state === "play") {
        ctx.strokeStyle = "#69db7c";
        ctx.lineWidth = 5;
        circle(target.x, target.y, 22); ctx.stroke();
      }

      for (const m of missiles) {
        const s = m.skill;
        const tail = Math.min(m.flown, s.radius * 4);
        ctx.strokeStyle = s.color + "55";
        ctx.lineWidth = s.radius * 1.2;
        ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(m.x - m.dx * tail, m.y - m.dy * tail); ctx.lineTo(m.x, m.y); ctx.stroke();
        ctx.fillStyle = s.color;
        circle(m.x, m.y, s.radius); ctx.fill();
      }

      for (const c of casters) {
        const r = 48;
        ctx.globalAlpha = c.wind > 0 ? 1 : Math.max(0, c.fade / 0.5);
        const img = champImage(c.skill.champ);
        ctx.save();
        circle(c.x, c.y, r); ctx.clip();
        if (img.complete && img.naturalWidth) ctx.drawImage(img, c.x - r, c.y - r, r * 2, r * 2);
        else { ctx.fillStyle = "#2b4270"; ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2); }
        ctx.restore();
        // 시전 중이면 테두리가 차오른다
        ctx.strokeStyle = c.skill.color;
        ctx.lineWidth = 8;
        const p = c.wind > 0 && c.skill.cast > 0 ? 1 - c.wind / c.skill.cast : 1;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + 6, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 나
      ctx.fillStyle = hitBy ? "#ff6b6b" : "#f0b429";
      circle(player.x, player.y, CHAMP.radius); ctx.fill();
      ctx.strokeStyle = "#0f1b33";
      ctx.lineWidth = 6;
      circle(player.x, player.y, CHAMP.radius - 14); ctx.stroke();
    }

    function hudUpdate() {
      hud("time").textContent = fmt(t);
      hud("dodged").textContent = dodged;
    }

    // ── 흐름 ──
    function loop(now) {
      raf = requestAnimationFrame(loop);
      // 다른 탭에 갔다 오면 한꺼번에 흐르지 않게 한 번에 최대 0.1초만 진행.
      // 시작 직후 첫 프레임은 시각이 시작 시각보다 조금 앞설 수 있어서 0 아래로는 안 간다
      acc += Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      while (acc >= STEP && state === "play") {
        acc -= STEP;
        step(STEP);
        if (hitBy) { end(); break; }
      }
      draw();
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
      const result = { ms: Math.round(t * 1000), dodged, by: hitBy.name, ver: VERSION };
      showOver(`
        <h2>${esc(hitBy.name)}에 맞았어요</h2>
        <p class="dodge-score">${fmt(t)}</p>
        <p class="note">피한 스킬 ${dodged}개</p>
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
    showOver(`
      <h2>스킬샷 피하기</h2>
      <p>사방에서 날아오는 스킬을 피해 오래 버티세요. 한 번 맞으면 끝이에요.</p>
      <ul class="dodge-keys">
        <li><b>투사체</b> 날아오는 스킬. 쏘는 순간 방향이 정해져요</li>
        <li><b>장판</b> 바닥 원이 다 차면 터져요</li>
        <li><b>레이저</b> 가는 선이 보이면 곧 그 선 전체를 쳐요</li>
        <li><b>감옥</b> 베이가 E. 테두리에 닿으면 끝, 안에 갇히면 버티기</li>
      </ul>
      <ul class="dodge-keys">
        <li><b>우클릭</b> 찍은 곳으로 이동 (누른 채 끌면 계속 따라가요)</li>
        <li><b>WASD</b> 누른 쪽으로 바로 이동 (방향키도 돼요)</li>
        <li><b>휴대폰</b> 화면을 누른 곳으로 이동</li>
      </ul>
      <p class="note">이동 속도 ${CHAMP.speed}, 판정 반지름 ${CHAMP.radius}. 스킬 ${SKILLS.length}개의 속도·폭·사거리·시전 시간은 롤 클라이언트 데이터(16.19)에서, 데이터에 없는 장판 지연 시간 몇 개는 롤 위키에서 가져왔어요.</p>
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
