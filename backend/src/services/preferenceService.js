'use strict';

const UserPreference = require('../models/UserPreference');

const DEFAULTS = Object.freeze({
  summaryStyle: 'standard',
  quizDifficulty: 'medium',
  quizQuestionCount: 10,
  quizQuestionTypes: ['multiple_choice', 'true_false', 'short_answer'],
  flashcardCount: 20,
});

async function getPreferences({ userId }) {
  const prefs = await UserPreference.findOne({ user: userId });
  return prefs ? { ...DEFAULTS, ...prefs.toJSON() } : { ...DEFAULTS };
}

async function updatePreferences({ userId, changes }) {
  const prefs = await UserPreference.findOneAndUpdate(
    { user: userId },
    { $set: changes, $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return { ...DEFAULTS, ...prefs.toJSON() };
}

module.exports = { getPreferences, updatePreferences, DEFAULTS };
