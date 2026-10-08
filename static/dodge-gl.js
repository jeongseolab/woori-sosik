// 스킬샷 피하기의 WebGL 효과층. dodge.js 가 쓴다.
//
// 게임 화면은 지금처럼 Canvas 2D 로 두 장에 나눠 그린다(바닥 bg, 그 위에 선 것들 fg).
// 이 층은 그 두 장을 텍스처로 받아 한 장으로 합치면서 2D 로는 못 하는 것을 더한다.
//   1. 파티클·리본 꼬리: 쿼드 수천 개를 한 번에 그린다. 바닥 층(ground)은 bg 와 fg 사이, 공중 층(air)은 fg 위
//      - 더하기 합성(빛)과 반투명(연기)을 한 번에: 미리 곱한 알파로 그리고, 빛은 알파를 0 으로 내보낸다
//      - 노이즈 침식(erode): 흐려지는 대신 노이즈 모양으로 갉아먹히며 사라진다(실시간 VFX 의 dissolve)
//      - 노이즈 흐름(noise): 노이즈를 흘려 불꽃·에너지가 일렁이게 한다
//   2. 충격파 왜곡: 터진 자리에서 퍼지는 고리 모양으로 화면을 굴절시킨다(원근 때문에 세로로 눌린 타원)
//   3. 빛 번짐(bloom): 밝은 곳만 골라 1/2·1/4·1/8 크기로 흐려 다시 더한다
//   4. 마무리: 화면 흔들림, 맞을 때 색수차, 가장자리 어둡게, 맞음·낮은 체력의 붉은 테두리, 죽으면 회색
//   5. 3D 챔피언: tools/champ_models.py 가 롤 게임 파일에서 만든 모델(static/dodge/models/*.bin) 을
//      구운 애니메이션(서 있기·달리기·스킬) 으로 움직인다. 바닥 위, 2D 로 그린 선 것들 밑에 깊이 버퍼로 그린다.
//      화면 투영은 dodge.js 의 proj 와 같은 식을 셰이더에서 그대로 한다(2D 그림과 정확히 겹치게)
//
// WebGL 을 못 쓰면 create 가 null 을 돌려주고, dodge.js 는 canvas2d() 로 같은 쿼드를 2D 로 그린다(침식·왜곡·번짐 없이).
(function () {
  // ── 모양 텍스처: 4×4 칸(한 칸 128px) 에 흰 모양을 그려 둔다. 색은 그릴 때 곱한다 ──
  const CELL = 128, GRID = 4, SIZE = CELL * GRID;
  const SHAPES = ["dot", "glow", "spark", "ring", "smoke", "star", "heart", "shard",
                  "leaf", "flame", "beam", "chain", "swirl", "rune", "rays", "disc"];

  let shapeSheet = null;
  function shapes() {
    if (shapeSheet) return shapeSheet;
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const g = c.getContext("2d");
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const radial = (stops, sx = 1, sy = 1) => {
      g.save();
      g.scale(sx, sy);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, CELL / 2 - 2);
      stops.forEach(([o, a]) => gr.addColorStop(o, "rgba(255,255,255," + a + ")"));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, CELL / 2 - 2, 0, Math.PI * 2); g.fill();
      g.restore();
    };
    const draw = {
      dot: () => radial([[0, 1], [0.25, 0.75], [0.55, 0.25], [1, 0]]),
      glow: () => radial([[0, 1], [0.08, 0.95], [0.2, 0.45], [0.5, 0.12], [1, 0]]),
      spark: () => radial([[0, 1], [0.3, 0.6], [1, 0]], 1, 0.14),
      ring: () => radial([[0, 0], [0.66, 0], [0.8, 1], [0.9, 0.5], [1, 0]]),
      smoke: () => {
        for (let i = 0; i < 26; i++) {
          const a = rnd() * Math.PI * 2, d = rnd() * 26, r = 14 + rnd() * 22;
          const gr = g.createRadialGradient(Math.cos(a) * d, Math.sin(a) * d, 0, Math.cos(a) * d, Math.sin(a) * d, r);
          gr.addColorStop(0, "rgba(255,255,255,.22)");
          gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr;
          g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
        }
      },
      star: () => {
        radial([[0, 1], [0.1, 0.6], [0.3, 0.12], [1, 0]]);
        for (const [rot, s] of [[0, 1], [Math.PI / 2, 1], [Math.PI / 4, 0.5], [-Math.PI / 4, 0.5]]) {
          g.save(); g.rotate(rot); g.scale(s, s * 0.07);
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, CELL / 2 - 2);
          gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr; g.beginPath(); g.arc(0, 0, CELL / 2 - 2, 0, Math.PI * 2); g.fill();
          g.restore();
        }
      },
      heart: () => {
        g.shadowColor = "#fff"; g.shadowBlur = 14;
        g.fillStyle = "#fff";
        const s = 34;
        g.beginPath();
        g.moveTo(0, s * 0.9);
        g.bezierCurveTo(-s * 1.6, -s * 0.1, -s * 0.75, -s * 1.3, 0, -s * 0.5);
        g.bezierCurveTo(s * 0.75, -s * 1.3, s * 1.6, -s * 0.1, 0, s * 0.9);
        g.fill();
      },
      shard: () => {
        const gr = g.createLinearGradient(-40, 0, 40, 0);
        gr.addColorStop(0, "rgba(255,255,255,.5)"); gr.addColorStop(0.5, "#fff"); gr.addColorStop(1, "rgba(255,255,255,.35)");
        g.fillStyle = gr; g.shadowColor = "#fff"; g.shadowBlur = 8;
        g.beginPath(); g.moveTo(54, 0); g.lineTo(0, -16); g.lineTo(-40, 0); g.lineTo(0, 16); g.closePath(); g.fill();
      },
      leaf: () => {
        g.fillStyle = "rgba(255,255,255,.9)";
        g.beginPath(); g.moveTo(-50, 0); g.quadraticCurveTo(0, -30, 50, 0); g.quadraticCurveTo(0, 30, -50, 0); g.fill();
        g.strokeStyle = "rgba(0,0,0,.35)"; g.globalCompositeOperation = "destination-out";
        g.lineWidth = 3; g.beginPath(); g.moveTo(-44, 0); g.lineTo(44, 0); g.stroke();
        g.globalCompositeOperation = "source-over";
      },
      flame: () => {
        g.save(); g.scale(0.62, 1);
        const gr = g.createRadialGradient(0, 18, 0, 0, 10, 58);
        gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,.6)"); gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(0, -60); g.bezierCurveTo(40, -10, 52, 30, 0, 58); g.bezierCurveTo(-52, 30, -40, -10, 0, -60); g.fill();
        g.restore();
      },
      chain: () => {
        g.strokeStyle = "#fff"; g.lineWidth = 9; g.shadowColor = "#fff"; g.shadowBlur = 6;
        g.beginPath(); g.ellipse(0, 0, 44, 22, 0, 0, Math.PI * 2); g.stroke();
      },
      swirl: () => {
        g.strokeStyle = "rgba(255,255,255,.9)"; g.lineCap = "round"; g.shadowColor = "#fff"; g.shadowBlur = 8;
        for (let k = 0; k < 3; k++) {
          g.lineWidth = 6 - k * 1.5;
          g.beginPath();
          for (let i = 0; i <= 60; i++) {
            const a = i / 60 * Math.PI * 1.6 + k * Math.PI * 2 / 3, r = 8 + i / 60 * 50;
            const x = Math.cos(a) * r, y = Math.sin(a) * r;
            if (i) g.lineTo(x, y); else g.moveTo(x, y);
          }
          g.stroke();
        }
      },
      rune: () => {
        // 마법진: 두 겹 고리, 눈금, 안쪽 별
        g.strokeStyle = "#fff"; g.shadowColor = "#fff"; g.shadowBlur = 5;
        g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 58, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 47, 0, Math.PI * 2); g.stroke();
        for (let i = 0; i < 24; i++) {
          const a = i / 24 * Math.PI * 2, l = i % 3 ? 4 : 9;
          g.beginPath(); g.moveTo(Math.cos(a) * 47, Math.sin(a) * 47); g.lineTo(Math.cos(a) * (47 + l), Math.sin(a) * (47 + l)); g.stroke();
        }
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
          const a = i / 6 * Math.PI * 2 * 2 - Math.PI / 2, x = Math.cos(a) * 40, y = Math.sin(a) * 40;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
      },
      rays: () => {
        for (let i = 0; i < 18; i++) {
          g.save(); g.rotate(i / 18 * Math.PI * 2 + rnd() * 0.2);
          const len = 40 + rnd() * 22;
          const gr = g.createLinearGradient(0, 0, len, 0);
          gr.addColorStop(0, "rgba(255,255,255,.9)"); gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr;
          g.beginPath(); g.moveTo(0, -2.5); g.lineTo(len, 0); g.lineTo(0, 2.5); g.fill();
          g.restore();
        }
        radial([[0, 0.9], [0.2, 0.3], [0.5, 0]]);
      },
      disc: () => radial([[0, 1], [0.8, 1], [0.93, 0.5], [1, 0]]),
    };
    SHAPES.forEach((name, i) => {
      g.save();
      g.translate((i % GRID) * CELL + CELL / 2, Math.floor(i / GRID) * CELL + CELL / 2);
      g.beginPath(); g.rect(-CELL / 2, -CELL / 2, CELL, CELL); g.clip();
      if (name === "beam") {
        // 세로로 긴 빛기둥: 가로로 가우스, 위·아래 끝은 옅게. 픽셀로 만들어 칸 자리에 옮긴다
        g.restore();
        const tmp = document.createElement("canvas");
        tmp.width = tmp.height = CELL;
        const tg = tmp.getContext("2d");
        const img = tg.createImageData(CELL, CELL);
        for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
          const u = (x + 0.5) / CELL * 2 - 1, v = (y + 0.5) / CELL;
          const a = Math.exp(-u * u * 7) * Math.min(1, v * 6) * Math.min(1, (1 - v) * 3);
          const k = (y * CELL + x) * 4;
          img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
          img.data[k + 3] = Math.round(a * 255);
        }
        tg.putImageData(img, 0, 0);
        g.drawImage(tmp, (i % GRID) * CELL, Math.floor(i / GRID) * CELL);
        return;
      }
      draw[name]();
      g.restore();
    });
    const frames = {};
    SHAPES.forEach((name, i) => {
      const x = (i % GRID) * CELL, y = Math.floor(i / GRID) * CELL;
      frames[name] = { tex: 1, u0: (x + 1) / SIZE, v0: (y + 1) / SIZE, u1: (x + CELL - 1) / SIZE, v1: (y + CELL - 1) / SIZE, w: CELL, h: CELL };
    });
    shapeSheet = { canvas: c, frames };
    return shapeSheet;
  }

  // ── 이어지는 노이즈(256×256, 가장자리가 맞물려 반복해도 이음매가 없다) ──
  let noiseCanvas = null;
  function noise() {
    if (noiseCanvas) return noiseCanvas;
    const N = 256, c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d"), img = g.createImageData(N, N);
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const octave = period => {
      const lat = Array.from({ length: period * period }, rnd);
      const at = (i, j) => lat[((j % period + period) % period) * period + ((i % period + period) % period)];
      return (x, y) => {
        const fx = x / N * period, fy = y / N * period, i = Math.floor(fx), j = Math.floor(fy);
        const tx = fx - i, ty = fy - j, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
        return a + (b - a) * sy;
      };
    };
    const os = [[octave(4), 0.5], [octave(8), 0.27], [octave(16), 0.15], [octave(32), 0.08]];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0;
      for (const [f, w] of os) v += f(x, y) * w;
      const k = (y * N + x) * 4, b = Math.max(0, Math.min(255, Math.round((v - 0.5) * 1.6 * 255 + 128)));
      img.data[k] = img.data[k + 1] = img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    noiseCanvas = c;
    return c;
  }

  // ── 쿼드 묶음: 한 쿼드 = 꼭짓점 4개 × 16 float ──
  // [x, y, u, v, nu, nv, r, g, b, a, tex, erode, add, noise, 0, 0]
  // 꼭짓점 순서: 0 왼쪽 위(u0,v0) · 1 오른쪽 위(u1,v0) · 2 오른쪽 아래(u1,v1) · 3 왼쪽 아래(u0,v1)
  const FL = 16;
  function Batch(max) {
    this.f = new Float32Array(max * 4 * FL);
    this.n = 0;
    this.max = max;
  }
  // q: 화면 좌표 8개(x0,y0 ... x3,y3), fr: 프레임, c: [r,g,b] (0~1), o: {a, add, erode, noise, n: [nu0,nv0,nu1,nv1]}
  Batch.prototype.quad = function (q, fr, c, a, add, erode, nz, nuv) {
    if (this.n >= this.max) return;
    const f = this.f;
    let i = this.n * 4 * FL;
    this.n++;
    const us = [fr.u0, fr.u1, fr.u1, fr.u0], vs = [fr.v0, fr.v0, fr.v1, fr.v1];
    const nu = nuv ? [nuv[0], nuv[2], nuv[2], nuv[0]] : [0, 1, 1, 0], nv = nuv ? [nuv[1], nuv[1], nuv[3], nuv[3]] : [0, 0, 1, 1];
    for (let k = 0; k < 4; k++) {
      f[i] = q[k * 2]; f[i + 1] = q[k * 2 + 1];
      f[i + 2] = us[k]; f[i + 3] = vs[k];
      f[i + 4] = nu[k]; f[i + 5] = nv[k];
      f[i + 6] = c[0]; f[i + 7] = c[1]; f[i + 8] = c[2]; f[i + 9] = a;
      f[i + 10] = fr.tex; f[i + 11] = erode || 0; f[i + 12] = add; f[i + 13] = nz || 0;
      f[i + 14] = 0; f[i + 15] = 0;
      i += FL;
    }
  };

  const VS_QUAD = `
    attribute vec2 aPos; attribute vec2 aUv; attribute vec2 aNuv; attribute vec4 aCol; attribute vec4 aP;
    uniform vec2 uRes;
    varying vec2 vUv; varying vec2 vNuv; varying vec4 vCol; varying vec4 vP;
    void main() {
      vUv = aUv; vNuv = aNuv; vCol = aCol; vP = aP;
      vec2 c = aPos / uRes * 2.0 - 1.0;
      gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
    }`;
  // vP: x 텍스처(0 롤 그림, 1 모양), y 침식(0~1), z 더하기(1 이면 빛), w 노이즈 일렁임
  const FS_QUAD = `
    precision mediump float;
    uniform sampler2D uAtlas; uniform sampler2D uShapes; uniform sampler2D uNoise;
    varying vec2 vUv; varying vec2 vNuv; varying vec4 vCol; varying vec4 vP;
    void main() {
      vec4 s = vP.x < 0.5 ? texture2D(uAtlas, vUv) : texture2D(uShapes, vUv);
      float n = texture2D(uNoise, vNuv).r;
      float k = vCol.a;
      if (vP.y > 0.001) k *= clamp((n * 0.75 + s.a * 0.25 - vP.y) * 6.0 + 0.5, 0.0, 1.0);
      k *= mix(1.0, 0.2 + n * 1.6, vP.w);
      gl_FragColor = vec4(s.rgb * vCol.rgb * k, s.a * k * (1.0 - vP.z));
    }`;
  const VS_FULL = `
    attribute vec2 aP; varying vec2 vUv;
    void main() { vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;
  // 2D 캔버스(위가 v=0) 를 충격파로 굴절시켜 옮긴다
  const FS_LAYER = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec2 uRes; uniform vec4 uW[8]; uniform vec2 uW2[8]; uniform int uN;
    varying vec2 vUv;
    void main() {
      vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
      vec2 off = vec2(0.0);
      for (int i = 0; i < 8; i++) {
        if (i >= uN) break;
        vec2 d = px - uW[i].xy;
        d.y /= uW2[i].y;
        float L = length(d) + 0.0001;
        float x = (L - uW[i].z) / uW2[i].x;
        vec2 dir = d / L;
        dir.y *= uW2[i].y;
        off -= dir * uW[i].w * x * exp(-x * x);
      }
      gl_FragColor = texture2D(uTex, (px + off) / uRes);
    }`;
  const FS_BRIGHT = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec2 uTexel; uniform float uTh;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(uTex, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(uTex, vUv + uTexel * vec2(0.5, -0.5)).rgb
             + texture2D(uTex, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(uTex, vUv + uTexel * vec2(0.5, 0.5)).rgb;
      c *= 0.25;
      float l = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(uTh, uTh + 0.3, l), 1.0);
    }`;
  const FS_BLUR = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;
      c += (texture2D(uTex, vUv + uDir * 1.3846153846).rgb + texture2D(uTex, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
      c += (texture2D(uTex, vUv + uDir * 3.2307692308).rgb + texture2D(uTex, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
      gl_FragColor = vec4(c, 1.0);
    }`;
  const FS_FINAL = `
    precision mediump float;
    uniform sampler2D uScene; uniform sampler2D uB1; uniform sampler2D uB2; uniform sampler2D uB3;
    uniform vec2 uRes; uniform vec2 uShake; uniform float uCa; uniform float uDead; uniform float uHurt;
    uniform float uLow; uniform float uBloom;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv + vec2(uShake.x, -uShake.y) / uRes;
      vec2 cc = uv - 0.5;
      vec3 col;
      if (uCa > 0.001) {
        vec2 o = cc * uCa * 0.025;
        col = vec3(texture2D(uScene, uv + o).r, texture2D(uScene, uv).g, texture2D(uScene, uv - o).b);
      } else {
        col = texture2D(uScene, uv).rgb;
      }
      vec3 b = texture2D(uB1, uv).rgb * 0.55 + texture2D(uB2, uv).rgb * 0.75 + texture2D(uB3, uv).rgb * 0.9;
      col += b * uBloom;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 1.1);
      col = (col - 0.5) * 1.04 + 0.5;
      float vig = smoothstep(0.9, 0.3, length(cc * vec2(1.0, 1.25)));
      col *= mix(0.7, 1.0, vig);
      float edge = smoothstep(0.32, 0.78, length(cc * vec2(1.0, 1.3)));
      col = mix(col, vec3(1.0, 0.15, 0.15), edge * uHurt * 0.6);
      col = mix(col, vec3(0.62, 0.0, 0.0), edge * uLow);
      l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l * 0.65), uDead);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;

  // ── 3D 챔피언 모델(.bin, 형식은 tools/champ_models.py) ──
  function half(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1F, f = h & 0x3FF;
    if (e === 0) return s * f * 5.960464477539063e-8;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * Math.pow(2, e - 15);
  }
  function parseModel(buf) {
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "LMDL") throw new Error("모델 아님");
    let o = 8;
    const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
    const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const V = u32(), I = u32(), B = u32(), A = u32(), height = f32(), scale = f32();
    const pos = new Float32Array(buf.slice(o, o + V * 12)); o += V * 12;
    const uv16 = new Uint16Array(buf.slice(o, o + V * 4)); o += V * 4;
    const bones = new Uint8Array(buf.slice(o, o + V * 4)); o += V * 4;
    const weights = new Float32Array(V * 4);
    const w8 = new Uint8Array(buf, o, V * 4); o += V * 4;
    for (let i = 0; i < V * 4; i++) weights[i] = w8[i] / 255;
    const idx = new Uint16Array(buf.slice(o, o + I * 2)); o += I * 2;
    o = (o + 3) & ~3;
    const uv = new Float32Array(V * 2);
    for (let i = 0; i < V * 2; i++) uv[i] = uv16[i] / 65535;
    const anims = {};
    for (let a = 0; a < A; a++) {
      let name = "";
      for (let i = 0; i < 12; i++) { const c = dv.getUint8(o + i); if (c) name += String.fromCharCode(c); }
      o += 12;
      const fps = f32(), F = u32(), n = F * B * 12;
      const h = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
      o = (o + 3) & ~3;
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = half(h[i]);
      anims[name] = { fps, F, m };
    }
    const md = { V, I, B, height, scale, pos, uv, bones, weights, idx, anims };
    md.pivot = bonePivots(md);
    for (const an of Object.values(anims)) splitPose(md, an);
    return md;
  }

  // 뼈마다 섞을 때 기준점: 그 뼈에 붙은 정점(바인드 자세) 의 가중 평균. 정점이 없는 뼈는 0
  function bonePivots(md) {
    const c = new Float32Array(md.B * 3), w = new Float32Array(md.B);
    for (let v = 0; v < md.V; v++) {
      for (let j = 0; j < 4; j++) {
        const k = md.weights[v * 4 + j];
        if (!k) continue;
        const b = md.bones[v * 4 + j];
        w[b] += k;
        for (let a = 0; a < 3; a++) c[b * 3 + a] += k * md.pos[v * 3 + a];
      }
    }
    for (let b = 0; b < md.B; b++) if (w[b]) for (let a = 0; a < 3; a++) c[b * 3 + a] /= w[b];
    return c;
  }
  // 구운 뼈 행렬(3×4) 을 회전(쿼터니언 q) · 나머지(S = Rᵀ·M, 크기) · 기준점이 옮겨 간 자리(p) 로 나눠 둔다.
  // 프레임 사이와 동작 전환을 행렬 그대로 섞으면 빨리 도는 뼈(한 프레임에 90° 넘게) 가 쪼그라들어 몸이 일그러진다
  function splitPose(md, an) {
    const N = an.F * md.B, q = new Float32Array(N * 4), s = new Float32Array(N * 9), p = new Float32Array(N * 3), M = an.m;
    const R = new Float32Array(9), C = new Float32Array(9), flat = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const o = i * 12, b = i % md.B, cx = md.pivot[b * 3], cy = md.pivot[b * 3 + 1], cz = md.pivot[b * 3 + 2];
      // 열마다 길이로 나눈 것으로 회전을 어림한다. C[행 * 3 + 열]
      let big = 0;
      for (let c = 0; c < 3; c++) {
        const x = M[o + c], y = M[o + 4 + c], z = M[o + 8 + c], l = Math.hypot(x, y, z);
        big = Math.max(big, l);
        const k = l > 1e-9 ? 1 / l : 0;
        C[c] = x * k; C[3 + c] = y * k; C[6 + c] = z * k;
      }
      // 뒤집힌 뼈(행렬식 < 0, 뽀삐·칼리스타·워윅 일부) 는 첫 열을 뒤집어 진짜 회전을 뽑는다(뒤집힘은 S 에 남는다)
      const det = C[0] * (C[4] * C[8] - C[5] * C[7]) - C[1] * (C[3] * C[8] - C[5] * C[6]) + C[2] * (C[3] * C[7] - C[4] * C[6]);
      if (det < 0) { C[0] = -C[0]; C[3] = -C[3]; C[6] = -C[6]; }
      const m00 = C[0], m01 = C[1], m02 = C[2], m10 = C[3], m11 = C[4], m12 = C[5], m20 = C[6], m21 = C[7], m22 = C[8];
      const tr = m00 + m11 + m22;
      let x, y, z, w;
      if (tr > 0) { const r = Math.sqrt(tr + 1) * 2; w = r / 4; x = (m21 - m12) / r; y = (m02 - m20) / r; z = (m10 - m01) / r; }
      else if (m00 > m11 && m00 > m22) { const r = Math.sqrt(Math.max(1e-9, 1 + m00 - m11 - m22)) * 2; w = (m21 - m12) / r; x = r / 4; y = (m01 + m10) / r; z = (m02 + m20) / r; }
      else if (m11 > m22) { const r = Math.sqrt(Math.max(1e-9, 1 + m11 - m00 - m22)) * 2; w = (m02 - m20) / r; x = (m01 + m10) / r; y = r / 4; z = (m12 + m21) / r; }
      else { const r = Math.sqrt(Math.max(1e-9, 1 + m22 - m00 - m11)) * 2; w = (m10 - m01) / r; x = (m02 + m20) / r; y = (m12 + m21) / r; z = r / 4; }
      const l = Math.hypot(x, y, z, w) || 1;
      x /= l; y /= l; z /= l; w /= l;
      if (!isFinite(x + y + z + w)) { x = y = z = 0; w = 1; }
      // 크기 0 인 숨긴 부품은 회전이 없다 → 아래에서 가까운 프레임의 회전을 빌린다(나타날 때 빙글 돌지 않게)
      if (big < 1e-6) flat[i] = 1;
      q[i * 4] = x; q[i * 4 + 1] = y; q[i * 4 + 2] = z; q[i * 4 + 3] = w;
      quatMat(x, y, z, w, R);
      // S = Rᵀ · M(3×3): 회전을 빼고 남은 것(크기·뒤집힘). R·S 는 M 과 정확히 같다
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        s[i * 9 + r * 3 + c] = R[r] * M[o + c] + R[3 + r] * M[o + 4 + c] + R[6 + r] * M[o + 8 + c];
      }
      for (let r = 0; r < 3; r++) p[i * 3 + r] = M[o + r * 4] * cx + M[o + r * 4 + 1] * cy + M[o + r * 4 + 2] * cz + M[o + r * 4 + 3];
    }
    // 숨긴 프레임의 회전: 앞쪽 보이는 프레임 것, 없으면 뒤쪽 것(S 는 0 이라 모양은 그대로)
    for (let b = 0; b < md.B; b++) {
      let last = -1;
      for (let f = 0; f < an.F; f++) { const i = f * md.B + b; if (!flat[i]) last = i; else if (last >= 0) q.copyWithin(i * 4, last * 4, last * 4 + 4); }
      let next = -1;
      for (let f = an.F - 1; f >= 0; f--) { const i = f * md.B + b; if (!flat[i]) next = i; else if (next >= 0 && !(last >= 0 && i > last)) q.copyWithin(i * 4, next * 4, next * 4 + 4); }
    }
    an.q = q; an.s = s; an.p = p;
    delete an.m;
  }
  // 쿼터니언 → 3×3 회전(행 우선) 을 out 에
  function quatMat(x, y, z, w, out) {
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * w); out[2] = 2 * (x * z + y * w);
    out[3] = 2 * (x * y + z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - x * w);
    out[6] = 2 * (x * z - y * w); out[7] = 2 * (y * z + x * w); out[8] = 1 - 2 * (x * x + y * y);
    return out;
  }

  // 모델 좌표 → 바닥 좌표 → 화면. dodge.js 의 proj 와 같은 식(uC: S, OX, OY, FOCAL · uC2: CAM_D, COS, SIN · uC3: 경기장 가운데)
  const VS_MODEL = `
    attribute vec3 aPos; attribute vec2 aUv;
    uniform vec4 uPlace; uniform vec2 uRot; uniform float uScale;
    uniform vec4 uC; uniform vec3 uC2; uniform vec2 uC3; uniform vec2 uRes;
    varying vec2 vUv; varying float vH;
    void main() {
      vec3 p = aPos * uScale;
      // 롤 모델은 앞이 +z, 오른쪽이 +x(이즈리얼의 왼손 건틀릿이 -x). 앞을 uRot(바라보는 방향) 으로,
      // +x 를 그 오른쪽(바닥 좌표에서 (-sin, cos)) 으로 놓는다
      float wx = uPlace.x + p.z * uRot.x - p.x * uRot.y;
      float wy = uPlace.y + p.z * uRot.y + p.x * uRot.x;
      float wz = p.y + uPlace.z;
      float dy = (wy - uC3.y) - uC2.x * uC2.y, dz = wz - uC2.x * uC2.z;
      float yc = -dy * uC2.z + dz * uC2.y;
      float zc = -dy * uC2.y - dz * uC2.z;
      float k = uC.w / zc * uC.x;
      float sx = uC.y + (wx - uC3.x) * k, sy = uC.z - yc * k;
      vec2 ndc = vec2(sx / uRes.x * 2.0 - 1.0, 1.0 - sy / uRes.y * 2.0);
      float d = clamp((zc - 500.0) / 6000.0, 0.0, 1.0) * 2.0 - 1.0;
      gl_Position = vec4(ndc * zc, d * zc, zc);
      vUv = aUv;
      vH = clamp(aPos.y / 220.0, 0.0, 1.0);
    }`;
  // 텍스처 + 위로 갈수록 살짝 밝게(롤의 위쪽 조명 흉내) + 덧칠(맞을 때 흰빛, 유체화 푸른빛) + 진하기
  const FS_MODEL = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec4 uTint; uniform float uAlpha;
    varying vec2 vUv; varying float vH;
    void main() {
      vec4 t = texture2D(uTex, vUv);
      if (t.a < 0.35) discard;
      vec3 c = t.rgb / max(t.a, 0.001) * (0.82 + 0.3 * vH);
      c = mix(c, uTint.rgb, uTint.a);
      gl_FragColor = vec4(c * uAlpha, uAlpha);
    }`;

  // ── 롤 이펙트(dodge-vfx.js 가 만든 삼각형) ──
  // 정점(롤 좌표 x, y 위, z 북쪽) → 바닥 좌표(x, -z, 높이 y) → 화면. 투영은 VS_MODEL 과 같다
  const VS_VFX = `
    attribute vec3 aPos; attribute vec2 aUv; attribute vec4 aCol; attribute vec4 aX; attribute vec2 aMu;
    uniform vec4 uC; uniform vec3 uC2; uniform vec2 uC3; uniform vec2 uRes;
    varying vec2 vUv; varying vec4 vCol; varying vec4 vX; varying vec2 vMu;
    void main() {
      float wx = aPos.x, wy = -aPos.z, wz = aPos.y;
      float dy = (wy - uC3.y) - uC2.x * uC2.y, dz = wz - uC2.x * uC2.z;
      float yc = -dy * uC2.z + dz * uC2.y;
      float zc = -dy * uC2.y - dz * uC2.z;
      float k = uC.w / zc * uC.x;
      float sx = uC.y + (wx - uC3.x) * k, sy = uC.z - yc * k;
      vec2 ndc = vec2(sx / uRes.x * 2.0 - 1.0, 1.0 - sy / uRes.y * 2.0);
      float d = clamp((zc - 500.0) / 6000.0, 0.0, 1.0) * 2.0 - 1.0;
      gl_Position = vec4(ndc * zc, d * zc, zc);
      vUv = aUv; vCol = aCol; vX = aX; vMu = aMu;
    }`;
  // 텍스처(낱장 또는 texDiv 칸) × 색. 색 조회 텍스처·팔레트·곱 텍스처·침식은 켜진 것만.
  // 텍스처는 미리 곱한 알파로 올라와 있다. 빛을 더하는 발생기는 알파를 0 으로 내보내 뒤를 덮지 않는다
  const FS_VFX = `
    precision mediump float;
    uniform sampler2D uTex; uniform sampler2D uColTex; uniform sampler2D uMult; uniform sampler2D uErode; uniform sampler2D uPal;
    uniform vec2 uDiv; uniform vec2 uWrap; uniform vec4 uOn; uniform float uAdd; uniform float uRef;
    uniform vec4 uPalSel; uniform vec4 uPalMix; uniform float uErodeA;
    varying vec2 vUv; varying vec4 vCol; varying vec4 vX; varying vec2 vMu;
    vec4 un(vec4 c) { return vec4(c.rgb / max(c.a, 0.0001), c.a); }
    void main() {
      // 반복 텍스처(2 의 거듭제곱, 밉맵 있음) 는 GL 의 REPEAT 에 맡긴다. fract 로 접으면 판 가장자리에서 UV 가 1 → 0 으로 뛰어
      // 그 픽셀 묶음이 가장 작은 밉맵(텍스처 평균색) 을 읽어, 이펙트 둘레에 점선 사각형이 생긴다
      float f = floor(vX.x + 0.5);
      vec2 cell = vec2(mod(f, uDiv.x), floor(f / uDiv.x));
      vec2 tuv = uWrap.x > 0.5 ? vUv : (cell + clamp(vUv, 0.002, 0.998)) / uDiv;
      vec4 s = un(texture2D(uTex, tuv));
      vec4 col = vCol;
      if (uOn.x > 0.5) { vec4 c = un(texture2D(uColTex, vec2(clamp(vX.y, 0.0, 1.0), 0.5))); col *= c; }
      if (uOn.w > 0.5) {
        float l = dot(s, uPalMix);
        vec4 pc = un(texture2D(uPal, vec2(clamp(l, 0.0, 1.0), uPalSel.x)));
        s = vec4(pc.rgb, s.a * pc.a);
      }
      // vMu: 곱하기 텍스처 UV(정점마다 dodge-vfx.js 가 계산. 기본 텍스처의 흐름·오프셋과 따로)
      if (uOn.y > 0.5) { vec4 m = un(texture2D(uMult, uWrap.y > 0.5 ? vMu : fract(vMu))); s *= m; }
      float a = s.a * col.a;
      if (uOn.z > 0.5 && vX.z > 0.0001) {
        vec4 em = texture2D(uErode, tuv);
        float m = uErodeA > 0.5 ? em.a : un(em).r;
        a *= smoothstep(vX.z, vX.z + 0.08, m);
      }
      if (a * 255.0 < uRef) discard;
      gl_FragColor = vec4(s.rgb * col.rgb * a, a * (1.0 - uAdd));
    }`;

  // 받은 모델 파일(.bin + 텍스처) 은 페이지에 남겨 둔다. 연습장을 나갔다(티어표·그룹방) 다시 와도 새로 받지 않는다.
  // WebGL 버퍼는 연습장마다 새로 만들지만 그건 금방이다
  // 파일은 브라우저 저장소(Cache Storage) 에도 넣어 둬서 다음에 연습장을 열 때는 받지 않는다.
  // ver 는 index.json 의 v(파일 내용 해시). 모델을 다시 만들면 v 가 바뀌어 새로 받고, 그 챔피언의 옛 파일은 지운다.
  // 저장소를 못 쓰면(http 주소·사생활 보호 모드) 그냥 받는다
  const RAW = new Map();
  const STORE = "dodge-models";
  function stored(url) {
    if (!window.caches) return fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r; });
    return caches.open(STORE).then(c => c.match(url).then(hit => hit || fetch(url).then(r => {
      if (!r.ok) throw new Error(r.status);
      const path = new URL(url, location.href).pathname;
      c.put(url, r.clone())
        .then(() => c.keys())
        .then(ks => ks.forEach(q => { if (new URL(q.url).pathname === path && q.url !== new URL(url, location.href).href) c.delete(q); }))
        .catch(() => {});
      return r;
    }))).catch(() => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r; }));
  }
  // 받은 그림 파일(blob) 을 푼다. createImageBitmap 은 메인 스레드 밖에서 푼다(Image 는 texImage2D 에 넘길 때 메인 스레드에서
  // 풀어서, 이펙트 텍스처 수백 장을 올리는 동안 로딩이 몇 초 길었다). ImageBitmap 은 WebGL 의 UNPACK_PREMULTIPLY 를 따르지 않으니
  // 여기서 미리 알파를 곱해 둔다(Image 를 올릴 때와 같은 값). 못 쓰는 브라우저는 Image 로
  function picture(b) {
    const img = () => new Promise((ok, no) => {
      const im = new Image(), src = URL.createObjectURL(b);
      im.onload = () => { URL.revokeObjectURL(src); ok(im); };
      im.onerror = () => { URL.revokeObjectURL(src); no(new Error("texture")); };
      im.src = src;
    });
    if (!window.createImageBitmap) return img();
    return createImageBitmap(b, { premultiplyAlpha: "premultiply" }).catch(img);
  }
  let probe = null;      // 이펙트 텍스처의 알파를 재 보는 16×16 캔버스(vfxTex)
  function rawModel(key, base, ver) {
    if (RAW.has(key)) return RAW.get(key);
    const q = ver ? "?v=" + ver : "";
    const p = Promise.all([
      stored(base + key + ".bin" + q).then(r => r.arrayBuffer()),
      stored(base + key + ".webp" + q).then(r => r.blob()).then(picture),
    ]);
    p.catch(() => RAW.delete(key));
    RAW.set(key, p);
    return p;
  }

  function create(top) {
    const cv = document.createElement("canvas");
    cv.className = "lol-gl";
    cv.setAttribute("aria-hidden", "true");
    let gl = null;
    try {
      gl = cv.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false,
                                    premultipliedAlpha: true, powerPreference: "high-performance" });
    } catch { gl = null; }
    if (!gl) return null;

    function program(vs, fs) {
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, "");
        u[name] = gl.getUniformLocation(p, info.name);
      }
      return { p, u, a: name => gl.getAttribLocation(p, name) };
    }

    let P;
    try {
      P = {
        quad: program(VS_QUAD, FS_QUAD),
        layer: program(VS_FULL, FS_LAYER),
        bright: program(VS_FULL, FS_BRIGHT),
        blur: program(VS_FULL, FS_BLUR),
        final: program(VS_FULL, FS_FINAL),
        model: program(VS_MODEL, FS_MODEL),
        vfx: program(VS_VFX, FS_VFX),
      };
    } catch (e) {
      console.warn("dodge-gl: 셰이더를 만들지 못해 2D 로 그립니다", e);
      return null;
    }

    const MAXQ = 8000;
    const ground = new Batch(3000), air = new Batch(MAXQ);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, MAXQ * 4 * FL * 4, gl.DYNAMIC_DRAW);
    const ibo = gl.createBuffer();
    const idx = new Uint16Array(MAXQ * 6);
    for (let i = 0; i < MAXQ; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const tri = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    function texture(src, repeat) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      return t;
    }
    const sh = shapes();
    const tShapes = texture(sh.canvas), tNoise = texture(noise(), true);
    let tAtlas = texture(null);
    const tBg = texture(null), tFg = texture(null);

    // 화면 크기 버퍼들: A 전체, 번짐용 1/2·1/4·1/8(각각 가로세로 흐림에 두 장)
    function target(w, h, depth) {
      const t = texture(null);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      let rb = null;
      if (depth) {
        // 3D 모델끼리 앞뒤를 가리는 깊이 버퍼
        rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      }
      return { t, fb, w, h, rb };
    }
    function drop(rt) { if (rt) { gl.deleteTexture(rt.t); gl.deleteFramebuffer(rt.fb); if (rt.rb) gl.deleteRenderbuffer(rt.rb); } }
    let W = 1, H = 1, cssW = 1, cssH = 1, RT = null;
    function resize(w, h, dpr) {
      cssW = w; cssH = h;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + "px";
      cv.style.height = h + "px";
      if (pw === W && ph === H && RT) return;
      W = cv.width = pw; H = cv.height = ph;
      if (RT) Object.values(RT).forEach(drop);
      const s = k => [Math.max(1, Math.round(W / k)), Math.max(1, Math.round(H / k))];
      RT = { A: target(W, H, true), h1: target(...s(2)), h2: target(...s(2)), q1: target(...s(4)), q2: target(...s(4)),
             e1: target(...s(8)), e2: target(...s(8)) };
    }

    let lost = false;
    cv.addEventListener("webglcontextlost", e => { e.preventDefault(); lost = true; });

    function bindFull(prog) {
      gl.useProgram(prog.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, tri);
      const a = prog.a("aP");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 8, 0);
    }
    function to(rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fb : null);
      gl.viewport(0, 0, rt ? rt.w : W, rt ? rt.h : H);
    }
    function bindTex(unit, t, loc) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(loc, unit);
    }

    const wv = new Float32Array(32), wv2 = new Float32Array(16);
    function layer(tex, waves) {
      bindFull(P.layer);
      bindTex(0, tex, P.layer.u.uTex);
      gl.uniform2f(P.layer.u.uRes, cssW, cssH);
      const n = Math.min(8, waves.length);
      for (let i = 0; i < n; i++) {
        const w = waves[i];
        wv.set([w.x, w.y, w.r, w.amp], i * 4);
        wv2.set([w.th, w.sq], i * 2);
      }
      gl.uniform4fv(P.layer.u.uW, wv);
      gl.uniform2fv(P.layer.u.uW2, wv2);
      gl.uniform1i(P.layer.u.uN, n);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawBatch(b) {
      if (!b.n) return;
      const q = P.quad;
      gl.useProgram(q.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.f.subarray(0, b.n * 4 * FL));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      const at = (name, size, off) => {
        const a = q.a(name);
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, size, gl.FLOAT, false, FL * 4, off * 4);
      };
      at("aPos", 2, 0); at("aUv", 2, 2); at("aNuv", 2, 4); at("aCol", 4, 6); at("aP", 4, 10);
      gl.uniform2f(q.u.uRes, cssW, cssH);
      bindTex(0, tAtlas, q.u.uAtlas);
      bindTex(1, tShapes, q.u.uShapes);
      bindTex(2, tNoise, q.u.uNoise);
      gl.drawElements(gl.TRIANGLES, b.n * 6, gl.UNSIGNED_SHORT, 0);
      // 다음 프로그램이 안 쓰는 속성은 끈다(전체 화면 그리기는 aP 하나만 쓴다)
      ["aUv", "aNuv", "aCol", "aP"].forEach(n => { const a = q.a(n); if (a >= 0) gl.disableVertexAttribArray(a); });
    }

    // ── 3D 챔피언 ──
    // 받아 둔 모델: 키 → { m(parseModel), tex, uvBuf, idxBuf, posBuf, out(뼈를 섞은 위치), mats(섞은 뼈 행렬) }
    const models = new Map(), asked = new Map();
    function loadModel(key, base, ver) {
      if (asked.has(key)) return asked.get(key);
      const p = rawModel(key, base, ver).then(([buf, img]) => {
        if (lost) return null;
        const m = parseModel(buf);
        const mk = (kind, data) => { const b = gl.createBuffer(); gl.bindBuffer(kind, b); gl.bufferData(kind, data, gl.STATIC_DRAW); return b; };
        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, m.V * 12, gl.DYNAMIC_DRAW);
        const md = { m, tex: texture(img), uvBuf: mk(gl.ARRAY_BUFFER, m.uv), idxBuf: mk(gl.ELEMENT_ARRAY_BUFFER, m.idx), posBuf,
                     out: new Float32Array(m.V * 3), mats: new Float32Array(m.B * 12) };
        models.set(key, md);
        return md;
      });
      // 못 받으면(서버가 잠깐 늦거나 끊김) 그 챔피언이 판 내내 초상화로 남지 않게, 잠시 뒤 다시 받을 수 있게 둔다
      p.catch(() => { setTimeout(() => asked.delete(key), 3000); });
      asked.set(key, p);
      return p;
    }
    // 나눠 둔 뼈 자세(q·s·p) 두 개를 k 만큼 섞어 a 에. 회전은 쿼터니언(가까운 쪽으로), 나머지는 직선
    function mixPose(a, b, k, B) {
      for (let i = 0; i < B; i++) {
        const o = i * 4;
        const d = a.q[o] * b.q[o] + a.q[o + 1] * b.q[o + 1] + a.q[o + 2] * b.q[o + 2] + a.q[o + 3] * b.q[o + 3];
        const sg = d < 0 ? -1 : 1;
        for (let j = 0; j < 4; j++) a.q[o + j] += (sg * b.q[o + j] - a.q[o + j]) * k;
      }
      for (let i = 0; i < B * 9; i++) a.s[i] += (b.s[i] - a.s[i]) * k;
      for (let i = 0; i < B * 3; i++) a.p[i] += (b.p[i] - a.p[i]) * k;
    }
    const newPose = B => ({ q: new Float32Array(B * 4), s: new Float32Array(B * 9), p: new Float32Array(B * 3) });
    // 애니메이션 name 의 time 초 뼈 자세를 dst(q·s·p) 에. 동작이 없으면 false
    function boneMats(m, name, time, loop, dst) {
      const an = m.anims[name] || m.anims.idle || Object.values(m.anims)[0];
      if (!an) return false;
      let f = time * an.fps;
      f = loop ? ((f % an.F) + an.F) % an.F : Math.min(an.F - 1, Math.max(0, f));
      const f0 = Math.floor(f), f1 = loop ? (f0 + 1) % an.F : Math.min(an.F - 1, f0 + 1), k = f - f0, B = m.B;
      dst.q.set(an.q.subarray(f0 * B * 4, (f0 + 1) * B * 4));
      dst.s.set(an.s.subarray(f0 * B * 9, (f0 + 1) * B * 9));
      dst.p.set(an.p.subarray(f0 * B * 3, (f0 + 1) * B * 3));
      if (k > 0 && f1 !== f0) {
        const nx = m.tmp || (m.tmp = newPose(B));
        nx.q.set(an.q.subarray(f1 * B * 4, (f1 + 1) * B * 4));
        nx.s.set(an.s.subarray(f1 * B * 9, (f1 + 1) * B * 9));
        nx.p.set(an.p.subarray(f1 * B * 3, (f1 + 1) * B * 3));
        mixPose(dst, nx, k, B);
      }
      return true;
    }
    const ROT = new Float32Array(9);
    // 뼈 자세(q·s·p) → 정점에 곱할 3×4 행렬: M = R·S, 기준점 c 가 p 로 가게 T = p − R·S·c
    function composeMats(m, ps, mats) {
      for (let b = 0; b < m.B; b++) {
        let x = ps.q[b * 4], y = ps.q[b * 4 + 1], z = ps.q[b * 4 + 2], w = ps.q[b * 4 + 3];
        const l = Math.hypot(x, y, z, w) || 1;
        x /= l; y /= l; z /= l; w /= l;
        const R = quatMat(x, y, z, w, ROT), S = ps.s, so = b * 9, o = b * 12;
        const cx = m.pivot[b * 3], cy = m.pivot[b * 3 + 1], cz = m.pivot[b * 3 + 2];
        for (let r = 0; r < 3; r++) {
          const m0 = R[r * 3] * S[so] + R[r * 3 + 1] * S[so + 3] + R[r * 3 + 2] * S[so + 6];
          const m1 = R[r * 3] * S[so + 1] + R[r * 3 + 1] * S[so + 4] + R[r * 3 + 2] * S[so + 7];
          const m2 = R[r * 3] * S[so + 2] + R[r * 3 + 1] * S[so + 5] + R[r * 3 + 2] * S[so + 8];
          mats[o + r * 4] = m0; mats[o + r * 4 + 1] = m1; mats[o + r * 4 + 2] = m2;
          mats[o + r * 4 + 3] = ps.p[b * 3 + r] - (m0 * cx + m1 * cy + m2 * cz);
        }
      }
    }
    // 애니메이션 name 의 time 초 자세로 뼈를 섞어 정점을 옮긴다. from 이 있으면 그 자세에서 mix(0~1) 만큼 넘어간 자세
    function pose(md, name, time, loop, from, mix) {
      const m = md.m, mats = md.mats, out = md.out;
      const cur = md.cur || (md.cur = newPose(m.B));
      if (!boneMats(m, name, time, loop, cur)) { out.set(m.pos); return; }
      if (from && mix < 1) {
        const prev = md.prev || (md.prev = newPose(m.B));
        if (boneMats(m, from.anim, from.time, from.loop !== false, prev)) {
          mixPose(prev, cur, mix, m.B);
          composeMats(m, prev, mats);
        } else composeMats(m, cur, mats);
      } else composeMats(m, cur, mats);
      const P = m.pos, Bn = m.bones, Wt = m.weights;
      for (let v = 0, n = m.V; v < n; v++) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        let ox = 0, oy = 0, oz = 0;
        for (let j = 0; j < 4; j++) {
          const w = Wt[v * 4 + j];
          if (w === 0) continue;
          const b = Bn[v * 4 + j] * 12;
          ox += w * (mats[b] * x + mats[b + 1] * y + mats[b + 2] * z + mats[b + 3]);
          oy += w * (mats[b + 4] * x + mats[b + 5] * y + mats[b + 6] * z + mats[b + 7]);
          oz += w * (mats[b + 8] * x + mats[b + 9] * y + mats[b + 10] * z + mats[b + 11]);
        }
        out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
      }
    }
    // actors: [{ key, x, y, z, angle, anim, time, loop, alpha, tint: [r, g, b, a], from: { anim, time, loop }, mix }], cam: dodge.js 의 투영 값
    function drawModels(actors, cam) {
      if (!actors || !actors.length || !cam) return;
      const q = P.model, u = q.u;
      gl.useProgram(q.p);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniform4f(u.uC, cam.S, cam.OX, cam.OY, cam.FOCAL);
      gl.uniform3f(u.uC2, cam.CAM_D, cam.COS, cam.SIN);
      gl.uniform2f(u.uC3, cam.W2, cam.H2);
      gl.uniform2f(u.uRes, cssW, cssH);
      const aPos = q.a("aPos"), aUv = q.a("aUv");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aUv);
      for (const ac of actors) {
        const md = models.get(ac.key);
        if (!md) continue;
        pose(md, ac.anim, ac.time, ac.loop !== false, ac.from, ac.mix == null ? 1 : ac.mix);
        gl.bindBuffer(gl.ARRAY_BUFFER, md.posBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, md.out);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 12, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, md.uvBuf);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 8, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, md.idxBuf);
        gl.uniform4f(u.uPlace, ac.x, ac.y, ac.z || 0, 0);
        gl.uniform2f(u.uRot, Math.cos(ac.angle), Math.sin(ac.angle));
        gl.uniform1f(u.uScale, md.m.scale);
        const tint = ac.tint || [0, 0, 0, 0];
        gl.uniform4f(u.uTint, tint[0], tint[1], tint[2], tint[3]);
        gl.uniform1f(u.uAlpha, ac.alpha == null ? 1 : ac.alpha);
        bindTex(0, md.tex, u.uTex);
        gl.drawElements(gl.TRIANGLES, md.m.I, gl.UNSIGNED_SHORT, 0);
      }
      gl.disableVertexAttribArray(aUv);
      gl.disable(gl.DEPTH_TEST);
    }

    function upload(t, canvas) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }

    function blur(src, tmp, k) {
      bindFull(P.blur);
      to(tmp);
      bindTex(0, src.t, P.blur.u.uTex);
      gl.uniform2f(P.blur.u.uDir, k / src.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      to(src);
      bindTex(0, tmp.t, P.blur.u.uTex);
      gl.uniform2f(P.blur.u.uDir, 0, k / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function down(src, dst, th) {
      bindFull(P.bright);
      to(dst);
      bindTex(0, src.t, P.bright.u.uTex);
      gl.uniform2f(P.bright.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(P.bright.u.uTh, th);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ── 롤 이펙트 ──
    // 이펙트 텍스처(dodge/vfx/t/<번호>.webp) 는 처음 쓸 때 받는다. 2 의 거듭제곱 크기만 반복(REPEAT) 할 수 있다(WebGL1)
    const vtex = new Map();
    let vbuf = null, vcap = 0;
    const white = texture(null);
    gl.bindTexture(gl.TEXTURE_2D, white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    function vfxTex(i) {
      if (i == null || !window.DodgeVfx) return null;
      if (vtex.has(i)) return vtex.get(i);
      const rec = { t: null, wrap: false, opaque: false, failed: false };
      // p: 받거나 실패하면 풀리는 약속(연습장 로딩 화면이 적 스킬 텍스처를 다 받을 때까지 기다린다)
      let settle;
      rec.p = new Promise(ok => { settle = ok; });
      vtex.set(i, rec);
      const put = img => {
        // 못 올리면 실패로 둔다(drawVfx 가 이 텍스처를 기다리느라 묶음을 영영 안 그리지 않게)
        if (lost) { rec.failed = true; settle(); return; }
        const pot = v => (v & (v - 1)) === 0;
        rec.wrap = pot(img.width) && pot(img.height);
        // 알파가 꽉 찬 텍스처인지(침식 지도는 그때 빨강 채널을 쓴다).
        // 캔버스 하나를 CPU 에 두고(willReadFrequently) 돌려 쓴다. 장마다 새 캔버스에서 읽으면 GPU 에서 되읽느라 오래 걸렸다
        try {
          if (!probe) { probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); probe.canvas.width = probe.canvas.height = 16; }
          probe.clearRect(0, 0, 16, 16);
          probe.drawImage(img, 0, 0, 16, 16);
          const d = probe.getImageData(0, 0, 16, 16).data;
          rec.opaque = true;
          for (let k = 3; k < d.length; k += 4) if (d[k] < 250) { rec.opaque = false; break; }
        } catch {}
        try {
          rec.t = texture(img, rec.wrap);
          if (rec.wrap) {
            gl.bindTexture(gl.TEXTURE_2D, rec.t);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          }
        } catch { rec.t = null; rec.failed = true; }
        if (img.close) img.close();
        settle();
      };
      fetch(DodgeVfx.base() + "t/" + i + ".webp").then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(picture)
        .then(put, () => { rec.failed = true; settle(); });
      return rec;
    }
    // list: DodgeVfx.batches() 의 묶음. ground 면 바닥층만, 아니면 나머지만
    function drawVfx(list, cam, ground) {
      if (!list || !list.length || !cam) return;
      const q = P.vfx, u = q.u;
      gl.useProgram(q.p);
      if (!vbuf) vbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      gl.uniform4f(u.uC, cam.S, cam.OX, cam.OY, cam.FOCAL);
      gl.uniform3f(u.uC2, cam.CAM_D, cam.COS, cam.SIN);
      gl.uniform2f(u.uC3, cam.W2, cam.H2);
      gl.uniform2f(u.uRes, cssW, cssH);
      const VF = DodgeVfx.VF, sizes = [3, 2, 4, 4, 2];
      const locs = ["aPos", "aUv", "aCol", "aX", "aMu"].map(n => q.a(n));
      if (ground) gl.disable(gl.DEPTH_TEST);
      else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const b of list) {
        if (!!b.ground !== !!ground) continue;
        const e = b.e, base = vfxTex(e.texture);
        if (!base || !base.t) continue;
        const ct = vfxTex(e.particleColorTexture), mt = e.textureMult && vfxTex(e.textureMult.textureMult);
        const er = e.alphaErosionDefinition && vfxTex(e.alphaErosionDefinition.erosionMapName);
        const pd = e.paletteDefinition, pt = pd && vfxTex(pd.paletteTexture);
        // 곱하기·침식·색·팔레트 텍스처를 다 받을 때까지 그리지 않는다. 기본 텍스처만으로 그리면
        // 모양을 깎는 마스크가 빠져 메시가 통째로 더해지고, 처음 날아오는 스킬이 하얗게 탄다(모르가나 Q 등)
        if ([ct, mt, er, pt].some(r => r && !r.t && !r.failed)) continue;
        if (b.verts.byteLength > vcap) { vcap = b.verts.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, vcap, gl.DYNAMIC_DRAW); }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.verts);
        let off = 0;
        locs.forEach((a, k) => {
          if (a >= 0) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, sizes[k], gl.FLOAT, false, VF * 4, off * 4); }
          off += sizes[k];
        });
        bindTex(0, base.t, u.uTex);
        const div = e.texDiv || [1, 1];
        gl.uniform2f(u.uDiv, Math.max(1, div[0]), Math.max(1, div[1]));
        const on = [ct && ct.t ? 1 : 0, mt && mt.t ? 1 : 0, er && er.t ? 1 : 0, pt && pt.t ? 1 : 0];
        gl.uniform2f(u.uWrap, base.wrap && !(div[0] > 1 || div[1] > 1) ? 1 : 0, on[1] && mt.wrap ? 1 : 0);
        gl.uniform4f(u.uOn, on[0], on[1], on[2], on[3]);
        bindTex(1, on[0] ? ct.t : white, u.uColTex);
        bindTex(2, on[1] ? mt.t : white, u.uMult);
        bindTex(3, on[2] ? er.t : white, u.uErode);
        bindTex(4, on[3] ? pt.t : white, u.uPal);
        gl.uniform1f(u.uErodeA, on[2] && !er.opaque ? 1 : 0);
        if (on[3]) {
          const cnt = pd.paletteCount || 1, sel = pd.paletteSelector && pd.paletteSelector.c ? pd.paletteSelector.c[0] : 0;
          const mix = pd.palleteSrcMixColor && pd.palleteSrcMixColor.c ? pd.palleteSrcMixColor.c : [1, 0, 0, 0];
          gl.uniform4f(u.uPalSel, (sel + 0.5) / cnt, 0, 0, 0);
          gl.uniform4f(u.uPalMix, mix[0], mix[1], mix[2], mix[3]);
        }
        gl.uniform1f(u.uAdd, b.add ? 1 : 0);
        gl.uniform1f(u.uRef, e.alphaRef == null ? 5 : e.alphaRef);
        gl.drawArrays(gl.TRIANGLES, 0, b.n);
      }
      locs.forEach(a => { if (a >= 0) gl.disableVertexAttribArray(a); });
      if (!ground) { gl.depthMask(true); gl.disable(gl.DEPTH_TEST); }
    }

    // o: { bg, fg (캔버스), waves, shake: {x, y}, ca, dead, hurt, low, bloom, vfx(롤 이펙트 묶음) }
    function frame(o) {
      if (lost || !RT) return false;
      try {
        upload(tBg, o.bg);
        upload(tFg, o.fg);
      } catch (e) {
        // CORS 없는 그림이 그려져 캔버스가 오염됐다. 이 층은 더 못 쓰니 2D 로 물러난다
        console.warn("dodge-gl: 캔버스를 올리지 못해 2D 로 그립니다", e);
        lost = true;
        return false;
      }
      gl.disable(gl.DEPTH_TEST);
      // 1) 바닥 → 바닥 파티클 → 선 것들 → 공중 파티클
      to(RT.A);
      gl.disable(gl.BLEND);
      layer(tBg, o.waves);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawBatch(ground);
      drawVfx(o.vfx, o.cam, true);
      drawModels(o.actors, o.cam);
      drawVfx(o.vfx, o.cam, false);
      layer(tFg, o.waves);
      drawBatch(air);
      gl.disable(gl.BLEND);
      // 2) 빛 번짐: 밝은 곳만 1/2 로, 흐리고, 1/4·1/8 로 내리며 또 흐린다
      down(RT.A, RT.h1, 0.8);
      blur(RT.h1, RT.h2, 1);
      down(RT.h1, RT.q1, 0);
      blur(RT.q1, RT.q2, 1.4);
      down(RT.q1, RT.e1, 0);
      blur(RT.e1, RT.e2, 1.8);
      // 3) 화면으로
      bindFull(P.final);
      to(null);
      const u = P.final.u;
      bindTex(0, RT.A.t, u.uScene);
      bindTex(1, RT.h1.t, u.uB1);
      bindTex(2, RT.q1.t, u.uB2);
      bindTex(3, RT.e1.t, u.uB3);
      gl.uniform2f(u.uRes, cssW, cssH);
      gl.uniform2f(u.uShake, o.shake ? o.shake.x : 0, o.shake ? o.shake.y : 0);
      gl.uniform1f(u.uCa, o.ca || 0);
      gl.uniform1f(u.uDead, o.dead || 0);
      gl.uniform1f(u.uHurt, o.hurt || 0);
      gl.uniform1f(u.uLow, o.low || 0);
      gl.uniform1f(u.uBloom, o.bloom == null ? 0.8 : o.bloom);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ground.n = 0;
      air.n = 0;
      return true;
    }

    top.after(cv);
    return {
      gl: true,
      canvas: cv,
      ground, air,
      frames: sh.frames,
      resize,
      frame,
      ok: () => !lost,
      setAtlas(img) { gl.deleteTexture(tAtlas); tAtlas = texture(img); },
      loadModel,
      model: key => models.get(key) || null,
      // 이펙트 텍스처들을 미리 받는다. 하나 끝날 때마다(받았든 실패했든) each() 를 부른다
      preloadVfx: (ids, each = () => {}) => Promise.all(ids.map(i => { const r = vfxTex(i); return (r ? r.p : Promise.resolve()).then(each); })),
      destroy() { cv.remove(); const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); },
    };
  }

  // ── WebGL 이 없을 때: 같은 쿼드를 2D 로 바로 그린다 ──
  // 꼭짓점 0·1·3 으로 평행사변형을 만들어 그린다(원근의 휨은 무시). 침식은 그만큼 옅게, 노이즈는 없음
  function canvas2d(atlas) {
    const sh = shapes();
    const tint = new Map();
    const src = fr => (fr.tex === 1 ? sh.canvas : atlas);
    function tinted(fr, c) {
      const key = fr.u0 + "," + fr.v0 + "," + fr.tex + ":" + c.map(x => Math.round(Math.min(1, x) * 15)).join("");
      let cv = tint.get(key);
      if (cv) return cv;
      const img = src(fr), iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
      const sx = fr.u0 * iw, sy = fr.v0 * ih, sw = (fr.u1 - fr.u0) * iw, shh = (fr.v1 - fr.v0) * ih;
      cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(sw)); cv.height = Math.max(1, Math.round(shh));
      const g = cv.getContext("2d");
      g.drawImage(img, sx, sy, sw, shh, 0, 0, cv.width, cv.height);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = "rgb(" + c.map(x => Math.round(Math.min(1, x) * 255)).join(",") + ")";
      g.fillRect(0, 0, cv.width, cv.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(img, sx, sy, sw, shh, 0, 0, cv.width, cv.height);
      if (tint.size > 600) tint.clear();
      tint.set(key, cv);
      return cv;
    }
    let ctx = null;
    const draw = {
      quad(q, fr, c, a, add, erode) {
        if (!ctx) return;
        const al = a * (1 - (erode || 0));
        if (al <= 0.01) return;
        const img = tinted(fr, c);
        ctx.save();
        ctx.globalAlpha = Math.min(1, al);
        ctx.globalCompositeOperation = add > 0.5 ? "lighter" : "source-over";
        ctx.transform(q[2] - q[0], q[3] - q[1], q[6] - q[0], q[7] - q[1], q[0], q[1]);
        ctx.drawImage(img, 0, 0, 1, 1);
        ctx.restore();
      },
    };
    return {
      gl: false,
      frames: sh.frames,
      ground: draw, air: draw,
      use(c) { ctx = c; },
    };
  }

  window.DodgeGL = { create, canvas2d, shapes };
})();
