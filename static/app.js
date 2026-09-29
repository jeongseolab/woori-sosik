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

function renderGate(mode = "login") {
  const signup = mode === "signup";
  view.innerHTML = `
    <section class="gate">
      <div>
        <h1>내가 한 챔피언만으로 만드는 티어표</h1>
        <p class="lead">남들 티어표 말고, 내 전적과 내 티어 구간의 통계로 줄 세운 나만의 OP 챔피언을 확인하세요. 친구들과 방을 만들어 서로 비교하고 듀오 궁합도 볼 수 있어요.</p>
        <div class="gate-demo" aria-hidden="true">
          <div><b style="background:var(--gold)">OP</b><span></span></div>
          <div><b style="background:var(--t1)">1</b><span></span></div>
          <div><b style="background:var(--t2)">2</b><span></span></div>
          <div><b style="background:var(--t3)">3</b><span></span></div>
        </div>
      </div>
      <div class="gate-card">
        <h2>${signup ? "Riot 계정으로 가입" : "Riot 계정으로 로그인"}</h2>
        <p class="note">${signup
          ? "가입할 때 OP.GG 에서 계정이 있는지 확인해요. 한국 서버 계정만 됩니다."
          : "가입할 때 쓴 Riot ID 와 비밀번호를 넣어 주세요."}</p>
        <form id="gate-form" novalidate>
          <label for="riot-id">Riot ID</label>
          <input id="riot-id" name="riot_id" placeholder="이름#태그" autocomplete="username" required>
          <label for="pw">${signup ? "이 사이트에서 쓸 비밀번호" : "비밀번호"}</label>
          <input id="pw" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}"
                 placeholder="${signup ? "6글자 이상" : ""}" required>
          <p class="err" id="gate-err"></p>
          <button type="submit">${signup ? "가입하기" : "로그인"}</button>
        </form>
        <p class="switch">${signup ? "이미 가입했나요?" : "처음인가요?"}
          <button type="button" id="gate-switch">${signup ? "로그인" : "가입하기"}</button></p>
        ${signup ? `<p class="note">Riot 비밀번호가 아니라 이 사이트 전용 비밀번호예요. Riot 비밀번호는 절대 넣지 마세요.</p>` : ""}
      </div>
    </section>`;

  document.getElementById("gate-switch").onclick = () => renderGate(signup ? "login" : "signup");
  const form = document.getElementById("gate-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("gate-err");
    const riot_id = form.riot_id.value.trim();
    const password = form.password.value;
    if (!riot_id.includes("#")) { err.textContent = "Riot ID 는 이름#태그 모양으로 적어 주세요"; return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = signup ? "계정 확인 중…" : "로그인 중…";
    err.textContent = "";
    try {
      const data = await api(signup ? "/api/signup" : "/api/login",
        { method: "POST", body: JSON.stringify({ riot_id, password }) });
      setToken(data.token);
      me = data.user;
      location.hash = "#/tier";
      route();
    } catch (ex) {
      err.textContent = ex.message;
      button.disabled = false;
      button.textContent = signup ? "가입하기" : "로그인";
    }
  };
  form.riot_id.focus();
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

function champButton(c) {
  return `
    <button type="button" class="champ" data-id="${c.id}" aria-expanded="false"
            aria-label="${esc(c.name)} 자세히">
      ${c.image ? `<img src="${esc(c.image)}" alt="" width="60" height="60" loading="lazy">` : ""}
      <span>${esc(c.name)}</span>
      <small>${pct(c.win_rate)} · ${c.play}판</small>
    </button>`;
}

function champDetail(c, bracket) {
  const where = bracket ? bracket + " 구간" : "전체 구간";
  return `
    <div class="detail">
      <h3>${esc(c.name)} ${c.tier ? c.tier + "티어" : "OP"}</h3>
      <dl>
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
    <p class="lead">최근 ${data.games}판(${esc(queues)})에서 고른 챔피언 ${data.champion_count}개를 내 승률, KDA, 판수로 줄 세웠어요. ${esc(basis)}</p>
    ${short}
    ${playerStrip(p)}
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

// 비교표의 칸. higher: 클수록 좋은가
const COLUMNS = [
  { key: "rank", label: "랭크", value: m => rankScore(m.rank), show: m => esc(m.rank ? m.rank.tier_ko + (["MASTER","GRANDMASTER","CHALLENGER"].includes(m.rank.tier) ? "" : " " + m.rank.division) + " " + m.rank.lp + "LP" : "없음") },
  { key: "win_rate", label: "승률", value: m => m.win_rate, show: m => pct(m.win_rate) },
  { key: "kda", label: "KDA", value: m => m.kda, show: m => num(m.kda, 2) },
  { key: "cs_per_min", label: "분당 CS", value: m => m.cs_per_min, show: m => num(m.cs_per_min) },
  { key: "games", label: "최근 판수", value: m => m.games, show: m => m.games ?? "-" },
];
const TIER_ORDER = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];

function rankScore(rank) {
  if (!rank) return null;
  return TIER_ORDER.indexOf(rank.tier) * 10000 + (5 - (rank.division || 1)) * 1000 + (rank.lp || 0);
}

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

  let sort = { key: "rank", dir: -1 };
  const ok = room.members.filter(m => !m.error);

  // 칸마다 가장 좋은 사람을 금색으로
  const best = {};
  for (const col of COLUMNS) {
    const vals = ok.map(col.value).filter(v => v != null);
    if (vals.length > 1) best[col.key] = Math.max(...vals);
  }

  function draw() {
    const rows = [...room.members].sort((a, b) => {
      if (a.error || b.error) return a.error ? 1 : -1;
      const col = COLUMNS.find(c => c.key === sort.key);
      return ((col.value(a) ?? -1) - (col.value(b) ?? -1)) * sort.dir;
    });
    body.innerHTML = `
      <div class="room-head">
        <h1>${esc(room.name)}</h1>
        <span class="code">초대 코드 <b>${esc(room.code)}</b><button type="button" class="ghost" id="copy-code">복사</button></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th scope="col">소환사</th>
          ${COLUMNS.map(c => `<th scope="col"><button type="button" data-sort="${c.key}"
            ${sort.key === c.key ? `aria-sort="${sort.dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</button></th>`).join("")}
          <th scope="col">주 라인</th><th scope="col">OP</th><th scope="col">1~2티어</th><th scope="col"></th>
        </tr></thead>
        <tbody>${rows.map(m => m.error ? `
          <tr><td>${esc(m.riot_id)}</td><td colspan="${COLUMNS.length + 4}" class="note">${esc(m.error)}</td></tr>` : `
          <tr class="${m.account_id === room.me ? "me" : ""}">
            <td><a class="mem" href="${tierHref(m.riot_id)}">
              ${m.icon ? `<img src="${esc(m.icon)}" alt="" width="36" height="36">` : ""}
              <span title="${esc(m.riot_id)}">${esc(m.game_name)}</span></a></td>
            ${COLUMNS.map(c => `<td class="${best[c.key] != null && c.value(m) === best[c.key] ? "best" : ""}">${c.show(m)}</td>`).join("")}
            <td>${esc(m.main_lane_ko || "-")}</td>
            <td>${m.op ? `<span class="op-mini">${m.op.image ? `<img src="${esc(m.op.image)}" alt="">` : ""}${esc(m.op.name)}</span>` : "-"}</td>
            <td><span class="mini">${(m.top || []).map(c => c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" title="${esc(c.name)}">` : "").join("")}</span></td>
            <td>${m.account_id === room.me ? "" : `<a class="btn ghost" href="${duoHref(m.riot_id)}">궁합</a>`}</td>
          </tr>`).join("")}</tbody>
      </table></div>
      <div class="toolbar">
        <button type="button" class="ghost" id="room-refresh">모두 최신 전적으로</button>
        <button type="button" class="ghost" id="leave">방 나가기</button>
        <span class="note">금색은 그 항목 1등이에요. 이름을 누르면 그 사람의 티어표가 열려요.</span>
      </div>`;

    body.querySelectorAll("th button").forEach(b => b.onclick = () => {
      sort = { key: b.dataset.sort, dir: sort.key === b.dataset.sort ? -sort.dir : -1 };
      draw();
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
      <input name="partner" placeholder="친구 Riot ID (이름#태그)" aria-label="친구 Riot ID" value="${esc(partner)}" required>
      <button>궁합 보기</button>
    </form>
    <div class="picks" id="picks"></div>
    <div id="duo-body"></div>`;

  document.getElementById("duo-form").onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.partner.value.trim();
    if (!v.includes("#")) { toast("Riot ID 는 이름#태그 모양으로 적어 주세요"); return; }
    location.hash = duoHref(v);
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
      <div class="dial" style="--p:${d.score}" role="img" aria-label="궁합 ${d.score}점"><b>${d.score}</b><span>궁합 점수</span></div>
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
