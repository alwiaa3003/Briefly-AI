'use strict';

const mongoose = require('mongoose');

const citationSchema = new mongoose.Schema(
  {
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    sourceTitle: { type: String, default: null, maxlength: 300 },
    sourceKind: { type: String, default: null, maxlength: 20 },
    chunk: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentChunk', default: null },
    label: { type: String, default: null, maxlength: 120 },
    page: { type: Number, default: null },
    section: { type: String, default: null, maxlength: 300 },
    startSeconds: { type: Number, default: null },
    snippet: { type: String, default: null, maxlength: 400 },
  },
  { _id: false }
);

/** One turn of an Ask AI conversation. Assistant turns carry validated citations. */
const messageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 8000 },
    // Client-generated id of a question: re-sending it returns the stored answer (no second AI call).
    clientRequestId: { type: String, default: undefined, maxlength: 64 },
    // Assistant only: how well the retrieved content supports the answer.
    support: { type: String, enum: ['supported', 'partial', 'not_found', null], default: null },
    citations: { type: [citationSchema], default: [] },
    followUps: { type: [String], default: [] },
    model: { type: String, default: null, maxlength: 100 },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        delete ret.usage;
        delete ret.clientRequestId;
        ret.conversation = ret.conversation?.toString();
        ret.citations = (ret.citations || []).map((c) => ({
          ...c,
          source: c.source?.toString(),
          chunk: c.chunk ? c.chunk.toString() : null,
        }));
        return ret;
      },
    },
  }
);

messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index(
  { conversation: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);
messageSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);
