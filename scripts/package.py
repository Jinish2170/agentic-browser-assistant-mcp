"""Package reviewed project paths, never local accounts, secrets or raw artifacts."""

import hashlib
import json
import stat
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DIRECTORIES = ("extension", "server", "shared", "scripts", "skills", "tests", "docs")
FILES = ("README.md", "package.json", "package-lock.json", ".gitignore", ".prettierignore")
ALLOWED = {".mjs", ".js", ".json", ".md", ".html", ".css", ".png", ".woff2", ".txt", ".py"}


def reviewed_files(directory):
    for item in sorted(directory.rglob("*")):
        if item.is_symlink():
            raise RuntimeError(f"Refusing symbolic link: {item.relative_to(ROOT)}")
        if any(part.startswith(".") or part in {"__pycache__", "node_modules", "artifacts"}
               for part in item.relative_to(directory).parts):
            continue
        if item.is_file() and item.suffix in ALLOWED:
            yield item


def write_archive(destination, entries):
    temporary = destination.with_suffix(".zip.tmp")
    with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for item, name in sorted(entries, key=lambda entry: entry[1]):
            if item.is_symlink():
                raise RuntimeError(f"Refusing symbolic link: {item}")
            info = ZipInfo(name, date_time=(2026, 10, 5, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, item.read_bytes(), compresslevel=9)
    with ZipFile(temporary) as archive:
        if archive.testzip():
            raise RuntimeError("Archive integrity check failed")
        if any(part in {".local", "artifacts", "node_modules", ".env"}
               for name in archive.namelist() for part in Path(name).parts):
            raise RuntimeError("Private path in archive")
    temporary.replace(destination)
    return {
        "file": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    }


version = json.loads((ROOT / "package.json").read_text())["version"]
manifest = DIST / "extension" / "manifest.json"
assert json.loads(manifest.read_text())["version"] == version, "Rebuild extension before packaging"
DIST.mkdir(exist_ok=True)
source = [(ROOT / file, f"jev-browser/{file}") for file in FILES]
for directory in DIRECTORIES:
    source.extend((item, f"jev-browser/{item.relative_to(ROOT).as_posix()}")
                  for item in reviewed_files(ROOT / directory))
extension = [(item, item.relative_to(DIST / "extension").as_posix())
             for item in reviewed_files(DIST / "extension")]
packages = [write_archive(DIST / "jev-browser-extension.zip", extension),
            write_archive(DIST / "jev-browser-source.zip", source)]
report = {"version": version, "packages": packages}
(DIST / "release.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
