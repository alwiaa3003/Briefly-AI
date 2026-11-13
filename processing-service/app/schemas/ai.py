"""Schemas for embeddings, RAG answers and study tools (notes, quizzes, flashcards, summary styles)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.articles import TokenUsage

SourceKind = Literal["article", "youtube", "video", "document"]

# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texts: list[str] = Field(min_length=1, max_length=500)
    task: Literal["document", "query"]

    @field_validator("texts")
    @classmethod
    def _bounded(cls, value: list[str]) -> list[str]:
        cleaned = [t.strip() for t in value]
        if any(not t or len(t) > 8000 for t in cleaned):
            raise ValueError("each text must contain 1 to 8000 characters")
        return cleaned


class EmbedResult(BaseModel):
    vectors: list[list[float]]
    model: str
    dimensions: int
    provider: str


# --------------------------------------------------------------------------
# Context chunks (provided by the Node backend after ownership-filtered retrieval)
# --------------------------------------------------------------------------


class ContextChunk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=12000)
    # Human-readable locator, e.g. "p. 4", "12:30-13:05", "Section: Methods".
    label: str | None = Field(default=None, max_length=120)
    source_id: str = Field(min_length=1, max_length=64)
    source_title: str | None = Field(default=None, max_length=300)
    source_kind: SourceKind


# --------------------------------------------------------------------------
# RAG answer
# --------------------------------------------------------------------------


class ChatTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=20)
    chunks: list[ContextChunk] = Field(default_factory=list, max_length=40)
    scope: Literal["source", "library"]
    scope_title: str | None = Field(default=None, max_length=300)


Support = Literal["supported", "partial", "not_found"]


class GeminiAnswer(BaseModel):
    answer: str
    support: str
    citations: list[str]
    follow_up_questions: list[str]


class Answer(BaseModel):
    answer: str = Field(min_length=1, max_length=6000)
    support: Support
    citations: list[str] = Field(default_factory=list, max_length=12)
    follow_up_questions: list[str] = Field(default_factory=list, max_length=3)


class AnswerResult(BaseModel):
    answer: Answer
    model: str
    citations_discarded: int
    usage: TokenUsage


# --------------------------------------------------------------------------
# Study tools
# --------------------------------------------------------------------------


class StudyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    source_kind: SourceKind
    summary_overview: str | None = Field(default=None, max_length=4000)
    chunks: list[ContextChunk] = Field(min_length=1, max_length=400)


Difficulty = Literal["easy", "medium", "hard"]
QuestionType = Literal["multiple_choice", "true_false", "short_answer"]


class QuizRequest(StudyRequest):
    count: int = Field(ge=1, le=30)
    difficulty: Difficulty
    types: list[QuestionType] = Field(min_length=1, max_length=3)


class FlashcardRequest(StudyRequest):
    count: int = Field(ge=1, le=60)


SummaryStyle = Literal["concise", "detailed", "bullet_points", "academic", "beginner", "technical", "exam_revision"]


class RestyleRequest(StudyRequest):
    style: SummaryStyle


# --- Gemini response schemas (unconstrained; strict models below validate) ---


class GeminiRefItem(BaseModel):
    text: str
    refs: list[str]


class GeminiTerm(BaseModel):
    term: str
    explanation: str
    refs: list[str]


class GeminiNotes(BaseModel):
    title: str
    overview: str
    key_concepts: list[GeminiTerm]
    definitions: list[GeminiTerm]
    key_facts: list[GeminiRefItem]
    examples: list[GeminiRefItem]
    formulas: list[GeminiRefItem]
    revision_points: list[GeminiRefItem]
    external_knowledge: list[str]


class GeminiQuestion(BaseModel):
    type: str
    question: str
    options: list[str]
    correct_option: int
    correct_boolean: bool
    accepted_answers: list[str]
    explanation: str
    refs: list[str]


class GeminiQuiz(BaseModel):
    title: str
    questions: list[GeminiQuestion]


class GeminiCard(BaseModel):
    front: str
    back: str
    refs: list[str]


class GeminiFlashcards(BaseModel):
    cards: list[GeminiCard]


class GeminiStyledSection(BaseModel):
    heading: str
    content: str


class GeminiStyledSummary(BaseModel):
    title: str
    overview: str
    sections: list[GeminiStyledSection]
    key_points: list[str]


# --- Validated outputs ---


def _short(min_len: int, max_len: int):
    return Field(min_length=min_len, max_length=max_len)


class RefItem(BaseModel):
    text: str = _short(3, 1200)
    refs: list[str] = Field(default_factory=list, max_length=8)


class Term(BaseModel):
    term: str = _short(1, 200)
    explanation: str = _short(3, 1500)
    refs: list[str] = Field(default_factory=list, max_length=8)


class StudyNotes(BaseModel):
    title: str = _short(1, 300)
    overview: str = _short(30, 3000)
    key_concepts: list[Term] = Field(min_length=1, max_length=25)
    definitions: list[Term] = Field(default_factory=list, max_length=30)
    key_facts: list[RefItem] = Field(default_factory=list, max_length=30)
    examples: list[RefItem] = Field(default_factory=list, max_length=20)
    formulas: list[RefItem] = Field(default_factory=list, max_length=20)
    revision_points: list[RefItem] = Field(min_length=3, max_length=25)
    # Background the model added that is NOT in the source; shown separately and labelled.
    external_knowledge: list[str] = Field(default_factory=list, max_length=10)


class QuizQuestion(BaseModel):
    id: str = _short(1, 20)
    type: QuestionType
    question: str = _short(5, 1000)
    options: list[str] = Field(default_factory=list, max_length=6)
    correct_option: int | None = None
    correct_boolean: bool | None = None
    accepted_answers: list[str] = Field(default_factory=list, max_length=8)
    explanation: str = _short(5, 1500)
    refs: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _consistent(self) -> QuizQuestion:
        if self.type == "multiple_choice":
            options = [o.strip() for o in self.options]
            if not 3 <= len(options) <= 6 or len({o.lower() for o in options}) != len(options) or not all(options):
                raise ValueError("multiple-choice questions need 3-6 distinct options")
            if self.correct_option is None or not 0 <= self.correct_option < len(options):
                raise ValueError("correct_option must point at an option")
            self.options = options
            self.correct_boolean = None
            self.accepted_answers = []
        elif self.type == "true_false":
            if self.correct_boolean is None:
                raise ValueError("true/false questions need correct_boolean")
            self.options, self.correct_option, self.accepted_answers = [], None, []
        else:
            answers = [a.strip() for a in self.accepted_answers if a.strip()]
            if not answers:
                raise ValueError("short-answer questions need accepted_answers")
            self.accepted_answers = answers[:8]
            self.options, self.correct_option, self.correct_boolean = [], None, None
        return self


class Quiz(BaseModel):
    title: str = _short(1, 300)
    questions: list[QuizQuestion] = Field(min_length=1, max_length=30)


class Flashcard(BaseModel):
    id: str = _short(1, 20)
    front: str = _short(2, 600)
    back: str = _short(2, 1500)
    refs: list[str] = Field(default_factory=list, max_length=8)


class Flashcards(BaseModel):
    cards: list[Flashcard] = Field(min_length=1, max_length=60)


class StyledSection(BaseModel):
    heading: str = _short(1, 200)
    content: str = _short(5, 8000)


class StyledSummary(BaseModel):
    title: str = _short(1, 300)
    overview: str = _short(20, 3000)
    sections: list[StyledSection] = Field(min_length=1, max_length=15)
    key_points: list[str] = Field(default_factory=list, max_length=20)


class GenerationResult(BaseModel):
    model: str
    prompt_version: str
    refs_discarded: int
    input_characters: int
    usage: TokenUsage


class NotesResult(GenerationResult):
    notes: StudyNotes


class QuizResult(GenerationResult):
    quiz: Quiz


class FlashcardsResult(GenerationResult):
    flashcards: Flashcards


class RestyleResult(GenerationResult):
    summary: StyledSummary
    style: SummaryStyle
