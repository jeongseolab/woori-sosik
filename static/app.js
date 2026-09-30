// Tier.gg 화면.
// 주소 뒤의 # 로 화면을 바꾼다.
//   #/tier            내 티어표
//   #/tier/이름#태그   다른 사람 티어표
//   #/rooms           그룹방 목록
//   #/rooms/3         3번 방
//   #/duo             듀오 궁합 (#/duo/이름#태그 면 바로 비교)

const view = document.getElementById("view");
const TOKEN_KEY = "mytier-token";
let me = null;
let lastRooms = [];   // 듀오 화면에서 친구를 고르기 쉽게 기억해 둔다

// ── 작은 도구 ───────────────────────────────────────────

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function pct(x) { return x == null ? "-" : Math.round(x * 100) + "%"; }
function num(x, digits = 1) { return x == null ? "-" : Number(x).toFixed(digits); }

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith("/api/login")) {
    setToken(null);
    me = null;
    forgetAll();
    warmed = false;
    location.hash = "#/login";
  }
  if (!res.ok) {
    const detail = data && data.detail;
    const err = new Error(typeof detail === "string" ? detail : "요청을 처리하지 못했습니다");
    // 닉네임 변경 확인처럼 화면이 따로 받아 처리할 대답이 있다
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── 한 번 받은 것은 기억해 둔다 ─────────────────────────
// 화면을 옮길 때마다 다시 받지 않는다. 새로 받는 건 새로고침(또는 "최신 전적으로" 버튼) 때뿐.
// 받는 중인 것도 기억해서, 그 화면을 떠났다 돌아와도 같은 요청을 이어서 기다린다.
const memo = new Map();   // 주소 -> Promise
const memoDone = new Map();   // 주소 -> 다 받은 값. 있으면 로딩 화면 없이 바로 그린다

// fresh 면 OP.GG 에서 새로 받게 하고, 받은 것으로 기억을 바꾼다
function load(path, fresh = false) {
  if (!fresh && memo.has(path)) return memo.get(path);
  const url = fresh ? path + (path.includes("?") ? "&" : "?") + "fresh=1" : path;
  const p = api(url);
  memo.set(path, p);
  p.then(d => { if (memo.get(path) === p) memoDone.set(path, d); },
         () => { if (memo.get(path) === p) memo.delete(path); });   // 실패는 기억하지 않는다
  return p;
}

// 이미 다 받은 값(없으면 undefined)
function known(path) { return memoDone.get(path); }

// 바뀐 것을 잊는다. test 에 맞는 주소를 모두 지운다
function forget(test) {
  for (const k of [...memo.keys()]) {
    if (typeof test === "string" ? k === test : test.test(k)) { memo.delete(k); memoDone.delete(k); }
  }
}

function forgetAll() { memo.clear(); memoDone.clear(); }

// 서버가 돌려준 새 값을 그대로 기억한다(다시 물어볼 필요 없게)
function remember(path, data) {
  const p = Promise.resolve(data);
  memo.set(path, p);
  memoDone.set(path, data);
}

// 로그인하면 자주 보는 것들을 뒤에서 미리 받아 둔다.
// 내 티어표 -> 방 목록 -> 방마다 사람 카드 -> 그 방의 주간 랭킹·무빙 순위
let warmed = false;
async function warmUp() {
  if (warmed) return;
  warmed = true;
  const quiet = p => p.catch(() => null);
  load("/api/dodge/me").catch(() => {});
  await quiet(load("/api/tierlist"));
  const rooms = await quiet(loadRooms());
  for (const r of rooms || []) {
    const room = await quiet(load("/api/rooms/" + r.id + "?lite=1"));
    if (!room) continue;
    // 방 하나의 카드는 한꺼번에(방 화면과 같다). 다 오면 새 판이 쌓였으니 주간 랭킹을 받는다
    await Promise.all(room.members.map(m => quiet(load("/api/rooms/" + r.id + "/member/" + m.account_id))));
    load("/api/rooms/" + r.id + "/weekly").catch(() => {});
    load("/api/rooms/" + r.id + "/dodge").catch(() => {});
    load("/api/rooms/" + r.id + "/members").catch(() => {});   // 듀오 궁합의 친구 고르기
  }
}

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
}

function rankText(rank) {
  if (!rank) return "랭크 기록 없음";
  const high = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(rank.tier);
  return rank.queue + " " + rank.tier_ko + (high ? "" : " " + rank.division) + " · " + rank.lp + "LP";
}

function tierHref(riotId) { return "#/tier/" + encodeURIComponent(riotId); }
function duoHref(riotId) { return "#/duo/" + encodeURIComponent(riotId); }

// 기다리는 동안 돌아가며 보여 줄 한 줄. 협곡에서 흔히 보는 장면들
const QUIPS = [
  "미니언 막타 치는 중…",
  "정글러가 부쉬에서 기다리는 중…",
  "OP.GG 에 와드 박는 중…",
  "용 타이머 계산하는 중…",
  "바론 버스 출발 기다리는 중…",
  "OP 후보 면접 보는 중…",
  "KDA 하나하나 세는 중…",
  "포탑 다이브 각 재는 중…",
  "귀환 중… 8초만요",
  "서폿이 와드 사는 중…",
];
// 닉네임을 새로 반영하는 동안. 상점과 컬렉션에서 흔히 하는 일들
const RENAME_QUIPS = [
  "코어 템 구매하는 중…",
  "스킨 변경하는 중…",
  "크로마 구매하는 중…",
  "소환사 아이콘 고르는 중…",
  "닉네임 변경권 쓰는 중…",
  "와드 스킨 갈아 끼우는 중…",
  "룬 페이지 다시 짜는 중…",
  "감정 표현 휠 정리하는 중…",
];
const QUIP_SETS = { tier: QUIPS, rename: RENAME_QUIPS };
const quipAt = {};
function nextQuip(set = "tier") {
  const list = QUIP_SETS[set] || QUIPS;
  const at = quipAt[set];
  quipAt[set] = at == null ? Math.floor(Math.random() * list.length) : (at + 1) % list.length;
  return list[quipAt[set]];
}

// 화면에 .quip 이 있을 때만 1.8초마다 문구를 바꾼다. 어느 묶음인지는 data-quips 로 안다
setInterval(() => {
  const els = document.querySelectorAll(".quip");
  if (!els.length) return;
  els.forEach(el => { el.textContent = nextQuip(el.dataset.quips); });
}, 1800);

// 티어표가 채워지는 모양의 로딩. 칸마다 챔피언 자리가 차례로 톡톡 들어온다
function funLoader(sub, small = false, quips = "tier") {
  return `
    <div class="fun-loader ${small ? "small" : ""}" role="status" aria-live="polite">
      <div class="fl-board" aria-hidden="true">
        ${["1", "2", "3", "4", "5"].slice(0, small ? 3 : 5).map(t =>
          `<div class="fl-row" data-t="${t}"><b>${t}</b><span><i></i><i></i><i></i></span></div>`).join("")}
      </div>
      <p class="quip" data-quips="${quips}">${esc(nextQuip(quips))}</p>
      ${sub ? `<p class="note">${esc(sub)}</p>` : ""}
    </div>`;
}

function loading(message, target = view) {
  target.innerHTML = funLoader(message);
}

// 옛 닉네임으로 로그인해 있는데 닉네임이 바뀐 경우. 새 닉네임으로 로그인하면 옮겨 준다
function renamedNotice(target = view) {
  target.innerHTML = `
    <div class="empty-state">
      <strong>LOL 닉네임이 바뀐 것 같아요</strong>
      <p>로그아웃한 뒤 <b>새 닉네임</b>과 지금 비밀번호로 로그인하면, 전적과 그룹방은 그대로 두고 닉네임만 바꿔 드려요.</p>
      <button type="button" class="relogin">새 닉네임으로 로그인</button>
    </div>`;
  target.querySelector(".relogin").onclick = () => document.getElementById("logout").click();
}

function failed(message, retry, target = view) {
  target.innerHTML = `
    <div class="empty-state">
      <strong>${esc(message)}</strong>
      <p>잠시 뒤 다시 시도해 주세요.</p>
      <button type="button" class="retry">다시 불러오기</button>
    </div>`;
  target.querySelector(".retry").onclick = retry;
}

