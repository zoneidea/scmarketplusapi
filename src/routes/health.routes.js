const express = require("express");
const { pool } = require("../config/mysql");

const router = express.Router();

router.get("/", async (req, res) => {
  const result = {
    success: true,
    service: "scmarketplusapi",
    database: "unknown",
    timestamp: new Date().toISOString(),
  };

  try {
    await pool.query("SELECT 1");
    result.database = "connected";
  } catch (error) {
    result.database = "unavailable";
    result.databaseError = error.message;
  }

  res.json(result);
});

module.exports = router;
