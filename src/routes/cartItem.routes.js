const express = require("express");

const cartItemService = require("../services/cartItem.service");
const { writeCartItemLog } = require("../services/cartItemLog.service");

const router = express.Router();

/** ตรวจสอบว่ามี member_id และเป็นค่าเดี่ยวที่นำไป bind กับ SQL ได้ */
const hasMemberId = (memberId) => {
  return memberId !== undefined && memberId !== null && !Array.isArray(memberId);
};

/** รับคำขอ GetCartItem บันทึก audit log และส่ง response รูปแบบเดียวกับ PHP เดิม */
const getCartItemHandler = async (req, res, next) => {
  const startedAt = Date.now();
  const memberId = req.query.member_id;
  const logContext = {
    method: req.method,
    path: req.originalUrl,
    databaseProfile: req.databaseProfile || "default",
    memberId: hasMemberId(memberId) ? String(memberId) : "",
  };

  await writeCartItemLog("request", logContext);

  if (!hasMemberId(memberId)) {
    await writeCartItemLog("response", {
      ...logContext,
      statusCode: 400,
      durationMs: Date.now() - startedAt,
      body: null,
    });
    return res.status(400).send(null);
  }

  try {
    const result = await cartItemService.getCartItems({
      memberId: String(memberId).trim(),
      databaseProfile: req.databaseProfile,
    });

    await writeCartItemLog("response", {
      ...logContext,
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      body: result,
    });
    return res.status(200).json(result);
  } catch (error) {
    await writeCartItemLog("error", {
      ...logContext,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      message: error.message,
      stack: error.stack,
    });
    return next(error);
  }
};

router.get(["/", "/index"], getCartItemHandler);

/** ปฏิเสธ HTTP method อื่นให้เหมือน index_put/index_post/index_delete ของ PHP เดิม */
router.all(["/", "/index"], (req, res) => {
  res.status(400).send(null);
});

module.exports = router;
