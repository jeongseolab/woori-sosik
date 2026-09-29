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
    location.hash = "#/login";
  }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : "요청을 처리하지 못했습니다");
  }
  return data;
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

function loading(message) {
  view.innerHTML = `
    <div class="loading">
      <div class="skeleton"><div></div><div></div><div></div></div>
      <p>${esc(message)}</p>
    </div>`;
}

function failed(message, retry) {
  view.innerHTML = `
    <div class="empty-state">
      <strong>${esc(message)}</strong>
      <p>잠시 뒤 다시 시도해 주세요.</p>
      <button type="button" id="retry">다시 불러오기</button>
    </div>`;
  document.getElementById("retry").onclick = retry;
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

  const target = arg ? decodeURIComponent(arg) : "";
  if (page === "rooms") return renderRooms(target);
  if (page === "duo") return renderDuo(target);
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
        <p class="gate-logo">Tier.gg</p>
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
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = signup ? "계정 확인 중…" : "로그인 중…";
    err.textContent = "";
    try {
      const data = await api(signup ? "/api/signup" : "/api/login",
        { method: "POST", body: JSON.stringify({ riot_id, password }) });
      setToken(data.token);
      me = data.user;
      try { localStorage.setItem(LAST_ID_KEY, JSON.stringify({ name: me.game_name, tag: me.tagline })); } catch {}
      location.hash = "#/tier";
      route();
    } catch (ex) {
      err.textContent = ex.message;
      button.disabled = false;
      button.textContent = signup ? "가입하기" : "로그인";
    }
  };

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
  (!signup && last.name ? form.password : form.lol_name).focus();
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

function champButton(c) {
  return `
    <button type="button" class="champ" data-id="${c.id}" aria-expanded="false"
            aria-label="${esc(c.name)} 자세히">
      ${c.image ? `<img src="${esc(c.image)}" alt="" width="60" height="60" loading="lazy">` : ""}
      <span>${esc(c.name)}</span>
      <small>${c.perf ? "플레이 " + c.perf.overall : pct(c.win_rate)} · ${c.play}판</small>
    </button>`;
}

