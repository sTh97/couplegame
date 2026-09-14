import { api, clearToken, deviceId, getToken, setToken } from "./api.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const heartsEl = document.getElementById("hearts");

const ui = {
  view: "landing",
  ageOk: false,
  nickname: localStorage.getItem("cg_nick") || "",
  pin: "",
  joinToken: "",
  joinPreview: null,
  state: null,
  history: [],
  loading: false,
  error: "",
  selectedOption: null,
  selectedChallenge: null,
  challengeDetail: null,
  questionStartedAt: Date.now(),
  advancing: false,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

let pollTimer = null;
let pollInFlight = false;
let lastVisualKey = "";
let lastView = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2800);
}

function heartSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20s-7-4.4-7-9.1C5 8.1 7.2 6.5 9.4 7.8c1 .6 1.8 1.9 2.6 3.1.8-1.2 1.6-2.5 2.6-3.1C16.8 6.5 19 8.1 19 10.9 19 15.6 12 20 12 20z" fill="#E58A9A"/></svg>`;
}

function spawnHearts() {
  if (ui.reducedMotion || !heartsEl || ui.view !== "landing") return;
  const el = document.createElement("div");
  el.className = "heart";
  el.textContent = "❤";
  el.style.left = `${18 + Math.random() * 64}%`;
  el.style.animationDuration = `${10 + Math.random() * 3}s`;
  heartsEl.appendChild(el);
  setTimeout(() => el.remove(), 13000);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (document.hidden || pollInFlight) return;
    pollInFlight = true;
    refreshState()
      .catch(() => {})
      .finally(() => {
        pollInFlight = false;
      });
  }, 2000);
}

function routeFromPath() {
  const path = location.pathname;
  const m = path.match(/^\/r\/([^/]+)/);
  if (m) {
    ui.joinToken = decodeURIComponent(m[1]);
    ui.view = ui.ageOk || getToken() ? "join" : "age";
    return;
  }
  if (path === "/history") ui.view = "history";
}

function go(view, replace = false) {
  ui.view = view;
  ui.error = "";
  const map = {
    landing: "/",
    waiting: "/play",
    mode: "/play",
    intensity: "/play",
    game: "/play",
    result: "/play",
    report: "/play",
    history: "/history",
  };
  const url = ui.joinToken && (view === "join" || view === "age") ? `/r/${ui.joinToken}` : map[view] || "/";
  if (replace) window.history.replaceState({ view }, "", url);
  else window.history.pushState({ view }, "", url);
  render();
}

window.addEventListener("popstate", () => {
  routeFromPath();
  render();
});

window.addEventListener("online", () => render());
window.addEventListener("offline", () => render());

async function refreshState() {
  if (!getToken()) return;
  const data = await api("/api/state");
  applyState(data.state);
}

function visualKey() {
  const s = ui.state;
  const g = s?.game;
  return JSON.stringify({
    view: ui.view,
    error: ui.error,
    loading: ui.loading,
    selectedOption: ui.selectedOption,
    selectedChallenge: ui.selectedChallenge,
    advancing: ui.advancing,
    ageOk: ui.ageOk,
    online: navigator.onLine,
    joinPreview: ui.joinPreview,
    historyLen: (ui.history || []).length,
    roomStatus: s?.room?.status,
    players: s?.room?.players,
    me: s?.me,
    game: g && {
      status: g.status,
      mode: g.mode,
      proposedMode: g.proposedMode,
      modeProposedBy: g.modeProposedBy,
      effectiveIntensity: g.effectiveIntensity,
      currentRound: g.currentRound,
      scores: g.scores,
      myAnswered: g.myAnswered,
      partnerAnswered: g.partnerAnswered,
      mySelectedOptionId: g.mySelectedOptionId,
      roundResult: g.roundResult,
      challenge: g.challenge,
      winner: g.winner,
      disconnectedPartner: g.disconnectedPartner,
      questionId: g.myQuestion?.questionId,
      pausedBy: g.pausedBy,
      resumeAck: g.resumeAck,
      reportReady: g.reportReady,
    },
  });
}

