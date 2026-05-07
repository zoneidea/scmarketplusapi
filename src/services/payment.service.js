const os = require("os");

const { getPool } = require("../config/mysql");
const boothLockService = require("./boothLock.service");
const notificationService = require("./notification.service");

const CALLBACK_CONTROLLER = "CallbackPaymentNotifyURL";

const issetParam = (value) => (value === undefined || value === null ? "" : value);

const normalizePaymentPayload = (payload = {}) => {
  const data = payload.data || {};

  return {
    code: issetParam(payload.code),
    msg: issetParam(payload.msg),
    message: issetParam(payload.message),
    sign: issetParam(payload.sign),
    appid: issetParam(data.appid),
    attach: issetParam(data.attach),
    cash_fee: issetParam(data.cash_fee),
    cash_fee_type: issetParam(data.cash_fee_type),
    channel: issetParam(data.channel),
    channel_order_no: issetParam(data.channel_order_no),
    fee_type: issetParam(data.fee_type),
    ksher_order_no: issetParam(data.ksher_order_no),
    mch_order_no: issetParam(data.mch_order_no),
    nonce_str: issetParam(data.nonce_str),
    openid: issetParam(data.openid),
    pay_mch_order_no: issetParam(data.pay_mch_order_no),
    rate: issetParam(data.rate),
    result: String(issetParam(data.result)).toUpperCase(),
    time_end: issetParam(data.time_end),
    total_fee: issetParam(data.total_fee),
  };
};

const insertNotifyLog = async (connection, data) => {
  const columns = [
    "code",
    "msg",
    "message",
    "sign",
    "appid",
    "attach",
    "cash_fee",
    "cash_fee_type",
    "channel",
    "channel_order_no",
    "fee_type",
    "ksher_order_no",
    "mch_order_no",
    "nonce_str",
    "openid",
    "pay_mch_order_no",
    "rate",
    "result",
    "time_end",
    "total_fee",
    "json",
    "controller",
  ];

  const values = columns.map((column) => data[column] ?? "");
  const placeholders = columns.map(() => "?").join(", ");

  await connection.execute(
    `INSERT INTO payment_notify_transaction (${columns.join(
      ", "
    )}, date_create) VALUES (${placeholders}, NOW())`,
    values
  );
};

const isPaymentSuccess = (code, result) => {
  return Number(code) === 0 && String(result).toUpperCase() === "SUCCESS";
};

const getFCMToken = async (connection, memberId) => {
  if (!memberId) {
    return "";
  }

  const [rows] = await connection.execute(
    "SELECT token FROM btmember b WHERE mb_Id = ?",
    [memberId]
  );

  return rows.length === 1 ? rows[0].token || "" : "";
};

const notifyMember = async (token, mchOrderNo, notification) => {
  if (!token) {
    return null;
  }

  try {
    return await notificationService.sendNotification({
      token,
      notification,
      data: {
        Controller: CALLBACK_CONTROLLER,
        Value: mchOrderNo,
      },
    });
  } catch (error) {
    console.error(`FCM send failed for ${mchOrderNo}: ${error.message}`);
    return null;
  }
};

const handleSuccess = async (connection, transactionRows, mchOrderNo, host, ip) => {
  let memberId = "";

  for (const transaction of transactionRows) {
    memberId = transaction.mb_id;

    if (transaction.CartType === "Booking") {
      await connection.execute(
        `UPDATE btbooking
         SET booking_status_id = 3
         WHERE booking_id = ? AND booking_member_id = ?`,
        [transaction.booking_id, memberId]
      );

      const [bookingDetails] = await connection.execute(
        `SELECT bd.bd_id, bd.bd_booth_id, bd.bd_booking_date
         FROM btbooking_detail bd
         WHERE bd.bd_booking_id = ?`,
        [transaction.booking_id]
      );

      for (const detail of bookingDetails) {
        await connection.execute(
          `UPDATE interested_booth
           SET status = 0
           WHERE bd_id = ?`,
          [detail.bd_id]
        );

        await boothLockService.updateLock(
          detail.bd_booth_id,
          detail.bd_booking_date,
          "confirmed"
        );
      }

      await connection.execute(
        `INSERT INTO nontification_master (
           booking_id,
           nontification_type,
           message,
           isRead,
           ipaddress,
           computername,
           date_create,
           UserType
         )
         SELECT
           bd_booking_id AS booking_id,
           'Booking',
           'แจ้งเตือนการจอง Booth',
           0,
           ?,
           ?,
           NOW(),
           'User'
         FROM btbooking_detail bd
         WHERE bd.bd_booking_id = ?`,
        [ip, host, transaction.booking_id]
      );
    }

    if (transaction.CartType === "Charge") {
      await connection.execute(
        "UPDATE audit_checker_details SET status_price = 'Success' WHERE keyId = ?",
        [transaction.keyId]
      );
    }
  }

  const [coupons] = await connection.execute(
    `SELECT coupon_id, mb_id
     FROM transaction_master
     WHERE trans_id = ?`,
    [mchOrderNo]
  );

  for (const coupon of coupons) {
    if (!coupon.coupon_id) {
      continue;
    }

    await connection.execute(
      "UPDATE btcoupon SET coupon_status = 3 WHERE coupon_id = ?",
      [coupon.coupon_id]
    );

    await connection.execute(
      `UPDATE btcoupon_in
       SET coupon_in_status = 'Y'
       WHERE coupon_id = ? AND coupon_in_user = ?`,
      [coupon.coupon_id, coupon.mb_id]
    );
  }

  return memberId;
};