// ── 다른 사람 티어표 팝업 ───────────────────────────────
// 그룹방에서 누군가의 티어표를 열면 방 화면 위에 창을 띄운다. 닫으면 방 화면 그대로다
function openPlayer(riotId) {
  closePlayer();
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.setAttribute("aria-label", riotId + " 티어표");
  dlg.innerHTML = `
    <div class="modal-box">
      <header class="modal-head">
        <button type="button" class="icon-btn" data-close aria-label="그룹방으로 돌아가기">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
        <b>${esc(riotId.split("#")[0])} 님의 티어표</b>
        <button type="button" class="icon-btn" data-close aria-label="닫기">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </header>
      <div class="modal-body"></div>
    </div>`;
  document.body.appendChild(dlg);
  // 바깥(어두운 곳) 을 누르거나, ← / ✕ 를 누르면 닫는다
  dlg.addEventListener("click", e => {
    if (e.target === dlg || e.target.closest("[data-close]")) dropModal(dlg);
  });
  // Esc 는 브라우저가 닫는다. 그때도 뒷정리를 한다.
  // close 신호는 늦게 올 수 있어서, 이 창 하나만 치운다(그새 새로 연 창은 건드리지 않게)
  dlg.addEventListener("close", () => dropModal(dlg));
  document.body.classList.add("modal-open");
  dlg.showModal();
  renderTier(riotId, false, dlg.querySelector(".modal-body"), true);
}

// 창 하나를 닫고 치운다. 이미 치운 창이면 아무것도 안 한다
function dropModal(dlg) {
  if (!dlg.isConnected) return;
  if (dlg.open) dlg.close();
  dlg.remove();
  if (!document.querySelector("dialog.modal")) document.body.classList.remove("modal-open");
}

function closePlayer() {
  document.querySelectorAll("dialog.modal").forEach(dropModal);
}
// 창 안에서 다른 화면(듀오 궁합 등) 으로 가면 창은 닫는다
window.addEventListener("hashchange", closePlayer);

// ── 작은 확인 창 ────────────────────────────────────────
// 티어표 팝업(dialog.modal) 과 섞이지 않게 dialog.ask 로 따로 띄운다

