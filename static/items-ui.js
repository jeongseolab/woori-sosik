// 아이템 추천 화면. #/items 는 Tier.gg 앱 안내·내려받기(app-ui.js), 웹에서 빌드만 미리 보는 화면은
// #/items/web, #/items/<챔피언 번호>/<라인>(이 파일).
// app.js 보다 먼저 읽고, app.js 의 도구(esc·load·known·view·routeSeq·champImg·toast) 를 부를 때 쓴다.
// 계산은 서버(items.py) 가 한다. 여기서는 챔피언·라인·예산을 고르고 결과를 그린다.

const ITEM_LANES = [["top", "탑"], ["jungle", "정글"], ["mid", "미드"], ["adc", "원딜"], ["support", "서폿"]];
const ITEM_ROLE_KO = { marksman: "원딜", mage: "마법사", assassin: "암살자", fighter: "전사", tank: "탱커", support: "서포터" };
const ITEM_BUDGET_KEY = "tiergg-items-budget";
let itemData = null;        // static/items/data.json(챔피언 목록·아이템 이름). 한 번만 받는다
let itemBudget = "full";    // full(끝까지) | usual(평소 버는 골드) | 숫자
try { itemBudget = localStorage.getItem(ITEM_BUDGET_KEY) || "full"; } catch {}

function itemIcon(id, size = 48) {
  return `<img src="/items/icons/${id}.png" alt="" width="${size}" height="${size}" loading="lazy">`;
}

async function itemDataLoad() {
  if (!itemData) {
    const res = await fetch("/items/data.json");
    if (!res.ok) throw new Error("아이템 자료를 받지 못했어요");
    itemData = await res.json();
  }
  return itemData;
}

// 내 티어표 챔피언(OP 먼저). 티어표를 아직 못 받았으면 빈 목록(받는 대로 다시 그리지는 않는다)
function myTierChamps() {
  const t = known("/api/tierlist");
  if (!t || !t.op) return [];
  return [t.op, ...["1", "2", "3", "4", "5"].flatMap(k => t.tiers[k] || [])]
    .filter(c => typeof c.id === "number");
}

async function renderItems(arg) {
  if (!arg) {
    if (!IN_APP) return renderAppLanding();
    itemDataLoad().catch(() => {});         // 하위템 이름(상태 카드) 에 쓴다
    return renderAppHome();
  }
  return renderItemsWeb(arg === "web" ? "" : arg);
}

