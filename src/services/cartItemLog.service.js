const fs = require("fs/promises");
const path = require("path");

const LOG_DIRECTORY = path.resolve(process.env.LOG_DIRECTORY || "logs");
const LOG_FILE = path.join(LOG_DIRECTORY, "get-cart-item.log");
let directoryPromise;

/** สร้างโฟลเดอร์ log เพียงครั้งเดียวและนำ Promise เดิมกลับมาใช้ซ้ำ */
const ensureLogDirectory = () => {
  if (!directoryPromise) {
    directoryPromise = fs.mkdir(LOG_DIRECTORY, { recursive: true });
  }

  return directoryPromise;
};

/** บันทึก request, response และ error เป็น JSON Lines เพื่อค้นหาและนำไปวิเคราะห์ได้ง่าย */
const writeCartItemLog = async (event, details = {}) => {
  try {
    await ensureLogDirectory();
    await fs.appendFile(
      LOG_FILE,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
      "utf8"
    );
  } catch (error) {
    console.error(`GetCartItem file log failed: ${error.message}`);
  }
};

module.exports = {
  writeCartItemLog,
};
