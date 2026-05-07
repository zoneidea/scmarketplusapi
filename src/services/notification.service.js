const admin = require("../config/firebase");

const sendNotification = async ({ token, topic, title, body, data = {}, notification }) => {
  if (!token && !topic) {
    const error = new Error("token or topic is required");
    error.statusCode = 400;
    throw error;
  }

  const message = {
    notification: notification || { title, body },
    data: normalizeData(data),
  };

  if (token) {
    message.token = token;
  }

  if (topic) {
    message.topic = topic;
  }

  const messageId = await admin.messaging().send(message);

  return {
    messageId,
  };
};

const normalizeData = (data) => {
  return Object.entries(data).reduce((result, [key, value]) => {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
    return result;
  }, {});
};

module.exports = {
  sendNotification,
};