function applyState(state) {
  if (!state) return;
  ui.state = state;
  const g = state.game;
  const r = state.room;
  if (!g) {
    if (r?.status === "WAITING_FOR_PARTNER" || r?.status === "PARTNER_JOINED" || r?.status === "WAITING_FOR_READY") {
      if (!["waiting", "age", "create", "join"].includes(ui.view)) ui.view = "waiting";
    }
  } else {
    const map = {
      MODE_SELECTION: "mode",
      BOUNDARY_SELECTION: "intensity",
      IN_PROGRESS: "game",
      ROUND_ACTIVE: "game",
      WAITING_FOR_BOTH_ANSWERS: "game",
      ROUND_RESULT: "game",
      CHALLENGE_ACTIVE: "game",
      PAUSED: "game",
      COMPLETED: ui.view === "report" ? "report" : "result",
      ABANDONED: "result",
    };
    const next = map[g.status];
    if (next) ui.view = next;
    if ((g.status === "ROUND_ACTIVE" || g.status === "IN_PROGRESS") && g.currentRound !== ui._roundTimer) {
      ui._roundTimer = g.currentRound;
      ui.questionStartedAt = Date.now();
    }
  }
  render();
}

async function restoreSession() {
  if (!getToken()) return false;
  try {
    const data = await api("/api/state");
    applyState(data.state);
    startPoll();
    return true;
  } catch {
    clearToken();
    return false;
  }
}

function h(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ""), "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function screen(inner) {
  const active = document.activeElement;
  const activeId = active && app.contains(active) ? active.id : "";
  const start = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
  const end = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;
  const respVal = document.getElementById("resp")?.value;
  const nickVal = document.getElementById("nick")?.value;
  const pinVal = document.getElementById("pin")?.value;
  const linkVal = document.getElementById("link")?.value;
  const scrollY = window.scrollY;
  const offline = navigator.onLine ? "" : `<div class="offline">You’re offline — we’ll resume when you reconnect.</div>`;
  const cls = ui._animateScreen ? "screen screen-enter" : "screen";
  app.innerHTML = `${offline}<div class="${cls}">${inner}</div>`;
  bind();
  const restore = (id, val) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  restore("resp", respVal);
  restore("nick", nickVal);
  restore("pin", pinVal);
  restore("link", linkVal);
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
      if (start != null && el.setSelectionRange) {
        try {
          el.setSelectionRange(start, end);
        } catch {
          /* not a text field */
        }
      }
    }
  }
  if (scrollY) window.scrollTo(0, scrollY);
}

function topbar(title, { back, extra } = {}) {
  return h`
    <div class="topbar">
      ${back ? `<button class="icon-btn" data-act="back" aria-label="Back">←</button>` : `<span class="icon-btn" style="visibility:hidden"></span>`}
      <div class="kicker">${escapeHtml(title)}</div>
      ${extra || `<span class="icon-btn" style="visibility:hidden"></span>`}
    </div>`;
}

function landing() {
  screen(h`
    <p class="kicker" style="text-align:center">Private · Two players · 18+</p>
    <div class="hero-mark">${heartSvg()}</div>
    <h1>A room for two.</h1>
    <p class="lede">Light trivia, optional closeness, and a night that stays between you. No accounts. No third players. Ever.</p>
    <div class="stack">
      <button class="btn btn-primary" data-act="start-create">Create a Room</button>
      <button class="btn btn-secondary" data-act="start-join">I Have a Link</button>
    </div>
    <p class="faint tiny" style="text-align:center;margin-top:22px">Mutual consent. Skip anytime. Nothing explicit. Nothing recorded on camera.</p>
  `);
}

function age(next) {
  screen(h`
    ${topbar("Welcome", { back: true })}
    <h1 style="text-align:left;font-size:2rem">A grown-up space.</h1>
    <p class="muted">Both of you need to confirm you are 18 or older before a private room can exist. We store only a timestamp — no ID, no biometrics.</p>
    <label class="check" style="margin:20px 0">
      <input type="checkbox" id="age" ${ui.ageOk ? "checked" : ""} />
      <span>I confirm that I am 18 years of age or older, and I am entering this private session willingly.</span>
    </label>
    <p class="tiny" id="age-err" style="color:var(--bad)">${ui.error ? escapeHtml(ui.error) : ""}</p>
    <div class="bottom-cta">
      <button class="btn btn-primary" data-act="confirm-age" data-next="${next || "create"}">Confirm & Continue</button>
      <button class="btn btn-ghost" data-act="home">Exit</button>
    </div>
  `);
}

function createRoom() {
  screen(h`
    ${topbar("Create room", { back: true })}
    <h1 style="text-align:left;font-size:2rem">Your seat is A.</h1>
    <p class="muted">Choose a nickname. Optionally lock the room with a short PIN your partner will type.</p>
    <div class="field">
      <label for="nick">Nickname</label>
      <input id="nick" maxlength="20" value="${escapeHtml(ui.nickname)}" placeholder="How should they see you?" />
    </div>
    <div class="field">
      <label for="pin">Optional PIN (4–6 digits)</label>
      <input id="pin" inputmode="numeric" maxlength="6" value="${escapeHtml(ui.pin)}" placeholder="Leave blank for none" />
    </div>
    <p class="tiny" style="color:var(--bad)">${escapeHtml(ui.error)}</p>
    <div class="bottom-cta">
      <button class="btn btn-primary" data-act="create-room" ${ui.loading ? "disabled" : ""}>${ui.loading ? "Creating…" : "Create Room"}</button>
    </div>
  `);
}

