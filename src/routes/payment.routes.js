const express = require("express");
const paymentService = require("../services/payment.service");

const router = express.Router();

router.post("/", async (req, res) => {
  let result;

  try {
    result = await paymentService.handlePaymentNotify(req.body, {
      databaseProfile: req.databaseProfile,
      rawBody: JSON.stringify(req.body || {}),
    });
  } catch (error) {
    result = {
      result: "FAIL",
      msg: error.message,
    };
  }

  res.status(200).json(result);
});

router.get("/", (req, res) => {
  res.status(200).send(`BackgroundURL GET CALLBACK--${req.query.params || ""}`);
});

router.put("/", (req, res) => {
  res.status(400).json({ success: false, message: "Bad request" });
});

router.delete("/", (req, res) => {
  res.status(400).json({ success: false, message: "Bad request" });
});

module.exports = router;
