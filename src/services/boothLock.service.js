const admin = require("../config/firebase");

const COLLECTION = "boothLocks";

const buildDocId = (boothId, date) => `${boothId}_${normalizeDate(date)}`;

const normalizeDate = (date) => {
  if (date instanceof Date) {
    return date.toISOString().slice(0, 10);
  }

  return String(date);
};

const deleteLock = async (boothId, date) => {
  const docId = buildDocId(boothId, date);
  await admin.firestore().collection(COLLECTION).doc(docId).delete();

  return {
    success: true,
    docId,
  };
};

const updateLock = async (boothId, date, status) => {
  const docId = buildDocId(boothId, date);
  const ref = admin.firestore().collection(COLLECTION).doc(docId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    return {
      success: false,
      message: `Not found: ${docId}`,
    };
  }

  const confirmed = !(status === "expired" || status === "pending");

  await ref.update({
    confirmed,
    status,
  });

  return {
    success: true,
    docId,
  };
};

const expireOldBoothLocks = async () => {
  const threshold = new Date(Date.now() - 15 * 60 * 1000);
  const snapshot = await admin
    .firestore()
    .collection(COLLECTION)
    .where("confirmed", "==", false)
    .where("status", "==", "pending")
    .where("lockedAt", "<", threshold)
    .get();

  if (snapshot.empty) {
    return 0;
  }

  const batch = admin.firestore().batch();
  snapshot.docs.forEach((doc) => {
    batch.update(doc.ref, { status: "expired" });
  });

  await batch.commit();

  return snapshot.size;
};

module.exports = {
  deleteLock,
  updateLock,
  expireOldBoothLocks,
};
