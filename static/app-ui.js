// Tier.gg 앱 안내·내려받기(#/items). 아이템 추천은 데스크톱 앱(Tier.gg 앱) 에서 쓴다.
// Tier.gg 웹(지금 이 사이트) 은 티어표·그룹방·듀오·연습장, Tier.gg 앱은 롤과 같이 켜 두는 프로그램이다.
// 웹에서 빌드만 미리 보는 화면은 #/items/web (items-ui.js).
//
// 첫 화면 오른쪽의 데모는 한 판을 그대로 따라간다: 챔프 선택 → 상점 추천 탭 → 게임 중. 아래 단계 줄이 같이 움직이고,
// 단계를 누르면 그 장면으로 간다. 움직임을 줄이는 설정이면 자동으로 넘기지 않는다.

const APP_OS_KO = { windows: "Windows", macos: "macOS" };

// Tier.gg 앱 창 안에서 열렸는가. 앱은 주소에 ?app=1 을 붙여 연다. 앱의 저장 공간은 브라우저와 따로라서
// 한 번 보면 기억해 두고(새로 고침·다른 화면으로 가도 앱 안), 브라우저에는 이 표시가 생기지 않는다
const IN_APP = (() => {
  const flag = /[?&]app=1\b/.test(location.search);
  try {
    if (flag) localStorage.setItem("tiergg-app", "1");
    return localStorage.getItem("tiergg-app") === "1";
  } catch { return flag; }
})();

if (IN_APP) {
  document.documentElement.classList.add("in-app");
  const tag = document.querySelector(".logo-tag");
  if (tag) { tag.textContent = "앱"; tag.title = "Tier.gg 앱"; }
}

// 앱이 열어 둔 함수(app/tiergg_app.py 의 Api). 페이지가 뜬 뒤 조금 있다 생긴다
function appBridge(timeout = 4000) {
  if (window.pywebview && window.pywebview.api) return Promise.resolve(window.pywebview.api);
  return new Promise(resolve => {
    const done = () => resolve(window.pywebview && window.pywebview.api || null);
    window.addEventListener("pywebviewready", done, { once: true });
    setTimeout(done, timeout);
  });
}
// ── 앱 업데이트 띠: 앱이 새 버전을 받아 두면(app/updater.py) 어느 탭에서든 위에 뜬다 ─────────────
// 1.1.1 처럼 자동 업데이트가 없던 앱에는 "이번 한 번만 새로 받아 주세요" 를 보여 준다
async function appUpdateWatch() {
  const api = await appBridge(8000);
  if (!api) return;
  let info = {};
  try { info = await api.info(); } catch { return; }
  if (!api.update_state) {
    const rel = await appLatest();
    const os = /darwin/.test(info.os) ? "macos" : "windows";
    const a = rel && rel.assets && rel.assets[os];
    if (a && appNewer(rel.version, info.version)) {
      appUpdateBar(`새 버전 ${esc(rel.version)}이 나왔어요. 이번 한 번만 새로 받아 지금 파일과 바꿔 주시면, 다음부터는 앱이 알아서 업데이트해요.`,
        `<a class="au-btn" href="${esc(a.url)}" target="_blank" rel="noopener">새 버전 받기</a>`);
    }
    return;
  }
  let shown = "";
  const tick = async () => {
    let st;
    try { st = await api.update_state(); } catch { st = {}; }
    const key = st.state + (st.latest || "");
    if (key !== shown) {
      shown = key;
      if (st.state === "ready") {
        appUpdateBar(`새 버전 ${esc(st.latest)}을 받아 뒀어요. 다시 시작하면 바뀌어요.`,
          `<button type="button" class="au-btn" data-restart>지금 다시 시작</button>`);
        const b = document.querySelector("[data-restart]");
        if (b) b.onclick = async () => { b.disabled = true; b.textContent = "다시 켜는 중…"; if (!(await api.restart())) b.textContent = "앱을 닫았다가 다시 켜 주세요"; };
      } else if (st.state === "manual" && st.url) {
        const why = st.reason === "translocated" ? "앱을 응용 프로그램 폴더로 옮기면 다음부터 알아서 업데이트돼요."
          : st.reason === "readonly" ? "앱이 있는 폴더에 쓸 수 없어서 직접 받아야 해요." : "";
        appUpdateBar(`새 버전 ${esc(st.latest)}이 나왔어요. ${why}`, `<a class="au-btn" href="${esc(st.url)}" target="_blank" rel="noopener">새 버전 받기</a>`);
      } else if (st.state === "error" && st.url) {
        appUpdateBar(`새 버전 ${esc(st.latest)}을 자동으로 받지 못했어요.`, `<a class="au-btn" href="${esc(st.url)}" target="_blank" rel="noopener">직접 받기</a>`);
      } else {
        appUpdateBar(null);
      }
    }
    if (st.state !== "ready") setTimeout(tick, st.state === "downloading" || st.state === "checking" || st.state === "idle" ? 3000 : 60000);
  };
  tick();
}

