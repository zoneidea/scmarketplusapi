const express = require("express");
const boothLockService = require("../services/boothLock.service");

const router = express.Router();

router.patch("/:boothId/:date", async (req, res, next) => {
  try {
    const result = await boothLockService.updateLock(
      req.params.boothId,
      req.params.date,
      req.body.status
    );

    res.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:boothId/:date", async (req, res, next) => {
  try {
    const result = await boothLockService.deleteLock(req.params.boothId, req.params.date);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/expire-old", async (req, res, next) => {
  try {
    const countUpdated = await boothLockService.expireOldBoothLocks();

    res.json({
      success: true,
      data: {
        countUpdated,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
