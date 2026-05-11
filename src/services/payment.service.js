const crypto = require("crypto");
const os = require("os");

const { getPool } = require("../config/mysql");
const boothLockService = require("./boothLock.service");
const ksherService = require("./ksher.service");
const notificationService = require("./notification.service");

const CALLBACK_CONTROLLER = "CallbackPaymentNotifyURL";
const RAW_LOG_TABLE = "payment_notify_raw_logs";
let notifyTableColumnSet = null;
let rawLogTableReady = false;

const issetParam = (value) => (value === undefined || value === null ? "" : value);

const safeJsonStringify = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {}, (key, currentValue) =>
      typeof currentValue === "bigint" ? currentValue.toString() : currentValue
    );
  } catch (error) {
    return JSON.stringify({
      stringify_error: error.message,
      value_type: typeof value,
    });
  }
};

const parseJsonObject = (value) => {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? value : null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
};

const normalizeIncomingPayload = (payload = {}, rawBody = "") => {
  if (payload && typeof payload === "object" && !Buffer.isBuffer(payload)) {
    return payload;
  }

  return parseJsonObject(payload) || parseJsonObject(rawBody) || {};
};

const valueFromDataOrPayload = (payload, data, key) => {
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    return data[key];
  }

  return payload[key];
};

const normalizePaymentPayload = (payload = {}) => {
  const data = parseJsonObject(payload.data) || payload.data || {};

  return {
    code: issetParam(payload.code),
    msg: issetParam(payload.msg),
    message: issetParam(payload.message),
    sign: issetParam(payload.sign),
    appid: issetParam(valueFromDataOrPayload(payload, data, "appid")),
    attach: issetParam(valueFromDataOrPayload(payload, data, "attach")),
    cash_fee: issetParam(valueFromDataOrPayload(payload, data, "cash_fee")),
    cash_fee_type: issetParam(valueFromDataOrPayload(payload, data, "cash_fee_type")),
    channel: issetParam(valueFromDataOrPayload(payload, data, "channel")),
    channel_order_no: issetParam(
      valueFromDataOrPayload(payload, data, "channel_order_no")
    ),
    fee_type: issetParam(valueFromDataOrPayload(payload, data, "fee_type")),
    ksher_order_no: issetParam(valueFromDataOrPayload(payload, data, "ksher_order_no")),
    lang: issetParam(valueFromDataOrPayload(payload, data, "lang")),
    mch_order_no: issetParam(valueFromDataOrPayload(payload, data, "mch_order_no")),
    nonce_str: issetParam(valueFromDataOrPayload(payload, data, "nonce_str")),
    openid: issetParam(valueFromDataOrPayload(payload, data, "openid")),
    pay_mch_order_no: issetParam(
      valueFromDataOrPayload(payload, data, "pay_mch_order_no")
    ),
    rate: issetParam(valueFromDataOrPayload(payload, data, "rate")),
    result: String(
      issetParam(valueFromDataOrPayload(payload, data, "result"))
    ).toUpperCase(),
    time_end: issetParam(valueFromDataOrPayload(payload, data, "time_end")),
    total_fee: issetParam(valueFromDataOrPayload(payload, data, "total_fee")),
  };
};

const getNotifyTableColumns = async (connection) => {
  if (!notifyTableColumnSet) {
    const [rows] = await connection.execute("SHOW COLUMNS FROM payment_notify_transaction");
    notifyTableColumnSet = new Set(rows.map((row) => row.Field));
  }

  return notifyTableColumnSet;
};

