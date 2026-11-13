'use strict';

const mongoose = require('mongoose');

/**
 * An Ask AI thread: about one source (`scope: 'source'`) or the user's whole
 * library (`scope: 'library'`). Messages live in the Message collection.
 */
const conversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scope: { type: String, enum: ['source', 'library'], required: true },
    source: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Source',
      default: null,
      required() {
        return this.scope === 'source';
      },
    },
    title: { type: String, default: 'New conversation', maxlength: 120 },
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        if (ret.source && ret.source.toString && !ret.source.id) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

conversationSchema.index({ user: 1, updatedAt: -1 });
conversationSchema.index({ user: 1, source: 1, updatedAt: -1 });

module.exports = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
