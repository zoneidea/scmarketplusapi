require("dotenv").config();

const app = require("./app");
const { pool } = require("./config/mysql");
require("./config/firebase");

const port = Number(process.env.PORT || 3000);

const server = app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
