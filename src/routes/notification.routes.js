const express = require("express");
const notificationService = require("../services/notification.service");

const router = express.Router();

router.post("/send", async (req, res, next) => {
  try {
    const result = await notificationService.sendNotification(req.body);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
