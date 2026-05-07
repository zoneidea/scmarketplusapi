const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/health.routes");
const notificationRoutes = require("./routes/notification.routes");
const firestoreRoutes = require("./routes/firestore.routes");
const paymentRoutes = require("./routes/payment.routes");
const boothLockRoutes = require("./routes/boothLock.routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

const captureRawBody = (req, res, buf) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString("utf8");
  }
};

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb", verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
app.use(express.text({ type: "*/*", limit: "1mb", verify: captureRawBody }));

app.use("/health", healthRoutes);
app.use("/CallbackPaymentNotifyURL", paymentRoutes);
app.use("/api/payments/callback", paymentRoutes);
app.use(
  "/uat/CallbackPaymentNotifyURL",
  (req, res, next) => {
    req.databaseProfile = "uat";
    next();
  },
  paymentRoutes
);
app.use(
  "/api/uat/payments/callback",
  (req, res, next) => {
    req.databaseProfile = "uat";
    next();
  },
  paymentRoutes
);
app.use("/api/notifications", notificationRoutes);
app.use("/api/firestore", firestoreRoutes);
app.use("/api/booth-locks", boothLockRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
