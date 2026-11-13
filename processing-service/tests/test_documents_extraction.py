import codecs

import pytest

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.documents.docx_extract import extract_docx
from app.documents.ocr import render_page_png
from app.documents.pdf import extract_pdf
from app.documents.text_utils import group_into_parts, make_blocks, split_long_text
from app.documents.txt_extract import decode_text, extract_txt
from tests import document_fixtures as fx


@pytest.fixture()
def settings():
    return get_settings()


def texts(result, kind=None):
    return [b.text for p in result.parts for b in p.blocks if kind is None or b.kind == kind]


# ------------------------------------------------------------------- PDF


class TestPdf:
    def test_pages_headings_paragraphs_and_metadata(self, tmp_path, settings):
        result = extract_pdf(fx.report_pdf(tmp_path / "r.pdf"), settings)

        assert result.format == "pdf"
        assert result.page_count == 3
        assert [p.page for p in result.parts] == [1, 2, 3]
        assert result.metadata.title == "Urban Heat Report"
        assert result.metadata.author == "Example Institute"
        assert result.metadata.created == "2025-03-01"

        headings = {b.text: b.level for p in result.parts for b in p.blocks if b.kind == "heading"}
        assert headings["Urban Heat Report"] == 1  # largest font
        assert headings["1. Introduction"] == 2
        assert headings["Key definition"] == 3  # short bold line
        # Soft-wrapped lines are joined into one paragraph.
        assert any(t.startswith("Urban trees reduce summer heat") and "twelve cities" in t for t in texts(result, "paragraph"))

    def test_page_references_are_kept_with_content(self, tmp_path, settings):
        result = extract_pdf(fx.report_pdf(tmp_path / "r.pdf"), settings)
        page2 = next(p for p in result.parts if p.page == 2)
        assert any("31 percent" in b.text for b in page2.blocks)
        assert page2.heading_path == ["Urban Heat Report", "1. Introduction"]  # carried over from page 1
        page3 = next(p for p in result.parts if p.page == 3)
        assert page3.heading_path[-1] == "Key definition"

    def test_running_headers_and_page_numbers_are_removed(self, tmp_path, settings):
        result = extract_pdf(fx.report_pdf(tmp_path / "r.pdf"), settings)
        all_text = " ".join(texts(result))
        assert "Annual Report" not in all_text
        assert not any(t.strip() in {"1", "2", "3"} for t in texts(result))

    def test_two_column_layout_is_read_column_by_column(self, tmp_path, settings):
        result = extract_pdf(fx.two_column_pdf(tmp_path / "c.pdf"), settings)
        joined = "\n".join(texts(result))
        assert joined.index("LEFTSTART") < joined.index("LEFTEND") < joined.index("RIGHTSTART") < joined.index("RIGHTEND")

    def test_scanned_pages_are_detected_for_ocr(self, tmp_path, settings):
        result = extract_pdf(fx.scanned_pdf(tmp_path / "s.pdf", pages=2), settings)
        assert result.ocr_pages == [1, 2]
        assert all(p.needs_ocr and not p.blocks for p in result.parts)
        assert result.char_count == 0

    def test_mixed_documents_only_ocr_the_image_pages(self, tmp_path, settings):
        result = extract_pdf(fx.mixed_pdf(tmp_path / "m.pdf", tmp_path), settings)
        assert result.ocr_pages == [2]
        assert result.parts[0].blocks and not result.parts[0].needs_ocr

    def test_encrypted_pdf(self, tmp_path, settings):
        with pytest.raises(ServiceError) as info:
            extract_pdf(fx.encrypted_pdf(tmp_path / "e.pdf", tmp_path), settings)
        assert info.value.code == "DOCUMENT_ENCRYPTED"
        assert info.value.retryable is False

    def test_corrupted_pdf(self, tmp_path, settings):
        with pytest.raises(ServiceError) as info:
            extract_pdf(fx.corrupted_pdf(tmp_path / "x.pdf", tmp_path), settings)
        assert info.value.code == "DOCUMENT_INVALID"

    def test_not_a_pdf(self, tmp_path, settings):
        fake = tmp_path / "fake.pdf"
        fake.write_bytes(b"PK\x03\x04 this is a zip")
        with pytest.raises(ServiceError) as info:
            extract_pdf(fake, settings)
        assert info.value.code == "DOCUMENT_INVALID"

    def test_pdf_without_text_or_images(self, tmp_path, settings):
        with pytest.raises(ServiceError) as info:
            extract_pdf(fx.blank_pdf(tmp_path / "b.pdf"), settings)
        assert info.value.code == "DOCUMENT_NO_TEXT"

    def test_page_limit_truncates_honestly(self, tmp_path, settings):
        result = extract_pdf(fx.long_pdf(tmp_path / "l.pdf", 6), settings, max_pages=4)
        assert result.page_count == 6
        assert result.pages_processed == 4
        assert result.truncated is True
        assert "first 4 of 6 pages" in result.warnings[0]

    def test_character_limit_truncates_at_a_page_boundary(self, tmp_path):
        settings = get_settings().model_copy(update={"document_max_chars": 10_000})
        result = extract_pdf(fx.long_pdf(tmp_path / "l.pdf", 80), settings)
        assert result.truncated is True
        assert result.char_count <= 10_000
        assert result.parts[-1].page == len(result.parts)

    def test_render_page_for_ocr(self, tmp_path):
        png = render_page_png(fx.scanned_pdf(tmp_path / "s.pdf", pages=1), 1, dpi=100)
        assert png.startswith(b"\x89PNG")
        with pytest.raises(ServiceError):
            render_page_png(tmp_path / "s.pdf", 5, dpi=100)


