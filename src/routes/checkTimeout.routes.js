const express = require("express");
const checkTimeoutService = require("../services/checkTimeout.service");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const result = await checkTimeoutService.runCheckTimeout({
      databaseProfile: req.databaseProfile,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