function joinRoom() {
  const preview = ui.joinPreview;
  screen(h`
    ${topbar("Join", { back: true })}
    <h1 style="text-align:left;font-size:2rem">${preview?.available === false ? "This door is closed." : "Your seat is B."}</h1>
    ${
      preview?.available === false
        ? `<p class="muted">${escapeHtml(preview.message)}</p><button class="btn btn-secondary" data-act="home">Back home</button>`
        : h`
      <p class="muted">${preview?.creatorNickname ? `${escapeHtml(preview.creatorNickname)} is waiting.` : "Enter the invitation and your nickname."}</p>
      ${
        ui.joinToken
          ? ""
          : `<div class="field"><label for="link">Invite link or code</label><input id="link" placeholder="Paste the link or token" value="${escapeHtml(ui.joinToken)}" /></div>`
      }
      <div class="field">
        <label for="nick">Nickname</label>
        <input id="nick" maxlength="20" value="${escapeHtml(ui.nickname)}" />
      </div>
      ${
        preview?.hasPin
          ? `<div class="field"><label for="pin">Room PIN</label><input id="pin" inputmode="numeric" maxlength="6" /></div>`
          : ""
      }
      <p class="tiny" style="color:var(--bad)">${escapeHtml(ui.error)}</p>
      <div class="bottom-cta">
        <button class="btn btn-primary" data-act="join-room" ${ui.loading ? "disabled" : ""}>${ui.loading ? "Joining…" : "Join Room"}</button>
      </div>`
    }
  `);
}

function waiting() {
  const r = ui.state?.room;
  const a = r?.players?.A;
  const b = r?.players?.B;
  const me = ui.state?.me;
  const invite = `${location.origin}/r/${r?.secureToken || ui.joinToken}`;
  screen(h`
    ${topbar("Waiting room", { extra: `<button class="icon-btn" data-act="history" aria-label="History">☰</button>` })}
    <h1 style="font-size:2rem">Just the two of you.</h1>
    <div class="dots">
      <span class="dot ${a?.connected ? "on" : "off"}" title="Player A"></span>
      <span class="dot ${b?.connected ? "on" : "off"}" title="Player B"></span>
    </div>
    <p class="waiting-copy pulse">${b ? "Your partner has joined." : "Waiting for your partner…"}</p>
    <div class="score-row">
      <div class="score-pill"><span class="tiny faint">You</span><strong>${escapeHtml(me?.nickname || "—")}</strong>${me?.ready ? "Ready" : "Not ready"}</div>
      <span class="faint">❤</span>
      <div class="score-pill"><span class="tiny faint">Partner</span><strong>${escapeHtml((me?.slot === "A" ? b : a)?.nickname || "…")}</strong>${(me?.slot === "A" ? b : a)?.ready ? "Ready" : "Waiting"}</div>
    </div>
    ${
      me?.slot === "A" && r?.secureToken
        ? `<div class="card"><p class="tiny faint">Invite link</p><div class="link-box"><input readonly value="${escapeHtml(invite)}" /><button class="btn btn-gold" style="min-height:48px;padding:10px 14px" data-act="copy-link">Copy</button></div><p class="tiny faint" style="margin-top:8px">Share this only with your partner.</p></div>`
        : ""
    }
    <div class="bottom-cta">
      <button class="btn btn-primary" data-act="ready">${me?.ready ? "I’m not ready" : "I’m Ready"}</button>
      <p class="tiny faint" style="text-align:center">The game starts only when both of you are ready.</p>
    </div>
  `);
}

