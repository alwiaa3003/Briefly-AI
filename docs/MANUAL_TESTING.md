# Briefly AI — Manual testing checklist

Work through this list top to bottom. Each step says what to do and what you should see.

## 0. Start everything

Prerequisites: Node 20.11+, Python 3.11+ (the project uses 3.13), `backend/.env` and `processing-service/.env` filled in (see the `.env.example` files), the Atlas vector index created once (`cd backend && npm run rag:create-index`).

Open four terminals:

```bash
# 1. Processing service  → http://127.0.0.1:8000/health  (docs: http://127.0.0.1:8000/docs in development)
cd processing-service
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
python -m app

# 2. API                 → http://localhost:5000/api/health/ready
cd backend && npm run dev

# 3. Worker (required for every summary, index and study job)
cd backend && npm run worker:dev

# 4. Frontend            → http://localhost:5173
cd frontend && npm run dev
```

**Expected:** `http://localhost:5000/api/health/ready` returns `"status":"ready"` with database, redis and processingService all `up`. The worker terminal prints `Processing worker started`.

**Free-tier note:** every step marked ⚡ uses Gemini. The whole checklist needs about 20–30 generation requests. Briefly's default budget is 15 per day (`AI_APP_DAILY_GENERATION_LIMIT`). To finish the checklist in one day, temporarily raise `AI_APP_DAILY_GENERATION_LIMIT`, `AI_USER_DAILY_GENERATION_LIMIT` and the three feature limits (for example to 40 / 40 / 20) in `backend/.env`. Only do this if AI Studio shows enough quota for `gemini-3.5-flash-lite`. Restore the values afterwards.

## 1. Account

1. Open http://localhost:5173. You are redirected to **Sign in**.
2. **Create account** with a new email and the password `testing123`. You land on **Overview**.
3. Reload the page. You stay signed in.
4. Sign out (Settings → Session). Sign in again with the same account.

## 2. Article (Journey 1)

1. **Summarize → Article**: enter `https://www.epa.gov/heatislands/learn-about-heat-islands`. ⚡
   - **Expected:** processing steps (Reading article → Writing the summary), then the summary page with an overview, sections, takeaways and key concepts.
2. Submit the same URL again. You are taken to the same summary; no new processing starts.
3. Try `http://localhost:3000`. It is rejected ("not allowed"). Try `https://example.com/does-not-exist`. You get a clear failure with **Try again**.
4. On the summary page, open the **Ask AI** tab and ask "What causes urban heat islands?" ⚡
   - **Expected:** an answer with numbered **Sources** chips.
   - Ask "What is the capital of Australia?" ⚡ The answer is labelled **Not found in the source**.
   - Double-click Send quickly. Only one answer appears.
5. **Study notes → Generate study notes** ⚡. Notes with concepts and revision points appear. **Copy** and **Export** work. Clicking Generate again returns the same notes instantly.
6. **Quiz**: choose 4 questions, Medium, all types → **Generate quiz** ⚡.
   - Answer the questions; no answers or explanations are visible before you submit.
   - **Submit answers** shows your score, the correct answers and explanations.
   - **Retry quiz** gives a clean form. **New quiz** with the same settings reopens the existing quiz and offers *Generate new questions*.
7. **Flashcards → Generate flashcards** ⚡. Flip a card, go next/previous, Shuffle, use **I knew it**. The progress bar updates.
8. **Summary** tab → Style: **Exam revision** ⚡. A rewritten summary appears. Switching back to Standard and to Exam revision again does not regenerate it.
9. **My Library**: the article is listed. Title search finds it.

## 3. YouTube (Journey 2)

1. **Summarize → YouTube**: `https://www.youtube.com/watch?v=jNQXAC9IVRw` (19 seconds) ⚡ (transcription + summary).
   - **Expected:** Preparing → Transcribing → Summarizing, then a summary with chapters and key moments. Clicking a timestamp seeks the embedded player. The transcript tab shows the timed text.
2. **Ask AI**: "What animal is shown?" ⚡. Citations show a timestamp label (e.g. `0:01–0:18`).
3. Try a private or invalid video link. You get a clear "can't be processed" message.

## 4. Documents (Journey 3), needs object storage (Backblaze B2)

Without storage configured, the Document tab explains that uploads need object storage. That is the expected **blocked** state. With B2 configured, including `STORAGE_FORCE_PATH_STYLE=true` (see `docs/DEPLOYMENT.md` §3a):

1. Upload a multi-page text PDF ⚡.
   - **Expected:** Extracting → Summarizing, then a summary with page chips (`p. 2`). A page chip opens the PDF at that page; **Download original** works.
