const axios = require("axios");

const httpClient = axios.create({
  baseURL: process.env.EXTERNAL_API_BASE_URL || undefined,
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 10000),
  headers: {
    "Content-Type": "application/json",
  },
});

module.exports = httpClient;
