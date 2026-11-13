'use strict';

const mongoose = require('mongoose');

/**
 * Timed transcript of a video source, one per source.
 *
 * Segments are compact ({ start, end, text, speaker }) and stored in video
 * order. A one-hour video is roughly 100 KB, far below MongoDB's 16 MB
 * document limit even for the longest allowed recordings.
 *
 * `completedWindows` makes transcription resumable: each window is appended
 * atomically together with its index, so a retried job skips finished windows
 * and can never append a window twice.
 */
const segmentSchema = new mongoose.Schema(
  {
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    text: { type: String, required: true, maxlength: 2000 },
    speaker: { type: String, default: null, maxlength: 40 },
  },
  { _id: false }
);

const transcriptSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },

    // Where the audio came from and who transcribed it.
    origin: { type: String, enum: ['youtube_video', 'uploaded_video'], required: true },
    provider: { type: String, default: null, maxlength: 40 },
    model: { type: String, default: null, maxlength: 100 },
    language: { type: String, default: null, maxlength: 35 },

    segments: { type: [segmentSchema], default: [] },
    completedWindows: { type: [Number], default: [] },
    totalWindows: { type: Number, default: null },

    durationSeconds: { type: Number, default: null },
    wordCount: { type: Number, default: 0 },
    hasSpeakerLabels: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        delete ret.completedWindows;
        if (ret.source) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

transcriptSchema.index({ source: 1 }, { unique: true });
transcriptSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Transcript || mongoose.model('Transcript', transcriptSchema);
