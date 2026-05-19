const os = require("os");

const { getPool } = require("../config/mysql");
const boothLockService = require("./boothLock.service");
const notificationService = require("./notification.service");

const CONTROLLER = "CheckTimeout";
const WARNING_MINUTES = 5;

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

const insertNotificationMaster = async (
  connection,
  { bookingId, type, message, ip, host }
) => {
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
     ) VALUES (?, ?, ?, 0, ?, ?, NOW(), 'User')`,
    [bookingId, type, message, ip, host]
  );
};

const sendMemberNotification = async ({ token, bookingId, message }) => {
  if (!token) {
    return {
      bookingId,
      success: false,
      skipped: true,
      reason: "missing token",
    };
  }

  try {
    const result = await notificationService.sendNotification({
      token,
      notification: {
        title: "SC Market",
        body: message,
      },
      data: {
        Controller: CONTROLLER,
        Value: String(bookingId),
      },
    });

    return {
      bookingId,
      success: true,
      ...result,
    };
  } catch (error) {
    return {
      bookingId,
      success: false,
      error: error.message,
    };
  }
};

const updateExpiredBookings = async (connection) => {
  const [result] = await connection.execute(
    `UPDATE btbooking
     SET booking_status_id = 4,
         booking_updated_date = NOW()
     WHERE booking_id IN (
       SELECT *
       FROM (
         SELECT b.booking_id
         FROM btbooking AS b
         WHERE b.booking_status_id IN (2, 5)
           AND NOW() > (
             SELECT b.booking_created_date + INTERVAL (m.to_Time * 60) MINUTE_SECOND
             FROM bttimeout AS m
           )
       ) AS c
     )
     OR (booking_status_id = 0 AND booking_building_id = 0)`
  );

  return result.affectedRows || 0;
};

const updateErroredOrders = async (connection) => {
  const [result] = await connection.execute(
    `UPDATE btbooking
     SET booking_status_id = 8,
         booking_updated_date = NOW()
     WHERE booking_member_id = 0
       AND booking_status_id = 0
       AND NOW() > ADDTIME(booking_created_date, '24:00:00')
       AND booking_id NOT IN (
         SELECT booking_id COLLATE utf8_unicode_ci
         FROM transaction_details
       )`
  );

  return result.affectedRows || 0;
};

const processWarningNotifications = async (connection, ip, host, minuteWarning) => {
  const [rows] = await connection.execute(
    `SELECT b.booking_id, b.booking_member_id, m.token, b.booking_created_date
     FROM btbooking AS b
     LEFT JOIN btmember m ON b.booking_member_id = m.mb_Id
     WHERE b.booking_status_id = 2
       AND DATE_FORMAT(NOW(), '%d/%m/%Y %h:%i') = DATE_FORMAT(
         (
           SELECT b.booking_created_date + INTERVAL ((m.to_Time - ?) * 60) MINUTE_SECOND
           FROM bttimeout AS m
         ),
         '%d/%m/%Y %h:%i'
       )`,
    [minuteWarning]
  );

  const results = [];

  for (const row of rows) {
    const message = `การจองเลขที่ ${row.booking_id} ของท่านจะหมดเวลาชำระเงินในอีก ${minuteWarning} นาที กรุณาดำเนินการชำระเงินด้วยค่ะ`;
    const notificationResult = await sendMemberNotification({
      token: row.token,
      bookingId: row.booking_id,
      message,
    });

    await insertNotificationMaster(connection, {
      bookingId: row.booking_id,
      type: "WARNING",
      message,
      ip,
      host,
    });

    results.push(notificationResult);
  }

  return results;
};

const processTimeoutNotifications = async (connection, ip, host) => {
  const [rows] = await connection.execute(
    `SELECT b.booking_id, b.booking_member_id, m.token, b.booking_created_date
     FROM btbooking AS b
     LEFT JOIN btmember m ON b.booking_member_id = m.mb_Id
     WHERE b.booking_status_id = 2
       AND DATE_FORMAT(NOW(), '%d/%m/%Y %h:%i') = DATE_FORMAT(
         (
           SELECT b.booking_created_date + INTERVAL (m.to_Time * 60) MINUTE_SECOND
           FROM bttimeout AS m
         ),
         '%d/%m/%Y %h:%i'
       )`
  );

  const results = [];

  for (const row of rows) {
    const message = `การจองเลขที่ ${row.booking_id} ของท่านจะหมดเวลาชำระเงินค่ะ`;
    const notificationResult = await sendMemberNotification({
      token: row.token,
      bookingId: row.booking_id,
      message,
    });

    await insertNotificationMaster(connection, {
      bookingId: row.booking_id,
      type: "TIMEOUT",
      message,
      ip,
      host,
    });

    results.push(notificationResult);
  }

  return results;
};

const processInterestNotifications = async (connection, ip, host) => {
  const [rows] = await connection.execute(
    `SELECT ib.mb_id,
            ib.bd_id,
            m.token,
            bd.bd_booking_id,
            bd.bd_booth_id,
            bb.bb_Name,
            bk.booking_id
     FROM interested_booth ib
     INNER JOIN btmember m ON ib.mb_id = m.mb_Id
     INNER JOIN btbooking_detail bd ON ib.bd_id = bd.bd_id
     INNER JOIN btbooking bk ON bd.bd_booking_id = bk.booking_id
     INNER JOIN btbooth bb ON bd.bd_booth_id = bb.bb_Id
     WHERE bk.booking_status_id = 4
       AND CAST(bk.booking_id AS CHAR(50)) NOT IN (
         SELECT *
         FROM (
           SELECT CAST(n.booking_id AS CHAR(50))
           FROM nontification_master n
           WHERE n.nontification_type = 'INTEREST'
         ) AS c
       )
     GROUP BY ib.mb_id,
              ib.bd_id,
              m.token,
              bd.bd_booking_id,
              bd.bd_booth_id,
              bb.bb_Name,
              bk.booking_id`
  );

  const results = [];

  for (const row of rows) {
    const message = `บูธ ${row.bb_Name} ได้มีการหลุดจองจากผู้จองท่านอื่น ท่านสามารถทำการจองบูธนี้ได้ในขณะนี้แล้วค่ะ`;
    const notificationResult = await sendMemberNotification({
      token: row.token,
      bookingId: row.booking_id,
      message,
    });

    await insertNotificationMaster(connection, {
      bookingId: row.bd_booking_id,
      type: "INTEREST",
      message,
      ip,
      host,
    });

    results.push(notificationResult);
  }

  return results;
};

const runCheckTimeout = async ({ databaseProfile } = {}) => {
  const connection = await getPool(databaseProfile).getConnection();
  const host = os.hostname();
  const ip = getLocalIp();

  try {
    const expiredBookingCount = await updateExpiredBookings(connection);
    const errorBookingCount = await updateErroredOrders(connection);
    const clearedFirestoreLocks = await boothLockService.expireOldBoothLocks();
    const warningPayment = await processWarningNotifications(
      connection,
      ip,
      host,
      WARNING_MINUTES
    );
    const warningTimeout = await processTimeoutNotifications(connection, ip, host);
    const warningInterest = await processInterestNotifications(connection, ip, host);

    return {
      status: "success",
      message: "แจ้งเตือน!",
      data: {
        updatedExpiredBookings: expiredBookingCount,
        updatedOrderErrors: errorBookingCount,
        clearedFirestoreLocks,
        "เตือนก่อนหมดเวลาชำระเงิน": warningPayment,
        "เตือนหมดเวลาชำระเงิน": warningTimeout,
        "เตือน Booth หลุดจอง": warningInterest,
      },
    };
  } finally {
    connection.release();
  }
};

module.exports = {
  runCheckTimeout,
};