function appNewer(a, b) {
  const pa = String(a || "").split(".").map(Number), pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function appUpdateBar(text, action = "") {
  let bar = document.querySelector(".au-bar");
  if (!text) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "au-bar";
    bar.setAttribute("role", "status");
    document.body.prepend(bar);
  }
  bar.innerHTML = `<p>${text}</p>${action}`;
}

if (IN_APP) appUpdateWatch();
const APP_SCENE_MS = 7000;
let appRelease;                 // /api/app/latest 결과(한 번만 받는다)

function appDetectOs() {
  const ua = navigator.userAgent || "";
  if (/android|iphone|ipad|ipod|mobile/i.test(ua)) return "mobile";
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ua;
  if (/mac/i.test(p)) return "macos";
  if (/win/i.test(p)) return "windows";
  return "other";
}

async function appLatest() {
  if (appRelease === undefined) {
    try {
      const res = await fetch("/api/app/latest");
      appRelease = res.ok ? await res.json() : null;
    } catch { appRelease = null; }
  }
  return appRelease;
}

function appSize(bytes) {
  return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + "MB" : Math.max(1, Math.round(bytes / 1e3)) + "KB";
}

function appDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

const appItem = (id, cls = "") => `<img class="${cls}" src="/items/icons/${id}.png" alt="" width="40" height="40" loading="lazy">`;
const appChamp = key => `<img src="${esc(champImg(key))}" alt="" width="44" height="44" loading="lazy">`;

const APP_STEPS = [
  { key: "select", title: "챔프 선택", text: "내 픽과 상대 조합으로 빌드를 정해 상점 추천 탭에 넣어요" },
  { key: "shop", title: "게임 시작", text: "상점을 열면 추천 탭에 Tier.gg 빌드가 있어요. 전체 화면에서도 보여요" },
  { key: "game", title: "귀환할 때마다", text: "지금 골드와 가방을 읽고 이번에 살 하위템을 알려 줘요" },
];