const handleFailed = async (connection, transactionRows) => {
  let memberId = "";

  for (const transaction of transactionRows) {
    memberId = transaction.mb_id;

    if (transaction.CartType === "Booking") {
      await connection.execute(
        `UPDATE btbooking
         SET booking_status_id = 2
         WHERE booking_id = ? AND booking_member_id = ?`,
        [transaction.booking_id, memberId]
      );
    }

    if (transaction.CartType === "Charge") {
      await connection.execute(
        "UPDATE audit_checker_details SET status_price = 'Pending' WHERE keyId = ?",
        [transaction.keyId]
      );
    }
  }

  return memberId;
};

const handlePaymentNotify = async (payload = {}, options = {}) => {
  const host = os.hostname();
  const ip = getLocalIp();
  const rawBody = options.rawBody || JSON.stringify(payload || {});
  const normalized = normalizePaymentPayload(payload);
  const connection = await getPool(options.databaseProfile).getConnection();
  let committed = false;

  try {
    await connection.beginTransaction();

    await insertNotifyLog(connection, {
      ...normalized,
      json: rawBody,
      controller: CALLBACK_CONTROLLER,
    });

    if (!normalized.mch_order_no) {
      await connection.commit();
      committed = true;
      return {
        result: "FAIL",
        msg: "JSON not have a mch_order_no data.",
      };
    }

    const [transactionRows] = await connection.execute(
      `SELECT trans_id, booking_id, keyId, CartType, mb_id
       FROM transaction_details
       WHERE trans_id = ?`,
      [normalized.mch_order_no]
    );

    if (transactionRows.length === 0) {
      await connection.commit();
      committed = true;
      return {
        result: "SUCCESS",
        msg: "OK",
      };
    }

    const success = isPaymentSuccess(normalized.code, normalized.result);
    const memberId = success
      ? await handleSuccess(connection, transactionRows, normalized.mch_order_no, host, ip)
      : await handleFailed(connection, transactionRows);

    await connection.commit();
    committed = true;

    const token = await getFCMToken(connection, memberId);
    await notifyMember(token, normalized.mch_order_no, {
      title: success ? "ชำระเงินสำเร็จ" : "ผิดพลาดในการชำระเงิน",
      body: success
        ? "ท่านได้ชำระเงินจองบูธเรียบร้อยแล้ว"
        : "การชำระเงินของท่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    });

    return {
      result: "SUCCESS",
      msg: "OK",
    };
  } catch (error) {
    if (!committed) {
      await connection.rollback();
    }

    await insertNotifyLog(connection, {
      ...emptyNotifyLog(),
      code: normalized.code,
      msg: "EXCEPTION",
      message: error.message,
      sign: normalized.sign,
      mch_order_no: normalized.mch_order_no,
      json: rawBody,
      controller: `${CALLBACK_CONTROLLER}_EXCEPTION`,
    }).catch(() => {});

    return {
      result: "FAIL",
      msg: "Exception transaction rollback.",
    };
  } finally {
    connection.release();
  }
};

const emptyNotifyLog = () => ({
  code: "",
  msg: "",
  message: "",
  sign: "",
  appid: "",
  attach: "",
  cash_fee: "",
  cash_fee_type: "",
  channel: "",
  channel_order_no: "",
  fee_type: "",
  ksher_order_no: "",
  mch_order_no: "",
  nonce_str: "",
  openid: "",
  pay_mch_order_no: "",
  rate: "",
  result: "",
  time_end: "",
  total_fee: "",
  json: "",
  controller: "",
});

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "127.0.0.1";
};

module.exports = {
  handlePaymentNotify,
};