function champDetail(c, bracket) {
  const where = bracket ? bracket + " 구간" : "전체 구간";
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
        <div><dt>${esc(where)} 메타</dt><dd>${c.meta_tier ? esc(c.meta_tier) + "티어 (" + esc(c.meta_rank) + "위)" : "정보 없음"}</dd></div>
      </dl>
    </div>`;
}

async function renderTier(riotId, fresh = false) {
  const mine = !riotId || riotId.toLowerCase().replace(/\s/g, "") === me.riot_id.toLowerCase().replace(/\s/g, "");
  loading("OP.GG 에서 전적과 챔피언 통계를 모으는 중이에요. 처음엔 15초쯤 걸려요.");
  let data;
  try {
    const q = new URLSearchParams();
    if (!mine) q.set("riot_id", riotId);
    if (fresh) q.set("fresh", "1");
    data = await api("/api/tierlist?" + q);
  } catch (ex) {
    return failed(ex.message, () => renderTier(riotId, fresh));
  }

  const p = data.player;
  const all = [data.op, ...Object.values(data.tiers).flat()].filter(Boolean);
  const title = mine ? "내 티어표" : esc(p.game_name) + " 님의 티어표";
  const basis = data.bracket ? data.bracket + " 구간 메타를 반영했어요." : "랭크 기록이 없어 전체 구간 메타를 반영했어요.";
  const queues = Object.entries(p.queues || {}).map(([q, n]) => q + " " + n).join(", ");
  const short = data.games < data.target_games
    ? `<p class="note">칼바람과 아레나를 빼고 나니 아직 ${data.games}판이에요. OP.GG 는 모드를 가리지 않고 최근 20판만 알려 줘서, 볼 때마다 쌓아 두고 ${data.target_games}판까지 채워요.</p>`
    : "";

  if (!data.op) {
    view.innerHTML = playerStrip(p) + `
      <div class="empty-state"><strong>최근 협곡 게임 기록이 없어요</strong>
      <p>솔로랭크, 자유랭크, 일반 게임을 몇 판 하고 나면 티어표가 만들어져요. 칼바람과 아레나는 세지 않아요.</p></div>`;
    return;
  }

  view.innerHTML = `
    <h1>${title}</h1>
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
        <div id="detail-slot"></div>
      </div>
    </section>
    <div class="toolbar">
      <button type="button" class="ghost" id="refresh">최신 전적으로 다시 만들기</button>
      ${mine ? "" : `<a class="btn" href="${duoHref(p.riot_id)}">나와 듀오 궁합 보기</a>`}
      <span class="note">챔피언을 누르면 왜 그 자리인지 보여 줘요.</span>
    </div>`;

  document.getElementById("refresh").onclick = () => renderTier(riotId, true);
  const slot = document.getElementById("detail-slot");
  view.querySelectorAll(".champ").forEach(btn => {
    btn.onclick = () => {
      const open = btn.getAttribute("aria-expanded") === "true";
      view.querySelectorAll(".champ").forEach(b => b.setAttribute("aria-expanded", "false"));
      if (open) { slot.innerHTML = ""; return; }
      btn.setAttribute("aria-expanded", "true");
      const c = all.find(x => String(x.id) === btn.dataset.id);
      slot.innerHTML = champDetail(c, data.bracket);
    };
  });
}

// ── 그룹방 ──────────────────────────────────────────────

async function loadRooms() {
  lastRooms = (await api("/api/rooms")).rooms;
  return lastRooms;
}

async function renderRooms(roomId) {
  let rooms;
  try { rooms = await loadRooms(); }
  catch (ex) { return failed(ex.message, () => renderRooms(roomId)); }

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
      toast("방을 만들었어요. 코드 " + r.code + " 를 친구에게 알려 주세요");
      location.hash = "#/rooms/" + r.id;
    } catch (ex) { toast(ex.message); }
  };
  document.getElementById("join-room").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/rooms/join", { method: "POST", body: JSON.stringify({ code: e.target.code.value }) });
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
const BASIC_METRICS = [
  { key: "win_rate", label: "승률", hint: "최근 판 승률", value: m => m.win_rate, show: v => pct(v), max: 1, mid: 0.5 },
  { key: "kda", label: "KDA", hint: "(킬+어시스트)÷데스", value: m => m.kda, show: v => num(v, 2) },
  { key: "cs_per_min", label: "분당 CS", hint: "라인 미니언과 정글 몬스터", value: m => m.cs_per_min, show: v => num(v) },
  { key: "kp", label: "킬 관여율", hint: "우리 팀 킬 중 내가 관여한 비율", value: m => m.play ? m.play.kp : null, show: v => pct(v), max: 1 },
  { key: "dmg", label: "분당 피해량", hint: "챔피언에게 준 피해", value: m => m.play ? m.play.dmg_per_min : null, show: v => String(v) },
  { key: "games", label: "최근 판수", hint: "점수에 쓴 협곡 판", value: m => m.games, show: v => String(v), max: 20 },
];

function metricChart(metric, members) {
  const vals = members.map(({ m }) => metric.value(m));
  const known = vals.filter(v => v != null);
  if (!known.length) return "";
  const max = metric.max ?? Math.max(...known) * 1.1;
  const top = Math.max(...known);
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
        <div><a href="${tierHref(m.riot_id)}" title="${esc(m.riot_id)}">${esc(m.game_name)}</a>
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
        <a class="btn ghost" href="${tierHref(m.riot_id)}">티어표 크게 보기</a>
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
let roomTab = "board";

async function renderRoom(roomId, fresh = false) {
  const body = document.getElementById("room-body");
  body.innerHTML = `<div class="loading"><div class="skeleton"><div></div><div></div></div>
    <p>방 사람들의 전적을 모으는 중이에요.</p></div>`;
  let room;
  try { room = await api("/api/rooms/" + roomId + (fresh ? "?fresh=1" : "")); }
  catch (ex) {
    body.innerHTML = `<div class="empty-state"><strong>${esc(ex.message)}</strong></div>`;
    return;
  }

  // 색은 들어온 순서(서버가 주는 순서)로 고정
  const members = room.members.map((m, i) => ({ m, color: memberColor(i) }));
  const ok = members.filter(({ m }) => !m.error);
  const broken = members.filter(({ m }) => m.error);

  function draw() {
    body.innerHTML = `
      <div class="room-head">
        <h1>${esc(room.name)}</h1>
        <span class="code">초대 코드 <b>${esc(room.code)}</b><button type="button" class="ghost" id="copy-code">복사</button></span>
      </div>
      <div class="seg" role="tablist" aria-label="방 화면">
        <button type="button" role="tab" data-tab="board" aria-selected="${roomTab === "board"}">OP · 티어표</button>
        <button type="button" role="tab" data-tab="stats" aria-selected="${roomTab === "stats"}">지표 비교</button>
      </div>
      ${roomTab === "board" ? `
        <div class="pcards">${ok.map(({ m, color }) => boardCard(m, color, m.account_id === room.me)).join("")}</div>`
      : `
        <div class="legend">${ok.map(({ m, color }) => `<span><i style="background:${color}"></i>${esc(m.game_name)}</span>`).join("")}</div>
        <h2 class="sub-h">플레이 점수 <small>50점이 그 라인과 그 판 티어의 보통</small></h2>
        <div class="metrics">${PLAY_METRICS.map(x => metricChart(x, ok)).join("")}</div>
        <h2 class="sub-h">기본 지표 <small>최근 20판</small></h2>
        <div class="metrics">${BASIC_METRICS.map(x => metricChart(x, ok)).join("")}</div>
        ${roomTable(room, ok)}`}
      ${broken.length ? `<p class="note">전적을 못 불러온 사람: ${broken.map(({ m }) => esc(m.riot_id) + " (" + esc(m.error) + ")").join(", ")}</p>` : ""}
      <div class="toolbar">
        <button type="button" class="ghost" id="room-refresh">모두 최신 전적으로</button>
        <button type="button" class="ghost" id="leave">방 나가기</button>
      </div>`;

    body.querySelectorAll(".seg button").forEach(b => b.onclick = () => { roomTab = b.dataset.tab; draw(); });
    document.getElementById("copy-code").onclick = async () => {
      try { await navigator.clipboard.writeText(room.code); toast("코드를 복사했어요"); }
      catch { toast("코드: " + room.code); }
    };
    document.getElementById("room-refresh").onclick = () => renderRoom(roomId, true);
    document.getElementById("leave").onclick = async () => {
      if (!confirm(room.name + " 방에서 나갈까요?")) return;
      try {
        await api("/api/rooms/" + roomId + "/me", { method: "DELETE" });
        toast("방에서 나왔어요");
        location.hash = "#/rooms";
        renderRooms("");
      } catch (ex) { toast(ex.message); }
    };
  }
  draw();
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
      const { members } = await api("/api/rooms/" + r.id + "/members");
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
  body.innerHTML = `<div class="loading"><div class="skeleton"><div></div><div></div></div>
    <p>두 사람의 최근 경기를 맞춰 보는 중이에요.</p></div>`;
  let d;
  try {
    d = await api("/api/duo?" + new URLSearchParams({ partner, ...(fresh ? { fresh: "1" } : {}) }));
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