function appStage() {
  const build = [2523, 3006, 3085, 3031, 3033, 3072];
  const mine = ["Garen", "LeeSin", "Ahri", "Jinx", "Leona"];
  const theirs = ["Aatrox", "Khazix", "Zed", "Draven", "Soraka"];
  return `
    <div class="ap-stage" data-scene="select" aria-label="Tier.gg 앱이 한 판 동안 하는 일(예시)">
      <svg class="ap-rift" viewBox="0 0 640 440" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path d="M-20 360 C 140 300, 220 330, 330 230 S 520 90, 680 70" />
        <path d="M-20 400 C 160 350, 250 370, 350 270 S 540 130, 680 110" />
      </svg>

      <div class="ap-scene" data-for="select" aria-hidden="true">
        <div class="ap-teams">
          <ol class="ap-team">${mine.map((k, i) => `<li class="${k === "Jinx" ? "me" : ""}" style="--i:${i}">${appChamp(k)}</li>`).join("")}</ol>
          <span class="ap-vs">VS</span>
          <ol class="ap-team them">${theirs.map((k, i) => `<li style="--i:${i}">${appChamp(k)}</li>`).join("")}</ol>
        </div>
      </div>

      <div class="ap-scene" data-for="shop" aria-hidden="true">
        <div class="ap-shop">
          <div class="ap-shop-tabs"><b>추천</b><span>전체 아이템</span></div>
          <p class="ap-shop-title">Tier.gg · 징크스 원딜</p>
          <div class="ap-block" style="--i:0"><small>시작 아이템</small><div>${appItem(1086)}${appItem(2003)}</div></div>
          <div class="ap-block" style="--i:1"><small>빌드 순서</small><div>${build.map(i => appItem(i)).join("")}</div></div>
          <div class="ap-block" style="--i:2"><small>먼저 올릴 하위템 (치유 감소)</small><div>${appItem(3123)}</div></div>
        </div>
      </div>

      <div class="ap-scene" data-for="game" aria-hidden="true">
        <div class="ap-hud"><span class="ap-clock">8:51</span><span class="ap-gold"><i></i><b>1,180</b></span></div>
      </div>

      <div class="ap-window" aria-hidden="true">
        <div class="ap-w-select">
          <b class="ap-w-head">챔프 선택 · 징크스</b>
          <small>원딜 · 확정 · 적 <span class="ap-w-count">0</span>명 공개</small>
          <div class="ap-w-build">${build.map((i, n) => appItem(i, "ap-pop") .replace("<img", `<img style="--i:${n}"`)).join("")}</div>
          <small class="ap-w-done">상점 추천 탭에 넣었어요</small>
        </div>
        <div class="ap-w-game">
          <b class="ap-w-head">징크스 · <span class="ap-w-gold">1,180</span>골드</b>
          <small>9:00 · vs 드레이븐</small>
          <div class="ap-w-row" style="--i:0">${appItem(1018)}<span>민첩성의 망토 <em>600골드</em><small>→ 마법광학 장치 C44</small></span></div>
          <div class="ap-w-row" style="--i:1">${appItem(3123)}<span>처형인의 대검 <em>800골드</em><small>→ 필멸자의 운명 · 맞라인 소라카 회복</small></span></div>
        </div>
      </div>
    </div>
    <ol class="ap-steps" role="tablist" aria-label="한 판 동안">
      ${APP_STEPS.map((s, i) => `
        <li><button type="button" role="tab" data-step="${s.key}" aria-selected="${i === 0}">
          <span class="ap-step-n">${i + 1}</span><b>${s.title}</b><small>${s.text}</small><i class="ap-step-bar"></i>
        </button></li>`).join("")}
    </ol>`;
}

function appDownloadButtons(os) {
  const primary = os === "macos" ? "macos" : "windows";
  const other = primary === "windows" ? "macos" : "windows";
  return `
    <div class="ap-get" data-primary="${primary}">
      <a class="ap-dl" data-os="${primary}" href="#" aria-disabled="true">
        <span class="ap-dl-fill" aria-hidden="true"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16" /></svg>
        <span class="ap-dl-text">${APP_OS_KO[primary]}용 받기</span>
      </a>
      <p class="ap-meta" aria-live="polite"><span>최신 버전을 확인하는 중이에요</span></p>
      <p class="ap-other">${os === "mobile" ? "앱은 PC에서 받아 주세요. " : ""}<a class="ap-dl-alt" data-os="${other}" href="#">${APP_OS_KO[other]}용 받기</a></p>
    </div>`;
}

