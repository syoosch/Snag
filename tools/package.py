"""Build Snag from its runtime files, using only local tools."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = (
    "*.html", "_locales/*/messages.json", "catch-script/*.js", "css/*.css",
    "img/*.png", "img/*.svg", "js/*.js", "lib/*.js", "lib/third-party-libraries.md",
    "lib/ffmpeg/*.js", "lib/ffmpeg/*.wasm", "lib/ffmpeg/LICENSE*.txt",
)


def build(browser, destination, signing_key):
    subprocess.run(["node", str(ROOT / "tools/check-dependencies.js")], check=True)
    manifest = ROOT / ("manifest.firefox.json" if browser == "firefox" else "manifest.json")
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    name = f"snag-{version}" + ("-firefox" if browser == "firefox" else "")
    destination.mkdir(parents=True, exist_ok=True)
    files = [(manifest, "manifest.json"), (ROOT / "LICENSE", "LICENSE")]
    for pattern in PACKAGE_FILES:
        for item in sorted(ROOT.glob(pattern)):
            if item.is_file() and not item.name.startswith("."):
                files.append((item, item.relative_to(ROOT).as_posix()))

    with tempfile.TemporaryDirectory(dir=destination) as temp:
        temp = Path(temp)
        archive = temp / (name + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for source, target in files:
                output.write(source, target)
        if signing_key:
            signer = shutil.which("crx3")
            if not signer or not signing_key.is_file():
                raise SystemExit("CRX signing requires a local crx3 executable and an existing private key.")
            stage = temp / "extension"
            with zipfile.ZipFile(archive) as package:
                package.extractall(stage)
            signed = temp / (name + ".crx")
            subprocess.run([signer, "-p", str(signing_key.resolve()), "-o", str(signed), str(stage)], check=True)
            os.replace(signed, destination / signed.name)
        os.replace(archive, destination / archive.name)
        print(destination / archive.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--key", type=Path, help="Also sign the Chromium package with this existing key")
    args = parser.parse_args()
    if args.key and args.browser != "chromium":
        parser.error("CRX signing is only available for Chromium.")
    build(args.browser, args.output.resolve(), args.key)
