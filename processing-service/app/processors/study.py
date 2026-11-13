"""Study tools: notes, quizzes, flashcards and alternative summary styles.

Input is a bounded, representative selection of the source's chunks (chosen by
the Node backend) plus the existing summary overview, never the whole raw
source. Every reference must be a supplied chunk id. Anything the model adds
from general knowledge is only allowed in StudyNotes.external_knowledge, which
the UI shows separately and labels.
"""

from __future__ import annotations

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.processors.grounding import INJECTION_RULE, generate_validated, neutralize, render_chunks, wrap
from app.schemas.ai import (
    FlashcardRequest,
    Flashcards,
    FlashcardsResult,
    GeminiFlashcards,
    GeminiNotes,
    GeminiQuiz,
    GeminiStyledSummary,
    NotesResult,
    Quiz,
    QuizRequest,
    QuizResult,
    RestyleRequest,
    RestyleResult,
    StudyNotes,
    StudyRequest,
    StyledSummary,
)
from app.services.gemini import StructuredGenerator

PROMPT_VERSION = "study-v1"

_BASE = f"""You are Briefly's study-material generator.

Rules you must always follow:
1. {INJECTION_RULE}
2. Base everything on the provided content. Do not invent facts, numbers, names,
   formulas or examples that are not in it.
3. refs: list the ids of the chunks (e.g. "c4") that support each item.
4. Write in the same language as the content. Be precise and avoid filler.
"""

NOTES_INSTRUCTION = (
    _BASE
    + """
Create structured study notes:
- title, overview (a 3-5 sentence topic overview)
- key_concepts: the central ideas, each explained clearly
- definitions: terms the content defines (empty if none)
- key_facts: important facts, figures and dates, copied exactly
- examples: concrete examples the content gives (empty if none)
- formulas: formulas, code, algorithms or technical details exactly as given (empty if none)
- revision_points: 5-12 short points to remember for revision
- external_knowledge: ONLY if a short piece of background not found in the
  content is genuinely needed to understand it, state it here (max 3 items);
  otherwise leave empty. Never mix outside knowledge into the other fields.
"""
)

QUIZ_INSTRUCTION = (
    _BASE
    + """
Create a quiz that tests understanding of THIS content (not general knowledge).
For each question set type to one of the requested types:
- multiple_choice: 4 plausible options, exactly one correct; correct_option is its index (0-based).
  Use correct_boolean false and accepted_answers [] (unused).
- true_false: a statement; correct_boolean is the truth value. Use options [], correct_option 0.
- short_answer: a question with a short factual answer; accepted_answers lists 1-4
  acceptable short answers (key words or phrases). Use options [], correct_option 0, correct_boolean false.
explanation: why the answer is correct, based on the content. Mix the requested
types, cover different parts of the content, and avoid trick questions.
Difficulty: easy = recall of key facts; medium = understanding and relationships;
hard = application, comparison and subtle details.
"""
)

FLASHCARD_INSTRUCTION = (
    _BASE
    + """
Create revision flashcards. front: a question, term or prompt (short).
back: the answer or explanation (1-3 sentences). Cover the most important
concepts, definitions and facts without duplicates.
"""
)

STYLE_GUIDES = {
    "concise": "Very short: an overview of 2 sentences and 2-3 brief sections. Only the essentials.",
    "detailed": "Thorough: a full overview and 4-8 sections covering all major points, arguments and evidence.",
    "bullet_points": "Each section's content is a bullet list ('- ' per line) of crisp points; no prose paragraphs.",
    "academic": (
        "Formal academic register: precise terminology, structured like an abstract plus thematic sections, "
        "with hedged claims."
    ),
    "beginner": (
        "For a newcomer: plain language, short sentences, explain every technical term when first used, "
        "use the content's own examples."
    ),
    "technical": (
        "For experts: keep technical terms, mechanisms, parameters, numbers and methods; skip basic explanations."
    ),
    "exam_revision": (
        "For exam revision: sections per topic with what to remember, key definitions and likely exam points; "
        "key_points are memorisable facts."
    ),
}

STYLE_INSTRUCTION = (
    _BASE
    + """
Rewrite the summary of this content in the requested style. The facts must stay
exactly the same as in the content; only the presentation changes.
Return title, overview, sections (heading + content) and key_points (3-10).
"""
)


def _allowed(request: StudyRequest, settings: Settings) -> tuple[str, set[str], int]:
    context, included = render_chunks(request.chunks, settings.study_max_input_chars)
    return context, {c.id for c in included}, len(context)