function appInstall(os) {
  const tab = os === "macos" ? "macos" : "windows";
  const steps = {
    windows: [
      ["받은 파일 열기", "<code>Tier.gg.exe</code>를 두 번 눌러요. 설치 없이 바로 켜져요."],
      ["처음 한 번만", "\"Windows의 PC 보호\" 창이 뜨면 <b>추가 정보</b>를 누르고 <b>실행</b>을 눌러요. 서명 인증서를 아직 붙이지 않아서 떠요."],
      ["롤 화면 설정", "롤 설정 → 비디오 → 창 모드를 <b>테두리 없음</b>으로 바꿔요. 전체 화면이면 작은 창이 롤 뒤로 숨어요(상점 추천 탭은 그대로 보여요)."],
    ],
    macos: [
      ["압축 풀기", "<code>Tier.gg.zip</code>을 풀고 Tier.gg를 응용 프로그램 폴더로 옮겨요."],
      ["처음 한 번만", "Tier.gg를 <b>Control-클릭 → 열기</b>로 열어요. \"확인되지 않은 개발자\" 창에서 <b>열기</b>를 누르면 다음부터는 그냥 켜져요."],
      ["롤 화면 설정", "롤 설정 → 비디오 → 창 모드를 <b>테두리 없음</b>으로 바꿔요."],
    ],
  };
  return `
    <section class="ap-install" id="ap-install" aria-labelledby="ap-install-h">
      <div class="ap-install-head">
        <h2 id="ap-install-h">설치</h2>
        <div class="seg" role="tablist" aria-label="운영체제">
          ${["windows", "macos"].map(k => `<button type="button" role="tab" data-install="${k}" aria-selected="${k === tab}">${APP_OS_KO[k]}</button>`).join("")}
        </div>
      </div>
      ${["windows", "macos"].map(k => `
        <ol class="ap-install-steps" data-install-for="${k}" ${k === tab ? "" : "hidden"}>
          ${steps[k].map(([t, d]) => `<li><b>${t}</b><p>${d}</p></li>`).join("")}
        </ol>`).join("")}
      <p class="note">앱 창에서 웹과 같은 계정으로 로그인해요. 켜 두기만 하면 롤 클라이언트와 게임을 알아서 찾아요. 게임 중 작은 창은 끌어서 옮기고 오른쪽 클릭으로 닫아요. 앱 창을 닫으면 작은 창도 같이 꺼져요.</p>
    </section>`;
}

const APP_FAQ = [
  ["웹과 앱 계정이 같나요?", "같아요. 앱 창은 Tier.gg 웹을 그대로 띄운 거라 티어표·그룹방·듀오 기록이 웹과 똑같이 보여요. 처음 한 번만 앱에서 로그인하면 돼요."],
  ["계정이 정지되지 않나요?", "Tier.gg 앱은 라이엇이 공개한 게임 정보(Live Client Data)와 클라이언트의 아이템 세트 기능만 써요. 게임 화면을 읽거나 조작하지 않고, 챔피언을 대신 고르지도 않아요. OP.GG·Porofessor 같은 앱과 같은 방식이에요."],
  ["전체 화면에서도 보이나요?", "상점 추천 탭의 빌드는 롤 안에 있어서 항상 보여요. 귀환할 때 뜨는 작은 창은 테두리 없음 창 모드에서만 롤 위에 떠요."],
  ["상점에 넣은 빌드를 지우고 싶어요", "Tier.gg 세트는 하나만 만들고 판마다 덮어써요. 직접 만든 아이템 세트는 건드리지 않아요. 완전히 지우려면 명령줄에서 <code>--remove-itemset</code>으로 켜요."],
  ["추천이 이상하거나 앱이 안 켜져요", "앱이 남긴 기록을 보내 주세요. Windows는 <code>%APPDATA%\\TierGG\\app.log</code>, macOS는 <code>~/Library/Application Support/TierGG/app.log</code>예요."],
];