function mode() {
  const g = ui.state?.game;
  const modes = ui.state?.modes || [];
  const me = ui.state?.me;
  const proposed = g?.proposedMode;
  const byMe = g?.modeProposedBy === me?.slot;
  screen(h`
    ${topbar("Mode")}
    <h1 style="font-size:2rem">How shall tonight feel?</h1>
    <p class="muted">You both have to agree on the same mode. Either of you may suggest another.</p>
    <div class="stack" style="margin-top:16px">
      ${modes
        .map(
          (m) => `<button class="card selectable ${proposed === m.modeId ? "selected" : ""}" data-act="pick-mode" data-id="${m.modeId}">
            <div class="kicker">${escapeHtml(m.tagline)}</div>
            <h3>${escapeHtml(m.name)}</h3>
            <p class="muted tiny">${escapeHtml(m.description)}</p>
          </button>`
        )
        .join("")}
    </div>
    ${
      proposed
        ? `<p class="muted" style="margin-top:16px">${
            byMe
              ? `You selected ${escapeHtml(modes.find((x) => x.modeId === proposed)?.name || proposed)}. Waiting for your partner…`
              : `Your partner selected ${escapeHtml(modes.find((x) => x.modeId === proposed)?.name || proposed)}.`
          }</p>`
        : ""
    }
    ${
      proposed && !byMe
        ? `<div class="row-actions" style="margin-top:12px">
            <button class="btn btn-primary" data-act="accept-mode">Accept</button>
            <button class="btn btn-secondary" data-act="suggest-mode">Suggest alternative</button>
          </div>`
        : ""
    }
  `);
}

function intensity() {
  const levels = ui.state?.intensities || [];
  const me = ui.state?.me;
  const g = ui.state?.game;
  screen(h`
    ${topbar("Boundaries")}
    <h1 style="font-size:2rem">Your comfort ceiling.</h1>
    <p class="muted">Chosen privately. Your partner never sees this pick — only the gentler of the two levels, once you both choose.</p>
    <div class="stack" style="margin-top:16px">
      ${levels
        .map(
          (lv) => `<button class="card selectable" data-act="pick-intensity" data-id="${lv.id}" ${me?.intensitySubmitted ? "disabled" : ""}>
            <h3>${escapeHtml(lv.name)}</h3>
            <p class="muted tiny">${escapeHtml(lv.description)}</p>
          </button>`
        )
        .join("")}
    </div>
    <p class="waiting-copy">${me?.intensitySubmitted ? (g?.effectiveIntensity ? `Tonight’s pace: ${escapeHtml(g.effectiveIntensity)}.` : "Waiting for your partner’s private choice…") : ""}</p>
  `);
}

function gameScreen() {
  const g = ui.state?.game;
  const r = ui.state?.room;
  if (!g) return waiting();
  if (g.status === "PAUSED" || g.disconnectedPartner) return paused();
  if (g.status === "CHALLENGE_ACTIVE") return challenge();
  if (g.status === "ROUND_RESULT" && g.roundResult) return roundResult();

  const q = g.myQuestion;
  const pct = Math.round(((g.currentRound - (g.myAnswered ? 0 : 1)) / (g.totalRounds || 10)) * 100);
  screen(h`
    ${topbar(`Round ${g.currentRound}/${g.totalRounds}`, { extra: `<button class="icon-btn" data-act="pause" aria-label="Pause">❚❚</button>` })}
    <div class="progress" aria-hidden="true"><span style="width:${Math.min(100, pct)}%"></span></div>
    <div class="score-row">
      <div class="score-pill"><span class="tiny faint">You</span><strong>${g.scores?.[ui.state.me.slot] ?? 0}</strong></div>
      <span class="faint">❤</span>
      <div class="score-pill"><span class="tiny faint">Partner</span><strong>${g.scores?.[ui.state.me.slot === "A" ? "B" : "A"] ?? 0}</strong></div>
    </div>
    ${
      q
        ? h`
      <p class="kicker">${escapeHtml(q.category)} · ${escapeHtml(q.difficulty)}</p>
      <h2 style="font-size:1.55rem;line-height:1.25">${escapeHtml(q.prompt)}</h2>
      <div class="options" style="margin-top:16px">
        ${(q.options || [])
          .map((o) => {
            const picked = g.mySelectedOptionId === o.optionId || ui.selectedOption === o.optionId;
            return `<button class="option ${picked ? "picked" : ""}" data-act="pick-option" data-id="${o.optionId}" ${g.myAnswered ? "disabled" : ""}>${escapeHtml(o.text)}</button>`;
          })
          .join("")}
      </div>
      <p class="waiting-copy">${g.myAnswered ? (g.partnerAnswered ? "" : "You answered ✓ — waiting for your partner…") : ""}</p>
      ${!g.myAnswered ? `<div class="bottom-cta"><button class="btn btn-primary" data-act="submit-answer" ${ui.selectedOption ? "" : "disabled"}>Lock in answer</button></div>` : ""}`
        : `<div class="card"><div class="skel"></div><div class="skel" style="margin-top:10px;width:70%"></div></div>`
    }
  `);
}

