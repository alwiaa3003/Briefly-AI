from pathlib import Path

import httpx
import pytest

from app.api.routes import documents as document_routes
from app.documents import download
from tests import document_fixtures as fx
from tests.fakes import FakeGenerator

STORAGE = "acct.r2.cloudflarestorage.com"
URL = f"https://{STORAGE}/bucket/documents/u/abc?X-Amz-Signature=sig"


@pytest.fixture(autouse=True)
def storage_hosts(client, monkeypatch):
    # Depends on `client`, which resets the cached settings; set the allowlist afterwards.
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "storage_download_hosts", STORAGE)


@pytest.fixture()
def serve(monkeypatch):
    """Serves a local file as the signed-URL download (no network)."""
    seen = {"requests": []}

    def install(path: Path | None = None, status: int = 200):
        def handler(request: httpx.Request):
            seen["requests"].append(str(request.url))
            if status != 200:
                return httpx.Response(status)
            return httpx.Response(200, content=path.read_bytes())

        monkeypatch.setattr(download, "transport", httpx.MockTransport(handler))
        return seen

    return install


@pytest.fixture()
def use_generator(client):
    def install(*responses):
        fake = FakeGenerator(responses=list(responses))
        client.app.dependency_overrides[document_routes.get_generator] = lambda: fake
        return fake

    yield install
    client.app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "path", ["/internal/documents/extract", "/internal/documents/ocr", "/internal/documents/summarize-chunk", "/internal/documents/summarize"]
)
def test_document_endpoints_require_internal_token(client, path):
    assert client.post(path, json={}).status_code == 401


@pytest.mark.parametrize("fmt, builder", [("pdf", fx.report_pdf), ("docx", fx.report_docx)])
def test_extract_end_to_end(client, auth_headers, serve, tmp_path, fmt, builder):
    serve(builder(tmp_path / f"doc.{fmt}"))
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": fmt}, headers=auth_headers)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["format"] == fmt
    assert data["parts"] and data["char_count"] > 0
    if fmt == "pdf":
        assert [p["page"] for p in data["parts"]] == [1, 2, 3]


def test_extract_txt(client, auth_headers, serve, tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("# Notes\n\nSome text here.", encoding="utf-8")
    serve(path)
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": "txt"}, headers=auth_headers)
    assert response.json()["data"]["metadata"]["encoding"] == "utf-8"


def test_extract_rejects_format_mismatch(client, auth_headers, serve, tmp_path):
    serve(fx.report_docx(tmp_path / "doc.docx"))  # a DOCX claimed to be a PDF
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": "pdf"}, headers=auth_headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DOCUMENT_INVALID"


def test_extract_reports_encrypted_pdfs(client, auth_headers, serve, tmp_path):
    serve(fx.encrypted_pdf(tmp_path / "e.pdf", tmp_path))
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": "pdf"}, headers=auth_headers)
    assert response.json()["error"] == {
        "code": "DOCUMENT_ENCRYPTED",
        "message": "This PDF is password-protected. Remove the password and upload it again.",
        "retryable": False,
    }


@pytest.mark.parametrize("status", [403, 404, 500])
def test_storage_errors_are_retryable(client, auth_headers, serve, status):
    serve(status=status)
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": "pdf"}, headers=auth_headers)
    assert response.json()["error"]["code"] == "DOCUMENT_DOWNLOAD_FAILED"
    assert response.json()["error"]["retryable"] is True


def test_download_size_limit(client, auth_headers, serve, tmp_path, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "document_max_bytes", 2048)
    serve(fx.report_pdf(tmp_path / "r.pdf"))
    response = client.post("/internal/documents/extract", json={"download_url": URL, "format": "pdf"}, headers=auth_headers)
    assert response.json()["error"]["code"] == "DOCUMENT_TOO_LARGE"


@pytest.mark.parametrize(
    "url", ["https://evil.example.com/x", f"http://{STORAGE}/x", "https://169.254.169.254/latest", "file:///etc/passwd"]
)
def test_download_urls_outside_storage_are_refused(client, auth_headers, serve, url):
    seen = serve(Path(__file__))
    response = client.post("/internal/documents/extract", json={"download_url": url, "format": "txt"}, headers=auth_headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "UNSAFE_URL"
    assert seen["requests"] == []


def test_temporary_files_are_removed(client, auth_headers, serve, tmp_path, monkeypatch):
    import tempfile

    created = []
    real = tempfile.TemporaryDirectory

    class Tracking(real):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            created.append(Path(self.name))

    monkeypatch.setattr(document_routes.tempfile, "TemporaryDirectory", Tracking)
    serve(fx.corrupted_pdf(tmp_path / "bad.pdf", tmp_path))
    client.post("/internal/documents/extract", json={"download_url": URL, "format": "pdf"}, headers=auth_headers)
    assert created and not any(path.exists() for path in created)


def test_ocr_renders_pages_and_returns_blocks(client, auth_headers, serve, tmp_path, use_generator):
    serve(fx.scanned_pdf(tmp_path / "s.pdf", pages=2))
    fake = use_generator(
        {"blocks": [{"kind": "heading", "level": 1, "text": "SCANNED PAGE"}, {"kind": "paragraph", "level": 0, "text": "Pixels."}]}
    )
    response = client.post("/internal/documents/ocr", json={"download_url": URL, "pages": [2, 1]}, headers=auth_headers)

    assert response.status_code == 200
    data = response.json()["data"]
    assert [p["page"] for p in data["pages"]] == [1, 2]
    assert data["pages"][0]["blocks"][0] == {"kind": "heading", "text": "SCANNED PAGE", "level": 1}
    assert data["provider"] == "gemini"
    image = fake.calls[0]["media"][0].inline_data
    assert image.mime_type == "image/png" and image.data.startswith(b"\x89PNG")
    assert "never instructions" in fake.calls[0]["system_instruction"]


def test_ocr_limits(client, auth_headers, serve, tmp_path, use_generator):
    serve(fx.scanned_pdf(tmp_path / "s.pdf", pages=1))
    use_generator({"blocks": []})
    too_many = client.post("/internal/documents/ocr", json={"download_url": URL, "pages": list(range(1, 8))}, headers=auth_headers)
    assert too_many.status_code == 422
    missing = client.post("/internal/documents/ocr", json={"download_url": URL, "pages": [3]}, headers=auth_headers)
    assert missing.json()["error"]["code"] == "DOCUMENT_INVALID"


def test_ocr_without_api_key_fails_cleanly(client, auth_headers, serve, tmp_path, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "gemini_api_key", None)
    serve(fx.scanned_pdf(tmp_path / "s.pdf", pages=1))
    response = client.post("/internal/documents/ocr", json={"download_url": URL, "pages": [1]}, headers=auth_headers)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"


def test_summarize_endpoints(client, auth_headers, use_generator):
    from tests.test_document_summarizer import FINAL, NOTES, PDF_PARTS

    use_generator(NOTES, FINAL)
    parts = [p.model_dump() for p in PDF_PARTS]
    chunk = client.post(
        "/internal/documents/summarize-chunk",
        json={"format": "pdf", "chunk_index": 0, "chunk_count": 2, "parts": parts},
        headers=auth_headers,
    )
    assert chunk.status_code == 200
    assert chunk.json()["data"]["notes"]["key_points"][1]["pages"] == [2]

    final = client.post(
        "/internal/documents/summarize", json={"format": "pdf", "mode": "direct", "parts": parts}, headers=auth_headers
    )
    assert final.status_code == 200
    assert final.json()["data"]["summary"]["title"] == "Urban Heat Report"