async function renderItemsWeb(arg) {
  const seq = routeSeq;
  const [champArg, laneArg] = (arg || "").split("/");
  const webBar = IN_APP
    ? `<p class="ib-webbar">웹 미리보기예요. 게임 중 추천은 <a href="#/items">아이템 추천</a> 화면과 작은 창에서 봐요.</p>`
    : `<p class="ib-webbar">웹 미리보기예요. 게임 중에는 상황을 알아서 읽는 <a href="#/items">Tier.gg 앱</a>을 써요.</p>`;
  view.innerHTML = webBar + `<h1>아이템 추천</h1>` + funLoader("아이템 자료를 펼치는 중이에요.");
  let d;
  try { d = await itemDataLoad(); } catch (ex) { return failed(ex.message, () => renderItemsWeb(arg)); }
  // 티어표가 없으면 뒤에서 받아 둔다(다음에 열 때 내 챔피언이 보인다)
  if (!known("/api/tierlist")) load("/api/tierlist").then(() => {
    if (seq === routeSeq && !champArg) renderItemsWeb(arg);
  }).catch(() => {});
  if (seq !== routeSeq) return;

  const mine = myTierChamps();
  const pick = champArg ? Number(champArg) : (mine[0] && mine[0].id);
  const lane = laneArg || (mine.find(c => c.id === pick) || {}).lane || "";
  const champs = Object.entries(d.champions).map(([id, c]) => ({ id: Number(id), ...c }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const href = (id, ln) => "#/items/" + id + (ln ? "/" + ln : "");

  view.innerHTML = webBar + `
    <h1>아이템 추천 <small class="ib-web-tag">웹 미리보기</small></h1>
    <p class="lead">라인을 고르면 OP.GG 템트리(코어 순서)를 뼈대로, 상대 조합에 맞춰 신발과 4~6번째를 골라요. 지금 골드를 넣으면 이번 귀환에 살 하위템까지 찾아요. 패치 ${esc(d.patch)} 아이템 기준이에요.</p>
    ${mine.length ? `
      <div class="ib-mine" aria-label="내 티어표 챔피언">
        ${mine.slice(0, 12).map((c, i) => `
          <a class="ib-chip ${c.id === pick ? "on" : ""}" href="${href(c.id, c.lane)}" title="${esc(c.name)} · ${esc(c.lane_ko || "")}">
            ${c.image ? `<img src="${esc(c.image)}" alt="" width="40" height="40" loading="lazy">` : ""}
            <span>${i === 0 ? "OP " : ""}${esc(c.name)}</span></a>`).join("")}
      </div>` : `<p class="note">내 티어표를 받으면 여기 내 챔피언이 보여요.</p>`}
    <form class="ib-form" id="ib-form">
      <div>
        <label for="ib-champ">챔피언</label>
        <input id="ib-champ" list="ib-champs" placeholder="챔피언 이름" autocomplete="off"
               value="${esc((d.champions[pick] || {}).name || "")}">
        <datalist id="ib-champs">${champs.map(c => `<option value="${esc(c.name)}">`).join("")}</datalist>
      </div>
      <div>
        <label>라인</label>
        <div class="seg ib-lane" role="group" aria-label="라인">
          ${ITEM_LANES.map(([k, ko]) => `<button type="button" data-lane="${k}" aria-selected="${k === lane}">${ko}</button>`).join("")}
        </div>
      </div>
    </form>
    <div id="ib-body"></div>`;

  const form = document.getElementById("ib-form");
  const input = document.getElementById("ib-champ");
  const go = () => {
    const name = input.value.trim();
    const c = champs.find(x => x.name === name) || champs.find(x => x.name.startsWith(name) && name);
    if (!c) { if (name) toast("그런 챔피언을 찾지 못했어요"); return; }
    location.hash = href(c.id, lane);
  };
  input.addEventListener("change", go);
  form.onsubmit = e => { e.preventDefault(); go(); };
  form.querySelectorAll("[data-lane]").forEach(b => b.onclick = () => {
    if (pick) location.hash = href(pick, b.dataset.lane === lane ? "" : b.dataset.lane);
  });

  if (!pick) {
    document.getElementById("ib-body").innerHTML = `<div class="empty-state"><strong>챔피언을 골라 주세요</strong><p>이름을 적거나 위의 내 챔피언을 누르면 빌드를 찾아요.</p></div>`;
    return;
  }
  drawItemBuild(pick, lane, seq);
}

// 게임 상황(시간·라인전·아군·적). 비어 있는 칸은 서버가 그 기준을 쓰지 않는다. 챔피언을 바꿔도 남긴다(같은 판을 여러 챔피언으로 견줘 보게)
const itemSit = { t: 0, lane: null, allies: [], enemies: [], foes: [], gold: 0 };
const ITEM_LANE_STATES = [[null, "모름"], [-0.7, "밀림"], [0, "비슷"], [0.7, "앞섬"]];

function sitParams() {
  const p = {};
  if (itemSit.t > 0) p.t = itemSit.t;
  if (itemSit.lane != null) p.lane_state = itemSit.lane;
  if (itemSit.allies.length) p.allies = itemSit.allies.join(",");
  if (itemSit.enemies.length) p.enemies = itemSit.enemies.join(",");
  if (itemSit.foes.length) p.foes = itemSit.foes.join(",");
  if (itemSit.gold > 0) p.now_gold = itemSit.gold;
  return p;
}

function sitPanel(champ) {
  const champs = itemData.champions;
  const team = (key, label, max) => `
    <div class="ib-team">
      <span class="ib-team-label">${label} <small>${itemSit[key].length}/${max}</small></span>
      ${itemSit[key].map(id => `<button type="button" class="ib-pick" data-drop="${key}:${id}" title="${esc((champs[id] || {}).name)} 빼기">
        <img src="${esc(champImg((champs[id] || {}).key))}" alt="" width="28" height="28"><span>${esc((champs[id] || {}).name)}</span><i aria-hidden="true">×</i></button>`).join("")}
      ${itemSit[key].length < max ? `<input class="ib-add" data-add="${key}" list="ib-champs" placeholder="+ 챔피언" aria-label="${label} 더하기">` : ""}
    </div>`;
  const on = itemSit.t > 0 || itemSit.lane != null || itemSit.allies.length || itemSit.enemies.length
    || itemSit.foes.length || itemSit.gold > 0;
  return `
    <details class="ib-sit" ${on ? "open" : ""}>
      <summary>게임 상황 넣기 <small>${on ? "적용 중" : "시간 · 지금 골드 · 라인전 · 맞라인 · 아군과 적 조합"}</small></summary>
      <div class="ib-sit-row">
        <label for="ib-t">게임 시간</label>
        <input type="range" id="ib-t" min="0" max="40" step="1" value="${itemSit.t}">
        <output for="ib-t">${itemSit.t > 0 ? itemSit.t + "분" : "모름"}</output>
      </div>
      <div class="ib-sit-row">
        <label for="ib-now">지금 골드</label>
        <input type="range" id="ib-now" min="0" max="5000" step="50" value="${itemSit.gold}">
        <output for="ib-now">${itemSit.gold > 0 ? itemSit.gold.toLocaleString() : "모름"}</output>
      </div>
      <div class="ib-sit-row">
        <span class="ib-team-label">라인전</span>
        <div class="seg" role="group" aria-label="라인전 상태">
          ${ITEM_LANE_STATES.map(([v, ko]) => `<button type="button" data-lane-state="${v}" aria-selected="${itemSit.lane === v}">${ko}</button>`).join("")}
        </div>
      </div>
      ${team("foes", "맞라인", 2)}
      ${team("allies", "아군(나 빼고)", 4)}
      ${team("enemies", "적", 5)}
      <div class="toolbar"><button type="button" class="ghost" id="ib-sit-clear" ${on ? "" : "disabled"}>상황 지우기</button>
        <span class="note">게임 중에는 오버레이가 이걸 실제 게임에서 읽어요(시간·내 골드와 가방·맞라이너와 CS·킬·레벨·아이템 비교·10명 조합). 여기서는 빈 가방으로 봐요.</span></div>
    </details>`;
}

// 예산 버튼·슬라이더는 같은 화면(같은 routeSeq) 에서 다시 그린다. 늦게 온 예전 답이 새 답을 덮지 않게 그릴 때마다 번호를 매긴다
let itemDrawSeq = 0;

async function drawItemBuild(champ, lane, routeAt) {
  const tok = ++itemDrawSeq;
  const live = () => tok === itemDrawSeq && routeAt === routeSeq;
  const body = document.getElementById("ib-body");
  const ask = budget => "/api/items/build?" + new URLSearchParams({ champion: champ, ...(lane ? { lane } : {}), ...(budget ? { gold: budget } : {}), ...sitParams() });
  // 예산을 정하려면 "평소 골드" 를 알아야 해서, 먼저 제한 없이 한 번 받는다(서버가 기억해 둬서 빠르다)
  const path0 = ask(null);
  if (!known(path0)) body.innerHTML = funLoader("6칸과 골드 안에서 가장 좋은 조합을 따져 보는 중이에요.", true);
  let r;
  try { r = await load(path0); } catch (ex) {
    if (live()) body.innerHTML = `<div class="empty-state"><strong>${esc(ex.message)}</strong></div>`;
    return;
  }
  const usual = r.usual;
  const budget = itemBudget === "usual" ? (usual && usual.budget) : itemBudget === "full" ? null : Number(itemBudget) || null;
  if (budget) {
    try { r = await load(ask(budget)); } catch (ex) {
      if (live()) body.innerHTML = `<div class="empty-state"><strong>${esc(ex.message)}</strong></div>`;
      return;
    }
  }
  if (!live()) return;

  const roles = (r.champion.roles || []).map(x => ITEM_ROLE_KO[x] || x).join("·");
  const laneKo = (ITEM_LANES.find(([k]) => k === r.lane) || [])[1];
  const methods = [
    ["best", "최종 추천", "DP·가성비가 고른 것과 값이 큰 후보를 모아 전부 따져 본 답. 치명타 100% 상한·라바돈까지 반영"],
    ["dp", "DP", "칸 × 골드 표를 채워 찾은 답. 스탯을 그냥 더해서 본다"],
    ["greedy", "가성비 순", "골드당 값이 큰 것부터 담은 답. 빠르지만 비싼 핵심을 놓치기 쉽다"],
  ];
  const hasTree = !!(r.tree && r.tree.source === "opgg");
  const sameAs = (a, b) => a.items.map(x => x.id).sort().join() === b.items.map(x => x.id).sort().join();
  const maxW = Math.max(...r.weights.map(x => x.w), 1);

  body.innerHTML = `
    <section class="ib-head">
      <img src="${esc(champImg(r.champion.key))}" alt="" width="56" height="56">
      <div><b>${esc(r.champion.name)}</b><small>${esc(roles)} · ${r.champion.damage === "magic" ? "AP" : r.champion.damage === "physical" ? "AD" : "AD·AP"}${laneKo && laneKo !== roles ? " · " + laneKo + " 라인" : ""}</small></div>
    </section>
    ${sitPanel(champ)}
    ${treeSection(r)}
    ${nowSection(r)}
    <section class="ib-head ib-head-sub">
      <h2 class="sub-h">스탯 값으로 찾은 빌드 <small>${hasTree ? "비교용 · 템트리 없이 계산" : "OP.GG 템트리가 없어 이걸 써요"}</small></h2>
      <div class="seg ib-budget" role="group" aria-label="골드 예산">
        <button type="button" data-budget="full" aria-selected="${itemBudget === "full"}">끝까지</button>
        <button type="button" data-budget="usual" aria-selected="${itemBudget === "usual"}" ${usual ? "" : "disabled title=\"이 챔피언으로 한 판이 아직 없어요\""}>평소 골드${usual ? " " + usual.budget.toLocaleString() : ""}</button>
        <button type="button" data-budget="pick" aria-selected="${!["full", "usual"].includes(itemBudget)}">직접</button>
      </div>
    </section>
    <div class="ib-range" ${["full", "usual"].includes(itemBudget) ? "hidden" : ""}>
      <input type="range" min="3000" max="19000" step="250" value="${budget || 10000}" id="ib-gold" aria-label="골드 예산">
      <output for="ib-gold">${(budget || 10000).toLocaleString()}골드</output>
    </div>
    ${usual ? `<p class="note">평소 골드: 내 협곡 ${usual.games}판에서 ${esc(r.champion.name)}로 평균 ${usual.avg_gold.toLocaleString()}골드${usual.avg_min ? "(" + usual.avg_min + "분)" : ""}를 벌었어요. 와드·물약 몫 10%를 빼고 예산으로 써요.</p>` : ""}

    <section class="ib-build" aria-label="추천 빌드">
      <ol>${r.best.items.map((it, i) => `
        <li title="${esc(it.name)} · ${it.price.toLocaleString()}골드">
          <span class="ib-n">${i + 1}</span>${itemIcon(it.id, 64)}
          <b>${esc(it.name)}</b><small>${it.price.toLocaleString()}골드</small></li>`).join("")}
        ${Array.from({ length: Math.max(0, r.slots - r.best.items.length) }, () => `<li class="ib-empty" aria-hidden="true"><span class="ib-slot"></span></li>`).join("")}
      </ol>
      <p class="ib-total">${r.best.price.toLocaleString()}골드${r.budget ? " / 예산 " + r.budget.toLocaleString() : ""} · 쓸모 있는 값 <b>${r.best.true_value.toLocaleString()}</b>골드어치</p>
      ${!hasTree && r.reasons && r.reasons.length ? `<ul class="ib-why">${r.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </section>

    <div class="ib-cols">
      <section>
        <h2 class="sub-h">${esc(r.champion.name)}가 아끼는 스탯</h2>
        <ul class="ib-weights">${r.weights.slice(0, 9).map(x => `
          <li><span>${esc(x.name)}</span><i style="--w:${(x.w / maxW * 100).toFixed(0)}%"></i><small>${x.gold ? (x.gold < 10 ? x.gold.toFixed(1) : Math.round(x.gold)) + "골드" : ""}</small></li>`).join("")}</ul>
        <p class="note">막대는 아끼는 정도(역할·AD/AP·내구도·라인으로 정함), 오른쪽은 그 스탯 1의 골드 값(재료 아이템 값에서 계산)이에요. 아이템 값 = 스탯 × 골드 값 × 아끼는 정도.</p>
      </section>
      <section>
        <h2 class="sub-h">세 가지 방법 비교</h2>
        <div class="table-wrap"><table class="ib-table">
          <thead><tr><th scope="col">방법</th><th scope="col">빌드</th><th scope="col">골드</th><th scope="col">값</th><th scope="col">시간</th></tr></thead>
          <tbody>${methods.map(([k, name, why]) => `
            <tr class="${k === "best" ? "me" : ""}">
              <th scope="row" title="${esc(why)}">${name}</th>
              <td><span class="mini">${r[k].items.map(it => itemIcon(it.id, 28)).join("")}</span>
                ${k !== "best" && sameAs(r[k], r.best) ? `<small class="ib-same">최종과 같음</small>` : ""}</td>
              <td>${r[k].price.toLocaleString()}</td>
              <td><b>${r[k].true_value.toLocaleString()}</b></td>
              <td>${r[k].ms < 0.1 ? "0.1ms 미만" : r[k].ms + "ms"}</td>
            </tr>`).join("")}</tbody>
        </table></div>
        <p class="note">후보 ${r.candidates}개(전설·신발). DP 는 묶음(신발·히드라·광휘 …)마다 하나만, 신발은 꼭 하나 넣어요. 최종 추천은 줄인 후보로 ${r.exact_tried.toLocaleString()}가지 조합을 전부 따졌어요. 값은 치명타 100% 상한을 반영한 값이라 DP 가 치명타를 넘치게 담으면 여기서 깎여요.</p>
      </section>
    </div>
    <p class="note ib-limit">아이템 고유 효과(패시브)는 라바돈·서포터 아이템·중상·생존(존야·수호 천사 …)·정화만 값에 넣었어요. 게임 중에는 오버레이(<code>python tools/item_overlay.py</code>)가 진짜 가방과 골드로 이번에 살 것을 알려 줘요.</p>`;

  body.querySelectorAll("[data-budget]").forEach(b => b.onclick = () => {
    const v = b.dataset.budget;
    itemBudget = v === "pick" ? String(budget || usual && usual.budget || 10000) : v;
    try { localStorage.setItem(ITEM_BUDGET_KEY, itemBudget); } catch {}
    drawItemBuild(champ, lane, routeAt);
  });
  // 게임 상황 칸
  const redraw = () => drawItemBuild(champ, lane, routeAt);
  const tRange = document.getElementById("ib-t");
  tRange.oninput = () => { tRange.nextElementSibling.textContent = Number(tRange.value) > 0 ? tRange.value + "분" : "모름"; };
  tRange.onchange = () => { itemSit.t = Number(tRange.value); redraw(); };
  const nowRange = document.getElementById("ib-now");
  nowRange.oninput = () => { nowRange.nextElementSibling.textContent = Number(nowRange.value) > 0 ? Number(nowRange.value).toLocaleString() : "모름"; };
  nowRange.onchange = () => { itemSit.gold = Number(nowRange.value); redraw(); };
  body.querySelectorAll("[data-lane-state]").forEach(b => b.onclick = () => {
    itemSit.lane = b.dataset.laneState === "null" ? null : Number(b.dataset.laneState);
    redraw();
  });
  body.querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
    const [key, id] = b.dataset.drop.split(":");
    itemSit[key] = itemSit[key].filter(x => x !== Number(id));
    redraw();
  });
  body.querySelectorAll("[data-add]").forEach(inp => inp.onchange = () => {
    const name = inp.value.trim();
    const hit = Object.entries(itemData.champions).find(([, c]) => c.name === name);
    if (!hit) { if (name) toast("그런 챔피언을 찾지 못했어요"); return; }
    const key = inp.dataset.add, id = Number(hit[0]);
    if (!itemSit[key].includes(id)) itemSit[key].push(id);
    redraw();
  });
  document.getElementById("ib-sit-clear").onclick = () => {
    Object.assign(itemSit, { t: 0, lane: null, allies: [], enemies: [], foes: [], gold: 0 });
    redraw();
  };

  const range = document.getElementById("ib-gold");
  if (range) {
    const out = range.nextElementSibling;
    range.oninput = () => { out.textContent = Number(range.value).toLocaleString() + "골드"; };
    range.onchange = () => {
      itemBudget = range.value;
      try { localStorage.setItem(ITEM_BUDGET_KEY, itemBudget); } catch {}
      drawItemBuild(champ, lane, routeAt);
    };
  }
}

const ITEM_SLOT_KO = { core1: "코어 1", core2: "코어 2", core3: "코어 3", boots: "신발", fourth: "4번째", fifth: "5번째",
  sixth: "6번째", owned: "가진 것", value: "" };

// OP.GG 템트리 뼈대로 짠 빌드. 상황 때문에 OP.GG 첫 후보와 다른 템을 골랐으면 그 칸에 표시한다
function treeSection(r) {
  if (!r.tree || r.tree.source !== "opgg") {
    return r.lane ? `<p class="note">OP.GG 템트리를 받지 못해서 아래 스탯 값 빌드를 보여 줘요.</p>`
      : `<p class="note">라인을 고르면 OP.GG 템트리(코어 순서)로 빌드를 짜요.</p>`;
  }
  const t = r.tree;
  return `
    <section class="ib-build" aria-label="템트리 빌드">
      <h2 class="sub-h">템트리 빌드 <small>OP.GG 코어 순서 + 상황</small></h2>
      <ol>${t.items.map((it, i) => `
        <li title="${esc(it.name)} · ${it.price.toLocaleString()}골드${it.note ? " · " + esc(it.note) : ""}" class="${it.note ? "ib-swap" : ""}">
          <span class="ib-n">${i + 1}</span>${itemIcon(it.id, 64)}
          <b>${esc(it.name)}</b><small>${esc(ITEM_SLOT_KO[it.slot] || "")}${it.note ? " · 상황" : ""}</small></li>`).join("")}
      </ol>
      ${t.reasons.length ? `<ul class="ib-why">${t.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </section>`;
}

// 지금 골드로 이번 귀환에 살 것(빈 가방 기준). dp 와 완전 탐색을 같이 보여 준다
function nowSection(r) {
  const n = r.now;
  if (!n) return "";
  const cons = (itemData && itemData.consumables) || {};
  const row = b => `
    <li>${itemIcon(b.id, 40)}<div><b>${esc(b.name)}</b> <span>${b.cost.toLocaleString()}골드</span>
      ${b.toward ? `<small>→ ${esc(b.toward)}</small>` : ""}${b.why && !cons[b.id] ? `<small class="ib-now-why">${esc(b.why)}</small>` : ""}</div></li>`;
  const spent = n.buy.reduce((a, b) => a + b.cost, 0);
  return `
    <section class="ib-now" aria-label="이번에 살 것">
      <h2 class="sub-h">이번 귀환에 살 것 <small>${itemSit.gold.toLocaleString()}골드 · 빈 가방</small></h2>
      ${n.buy.length ? `<ul class="ib-now-list">${n.buy.map(row).join("")}</ul>
        <p class="note">${spent.toLocaleString()}골드를 써요. 하위템 묶음을 DP(칸 × 골드 표)로 고르고, 앞쪽 묶음은 전부 따져 확인했어요
          (DP ${n.dp.value.toLocaleString()} · 전부 따짐 ${n.exact.value.toLocaleString()} · ${n.exact.tried.toLocaleString()}가지).</p>`
        : `<p class="note">이 골드로는 살 만한 재료가 없어요.</p>`}
    </section>`;
}