function roundResult() {
  const g = ui.state.game;
  const rr = g.roundResult;
  screen(h`
    ${topbar(`Round ${g.currentRound}/${g.totalRounds}`)}
    <div class="banner ${rr.myCorrect ? "ok" : "no"}">
      <div class="kicker">${rr.myCorrect ? "Correct" : "Not this one"}</div>
      <h2>${rr.myCorrect ? `+${rr.myScoreDelta}` : "+0"}</h2>
      <p class="muted tiny">Partner: ${rr.partnerCorrect ? "correct" : "missed"} · ${rr.partnerCorrect ? `+${rr.partnerScoreDelta}` : "+0"}</p>
    </div>
    <div class="score-row">
      <div class="score-pill"><span class="tiny faint">You</span><strong>${g.scores[ui.state.me.slot]}</strong></div>
      <span>❤</span>
      <div class="score-pill"><span class="tiny faint">Partner</span><strong>${g.scores[ui.state.me.slot === "A" ? "B" : "A"]}</strong></div>
    </div>
    <p class="muted" style="text-align:center">${rr.myCorrect && rr.partnerCorrect ? "Clean round. Onward." : "A miss opens an optional challenge — skip anytime, score unchanged."}</p>
    <div class="bottom-cta">
      <button class="btn btn-primary" data-act="advance">${ui.advancing ? "…" : "Continue"}</button>
    </div>
  `);
}

function challenge() {
  const ch = ui.state.game.challenge;
  if (!ch) return gameScreen();
  if (!ch.mine) {
    screen(h`
      ${topbar("Challenge")}
      <h1 style="font-size:2rem">A pause for closeness.</h1>
      <p class="waiting-copy pulse">${ch.selected ? "Your partner chose a challenge for both of you." : "Your partner is choosing a challenge…"}</p>
      ${
        ch.selected
          ? `<div class="card"><div class="kicker">${escapeHtml(ch.selected.challengeType)}</div><h3>${escapeHtml(ch.selected.title)}</h3><p class="muted">${escapeHtml(ch.selected.instruction)}</p></div>
             <p class="tiny faint" style="text-align:center;margin-top:12px">Do it together. They’ll mark it complete. Skipping never costs points.</p>`
          : ""
      }
    `);
    return;
  }
  if (ch.selectedId && ch.selected) {
    const sel = ch.selected;
    screen(h`
      ${topbar("Challenge")}
      <div class="kicker">${escapeHtml(sel.challengeType)} · ~${sel.estimatedDurationSec}s</div>
      <h1 style="text-align:left;font-size:2rem">${escapeHtml(sel.title)}</h1>
      <p class="muted">${escapeHtml(sel.instruction)}</p>
      ${sel.requiresResponse ? `<div class="field" style="margin-top:16px"><label for="resp">A few words, if you like</label><textarea id="resp" maxlength="500" placeholder="Optional — only stored with this challenge"></textarea></div>` : ""}
      <div class="bottom-cta">
        <button class="btn btn-primary" data-act="complete-challenge">${sel.requiresPhysicalAction ? "We did it" : "Mark complete"}</button>
        <div class="row-actions">
          <button class="btn btn-secondary" data-act="skip-challenge">Skip</button>
          <button class="btn btn-ghost" data-act="replace-challenge">Replace</button>
        </div>
        <p class="tiny faint" style="text-align:center">Skip and replace never affect your score.</p>
      </div>
    `);
    return;
  }
  screen(h`
    ${topbar("Choose a challenge")}
    <h1 style="font-size:2rem">Four doors. One is enough.</h1>
    <p class="muted">All of these stay at or below tonight’s agreed intensity. Your partner will see the one you accept.</p>
    <div class="stack" style="margin-top:14px">
      ${(ch.options || [])
        .map(
          (o) => `<button class="card selectable ${ui.selectedChallenge === o.challengeId ? "selected" : ""}" data-act="pick-challenge" data-id="${o.challengeId}">
            <div class="kicker">${escapeHtml(o.challengeType)}</div>
            <h3>${escapeHtml(o.title)}</h3>
            <p class="muted tiny">${escapeHtml(o.teaser)}</p>
          </button>`
        )
        .join("")}
    </div>
    <div class="bottom-cta">
      <button class="btn btn-primary" data-act="select-challenge" ${ui.selectedChallenge ? "" : "disabled"}>Accept this one</button>
      <button class="btn btn-ghost" data-act="replace-challenge">Show four new ones</button>
    </div>
  `);
}

function paused() {
  const g = ui.state.game;
  const waitingPartner = g.disconnectedPartner;
  screen(h`
    ${topbar(waitingPartner ? "Connection" : "Paused")}
    <h1 style="font-size:2rem">${waitingPartner ? "Your partner’s connection dropped." : "A breath."}</h1>
    <p class="muted">${waitingPartner ? "We’ll hold this exact round. They can return on this device or another with the same session." : "Both of you need to resume. Either of you may end the night without a forfeit."}</p>
    <div class="bottom-cta">
      ${waitingPartner ? "" : `<button class="btn btn-primary" data-act="resume">I’m ready to resume</button>`}
      <button class="btn btn-secondary" data-act="end-game">End game</button>
    </div>
  `);
}

