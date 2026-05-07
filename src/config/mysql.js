const mysql = require("mysql2/promise");

const pools = new Map();

const normalizeProfile = (profile) => {
  return profile === "uat" ? "uat" : "default";
};

const getConfig = (profile) => {
  if (normalizeProfile(profile) === "uat") {
    return {
      host: process.env.MYSQL_UAT_HOST || "localhost",
      port: Number(process.env.MYSQL_UAT_PORT || 3306),
      user: process.env.MYSQL_UAT_USER || "zoneUat",
      password: process.env.MYSQL_UAT_PASSWORD || "",
      database: process.env.MYSQL_UAT_DATABASE || "scmarket_uat",
      connectionLimit: Number(process.env.MYSQL_UAT_CONNECTION_LIMIT || 10),
    };
  }

  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "scmarketplus",
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  };
};

const createPool = (profile) => {
  const config = getConfig(profile);

  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
  });
};

const getPool = (profile = process.env.MYSQL_PROFILE) => {
  const normalizedProfile = normalizeProfile(profile);

  if (!pools.has(normalizedProfile)) {
    pools.set(normalizedProfile, createPool(normalizedProfile));
  }

  return pools.get(normalizedProfile);
};

const pool = getPool();

const query = async (sql, params = [], profile) => {
  const [rows] = await getPool(profile).execute(sql, params);
  return rows;
};

const closePools = async () => {
  await Promise.all([...pools.values()].map((currentPool) => currentPool.end()));
};

module.exports = {
  pool,
  getPool,
  query,
  closePools,
  normalizeProfile,
};
