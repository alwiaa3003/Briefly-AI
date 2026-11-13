"""Retrieval-augmented answers ("Ask AI").

The Node backend retrieves the most relevant chunks (filtered by owner and
source) and sends only those, plus a bounded conversation history. The model
must answer from the chunks only and cite chunk ids; citations are validated,
and an answer cannot be "supported" without at least one valid citation.
"""

from __future__ import annotations

from app.core.config import Settings
from app.processors.grounding import INJECTION_RULE, generate_validated, neutralize, render_chunks, wrap
from app.schemas.ai import Answer, AnswerRequest, AnswerResult, GeminiAnswer
from app.services.gemini import StructuredGenerator

PROMPT_VERSION = "rag-answer-v1"

INSTRUCTION = f"""You are Briefly's study assistant. You answer questions about the user's own saved
content (articles, video transcripts and documents).

Rules you must always follow:
1. {INJECTION_RULE}
2. Answer ONLY from the provided context chunks. Do not use outside knowledge, and
   do not guess. If the context does not contain the answer, say so plainly (for
   example: "The source doesn't say.") and set support to "not_found". Never
   invent facts, numbers, quotes, page numbers or timestamps.
3. support: "supported" if the chunks fully answer the question, "partial" if they
   answer only part of it (say which part is missing), "not_found" if they don't.
4. citations: the ids of the chunks you actually used (e.g. "c3"). Every factual
   statement must be backed by a cited chunk. Cite nothing if support is "not_found".
5. Use the conversation history only to understand follow-up questions (what
   "it" or "that" refers to). Facts must still come from the chunks.
6. Be concise and specific: 1-3 short paragraphs or a short list. Write in the
   language of the user's question.
7. follow_up_questions: up to 3 short questions the user could ask next that the
   context can answer. Empty list if none.
"""


def _prepare(data: dict) -> dict:
    support = str(data.get("support", "")).strip().lower()
    data["support"] = support if support in ("supported", "partial", "not_found") else "partial"
    data["follow_up_questions"] = [
        q for q in data.get("follow_up_questions") or [] if isinstance(q, str) and q.strip()
    ][:3]
    return data


async def answer_question(request: AnswerRequest, settings: Settings, generator: StructuredGenerator) -> AnswerResult:
    context, included = render_chunks(request.chunks, settings.rag_max_context_chars)
    allowed = {c.id for c in included}

    history = "\n".join(f"{turn.role.upper()}: {neutralize(turn.content)}" for turn in request.history[-12:])
    scope = (
        f'The user is asking about one source: "{neutralize(request.scope_title)}".'
        if request.scope == "source" and request.scope_title
        else "The user is asking about their whole library; chunks may come from different sources."
    )
    prompt = "\n\n".join(
        part
        for part in (
            scope,
            f"Conversation so far:\n{history}" if history else "",
            wrap(context) if context else "<<<CONTEXT_START>>>\n(no relevant content was found)\n<<<CONTEXT_END>>>",
            f"Question: {neutralize(request.question)}",
        )
        if part
    )

    answer, dropped, usage = await generate_validated(
        generator,
        instruction=INSTRUCTION,
        prompt=prompt,
        schema=GeminiAnswer,
        model=Answer,
        allowed_refs=allowed,
        prepare=_prepare,
        max_output_tokens=4096,
    )
    # Grounding rules enforced after validation.
    if answer.support == "not_found":
        answer.citations = []
    elif not answer.citations:
        answer.support = "partial" if allowed else "not_found"
    return AnswerResult(answer=answer, model=generator.model, citations_discarded=dropped, usage=usage)