function result() {
  const g = ui.state?.game;
  const me = ui.state?.me;
  const winner = g?.winner;
  const mineWin = winner === me?.slot;
  const draw = winner === "Draw";
  screen(h`
    ${topbar("Tonight")}
    <div class="banner win">
      <div class="kicker">Final</div>
      <h1>${draw ? "It’s a Tie — Perfect Match ❤" : mineWin ? "You Won ❤" : "They edged the trivia ❤"}</h1>
      <p class="muted">You ${g?.scores?.[me.slot] ?? 0} · Partner ${g?.scores?.[me.slot === "A" ? "B" : "A"] ?? 0}</p>
    </div>
    <div class="stack">
      <button class="btn btn-primary" data-act="open-report">Read tonight’s story</button>
      <button class="btn btn-secondary" data-act="history">Game history</button>
      <button class="btn btn-ghost" data-act="home-reset">New room</button>
    </div>
  `);
}

function report() {
  const report = ui.state?.game?.report;
  if (!report) {
    screen(`${topbar("Report")}<p class="muted">Gathering tonight’s story…</p>`);
    api(`/api/games/${ui.state.game.gameId}/report`)
      .then((d) => {
        ui.state.game.report = d.report;
        render();
      })
      .catch((e) => toast(e.message));
    return;
  }
  const me = ui.state.me.slot;
  const other = me === "A" ? "B" : "A";
  const ks = report.knowledgeStats?.[me];
  screen(h`
    ${topbar("Report", { back: true })}
    <h1 style="font-size:2rem">${escapeHtml(report.narrative?.title || "Tonight’s Game Story")}</h1>
    <p class="muted">${escapeHtml(report.narrative?.body || "")}</p>
    <dl class="report card" style="margin-top:16px">
      <dt>Mode</dt><dd>${escapeHtml(report.gameSummary?.mode)} · ${escapeHtml(report.gameSummary?.effectiveIntensity)}</dd>
      <dt>Scores</dt><dd>You ${report.scores?.[me]} · Partner ${report.scores?.[other]} · ${escapeHtml(report.winner === "Draw" ? "Draw" : report.winner === me ? "You" : "Partner")}</dd>
      <dt>Accuracy</dt><dd>${ks?.accuracy ?? 0}% · ${ks?.correct ?? 0} correct · ${ks?.incorrect ?? 0} missed</dd>
      <dt>Avg response</dt><dd>${Math.round((ks?.avgResponseTimeMs || 0) / 100) / 10}s</dd>
      <dt>Challenges</dt><dd>${report.challengeStats?.triggered || 0} opened · ${report.challengeStats?.completed || 0} completed · ${report.challengeStats?.skipped || 0} skipped</dd>
      <dt>Knowledge Champion</dt><dd>${escapeHtml(labelSlot(report.superlatives?.knowledgeChampion))}</dd>
      <dt>Fastest Thinker</dt><dd>${escapeHtml(labelSlot(report.superlatives?.fastestThinker))}</dd>
      <dt>Best category</dt><dd>${escapeHtml(report.superlatives?.bestCategory || "—")}</dd>
    </dl>
    <div class="bottom-cta">
      <button class="btn btn-secondary" data-act="privacy">Privacy & delete</button>
      <button class="btn btn-ghost" data-act="home-reset">Done</button>
    </div>
  `);
}

function labelSlot(v) {
  const me = ui.state?.me?.slot;
  if (v === "Draw" || v === "Both") return "Both of you";
  if (v === me) return "You";
  if (v === "A" || v === "B") return "Your partner";
  return v || "—";
}

function historyScreen() {
  screen(h`
    ${topbar("History", { back: true })}
    <h1 style="font-size:2rem">Previous nights.</h1>
    <p class="muted tiny">Metadata only — no challenge text lives here.</p>
    <div class="stack" style="margin-top:14px">
      ${(ui.history || [])
        .map(
          (g) => `<div class="card">
            <div class="kicker">${escapeHtml(g.mode || "Session")} · ${escapeHtml(g.status)}</div>
            <p>${new Date(g.createdAt).toLocaleString()} · ${g.scores ? `${g.scores.A}–${g.scores.B}` : ""}</p>
            ${g.status === "COMPLETED" ? `<button class="btn btn-ghost" data-act="delete-game" data-id="${g.gameId}">Delete this session</button>` : ""}
          </div>`
        )
        .join("") || `<p class="muted">No sessions on this device yet.</p>`}
    </div>
  `);
}