def _header(request: StudyRequest) -> str:
    lines = [
        f"Source: {neutralize(request.title)}" if request.title else "Source: (untitled)",
        f"Type: {request.source_kind}",
    ]
    if request.summary_overview:
        lines.append(f"Existing summary overview: {neutralize(request.summary_overview)}")
    return "\n".join(lines)


async def generate_notes(request: StudyRequest, settings: Settings, generator: StructuredGenerator) -> NotesResult:
    context, allowed, size = _allowed(request, settings)
    notes, dropped, usage = await generate_validated(
        generator,
        instruction=NOTES_INSTRUCTION,
        prompt=f"{_header(request)}\n\n{wrap(context)}",
        schema=GeminiNotes,
        model=StudyNotes,
        allowed_refs=allowed,
        max_output_tokens=16384,
    )
    return NotesResult(
        notes=notes,
        model=generator.model,
        prompt_version=PROMPT_VERSION,
        refs_discarded=dropped,
        input_characters=size,
        usage=usage,
    )


def _min_questions(count: int) -> int:
    return max(1, (count + 1) // 2)


def _prepare_quiz(types: list[str], count: int):
    def prepare(data: dict) -> dict:
        questions = []
        for item in data.get("questions") or []:
            if isinstance(item, dict) and item.get("type") in types:
                questions.append(item)
        if len(questions) < _min_questions(count):
            raise ValueError("too few valid quiz questions")
        for index, item in enumerate(questions[:count]):
            item["id"] = f"q{index + 1}"
        data["questions"] = questions[:count]
        return data

    return prepare


async def generate_quiz(request: QuizRequest, settings: Settings, generator: StructuredGenerator) -> QuizResult:
    context, allowed, size = _allowed(request, settings)
    prompt = (
        f"{_header(request)}\nCreate exactly {request.count} questions. Difficulty: {request.difficulty}. "
        f"Allowed types: {', '.join(request.types)}.\n\n{wrap(context)}"
    )
    quiz, dropped, usage = await generate_validated(
        generator,
        instruction=QUIZ_INSTRUCTION,
        prompt=prompt,
        schema=GeminiQuiz,
        model=Quiz,
        allowed_refs=allowed,
        prepare=_prepare_quiz(request.types, request.count),
        max_output_tokens=16384,
    )
    if len(quiz.questions) < _min_questions(request.count):  # e.g. questions removed during validation
        raise ServiceError(502, "AI_INVALID_RESPONSE", "Too few valid quiz questions were generated.", retryable=False)
    return QuizResult(
        quiz=quiz,
        model=generator.model,
        prompt_version=PROMPT_VERSION,
        refs_discarded=dropped,
        input_characters=size,
        usage=usage,
    )


def _prepare_cards(count: int):
    def prepare(data: dict) -> dict:
        cards, seen = [], set()
        for item in data.get("cards") or []:
            if not isinstance(item, dict):
                continue
            key = str(item.get("front", "")).strip().lower()
            if key and key not in seen:
                seen.add(key)
                cards.append(item)
        for index, item in enumerate(cards[:count]):
            item["id"] = f"f{index + 1}"
        data["cards"] = cards[:count]
        return data

    return prepare


async def generate_flashcards(
    request: FlashcardRequest, settings: Settings, generator: StructuredGenerator
) -> FlashcardsResult:
    context, allowed, size = _allowed(request, settings)
    cards, dropped, usage = await generate_validated(
        generator,
        instruction=FLASHCARD_INSTRUCTION,
        prompt=f"{_header(request)}\nCreate up to {request.count} flashcards.\n\n{wrap(context)}",
        schema=GeminiFlashcards,
        model=Flashcards,
        allowed_refs=allowed,
        prepare=_prepare_cards(request.count),
        max_output_tokens=16384,
    )
    return FlashcardsResult(
        flashcards=cards,
        model=generator.model,
        prompt_version=PROMPT_VERSION,
        refs_discarded=dropped,
        input_characters=size,
        usage=usage,
    )


async def restyle_summary(request: RestyleRequest, settings: Settings, generator: StructuredGenerator) -> RestyleResult:
    context, allowed, size = _allowed(request, settings)
    summary, dropped, usage = await generate_validated(
        generator,
        instruction=STYLE_INSTRUCTION,
        prompt=(
            f"{_header(request)}\nRequested style: {request.style} - {STYLE_GUIDES[request.style]}\n\n{wrap(context)}"
        ),
        schema=GeminiStyledSummary,
        model=StyledSummary,
        allowed_refs=allowed,
        max_output_tokens=16384,
    )
    return RestyleResult(
        summary=summary,
        style=request.style,
        model=generator.model,
        prompt_version=PROMPT_VERSION,
        refs_discarded=dropped,
        input_characters=size,
        usage=usage,
    )
