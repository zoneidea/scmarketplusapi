const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const DEFAULT_SERVICE_ACCOUNT_PATH = path.resolve(
  process.cwd(),
  "sc-market-plus-firebase.json"
);

const parseServiceAccount = () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return null;
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return serviceAccount;
};

const createCredential = () => {
  const serviceAccount = parseServiceAccount();

  if (serviceAccount) {
    return admin.credential.cert(serviceAccount);
  }

  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : DEFAULT_SERVICE_ACCOUNT_PATH;

  if (fs.existsSync(serviceAccountPath)) {
    return admin.credential.cert(require(serviceAccountPath));
  }

  return admin.credential.applicationDefault();
};

if (!admin.apps.length) {
  const options = {
    credential: createCredential(),
  };

  if (process.env.FIREBASE_DATABASE_URL) {
    options.databaseURL = process.env.FIREBASE_DATABASE_URL;
  }

  admin.initializeApp(options);
}

module.exports = admin;