2. Upload a DOCX ⚡. References show section names instead of pages.
3. Upload a TXT file ⚡. Summary appears.
4. Upload a scanned PDF (an image-only PDF) ⚡. Text is recognized with OCR (Gemini); pages beyond `DOCUMENT_MAX_OCR_PAGES` are listed as skipped.
5. Negative cases, each with a clear message and nothing stored:
   - an empty `.txt`
   - a `.exe` renamed to `.pdf`
   - a `.doc` (legacy Word)
   - a corrupt PDF
   - a file over 50 MB
6. Open the PDF's **Flashcards** or **Study notes** ⚡. References point to real page numbers.

## 5. Uploaded video (Journey 4), needs object storage (Backblaze B2)

1. Upload a short MP4 with speech (under 3 minutes) ⚡.
   - **Expected:** Preparing → Transcribing → Summarizing, then a summary with chapters. The video plays in the page, and clicking a chapter seeks it.
2. Upload a video without audio. You get "no audio track to transcribe".
3. Cancel an upload halfway. Nothing appears in the library.

## 6. Smart search (Journey 5)

1. **My Library → Smart search**: type "why are cities hotter" ⚡ (one embedding).
   - **Expected:** the EPA article (and any related document) with a highlighted passage.
2. Type "medieval castle architecture". **No matches** (nothing unrelated is shown).
3. Use the type filter (Documents) and a future **From** date; results narrow or disappear accordingly.
4. Create a second account in a private window and add one article there. Neither account's search or Ask AI ever shows the other's content.

## 7. Persistence (Journey 6)

Sign out, sign in again:
- the library is unchanged;
- notes, quiz results ("best" score in the quiz list), flashcard progress and Ask AI conversations (sidebar **Ask AI**) are all still there.

## 8. Usage and quota behaviour (Journey 7)

1. **Settings → AI usage**: Gemini status, Briefly's budget meters (they increased while you tested), requests by feature, and the AI Studio link.
2. Simulate an exhausted budget:
   - set `AI_APP_DAILY_STUDY_LIMIT=1` in `backend/.env` and restart the API and the worker;
   - request flashcards for a source that has none.

   **Expected:** the panel shows **Paused: waiting for AI capacity** with an explanation. Everything already generated stays available. Restore the value and restart; the paused job continues automatically after the budget resets (or retry it).
3. In Ask AI, when the budget or quota is exhausted, the message says answers are paused and that saved content is still available. It is not shown as an error.

## 9. Responsive and general UI

- Narrow the browser to phone width. The sidebar becomes a menu, and the pages and tabs remain usable without horizontal scrolling.
- The browser console (F12) shows no errors during the steps above.

## 10. Automated tests and real Gemini usage

Routine test runs never send a request to Gemini:

| Suite | Command | Why it cannot reach Gemini |
|---|---|---|
| Backend unit/API | `cd backend && npm test` | The processing-service URL points at a closed port (`127.0.0.1:1`); the backend has no Google SDK. |
| Infrastructure | `cd backend && npm run test:infra` | Uses only health, internal-test and test-job endpoints (no AI). |
| Frontend | `cd frontend && npm test` | Services are mocked; the frontend only talks to the backend. |
| Processing service | `cd processing-service && ../.venv/Scripts/python -m pytest` | `tests/conftest.py` replaces the real key with a dummy and blocks `google.genai.Client` requests. The run ends with `Real Gemini API calls attempted by routine tests: 0` and fails if that number is not 0. |

**End-to-end runs without Gemini (mock mode).** Start the processing service with `AI_MOCK_MODE=true` (process environment, not `.env`). Generation and embeddings then return deterministic, schema-valid test data, results are labelled `mock:<model>`, and no Gemini client is created. Mocked calls report 0 Gemini requests, so Briefly's shared counters do not grow, but each call still needs budget to be available. For an isolated run, start the API and worker with `AI_GATE_STORE=memory` (budgets counted per process, independent of the shared counters) and their own `QUEUE_PREFIX` (separate jobs). The service refuses mock mode when `ENVIRONMENT=production`.

**Real Gemini verification (opt-in).** `RUN_LIVE_GEMINI=1 ../.venv/Scripts/python -m pytest tests/test_live_gemini.py` from `processing-service/` sends exactly 1 generation and 1 embedding request with the key in `processing-service/.env`. In this mode only tests marked `live_gemini` run. These requests count against Google's free-tier quota; a separate Redis prefix or queue prefix never isolates that quota.

**Worker and Redis.** The worker starts taking jobs only after the shared Redis connection is ready (`WORKER_REDIS_READY_TIMEOUT_MS`, default 60 s); otherwise it exits with `WORKER_REDIS_NOT_READY`. If Redis drops later, AI work in jobs waits (`AI_BUDGET_UNAVAILABLE`, deferred) instead of being counted in process memory.
