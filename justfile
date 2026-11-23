default:
    @just --list

validate:
    node tools/check-dependencies.js

build-zip:
    python tools/package.py

build-firefox:
    python tools/package.py --browser firefox

# Optional signing uses a locally installed crx3 and the owner's existing key.
build-crx key="private-key.pem":
    python tools/package.py --key "{{key}}"

quick: build-zip

build: build-zip build-firefox

release: build

version:
    node -p "require('./manifest.json').version"