function privacy() {
  screen(h`
    ${topbar("Privacy", { back: true })}
    <h1 style="font-size:2rem">Your night stays yours.</h1>
    <p class="muted">No photos, audio, or video. Challenge responses are excluded from logs. You may delete this session’s history and report.</p>
    <div class="bottom-cta">
      <button class="btn btn-secondary" data-act="delete-current">Delete this game</button>
      <button class="btn btn-ghost" data-act="home-reset">Leave</button>
    </div>
  `);
}

function render() {
  const key = visualKey();
  const viewChanged = ui.view !== lastView;
  if (!viewChanged && key === lastVisualKey) return;
  lastVisualKey = key;
  ui._animateScreen = viewChanged && !ui.reducedMotion;
  lastView = ui.view;
  const v = ui.view;
  if (v === "landing") landing();
  else if (v === "age") age(ui.joinToken ? "join" : "create");
  else if (v === "create") createRoom();
  else if (v === "join") joinRoom();
  else if (v === "waiting") waiting();
  else if (v === "mode") mode();
  else if (v === "intensity") intensity();
  else if (v === "game") gameScreen();
  else if (v === "result") result();
  else if (v === "report") report();
  else if (v === "history") historyScreen();
  else if (v === "privacy") privacy();
  else landing();
}

function bind() {
  app.querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", onAction);
  });
  const ageBox = app.querySelector("#age");
  if (ageBox) ageBox.addEventListener("change", () => { ui.ageOk = ageBox.checked; });
}

async function onAction(e) {
  const act = e.currentTarget.getAttribute("data-act");
  try {
    if (act === "home") { ui.joinToken = ""; go("landing"); }
    if (act === "home-reset") { stopPoll(); clearToken(); ui.state = null; ui.joinToken = ""; go("landing"); }
    if (act === "back") history.back();
    if (act === "start-create") go(ui.ageOk ? "create" : "age");
    if (act === "start-join") { ui.joinToken = ""; go(ui.ageOk ? "join" : "age"); }
    if (act === "confirm-age") {
      const box = document.getElementById("age");
      if (!box?.checked) { ui.error = "Please confirm to continue."; render(); return; }
      ui.ageOk = true;
      go(e.currentTarget.dataset.next || "create");
    }
    if (act === "create-room") await doCreate();
    if (act === "join-room") await doJoin();
    if (act === "copy-link") {
      const input = app.querySelector(".link-box input");
      await navigator.clipboard.writeText(input.value);
      toast("Link copied — share it only with them.");
    }
    if (act === "ready") {
      const me = ui.state.me;
      const data = await api(`/api/rooms/${ui.state.room.roomId}/ready`, { method: "POST", body: { ready: !me.ready } });
      applyState(data.state);
    }
    if (act === "pick-mode") {
      const id = e.currentTarget.dataset.id;
      const g = ui.state.game;
      if (g.proposedMode && g.modeProposedBy !== ui.state.me.slot) {
        ui._suggest = id;
        toast("Tap Suggest alternative to send this instead.");
        return;
      }
      const data = await api(`/api/games/${g.gameId}/mode`, { method: "POST", body: { modeId: id } });
      applyState(data.state);
    }
    if (act === "accept-mode") {
      const g = ui.state.game;
      const data = await api(`/api/games/${g.gameId}/mode`, { method: "POST", body: { modeId: g.proposedMode, action: "accept" } });
      applyState(data.state);
    }
    if (act === "suggest-mode") {
      const g = ui.state.game;
      const other = (ui.state.modes || []).find((m) => m.modeId !== g.proposedMode);
      const modeId = ui._suggest || other?.modeId;
      if (!modeId) return;
      const data = await api(`/api/games/${g.gameId}/mode`, { method: "POST", body: { modeId, action: "suggest" } });
      applyState(data.state);
    }
    if (act === "pick-intensity") {
      const data = await api(`/api/games/${ui.state.game.gameId}/preferences`, { method: "POST", body: { intensity: e.currentTarget.dataset.id } });
      applyState(data.state);
    }
    if (act === "pick-option") { ui.selectedOption = e.currentTarget.dataset.id; render(); }
    if (act === "submit-answer") {
      const data = await api(`/api/games/${ui.state.game.gameId}/answers`, {
        method: "POST",
        body: { selectedOptionId: ui.selectedOption, responseTimeMs: Date.now() - ui.questionStartedAt },
      });
      ui.selectedOption = null;
      ui.questionStartedAt = Date.now();
      applyState(data.state);
    }
    if (act === "advance") {
      ui.advancing = true;
      const data = await api(`/api/games/${ui.state.game.gameId}/advance`, { method: "POST", body: {} });
      ui.advancing = false;
      ui.selectedChallenge = null;
      applyState(data.state);
    }
    if (act === "pick-challenge") { ui.selectedChallenge = e.currentTarget.dataset.id; render(); }
    if (act === "select-challenge") {
      const data = await api(`/api/games/${ui.state.game.gameId}/challenge-selection`, { method: "POST", body: { challengeId: ui.selectedChallenge } });
      applyState(data.state);
    }
    if (act === "complete-challenge") {
      const text = document.getElementById("resp")?.value || "";
      const data = await api(`/api/games/${ui.state.game.gameId}/challenge-response`, { method: "POST", body: { responseText: text } });
      applyState(data.state);
    }
    if (act === "skip-challenge") {
      const data = await api(`/api/games/${ui.state.game.gameId}/challenge-skip`, { method: "POST", body: {} });
      applyState(data.state);
    }
    if (act === "replace-challenge") {
      const data = await api(`/api/games/${ui.state.game.gameId}/challenge-replace`, { method: "POST", body: {} });
      ui.selectedChallenge = null;
      applyState(data.state);
    }
    if (act === "pause") {
      const data = await api(`/api/games/${ui.state.game.gameId}/pause`, { method: "POST", body: {} });
      applyState(data.state);
    }
    if (act === "resume") {
      const data = await api(`/api/games/${ui.state.game.gameId}/resume`, { method: "POST", body: {} });
      applyState(data.state);
    }
    if (act === "end-game") {
      const data = await api(`/api/games/${ui.state.game.gameId}/pause`, { method: "POST", body: { action: "end" } });
      applyState(data.state);
    }
    if (act === "open-report") { ui.view = "report"; render(); }
    if (act === "privacy") { ui.view = "privacy"; render(); }
    if (act === "history") {
      try {
        const d = await api("/api/history");
        ui.history = d.history || [];
      } catch {
        ui.history = [];
      }
      ui.view = "history";
      window.history.pushState({ view: "history" }, "", "/history");
      render();
    }
    if (act === "delete-game") {
      await api(`/api/games/${e.currentTarget.dataset.id}`, { method: "DELETE" });
      ui.history = ui.history.filter((g) => g.gameId !== e.currentTarget.dataset.id);
      toast("Session deleted.");
      render();
    }
    if (act === "delete-current") {
      await api(`/api/games/${ui.state.game.gameId}`, { method: "DELETE" });
      toast("This session’s history and report were deleted.");
      go("landing");
    }
  } catch (err) {
    ui.loading = false;
    ui.advancing = false;
    ui.error = err.message;
    toast(err.message);
    render();
  }
}

