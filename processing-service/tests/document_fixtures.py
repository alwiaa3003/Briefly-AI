"""Builders for representative test documents (generated at test time, no binaries committed)."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

# ---------------------------------------------------------------- PDF (text)


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_text_pdf(path: Path, pages: list[list[tuple]], title: str | None = None, author: str | None = None) -> Path:
    """pages: list of [(text, font_size, x, y, bold?)]. Writes a minimal, valid PDF 1.4."""
    objects: list[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    catalog = add(b"")  # placeholder
    pages_obj = add(b"")
    font_regular = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    font_bold = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    page_ids = []
    for items in pages:
        stream = b""
        for item in items:
            text, size, x, y = item[:4]
            font = "F2" if len(item) > 4 and item[4] else "F1"
            stream += f"BT /{font} {size} Tf {x} {y} Td ({_escape(text)}) Tj ET\n".encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream")
        page_ids.append(
            add(
                (
                    f"<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 {font_regular} 0 R /F2 {font_bold} 0 R >> >> /Contents {content} 0 R >>"
                ).encode()
            )
        )
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode()
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[pages_obj - 1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    info = None
    if title or author:
        fields = (f"/Title ({_escape(title)}) " if title else "") + (f"/Author ({_escape(author)})" if author else "")
        info = add(f"<< {fields} /CreationDate (D:20250301120000) >>".encode())

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, obj in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    trailer = f"<< /Size {len(objects) + 1} /Root {catalog} 0 R" + (f" /Info {info} 0 R" if info else "") + " >>"
    out.write(f"trailer\n{trailer}\nstartxref\n{xref}\n%%EOF\n".encode())
    path.write_bytes(out.getvalue())
    return path


def body_lines(text: str, x: int, top: int, size: int = 11, width: int = 80) -> list[tuple]:
    """Wraps text into lines at fixed spacing (a paragraph)."""
    words, lines, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return [(line, size, x, top - i * (size + 3)) for i, line in enumerate(lines)]


LOREM = (
    "Urban trees reduce summer heat by shading streets and through evapotranspiration, which draws heat "
    "from the surrounding air. Measurements across twelve cities found canopy-rich districts were cooler."
)


def report_pdf(path: Path) -> Path:
    """Three pages: title + headings + paragraphs, running header and page numbers on every page."""
    pages = []
    for number in range(1, 4):
        items = [("Example Institute - Annual Report", 8, 50, 770), (str(number), 8, 300, 30)]
        if number == 1:
            items += [("Urban Heat Report", 24, 50, 720), ("1. Introduction", 16, 50, 680)]
            items += body_lines(LOREM, 50, 655)
        elif number == 2:
            items += [("2. Findings", 16, 50, 720)]
            items += body_lines("The study found that canopy cover was 31 percent in wealthy districts and 12 percent in "
                                "lower-income districts, a gap of 19 percentage points.", 50, 695)
            items += [("Key definition", 11, 50, 600, True)]
            items += body_lines("Evapotranspiration is the release of water vapour from leaves, which cools the air.", 50, 585)
        else:
            items += [("3. Conclusions", 16, 50, 720)]
            items += body_lines("Cities should protect mature trees and fund maintenance for at least two decades.", 50, 695)
        pages.append(items)
    return write_text_pdf(path, pages, title="Urban Heat Report", author="Example Institute")


def two_column_pdf(path: Path) -> Path:
    left = body_lines("LEFTSTART The left column discusses shade from street trees in dense neighbourhoods. LEFTEND", 50, 700, width=40)
    right = body_lines("RIGHTSTART The right column discusses budgets and maintenance schedules for cities. RIGHTEND", 330, 700, width=40)
    return write_text_pdf(path, [left + right])


def blank_pdf(path: Path, pages: int = 2) -> Path:
    return write_text_pdf(path, [[] for _ in range(pages)])


def long_pdf(path: Path, pages: int) -> Path:
    return write_text_pdf(path, [[(f"Section {n}", 16, 50, 720), *body_lines(LOREM, 50, 690)] for n in range(1, pages + 1)])


# ------------------------------------------------------------ PDF (scanned)


def scanned_pdf(path: Path, pages: int = 2) -> Path:
    from PIL import Image, ImageDraw

    images = []
    for n in range(pages):
        image = Image.new("RGB", (850, 1100), "white")
        draw = ImageDraw.Draw(image)
        draw.text((80, 100), f"SCANNED PAGE {n + 1}", fill="black")
        draw.text((80, 140), "Text that only exists as pixels.", fill="black")
        images.append(image)
    images[0].save(path, "PDF", resolution=100, save_all=True, append_images=images[1:])
    return path


def mixed_pdf(path: Path, workdir: Path) -> Path:
    """Page 1 has text, page 2 is a scanned image (merged with pypdf)."""
    from pypdf import PdfReader, PdfWriter

    text = report_pdf(workdir / "text.pdf")
    scan = scanned_pdf(workdir / "scan.pdf", pages=1)
    writer = PdfWriter()
    writer.add_page(PdfReader(text).pages[0])
    writer.add_page(PdfReader(scan).pages[0])
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def encrypted_pdf(path: Path, workdir: Path) -> Path:
    from pypdf import PdfReader, PdfWriter

    source = report_pdf(workdir / "plain.pdf")
    writer = PdfWriter()
    for page in PdfReader(source).pages:
        writer.add_page(page)
    writer.encrypt(user_password="secret", owner_password="owner")
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def corrupted_pdf(path: Path, workdir: Path) -> Path:
    data = report_pdf(workdir / "ok.pdf").read_bytes()
    path.write_bytes(data[:200] + b"\x00garbage" * 50)
    return path


# -------------------------------------------------------------------- DOCX


def report_docx(path: Path) -> Path:
    import docx

    document = docx.Document()
    document.core_properties.title = "Quarterly Review"
    document.core_properties.author = "Jane Analyst"
    document.add_heading("Quarterly Review", level=0)
    document.add_heading("Summary", level=1)
    document.add_paragraph("Revenue grew 12 percent to 4.2 million dollars compared with the previous quarter.")
    document.add_heading("Highlights", level=2)
    document.add_paragraph("Launched two products", style="List Bullet")
    document.add_paragraph("Opened the Berlin office", style="List Bullet")
    document.add_paragraph("Hiring continued as planned.")
    table = document.add_table(rows=3, cols=2)
    for row, (metric, value) in enumerate([("Metric", "Value"), ("Revenue", "4.2M"), ("Margin", "18%")]):
        table.cell(row, 0).text = metric
        table.cell(row, 1).text = value
    document.add_heading("Outlook", level=1)
    document.add_paragraph("Management expects growth to slow to 8 percent next quarter.")
    document.save(path)
    return path


def rewrite_zip(source: Path, target: Path, replace: dict[str, bytes] | None = None, add: dict[str, bytes] | None = None) -> Path:
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = (replace or {}).get(item.filename, src.read(item.filename))
            dst.writestr(item, data)
        for name, data in (add or {}).items():
            dst.writestr(name, data)
    return target


def macro_docx(path: Path, workdir: Path) -> Path:
    source = report_docx(workdir / "plain.docx")
    with zipfile.ZipFile(source) as archive:
        types = archive.read("[Content_Types].xml").decode()
    types = types.replace(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "application/vnd.ms-word.document.macroEnabled.main+xml",
    )
    return rewrite_zip(source, path, replace={"[Content_Types].xml": types.encode()}, add={"word/vbaProject.bin": b"\x00" * 64})


def bomb_docx(path: Path, workdir: Path, size: int) -> Path:
    source = report_docx(workdir / "plain2.docx")
    return rewrite_zip(source, path, add={"word/media/padding.bin": b"\x00" * size})