async function renderAppLanding() {
  const seq = routeSeq;
  const os = appDetectOs();
  view.innerHTML = `
    <div class="ap">
      <section class="ap-hero">
        <div class="ap-copy">
          <p class="ap-kind"><span class="ap-app-mark" aria-hidden="true"></span>Tier.gg 앱 전용</p>
          <h1>귀환할 때마다<br>살 템이 떠요</h1>
          <p class="ap-lead">아이템 추천은 PC에 까는 Tier.gg 앱에서 써요. 앱에는 웹의 티어표·그룹방·듀오 궁합·연습장이 그대로 있고, 롤과 같이 켜 두면 챔프 선택에서 빌드를 상점 추천 탭에 넣고 게임 중에는 이번에 살 하위템을 알려 줘요. 따로 입력할 건 없어요.</p>
          ${appDownloadButtons(os)}
        </div>
        <div class="ap-show">${appStage()}</div>
      </section>

      <section class="ap-split" aria-label="웹과 앱">
        <div><h2>Tier.gg 웹</h2><p>지금 보는 사이트예요. 티어표, 그룹방, 듀오 궁합, 연습장을 브라우저로 어디서나 써요.</p></div>
        <div><h2>Tier.gg 앱</h2><p>웹의 기능을 모두 담고 아이템 추천을 더했어요. 같은 계정으로 로그인하고, 롤을 하는 PC에서 켜 둬요. 게임 정보는 내 PC 안에서만 읽어요.</p></div>
      </section>

      ${appInstall(os)}

      <section class="ap-faq" aria-labelledby="ap-faq-h">
        <h2 id="ap-faq-h">알아 둘 것</h2>
        ${APP_FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}
      </section>

      <p class="ap-web-link">앱 없이 빌드만 보고 싶으면 <a href="#/items/web">웹에서 미리 보기</a>를 써요. 시간·상대 조합·골드를 직접 넣어야 해요.</p>
    </div>`;

  appRunStage(seq);
  appWireInstall();
  const rel = await appLatest();
  if (seq !== routeSeq) return;
  appWireDownloads(rel);
}

function appWireDownloads(rel) {
  const box = view.querySelector(".ap-get");
  if (!box) return;
  const meta = box.querySelector(".ap-meta");
  const assets = (rel && rel.assets) || {};
  const primary = box.querySelector(".ap-dl");
  const asset = assets[primary.dataset.os];
  if (rel && rel.version) {
    meta.innerHTML = `<span>버전 ${esc(rel.version)}</span>${asset ? `<span>${appSize(asset.size)}</span>` : ""}<span>무료</span>${rel.published_at ? `<span>${appDate(rel.published_at)}</span>` : ""}`;
  } else {
    meta.innerHTML = `<span>첫 버전을 준비하고 있어요. 곧 받을 수 있어요.</span>`;
  }
  for (const a of box.querySelectorAll("[data-os]")) {
    const file = assets[a.dataset.os];
    if (!file) {
      a.setAttribute("aria-disabled", "true");
      a.removeAttribute("href");
      if (a === primary) a.querySelector(".ap-dl-text").textContent = APP_OS_KO[a.dataset.os] + "용 준비 중";
      else a.textContent = APP_OS_KO[a.dataset.os] + "용 준비 중";
      continue;
    }
    a.href = file.url;
    a.removeAttribute("aria-disabled");
    a.setAttribute("download", file.name);
    a.onclick = e => {
      if (a !== primary) return;            // 작은 링크는 그냥 받는다
      e.preventDefault();
      if (primary.classList.contains("going")) return;
      // 누르면 버튼이 차오르고, 다 차면 받기를 시작한다. 그다음 설치 순서로 데려간다
      primary.classList.add("going");
      primary.querySelector(".ap-dl-text").textContent = "받는 중";
      setTimeout(() => {
        location.href = file.url;
        primary.classList.remove("going");
        primary.classList.add("done");
        primary.querySelector(".ap-dl-text").textContent = "받았어요. 다시 받기";
        const tab = view.querySelector(`[data-install="${a.dataset.os}"]`);
        if (tab) tab.click();
        const inst = document.getElementById("ap-install");
        if (inst) {
          inst.classList.add("lit");
          inst.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        }
      }, 900);
    };
  }
}

function appWireInstall() {
  for (const b of view.querySelectorAll("[data-install]")) {
    b.onclick = () => {
      for (const x of view.querySelectorAll("[data-install]")) x.setAttribute("aria-selected", String(x === b));
      for (const ol of view.querySelectorAll("[data-install-for]")) ol.hidden = ol.dataset.installFor !== b.dataset.install;
    };
  }
}

