const express = require("express");

const paymentService = require("../services/payment.service");

const router = express.Router();

const getRequestBaseUrl = (req) => {
  const host = req.get("host");

  if (!host) {
    return "";
  }

  return `${req.protocol}://${host}/`;
};

router.post(["/", "/index"], async (req, res) => {
  const result = await paymentService.createTransactionPayment(req.body, {
    databaseProfile: req.databaseProfile,
    baseUrl: getRequestBaseUrl(req),
  });

  res.status(200).json(result);
});

router.all(["/", "/index"], (req, res) => {
  res.status(400).json({ success: false, message: "Bad request" });
});

module.exports = router;
