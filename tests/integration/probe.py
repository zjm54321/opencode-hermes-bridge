"""Test-only byte fixtures and read-only, targeted SQLite evidence. No Hermes imports."""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import struct
import zipfile
import zlib


def make_files(directory: Path) -> list[dict[str, str]]:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")
    # A valid one-page PDF with byte-accurate xref offsets, not merely a magic header.
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
        b"<< /Length 4 >>\nstream\nq\nQ\nendstream",
    ]
    for number, data in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + data + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 5\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        entry = zipfile.ZipInfo("hello.txt", date_time=(2026, 1, 1, 0, 0, 0))
        output.writestr(entry, b"A real ZIP member.\n")
    with zipfile.ZipFile(io.BytesIO(archive.getvalue())) as check:
        assert check.testzip() is None
        assert check.read("hello.txt") == b"A real ZIP member.\n"
    values = [
        ("one-pixel.png", "image/png", png),
        ("note.txt", "text/plain", "Echo bytes, not model understanding.\n你好\n".encode()),
        ("document.pdf", "application/pdf", bytes(pdf)),
        ("archive.zip", "application/zip", archive.getvalue()),
    ]
    result = []
    for name, mime, data in values:
        path = directory / name
        path.write_bytes(data)
        path.chmod(0o600)
        result.append({"name": name, "mime": mime, "base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()})
    return result


def inspect(database: Path, job: str, thread: str) -> dict:
    # Read-only connection; no debug endpoints and no test-only production changes.
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=2) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute("SELECT id,thread_id,status,input FROM jobs WHERE id=?", (job,))]
        row = db.execute("SELECT messages FROM threads WHERE id=?", (thread,)).fetchone()
        return {"rows": rows, "messages": json.loads(row["messages"]) if row else []}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    files = commands.add_parser("files")
    files.add_argument("directory", type=Path)
    evidence = commands.add_parser("inspect")
    evidence.add_argument("database", type=Path)
    evidence.add_argument("job")
    evidence.add_argument("thread")
    args = parser.parse_args()
    value = make_files(args.directory) if args.command == "files" else inspect(args.database, args.job, args.thread)
    print(json.dumps(value), flush=True)
