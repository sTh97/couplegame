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

let clientPromise;

async function connectWithFallback() {
  const opts = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  };
  try {
    const client = new MongoClient(MONGODB_URI, opts);
    return await client.connect();
  } catch (err) {
    const msg = String(err && err.message);
    if (/querySrv|ECONNREFUSED|ENOTFOUND|ETIMEOUT/i.test(msg)) {
      const client = new MongoClient(MONGODB_URI_STANDARD, opts);
      return client.connect();
    }
    throw err;
  }
}

function getClient() {
  if (!clientPromise) {
    clientPromise = connectWithFallback();
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

module.exports = { getDb, collections, ensureIndexes, DB_NAME };