function openAsk(html, label) {
  const dlg = document.createElement("dialog");
  dlg.className = "ask";
  dlg.setAttribute("aria-label", label);
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// 닉네임이 바뀌었는지 묻는다. "예" 면 true
function askRename(oldId, newId) {
  return new Promise(resolve => {
    const dlg = openAsk(`
      <div class="ask-box">
        <h2>닉네임 변경 확인</h2>
        <p class="rename-pair">
          <span class="old">${esc(oldId)}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <b>${esc(newId)}</b>
        </p>
        <p>이름이 변경되었습니까? <b>예</b>를 누르면 Tier.gg 계정도 새 닉네임으로 바꿔요. 전적과 그룹방은 그대로예요.</p>
        <div class="ask-actions">
          <button type="button" class="ghost" value="no">아니요</button>
          <button type="button" value="yes">예</button>
        </div>
      </div>`, "닉네임 변경 확인");
    let answer = false;
    dlg.querySelectorAll("button").forEach(b => b.onclick = () => {
      answer = b.value === "yes";
      dlg.close();
    });
    // Esc 로 닫으면 "아니요" 로 본다
    dlg.addEventListener("close", () => resolve(answer));
    dlg.querySelector('button[value="yes"]').focus();
  });
}

// 기다리는 동안 띄워 두는 창. 돌려준 함수를 부르면 닫힌다
function showBusy(title, quips) {
  const dlg = openAsk(`
    <div class="ask-box">
      <h2>${esc(title)}</h2>
      ${funLoader("", true, quips)}
    </div>`, title);
  // 일하는 중에는 Esc 로 닫히지 않게 한다
  dlg.addEventListener("cancel", e => e.preventDefault());
  return () => { if (dlg.open) dlg.close(); };
}

// ── 길 찾기 ─────────────────────────────────────────────

async function route() {
  const hash = location.hash || "#/tier";
  const [, page, arg] = hash.match(/^#\/([^/]*)\/?(.*)$/) || [];

  if (!me && getToken()) {
    try { me = (await api("/api/me")).user; } catch { me = null; }
  }
  if (!me) {
    showTop(false);
    return renderGate();
  }
  showTop(true, page);
  // 지금 화면이 먼저 받게 한 박자 늦게 시작한다
  setTimeout(warmUp, 300);

  const target = arg ? decodeURIComponent(arg) : "";
  // 다른 화면으로 가면 돌던 게임은 멈춘다
  stopDodge();
  if (page === "rooms") return renderRooms(target);
  if (page === "duo") return renderDuo(target);
  if (page === "dodge") return renderDodge(target);
  return renderTier(target);
}

function showTop(on, page) {
  const top = document.getElementById("top");
  top.hidden = !on;
  if (!on) return;
  document.getElementById("who-name").textContent = me.riot_id;
  for (const a of top.querySelectorAll(".tabs a")) {
    const current = a.dataset.tab === (page === "login" ? "tier" : page || "tier");
    current ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
}

document.getElementById("logout").onclick = async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  setToken(null);
  me = null;
  // 다른 계정으로 들어올 수 있으니 받아 둔 것을 모두 버린다
  forgetAll();
  warmed = false;
  location.hash = "#/login";
  route();
};

window.addEventListener("hashchange", route);

// ── 로그인 ──────────────────────────────────────────────

// 로그인 화면 왼쪽에 보여 줄 예시 티어표. 실제 챔피언 그림으로 "이런 걸 받는다" 를 보여 준다
const GATE_SAMPLE = {
  op: { key: "Ahri", name: "아리", note: "플레이 78점" },
  rows: [["1", ["Yone", "LeeSin"]], ["2", ["Orianna", "Thresh", "Jax"]], ["3", ["Zed", "Garen"]]],
};
const LAST_ID_KEY = "tiergg-last-id";

function champImg(key) {
  return "https://opgg-static.akamaized.net/meta/images/lol/latest/champion/" + key + ".png";
}

function gateSample() {
  const s = GATE_SAMPLE;
  return `
    <figure class="sample" aria-label="티어표 예시">
      <div class="sample-op">
        <img src="${champImg(s.op.key)}" alt="" width="64" height="64">
        <div><span>OP</span><b>${s.op.name}</b><small>${s.op.note}</small></div>
      </div>
      ${s.rows.map(([t, keys]) => `
        <div class="sample-row" data-t="${t}"><b>${t}</b>
          <span>${keys.map(k => `<img src="${champImg(k)}" alt="" width="36" height="36" loading="lazy">`).join("")}</span></div>`).join("")}
      <figcaption>예시 화면</figcaption>
    </figure>`;
}

function renderGate(mode = "login") {
  const signup = mode === "signup";
  let last = {};
  try { last = JSON.parse(localStorage.getItem(LAST_ID_KEY) || "{}"); } catch {}

  view.innerHTML = `
    <section class="gate">
      <div class="gate-intro">
        <p class="gate-logo"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#f0b429"/><rect x="6" y="7" width="20" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="13.75" width="14" height="4.5" rx="2" fill="#0f1b33"/><rect x="6" y="20.5" width="8" height="4.5" rx="2" fill="#0f1b33"/></svg><span>Tier.gg</span></p>
        <h1>내가 한 챔피언만으로 만드는 티어표</h1>
        <p class="lead">최근 20판에서 판마다 얼마나 잘했는지를 라인과 티어 기준으로 매겨, 나만의 OP와 1~5티어를 정해 줘요.</p>
        <ul class="gate-points">
          <li><b>나만의 티어표</b>승률보다 전투, 성장, 스노우볼 같은 플레이 점수로 줄 세워요.</li>
          <li><b>그룹방</b>초대 코드로 친구들과 모여 지표를 그래프로 비교해요.</li>
          <li><b>듀오 궁합</b>같이 한 판을 찾아 둘이 할 때 더 이기는지 보여 줘요.</li>
        </ul>
      </div>

      <div class="gate-card">
        <div class="seg gate-tabs" role="tablist" aria-label="로그인 또는 가입">
          <button type="button" role="tab" data-mode="login" aria-selected="${!signup}">로그인</button>
          <button type="button" role="tab" data-mode="signup" aria-selected="${signup}">가입하기</button>
        </div>
        <p class="note">${signup
          ? "LOL 계정이 있는지 OP.GG 에서 확인한 뒤 만들어요. 한국 서버 계정만 됩니다."
          : "가입할 때 쓴 LOL ID 와 비밀번호를 넣어 주세요."}</p>
        <form id="gate-form" novalidate>
          <label for="lol-name">LOL ID</label>
          <div class="id-pair">
            <input id="lol-name" name="lol_name" placeholder="닉네임" autocomplete="username"
                   value="${esc(signup ? "" : last.name || "")}" required>
            <span aria-hidden="true">#</span>
            <input id="lol-tag" name="lol_tag" placeholder="KR1" aria-label="태그 (# 뒤)" maxlength="5"
                   value="${esc(signup ? "" : last.tag || "")}" required>
          </div>
          <label for="pw">${signup ? "이 사이트에서 쓸 비밀번호" : "비밀번호"}</label>
          <div class="pw-field">
            <input id="pw" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}"
                   placeholder="${signup ? "6글자 이상" : ""}" required>
            <button type="button" class="pw-toggle" aria-controls="pw" aria-pressed="false">보기</button>
          </div>
          ${signup ? `
          <label for="pw2">비밀번호 확인</label>
          <input id="pw2" name="password2" type="password" autocomplete="new-password" placeholder="한 번 더 입력" required>
          <p class="note">LOL 계정 비밀번호가 아니라 이 사이트에서만 쓰는 비밀번호예요.</p>` : ""}
          <p class="caps" id="caps" hidden>Caps Lock 이 켜져 있어요</p>
          <p class="err" id="gate-err" aria-live="polite"></p>
          <button type="submit">${signup ? "가입하기" : "로그인"}</button>
        </form>
      </div>

      <div class="gate-sample">${gateSample()}</div>
    </section>`;

  view.querySelectorAll(".gate-tabs button").forEach(b => b.onclick = () => {
    if (b.dataset.mode !== mode) renderGate(b.dataset.mode);
  });

  const form = document.getElementById("gate-form");

  // 비밀번호 보기/숨기기 (두 칸 모두)
  const toggle = form.querySelector(".pw-toggle");
  toggle.onclick = () => {
    const show = form.password.type === "password";
    form.password.type = show ? "text" : "password";
    if (form.password2) form.password2.type = form.password.type;
    toggle.textContent = show ? "숨기기" : "보기";
    toggle.setAttribute("aria-pressed", String(show));
  };

  // Caps Lock 이 켜져 있으면 알려 준다(비밀번호 틀리는 흔한 이유)
  const caps = document.getElementById("caps");
  form.addEventListener("keyup", e => {
    if (e.getModifierState) caps.hidden = !e.getModifierState("CapsLock");
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("gate-err");
    const name = form.lol_name.value.trim();
    // 태그 칸에 # 까지 적어도 괜찮게 앞의 # 는 뗀다
    const tag = form.lol_tag.value.trim().replace(/^#+/, "");
    const password = form.password.value;
    if (!name) { err.textContent = "닉네임을 적어 주세요"; form.lol_name.focus(); return; }
    if (!tag) { err.textContent = "# 뒤의 태그를 적어 주세요 (예: KR1)"; form.lol_tag.focus(); return; }
    if (!password) { err.textContent = "비밀번호를 적어 주세요"; form.password.focus(); return; }
    if (signup && password.length < 6) { err.textContent = "비밀번호는 6글자 이상이어야 합니다"; form.password.focus(); return; }
    if (signup && password !== form.password2.value) {
      err.textContent = "비밀번호 확인이 달라요. 두 칸에 똑같이 적어 주세요";
      form.password2.focus();
      return;
    }
    const riot_id = name + "#" + tag;
    forgetAll();
    warmed = false;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = signup ? "계정 확인 중…" : "로그인 중…";
    err.textContent = "";
    const done = (data) => {
      setToken(data.token);
      me = data.user;
      try { localStorage.setItem(LAST_ID_KEY, JSON.stringify({ name: me.game_name, tag: me.tagline })); } catch {}
      location.hash = "#/tier";
      route();
    };
    const reset = (message) => {
      err.textContent = message;
      button.disabled = false;
      button.textContent = signup ? "가입하기" : "로그인";
    };
    try {
      done(await api(signup ? "/api/signup" : "/api/login",
        { method: "POST", body: JSON.stringify({ riot_id, password }) }));
    } catch (ex) {
      const rename = !signup && ex.status === 409 && ex.data && ex.data.rename;
      if (!rename) return reset(ex.message);
      // 새 닉네임으로 들어왔고 비밀번호도 맞다. 바꿀지 본인에게 묻는다
      if (!await askRename(rename.old, rename.new)) {
        return reset("닉네임이 바뀐 게 아니라면 가입할 때 쓴 LOL ID(" + rename.old + ")로 로그인해 주세요");
      }
      await applyRename(riot_id, password, done, reset);
    }
  };

  // 닉네임을 바꾸고, 새 닉네임으로 티어표를 미리 받아 둔다. 그동안 "반영 중" 창을 띄운다
  async function applyRename(riot_id, password, done, reset) {
    const close = showBusy("정보를 반영 중입니다", "rename");
    // 너무 빨리 끝나 창이 번쩍하고 사라지지 않게 잠깐은 띄워 둔다
    const atLeast = new Promise(r => setTimeout(r, 2000));
    let data;
    try {
      data = await api("/api/login", { method: "POST",
        body: JSON.stringify({ riot_id, password, confirm_rename: true }) });
      setToken(data.token);
      // 티어표를 미리 받아 두면 창이 닫히자마자 바로 보인다. 실패해도 티어표 화면이 다시 부른다
      await load("/api/tierlist").catch(() => {});
      await atLeast;
    } catch (ex) {
      close();
      return reset(ex.message);
    }
    close();
    toast("닉네임을 " + data.user.riot_id + " 로 바꿨어요");
    done(data);
  }

  // 닉네임에 "이름#태그" 를 통째로 붙여 넣으면 알아서 두 칸으로 나눈다
  form.lol_name.addEventListener("input", () => {
    const v = form.lol_name.value;
    const at = v.lastIndexOf("#");
    if (at > 0) {
      form.lol_name.value = v.slice(0, at).trim();
      form.lol_tag.value = v.slice(at + 1).trim();
      form.lol_tag.focus();
    }
  });
  // 저장된 아이디가 있으면 바로 비밀번호부터
  // 화면이 아래로 밀려 로고가 가려지지 않게 스크롤은 하지 않는다
  (!signup && last.name ? form.password : form.lol_name).focus({ preventScroll: true });
}

// ── 티어표 ──────────────────────────────────────────────

function playerStrip(p, extra = "") {
  return `
    <section class="player">
      ${p.icon ? `<img src="${esc(p.icon)}" alt="" width="64" height="64">` : ""}
      <div>
        <div class="name">${esc(p.game_name)}<small>#${esc(p.tagline)}</small></div>
        <div class="rank">${esc(rankText(p.rank))}${p.main_lane_ko ? " · 주 라인 " + esc(p.main_lane_ko) : ""}</div>
      </div>
      <div class="stats">
        <div class="stat"><b>${pct(p.win_rate)}</b><span>승률</span></div>
        <div class="stat"><b>${num(p.kda, 2)}</b><span>KDA</span></div>
        <div class="stat"><b>${num(p.cs_per_min)}</b><span>분당 CS</span></div>
        <div class="stat"><b>${p.games ?? "-"}</b><span>최근 판</span></div>
      </div>
      ${extra}
    </section>`;
}

const AREAS = [["combat", "전투"], ["growth", "성장"], ["snowball", "스노우볼"],
               ["damage", "딜"], ["vision", "시야"], ["opgg", "OP.GG 평점"]];
const AREA_HINT = {
  combat: "KDA와 킬 관여율",
  growth: "분당 CS와 팀 골드 중 내 몫",
  snowball: "14분 무렵 OP.GG 평점과 최다 연속 킬",
  damage: "분당 챔피언 피해량",
  vision: "분당 와드 설치와 제어 와드",
  opgg: "OP.GG가 매긴 그 판 평점",
};

// 점수에 따라 색을 바꾼다. 50이 그 라인·티어의 보통
function scoreColor(v) {
  if (v == null) return "var(--muted)";
  if (v >= 60) return "var(--gold)";
  if (v < 40) return "var(--lose)";
  return "var(--text)";
}

function areaBars(play) {
  return AREAS.map(([k, label]) => {
    const v = play.areas[k];
    return `
      <div class="area" title="${esc(AREA_HINT[k])}">
        <span>${label}</span>
        <i style="--w:${v == null ? 0 : v}%;--c:${scoreColor(v)}"></i>
        <b style="color:${scoreColor(v)}">${v == null ? "-" : v}</b>
      </div>`;
  }).join("");
}

function diagnosis(p) {
  if (!p.play) return "";
  const x = p.play;
  return `
    <section class="diag">
      <div class="diag-score">
        <b style="color:${scoreColor(x.overall)}">${x.overall}</b>
        <span>플레이 점수</span>
        <small>최근 ${x.games}판 평균</small>
      </div>
      <div class="areas">${areaBars(x)}</div>
      <p class="note diag-note">50점이 그 라인과 그 판 티어의 보통이에요. 20판 승률은 팀운이 커서 거의 반영하지 않아요.
        킬 관여율 ${pct(x.kp)}, 팀 골드 중 내 몫 ${pct(x.gold_share)}, 분당 피해량 ${x.dmg_per_min ?? "-"}</p>
    </section>`;
}

// 지금 그리는 티어표의 구간 이름(실버 등). 챔피언 칸의 설명에 쓴다
let bracketNow = null;

function officialLabel(c, bracket) {
  if (!c.meta_tier) return "공식 티어 정보 없음";
  const where = c.meta_scope === "bracket" && bracket ? bracket + " 구간" : "전체 구간";
  return where + " OP.GG 공식 " + c.meta_tier + "티어" + (c.meta_rank ? " (" + c.meta_rank + "위)" : "");
}

function champButton(c) {
  return `
    <button type="button" class="champ" data-id="${c.id}" aria-expanded="false"
            aria-label="${esc(c.name)} 자세히">
      <span class="pic">
        ${c.image ? `<img src="${esc(c.image)}" alt="" width="60" height="60" loading="lazy">` : ""}
        ${c.meta_tier ? `<em class="official" data-t="${esc(c.meta_tier)}" title="${esc(officialLabel(c, bracketNow))}">${esc(c.meta_tier)}</em>` : ""}
      </span>
      <span>${esc(c.name)}</span>
      <small>${c.perf ? "플레이 " + c.perf.overall : pct(c.win_rate)} · ${c.play}판</small>
    </button>`;
}

function champDetail(c, bracket) {
  const where = c.meta_scope === "bracket" && bracket ? bracket : "전체 구간";
  return `
    <div class="detail">
      <h3>${esc(c.name)} ${c.tier ? c.tier + "티어" : "OP"}</h3>
      ${c.perf ? `<div class="areas areas-inline">${areaBars(c.perf)}</div>` : ""}
      <dl>
        <div><dt>플레이 점수</dt><dd style="color:${scoreColor(c.perf && c.perf.overall)}">${c.perf ? c.perf.overall + "점" : "-"}</dd></div>
        <div><dt>판수</dt><dd>${c.play}판 (${c.win}승)</dd></div>
        <div><dt>내 승률</dt><dd>${pct(c.win_rate)}</dd></div>
        <div><dt>KDA</dt><dd>${num(c.kda, 2)}</dd></div>
        <div><dt>분당 CS</dt><dd>${num(c.cs_per_min)}</dd></div>
        <div><dt>라인</dt><dd>${esc(c.lane_ko || "-")}</dd></div>
        <div><dt>${esc(where)} 공식 티어</dt><dd>${c.meta_tier ? esc(c.meta_tier) + "티어 (" + esc(c.meta_rank) + "위)" : "정보 없음"}</dd></div>
      </dl>
    </div>`;
}

async function renderTier(riotId, fresh = false, target = view, inModal = false) {
  const mine = !riotId || riotId.toLowerCase().replace(/\s/g, "") === me.riot_id.toLowerCase().replace(/\s/g, "");
  const path = mine ? "/api/tierlist" : "/api/tierlist?" + new URLSearchParams({ riot_id: riotId });
  // 받아 둔 게 있으면 로딩 화면 없이 바로 그린다
  if (fresh || !known(path)) loading("OP.GG 에서 전적과 챔피언 통계를 모으는 중이에요. 처음 만드는 티어표는 조금 걸려요.", target);
  let data;
  try {
    data = await load(path, fresh);
  } catch (ex) {
    if (mine && ex.data && ex.data.renamed) return renamedNotice(target);
    return failed(ex.message, () => renderTier(riotId, fresh, target, inModal), target);
  }

  const p = data.player;
  const all = [data.op, ...Object.values(data.tiers).flat()].filter(Boolean);
  const title = mine ? "내 티어표" : esc(p.game_name) + " 님의 티어표";
  bracketNow = data.bracket;
  const basis = !data.bracket
    ? "티어를 알 수 없어 전체 구간 OP.GG 공식 티어를 반영했어요."
    : data.bracket_source === "최근 판 평균"
      ? "랭크가 없어서 최근 판들의 평균 티어(" + data.bracket + ")를 실제 티어로 보고, 그 구간의 OP.GG 공식 티어를 반영했어요."
      : data.bracket + " 구간(" + data.bracket_source + " 기준) OP.GG 공식 티어를 반영했어요. 챔피언 그림 옆 숫자가 공식 티어예요.";
  const queues = Object.entries(p.queues || {}).map(([q, n]) => q + " " + n).join(", ");
  const short = data.games < data.target_games
    ? `<p class="note">칼바람과 아레나를 빼고 나니 아직 ${data.games}판이에요. OP.GG 는 모드를 가리지 않고 최근 20판만 알려 줘서, 볼 때마다 쌓아 두고 ${data.target_games}판까지 채워요.</p>`
    : "";

  if (!data.op) {
    target.innerHTML = playerStrip(p) + `
      <div class="empty-state"><strong>최근 협곡 게임 기록이 없어요</strong>
      <p>솔로랭크, 자유랭크, 일반 게임을 몇 판 하고 나면 티어표가 만들어져요. 칼바람과 아레나는 세지 않아요.</p></div>`;
    return;
  }

  target.innerHTML = `
    ${inModal ? "" : `<h1>${title}</h1>`}
    <p class="lead">최근 ${data.games}판(${esc(queues)})에서 고른 챔피언 ${data.champion_count}개를 판마다의 플레이 점수로 줄 세웠어요. ${esc(basis)}</p>
    ${short}
    ${playerStrip(p)}
    ${diagnosis(p)}
    <section class="board">
      <article class="op reveal">
        <p class="op-mark">OP</p>
        ${data.op.image ? `<img src="${esc(data.op.image)}" alt="" width="148" height="148">` : ""}
        <p class="cname">${esc(data.op.name)}</p>
        <p class="why">${esc(data.op.reason)}</p>
      </article>
      <div>
        <div class="rows">
          ${["1", "2", "3", "4", "5"].map(t => `
            <div class="row" data-t="${t}">
              <b>${t}</b>
              <div class="champs">${data.tiers[t].length
                ? data.tiers[t].map(champButton).join("")
                : `<span class="empty">비어 있음</span>`}</div>
            </div>`).join("")}
        </div>
        <div class="detail-slot"></div>
      </div>
    </section>
    <div class="toolbar">
      <button type="button" class="ghost refresh">최신 전적으로 다시 만들기</button>
      ${mine ? "" : `<a class="btn" href="${duoHref(p.riot_id)}">나와 듀오 궁합 보기</a>`}
      <span class="note">챔피언을 누르면 왜 그 자리인지 보여 줘요.</span>
    </div>`;

  target.querySelector(".refresh").onclick = () => renderTier(riotId, true, target, inModal);
  const slot = target.querySelector(".detail-slot");
  target.querySelectorAll(".champ").forEach(btn => {
    btn.onclick = () => {
      const open = btn.getAttribute("aria-expanded") === "true";
      target.querySelectorAll(".champ").forEach(b => b.setAttribute("aria-expanded", "false"));
      if (open) { slot.innerHTML = ""; return; }
      btn.setAttribute("aria-expanded", "true");
      const c = all.find(x => String(x.id) === btn.dataset.id);
      slot.innerHTML = champDetail(c, data.bracket);
    };
  });
}

// ── 그룹방 ──────────────────────────────────────────────

async function loadRooms() {
  lastRooms = (await load("/api/rooms")).rooms;
  return lastRooms;
}

// 방 목록이 바뀌었을 때(만들기·들어가기·나가기)
function forgetRooms() { forget("/api/rooms"); }

// #/rooms/3/dodge 처럼 방 번호 뒤에 탭을 붙이면 그 탭을 바로 연다
const ROOM_TABS = ["board", "stats", "weekly", "dodge"];

async function renderRooms(target) {
  let [roomId = "", tab] = (target || "").split("/");
  // #/rooms/dodge 처럼 방 번호 없이 탭만 오면, 마지막으로 본 방(없으면 첫 방)의 그 탭
  if (ROOM_TABS.includes(roomId)) { tab = roomId; roomId = lastRoomId; }
  if (ROOM_TABS.includes(tab)) roomTab = tab;
  let rooms;
  try { rooms = await loadRooms(); }
  catch (ex) { return failed(ex.message, () => renderRooms(target)); }

  if (!roomId && rooms.length) roomId = String(rooms[0].id);

  view.innerHTML = `
    <section class="rooms">
      <aside class="side">
        <div class="box">
          <h2>내 방</h2>
          ${rooms.length ? `<ul class="room-list">${rooms.map(r => `
            <li><a href="#/rooms/${r.id}" ${String(r.id) === roomId ? 'aria-current="page"' : ""}>
              <span>${esc(r.name)}</span><small>${r.members}명</small></a></li>`).join("")}</ul>`
            : `<p class="note">아직 들어간 방이 없어요.</p>`}
        </div>
        <div class="box">
          <h2>새 방 만들기</h2>
          <form id="make-room"><input name="name" maxlength="30" placeholder="방 이름" aria-label="방 이름" required><button>만들기</button></form>
        </div>
        <div class="box">
          <h2>코드로 들어가기</h2>
          <form id="join-room"><input name="code" maxlength="6" placeholder="6글자 코드" aria-label="초대 코드" required><button>들어가기</button></form>
        </div>
      </aside>
      <div id="room-body">${rooms.length ? "" : `
        <div class="empty-state"><strong>친구들과 방을 만들어 보세요</strong>
        방을 만들면 초대 코드가 나와요. 친구가 그 코드로 들어오면 서로의 티어표와 지표를 나란히 볼 수 있어요.</div>`}</div>
    </section>`;

  document.getElementById("make-room").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: e.target.name.value }) });
      forgetRooms();
      toast("방을 만들었어요. 코드 " + r.code + " 를 친구에게 알려 주세요");
      location.hash = "#/rooms/" + r.id;
    } catch (ex) { toast(ex.message); }
  };
  document.getElementById("join-room").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/rooms/join", { method: "POST", body: JSON.stringify({ code: e.target.code.value }) });
      forgetRooms();
      // 들어간 방은 사람이 늘었으니 그 방에서 받아 둔 것도 버린다
      forget(new RegExp("^/api/rooms/" + r.id + "[/?]"));
      toast(r.name + " 방에 들어갔어요");
      location.hash = "#/rooms/" + r.id;
    } catch (ex) { toast(ex.message); }
  };

  if (roomId) renderRoom(roomId);
}

