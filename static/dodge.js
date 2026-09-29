// 스킬샷 피하기. 서버 없이 이 파일만으로 돈다(기록 저장만 app.js 가 서버에 보낸다).
//
// 거리와 속도는 롤의 게임 단위(유닛) 그대로 쓰고, 그릴 때만 화면 크기에 맞춰 줄인다.
//   - 내 챔피언: 판정 반지름 65(대부분의 챔피언), 이동 속도 345
//   - 스킬: 투사체 속도·폭·사거리·시전 시간을 롤 위키의 값에 맞췄다(패치마다 조금씩 바뀐다)
//   - 맞았는지: 투사체 원(폭의 절반)과 내 판정 원이 겹치면 맞은 것. 롤과 같은 방식이다
// 빠른 투사체(초당 2000)가 한 프레임에 나를 뛰어넘지 않게, 1/240초씩 잘게 나눠 움직인다.
//
// 조작: 우클릭(누른 채 끌면 계속 따라감) 또는 WASD·방향키. 휴대폰은 화면을 누르면 이동.
// WASD 는 e.code 로 읽는다. 한글 입력 상태에서도 ㅈㅁㄴㅇ 이 아니라 WASD 로 잡힌다.

(function () {
  const ARENA = { w: 1400, h: 900 };
  const CHAMP = { radius: 65, speed: 345 };
  const STEP = 1 / 240;
  const MIN_CAST_DIST = 700;   // 바로 옆에서 쏘면 피할 수 없다. 이만큼은 떨어져서 쏜다

  // from: 몇 초부터 나오는지. 시간이 갈수록 빠른 스킬이 섞인다
  const SKILLS = [
    { name: "모르가나 Q", champ: "Morgana", speed: 1200, radius: 70, range: 1300, cast: 0.25, color: "#b197fc", from: 0 },
    { name: "럭스 Q", champ: "Lux", speed: 1200, radius: 70, range: 1240, cast: 0.25, color: "#ffe066", from: 0 },
    { name: "니달리 Q", champ: "Nidalee", speed: 1300, radius: 40, range: 1500, cast: 0.25, color: "#8ce99a", from: 0 },
    { name: "아리 E", champ: "Ahri", speed: 1550, radius: 60, range: 1000, cast: 0.25, color: "#faa2c1", from: 10 },
    { name: "이즈리얼 Q", champ: "Ezreal", speed: 2000, radius: 60, range: 1200, cast: 0.25, color: "#74c0fc", from: 20 },
    { name: "블리츠크랭크 Q", champ: "Blitzcrank", speed: 1800, radius: 70, range: 1100, cast: 0.25, color: "#ffc078", from: 30 },
    { name: "쓰레쉬 Q", champ: "Thresh", speed: 1900, radius: 70, range: 1100, cast: 0.5, color: "#63e6be", from: 40 },
    { name: "애쉬 R", champ: "Ashe", speed: 1600, radius: 130, range: 3000, cast: 0.25, color: "#a5d8ff", from: 60, rare: true },
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
  function castGap(t) { return Math.max(0.32, 1.25 * Math.pow(0.97, t / 2)); }
  function leadChance(t) { return Math.min(0.45, t / 150); }

  function fmt(sec) {
    const s = Math.floor(sec), cs = Math.floor((sec - s) * 100);
    return s + "." + String(cs).padStart(2, "0") + "초";
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
    let player, target, casters, missiles, hitBy;
    const keys = new Set();
    let holding = false;
    let scale = 1;

    function reset() {
      player = { x: ARENA.w / 2, y: ARENA.h / 2, vx: 0, vy: 0 };
      target = null;
      casters = [];
      missiles = [];
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

    // ── 스킬 쏘기 ──
    function pickSkill() {
      const open = SKILLS.filter(s => s.from <= t);
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

    function cast() {
      const skill = pickSkill();
      let at = edgePoint();
      for (let i = 0; i < 12 && Math.hypot(at.x - player.x, at.y - player.y) < MIN_CAST_DIST; i++) at = edgePoint();
      // 롤처럼 누르는 순간 방향이 정해진다. 가끔은 내가 갈 곳을 앞질러 쏜다
      let aimX = player.x, aimY = player.y;
      if (Math.random() < leadChance(t)) {
        const fly = skill.cast + Math.hypot(at.x - player.x, at.y - player.y) / skill.speed;
        aimX += player.vx * fly;
        aimY += player.vy * fly;
      }
      const d = Math.hypot(aimX - at.x, aimY - at.y) || 1;
      casters.push({ skill, x: at.x, y: at.y, dx: (aimX - at.x) / d, dy: (aimY - at.y) / d, wind: skill.cast, fade: 0.5 });
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
        const dist = Math.hypot(dx, dy);
        const move = CHAMP.speed * dt;
        if (dist <= move) {
          player.x = target.x; player.y = target.y;
          player.vx = player.vy = 0;
          if (!holding) target = null;
        } else {
          player.vx = dx / dist * CHAMP.speed;
          player.vy = dy / dist * CHAMP.speed;
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
          if (c.wind <= 0) {
            const s = c.skill;
            missiles.push({ skill: s, x: c.x, y: c.y, dx: c.dx, dy: c.dy, left: s.range, flown: 0 });
          }
        } else {
          c.fade -= dt;
        }
      }
      casters = casters.filter(c => c.wind > 0 || c.fade > 0);

      // 투사체
      for (const m of missiles) {
        const d = m.skill.speed * dt;
        m.x += m.dx * d; m.y += m.dy * d;
        m.left -= d; m.flown += d;
        const reach = CHAMP.radius + m.skill.radius;
        if ((m.x - player.x) ** 2 + (m.y - player.y) ** 2 < reach * reach) { hitBy = m; return; }
      }
      const pad = 200;
      const alive = [];
      for (const m of missiles) {
        const out = m.x < -pad || m.y < -pad || m.x > ARENA.w + pad || m.y > ARENA.h + pad;
        if (m.left <= 0 || out) dodged += 1; else alive.push(m);
      }
      missiles = alive;
    }

    // ── 그리기 ──
    function draw() {
      ctx.clearRect(0, 0, ARENA.w, ARENA.h);
      ctx.fillStyle = "#0b1528";
      ctx.fillRect(0, 0, ARENA.w, ARENA.h);
      ctx.strokeStyle = "rgba(154,171,201,.08)";
      ctx.lineWidth = 2;
      for (let x = 100; x < ARENA.w; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.h); ctx.stroke(); }
      for (let y = 100; y < ARENA.h; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.w, y); ctx.stroke(); }
      if (!player) return;

      // 찍은 곳 표시(롤의 초록 클릭 표시)
      if (target && state === "play") {
        ctx.strokeStyle = "#69db7c";
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(target.x, target.y, 22, 0, Math.PI * 2); ctx.stroke();
      }

      for (const m of missiles) {
        const s = m.skill;
        const tail = Math.min(m.flown, s.radius * 4);
        ctx.strokeStyle = s.color + "55";
        ctx.lineWidth = s.radius * 1.2;
        ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(m.x - m.dx * tail, m.y - m.dy * tail); ctx.lineTo(m.x, m.y); ctx.stroke();
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(m.x, m.y, s.radius, 0, Math.PI * 2); ctx.fill();
      }

      for (const c of casters) {
        const r = 48;
        ctx.globalAlpha = c.wind > 0 ? 1 : Math.max(0, c.fade / 0.5);
        const img = champImage(c.skill.champ);
        ctx.save();
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.clip();
        if (img.complete && img.naturalWidth) ctx.drawImage(img, c.x - r, c.y - r, r * 2, r * 2);
        else { ctx.fillStyle = "#2b4270"; ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2); }
        ctx.restore();
        // 시전 중이면 테두리가 차오른다
        ctx.strokeStyle = c.skill.color;
        ctx.lineWidth = 8;
        const p = c.wind > 0 ? 1 - c.wind / c.skill.cast : 1;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + 6, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 나
      ctx.fillStyle = hitBy ? "#ff6b6b" : "#f0b429";
      ctx.beginPath(); ctx.arc(player.x, player.y, CHAMP.radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0f1b33";
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(player.x, player.y, CHAMP.radius - 14, 0, Math.PI * 2); ctx.stroke();
    }

    function hudUpdate() {
      hud("time").textContent = fmt(t);
      hud("dodged").textContent = dodged;
    }

    // ── 흐름 ──
    function loop(now) {
      raf = requestAnimationFrame(loop);
      // 다른 탭에 갔다 오면 한꺼번에 흐르지 않게 한 번에 최대 0.1초만 진행
      acc += Math.min(0.1, (now - last) / 1000);
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
      const result = { ms: Math.round(t * 1000), dodged, by: hitBy.skill.name };
      showOver(`
        <h2>${esc(hitBy.skill.name)}에 맞았어요</h2>
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
      <p>사방에서 날아오는 논타깃 스킬을 피해 오래 버티세요. 한 번 맞으면 끝이에요.</p>
      <ul class="dodge-keys">
        <li><b>우클릭</b> 찍은 곳으로 이동 (누른 채 끌면 계속 따라가요)</li>
        <li><b>WASD</b> 누른 쪽으로 바로 이동 (방향키도 돼요)</li>
        <li><b>휴대폰</b> 화면을 누른 곳으로 이동</li>
      </ul>
      <p class="note">이동 속도 ${CHAMP.speed}, 판정 반지름 ${CHAMP.radius}. 스킬 속도·폭·사거리·시전 시간도 롤에 맞췄어요.</p>
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

  window.DodgeGame = { mount, fmt, SKILLS };
})();
