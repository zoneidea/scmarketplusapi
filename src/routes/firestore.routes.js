const express = require("express");
const firestoreService = require("../services/firestore.service");

const router = express.Router();

router.patch("/:collection/:documentId", async (req, res, next) => {
  try {
    const result = await firestoreService.updateDocument(
      req.params.collection,
      req.params.documentId,
      req.body
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
