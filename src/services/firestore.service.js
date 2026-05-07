const admin = require("../config/firebase");

const updateDocument = async (collection, documentId, payload) => {
  if (!collection || !documentId) {
    const error = new Error("collection and documentId are required");
    error.statusCode = 400;
    throw error;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("request body must be an object");
    error.statusCode = 400;
    throw error;
  }

  const ref = admin.firestore().collection(collection).doc(documentId);
  await ref.set(
    {
      ...payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const snapshot = await ref.get();

  return {
    id: snapshot.id,
    data: snapshot.data(),
  };
};

module.exports = {
  updateDocument,
};
