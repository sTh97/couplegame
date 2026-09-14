const { MongoClient } = require("mongodb");

const USER = "staimoorhasan_db_user";
const PASS = "Ia1kgfTakzfi4m1U";

const MONGODB_URI =
  process.env.MONGODB_URI ||
  `mongodb+srv://${USER}:${PASS}@cluster0.nt5pm2q.mongodb.net/couplegame?retryWrites=true&w=majority`;

const MONGODB_URI_STANDARD =
  process.env.MONGODB_URI_STANDARD ||
  `mongodb://${USER}:${PASS}@ac-efwjyys-shard-00-00.nt5pm2q.mongodb.net:27017,ac-efwjyys-shard-00-01.nt5pm2q.mongodb.net:27017,ac-efwjyys-shard-00-02.nt5pm2q.mongodb.net:27017/couplegame?ssl=true&replicaSet=atlas-yqwgei-shard-0&authSource=admin&retryWrites=true&w=majority`;

const DB_NAME = process.env.MONGODB_DB || "couplegame";
const ON_NETLIFY = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

let clientPromise;

function clientOptions() {
  return {
    maxPoolSize: 5,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 6000,
    connectTimeoutMS: 6000,
    socketTimeoutMS: 10000,
    family: 4,
  };
}

async function tryConnect(uri) {
  const client = new MongoClient(uri, clientOptions());
  await client.connect();
  await client.db(DB_NAME).command({ ping: 1 });
  return client;
}

async function connectWithFallback() {
  const uris = ON_NETLIFY ? [MONGODB_URI_STANDARD, MONGODB_URI] : [MONGODB_URI, MONGODB_URI_STANDARD];
  let lastErr;
  for (const uri of uris) {
    try {
      return await tryConnect(uri);
    } catch (err) {
      lastErr = err;
    }
  }
  const wrapped = new Error(lastErr && lastErr.message ? lastErr.message : "Database connection failed");
  wrapped.name = "MongoConnectionError";
  wrapped.cause = lastErr;
  throw wrapped;
}

function getClient() {
  if (!clientPromise) {
    clientPromise = connectWithFallback().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(DB_NAME);
}

async function collections() {
  const db = await getDb();
  return {
    rooms: db.collection("rooms"),
    games: db.collection("games"),
    questions: db.collection("questions"),
    challenges: db.collection("challenges"),
    reports: db.collection("reports"),
    events: db.collection("game_events"),
    audit: db.collection("audit_logs"),
  };
}

async function ensureIndexes() {
  const { rooms, games, questions, challenges, reports, events, audit } = await collections();
  await Promise.all([
    rooms.createIndex({ secureToken: 1 }, { unique: true }),
    rooms.createIndex({ roomId: 1 }, { unique: true }),
    rooms.createIndex({ expiresAt: 1 }),
    games.createIndex({ gameId: 1 }, { unique: true }),
    games.createIndex({ roomId: 1 }),
    games.createIndex({ "players.A.sessionId": 1 }),
    games.createIndex({ "players.B.sessionId": 1 }),
    questions.createIndex({ questionId: 1 }, { unique: true }),
    challenges.createIndex({ challengeId: 1 }, { unique: true }),
    challenges.createIndex({ gameMode: 1, intensityLevel: 1, activeStatus: 1 }),
    reports.createIndex({ gameId: 1 }, { unique: true }),
    events.createIndex({ roomId: 1, createdAt: -1 }),
    audit.createIndex({ createdAt: -1 }),
  ]);
}

function isDbError(err) {
  const name = String((err && err.name) || "");
  const msg = String((err && err.message) || "");
  return (
    name.includes("Mongo") ||
    /mongo|querySrv|ECONNREFUSED|ENOTFOUND|whitelist|not allowed|server selection|authentication|EAI_AGAIN/i.test(
      msg
    )
  );
}

module.exports = { getDb, collections, ensureIndexes, DB_NAME, isDbError };
