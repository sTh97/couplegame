const { handler } = require("../netlify/functions/api");

async function call(method, path, body, token) {
  const event = {
    path,
    rawUrl: `http://localhost:3000${path}`,
    httpMethod: method,
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  };
  const res = await handler(event);
  const data = JSON.parse(res.body || "{}");
  if (res.statusCode >= 400) {
    const err = new Error(`${method} ${path} -> ${res.statusCode} ${data.message || res.body}`);
    err.data = data;
    throw err;
  }
  return data;
}

(async () => {
  const health = await call("GET", "/api/health");
  console.log("health", health);

  const a = await call("POST", "/api/rooms", { nickname: "Aria", ageConfirmed: true, deviceId: "dev-a" });
  console.log("created", a.roomId, a.secureToken, a.state.room.status);
  const tokenA = a.sessionToken;

  const b = await call("POST", `/api/rooms/${a.secureToken}/join`, { nickname: "Ben", ageConfirmed: true, deviceId: "dev-b" });
  console.log("joined", b.slot, b.state.room.status);
  const tokenB = b.sessionToken;

  const third = await handler({
    path: `/api/rooms/${a.secureToken}/join`,
    rawUrl: `http://localhost:3000/api/rooms/${a.secureToken}/join`,
    httpMethod: "POST",
    headers: { origin: "http://localhost:3000" },
    body: JSON.stringify({ nickname: "Cara", ageConfirmed: true }),
  });
  console.log("third", third.statusCode, JSON.parse(third.body).code);

  await call("POST", `/api/rooms/${a.roomId}/ready`, { ready: true }, tokenA);
  const readyB = await call("POST", `/api/rooms/${a.roomId}/ready`, { ready: true }, tokenB);
  console.log("both ready", readyB.state.room.status, readyB.state.game?.status);

  const gameId = readyB.state.game.gameId;
  await call("POST", `/api/games/${gameId}/mode`, { modeId: "LOVE_MAKING" }, tokenA);
  const mode = await call("POST", `/api/games/${gameId}/mode`, { modeId: "LOVE_MAKING", action: "accept" }, tokenB);
  console.log("mode", mode.state.game.status, mode.state.game.mode);

  await call("POST", `/api/games/${gameId}/preferences`, { intensity: "playful" }, tokenA);
  const prefs = await call("POST", `/api/games/${gameId}/preferences`, { intensity: "soft" }, tokenB);
  const startedA = await call("GET", "/api/state", null, tokenA);
  const startedB = prefs;
  console.log("started", startedB.state.game.status, startedB.state.game.effectiveIntensity, startedA.state.game.myQuestion?.prompt);

  const qA = startedA.state.game.myQuestion;
  await call("POST", `/api/games/${gameId}/answers`, { selectedOptionId: qA.options[0].optionId, responseTimeMs: 1200 }, tokenA);

  const stateB = await call("GET", "/api/state", null, tokenB);
  const qB = stateB.state.game.myQuestion;
  const afterB = await call("POST", `/api/games/${gameId}/answers`, { selectedOptionId: qB.options[0].optionId, responseTimeMs: 900 }, tokenB);
  console.log("round", afterB.state.game.status, afterB.state.game.roundResult);

  const adv = await call("POST", `/api/games/${gameId}/advance`, {}, tokenA);
  console.log("advance", adv.state.game.status, adv.state.game.challenge ? "challenge" : "next");

  console.log("OK");
  process.exit(0);
})().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
