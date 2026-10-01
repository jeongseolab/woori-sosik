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
    function target(w, h) {
      const t = texture(null);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, fb, w, h };
    }
    function drop(rt) { if (rt) { gl.deleteTexture(rt.t); gl.deleteFramebuffer(rt.fb); } }
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
      RT = { A: target(W, H), h1: target(...s(2)), h2: target(...s(2)), q1: target(...s(4)), q2: target(...s(4)),
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

    // o: { bg, fg (캔버스), waves, shake: {x, y}, ca, dead, hurt, low, bloom }
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
      layer(tFg, o.waves);
      drawBatch(air);
      gl.disable(gl.BLEND);
      // 2) 빛 번짐: 밝은 곳만 1/2 로, 흐리고, 1/4·1/8 로 내리며 또 흐린다
      down(RT.A, RT.h1, 0.72);
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
