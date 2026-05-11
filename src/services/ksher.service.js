const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const axios = require("axios");

const DEFAULT_GATEWAY_BASE_URL = "https://gateway.ksher.com/api";
const DEFAULT_KSHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL7955OCuN4I8eYNL/mixZWIXIgCvIVE
ivlxqdpiHPcOLdQ2RPSx/pORpsUu/E9wz0mYS2PY7hNc2mBgBOQT+wUCAwEAAQ==
-----END PUBLIC KEY-----`;
const privateKeyCache = new Map();

const compactString = (value) => (value === undefined || value === null ? "" : String(value));

const getGatewayBaseUrl = () => {
  return (process.env.KSHER_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
};

const getKeyName = (appid) => {
  return `Mch${String(appid || "").replace(/^mch/i, "")}_PrivateKey.pem`;
};

const isPem = (value) => {
  return typeof value === "string" && value.includes("BEGIN RSA PRIVATE KEY");
};

const normalizePem = (value) => {
  return isPem(value) ? value.replace(/\\n/g, "\n") : "";
};

const getPrivateKeyCandidates = (keyName) => {
  const keyDir = process.env.KSHER_PRIVATE_KEY_DIR || "./ksher_pay";
  const candidates = [];

  if (process.env.KSHER_PRIVATE_KEY_PATH) {
    candidates.push(path.resolve(process.cwd(), process.env.KSHER_PRIVATE_KEY_PATH));
  }

  candidates.push(path.resolve(process.cwd(), keyDir, keyName));

  return [...new Set(candidates)];
};

const readPrivateKey = (appid, databasePrivateKey = "") => {
  const keyName = getKeyName(appid);
  const candidates = getPrivateKeyCandidates(keyName);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    if (!privateKeyCache.has(candidate)) {
      privateKeyCache.set(candidate, fs.readFileSync(candidate, "utf8"));
    }

    return privateKeyCache.get(candidate);
  }

  const keyFromDatabase = normalizePem(databasePrivateKey);
  if (keyFromDatabase) {
    return keyFromDatabase;
  }

  throw new Error(
    `Ksher private key not found for ${appid} (${keyName}). Searched: ${candidates.join(", ")}`
  );
};

const generateNonce = () => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(16);

  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
};

const getTimeStamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
};

const buildSignSource = (params) => {
  return Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}=${compactString(params[key])}`)
    .join("");
};

const signParams = (params, privateKey) => {
  const signer = crypto.createSign("RSA-MD5");
  signer.update(buildSignSource(params), "utf8");
  signer.end();

  return signer.sign(privateKey, "hex");
};

const getKsherPublicKey = () => {
  return (process.env.KSHER_PUBLIC_KEY || DEFAULT_KSHER_PUBLIC_KEY).replace(/\\n/g, "\n");
};

const verifyParams = (params, sign) => {
  const verifier = crypto.createVerify("RSA-MD5");
  verifier.update(buildSignSource(params), "utf8");
  verifier.end();

  return verifier.verify(getKsherPublicKey(), Buffer.from(sign, "hex"));
};

const buildVerifyFailedResponse = (timeStamp) => {
  return {
    code: 0,
    data: {
      err_code: "VERIFY_KSHER_SIGN_FAIL",
      err_msg: "verify signature failed",
      result: "FAIL",
    },
    msg: "ok",
    sign: "",
    status_code: "",
    status_msg: "",
    time_stamp: timeStamp,
    version: "3.0.0",
  };
};

const gatewayPay = async ({ appid, privateKey, data }) => {
  const requestData = {
    ...data,
    appid,
    nonce_str: generateNonce(),
    time_stamp: getTimeStamp(),
  };

  requestData.sign = signParams(requestData, privateKey);

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(requestData)) {
    body.append(key, compactString(value));
  }

  const response = await axios.post(`${getGatewayBaseUrl()}/gateway_pay`, body.toString(), {
    timeout: Number(process.env.HTTP_TIMEOUT_MS || 10000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  let responseData = response.data;

  if (
    responseData &&
    typeof responseData === "object" &&
    Number(responseData.code) === 0 &&
    responseData.data &&
    responseData.sign &&
    !verifyParams(responseData.data, responseData.sign)
  ) {
    responseData = buildVerifyFailedResponse(requestData.time_stamp);
  }

  return {
    data: responseData,
    raw: typeof responseData === "string" ? responseData : JSON.stringify(responseData),
    signedRequestData: requestData,
  };
};

module.exports = {
  gatewayPay,
  getKeyName,
  readPrivateKey,
  signParams,
  verifyParams,
};
