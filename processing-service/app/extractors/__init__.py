"""Content extractors (later milestones).

Each extractor turns a source into plain text plus metadata:
  - article URLs (HTML fetch + readability-style extraction, with SSRF protection)
  - YouTube URLs (captions / transcripts)
  - uploaded videos (audio transcription)
  - documents (PDF, DOCX, TXT)

Intentionally empty in Milestone 1.
"""
