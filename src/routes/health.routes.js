const express = require("express");
const { getPool, normalizeProfile } = require("../config/mysql");

const router = express.Router();

const healthCheck = async (req, res) => {
  const profile = normalizeProfile(req.params.profile);
  const result = {
    success: true,
    service: "scmarketplusapi",
    profile,
    database: "unknown",
    timestamp: new Date().toISOString(),
  };

  try {
    await getPool(profile).query("SELECT 1");
    result.database = "connected";
  } catch (error) {
    result.database = "unavailable";
    result.databaseError = error.message;
  }

  res.json(result);
};

router.get("/", healthCheck);
router.get("/:profile", healthCheck);

module.exports = router;
