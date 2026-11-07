#!/usr/bin/env python3
"""Build the small source-only release; never include runtime/config/secrets."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import tarfile

VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "app-manifest.sha256"
PAYLOAD_EXTENSIONS = {"app": {".mjs", ".json", ".md", ".txt"}, "example": {".js", ".json", ".md"}}
OPTIONAL_FILES = ("README.md", "LICENSE", "CHANGELOG.md")
SOURCE_FILES = ("install.sh", "scripts/build-release.py")


def clean_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    if b"\0" in raw:
        raise ValueError(f"不允许二进制载荷：{path.relative_to(ROOT)}")
    raw.decode("utf-8")  # All shipped files are reviewable UTF-8 text.
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def payload_files() -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for directory, extensions in PAYLOAD_EXTENSIONS.items():
        base = ROOT / directory
        if not base.is_dir() or base.is_symlink():
            raise ValueError(f"缺少普通目录：{directory}/")
        for path in sorted(base.rglob("*")):
            relative = path.relative_to(ROOT).as_posix()
            if path.is_symlink():
                raise ValueError(f"不能打包符号链接：{relative}")
            if path.is_dir():
                continue
            if not path.is_file() or path.suffix not in extensions:
                raise ValueError(f"载荷不在白名单内：{relative}")
            if any(not (c.isascii() and (c.isalnum() or c in "_./-")) for c in relative):
                raise ValueError(f"文件名不在安装器白名单内：{relative}")
            result[relative] = clean_bytes(path)
    if "app/cli.mjs" not in result:
        raise ValueError("缺少 app/cli.mjs")
    return result


def build(output_dir: Path) -> tuple[Path, Path]:
    payload = payload_files()
    manifest = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(payload.items())).encode()
    # Normalize the source payload too, so --source-dir uses the same hashes as
    # the Linux release even if the checkout initially used Windows CRLF.
    for name, data in payload.items():
        path = ROOT / name
        if path.read_bytes() != data:
            path.write_bytes(data)
    (ROOT / MANIFEST).write_bytes(manifest)
    files = {**payload, MANIFEST: manifest}
    for name in SOURCE_FILES:
        path = ROOT / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"缺少构建源文件或源文件是链接：{name}")
        data = clean_bytes(path)
        if path.read_bytes() != data:
            path.write_bytes(data)
        files[name] = data
    for name in OPTIONAL_FILES:
        path = ROOT / name
        if path.exists():
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"文档不是普通文件：{name}")
            files[name] = clean_bytes(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"termux-pi-{VERSION}.tar.gz"
    temporary = archive.with_suffix(".tmp")
    prefix = f"termux-pi-{VERSION}"
    with temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                directories = {prefix}
                for name in files:
                    parts = name.split("/")
                    for i in range(1, len(parts)):
                        directories.add(prefix + "/" + "/".join(parts[:i]))
                for name in sorted(directories):
                    info = tarfile.TarInfo(name + "/")
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    info.mtime = 0
                    tar.addfile(info)
                for name, data in sorted(files.items()):
                    info = tarfile.TarInfo(f"{prefix}/{name}")
                    info.size = len(data)
                    info.mode = 0o755 if name in SOURCE_FILES else 0o644
                    info.mtime = 0
                    tar.addfile(info, io.BytesIO(data))
    os.replace(temporary, archive)
    sums = output_dir / "SHA256SUMS"
    sums.write_bytes(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n".encode())
    return archive, sums


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        for path in build(args.output_dir.resolve()):
            print(path)
    except (ValueError, OSError, UnicodeError) as error:
        parser.exit(1, f"构建失败：{error}\n")