// 방 사람마다 고정된 색. 들어온 순서로 정해서, 무엇을 보든 사람의 색은 그대로다.
// 남색 바탕에서 색약 검사까지 통과한 6색. 7번째부터는 색 대신 이름으로만 구분한다
const MEMBER_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
function memberColor(i) { return MEMBER_COLORS[i] || "#6b7a99"; }

// 지표 비교에 쓰는 막대. max: 막대 끝(없으면 사람들 중 최댓값보다 조금 크게), mid: 보통 선
const PLAY_METRICS = AREAS.map(([k, label]) => ({
  key: k, label, hint: AREA_HINT[k], value: m => m.play ? m.play.areas[k] : null,
  show: v => String(v), max: 100, mid: 50,
}));
// low: 적을수록 좋은 지표(데스). 1등 표시를 가장 작은 값에 붙인다
const BASIC_METRICS = [
  { key: "win_rate", label: "승률", hint: "최근 판 승률", value: m => m.win_rate, show: v => pct(v), max: 1, mid: 0.5 },
  { key: "kda", label: "KDA", hint: "(킬+어시스트)÷데스", value: m => m.kda, show: v => num(v, 2) },
  { key: "kills", label: "평균 킬", hint: "한 판에 평균 몇 번 잡았나", value: m => m.kills_avg, show: v => num(v) },
  { key: "deaths", label: "평균 데스", hint: "한 판에 평균 몇 번 죽었나. 적을수록 1등", value: m => m.deaths_avg, show: v => num(v), low: true },
  { key: "assists", label: "평균 어시스트", hint: "한 판에 평균 몇 번 도왔나", value: m => m.assists_avg, show: v => num(v) },
  { key: "cs_per_min", label: "분당 CS", hint: "라인 미니언과 정글 몬스터", value: m => m.cs_per_min, show: v => num(v) },
  { key: "kp", label: "킬 관여율", hint: "우리 팀 킬 중 내가 관여한 비율", value: m => m.play ? m.play.kp : null, show: v => pct(v), max: 1 },
  { key: "gold_share", label: "골드 몫", hint: "우리 팀 골드 중 내가 번 비율", value: m => m.play ? m.play.gold_share : null, show: v => pct(v) },
  { key: "dmg", label: "분당 피해량", hint: "챔피언에게 준 피해", value: m => m.play ? m.play.dmg_per_min : null, show: v => String(v) },
  { key: "wards", label: "분당 와드", hint: "와드 설치와 제어 와드 구매", value: m => m.wards_per_min, show: v => num(v, 2) },
  { key: "games", label: "최근 판수", hint: "점수에 쓴 협곡 판", value: m => m.games, show: v => String(v), max: 20 },
];