// 데모: 장면마다 data-scene 을 바꾸고, 그 장면 안의 숫자(공개된 적·골드·시간) 를 센다. 다른 화면으로 가면 멈춘다
function appRunStage(seq) {
  const stage = view.querySelector(".ap-stage");
  if (!stage) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const keys = APP_STEPS.map(s => s.key);
  const timers = [];
  const box = stage.parentElement;     // 단계 줄도 같은 상자 안에서만 찾는다(화면을 다시 그리면 예전 데모는 멈춘다)
  const alive = () => seq === routeSeq && stage.isConnected;
  const later = (fn, ms) => timers.push(setTimeout(() => { if (alive()) fn(); }, ms));
  let at = 0;

  const play = (k, auto) => {
    timers.splice(0).forEach(clearTimeout);
    at = keys.indexOf(k);
    stage.dataset.scene = k;
    stage.classList.remove("run");
    void stage.offsetWidth;            // 같은 장면을 다시 눌러도 처음부터
    stage.classList.add("run");
    for (const b of box.querySelectorAll("[data-step]")) {
      b.setAttribute("aria-selected", String(b.dataset.step === k));
      b.classList.toggle("auto", auto && !reduce);
    }
    const count = stage.querySelector(".ap-w-count");
    const goldEls = [stage.querySelector(".ap-gold b"), stage.querySelector(".ap-w-gold")];
    const clock = stage.querySelector(".ap-clock");
    if (k === "select") {
      count.textContent = reduce ? "5" : "0";
      if (!reduce) for (let i = 1; i <= 5; i++) later(() => { count.textContent = String(i); }, 500 + i * 420);
    }
    if (k === "game") {
      const from = 1180, to = 1400, steps = 11;
      const show = n => {
        const g = Math.round(from + (to - from) * n / steps).toLocaleString();
        goldEls.forEach(el => { el.textContent = g; });
        const s = 51 + Math.round(9 * n / steps);
        clock.textContent = s >= 60 ? "9:00" : "8:" + String(s).padStart(2, "0");
      };
      if (reduce) show(steps);
      else { show(0); for (let n = 1; n <= steps; n++) later(() => show(n), 300 + n * 160); }
    }
    if (auto && !reduce) later(() => play(keys[(at + 1) % keys.length], true), APP_SCENE_MS);
  };

  for (const b of box.querySelectorAll("[data-step]")) b.onclick = () => play(b.dataset.step, false);
  // 화면 밖에 있을 때는 멈춰 둔다(다른 탭에서 계속 돌지 않게)
  document.addEventListener("visibilitychange", function onVis() {
    if (!alive()) return document.removeEventListener("visibilitychange", onVis);
    if (document.hidden) timers.splice(0).forEach(clearTimeout);
    else play(keys[at], true);
  });
  play(reduce ? "game" : "select", true);
}


// ── 앱 안에서 연 "아이템 추천" 탭: 내려받기 안내 대신 지금 상태 ───────────────
// 작은 창(아이템 추천 프로세스) 이 남긴 상태를 1.5초마다 읽어 그린다. 작은 창을 닫았으면 다시 켤 수 있다

async function renderAppHome() {
  const seq = routeSeq;
  view.innerHTML = `
    <div class="ap ah">
      <section class="ah-head">
        <div>
          <p class="ap-kind"><span class="ap-app-mark" aria-hidden="true"></span>Tier.gg 앱</p>
          <h1>아이템 추천</h1>
          <p class="ap-lead">롤과 같이 켜 두면 알아서 움직여요. 챔프 선택에서는 빌드를 상점 추천 탭에 넣고, 게임 중에는 작은 창에 이번에 살 것을 띄워요.</p>
        </div>
      </section>
      <section class="ah-live" aria-live="polite"><div class="ah-card">${funLoader("앱과 연결하는 중이에요.", true)}</div></section>
      <ol class="ap-steps ah-steps" aria-label="한 판 동안">
        ${APP_STEPS.map((s, i) => `<li><div class="ah-step" data-step="${s.key}"><span class="ap-step-n">${i + 1}</span><b>${s.title}</b><small>${s.text}</small></div></li>`).join("")}
      </ol>
      <p class="ap-web-link">게임 밖에서 빌드를 미리 보려면 <a href="#/items/web">웹 미리보기</a>를 써요.</p>
    </div>`;
  const api = await appBridge();
  if (seq !== routeSeq) return;
  const card = view.querySelector(".ah-card");
  if (!api) {
    card.innerHTML = `<div class="ah-empty"><b>앱과 연결하지 못했어요</b><p>Tier.gg 앱을 다시 켜 주세요. 계속 안 되면 앱 폴더의 app.log를 보내 주세요.</p></div>`;
    return;
  }
  let last = "";
  const tick = async () => {
    if (seq !== routeSeq || !card.isConnected) return;
    let st;
    try { st = await api.status(); } catch { st = { mode: "wait", text: "상태를 읽지 못했어요" }; }
    const key = JSON.stringify({ ...st, at: 0 });
    if (key !== last) {
      last = key;
      card.innerHTML = appHomeCard(st);
      const btn = card.querySelector("[data-show-overlay]");
      if (btn) btn.onclick = async () => { btn.disabled = true; await api.show_overlay(); setTimeout(tick, 600); };
      for (const el of view.querySelectorAll(".ah-step")) {
        const on = (st.mode === "select" && el.dataset.step === "select") || (st.mode === "game" && el.dataset.step === "game");
        el.classList.toggle("on", on);
      }
    }
    setTimeout(tick, 1500);
  };
  tick();
}