async function doCreate() {
  const nick = document.getElementById("nick")?.value || "";
  const pin = document.getElementById("pin")?.value || "";
  ui.nickname = nick;
  localStorage.setItem("cg_nick", nick);
  ui.loading = true;
  render();
  const data = await api("/api/rooms", {
    method: "POST",
    body: { nickname: nick, ageConfirmed: true, pin: pin || undefined, deviceId: deviceId() },
  });
  ui.loading = false;
  applyState(data.state);
  ui.view = "waiting";
  startPoll();
  render();
}

async function doJoin() {
  const nick = document.getElementById("nick")?.value || ui.nickname;
  const pin = document.getElementById("pin")?.value || "";
  const link = document.getElementById("link")?.value || ui.joinToken;
  const token = (link || "").split("/r/").pop().trim();
  ui.nickname = nick;
  localStorage.setItem("cg_nick", nick);
  ui.loading = true;
  render();
  const data = await api(`/api/rooms/${encodeURIComponent(token)}/join`, {
    method: "POST",
    body: { nickname: nick, ageConfirmed: true, pin: pin || undefined, deviceId: deviceId() },
  });
  ui.loading = false;
  ui.joinToken = token;
  applyState(data.state);
  ui.view = "waiting";
  startPoll();
  render();
}

async function loadJoinPreview() {
  if (!ui.joinToken) return;
  try {
    ui.joinPreview = await api(`/api/rooms/${encodeURIComponent(ui.joinToken)}`);
  } catch {
    ui.joinPreview = { available: false, message: "This room is no longer available." };
  }
}

async function boot() {
  spawnHearts();
  setInterval(spawnHearts, 10000);
  routeFromPath();
  if (ui.joinToken) await loadJoinPreview();
  const restored = await restoreSession();
  if (!restored) render();
  else startPoll();
}

boot();
