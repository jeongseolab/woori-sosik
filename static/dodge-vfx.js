// 스킬샷 피하기의 롤 이펙트 재생기. tools/lol_vfx.py 가 롤 클라이언트에서 뽑은 파티클 정의(dodge/vfx/fx.json) 를
// 롤 엔진처럼 돌리고(발생기 → 파티클), dodge-gl.js 의 WebGL 에 3D 로 그린다.
//
// 값의 뜻은 LeagueToolkit lol-meta-wiki(github.com/LeagueToolkit/lol-meta-wiki) 를 따른다.
//  - 값(Value*): 상수 c, 곡선 t·v, 확률표 r(성분마다 [keyTimes, keyValues]: 0~1 난수로 찾은 값을 곱한다).
//    Birth* 는 파티클이 날 때 한 번(곡선은 발생기 나이 비율로), 나머지는 파티클 나이 비율(0~1) 로 본다
//  - 크기: 카메라 판·바닥 판은 ±scale.x × ±scale.y(그래서 지름이 2배), 광선은 길이 scale.y·너비 scale.x
//  - 섞기: 0·2·4(와 없음) 는 빛을 더하고, 1·3·5 는 알파로 덮는다(검은 바탕 텍스처 / 알파 텍스처로 확인)
//  - 바닥층(isGroundLayer): 캐릭터보다 먼저, 깊이 검사 없이 그린다
// 좌표는 롤 그대로(x 동쪽, y 위, z 북쪽) 로 계산하고, 그릴 때 연습장 바닥 좌표로 바꾼다(바닥 x = x, 바닥 y = -z, 높이 = y)
(function () {
  "use strict";

  const D2R = Math.PI / 180;
  const ADDITIVE = new Set([undefined, null, 0, 2, 4]);

  // ── 값 ──
  function lerpKeys(times, values, t) {
    const n = times.length;
    if (n === 1 || t <= times[0]) return values[0];
    if (t >= times[n - 1]) return values[n - 1];
    let i = 1;
    while (i < n && times[i] < t) i++;
    const a = times[i - 1], b = times[i], k = b > a ? (t - a) / (b - a) : 0;
    const va = values[i - 1], vb = values[i];
    if (typeof va === "number") return va + (vb - va) * k;
    const out = new Array(va.length);
    for (let j = 0; j < va.length; j++) out[j] = va[j] + (vb[j] - va[j]) * k;
    return out;
  }
  // 값 v 를 t(0~1) 에서. 없으면 def. 확률표가 있으면 rnd 를 곱한다(rnd: 성분마다 0~1, 없으면 그 자리에서 뽑는다)
  function ev(v, t, def, rnd) {
    if (!v) return def;
    let x = v.t ? lerpKeys(v.t, v.v, t) : v.c != null ? v.c : def;
    if (x == null) return def;
    if (v.r) {
      if (typeof x === "number") {
        const r = v.r[0];
        if (r) x *= lerpKeys(r[0], r[1], rnd ? rnd[0] : Math.random());
      } else {
        x = x.slice();
        for (let j = 0; j < x.length; j++) {
          const r = v.r[j];
          if (r) x[j] *= lerpKeys(r[0], r[1], rnd ? rnd[j] : Math.random());
        }
      }
    }
    return x;
  }
  // 파티클 나이에 따라 바뀌는 값(확률표 없음)
  const life = (v, t, def) => (!v ? def : v.t ? lerpKeys(v.t, v.v, t) : v.c != null ? v.c : def);

  // ── 벡터·회전(롤 좌표) ──
  const v3 = (x, y, z) => [x, y, z];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Y 축(위) 으로 돌리기: 앞(+z) 이 (sin, 0, cos) 로
  const yaw = (p, s, c) => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  // 투사체에 붙은 이펙트의 축: 롤은 투사체 이펙트를 X 오른쪽 · Y 날아가는 쪽 · Z 위 로 만든다
  // (니달리 창·애쉬 화살 메시, 꼬리가 -Y 로 뻗는 브랜드·모르가나 메시, 럭스 Q 바닥 빛(0, -260, -120) 이 투사체 뒤 바닥).
  // 그래서 투사체 이펙트는 Y 와 Z 를 바꿔 읽는다. 장판·시전·맞음 이펙트는 Y 가 위 그대로
  const misAxes = p => [p[0], p[2], p[1]];
  // 이 시스템의 로컬 벡터 → 롤 세상 방향(붙은 것의 방향으로 돌린다)
  const toWorld = (inst, p) => yaw(inst.mis ? misAxes(p) : p, inst.sin, inst.cos);
  // 오일러 각(도) → 3×3 행렬(열: X, Y, Z 축). 롤 스타일 Y·X·Z 순
  function euler(r) {
    const x = r[0] * D2R, y = r[1] * D2R, z = r[2] * D2R;
    const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
    // R = Ry · Rx · Rz
    return [
      [cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz],
      [-cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz],
      [sy * cx, -sx, cy * cx],
    ];
  }
  const mv = (m, p) => [m[0][0] * p[0] + m[1][0] * p[1] + m[2][0] * p[2],
                        m[0][1] * p[0] + m[1][1] * p[1] + m[2][1] * p[2],
                        m[0][2] * p[0] + m[1][2] * p[1] + m[2][2] * p[2]];
  // 축 axis 둘레로 deg 만큼(로드리게스)
  function around(p, axis, deg) {
    const a = norm(axis), t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
    const d = a[0] * p[0] + a[1] * p[1] + a[2] * p[2], x = cross(a, p);
    return [p[0] * c + x[0] * s + a[0] * d * (1 - c), p[1] * c + x[1] * s + a[1] * d * (1 - c), p[2] * c + x[2] * s + a[2] * d * (1 - c)];
  }

  // ── 자료 ──
  let FX = null, BASE = "";
  const ready = [];
  function load(base) {
    if (FX) return Promise.resolve(FX);
    BASE = base;
    return fetch(base + "fx.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(j => {
      FX = j;
      ready.forEach(f => f());
      return FX;
    });
  }
  const skillFx = name => (FX && FX.skills[name]) || null;
  // 적 스킬(FX.skills) 이 쓰는 텍스처 번호 전부: 시전·투사체·적중 시스템과 그 자식 시스템까지 따라가며
  // dodge-gl.js drawVfx 가 묶는 것(기본·색·곱하기·침식·팔레트) 을 모은다
  function skillTextures() {
    if (!FX) return [];
    const seen = new Set(), tex = new Set();
    const walk = name => {
      if (seen.has(name) || !FX.systems[name]) return;
      seen.add(name);
      for (const e of FX.systems[name].emitters) {
        for (const i of [e.texture, e.particleColorTexture, e.textureMult && e.textureMult.textureMult,
                         e.alphaErosionDefinition && e.alphaErosionDefinition.erosionMapName,
                         e.paletteDefinition && e.paletteDefinition.paletteTexture]) if (i != null) tex.add(i);
        if (e.childParticleSetDefinition) (e.childParticleSetDefinition.kids || []).forEach(walk);
      }
    };
    for (const sk of Object.values(FX.skills)) for (const names of Object.values(sk)) [].concat(names).forEach(walk);
    return [...tex];
  }
  // 뼈대 메시(자이라 E 덩굴, 초가스 Q 가시): tools/lol_vfx.py 가 애니메이션을 프레임마다 정점 위치로 구워 둔 것(skin/<이름>.bin).
  // 받기 전에는 그 발생기를 그리지 않는다
  function loadSkin(m) {
    if (m.ld) return m.ld;
    m.ld = fetch(BASE + "skin/" + m.skin + ".bin").then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(buf => {
      const h = new DataView(buf);
      const nv = h.getUint32(8, true), ni = h.getUint32(12, true), nf = h.getUint32(16, true), fps = h.getFloat32(20, true), q = h.getFloat32(24, true);
      let o = 28;
      const idx = new Uint16Array(buf, o, ni);
      o = (o + ni * 2 + 3) & ~3;
      const uv = new Float32Array(buf, o, nv * 2);
      const raw = new Int16Array(buf, o + nv * 8, nf * nv * 3);
      // 삼각형마다 3정점으로 펼친다(정적 메시와 같은 모양)
      const U = new Float32Array(ni * 2);
      for (let k = 0; k < ni; k++) { U[k * 2] = uv[idx[k] * 2]; U[k * 2 + 1] = uv[idx[k] * 2 + 1]; }
      Object.assign(m, { uv: U, idx, raw, nv, nf, fps, q, tmp: new Float32Array(ni * 3) });
    }).catch(() => { m.bad = true; });
    return m.ld;
  }
  const loadSkins = () => Promise.all(FX ? FX.meshes.filter(m => m.skin).map(loadSkin) : []);
  // 파티클 나이 age 의 정점 위치(앞뒤 프레임 사이를 잇는다). 애니메이션이 끝나면 마지막 프레임에 선다
  function skinAt(m, age) {
    const fa = Math.min(m.nf - 1, Math.max(0, age * m.fps)), f0 = Math.floor(fa), f1 = Math.min(m.nf - 1, f0 + 1), k = fa - f0;
    const a = f0 * m.nv * 3, b = f1 * m.nv * 3, R = m.raw, I = m.idx, P = m.tmp, q = m.q;
    for (let i = 0; i < I.length; i++) {
      const v = I[i] * 3;
      for (let c = 0; c < 3; c++) P[i * 3 + c] = (R[a + v + c] + (R[b + v + c] - R[a + v + c]) * k) * q;
    }
    return P;
  }
  // 내 챔피언 이펙트(dodge/vfx/mine/<챔피언>.json): 시스템·메시를 합쳐 두고 칸별 이펙트를 돌려준다
  const mine = new Map();
  function loadMine(champ) {
    const key = String(champ).toLowerCase();
    if (mine.has(key)) return mine.get(key);
    const p = new Promise(ok => (FX ? ok() : ready.push(ok))).then(() => fetch(BASE + "mine/" + key + ".json"))
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(j => {
        const off = FX.meshes.length;
        FX.meshes.push(...j.meshes);
        for (const [name, sys] of Object.entries(j.systems)) {
          if (FX.systems[name]) continue;
          for (const e of sys.emitters) if (e.primitive && e.primitive.mesh != null) e.primitive.mesh += off;
          FX.systems[name] = sys;
        }
        return j.slots;
      });
    p.catch(() => mine.delete(key));
    mine.set(key, p);
    return p;
  }

  // ── 재생 중인 시스템 ──
  const live = [];
  // name: 시스템 경로. o: { x, y, h(바닥 좌표·높이), dir: {x, y}(바닥에서 앞), target: {x, y, h}(빔 끝), scale }
  // o.gain: 밝기 배율(색에 곱한다. 적 스킬을 잘 보이게)
  function play(name, o = {}) {
    if (!FX || !FX.systems[name]) return null;
    const s = FX.systems[name];
    const inst = { s, name, age: 0, stopped: false, done: false, scale: o.scale || 1, ems: [], odom: 0, gain: o.gain || 0, mis: !!o.missile,
                   hold: !!(o.hold || o.missile), squash: o.squash || 0 };
    // 몸에 붙이는 이펙트(o.center = 몸 가운데 높이): 롤이 몸 가운데 뼈(Buffbone Center) 에 붙이게 만든 것은 그 높이로 올린다
    if (o.center) { const L = attachLift(s); inst.hOff = L > 0 ? L : L < 0 ? o.center : 0; }
    place(inst, o);
    if (!inst.pos) inst.pos = [0, 0, 0];      // 자식 시스템은 자리 없이 켜고 바로 부모 파티클 자리로 옮긴다
    inst.prev = inst.pos.slice();
    // acc 1: 켜지자마자(timeBeforeFirstEmission 뒤 첫 걸음) 첫 파티클을 낸다. 0 이면 1초에 1개·발생기 1초 같은
    // '하나만 내는' 발생기(시비르 E 구 빛·아무무 Q 적중 고리 …) 가 발생기가 끝날 때까지 하나도 못 냈다
    for (const e of s.emitters) inst.ems.push({ e, age: 0, acc: 1, ps: [], single: false, emitted: 0, path: 0 });
    live.push(inst);
    return inst;
  }
  // 롤 좌표로 옮겨 둔다
  function place(inst, o) {
    if (o.x != null) inst.pos = [o.x, (o.h || 0) + (inst.hOff || 0), -(o.y || 0)];
    if (o.dir) {
      const dx = o.dir.x, dz = -o.dir.y, l = Math.hypot(dx, dz) || 1;
      inst.sin = dx / l; inst.cos = dz / l;
    } else if (inst.sin == null) { inst.sin = 0; inst.cos = 1; }
    if (o.target) inst.target = [o.target.x, o.target.h || 0, -o.target.y];
  }
  function move(inst, o) { if (inst) place(inst, o); }
  // 이 시스템이 어디에 붙게 만들어졌나. 양수: 그만큼 위(바닥층 발생기를 그만큼 내려 둠 — 럭스 W 보호막의 바닥 빛 -95),
  // -1: 몸 가운데(구·큰 빛이 원점 가운데 — 카사딘 Q·오리아나 E·리 신 W 보호막 구), 0: 발밑(다이애나 W·리븐 E 처럼 바닥부터 그린 것)
  function attachLift(s) {
    if (s.lift != null) return s.lift;
    let ground = 0, high = false, round = false;
    for (const e of s.emitters) {
      const eo = e.SpawnShape && ev(e.SpawnShape.emitOffset, 0, null), ep = ev(e.EmitterPosition, 0, null);
      const y = (Array.isArray(eo) && eo.length === 3 ? eo[1] : 0) + (Array.isArray(ep) ? ep[1] : 0);
      if (e.isGroundLayer && y < -20) ground = Math.max(ground, -y);
      if (y >= 60) high = true;
      const T = e.primitive && e.primitive.T, sv = ev(e.birthScale0, 0, [1, 1, 1]), sc = Array.isArray(sv) ? sv : [sv, sv, sv];
      if (T === "VfxPrimitiveMesh" && FX.meshes[e.primitive.mesh] && FX.meshes[e.primitive.mesh].pos) {
        const m = FX.meshes[e.primitive.mesh];
        if (m.yMin == null) { let a = Infinity, b = -Infinity; for (let i = 1; i < m.pos.length; i += 3) { a = Math.min(a, m.pos[i]); b = Math.max(b, m.pos[i]); } m.yMin = a; m.yMax = b; }
        const lo = y + m.yMin * sc[1], hi = y + m.yMax * sc[1];
        if (lo < -40 && hi > 40 && Math.abs(lo + hi) < 0.3 * (hi - lo)) round = true;
      } else if (!T && Math.abs(y) < 30 && sc[0] >= 80) round = true;
    }
    s.lift = ground > 0 ? ground : round && !high ? -1 : 0;
    return s.lift;
  }
  // 그만 뿜는다. 남은 파티클은 particleLinger 만큼 더 산다
  function stop(inst) {
    if (!inst || inst.stopped) return;
    inst.stopped = true;
    for (const em of inst.ems) {
      const lg = em.e.particleLinger || 0;
      for (const p of em.ps) p.die = Math.min(p.die, p.age + lg);
    }
  }
  function kill(inst) { if (inst) { inst.stopped = true; inst.done = true; } }

  const HOLD_MAX = 4;
  // ── 한 걸음 ──
  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const inst = live[i];
      step(inst, dt);
      if (inst.done) live.splice(i, 1);
    }
  }
  function step(inst, dt) {
    inst.age += dt;
    if (inst.ttl && inst.age > inst.ttl) stop(inst);        // 주인이 잊은 이펙트는 저절로 끈다
    if (inst.until != null && inst.age > inst.until) { kill(inst); return; }   // 남은 파티클까지 이 나이에 지운다(CC 가 풀린 적중 이펙트)
    const moved = [inst.pos[0] - inst.prev[0], inst.pos[1] - inst.prev[1], inst.pos[2] - inst.prev[2]];
    inst.odom += len(moved);
    inst.prev = inst.pos.slice();
    let alive = false;
    for (const em of inst.ems) {
      const e = em.e;
      em.age += dt;
      const t0 = e.timeBeforeFirstEmission || 0;
      const L = e.lifetime;
      const active = !inst.stopped && em.age >= t0 && (L == null || em.age < t0 + L);
      const frac = L ? Math.min(1, Math.max(0, (em.age - t0) / L)) : 0;
      if (active) {
        if (e.isSingleParticle) {
          if (!em.single) {
            em.single = true;
            const n = Math.max(1, Math.round(ev(e.rate, 0, 1)));
            for (let k = 0; k < n; k++) spawn(inst, em, frac);
          }
        } else {
          const rate = Math.max(0, ev(e.rate, frac, 0));
          em.acc += rate * (rate > DENSE_RATE ? density : 1) * dt;
          let guard = 0;
          while (rate > 0 && em.acc >= 1 && guard++ < 200) { em.acc -= 1; spawn(inst, em, frac); }
        }
      } else if (e.isSingleParticle && em.single && !em.ended && (inst.stopped || (L != null && em.age >= t0 + L))) {
        // 하나뿐인 파티클은 발생기가 끝나면 linger 만큼 남는다. 단 수명(particleLifetime) 이 적힌 것은 발생기보다 오래 산다:
        // 롤 데이터는 발생기 1초·파티클 2.7~3.85초(럭스 W·오리아나 E 보호막 구), 0.1초·50초(애쉬 R 화살 빛) 처럼 파티클 수명이 보이는 시간이다.
        // 켜 둘 시간이 정해진 것(버프·투사체, hold) 은 꺼질 때까지, 그냥 켠 것은 수명이 짧을 때(HOLD_MAX 초 안) 만 다 산다
        em.ended = true;
        const lg = e.particleLinger || 0;
        for (const p of em.ps) {
          if (!inst.stopped && e.particleLifetime != null && (inst.hold || p.life <= HOLD_MAX)) continue;
          p.die = Math.min(p.die, p.age + lg);
        }
      }
      // 파티클
      for (let j = em.ps.length - 1; j >= 0; j--) {
        const p = em.ps[j];
        p.age += dt;
        if (p.age >= p.die) {
          if (e.childParticleSetDefinition && e.childParticleSetDefinition.onDeath) child(inst, e, p);
          em.ps.splice(j, 1);
          continue;
        }
        const f = Math.min(1, p.age / p.life);
        p.f = f;
        // 발생기를 따라가기(bindWeight)
        if (p.bind) { p.pos[0] += moved[0] * p.bind; p.pos[1] += moved[1] * p.bind; p.pos[2] += moved[2] * p.bind; }
        // 속도: 끌림·가속
        if (p.drag) {
          p.vel[0] *= Math.exp(-p.drag[0] * dt); p.vel[1] *= Math.exp(-p.drag[1] * dt); p.vel[2] *= Math.exp(-p.drag[2] * dt);
        }
        if (p.acc) { p.vel[0] += p.acc[0] * dt; p.vel[1] += p.acc[1] * dt; p.vel[2] += p.acc[2] * dt; }
        if (e.worldAcceleration) {
          const a = life(e.worldAcceleration, f, [0, 0, 0]);
          p.vel[0] += a[0] * dt; p.vel[1] += a[1] * dt; p.vel[2] += a[2] * dt;
        }
        let vx = p.vel[0], vy = p.vel[1], vz = p.vel[2];
        if (e.velocity) { const v = life(e.velocity, f, [0, 0, 0]); const w = p.local ? toWorld(inst, v) : v; vx += w[0]; vy += w[1]; vz += w[2]; }
        p.pos[0] += vx * dt; p.pos[1] += vy * dt; p.pos[2] += vz * dt;
        p.v = [vx, vy, vz];
        // 발생기 둘레로 돌기(도/초)
        if (p.orbit) {
          const c = p.bind ? inst.pos : p.origin;
          let rel = [p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]];
          if (p.orbit[0]) rel = around(rel, [1, 0, 0], p.orbit[0] * dt);
          if (p.orbit[1]) rel = around(rel, [0, 1, 0], p.orbit[1] * dt);
          if (p.orbit[2]) rel = around(rel, [0, 0, 1], p.orbit[2] * dt);
          p.pos = [c[0] + rel[0], c[1] + rel[1], c[2] + rel[2]];
        }
        // 회전
        if (p.spin) { p.rot[0] += p.spin[0] * dt; p.rot[1] += p.spin[1] * dt; p.rot[2] += p.spin[2] * dt; }
        if (e.rotation0) { const r = life(e.rotation0, f, [0, 0, 0]); p.rot[0] += r[0] * dt; p.rot[1] += r[1] * dt; p.rot[2] += r[2] * dt; }
        if (e.particleUVScrollRate) { const s = life(e.particleUVScrollRate, f, [0, 0]); p.scroll[0] += s[0] * dt; p.scroll[1] += s[1] * dt; }
        if (p.uvSpin) p.uvRot += p.uvSpin * dt;
      }
      if (em.ps.length) alive = true;
      if (!inst.stopped && (L == null || em.age < t0 + L)) alive = true;
    }
    if (!alive) inst.done = true;
  }

  // 파티클 밀도(1 = 롤 그대로). 화면이 느릴 때 dodge.js 가 낮춘다. 1초에 DENSE_RATE 개 넘게 뿜는 발생기(불티·연기 줄기) 만
  // 덜 뿜고, 한 번만 나오는 것·드문 것(메시·본체) 은 그대로 둔다
  let density = 1;
  const DENSE_RATE = 10;

  // 파티클 하나를 낳는다
  function spawn(inst, em, frac) {
    const e = em.e, sc = inst.scale;
    const local = e.isLocalOrientation !== false;
    const turn = p => (local ? toWorld(inst, p) : p);
    // 자리: 발생기 위치 + 모양 안의 한 점
    let off = ev(e.EmitterPosition, frac, [0, 0, 0]);
    let vel = ev(e.birthVelocity, frac, [0, 0, 0]);
    const sh = e.SpawnShape;
    if (sh) {
      let o = [0, 0, 0];
      if (Array.isArray(sh.emitOffset)) o = sh.emitOffset.slice();
      else if (sh.emitOffset) o = ev(sh.emitOffset, frac, [0, 0, 0]);
      if (sh.T === "VfxShapeSphere") {
        const r = sh.radius || 0, u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const k = r * Math.cbrt(Math.random());
        o = [s * Math.cos(a) * k, u * k, s * Math.sin(a) * k];
      } else if (sh.T === "VfxShapeCylinder") {
        const r = sh.radius || 0, a = Math.random() * Math.PI * 2, k = r * Math.sqrt(Math.random());
        o = [Math.cos(a) * k, Math.random() * (sh.height || 0), Math.sin(a) * k];
      } else if (sh.T === "VfxShapeBox") {
        const s = sh.Size || [0, 0, 0];
        o = [(Math.random() - 0.5) * s[0], (Math.random() - 0.5) * s[1], (Math.random() - 0.5) * s[2]];
      }
      // 옛 모양: 각 축 둘레로 돌린다(자리와 속도 모두)
      if (sh.emitRotationAngles && sh.emitRotationAxes) {
        sh.emitRotationAngles.forEach((ang, k) => {
          const deg = ev(ang, frac, 0), ax = sh.emitRotationAxes[k];
          if (deg && ax) { o = around(o, ax, deg); vel = around(vel, ax, deg); }
        });
      }
      off = add(off, o);
    }
    off = mul(off, sc);
    const pos = add(inst.pos, turn(off));
    // 수명
    let pl = ev(e.particleLifetime, frac, 3);
    if (!(pl > 0)) pl = Infinity;
    const scale = ev(e.birthScale0, frac, [1, 1, 1]).map(v => v * sc);
    if (e.isUniformScale) { scale[1] = scale[0]; scale[2] = scale[0]; }
    const flip = e.texDiv ? Math.round(e.texDiv[0] * e.texDiv[1]) : 1;
    // numFrames 가 없으면 롤 기본값 1: 칸을 넘기지 않고 startFrame 칸만 쓴다(제드 R 소용돌이가 둥근 덩어리 칸으로 넘어가던 것)
    const nFrames = e.numFrames || 1;
    let frame0 = e.startFrame || 0;
    if (e.isRandomStartFrame) frame0 = Math.floor(Math.random() * (e.numFrames || flip));
    const p = {
      age: 0, life: pl, die: pl, f: 0,
      pos, origin: inst.pos.slice(), vel: turn(vel), v: [0, 0, 0], local,
      bind: e.isEmitterSpace ? 1 : ev(e.bindWeight, frac, 0),
      drag: e.birthDrag || e.drag ? ev(e.birthDrag || e.drag, frac, [0, 0, 0]) : null,
      acc: e.birthAcceleration ? turn(ev(e.birthAcceleration, frac, [0, 0, 0])) : null,
      orbit: e.birthOrbitalVelocity ? ev(e.birthOrbitalVelocity, frac, null) : null,
      rot: ev(e.birthRotation0, frac, [0, 0, 0]).slice(),
      spin: e.birthRotationalVelocity0 ? ev(e.birthRotationalVelocity0, frac, [0, 0, 0]) : null,
      scale, color: ev(e.birthColor, frac, [1, 1, 1, 1]),
      frame0, nFrames, frameRate: (e.frameRate || 0) * ev(e.birthFrameRate, frac, 1),
      uvOff: ev(e.birthUVOffset, frac, [0, 0]).slice(), scroll: [0, 0],
      uvScroll: ev(e.birthUvScrollRate, frac, [0, 0]),
      uvRot: 0, uvSpin: e.birthUvRotateRate ? ev(e.birthUvRotateRate, frac, 0) : 0,
      dist: inst.odom,
      tile: null,
    };
    if (p.orbit && !p.orbit.some(Boolean)) p.orbit = null;
    if (p.spin && !p.spin.some(Boolean)) p.spin = null;
    const prim = e.primitive;
    if (prim && (prim.mTrail || prim.mBeam)) {
      const ts = (prim.mTrail || prim.mBeam).mBirthTilingSize;
      p.tile = ev(ts, frac, [0, 0, 0]);
    }
    if (e.textureMult) {
      const m = e.textureMult;
      p.multOff = ev(m.birthUVOffsetMult, frac, [0, 0]).slice();
      p.multScroll = ev(m.birthUvScrollRateMult || m.birthUVScrollRateMult, frac, [0, 0]);
    }
    em.ps.push(p);
    em.emitted++;
  }

  // 파티클이 죽을 때 자식 시스템(childEmitOnDeath)
  function child(inst, e, p) {
    const c = e.childParticleSetDefinition;
    if (ev(c.chance, 0, 1) < Math.random()) return;
    for (const k of c.kids) {
      const ci = play(k, { scale: inst.scale });
      if (ci) { ci.pos = p.pos.slice(); ci.prev = ci.pos.slice(); ci.sin = inst.sin; ci.cos = inst.cos; ci.target = inst.target; ci.gain = inst.gain; ci.mis = inst.mis; ci.hold = inst.hold; }
    }
  }

  // ── 그리기 자료 ──
  // 카메라(롤 좌표): 오른쪽 R, 화면 위 U, 카메라 자리 C. cam 은 dodge.js 의 투영 값
  function camera(cam) {
    return { R: [1, 0, 0], U: [0, cam.COS, cam.SIN], C: [cam.W2, cam.CAM_D * cam.SIN, -(cam.H2 + cam.CAM_D * cam.COS)] };
  }

  // 정점: 위치 3(롤 좌표), uv 2, 색 4, [프레임, 색 조회 u, 침식 문턱, 0] 4, 곱 텍스처 uv 2 = 15
  const VF = 15;
  // 발생기 하나 → 삼각형 정점 배열(out 에 덧붙인다). 돌려주는 값: 정점 수
  function build(inst, em, cam, out) {
    const e = em.e, prim = e.primitive || {}, T = prim.T;
    const ps = em.ps;
    if (!ps.length) return 0;
    let n = 0;
    const put = (P, uv, col, x, mu) => {
      const f = room(out, 1), i = out.n * VF;
      f[i] = P[0]; f[i + 1] = P[1]; f[i + 2] = P[2]; f[i + 3] = uv[0]; f[i + 4] = uv[1];
      f[i + 5] = col[0]; f[i + 6] = col[1]; f[i + 7] = col[2]; f[i + 8] = col[3];
      // 곱하기 텍스처 UV: 기본 텍스처의 UV 변환(무작위 오프셋·흐름·회전) 을 따르지 않고 변환 전 UV 에 자기 배율·오프셋만
      const r = uv.raw || uv;
      f[i + 9] = x[0]; f[i + 10] = x[1]; f[i + 11] = x[2]; f[i + 12] = 0;
      f[i + 13] = mu ? r[0] * mu[2] + mu[0] : 0; f[i + 14] = mu ? r[1] * mu[3] + mu[1] : 0;
      out.n++; n++;
    };
    const tri = (a, b, c) => { put(...a); put(...b); put(...c); };
    const quad = (v0, v1, v2, v3) => { tri(v0, v1, v2); tri(v0, v2, v3); };
    const cs = camera(cam);

    if (T === "VfxPrimitiveCameraTrail" || T === "VfxPrimitiveArbitraryTrail") {
      // 리본: 새 파티클(머리) → 옛 파티클(꼬리)
      const pts = ps.slice().reverse();
      if (pts.length < 2) return 0;
      const tr = prim.mTrail || {};
      let walked = 0;
      const cut = tr.mCutoff > 0 ? tr.mCutoff : Infinity;
      const rows = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (i > 0) walked += len([p.pos[0] - pts[i - 1].pos[0], p.pos[1] - pts[i - 1].pos[1], p.pos[2] - pts[i - 1].pos[2]]);
        if (walked > cut && i > 1) break;
        const a = pts[Math.max(0, i - 1)].pos, b = pts[Math.min(pts.length - 1, i + 1)].pos;
        const dir = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        let side;
        if (T === "VfxPrimitiveArbitraryTrail") {
          side = norm(toWorld(inst, mv(euler(p.rot), [1, 0, 0])));
        } else {
          const toCam = norm([cs.C[0] - p.pos[0], cs.C[1] - p.pos[1], cs.C[2] - p.pos[2]]);
          side = norm(cross(dir, toCam));
        }
        const s = scaleOf(e, p), col = colorOf(e, p), w = s[0];
        if (inst.gain) { col[0] *= inst.gain; col[1] *= inst.gain; col[2] *= inst.gain; }
        const tx = p.tile ? p.tile[0] : 0;
        const u = tx > 0 ? (tr.mMode ? p.dist : walked) / tx : 0;
        rows.push({ L: add(p.pos, mul(side, w)), Rr: add(p.pos, mul(side, -w)), u, col, x: extra(e, p) });
      }
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const ua = uvT(e, ps[0], [a.u, 0]), ub = uvT(e, ps[0], [b.u, 0]), ua1 = uvT(e, ps[0], [a.u, 1]), ub1 = uvT(e, ps[0], [b.u, 1]);
        quad([a.L, ua, a.col, a.x], [b.L, ub, b.col, b.x], [b.Rr, ub1, b.col, b.x], [a.Rr, ua1, a.col, a.x]);
      }
      return n;
    }

    for (const p of ps) {
      const s = scaleOf(e, p), col = colorOf(e, p), x = extra(e, p);
      if (col[3] <= 0.002) continue;
      if (inst.gain) { col[0] *= inst.gain; col[1] *= inst.gain; col[2] *= inst.gain; }
      const mu = e.textureMult ? multUv(e, p) : null;
      if (T === "VfxPrimitiveBeam") {
        if (!inst.target) continue;
        const bm = prim.mBeam || {};
        const so = bm.mLocalSpaceSourceOffset ? toWorld(inst, bm.mLocalSpaceSourceOffset) : [0, 0, 0];
        const to = bm.mLocalSpaceTargetOffset ? toWorld(inst, bm.mLocalSpaceTargetOffset) : [0, 0, 0];
        const A = add(inst.pos, so), B = add(inst.target, to), AB = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const L = len(AB);
        if (L < 1) continue;
        const dir = mul(AB, 1 / L);
        if (prim.mesh != null) {
          // 메시 빔(쓰레쉬 Q 사슬): 메시의 Z 축을 빔 방향으로, 위는 세상 위. 메시 길이(Z) 만큼씩 이어 붙여 빔을 채운다(엔진의 배치는 미확인)
          const m = FX.meshes[prim.mesh];
          if (!m) continue;
          if (m.zMin == null) { let a = Infinity, b = -Infinity; for (let i = 2; i < m.pos.length; i += 3) { a = Math.min(a, m.pos[i]); b = Math.max(b, m.pos[i]); } m.zMin = a; m.zMax = b; }
          const mlen = Math.max(1, m.zMax - m.zMin), cnt = Math.max(1, Math.round(L / (mlen * s[0]))), kz = L / (cnt * mlen);
          const up0 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
          const xa = norm(cross(up0, dir)), ya = cross(dir, xa);
          const P = m.pos, U = m.uv, nv = P.length / 3;
          const o0 = uvT(e, p, [0, 0]), o1 = uvT(e, p, [1, 0]), o2 = uvT(e, p, [0, 1]);
          for (let c = 0; c < cnt; c++) {
            const f = room(out, nv), bx = A[0] + dir[0] * c * L / cnt, by = A[1] + dir[1] * c * L / cnt, bz = A[2] + dir[2] * c * L / cnt;
            let i = out.n * VF;
            for (let k = 0; k < nv; k++, i += VF) {
              const lx = P[k * 3] * s[0], ly = P[k * 3 + 1] * s[0], lz = (P[k * 3 + 2] - m.zMin) * kz, u = U[k * 2], v = U[k * 2 + 1];
              f[i] = bx + xa[0] * lx + ya[0] * ly + dir[0] * lz;
              f[i + 1] = by + xa[1] * lx + ya[1] * ly + dir[1] * lz;
              f[i + 2] = bz + xa[2] * lx + ya[2] * ly + dir[2] * lz;
              f[i + 3] = o0[0] + (o1[0] - o0[0]) * u + (o2[0] - o0[0]) * v;
              f[i + 4] = o0[1] + (o1[1] - o0[1]) * u + (o2[1] - o0[1]) * v;
              f[i + 5] = col[0]; f[i + 6] = col[1]; f[i + 7] = col[2]; f[i + 8] = col[3];
              f[i + 9] = x[0]; f[i + 10] = x[1]; f[i + 11] = x[2]; f[i + 12] = 0; f[i + 13] = mu ? u * mu[2] + mu[0] : 0; f[i + 14] = mu ? v * mu[3] + mu[1] : 0;
            }
            out.n += nv; n += nv;
          }
          continue;
        }
        const y = s[1] > 0 && s[1] < 1 ? s[1] : 0, z = s[2] > 0 && s[2] < 1 ? s[2] : 0;
        const A2 = add(A, mul(AB, y)), B2 = add(B, mul(AB, -z));
        let side;
        if (bm.mMode === 1) side = norm(cross([0, 1, 0], dir));
        else side = norm(cross(dir, norm([cs.C[0] - A[0], cs.C[1] - A[1], cs.C[2] - A[2]])));
        const hw = s[0] / 2;
        const tl = p.tile || [0, 0, 0];
        const rw = tl[0] > 0 ? s[0] / tl[0] : 1, rl = tl[1] > 0 ? L / tl[1] : 1;
        // 텍스처는 v 가 빔을 따라(uv 변환은 빔 방향이 첫 축)
        const uvb = (a, b) => { const q = uvT(e, p, [a * rl, b * rw]), r = [q[1], q[0]]; r.raw = [b, a]; return r; };
        quad([add(A2, mul(side, hw)), uvb(y, 0), col, x, mu], [add(B2, mul(side, hw)), uvb(1 - z, 0), col, x, mu],
             [add(B2, mul(side, -hw)), uvb(1 - z, 1), col, x, mu], [add(A2, mul(side, -hw)), uvb(y, 1), col, x, mu]);
        continue;
      }
      const ori = orientation(inst, e, p);
      if (T === "VfxPrimitiveMesh" || T === "VfxPrimitiveAttachedMesh") {
        const m = FX.meshes[prim.mesh];
        if (!m) continue;
        if (m.skin && !m.raw) { if (!m.bad) loadSkin(m); continue; }
        const P = m.skin ? skinAt(m, p.age) : m.pos, U = m.uv, nv = P.length / 3, f = room(out, nv);
        const [a, b, c] = ori, px = p.pos[0], py = p.pos[1], pz = p.pos[2];
        // UV 는 한 번에 같은 변환이라 (0,0)·(1,0)·(0,1) 세 점으로 아핀 변환을 구해 쓴다
        const o0 = uvT(e, p, [0, 0]), o1 = uvT(e, p, [1, 0]), o2 = uvT(e, p, [0, 1]);
        const mu0 = mu ? mu[0] : 0, mu1 = mu ? mu[1] : 0, mk0 = mu ? mu[2] : 0, mk1 = mu ? mu[3] : 0;
        let i = out.n * VF;
        for (let k = 0; k < nv; k++, i += VF) {
          const lx = P[k * 3] * s[0], ly = P[k * 3 + 1] * s[1], lz = P[k * 3 + 2] * s[2], u = U[k * 2], v = U[k * 2 + 1];
          f[i] = px + a[0] * lx + b[0] * ly + c[0] * lz;
          f[i + 1] = py + a[1] * lx + b[1] * ly + c[1] * lz;
          f[i + 2] = pz + a[2] * lx + b[2] * ly + c[2] * lz;
          f[i + 3] = o0[0] + (o1[0] - o0[0]) * u + (o2[0] - o0[0]) * v;
          f[i + 4] = o0[1] + (o1[1] - o0[1]) * u + (o2[1] - o0[1]) * v;
          f[i + 5] = col[0]; f[i + 6] = col[1]; f[i + 7] = col[2]; f[i + 8] = col[3];
          f[i + 9] = x[0]; f[i + 10] = x[1]; f[i + 11] = x[2]; f[i + 12] = 0; f[i + 13] = u * mk0 + mu0; f[i + 14] = v * mk1 + mu1;
        }
        out.n += nv; n += nv;
        continue;
      }
      if (T === "VfxPrimitiveRay") {
        const axis = norm(mv(ori, [0, 0, 1]));
        const near = add(p.pos, mul(axis, s[2])), far = add(p.pos, mul(axis, s[2] + s[1]));
        const toCam = norm([cs.C[0] - p.pos[0], cs.C[1] - p.pos[1], cs.C[2] - p.pos[2]]);
        const side = mul(norm(cross(axis, toCam)), s[0] / 2);
        quad([add(near, side), uvT(e, p, [0, 1]), col, x, mu], [add(far, side), uvT(e, p, [0, 0]), col, x, mu],
             [add(far, mul(side, -1)), uvT(e, p, [1, 0]), col, x, mu], [add(near, mul(side, -1)), uvT(e, p, [1, 1]), col, x, mu]);
        continue;
      }
      let X, Y;
      if (T === "VfxPrimitiveArbitraryQuad" || T === "VfxPrimitivePlanarProjection") {
        // 입자 자신의 X·Y 축 평면. 아무 회전 없으면 선 판(앞 +Z), [90,0,0] 이면 바닥에 눕는다
        X = mv(ori, [1, 0, 0]); Y = mv(ori, [0, 1, 0]);
        if (T === "VfxPrimitivePlanarProjection") { X = [1, 0, 0]; Y = [0, 0, 1]; }
        const c = (sx, sy) => add(p.pos, add(mul(X, sx * s[0]), mul(Y, sy * s[1])));
        // u = y + 0.5(+Y 쪽), v = 0.5 - x
        quad([c(-1, 1), uvT(e, p, [1, 1]), col, x, mu], [c(1, 1), uvT(e, p, [1, 0]), col, x, mu],
             [c(1, -1), uvT(e, p, [0, 0]), col, x, mu], [c(-1, -1), uvT(e, p, [0, 1]), col, x, mu]);
        continue;
      }
      // 카메라 판(기본): 화면 오른쪽·위 축, X 회전만큼 돈다. 움직이는 쪽으로 세우면(isDirectionOriented) 그 방향이 위
      if (e.isDirectionOriented && len(p.v) > 0.01) {
        const toCam = norm([cs.C[0] - p.pos[0], cs.C[1] - p.pos[1], cs.C[2] - p.pos[2]]);
        Y = norm(p.v);
        X = norm(cross(Y, toCam));
        const st = e.directionVelocityScale ? Math.max(e.directionVelocityMinScale || 1, len(p.v) * e.directionVelocityScale) : 1;
        const c = (sx, sy) => add(p.pos, add(mul(X, sx * s[0]), mul(Y, sy * s[1] * st)));
        quad([c(-1, 1), uvT(e, p, [0, 0]), col, x, mu], [c(1, 1), uvT(e, p, [1, 0]), col, x, mu],
             [c(1, -1), uvT(e, p, [1, 1]), col, x, mu], [c(-1, -1), uvT(e, p, [0, 1]), col, x, mu]);
        continue;
      }
      const roll = Math.trunc(p.rot[0]) * D2R, cr = Math.cos(roll), sr = Math.sin(roll);
      X = add(mul(cs.R, cr), mul(cs.U, sr));
      Y = add(mul(cs.R, -sr), mul(cs.U, cr));
      const c = (sx, sy) => add(p.pos, add(mul(X, sx * s[0]), mul(Y, sy * s[1])));
      quad([c(-1, 1), uvT(e, p, [0, 0]), col, x, mu], [c(1, 1), uvT(e, p, [1, 0]), col, x, mu],
           [c(1, -1), uvT(e, p, [1, 1]), col, x, mu], [c(-1, -1), uvT(e, p, [0, 1]), col, x, mu]);
    }
    return n;
  }
  // 입자의 방향(3×3): 입자 회전, 그리고 발생기가 붙은 것의 방향(local 이면)
  function orientation(inst, e, p) {
    let m = euler(p.rot);
    if (e.isDirectionOriented && len(p.v) > 0.01) {
      // 움직이는 쪽을 +Z 로
      const z = norm(p.v), up = Math.abs(z[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
      const xx = norm(cross(up, z)), yy = cross(z, xx);
      const base = [xx, yy, z];
      return [mv(base, m[0]), mv(base, m[1]), mv(base, m[2])];
    }
    if (e.particleIsLocalOrientation !== false && e.isLocalOrientation !== false) {
      m = [toWorld(inst, m[0]), toWorld(inst, m[1]), toWorld(inst, m[2])];
    }
    return m;
  }
  function scaleOf(e, p) {
    const k = life(e.scale0, p.f, [1, 1, 1]);
    return [p.scale[0] * k[0], p.scale[1] * k[1], p.scale[2] * k[2]];
  }
  function colorOf(e, p) {
    const c = life(e.Color, p.f, [1, 1, 1, 1]), b = p.color;
    return [b[0] * c[0], b[1] * c[1], b[2] * c[2], (b[3] == null ? 1 : b[3]) * (c[3] == null ? 1 : c[3])];
  }
  // [프레임, 색 조회 u, 침식 문턱]
  function extra(e, p) {
    let fr = p.frame0;
    if (p.nFrames > 1) {
      fr = p.frameRate > 0 ? p.frame0 + Math.floor(p.age * p.frameRate) : p.frame0 + Math.floor(p.f * p.nFrames);
      fr %= p.nFrames;
    }
    const sc = e.colorLookUpScales || [1, 1], of = e.colorLookUpOffsets || [0, 0];
    const cu = p.f * sc[0] + of[0];
    const er = e.alphaErosionDefinition ? life(e.alphaErosionDefinition.erosionDriveCurve, p.f, 0) : 0;
    return [fr, cu, er];
  }
  // 입자의 UV 변환: 가운데 기준 회전·배율, 오프셋, 흐름
  function uvT(e, p, uv) {
    let u = uv[0], v = uv[1];
    if (e.TextureFlipU) u = 1 - u;
    if (e.TextureFlipV) v = 1 - v;
    const rot = (e.uvRotation ? life(e.uvRotation, p.f, 0) : 0) + p.uvRot;
    if (rot) {
      const a = rot * D2R, c = Math.cos(a), s = Math.sin(a), x = u - 0.5, y = v - 0.5;
      u = x * c - y * s + 0.5; v = x * s + y * c + 0.5;
    }
    if (e.uvScale) {
      const k = life(e.uvScale, p.f, [1, 1]);
      u = (u - 0.5) * k[0] + 0.5; v = (v - 0.5) * k[1] + 0.5;
    }
    const em = e.emitterUvScrollRate ? life(e.emitterUvScrollRate, 0, [0, 0]) : [0, 0];
    u += p.uvOff[0] + p.uvScroll[0] * p.age + p.scroll[0] + em[0] * p.age;
    v += p.uvOff[1] + p.uvScroll[1] * p.age + p.scroll[1] + em[1] * p.age;
    const out = [u, v];
    out.raw = uv;
    return out;
  }
  function multUv(e, p) {
    const m = e.textureMult, k = life(m.uvScaleMult, p.f, [1, 1]);
    const sc = m.ParticleIntegratedUvScrollMult ? life(m.ParticleIntegratedUvScrollMult, p.f, [0, 0]) : [0, 0];
    return [p.multOff[0] + p.multScroll[0] * p.age + sc[0], p.multOff[1] + p.multScroll[1] * p.age + sc[1], k[0], k[1]];
  }

  // 정점을 모으는 버퍼(프레임마다 처음부터 다시 쓴다. 모자라면 두 배로)
  const W = { f: new Float32Array(1 << 18), n: 0 };
  function room(w, k) {
    if ((w.n + k) * VF > w.f.length) {
      const g = new Float32Array(Math.max(w.f.length * 2, (w.n + k) * VF * 2));
      g.set(w.f.subarray(0, w.n * VF));
      w.f = g;
    }
    return w.f;
  }
  // 그릴 묶음: [{ e, verts(Float32Array), n, ground, add, pass }] — pass 순, 같은 pass 는 시스템 안 순서
  function batches(cam) {
    const out = [];
    W.n = 0;
    for (const inst of live) {
      inst.ems.forEach((em, k) => {
        if (!em.ps.length) return;
        const start = W.n;
        const n = build(inst, em, cam, W);
        if (!n) return;
        // squash: 붙은 자리 높이를 기준으로 위아래를 줄인다(야스오 장막처럼 롤에선 높아도 연습장 화면에선 너무 길어 보이는 것)
        if (inst.squash) {
          const f = W.f, y0 = inst.pos[1], k = inst.squash;
          for (let i = start * VF + 1, end = W.n * VF; i < end; i += VF) f[i] = y0 + (f[i] - y0) * k;
        }
        const e = em.e;
        out.push({ e, start, n, ground: !!e.isGroundLayer, add: ADDITIVE.has(e.blendMode),
                   pass: e.pass || 0, k, mesh: !!(e.primitive && (e.primitive.T || "").includes("Mesh")) });
      });
    }
    // 버퍼가 커졌을 수 있으니 다 모은 뒤에 잘라 준다
    for (const b of out) b.verts = W.f.subarray(b.start * VF, (b.start + b.n) * VF);
    out.sort((a, b) => a.pass - b.pass);
    return out;
  }

  window.DodgeVfx = { load, loadMine, play, move, stop, kill, update, batches, skillFx, skillTextures, loadSkins, VF, onReady: f => (FX ? f() : ready.push(f)),
                      clear() { live.length = 0; }, density(k) { density = k; }, count: () => live.length, data: () => FX, base: () => BASE };
})();
