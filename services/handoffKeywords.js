const HandoffKeyword = require("../models/HandoffKeyword");
const {
  DEFAULT_CUSTOM_HANDOFF_KEYWORDS,
  DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION,
} = require("./handoffDetection");

const getCustomHandoffKeywords = async (restaurantId) => {
  let doc = await HandoffKeyword.findOne({ restaurantId }).lean();
  if (!doc) {
    try {
      doc = await HandoffKeyword.create({
        restaurantId,
        words: DEFAULT_CUSTOM_HANDOFF_KEYWORDS,
        defaultsVersion: DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION,
      });
      return doc.words;
    } catch (error) {
      if (error.code !== 11000) throw error;
      doc = await HandoffKeyword.findOne({ restaurantId }).lean();
    }
  }

  if ((doc.defaultsVersion || 0) < DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION) {
    await HandoffKeyword.updateOne(
      {
        _id: doc._id,
        $or: [
          { defaultsVersion: { $lt: DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION } },
          { defaultsVersion: { $exists: false } },
        ],
      },
      {
        $addToSet: { words: { $each: DEFAULT_CUSTOM_HANDOFF_KEYWORDS } },
        $set: { defaultsVersion: DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION },
      }
    );
    doc = await HandoffKeyword.findOne({ restaurantId }).select("words").lean();
  }

  return doc?.words || [];
};

module.exports = { getCustomHandoffKeywords };
