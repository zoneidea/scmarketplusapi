const { getPool } = require("../config/mysql");

/** แปลงค่าจากฐานข้อมูลเป็น string เพื่อให้ response ตรงกับ PHP เดิม */
const toResponseString = (value) => {
  return value === undefined || value === null ? "" : String(value).trim();
};

/** แปลงค่าฐานข้อมูลแบบ raw เหมือน result_array ของ PHP โดยคง null เอาไว้ */
const toPhpDatabaseValue = (value) => {
  return value === undefined || value === null ? null : String(value);
};

/** สร้าง placeholder สำหรับคำสั่ง SQL IN โดยไม่ต่อค่าจากผู้ใช้ลงใน SQL โดยตรง */
const createPlaceholders = (values) => values.map(() => "?").join(", ");

/** สร้าง key สำหรับจัดกลุ่มข้อมูลตาม booking และวันที่ */
const createBookingDateKey = (bookingId, bookingDate) => {
  return `${toResponseString(bookingId)}\u0000${toResponseString(bookingDate)}`;
};

/** จัดกลุ่มแถวจากฐานข้อมูลเป็น Map เพื่อลดการค้นหาซ้ำระหว่างประกอบ response */
const groupRows = (rows, getKey, mapRow) => {
  const groupedRows = new Map();

  for (const row of rows) {
    const key = getKey(row);
    const currentRows = groupedRows.get(key) || [];
    currentRows.push(mapRow(row));
    groupedRows.set(key, currentRows);
  }

  return groupedRows;
};

/** ดึงรายการ booking ในตะกร้าที่รอชำระเงินของสมาชิก */
const fetchBookings = async (pool, memberId) => {
  const [rows] = await pool.execute(
    `SELECT b.booking_id,
            bu.bu_Name,
            m.mi_Name,
            DATE_FORMAT(b.booking_created_date, '%Y-%m-%d %H:%i:%s') AS booking_created_date,
            b.booking_status_id,
            bs.status_name
     FROM btbooking AS b
     LEFT JOIN btbu AS bu ON b.booking_building_id = bu.bu_Id
     LEFT JOIN btmarketinformation AS m ON b.booking_market_id = m.mi_Id
     LEFT JOIN btstatus AS bs ON bs.status_id = b.booking_status_id
     WHERE b.booking_member_id = ?
       AND b.booking_status_id IN (2, 5)`,
    [memberId]
  );

  return rows;
};

/** ดึงค่าปรับหรือค่าเสียหายที่ยังรอชำระของสมาชิก */
const fetchCharges = async (pool, memberId) => {
  const [rows] = await pool.execute(
    `SELECT bd.bd_booking_id AS booking_id,
            bb.bb_Name,
            DATE_FORMAT(bd.bd_booking_date, '%Y-%m-%d') AS bd_booking_date,
            cd.keyId,
            cd.mistake_note,
            cd.accessories_price,
            cd.charge_price,
            cd.total_price,
            cd.status_price
     FROM audit_checker_details AS cd
     LEFT JOIN btbooking_detail AS bd ON cd.bd_id = bd.bd_id
     LEFT JOIN btbooking AS bk ON bd.bd_booking_id = bk.booking_id
     LEFT JOIN btbooth AS bb ON bd.bd_booth_id = bb.bb_Id
     WHERE cd.audit_status_id = 'F'
       AND cd.status_price IN ('Pending', 'Waiting')
       AND bk.booking_member_id = ?`,
    [memberId]
  );

  return rows;
};

/** ดึงรายละเอียดบูธทั้งหมดของหลาย booking ใน query เดียว */
const fetchBookingDetails = async (pool, bookingIds) => {
  if (bookingIds.length === 0) {
    return [];
  }

  const [rows] = await pool.execute(
    `SELECT bd.bd_booking_id AS booking_id,
            DATE_FORMAT(bd.bd_booking_date, '%Y-%m-%d') AS bd_booking_date,
            bd.bd_booth_id,
            bb.bb_Name,
            bb.bb_Price,
            CONCAT(
              FLOOR(TIMESTAMPDIFF(MINUTE, bd.bd_created_date, NOW()) / 60),
              ' ชั่วโมง ',
              MOD(TIMESTAMPDIFF(MINUTE, bd.bd_created_date, NOW()), 60),
              ' นาที'
            ) AS Timelate
     FROM btbooking_detail AS bd
     LEFT JOIN btbooth AS bb ON bd.bd_booth_id = bb.bb_Id
     WHERE bd.bd_booking_id IN (${createPlaceholders(bookingIds)})`,
    bookingIds
  );

  return rows;
};

/** ดึงสินค้าของหลาย booking ใน query เดียวแทนการ query ซ้ำทีละรายการ */
const fetchBookingProducts = async (pool, bookingIds) => {
  if (bookingIds.length === 0) {
    return [];
  }

  const [rows] = await pool.execute(
    `SELECT pb.booking_id,
            DATE_FORMAT(pb.product_booking_date, '%Y-%m-%d') AS booking_date,
            p.pd_Id,
            p.pd_Name
     FROM btproduct_booking AS pb
     LEFT JOIN btproduct AS p ON pb.product_id = p.pd_Id
     WHERE pb.booking_id IN (${createPlaceholders(bookingIds)})`,
    bookingIds
  );

  return rows;
};