function metricChart(metric, members) {
  const vals = members.map(({ m }) => metric.value(m));
  const known = vals.filter(v => v != null);
  if (!known.length) return "";
  const max = metric.max ?? Math.max(...known) * 1.1;
  const top = metric.low ? Math.min(...known) : Math.max(...known);
  const rows = members.map(({ m, color }, i) => {
    const v = vals[i];
    const w = v == null ? 0 : Math.max(2, Math.min(100, v / max * 100));
    const lead = known.length > 1 && v === top;
    const mid = metric.mid != null ? `<span class="midline" style="left:${metric.mid / max * 100}%" aria-hidden="true"></span>` : "";
    return `
      <div class="mrow" title="${esc(m.game_name)} ${esc(metric.label)} ${v == null ? "기록 없음" : esc(metric.show(v))}">
        <span class="mwho"><i style="background:${color}"></i><span>${esc(m.game_name)}</span></span>
        <span class="track">${mid}<span class="fill" style="width:${w}%;background:${color}"></span></span>
        <b>${v == null ? "-" : esc(metric.show(v))}${lead ? `<em>1등</em>` : ""}</b>
      </div>`;
  }).join("");
  return `
    <section class="metric">
      <h3>${esc(metric.label)}</h3>
      <p class="hint">${esc(metric.hint)}${metric.mid != null ? ". 점선이 보통" : ""}</p>
      <div class="mrows">${rows}</div>
    </section>`;
}

function rankShort(rank) {
  if (!rank) return "랭크 없음";
  const high = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(rank.tier);
  return rank.tier_ko + (high ? "" : " " + rank.division);
}