function appHomeCard(st) {
  const icons = ids => `<div class="ah-icons">${ids.map(i => appItem(i)).join("")}</div>`;
  const off = st.overlay === false ? `
    <div class="ah-off"><span>작은 창이 꺼져 있어요. 켜야 게임 중에 이번에 살 것이 떠요.</span>
      <button type="button" data-show-overlay>작은 창 켜기</button></div>` : "";
  if (st.mode === "select") {
    return `${off}
      <div class="ah-row"><span class="ah-dot select" aria-hidden="true"></span><div>
        <b class="ah-title">챔프 선택 · ${esc(st.champion)}</b>
        <small>${esc(st.status || "빌드를 준비하고 있어요")}${st.locked === false ? " (고민 중인 챔피언 기준)" : ""}</small></div></div>
      <h2 class="ah-sub">상점 추천 탭에 넣은 빌드</h2>${icons(st.build || [])}
      ${(st.parts || []).length ? `<h2 class="ah-sub">먼저 올릴 하위템</h2><div class="ah-buy">${st.parts.map(([id, why]) => `<div>${appItem(id)}<span><b>${esc((itemData && itemData.items && itemData.items[id] || {}).name || "")}</b><small>${esc(why)}</small></span></div>`).join("")}</div>` : ""}
      ${appHomeReasons(st)}`;
  }
  if (st.mode === "game") {
    return `${off}
      <div class="ah-row"><span class="ah-dot game" aria-hidden="true"></span><div>
        <b class="ah-title">${esc(st.text)}</b><small>${esc(st.situation || "")}</small></div></div>
      <h2 class="ah-sub">이번에 살 것</h2>
      ${(st.buy || []).length ? `<div class="ah-buy">${st.buy.map(b => `<div>${appItem(b.id)}<span><b>${esc(b.name)} <em>${b.cost.toLocaleString()}골드</em></b>${b.toward ? `<small>→ ${esc(b.toward)}</small>` : ""}</span></div>`).join("")}</div>`
        : `<p class="note">지금 골드로는 다음 재료를 못 사요.</p>`}
      ${(st.sell || []).length ? `<p class="note">칸이 모자라 팔 것: ${st.sell.map(esc).join(", ")}</p>` : ""}
      <h2 class="ah-sub">빌드</h2><div class="ah-icons">${(st.build || []).map(i => appItem(i, (st.owned || []).includes(i) ? "own" : "")).join("")}</div>
      ${appHomeReasons(st)}`;
  }
  return `${off}
    <div class="ah-row"><span class="ah-dot" aria-hidden="true"></span><div>
      <b class="ah-title">${esc(st.text || "게임을 기다리는 중이에요")}</b>
      <small>큐를 돌리면 챔프 선택부터 알아서 시작해요. 롤 클라이언트가 꺼져 있으면 켜 주세요.</small></div></div>`;
}

function appHomeReasons(st) {
  return (st.reasons || []).length ? `<ul class="ib-why ah-why">${st.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
}