const ensureRawLogTable = async (connection) => {
  if (rawLogTableReady) {
    return;
  }

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${RAW_LOG_TABLE} (
      raw_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      event_name VARCHAR(50) NOT NULL DEFAULT 'received',
      controller VARCHAR(100) NOT NULL DEFAULT '',
      database_profile VARCHAR(50) NOT NULL DEFAULT '',
      request_method VARCHAR(16) NOT NULL DEFAULT '',
      request_url VARCHAR(500) NOT NULL DEFAULT '',
      request_path VARCHAR(255) NOT NULL DEFAULT '',
      request_ip VARCHAR(100) NOT NULL DEFAULT '',
      remote_address VARCHAR(100) NOT NULL DEFAULT '',
      content_type VARCHAR(255) NOT NULL DEFAULT '',
      user_agent VARCHAR(500) NOT NULL DEFAULT '',
      headers_json LONGTEXT NULL,
      query_json LONGTEXT NULL,
      params_json LONGTEXT NULL,
      body_type VARCHAR(50) NOT NULL DEFAULT '',
      body_json LONGTEXT NULL,
      raw_body LONGTEXT NULL,
      payload_json LONGTEXT NULL,
      normalized_json LONGTEXT NULL,
      error_message LONGTEXT NULL,
      error_stack LONGTEXT NULL,
      date_create DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (raw_id),
      KEY idx_date_create (date_create),
      KEY idx_controller (controller),
      KEY idx_event_name (event_name),
      KEY idx_database_profile (database_profile)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  rawLogTableReady = true;
};

const insertRawNotifyLog = async (connection, data = {}) => {
  await ensureRawLogTable(connection);

  const request = data.request || {};
  const headers = request.headers || {};

  await connection.execute(
    `INSERT INTO ${RAW_LOG_TABLE} (
       event_name,
       controller,
       database_profile,
       request_method,
       request_url,
       request_path,
       request_ip,
       remote_address,
       content_type,
       user_agent,
       headers_json,
       query_json,
       params_json,
       body_type,
       body_json,
       raw_body,
       payload_json,
       normalized_json,
       error_message,
       error_stack,
       date_create
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      data.eventName || "received",
      data.controller || CALLBACK_CONTROLLER,
      data.databaseProfile || "",
      request.method || "",
      request.originalUrl || "",
      request.path || "",
      request.ip || "",
      request.remoteAddress || "",
      headers["content-type"] || "",
      headers["user-agent"] || "",
      safeJsonStringify(headers),
      safeJsonStringify(request.query || {}),
      safeJsonStringify(request.params || {}),
      request.bodyType || "",
      safeJsonStringify(data.body),
      data.rawBody || "",
      safeJsonStringify(data.payload),
      safeJsonStringify(data.normalized),
      data.error?.message || "",
      data.error?.stack || "",
    ]
  );
};

const tryInsertRawNotifyLog = async (connection, data = {}) => {
  try {
    await insertRawNotifyLog(connection, data);
  } catch (error) {
    console.error(`Raw payment notify log failed: ${error.message}`);
  }
};

const insertNotifyLog = async (connection, data) => {
  const tableColumns = await getNotifyTableColumns(connection);
  const columns = [
    "code",
    "lang",
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
  ].filter((column) => tableColumns.has(column));

  const values = columns.map((column) => data[column] ?? "");
  const placeholders = columns.map(() => "?").join(", ");
  const hasDateCreate = tableColumns.has("date_create");
  const dateColumn = hasDateCreate ? ", date_create" : "";
  const dateValue = hasDateCreate ? ", NOW()" : "";

  await connection.execute(
    `INSERT INTO payment_notify_transaction (${columns.join(
      ", "
    )}${dateColumn}) VALUES (${placeholders}${dateValue})`,
    values
  );
};

const isPaymentSuccess = (code, result) => {
  return Number(code) === 0 && String(result).toUpperCase() === "SUCCESS";
};

const toArray = (value) => {
  return Array.isArray(value) ? value : [value];
};

const isBlank = (value) => {
  return value === undefined || value === null || value === "";
};

const normalizeIdArray = (value) => {
  return toArray(value).filter((item) => !isBlank(item));
};

const buildInClause = (values) => {
  return values.map(() => "?").join(", ");
};

const rowMapBy = (rows, key) => {
  return new Map(rows.map((row) => [String(row[key]), row]));
};

const getBangkokYearMonth = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.PAYMENT_TIME_ZONE || "Asia/Bangkok",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";

  return `${year}${month}`;
};

const generateTransactionId = () => {
  return `T${getBangkokYearMonth()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
};

const getBaseUrl = (baseUrl = "") => {
  const resolved = process.env.PAYMENT_PUBLIC_BASE_URL || baseUrl || "";
  return resolved.endsWith("/") ? resolved : `${resolved}/`;
};

const buildGatewayPayData = ({ transId, amount, baseUrl }) => {
  const resolvedBaseUrl = getBaseUrl(baseUrl);

  return {
    mch_order_no: transId,
    total_fee: Math.round(Number(amount || 0) * 100),
    fee_type: "THB",
    channel_list:
      process.env.KSHER_CHANNEL_LIST || "promptpay,truemoney,linepay,card,scb_easy",
    mch_code: transId,
    mch_redirect_url: `${resolvedBaseUrl}CallbackPaymentSuccessURL?TransID=${transId}`,
    mch_redirect_url_fail: `${resolvedBaseUrl}CallbackPaymentFailedURL?TransID=${transId}`,
    product_name: process.env.KSHER_PRODUCT_NAME || "จองบูธ SC MARKET",
    lang: process.env.KSHER_LANG || "th",
    refer_url: process.env.KSHER_REFER_URL || "http://www.ksher.cn",
    mch_notify_url:
      process.env.KSHER_NOTIFY_URL || "https://api.scmarketplus.com/CallbackPaymentNotifyURL",
    device: process.env.KSHER_DEVICE || "H5",
  };
};

const validateBookings = async (connection, bookingIds) => {
  if (bookingIds.length === 0) {
    return { marketId: "" };
  }

  const [rows] = await connection.execute(
    `SELECT booking_id, booking_market_id
     FROM btbooking
     WHERE booking_id IN (${buildInClause(bookingIds)}) AND booking_status_id = 2`,
    bookingIds
  );
  const bookingsById = rowMapBy(rows, "booking_id");
  let marketId = "";

  for (const bookingId of bookingIds) {
    const booking = bookingsById.get(String(bookingId));

    if (!booking) {
      return {
        error: {
          status: "fail",
          message: `เลขที่การจอง ${bookingId} หมดเวลาในการชำระเงินแล้ว!`,
          data: "",
        },
      };
    }

    if (marketId === "") {
      marketId = booking.booking_market_id;
      continue;
    }

    if (String(marketId) !== String(booking.booking_market_id)) {
      return {
        error: {
          status: "fail",
          message: "คุณไม่สามารถชำระค่าจองของ 2 ตึก พร้อมกันได้ กรุณาทำรายการใหม่!",
          data: "",
        },
      };
    }

    marketId = booking.booking_market_id;
  }

  return { marketId };
};

const resolveChargeMarketId = async (connection, chargeIds, currentMarketId) => {
  if (chargeIds.length === 0) {
    return currentMarketId;
  }

  const [rows] = await connection.execute(
    `SELECT acd.keyId, b.booking_market_id
     FROM audit_checker_details AS acd
     LEFT JOIN btbooking AS b ON acd.booking_id = b.booking_id
     WHERE acd.keyId IN (${buildInClause(chargeIds)})`,
    chargeIds
  );
  const chargesById = rowMapBy(rows, "keyId");
  let marketId = currentMarketId;

  for (const chargeId of chargeIds) {
    const charge = chargesById.get(String(chargeId));

    if (!charge) {
      throw new Error(`ไม่พบรายการค่าใช้จ่าย ${chargeId}`);
    }

    marketId = charge.booking_market_id;
  }

  return marketId;
};

const getMerchantCredentials = async (connection, marketId) => {
  const [rows] = await connection.execute(
    `SELECT bb.mch_id, bb.privatekey
     FROM btmarketinformation AS mi
     LEFT JOIN btbu AS bb ON mi.bu_Id = bb.bu_Id
     WHERE mi.mi_Id = ?`,
    [marketId || ""]
  );

  return rows[0] || null;
};

const insertTransactionDetails = async (connection, { transId, bookingIds, chargeIds, memberId }) => {
  if (bookingIds.length > 0) {
    const placeholders = bookingIds.map(() => "(?, ?, 'Booking', NOW(), NOW(), ?)").join(", ");
    const params = bookingIds.flatMap((bookingId) => [transId, bookingId, memberId]);

    await connection.execute(
      `INSERT INTO transaction_details (
         trans_id,
         booking_id,
         CartType,
         date_create,
         date_modify,
         mb_id
       ) VALUES ${placeholders}`,
      params
    );

    await connection.execute(
      `UPDATE btbooking
       SET booking_status_id = 5
       WHERE booking_id IN (${buildInClause(bookingIds)})`,
      bookingIds
    );
  }

  if (chargeIds.length > 0) {
    const placeholders = chargeIds.map(() => "(?, ?, 'Charge', NOW(), NOW(), ?)").join(", ");
    const params = chargeIds.flatMap((chargeId) => [transId, chargeId, memberId]);

    await connection.execute(
      `INSERT INTO transaction_details (
         trans_id,
         keyId,
         CartType,
         date_create,
         date_modify,
         mb_id
       ) VALUES ${placeholders}`,
      params
    );

    await connection.execute(
      `UPDATE audit_checker_details
       SET status_price = 'Waiting'
       WHERE keyId IN (${buildInClause(chargeIds)})`,
      chargeIds
    );
  }
};

const createTransactionPayment = async (payload = {}, options = {}) => {
  const bookingIds = normalizeIdArray(payload.booking_id);
  const chargeIds = normalizeIdArray(payload.charge_id);
  const couponId = isBlank(payload.coupon_id) ? 0 : payload.coupon_id;
  const amount = payload.amount;
  const memberId = payload.mb_Id;
  const connection = await getPool(options.databaseProfile).getConnection();

  try {
    const bookingValidation = await validateBookings(connection, bookingIds);
    if (bookingValidation.error) {
      return bookingValidation.error;
    }

    const marketId = await resolveChargeMarketId(
      connection,
      chargeIds,
      bookingValidation.marketId
    );
    const merchant = await getMerchantCredentials(connection, marketId);

    if (!merchant) {
      return {
        status: "fail",
        message: "mch id ไม่ถูกต้องกรุณาติดต่อแอดมิน",
        data: "",
      };
    }

    const transId = generateTransactionId();
    const privateKey = ksherService.readPrivateKey(merchant.mch_id, merchant.privatekey);
    const gatewayPayData = buildGatewayPayData({
      transId,
      amount,
      baseUrl: options.baseUrl,
    });
    const gatewayResponse = await ksherService.gatewayPay({
      appid: merchant.mch_id,
      privateKey,
      data: gatewayPayData,
    });
    const gatewayPayArray =
      typeof gatewayResponse.data === "string"
        ? parseJsonObject(gatewayResponse.data)
        : gatewayResponse.data;
    const payContent = gatewayPayArray?.data?.pay_content;

    if (!payContent) {
      return {
        status: "fail",
        message: "Fail to create Redirect Order",
        data: gatewayResponse.raw,
      };
    }

    await connection.beginTransaction();

    try {
      await connection.execute(
        `INSERT INTO transaction_master (
           trans_id,
           mch_pay_content,
           mch_sign,
           mch_msg,
           mch_message,
           mch_code,
           amount,
           date_create,
           date_modify,
           mb_id,
           coupon_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?)`,
        [
          transId,
          payContent,
          gatewayPayArray.sign,
          gatewayPayArray.msg,
          gatewayPayArray.message,
          gatewayPayArray.code,
          amount,
          memberId,
          couponId,
        ]
      );

      await insertTransactionDetails(connection, {
        transId,
        bookingIds,
        chargeIds,
        memberId,
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();

      return {
        status: "failed",
        message: "บันทึกไม่สำเร็จ!",
        data: error.message,
      };
    }

    return {
      status: "success",
      message: "บันทึกสำเร็จ!",
      TransID: transId,
      gateway_pay_data: gatewayPayData,
      mch_code: gatewayPayArray.code,
      pay_content: payContent,
    };
  } catch (error) {
    return {
      status: "failed",
      message: error.message,
      data: null,
    };
  } finally {
    connection.release();
  }
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
  const rawBody =
    options.rawBody ||
    (typeof payload === "string" ? payload : JSON.stringify(payload || {}));
  const connection = await getPool(options.databaseProfile).getConnection();

  await tryInsertRawNotifyLog(connection, {
    eventName: "received",
    controller: CALLBACK_CONTROLLER,
    databaseProfile: options.databaseProfile || "",
    request: options.request,
    body: payload,
    payload,
    rawBody,
  });

  const parsedPayload = normalizeIncomingPayload(payload, rawBody);
  const normalized = normalizePaymentPayload(parsedPayload);
  let transactionStarted = false;

  try {
    await tryInsertRawNotifyLog(connection, {
      eventName: "normalized",
      controller: CALLBACK_CONTROLLER,
      databaseProfile: options.databaseProfile || "",
      request: options.request,
      body: payload,
      payload: parsedPayload,
      normalized,
      rawBody,
    });

    await insertNotifyLog(connection, {
      ...normalized,
      json: rawBody,
      controller: CALLBACK_CONTROLLER,
    });

    if (!normalized.mch_order_no) {
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
      return {
        result: "SUCCESS",
        msg: "OK",
      };
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const success = isPaymentSuccess(normalized.code, normalized.result);
    const memberId = success
      ? await handleSuccess(connection, transactionRows, normalized.mch_order_no, host, ip)
      : await handleFailed(connection, transactionRows);

    await connection.commit();
    transactionStarted = false;

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
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
    }

    await tryInsertRawNotifyLog(connection, {
      eventName: "exception",
      controller: CALLBACK_CONTROLLER,
      databaseProfile: options.databaseProfile || "",
      request: options.request,
      body: payload,
      payload: parsedPayload,
      normalized,
      rawBody,
      error,
    });

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
  lang: "",
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
  createTransactionPayment,
  handlePaymentNotify,
};