/** ดึงอุปกรณ์เสริมของหลาย booking ใน query เดียวแทนการ query ซ้ำทีละรายการ */
const fetchBookingAccessories = async (pool, bookingIds) => {
  if (bookingIds.length === 0) {
    return [];
  }

  const [rows] = await pool.execute(
    `SELECT ba.bd_booking_id AS booking_id,
            DATE_FORMAT(ba.bd_booking_date, '%Y-%m-%d') AS booking_date,
            ba.qty,
            bn.at_Name,
            bn.at_Price
     FROM btbooking_detail_another AS ba
     LEFT JOIN btanother AS bn ON ba.at_id = bn.at_id
     WHERE ba.bd_booking_id IN (${createPlaceholders(bookingIds)})`,
    bookingIds
  );

  return rows;
};

/** ดึงรายละเอียดค่าอุปกรณ์ของหลาย charge ด้วย parameter binding */
const fetchChargeAccessories = async (pool, keyIds) => {
  if (keyIds.length === 0) {
    return [];
  }

  const [rows] = await pool.execute(
    `SELECT acd.keyId,
            ac.accessories_name,
            acd.accessories_id,
            acd.qty,
            acd.price
     FROM audit_checker_details_accessories AS acd
     INNER JOIN accessories_charge AS ac ON acd.accessories_id = ac.accessories_id
     WHERE acd.keyId IN (${createPlaceholders(keyIds)})`,
    keyIds
  );

  return rows;
};

/** ประกอบข้อมูล booking กับรายละเอียด สินค้า และอุปกรณ์ โดยใช้ Map เพื่อค้นหาแบบ O(1) */
const buildCart = (bookings, details, products, accessories) => {
  const productsByBookingDate = groupRows(
    products,
    (row) => createBookingDateKey(row.booking_id, row.booking_date),
    (row) => ({
      pd_Id: toResponseString(row.pd_Id),
      pd_Name: toResponseString(row.pd_Name),
    })
  );
  const accessoriesByBookingDate = groupRows(
    accessories,
    (row) => createBookingDateKey(row.booking_id, row.booking_date),
    (row) => ({
      at_Name: toResponseString(row.at_Name),
      at_Price: toResponseString(row.at_Price),
      qty: toResponseString(row.qty),
    })
  );
  const detailsByBooking = groupRows(
    details,
    (row) => toResponseString(row.booking_id),
    (row) => {
      const bookingDateKey = createBookingDateKey(row.booking_id, row.bd_booking_date);

      return {
        bd_booking_date: toResponseString(row.bd_booking_date),
        bd_booth_id: toResponseString(row.bd_booth_id),
        bb_Name: toResponseString(row.bb_Name),
        bb_Price: toResponseString(row.bb_Price),
        bb_TimeLate: toResponseString(row.Timelate),
        product: productsByBookingDate.get(bookingDateKey) || [],
        accessory: accessoriesByBookingDate.get(bookingDateKey) || [],
      };
    }
  );

  return bookings.map((booking) => ({
    booking_id: toResponseString(booking.booking_id),
    bu_Name: toResponseString(booking.bu_Name),
    mi_Name: toResponseString(booking.mi_Name),
    create_date: toResponseString(booking.booking_created_date),
    status_id: toResponseString(booking.booking_status_id),
    status_name: toResponseString(booking.status_name),
    checked: false,
    booking_detail: detailsByBooking.get(toResponseString(booking.booking_id)) || [],
  }));
};

/** ประกอบรายการ charge และตัดรายการที่ยอดรวมไม่มากกว่า 0 ตามเจตนาของ PHP เดิม */
const buildCharges = (charges, chargeAccessories) => {
  const accessoriesByKeyId = groupRows(
    chargeAccessories,
    (row) => toResponseString(row.keyId),
    (row) => ({
      accessories_name: toPhpDatabaseValue(row.accessories_name),
      accessories_id: toPhpDatabaseValue(row.accessories_id),
      qty: toPhpDatabaseValue(row.qty),
      price: toPhpDatabaseValue(row.price),
    })
  );

  return charges
    .filter((charge) => Number.parseInt(String(charge.total_price), 10) > 0)
    .map((charge) => ({
      booking_id: toResponseString(charge.booking_id),
      BoothName: toResponseString(charge.bb_Name),
      booking_date: toResponseString(charge.bd_booking_date),
      total_price: toResponseString(charge.total_price),
      mistake_note: toResponseString(charge.mistake_note),
      accessories_price: toResponseString(charge.accessories_price),
      charge_price: toResponseString(charge.charge_price),
      status_price: toResponseString(charge.status_price),
      keyId: toResponseString(charge.keyId),
      checked: false,
      accessories_price_details:
        accessoriesByKeyId.get(toResponseString(charge.keyId)) || [],
    }));
};

/** ดึงและประกอบข้อมูลตะกร้าทั้งหมด โดยจำกัดจำนวน query คงที่ไม่โตตามจำนวนรายการ */
const getCartItems = async ({ memberId, databaseProfile } = {}) => {
  const pool = getPool(databaseProfile);
  const [bookings, charges] = await Promise.all([
    fetchBookings(pool, memberId),
    fetchCharges(pool, memberId),
  ]);
  const bookingIds = [
    ...new Set(bookings.map((row) => row.booking_id).filter((value) => value != null)),
  ];
  const keyIds = [
    ...new Set(charges.map((row) => row.keyId).filter((value) => value != null)),
  ];
  const [details, products, accessories, chargeAccessories] = await Promise.all([
    fetchBookingDetails(pool, bookingIds),
    fetchBookingProducts(pool, bookingIds),
    fetchBookingAccessories(pool, bookingIds),
    fetchChargeAccessories(pool, keyIds),
  ]);

  return {
    status: "success",
    message: "",
    data: {
      Cart: buildCart(bookings, details, products, accessories),
      Charge: buildCharges(charges, chargeAccessories),
    },
  };
};

module.exports = {
  getCartItems,
};