# ------------------------------------------------------------------ DOCX


class TestDocx:
    def test_structure_order_lists_tables_and_metadata(self, tmp_path, settings):
        result = extract_docx(fx.report_docx(tmp_path / "r.docx"), settings)

        blocks = [(b.kind, b.text, b.level) for p in result.parts for b in p.blocks]
        kinds = [k for k, _, _ in blocks]
        assert blocks[0] == ("heading", "Quarterly Review", 1)
        assert ("heading", "Highlights", 2) in blocks
        assert ("list", "- Launched two products\n- Opened the Berlin office", None) in blocks
        assert ("table", "Metric | Value\nRevenue | 4.2M\nMargin | 18%", None) in blocks
        assert kinds.index("list") < kinds.index("table")  # body order preserved
        assert result.metadata.title == "Quarterly Review"
        assert result.metadata.author == "Jane Analyst"
        assert result.page_count is None  # DOCX has no fixed pages
        assert all(p.page is None for p in result.parts)

    def test_macro_enabled_documents_are_rejected(self, tmp_path, settings):
        with pytest.raises(ServiceError) as info:
            extract_docx(fx.macro_docx(tmp_path / "m.docx", tmp_path), settings)
        assert info.value.code == "DOCUMENT_MACROS"

    def test_zip_bombs_are_rejected_before_parsing(self, tmp_path):
        settings = get_settings().model_copy(update={"docx_max_uncompressed_bytes": 5 * 1024 * 1024})
        with pytest.raises(ServiceError) as info:
            extract_docx(fx.bomb_docx(tmp_path / "b.docx", tmp_path, 6 * 1024 * 1024), settings)
        assert info.value.code == "DOCUMENT_TOO_LARGE"

    @pytest.mark.parametrize("content", [b"not a zip at all", b"PK\x03\x04broken zip"])
    def test_malformed_files(self, tmp_path, settings, content):
        path = tmp_path / "bad.docx"
        path.write_bytes(content)
        with pytest.raises(ServiceError) as info:
            extract_docx(path, settings)
        assert info.value.code == "DOCUMENT_INVALID"

    def test_zip_that_is_not_a_word_document(self, tmp_path, settings):
        import zipfile

        path = tmp_path / "other.docx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("hello.txt", "hi")
        with pytest.raises(ServiceError) as info:
            extract_docx(path, settings)
        assert info.value.code == "DOCUMENT_INVALID"

    def test_empty_document(self, tmp_path, settings):
        import docx

        path = tmp_path / "empty.docx"
        docx.Document().save(path)
        with pytest.raises(ServiceError) as info:
            extract_docx(path, settings)
        assert info.value.code == "DOCUMENT_NO_TEXT"