function boardCard(m, color, isMe) {
  const tierRow = t => `
    <div class="mt" data-t="${t}"><b>${t}</b><span>${(m.tiers[t] || []).map(c =>
      c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" title="${esc(c.name)}${c.perf != null ? ", 플레이 " + c.perf + "점" : ""}" width="30" height="30" loading="lazy">` : "").join("")
      || `<small>-</small>`}</span></div>`;
  return `
    <article class="pcard ${isMe ? "me" : ""}" style="--mc:${color}">
      <header>
        ${m.icon ? `<img src="${esc(m.icon)}" alt="" width="40" height="40">` : ""}
        <div><a href="${tierHref(m.riot_id)}" data-player="${esc(m.riot_id)}" title="${esc(m.riot_id)}">${esc(m.game_name)}</a>
          <small>${esc(rankShort(m.rank))}${m.main_lane_ko ? " · " + esc(m.main_lane_ko) : ""}</small></div>
        <span class="pscore" title="최근 판 플레이 점수"><b style="color:${scoreColor(m.play && m.play.overall)}">${m.play ? m.play.overall : "-"}</b><small>플레이</small></span>
      </header>
      <div class="pop">
        ${m.op && m.op.image ? `<img src="${esc(m.op.image)}" alt="" width="72" height="72">` : ""}
        <div><span>OP</span><b>${m.op ? esc(m.op.name) : "기록 없음"}</b>
          ${m.op && m.op.perf != null ? `<small>플레이 ${m.op.perf}점</small>` : ""}</div>
      </div>
      <div class="mtiers">${["1", "2", "3", "4", "5"].map(tierRow).join("")}</div>
      <footer>
        <a class="btn ghost" href="${tierHref(m.riot_id)}" data-player="${esc(m.riot_id)}">티어표 크게 보기</a>
        ${isMe ? "" : `<a class="btn ghost" href="${duoHref(m.riot_id)}">나와 궁합</a>`}
      </footer>
    </article>`;
}

function roomTable(room, members) {
  return `
    <details class="as-table">
      <summary>숫자 표로 보기</summary>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">소환사</th><th scope="col">랭크</th><th scope="col">플레이</th>
          ${AREAS.map(([, l]) => `<th scope="col">${l}</th>`).join("")}
          ${BASIC_METRICS.map(x => `<th scope="col">${x.label}</th>`).join("")}</tr></thead>
        <tbody>${members.map(({ m }) => `
          <tr class="${m.account_id === room.me ? "me" : ""}">
            <td>${esc(m.game_name)}</td>
            <td>${esc(rankShort(m.rank))}</td>
            <td>${m.play ? m.play.overall : "-"}</td>
            ${AREAS.map(([k]) => `<td>${m.play && m.play.areas[k] != null ? m.play.areas[k] : "-"}</td>`).join("")}
            ${BASIC_METRICS.map(x => { const v = x.value(m); return `<td>${v == null ? "-" : esc(x.show(v))}</td>`; }).join("")}
          </tr>`).join("")}</tbody>
      </table></div>
    </details>`;
}

// 방을 옮겨 다녀도 보던 탭을 기억한다
// 아직 전적을 받는 중인 사람의 카드
function pendingCard(m, color) {
  return `
    <article class="pcard pending" style="--mc:${color}">
      <header><div><b>${esc(m.game_name)}</b><small>전적 불러오는 중</small></div></header>
      ${funLoader("", true)}
    </article>`;
}

let roomTab = "board";
// 마지막으로 본 방. 연습장의 "무빙 순위" 버튼이 이 방으로 간다
let lastRoomId = "";
// 방을 옮기거나 새로 부르면 앞서 오던 대답은 버린다
let roomLoadSeq = 0;

async function renderRoom(roomId, fresh = false) {
  const seq = ++roomLoadSeq;
  const body = document.getElementById("room-body");
  const base = "/api/rooms/" + roomId;
  lastRoomId = String(roomId);
  // "모두 최신 전적으로" 면 이 방에서 받아 둔 것을 버리고 새로 받는다(사람이 늘었을 수도 있다)
  if (fresh) forget(new RegExp("^" + base + "[/?]"));
  if (!known(base + "?lite=1")) body.innerHTML = funLoader("방 사람들을 부르는 중이에요.");
  let room;
  try { room = await load(base + "?lite=1"); }
  catch (ex) {
    body.innerHTML = `<div class="empty-state"><strong>${esc(ex.message)}</strong></div>`;
    return;
  }
  if (seq !== roomLoadSeq) return;

  // 색은 들어온 순서(서버가 주는 순서)로 고정. 받아 둔 카드는 바로 채운다
  const cardPath = m => base + "/member/" + m.account_id;
  const members = room.members.map((m, i) => ({ m: known(cardPath(m)) || { ...m, pending: true }, color: memberColor(i) }));
  const colorOf = id => (members.find(s => s.m.account_id === id) || {}).color || memberColor(99);
  let arrived = members.filter(s => !s.m.pending).length;

  // 주간 랭킹·무빙 순위는 DB 만 읽어서 빠르다. 받아 둔 게 없으면 그 탭을 처음 열 때 받는다.
  // 주간 랭킹은 카드를 새로 받으면(= 모두의 새 판이 쌓이면) 한 번 더 받는다
  const extra = { weekly: known(base + "/weekly") || null, dodge: known(base + "/dodge") || null };
  // again 이면 받는 중이어도 새로 받는다. 늦게 온 옛 대답이 새 대답을 덮지 않게 순번을 붙인다
  const loadingExtra = {}, extraTurn = {};
  function loadExtra(kind, again = false) {
    if (loadingExtra[kind] && !again) return;
    loadingExtra[kind] = true;
    const turn = extraTurn[kind] = (extraTurn[kind] || 0) + 1;
    load(base + "/" + kind)
      .then(d => { if (turn === extraTurn[kind]) extra[kind] = d; },
            ex => { if (turn === extraTurn[kind]) extra[kind] = { error: ex.message }; })
      .finally(() => {
        if (turn !== extraTurn[kind]) return;
        loadingExtra[kind] = false;
        if (seq === roomLoadSeq && body.isConnected) draw();
      });
  }

  function tabBody(ok, waiting) {
    if (roomTab === "board") {
      return `<div class="pcards">${members.filter(({ m }) => !m.error).map(({ m, color }) =>
        m.pending ? pendingCard(m, color) : boardCard(m, color, m.account_id === room.me)).join("")}</div>`;
    }
    if (roomTab === "weekly" || roomTab === "dodge") {
      const d = extra[roomTab];
      if (!d) { loadExtra(roomTab); return funLoader(roomTab === "weekly" ? "이번 주 기록을 모으는 중이에요." : "", true); }
      if (d.error) return `<div class="empty-state"><strong>${esc(d.error)}</strong></div>`;
      return roomTab === "weekly" ? weeklyView(d, colorOf, waiting.length) : dodgeBoard(d, colorOf, roomId);
    }
    if (!ok.length) return funLoader("그래프를 그릴 전적을 모으는 중이에요.");
    return `
      ${waiting.length ? `<p class="note">아직 ${waiting.length}명을 불러오는 중이에요. 오는 대로 그래프에 더해져요.</p>` : ""}
      <div class="legend">${ok.map(({ m, color }) => `<span><i style="background:${color}"></i>${esc(m.game_name)}</span>`).join("")}</div>
      <h2 class="sub-h">플레이 점수 <small>50점이 그 라인과 그 판 티어의 보통</small></h2>
      <div class="metrics">${PLAY_METRICS.map(x => metricChart(x, ok)).join("")}</div>
      <h2 class="sub-h">기본 지표 <small>최근 20판</small></h2>
      <div class="metrics">${BASIC_METRICS.map(x => metricChart(x, ok)).join("")}</div>
      ${roomTable(room, ok)}`;
  }

  function draw() {
    const ok = members.filter(({ m }) => !m.pending && !m.error);
    const waiting = members.filter(({ m }) => m.pending);
    const broken = members.filter(({ m }) => m.error);
    const total = members.length;
    body.innerHTML = `
      <div class="room-head">
        <h1>${esc(room.name)}</h1>
        <span class="code">초대 코드 <b>${esc(room.code)}</b><button type="button" class="ghost" id="copy-code">복사</button></span>
      </div>
      ${waiting.length ? `
        <div class="progress" role="status">
          <span class="bar"><i style="width:${Math.round(arrived / total * 100)}%"></i></span>
          <span>${total}명 중 ${arrived}명 불러옴</span>
        </div>` : ""}
      <div class="seg room-tabs" role="tablist" aria-label="방 화면">
        <button type="button" role="tab" data-tab="board" aria-selected="${roomTab === "board"}">OP · 티어표</button>
        <button type="button" role="tab" data-tab="stats" aria-selected="${roomTab === "stats"}">지표 비교</button>
        <button type="button" role="tab" data-tab="weekly" aria-selected="${roomTab === "weekly"}">주간 랭킹</button>
        <button type="button" role="tab" data-tab="dodge" aria-selected="${roomTab === "dodge"}">무빙 순위</button>
      </div>
      ${tabBody(ok, waiting)}
      ${broken.length ? `<p class="note">전적을 못 불러온 사람: ${broken.map(({ m }) => esc(m.riot_id) + " (" + esc(m.error) + ")").join(", ")}</p>` : ""}
      <div class="toolbar">
        <button type="button" class="ghost" id="room-refresh">모두 최신 전적으로</button>
        <button type="button" class="ghost" id="leave">방 나가기</button>
      </div>`;

    body.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
      roomTab = b.dataset.tab;
      // 새로고침해도 같은 탭이 열리게 주소만 바꾼다(화면을 다시 부르지는 않는다)
      history.replaceState(null, "", "#/rooms/" + roomId + "/" + roomTab);
      draw();
    });
    // 티어표 링크는 팝업으로. Ctrl/가운데 클릭(새 탭) 은 그대로 둔다
    body.querySelectorAll("a[data-player]").forEach(a => a.onclick = e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openPlayer(a.dataset.player);
    });
    document.getElementById("copy-code").onclick = async () => {
      try { await navigator.clipboard.writeText(room.code); toast("코드를 복사했어요"); }
      catch { toast("코드: " + room.code); }
    };
    document.getElementById("room-refresh").onclick = () => renderRoom(roomId, true);
    document.getElementById("leave").onclick = async () => {
      if (!confirm(room.name + " 방에서 나갈까요?")) return;
      try {
        await api("/api/rooms/" + roomId + "/me", { method: "DELETE" });
        forgetRooms();
        forget(new RegExp("^" + base + "[/?]"));
        if (lastRoomId === String(roomId)) lastRoomId = "";
        toast("방에서 나왔어요");
        location.hash = "#/rooms";
        renderRooms("");
      } catch (ex) { toast(ex.message); }
    };
  }
  draw();

  // 아직 없는 카드만 사람마다 따로 받아서, 오는 대로 채운다.
  // 다른 화면으로 가도 받는 건 계속된다(load 가 기억해 둔다)
  const missing = members.filter(s => s.m.pending);
  let left = missing.length;
  missing.forEach(slot => {
    load(cardPath(slot.m), fresh)
      .then(card => { slot.m = card; },
            ex => { slot.m = { ...slot.m, pending: false, error: ex.message }; })
      .finally(() => {
        arrived += 1;
        left -= 1;
        // 새로 받은 카드가 다 왔으면 새로 쌓인 판으로 주간 랭킹을 다시 받는다
        if (left === 0) {
          forget(base + "/weekly");
          if (roomTab === "weekly" && seq === roomLoadSeq) loadExtra("weekly", true);
          else { extra.weekly = null; extraTurn.weekly = (extraTurn.weekly || 0) + 1; loadingExtra.weekly = false; }
        }
        if (seq === roomLoadSeq && body.isConnected) draw();
      });
  });
}

// ── 주간 랭킹 ───────────────────────────────────────────

function shortDate(iso) {
  const d = new Date(iso);
  return (d.getMonth() + 1) + "/" + d.getDate();
}

// 값이 큰 순서로 줄 세우고, 같은 값이면 같은 순위(1, 1, 3)
function rankBy(rows, key) {
  rows = rows.filter(m => m[key] != null).sort((x, y) => y[key] - x[key]);
  return rows.map(m => ({ m, rank: rows.findIndex(o => o[key] === m[key]) + 1 }));
}

// 순위표 한 장. detail: 이름 밑에 작게 적을 내용
function weekBoard(title, icon, ranked, show, detail, me, colorOf, empty) {
  return `
    <section class="award">
      <h3><span aria-hidden="true">${icon}</span> ${esc(title)}</h3>
      ${ranked.length ? `<ol>${ranked.map(({ m, rank }) => `
        <li class="${m.account_id === me ? "me" : ""} ${rank === 1 ? "first" : ""}">
          <span class="rk">${rank}</span>
          <span class="who2">
            <span class="mwho"><i style="background:${colorOf(m.account_id)}"></i><span>${esc(m.game_name)}</span></span>
            ${detail ? `<small>${detail(m)}</small>` : ""}
          </span>
          <b>${esc(show(m))}</b>
        </li>`).join("")}</ol>`
        : `<p class="note">${esc(empty)}</p>`}
    </section>`;
}

function weeklyView(data, colorOf, waiting) {
  const w = data.weights;
  const pctW = k => Math.round(w[k] * 100) + "%";
  const total = rankBy(data.members, "score");
  const short = data.members.filter(m => m.score == null && m.games > 0);
  const end = new Date(new Date(data.until).getTime() - 1);

  return `
    <h2 class="sub-h">이번 주 <small>${shortDate(data.since)}(월) ~ ${shortDate(end)}(일) · 한국 시각</small></h2>
    ${waiting ? `<p class="note">아직 ${waiting}명의 전적을 불러오는 중이에요. 다 오면 순위를 다시 매겨요.</p>` : ""}
    <div class="awards one">
      ${weekBoard("종합 순위", "👑", total, m => num(m.score) + "점",
        m => `플레이 ${m.play ?? "-"} · 승률 ${pct(m.win_rate)} · KDA ${num(m.kda, 2)} · ${m.games}판`,
        data.me, colorOf, "이번 주 " + data.min_games + "판 이상 한 사람이 없어요")}
    </div>
    ${short.length ? `<p class="note">${data.min_games}판이 안 돼서 종합 순위에서 빠진 사람: ${short.map(m => esc(m.game_name) + " " + m.games + "판").join(", ")}</p>` : ""}
    <p class="note">종합 점수 = 플레이 점수 ${pctW("play")} + 승률 ${pctW("win_rate")} + KDA ${pctW("kda")}.
      셋 다 50점이 보통이에요(승률 50%, KDA 는 그 라인의 보통 KDA 가 50점).
      협곡 판(솔로·자유·일반) 중 Tier.gg 에서 한 번이라도 불러온 판만 세요. 방을 열 때마다 모두의 새 판이 쌓여요.</p>`;
}

// ── 무빙 순위 (그룹방) ──────────────────────────────────

function dodgeBoard(data, colorOf, roomId, challenge = true) {
  const fmt = ms => ms == null ? "-" : DodgeGame.fmt(ms / 1000);
  const played = data.members.filter(m => m.best != null);
  return `
    <div class="dodge-board-head">
      <h2 class="sub-h">무빙 순위 <small>스킬샷 피하기 최고 기록 순</small></h2>
      ${challenge ? `<a class="btn" href="#/dodge/${roomId}">도전하기</a>` : ""}
    </div>
    ${played.length ? "" : `<p class="note">아직 아무도 기록이 없어요. 첫 기록을 세워 보세요.</p>`}
    <div class="table-wrap"><table class="dodge-table">
      <thead><tr><th scope="col">순위</th><th scope="col">소환사</th><th scope="col">최고 기록</th><th scope="col">이번 주</th><th scope="col">판수</th></tr></thead>
      <tbody>${data.members.map((m, i) => `
        <tr class="${m.account_id === data.me ? "me" : ""}">
          <td>${m.best == null ? "-" : i + 1}</td>
          <td><span class="mwho"><i style="background:${colorOf(m.account_id)}"></i><span>${esc(m.game_name)}</span></span></td>
          <td><b>${fmt(m.best)}</b></td>
          <td>${fmt(m.week_best)}</td>
          <td>${m.runs || 0}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

// ── 연습장: 스킬샷 피하기 ───────────────────────────────
// 게임은 dodge.js 가 돌린다. 여기서는 판 시작·끝을 서버에 알리고 순위를 보여 준다.
// 서버를 기다리지 않고 게임부터 띄운다. 기록과 순위는 뒤에서 채운다

let dodgeGame = null;
function stopDodge() {
  if (dodgeGame) { dodgeGame.destroy(); dodgeGame = null; }
}

function renderDodge(roomArg) {
  // 어느 방의 순위를 보여 줄지: 주소에 온 방 -> 마지막으로 본 방 -> 내 첫 방
  const roomId = /^\d+$/.test(roomArg || "") ? roomArg
    : lastRoomId || (lastRooms[0] ? String(lastRooms[0].id) : "");
  // 누르면 그룹방의 무빙 순위 탭으로 바로 간다
  const boardHref = roomId ? "#/rooms/" + roomId + "/dodge" : "#/rooms/dodge";
  view.innerHTML = `
    <section class="dodge">
      <div class="dodge-head">
        <h1>스킬샷 피하기</h1>
        <a class="btn ghost" href="${boardHref}">무빙 순위</a>
      </div>
      <div id="dodge-root"></div>
      ${roomId ? `<div id="dodge-mini" class="dodge-mini"></div>` : ""}
    </section>`;

  const fmt = ms => ms == null ? "-" : DodgeGame.fmt(ms / 1000);
  const showBest = r => dodgeGame && dodgeGame.setBest(
    r.best == null ? "" : `최고 <b>${fmt(r.best)}</b> · 이번 주 <b>${fmt(r.week_best)}</b>`);

  let runPromise = null;
  dodgeGame = DodgeGame.mount(document.getElementById("dodge-root"), {
    links: `<a class="btn ghost" href="${boardHref}">무빙 순위 보기</a>`,
    onStart() {
      runPromise = api("/api/dodge/start", { method: "POST" }).then(r => r.run);
      runPromise.catch(() => {});
    },
    async onEnd({ ms, dodged, ver }) {
      let r;
      try {
        const run = await runPromise;
        r = await api("/api/dodge/finish", { method: "POST", body: JSON.stringify({ run, ms, dodged, ver }) });
      } catch (ex) {
        return `<p class="note">기록을 저장하지 못했어요 (${esc(ex.message)})</p>`;
      }
      // 기록이 바뀌었으니 받아 둔 내 기록과 방 순위를 새것으로
      remember("/api/dodge/me", r);
      forget(/^\/api\/rooms\/\d+\/dodge$/);
      showBest(r);
      if (roomId) drawMini();
      if (!r.saved) return `<p class="note">1초 넘게 버틴 판부터 기록해요</p>`;
      if (r.new_best) return `<p class="dodge-new">🎉 최고 기록!</p>`;
      if (r.new_week_best) return `<p class="dodge-new">이번 주 최고 기록!</p>`;
      return `<p class="note">최고 기록 ${fmt(r.best)}</p>`;
    },
  });

  load("/api/dodge/me").then(showBest, () => {});

  // 방에서 왔으면 그 방 순위를 게임 아래에 작게
  async function drawMini() {
    const box = document.getElementById("dodge-mini");
    if (!box) return;
    try {
      const d = await load("/api/rooms/" + roomId + "/dodge");
      // 색은 방 화면과 같게, 들어온 순서(slot)로
      const colorOf = id => memberColor(d.members.find(m => m.account_id === id).slot);
      box.innerHTML = dodgeBoard(d, colorOf, roomId, false);
    } catch (ex) {
      box.innerHTML = `<p class="note">${esc(ex.message)}</p>`;
    }
  }
  if (roomId) drawMini();
}

// ── 듀오 궁합 ───────────────────────────────────────────

async function renderDuo(partner, fresh = false) {
  view.innerHTML = `
    <h1>듀오 궁합</h1>
    <p class="lead">둘이 같은 팀으로 한 판을 찾아서, 같이 할 때 승률이 평소보다 오르는지 봐요.</p>
    <form class="duo-form" id="duo-form">
      <div class="id-pair">
        <input name="p_name" placeholder="친구 닉네임" aria-label="친구 닉네임" value="${esc(partner.split("#")[0] || "")}" required>
        <span aria-hidden="true">#</span>
        <input name="p_tag" placeholder="KR1" aria-label="친구 태그 (# 뒤)" maxlength="5" value="${esc(partner.split("#")[1] || "")}" required>
      </div>
      <button>궁합 보기</button>
    </form>
    <div class="picks" id="picks"></div>
    <div id="duo-body"></div>`;

  const form = document.getElementById("duo-form");
  // 닉네임 칸에 "이름#태그" 를 붙여 넣으면 두 칸으로 나눈다
  form.p_name.addEventListener("input", () => {
    const v = form.p_name.value, at = v.lastIndexOf("#");
    if (at > 0) { form.p_name.value = v.slice(0, at).trim(); form.p_tag.value = v.slice(at + 1).trim(); form.p_tag.focus(); }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = form.p_name.value.trim();
    const tag = form.p_tag.value.trim().replace(/^#+/, "");
    if (!name || !tag) { toast("친구의 닉네임과 # 뒤 태그를 모두 적어 주세요"); return; }
    location.hash = duoHref(name + "#" + tag);
  };

  fillPicks();
  if (partner) drawDuo(partner, fresh);
}

async function fillPicks() {
  // 내 방 사람들을 빠르게 고를 수 있게 버튼으로
  try {
    const rooms = lastRooms.length ? lastRooms : await loadRooms();
    const seen = new Set([me.riot_id]);
    const names = [];
    for (const r of rooms.slice(0, 3)) {
      const { members } = await load("/api/rooms/" + r.id + "/members");
      for (const id of members) {
        if (!seen.has(id)) { seen.add(id); names.push(id); }
      }
    }
    const picks = document.getElementById("picks");
    if (!picks || !names.length) return;
    picks.innerHTML = names.slice(0, 10).map(n =>
      `<a class="btn ghost" href="${duoHref(n)}">${esc(n)}</a>`).join("");
  } catch {}
}

async function drawDuo(partner, fresh) {
  const body = document.getElementById("duo-body");
  const path = "/api/duo?" + new URLSearchParams({ partner });
  if (fresh || !known(path)) body.innerHTML = funLoader("두 사람의 최근 경기를 맞춰 보는 중이에요.");
  let d;
  try {
    d = await load(path, fresh);
  } catch (ex) {
    body.innerHTML = `<div class="empty-state"><strong>${esc(ex.message)}</strong></div>`;
    return;
  }

  const t = d.together;
  const side = (p, right) => `
    <a class="side-card ${right ? "right" : ""}" href="${tierHref(p.riot_id)}">
      ${p.icon ? `<img src="${esc(p.icon)}" alt="" width="56" height="56">` : ""}
      <div><b title="${esc(p.riot_id)}">${esc(p.game_name)}</b><span>${esc(rankText(p.rank))}</span></div>
    </a>`;

  const cmpRow = (label, av, bv, fmt, higher = true) => {
    const aWin = av != null && bv != null && (higher ? av > bv : av < bv);
    const bWin = av != null && bv != null && (higher ? bv > av : bv < av);
    return `<tr><td class="${aWin ? "win" : ""}">${fmt(av)}</td><td>${label}</td><td class="${bWin ? "win" : ""}">${fmt(bv)}</td></tr>`;
  };

  const bar = (label, value, color) => `
    <div class="bar"><div><span>${label}</span><b>${pct(value)}</b></div>
    <i style="--w:${value == null ? 0 : Math.round(value * 100)}%;${color ? "--c:" + color : ""}"></i></div>`;

  body.innerHTML = `
    <div class="versus">
      ${side(d.a, false)}
      <div class="dial" role="img" aria-label="궁합 ${d.score}점">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r="52" class="dial-track"></circle>
          <circle cx="60" cy="60" r="52" class="dial-fill" pathLength="100"
                  style="stroke-dasharray:${d.score} 100"></circle>
        </svg>
        <div><b>${d.score}</b><span>궁합 점수</span></div>
      </div>
      ${side(d.b, true)}
    </div>
    <p class="verdict">${esc(d.verdict)}</p>

    <div class="cards">
      <section class="card">
        <h3>같이 한 판</h3>
        <p class="big">${t.games}<small>판 중 ${t.wins}승</small></p>
        ${bar("같이 할 때 승률", t.win_rate)}
        ${bar("각자 할 때 평균 승률", t.base_win_rate, "var(--muted)")}
        ${t.games ? "" : `<p class="note">최근 기록에서 같은 팀으로 한 판을 찾지 못했어요. 같이 몇 판 하고 다시 보면 정확해져요.</p>`}
      </section>

      <section class="card">
        <h3>지표 비교</h3>
        <table class="cmp">
          <tr><th title="${esc(d.a.riot_id)}">${esc(d.a.game_name)}</th><th></th><th title="${esc(d.b.riot_id)}">${esc(d.b.game_name)}</th></tr>
          ${cmpRow("최근 승률", d.a.win_rate, d.b.win_rate, pct)}
          ${cmpRow("최근 KDA", d.a.kda, d.b.kda, v => num(v, 2))}
          ${cmpRow("분당 CS", d.a.cs_per_min, d.b.cs_per_min, v => num(v))}
          ${cmpRow("플레이 점수", d.a.play && d.a.play.overall, d.b.play && d.b.play.overall, v => v ?? "-")}
          ${cmpRow("스노우볼", d.a.play && d.a.play.areas.snowball, d.b.play && d.b.play.areas.snowball, v => v ?? "-")}
          ${t.games ? cmpRow("같이 할 때 KDA", t.kda_a, t.kda_b, v => num(v, 2)) : ""}
          <tr><td>${esc(d.a.main_lane_ko || "-")}</td><td>주 라인</td><td>${esc(d.b.main_lane_ko || "-")}</td></tr>
        </table>
        ${d.same_lane ? `<p class="note">주 라인이 같아서 한 명이 양보해야 해요.</p>` : ""}
      </section>

      <section class="card">
        <h3>잘 맞은 조합</h3>
        ${t.combos.length ? `<ul class="games">${t.combos.map(c => `
          <li class="${c.wins * 2 >= c.games ? "w" : ""}"><span>${esc(c.a)} + ${esc(c.b)}</span><b>${c.wins}/${c.games}승</b></li>`).join("")}</ul>`
          : `<p class="note">같이 한 판이 생기면 챔피언 조합별 승리를 보여 줘요.</p>`}
        ${t.lanes.length ? `<p class="note">자주 선 라인: ${t.lanes.map(l => esc(l.a + "+" + l.b) + " " + l.games + "판").join(", ")}</p>` : ""}
      </section>

      <section class="card">
        <h3>맞대결</h3>
        <p class="big">${d.versus.a_wins} : ${d.versus.b_wins}</p>
        <p class="note">${d.versus.games ? "서로 다른 팀으로 만난 " + d.versus.games + "판의 결과예요." : "서로 적으로 만난 판은 아직 없어요."}</p>
      </section>
    </div>

    ${t.recent.length ? `
      <h2 style="margin-top:28px">최근 같이 한 판</h2>
      <ul class="games">${t.recent.map(g => `
        <li class="${g.result === "WIN" ? "w" : ""}">
          <span>${esc(g.a)} ${esc(g.a_kda)} + ${esc(g.b)} ${esc(g.b_kda)}</span>
          <b>${g.result === "WIN" ? "승리" : g.result === "LOSE" ? "패배" : "다시하기"}</b></li>`).join("")}</ul>` : ""}

    <div class="toolbar">
      <button type="button" class="ghost" id="duo-refresh">최신 전적으로 다시 보기</button>
      <span class="note">같이 한 판은 쌓아 둔 솔로랭크, 자유랭크, 일반 게임에서 찾아요. 지표 비교는 각자 최근 20판 기준이에요. OP.GG 는 한 번에 최근 20판만 알려 줘서, 자주 볼수록 쌓인 판이 늘어나요. (지금 ${d.sample.a}판, ${d.sample.b}판)</span>
    </div>`;

  document.getElementById("duo-refresh").onclick = () => drawDuo(partner, true);
}

route();
