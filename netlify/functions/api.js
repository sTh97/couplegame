const crypto = require("crypto");
const { collections, ensureIndexes } = require("./lib/db");
const {
  QUESTIONS,
  CHALLENGES,
  GAME_MODES,
  INTENSITY_LEVELS,
  SCORING_CONFIG,
  PROFANITY,
} = require("./lib/content");

const SESSION_SECRET = process.env.SESSION_SECRET || "couplegame-mvp-session-secret-change-me";
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DISCONNECT_GRACE_MS = 120 * 1000;
const HEARTBEAT_STALE_MS = 22 * 1000;
const QUESTIONS_PER_PLAYER = 10;
const CHALLENGE_REPLACE_CAP = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const rateBuckets = new Map();
let seeded = false;

const INTENSITY_RANK = { soft: 1, playful: 2, intimate: 3 };
const DIFFICULTY_PLAN = ["easy", "easy", "easy", "medium", "medium", "medium", "medium", "medium", "hard", "hard"];

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function error(statusCode, code, message, correlationId) {
  return json(statusCode, { code, message, correlationId });
}

function correlationId() {
  return crypto.randomUUID();
}

function now() {
  return new Date();
}

function randomToken() {
  return crypto.randomBytes(16).toString("base64url");
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return true;
  try {
    const [salt, hash] = stored.split(":");
    const check = crypto.scryptSync(String(pin), salt, 32).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(check, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearer(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const cookie = h.cookie || h.Cookie || "";
  const match = cookie.match(/(?:^|;\s*)cg_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function cookieHeader(token) {
  return `cg_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"] ||
    event.headers["client-ip"] ||
    "unknown"
  )
    .toString()
    .split(",")[0]
    .trim();
}

function rateLimit(key, max = 30) {
  const t = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter((x) => t - x < RATE_WINDOW_MS);
  if (fresh.length >= max) return false;
  fresh.push(t);
  rateBuckets.set(key, fresh);
  return true;
}

function sanitizeNickname(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 20) return { ok: false, message: "Nickname must be 1–20 characters." };
  const lower = name.toLowerCase();
  if (PROFANITY.some((w) => lower.includes(w))) return { ok: false, message: "Please choose a kinder nickname." };
  return { ok: true, name };
}

function parsePath(event) {
  let path = event.path || "/";
  if (event.rawUrl) {
    try {
      path = new URL(event.rawUrl).pathname;
    } catch {
      /* keep event.path */
    }
  }
  path = path.replace("/.netlify/functions/api", "");
  if (!path.startsWith("/api")) {
    if (!path.startsWith("/")) path = `/${path}`;
    path = `/api${path === "/" ? "" : path}`;
  }
  path = path.replace(/\/+$/, "") || "/api";
  return { method: (event.httpMethod || "GET").toUpperCase(), path };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function publicPlayer(p, hideIntensity = true) {
  if (!p) return null;
  return {
    slot: p.slot,
    nickname: p.nickname,
    ready: !!p.ready,
    connected: !!p.connected,
    ageConfirmed: !!p.ageConfirmedAt,
    intensitySubmitted: !!p.intensity,
    intensity: hideIntensity ? undefined : p.intensity,
  };
}

function minIntensity(a, b) {
  if (!a || !b) return null;
  return INTENSITY_RANK[a] <= INTENSITY_RANK[b] ? a : b;
}

function pickQuestions(excludeIds = []) {
  const used = new Set(excludeIds);
  const byDiff = { easy: [], medium: [], hard: [] };
  for (const q of QUESTIONS) {
    if (!used.has(q.questionId)) byDiff[q.difficulty].push(q);
  }
  const selected = [];
  for (const diff of DIFFICULTY_PLAN) {
    const pool = byDiff[diff].length ? byDiff[diff] : [...byDiff.easy, ...byDiff.medium, ...byDiff.hard];
    const available = pool.filter((q) => !used.has(q.questionId));
    if (!available.length) continue;
    const choice = available[Math.floor(Math.random() * available.length)];
    used.add(choice.questionId);
    selected.push(choice);
  }
  while (selected.length < QUESTIONS_PER_PLAYER) {
    const leftover = QUESTIONS.filter((q) => !used.has(q.questionId));
    if (!leftover.length) break;
    const choice = leftover[Math.floor(Math.random() * leftover.length)];
    used.add(choice.questionId);
    selected.push(choice);
  }
  return selected.slice(0, QUESTIONS_PER_PLAYER);
}

function snapshotQuestion(q, sequence) {
  return {
    sequence,
    questionId: q.questionId,
    category: q.category,
    difficulty: q.difficulty,
    prompt: q.prompt,
    options: q.options,
    correctOptionId: q.correctOptionId,
    selectedOptionId: null,
    isCorrect: null,
    responseTimeMs: null,
    answeredAt: null,
  };
}

function clientQuestion(snap) {
  if (!snap) return null;
  return {
    sequence: snap.sequence,
    questionId: snap.questionId,
    category: snap.category,
    difficulty: snap.difficulty,
    prompt: snap.prompt,
    options: snap.options,
  };
}

function pickChallenges(mode, intensity, excludeIds = [], count = 4) {
  const rank = INTENSITY_RANK[intensity] || 1;
  let pool = CHALLENGES.filter(
    (c) => c.gameMode === mode && c.activeStatus && INTENSITY_RANK[c.intensityLevel] <= rank && !excludeIds.includes(c.challengeId)
  );
  if (pool.length < count) {
    pool = CHALLENGES.filter((c) => c.gameMode === mode && c.activeStatus && !excludeIds.includes(c.challengeId));
  }
  if (pool.length < count) {
    pool = CHALLENGES.filter((c) => c.activeStatus && INTENSITY_RANK[c.intensityLevel] <= rank);
  }
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function publicChallenge(c) {
  return {
    challengeId: c.challengeId,
    challengeType: c.challengeType,
    title: c.title,
    teaser: c.instruction.slice(0, 72) + (c.instruction.length > 72 ? "…" : ""),
    instruction: c.instruction,
    intensityLevel: c.intensityLevel,
    estimatedDurationSec: c.estimatedDurationSec,
    requiresResponse: c.requiresResponse,
    requiresPhysicalAction: c.requiresPhysicalAction,
    skipAllowed: c.skipAllowed,
    replacementAllowed: c.replacementAllowed,
  };
}

async function seedIfNeeded() {
  if (seeded) return;
  const { questions, challenges } = await collections();
  const qCount = await questions.countDocuments();
  if (qCount === 0) {
    await questions.insertMany(QUESTIONS.map((q) => ({ ...q, createdAt: now(), updatedAt: now() })));
  }
  const cCount = await challenges.countDocuments();
  if (cCount === 0) {
    await challenges.insertMany(CHALLENGES.map((c) => ({ ...c, createdAt: now(), updatedAt: now() })));
  }
  await ensureIndexes();
  seeded = true;
}

async function logEvent(roomId, gameId, type, data = {}) {
  const { events } = await collections();
  const safe = { ...data };
  delete safe.responseText;
  delete safe.pin;
  delete safe.instruction;
  await events.insertOne({
    eventId: crypto.randomUUID(),
    roomId,
    gameId: gameId || null,
    type,
    data: safe,
    createdAt: now(),
  });
}

async function audit(action, ok, extra = {}) {
  const { audit } = await collections();
  await audit.insertOne({
    action,
    ok,
    ...extra,
    createdAt: now(),
  });
}

function winnerOf(scores) {
  if (scores.A > scores.B) return "A";
  if (scores.B > scores.A) return "B";
  return "Draw";
}

function buildReport(room, game) {
  const durationMs = (game.completedAt || now()) - (game.startedAt || game.createdAt);
  const statsFor = (slot) => {
    const qs = game.questions[slot] || [];
    const correct = qs.filter((x) => x.isCorrect === true).length;
    const incorrect = qs.filter((x) => x.isCorrect === false).length;
    const times = qs.filter((x) => x.responseTimeMs != null).map((x) => x.responseTimeMs);
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const byCat = {};
    for (const q of qs) {
      if (!byCat[q.category]) byCat[q.category] = { correct: 0, total: 0 };
      byCat[q.category].total += 1;
      if (q.isCorrect) byCat[q.category].correct += 1;
    }
    return { correct, incorrect, accuracy: qs.length ? Math.round((correct / qs.length) * 100) : 0, avgResponseTimeMs: avg, categoryStats: byCat };
  };
  const a = statsFor("A");
  const b = statsFor("B");
  const allChallenges = game.challengeHistory || [];
  const catEntries = (stats) => Object.entries(stats.categoryStats);
  const bestCat = (stats) => {
    const entries = catEntries(stats).sort((x, y) => y[1].correct / y[1].total - x[1].correct / x[1].total);
    return entries[0] ? entries[0][0] : "General Knowledge";
  };
  const hardCat = (stats) => {
    const entries = catEntries(stats).sort((x, y) => x[1].correct / x[1].total - y[1].correct / y[1].total);
    return entries[0] ? entries[0][0] : "Puzzles";
  };
  const fastest = a.avgResponseTimeMs <= b.avgResponseTimeMs ? "A" : "B";
  const knowledgeChamp = a.correct === b.correct ? "Both" : a.correct > b.correct ? "A" : "B";
  const winner = winnerOf(game.scores);
  const modeName = GAME_MODES.find((m) => m.modeId === game.mode)?.name || game.mode;
  const story = `Tonight, ${room.players.A.nickname} and ${room.players.B.nickname} chose ${modeName} at a ${game.effectiveIntensity} pace. Ten questions each, no rush, no penalties for skipping closeness. ${
    winner === "Draw"
      ? "The scores landed in a perfect match — knowledge, it turns out, can be a love language too."
      : `${room.players[winner].nickname} edged the trivia, but the night belonged to both of you.`
  }`;

  return {
    gameSummary: {
      gameId: game.gameId,
      roomId: room.roomId,
      date: game.startedAt || game.createdAt,
      startedAt: game.startedAt,
      completedAt: game.completedAt,
      durationMs,
      mode: game.mode,
      effectiveIntensity: game.effectiveIntensity,
      status: game.status,
    },
    players: {
      A: { nickname: room.players.A.nickname, slot: "A" },
      B: { nickname: room.players.B.nickname, slot: "B" },
    },
    scores: game.scores,
    knowledgeStats: { A: a, B: b },
    categoryStats: { A: a.categoryStats, B: b.categoryStats },
    challengeStats: {
      triggered: allChallenges.length,
      completed: allChallenges.filter((c) => c.outcome === "Completed").length,
      skipped: allChallenges.filter((c) => c.outcome === "Skipped").length,
      replaced: allChallenges.filter((c) => c.replaced).length,
    },
    roleplaySummary: game.mode === "ROLEPLAY" ? game.roleplayContext : null,
    winner,
    timeline: game.timeline || [],
    narrative: { title: "Tonight's Game Story", body: story },
    superlatives: {
      knowledgeChampion: knowledgeChamp,
      fastestThinker: fastest,
      bestCategory: bestCat(a.correct >= b.correct ? a : b),
      mostDifficultCategory: hardCat(a.accuracy <= b.accuracy ? a : b),
      closestRound: "Every round counted",
    },
  };
}

function maybeExpire(room) {
  if (room.status === "EXPIRED" || room.status === "COMPLETED" || room.status === "ABANDONED") return room;
  if (new Date(room.expiresAt).getTime() < Date.now() && room.status === "WAITING_FOR_PARTNER") {
    room.status = "EXPIRED";
  }
  return room;
}

function markConnection(room) {
  const t = Date.now();
  for (const slot of ["A", "B"]) {
    const p = room.players[slot];
    if (!p) continue;
    if (p.lastHeartbeat && t - new Date(p.lastHeartbeat).getTime() > HEARTBEAT_STALE_MS) {
      p.connected = false;
    }
  }
}

async function saveRoom(room) {
  const { rooms } = await collections();
  room.updatedAt = now();
  await rooms.updateOne({ roomId: room.roomId }, { $set: room });
}

async function saveGame(game) {
  const { games } = await collections();
  game.updatedAt = now();
  await games.updateOne({ gameId: game.gameId }, { $set: game });
}

async function getRoomByToken(token) {
  const { rooms } = await collections();
  const room = await rooms.findOne({ secureToken: token });
  return room ? maybeExpire(room) : null;
}

async function getRoomById(roomId) {
  const { rooms } = await collections();
  const room = await rooms.findOne({ roomId });
  return room ? maybeExpire(room) : null;
}

async function getGameByRoom(roomId) {
  const { games } = await collections();
  return games.findOne(
    { roomId, $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
    { sort: { createdAt: -1 } }
  );
}

async function getGame(gameId) {
  const { games } = await collections();
  return games.findOne({ gameId });
}

function requireSession(event, cid) {
  const token = getBearer(event);
  const session = verifySession(token);
  if (!session) return { error: error(401, "UNAUTHENTICATED", "Please rejoin this private room.", cid) };
  return { session, token };
}

function assertRoomAccess(session, room, cid) {
  if (!room) return error(404, "NOT_FOUND", "This room is no longer available.", cid);
  if (session.roomId !== room.roomId) {
    return error(403, "FORBIDDEN", "You cannot access this private room.", cid);
  }
  const player = room.players[session.slot];
  if (!player || player.sessionId !== session.sid) {
    return error(403, "FORBIDDEN", "You cannot access this private room.", cid);
  }
  return null;
}

function nextRoundAfterChallenges(game) {
  const pending = (game.challengeQueue || []).filter((x) => x.status === "pending");
  if (pending.length) {
    game.status = "CHALLENGE_ACTIVE";
    const next = pending[0];
    game.activeChallenge = {
      playerSlot: next.slot,
      round: next.round,
      options: next.options,
      selectedId: null,
      outcome: "pending",
      replacementsUsed: 0,
      responseText: null,
    };
    return;
  }
  if (game.currentRound >= QUESTIONS_PER_PLAYER) {
    game.status = "COMPLETED";
    game.completedAt = now();
    return;
  }
  game.currentRound += 1;
  game.status = "ROUND_ACTIVE";
  game.activeChallenge = null;
  game.roundRevealed = false;
}

function clientState(room, game, slot) {
  markConnection(room);
  const me = room.players[slot];
  const partnerSlot = slot === "A" ? "B" : "A";
  const partner = room.players[partnerSlot];
  const base = {
    serverTime: Date.now(),
    room: {
      roomId: room.roomId,
      secureToken: room.secureToken,
      status: room.status,
      hasPin: !!room.pinHash,
      expiresAt: room.expiresAt,
      createdAt: room.createdAt,
      players: {
        A: publicPlayer(room.players.A),
        B: publicPlayer(room.players.B),
      },
      mySlot: slot,
      partnerConnected: !!(partner && partner.connected),
      bothReady: !!(room.players.A?.ready && room.players.B?.ready),
    },
    modes: GAME_MODES,
    intensities: INTENSITY_LEVELS,
    me: { slot, nickname: me?.nickname, ready: !!me?.ready, intensitySubmitted: !!me?.intensity },
    game: null,
  };

  if (!game) return base;

  const myQ = (game.questions?.[slot] || []).find((q) => q.sequence === game.currentRound);
  const partnerQ = (game.questions?.[partnerSlot] || []).find((q) => q.sequence === game.currentRound);
  const bothAnswered = !!(myQ && partnerQ && myQ.answeredAt && partnerQ.answeredAt);
  const reveal = bothAnswered && (game.roundRevealed || game.status !== "ROUND_ACTIVE");

  let challengeView = null;
  if (game.activeChallenge) {
    const mine = game.activeChallenge.playerSlot === slot;
    if (mine) {
      challengeView = {
        mine: true,
        ...game.activeChallenge,
        options: (game.activeChallenge.options || []).map(publicChallenge),
        selected: game.activeChallenge.selectedId
          ? publicChallenge(game.activeChallenge.options.find((o) => o.challengeId === game.activeChallenge.selectedId) || {})
          : null,
      };
    } else if (game.activeChallenge.selectedId) {
      const sel = game.activeChallenge.options.find((o) => o.challengeId === game.activeChallenge.selectedId);
      challengeView = {
        mine: false,
        playerSlot: game.activeChallenge.playerSlot,
        selected: sel ? publicChallenge(sel) : null,
        waitingOnPartner: game.activeChallenge.outcome === "pending",
      };
    } else {
      challengeView = {
        mine: false,
        playerSlot: game.activeChallenge.playerSlot,
        waitingOnPartner: true,
        selected: null,
      };
    }
  }

  base.game = {
    gameId: game.gameId,
    status: game.status,
    mode: game.mode,
    proposedMode: game.proposedMode,
    modeProposedBy: game.modeProposedBy,
    modeConfirmed: !!game.modeConfirmed,
    effectiveIntensity: game.effectiveIntensity,
    currentRound: game.currentRound,
    totalRounds: QUESTIONS_PER_PLAYER,
    scores: game.scores,
    pausedBy: game.pausedBy,
    resumeAck: game.resumeAck,
    myQuestion: game.status === "ROUND_ACTIVE" || game.status === "WAITING_FOR_BOTH_ANSWERS" ? clientQuestion(myQ) : reveal ? clientQuestion(myQ) : clientQuestion(myQ),
    myAnswered: !!(myQ && myQ.answeredAt),
    partnerAnswered: !!(partnerQ && partnerQ.answeredAt),
    mySelectedOptionId: myQ?.selectedOptionId || null,
    roundResult: reveal
      ? {
          myCorrect: myQ?.isCorrect,
          partnerCorrect: partnerQ?.isCorrect,
          myScoreDelta: myQ?.isCorrect ? SCORING_CONFIG.correctPoints : 0,
          partnerScoreDelta: partnerQ?.isCorrect ? SCORING_CONFIG.correctPoints : 0,
        }
      : null,
    challenge: challengeView,
    winner: game.winner || null,
    reportReady: !!game.reportGenerated,
    disconnectedPartner: !!(partner && !partner.connected) && ["IN_PROGRESS", "ROUND_ACTIVE", "WAITING_FOR_BOTH_ANSWERS", "CHALLENGE_ACTIVE", "PAUSED"].includes(game.status),
  };

  if (game.status === "COMPLETED" && game.report) {
    base.game.report = game.report;
    base.game.winner = game.winner;
  }
  return base;
}

async function handleCreateRoom(event, cid) {
  if (!rateLimit(`create:${clientIp(event)}`, 20)) {
    return error(429, "RATE_LIMIT", "Please wait a moment and try again.", cid);
  }
  const body = parseBody(event);
  if (!body.ageConfirmed) return error(400, "AGE_REQUIRED", "Please confirm you are 18 or older.", cid);
  const nick = sanitizeNickname(body.nickname);
  if (!nick.ok) return error(400, "INVALID_NICKNAME", nick.message, cid);
  if (body.pin && !/^\d{4,6}$/.test(String(body.pin))) {
    return error(400, "INVALID_PIN", "PIN must be 4–6 digits.", cid);
  }

  const roomId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const secureToken = randomToken();
  const createdAt = now();
  const origin = (event.headers.origin || event.headers.Origin || "").replace(/\/$/, "") || "";
  const inviteUrl = `${origin}/r/${secureToken}`;

  const playerA = {
    slot: "A",
    nickname: nick.name,
    sessionId,
    ageConfirmedAt: createdAt,
    ready: false,
    connected: true,
    lastHeartbeat: createdAt,
    intensity: null,
    deviceId: body.deviceId || null,
  };

  const room = {
    roomId,
    secureToken,
    pinHash: body.pin ? hashPin(body.pin) : null,
    status: "WAITING_FOR_PARTNER",
    players: { A: playerA, B: null },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + ROOM_TTL_MS),
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
  };

  const { rooms } = await collections();
  await rooms.insertOne(room);

  const sessionToken = signSession({
    roomId,
    slot: "A",
    sid: sessionId,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  });

  await logEvent(roomId, null, "ROOM_CREATED", { slot: "A" });
  return json(
    201,
    {
      roomId,
      secureToken,
      inviteUrl,
      sessionToken,
      slot: "A",
      state: clientState(room, null, "A"),
    },
    { "Set-Cookie": cookieHeader(sessionToken) }
  );
}

async function handleJoinRoom(event, token, cid) {
  if (!rateLimit(`join:${clientIp(event)}:${token}`, 40)) {
    return error(429, "RATE_LIMIT", "Please wait a moment and try again.", cid);
  }
  const body = parseBody(event);
  if (!body.ageConfirmed) return error(400, "AGE_REQUIRED", "Please confirm you are 18 or older.", cid);
  const nick = sanitizeNickname(body.nickname);
  if (!nick.ok) return error(400, "INVALID_NICKNAME", nick.message, cid);

  const room = await getRoomByToken(token);
  if (!room || room.status === "EXPIRED") {
    await audit("join", false, { reason: "expired_or_missing", cid });
    return error(404, "NOT_FOUND", "This room is no longer available.", cid);
  }
  if (room.players.B) {
    return error(409, "ROOM_FULL", "This private room already has two players.", cid);
  }
  if (room.pinHash) {
    if (!body.pin || !verifyPin(body.pin, room.pinHash)) {
      await audit("pin_failure", false, { roomId: room.roomId, cid });
      return error(401, "WRONG_PIN", "That code didn’t work. Please try again.", cid);
    }
  }

  const sessionId = crypto.randomUUID();
  const t = now();
  room.players.B = {
    slot: "B",
    nickname: nick.name,
    sessionId,
    ageConfirmedAt: t,
    ready: false,
    connected: true,
    lastHeartbeat: t,
    intensity: null,
    deviceId: body.deviceId || null,
  };
  room.status = "PARTNER_JOINED";
  await saveRoom(room);
  await logEvent(room.roomId, null, "PLAYER_JOINED", { slot: "B" });

  const sessionToken = signSession({
    roomId: room.roomId,
    slot: "B",
    sid: sessionId,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  });

  return json(
    200,
    {
      roomId: room.roomId,
      sessionToken,
      slot: "B",
      partnerNickname: room.players.A.nickname,
      state: clientState(room, null, "B"),
    },
    { "Set-Cookie": cookieHeader(sessionToken) }
  );
}

async function handlePublicRoom(token, cid) {
  const room = await getRoomByToken(token);
  if (!room || room.status === "EXPIRED") {
    return json(200, { available: false, reason: "unavailable", message: "This room is no longer available." });
  }
  if (room.players.B) {
    return json(200, {
      available: false,
      reason: "full",
      message: "This private room already has two players.",
    });
  }
  return json(200, {
    available: true,
    hasPin: !!room.pinHash,
    creatorNickname: room.players.A?.nickname || "Partner",
    status: room.status,
  });
}

async function handleReady(event, roomId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const room = await getRoomById(roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const body = parseBody(event);
  const slot = auth.session.slot;
  room.players[slot].ready = body.ready !== false;
  room.players[slot].lastHeartbeat = now();
  room.players[slot].connected = true;
  if (room.players.A?.ready && room.players.B?.ready) {
    room.status = "MODE_SELECTION";
    if (!(await getGameByRoom(room.roomId))) {
      const gameId = crypto.randomUUID();
      const game = {
        gameId,
        roomId: room.roomId,
        status: "MODE_SELECTION",
        mode: null,
        proposedMode: null,
        modeProposedBy: null,
        modeConfirmed: false,
        intensityA: null,
        intensityB: null,
        effectiveIntensity: null,
        currentRound: 1,
        scores: { A: 0, B: 0 },
        questions: { A: [], B: [] },
        challengeQueue: [],
        challengeHistory: [],
        shownChallengeIds: [],
        activeChallenge: null,
        roundRevealed: false,
        pausedBy: null,
        resumeAck: { A: false, B: false },
        roleplayContext: {
          sessionId: gameId,
          scenario: null,
          characterA: null,
          characterB: null,
          priorDecisions: [],
          completedPrompts: [],
          currentStoryState: null,
        },
        timeline: [],
        createdAt: now(),
        startedAt: null,
        completedAt: null,
        winner: null,
        report: null,
        reportGenerated: false,
        players: {
          A: { sessionId: room.players.A.sessionId, nickname: room.players.A.nickname },
          B: { sessionId: room.players.B.sessionId, nickname: room.players.B.nickname },
        },
      };
      const { games } = await collections();
      await games.insertOne(game);
    }
  } else if (room.players.B) {
    room.status = "WAITING_FOR_READY";
  }
  await saveRoom(room);
  await logEvent(room.roomId, null, "PLAYER_READY", { slot, ready: room.players[slot].ready });
  const game = await getGameByRoom(room.roomId);
  return json(200, { state: clientState(room, game, slot) });
}

async function handleMode(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const body = parseBody(event);
  const modeId = body.modeId;
  if (!GAME_MODES.some((m) => m.modeId === modeId)) {
    return error(400, "INVALID_MODE", "Please choose a valid mode.", cid);
  }
  const slot = auth.session.slot;
  if (!game.proposedMode) {
    game.proposedMode = modeId;
    game.modeProposedBy = slot;
    await logEvent(room.roomId, game.gameId, "MODE_SELECTED", { modeId, slot });
  } else if (body.action === "suggest") {
    game.proposedMode = modeId;
    game.modeProposedBy = slot;
    game.modeConfirmed = false;
    await logEvent(room.roomId, game.gameId, "MODE_SELECTED", { modeId, slot, suggest: true });
  } else if (body.action === "accept" || modeId === game.proposedMode) {
    if (slot === game.modeProposedBy && body.action !== "accept") {
      /* proposer waiting */
    } else {
      game.mode = game.proposedMode;
      game.modeConfirmed = true;
      game.status = "BOUNDARY_SELECTION";
      room.status = "BOUNDARY_SELECTION";
      await logEvent(room.roomId, game.gameId, "MODE_CONFIRMED", { modeId: game.mode });
    }
  }
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, slot) });
}

async function handlePreferences(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const body = parseBody(event);
  const intensity = String(body.intensity || "").toLowerCase();
  if (!INTENSITY_RANK[intensity]) return error(400, "INVALID_INTENSITY", "Choose Soft, Playful, or Intimate.", cid);
  const slot = auth.session.slot;
  if (slot === "A") game.intensityA = intensity;
  else game.intensityB = intensity;
  room.players[slot].intensity = intensity;

  if (game.intensityA && game.intensityB) {
    game.effectiveIntensity = minIntensity(game.intensityA, game.intensityB);
    const qsA = pickQuestions();
    const qsB = pickQuestions(qsA.map((q) => q.questionId));
    game.questions = {
      A: qsA.map((q, i) => snapshotQuestion(q, i + 1)),
      B: qsB.map((q, i) => snapshotQuestion(q, i + 1)),
    };
    game.status = "ROUND_ACTIVE";
    game.currentRound = 1;
    game.startedAt = now();
    room.status = "IN_PROGRESS";
    room.startedAt = game.startedAt;
    if (game.mode === "ROLEPLAY") {
      game.roleplayContext.scenario = "A shared evening of scenes";
      game.roleplayContext.currentStoryState = "opening";
    }
    await logEvent(room.roomId, game.gameId, "GAME_STARTED", { effectiveIntensity: game.effectiveIntensity });
  }
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, slot) });
}

async function handleAnswer(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (game.status === "PAUSED") return error(409, "PAUSED", "The game is paused.", cid);
  if (!["IN_PROGRESS", "ROUND_ACTIVE", "WAITING_FOR_BOTH_ANSWERS"].includes(game.status)) {
    return error(409, "BAD_STATE", "This round is not accepting answers.", cid);
  }
  const slot = auth.session.slot;
  const body = parseBody(event);
  const q = (game.questions[slot] || []).find((x) => x.sequence === game.currentRound);
  if (!q) return error(400, "NO_QUESTION", "No question for this round.", cid);
  if (q.answeredAt) return error(409, "ALREADY_ANSWERED", "This answer was already recorded.", cid);
  const option = q.options.find((o) => o.optionId === body.selectedOptionId);
  if (!option) return error(400, "INVALID_OPTION", "Please choose one of the four options.", cid);

  q.selectedOptionId = body.selectedOptionId;
  q.isCorrect = body.selectedOptionId === q.correctOptionId;
  q.responseTimeMs = Math.max(0, Number(body.responseTimeMs) || 0);
  q.answeredAt = now();
  if (q.isCorrect) game.scores[slot] += SCORING_CONFIG.correctPoints;
  game.timeline.push({ at: now(), type: "ANSWER", slot, sequence: q.sequence, correct: q.isCorrect });
  await logEvent(room.roomId, game.gameId, "QUESTION_ANSWERED", { slot, sequence: q.sequence });

  const other = slot === "A" ? "B" : "A";
  const otherQ = game.questions[other].find((x) => x.sequence === game.currentRound);
  if (otherQ?.answeredAt) {
    game.status = "ROUND_RESULT";
    game.roundRevealed = true;
    game.challengeQueue = [];
    for (const s of ["A", "B"]) {
      const qq = game.questions[s].find((x) => x.sequence === game.currentRound);
      if (qq && qq.isCorrect === false) {
        const options = pickChallenges(game.mode, game.effectiveIntensity, game.shownChallengeIds, 4);
        game.shownChallengeIds.push(...options.map((c) => c.challengeId));
        game.challengeQueue.push({ slot: s, round: game.currentRound, options, status: "pending" });
      }
    }
    await logEvent(room.roomId, game.gameId, "ROUND_COMPLETED", { round: game.currentRound });
  } else {
    game.status = "WAITING_FOR_BOTH_ANSWERS";
  }
  await saveGame(game);
  return json(200, { state: clientState(room, game, slot) });
}

async function handleAdvance(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (game.status !== "ROUND_RESULT") {
    return json(200, { state: clientState(room, game, auth.session.slot) });
  }
  nextRoundAfterChallenges(game);
  if (game.status === "COMPLETED") {
    game.winner = winnerOf(game.scores);
    if (!game.reportGenerated) {
      game.report = buildReport(room, game);
      game.reportGenerated = true;
      room.status = "COMPLETED";
      room.completedAt = game.completedAt;
      const { reports } = await collections();
      await reports.updateOne(
        { gameId: game.gameId },
        { $set: { gameId: game.gameId, roomId: room.roomId, payload: game.report, createdAt: now(), deletedAt: null } },
        { upsert: true }
      );
      await logEvent(room.roomId, game.gameId, "GAME_COMPLETED", { winner: game.winner });
    }
  } else if (game.status === "CHALLENGE_ACTIVE") {
    await logEvent(room.roomId, game.gameId, "CHALLENGE_GENERATED", { slot: game.activeChallenge.playerSlot });
  }
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handleChallengeSelect(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (!game.activeChallenge || game.activeChallenge.playerSlot !== auth.session.slot) {
    return error(409, "NOT_YOUR_CHALLENGE", "This challenge belongs to your partner.", cid);
  }
  const body = parseBody(event);
  const found = game.activeChallenge.options.find((o) => o.challengeId === body.challengeId);
  if (!found) return error(400, "INVALID_CHALLENGE", "Please choose one of the four challenges.", cid);
  game.activeChallenge.selectedId = found.challengeId;
  if (game.mode === "ROLEPLAY") {
    game.roleplayContext.completedPrompts.push(found.title);
    game.roleplayContext.currentStoryState = found.title;
  }
  await logEvent(room.roomId, game.gameId, "CHALLENGE_SELECTED", { challengeId: found.challengeId, slot: auth.session.slot });
  await saveGame(game);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

function finishChallenge(game, room, outcome, responseText) {
  const ch = game.activeChallenge;
  const selected = ch.options.find((o) => o.challengeId === ch.selectedId) || ch.options[0];
  game.challengeHistory.push({
    slot: ch.playerSlot,
    round: ch.round,
    challengeId: selected?.challengeId,
    title: selected?.title,
    outcome,
    replaced: ch.replacementsUsed > 0,
    at: now(),
  });
  const qItem = game.challengeQueue.find((x) => x.slot === ch.playerSlot && x.round === ch.round && x.status === "pending");
  if (qItem) qItem.status = "done";
  game.timeline.push({ at: now(), type: "CHALLENGE", slot: ch.playerSlot, outcome, challengeId: selected?.challengeId });
  void responseText;
  void room;
  nextRoundAfterChallenges(game);
}

async function handleChallengeResponse(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (!game.activeChallenge || game.activeChallenge.playerSlot !== auth.session.slot) {
    return error(409, "NOT_YOUR_CHALLENGE", "This challenge belongs to your partner.", cid);
  }
  if (!game.activeChallenge.selectedId) return error(400, "NO_SELECTION", "Please choose a challenge first.", cid);
  const body = parseBody(event);
  finishChallenge(game, room, "Completed", body.responseText || null);
  if (game.status === "COMPLETED") {
    game.winner = winnerOf(game.scores);
    game.report = buildReport(room, game);
    game.reportGenerated = true;
    room.status = "COMPLETED";
    room.completedAt = game.completedAt;
    const { reports } = await collections();
    await reports.updateOne(
      { gameId: game.gameId },
      { $set: { gameId: game.gameId, roomId: room.roomId, payload: game.report, createdAt: now(), deletedAt: null } },
      { upsert: true }
    );
  }
  await logEvent(room.roomId, game.gameId, "CHALLENGE_COMPLETED", { slot: auth.session.slot });
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handleChallengeSkip(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (!game.activeChallenge || game.activeChallenge.playerSlot !== auth.session.slot) {
    return error(409, "NOT_YOUR_CHALLENGE", "This challenge belongs to your partner.", cid);
  }
  if (!game.activeChallenge.selectedId && game.activeChallenge.options[0]) {
    game.activeChallenge.selectedId = game.activeChallenge.options[0].challengeId;
  }
  finishChallenge(game, room, "Skipped", null);
  if (game.status === "COMPLETED") {
    game.winner = winnerOf(game.scores);
    game.report = buildReport(room, game);
    game.reportGenerated = true;
    room.status = "COMPLETED";
    room.completedAt = game.completedAt;
  }
  await logEvent(room.roomId, game.gameId, "CHALLENGE_SKIPPED", { slot: auth.session.slot });
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handleChallengeReplace(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (!game.activeChallenge || game.activeChallenge.playerSlot !== auth.session.slot) {
    return error(409, "NOT_YOUR_CHALLENGE", "This challenge belongs to your partner.", cid);
  }
  if (game.activeChallenge.replacementsUsed >= CHALLENGE_REPLACE_CAP) {
    return error(400, "REPLACE_CAP", "That’s as many replacements as this round allows. Skip or pick one.", cid);
  }
  game.activeChallenge.replacementsUsed += 1;
  const options = pickChallenges(game.mode, game.effectiveIntensity, game.shownChallengeIds, 4);
  game.shownChallengeIds.push(...options.map((c) => c.challengeId));
  game.activeChallenge.options = options;
  game.activeChallenge.selectedId = null;
  await saveGame(game);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handlePause(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const body = parseBody(event);
  if (body.action === "end") {
    game.status = "ABANDONED";
    room.status = "ABANDONED";
    await saveGame(game);
    await saveRoom(room);
    return json(200, { state: clientState(room, game, auth.session.slot) });
  }
  if (game.status !== "PAUSED") {
    game.prePauseStatus = game.status;
    game.status = "PAUSED";
    game.pausedBy = auth.session.slot;
    game.resumeAck = { A: false, B: false };
    room.status = "PAUSED";
    await logEvent(room.roomId, game.gameId, "GAME_PAUSED", { slot: auth.session.slot });
  }
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handleResume(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (game.status !== "PAUSED") return json(200, { state: clientState(room, game, auth.session.slot) });
  game.resumeAck[auth.session.slot] = true;
  if (game.resumeAck.A && game.resumeAck.B) {
    game.status = game.prePauseStatus || "ROUND_ACTIVE";
    game.pausedBy = null;
    room.status = "IN_PROGRESS";
    await logEvent(room.roomId, game.gameId, "GAME_RESUMED", {});
  }
  await saveGame(game);
  await saveRoom(room);
  return json(200, { state: clientState(room, game, auth.session.slot) });
}

async function handleState(event, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const room = await getRoomById(auth.session.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const slot = auth.session.slot;
  room.players[slot].connected = true;
  room.players[slot].lastHeartbeat = now();
  const partner = room.players[slot === "A" ? "B" : "A"];
  if (partner && partner.lastHeartbeat && Date.now() - new Date(partner.lastHeartbeat).getTime() > HEARTBEAT_STALE_MS) {
    partner.connected = false;
  }
  if (
    partner &&
    !partner.connected &&
    partner.lastHeartbeat &&
    Date.now() - new Date(partner.lastHeartbeat).getTime() > DISCONNECT_GRACE_MS &&
    room.status === "IN_PROGRESS"
  ) {
    /* hold in place; partner can still reconnect */
  }
  await saveRoom(room);
  const game = await getGameByRoom(room.roomId);
  return json(200, { state: clientState(room, game, slot) });
}

async function handleHistory(event, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const { games } = await collections();
  const sid = auth.session.sid;
  const list = await games
    .find({
      $or: [{ "players.A.sessionId": sid }, { "players.B.sessionId": sid }],
      $and: [{ $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] }],
    })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  return json(200, {
    history: list.map((g) => ({
      gameId: g.gameId,
      roomId: g.roomId,
      mode: g.mode,
      status: g.status,
      scores: g.scores,
      winner: g.winner,
      createdAt: g.createdAt,
      completedAt: g.completedAt,
      effectiveIntensity: g.effectiveIntensity,
    })),
  });
}

async function handleDeleteGame(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  const t = now();
  game.deletedAt = t;
  if (game.report) game.report = { deleted: true };
  game.challengeHistory = (game.challengeHistory || []).map((c) => ({ ...c, title: undefined }));
  await saveGame(game);
  const { reports } = await collections();
  await reports.updateOne({ gameId }, { $set: { deletedAt: t, payload: null } });
  return json(200, { ok: true });
}

async function handleReport(event, gameId, cid) {
  const auth = requireSession(event, cid);
  if (auth.error) return auth.error;
  const game = await getGame(gameId);
  if (!game) return error(404, "NOT_FOUND", "Game not found.", cid);
  const room = await getRoomById(game.roomId);
  const denied = assertRoomAccess(auth.session, room, cid);
  if (denied) return denied;
  if (game.status !== "COMPLETED") return error(409, "NOT_COMPLETE", "The report appears after the game ends.", cid);
  if (!game.reportGenerated) {
    game.report = buildReport(room, game);
    game.reportGenerated = true;
    await saveGame(game);
  }
  return json(200, { report: game.report, winner: game.winner, scores: game.scores });
}

exports.handler = async (event) => {
  const cid = correlationId();
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": event.headers.origin || "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      },
      body: "",
    };
  }

  try {
    await seedIfNeeded();
    const { method, path } = parsePath(event);
    const parts = path.split("/").filter(Boolean);

    if (method === "GET" && path === "/api/health") {
      return json(200, { ok: true, service: "couplegame" });
    }
    if (method === "POST" && path === "/api/rooms") return handleCreateRoom(event, cid);
    if (method === "GET" && parts[0] === "api" && parts[1] === "rooms" && parts[2] && parts[3] === undefined) {
      return handlePublicRoom(parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "join") {
      return handleJoinRoom(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "ready") {
      return handleReady(event, parts[2], cid);
    }
    if (method === "GET" && path === "/api/state") return handleState(event, cid);
    if (method === "POST" && path === "/api/heartbeat") return handleState(event, cid);
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "mode") {
      return handleMode(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "preferences") {
      return handlePreferences(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "answers") {
      return handleAnswer(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "advance") {
      return handleAdvance(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "challenge-selection") {
      return handleChallengeSelect(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "challenge-response") {
      return handleChallengeResponse(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "challenge-skip") {
      return handleChallengeSkip(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "challenge-replace") {
      return handleChallengeReplace(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "pause") {
      return handlePause(event, parts[2], cid);
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "resume") {
      return handleResume(event, parts[2], cid);
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "games" && parts[3] === "report") {
      return handleReport(event, parts[2], cid);
    }
    if (method === "GET" && path === "/api/history") return handleHistory(event, cid);
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "games" && parts[2]) {
      return handleDeleteGame(event, parts[2], cid);
    }

    return error(404, "NOT_FOUND", "Unknown endpoint.", cid);
  } catch (err) {
    console.error("api_error", cid, err && err.message);
    return error(500, "SERVER_ERROR", "Something went wrong. Please try again.", cid);
  }
};