# ------------------------------------------------------------------- TXT

SAMPLE = "# Field notes\n\nFirst paragraph line one.\nLine two stays on its own line.\n\n- apples\n- pears\n\nClosing paragraph."


class TestTxt:
    @pytest.mark.parametrize(
        "encoding, prefix",
        [("utf-8", b""), ("utf-8", codecs.BOM_UTF8), ("utf-16-le", codecs.BOM_UTF16_LE), ("utf-16-be", codecs.BOM_UTF16_BE)],
    )
    def test_unicode_encodings(self, tmp_path, settings, encoding, prefix):
        path = tmp_path / "notes.txt"
        path.write_bytes(prefix + "Café – naïve résumé\n\nSecond paragraph.".encode(encoding))
        result = extract_txt(path, settings)
        assert texts(result)[0] == "Café – naïve résumé"

    def test_legacy_single_byte_encoding(self, tmp_path, settings):
        path = tmp_path / "legacy.txt"
        path.write_bytes(("Der Bericht über die Stadtbäume zeigt, dass größere Bäume kühlen. " * 5).encode("cp1252"))
        result = extract_txt(path, settings)
        assert "über" in texts(result)[0] and "größere" in texts(result)[0]

    def test_structure_paragraphs_and_line_breaks(self, tmp_path, settings):
        path = tmp_path / "notes.txt"
        path.write_text(SAMPLE, encoding="utf-8")
        result = extract_txt(path, settings)
        blocks = [(b.kind, b.text) for p in result.parts for b in p.blocks]
        assert blocks == [
            ("heading", "Field notes"),
            ("paragraph", "First paragraph line one.\nLine two stays on its own line."),
            ("list", "- apples\n- pears"),
            ("paragraph", "Closing paragraph."),
        ]
        assert result.metadata.title == "Field notes"
        assert result.metadata.encoding == "utf-8"

    @pytest.mark.parametrize("content", [b"", b"   \n\n  "])
    def test_empty_files(self, tmp_path, settings, content):
        path = tmp_path / "empty.txt"
        path.write_bytes(content)
        with pytest.raises(ServiceError) as info:
            extract_txt(path, settings)
        assert info.value.code == "DOCUMENT_EMPTY"

    def test_binary_files_are_rejected(self, tmp_path, settings):
        path = tmp_path / "program.txt"
        path.write_bytes(b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff" * 200)
        with pytest.raises(ServiceError) as info:
            extract_txt(path, settings)
        assert info.value.code == "DOCUMENT_INVALID"

    def test_decode_prefers_bom(self):
        assert decode_text(codecs.BOM_UTF16_LE + "hi".encode("utf-16-le")) == ("hi", "utf-16-le")


# ------------------------------------------------------------ text utils


class TestChunkingUtils:
    def test_long_text_splits_at_sentence_boundaries(self):
        sentence = "This is a complete sentence about urban trees and their cooling effect. "
        pieces = split_long_text(sentence * 100, 500)
        assert all(len(p) <= 500 for p in pieces)
        assert all(p.rstrip().endswith(".") for p in pieces)
        assert " ".join(pieces).split() == (sentence * 100).split()  # nothing lost or duplicated

    def test_enormous_sentence_splits_at_word_boundaries(self):
        pieces = split_long_text("word " * 1000, 300)
        assert all(len(p) <= 300 for p in pieces)
        assert all(not p.startswith("ord") for p in pieces)

    def test_parts_never_split_blocks_and_track_headings(self):
        blocks = make_blocks("heading", "Intro", 4000, 1)
        blocks += make_blocks("paragraph", "A" * 900, 4000)
        blocks += make_blocks("heading", "Details", 4000, 1)
        blocks += make_blocks("paragraph", "B" * 900, 4000) + make_blocks("paragraph", "C" * 900, 4000)
        parts = group_into_parts(blocks, part_chars=1500)
        assert [b.text[:1] for p in parts for b in p.blocks] == ["I", "A", "D", "B", "C"]
        assert parts[0].heading_path == ["Intro"]
        assert parts[1].heading_path == ["Details"]
        assert all(p.page is None for p in parts)
