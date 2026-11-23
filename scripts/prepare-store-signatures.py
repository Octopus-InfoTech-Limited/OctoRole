#!/usr/bin/env python3
"""Set the signing identifiers that Xcode preserves during cloud distribution signing."""
import argparse
import plistlib
import subprocess
from pathlib import Path

MACHO_HEADERS = {
    bytes.fromhex(value)
    for value in ("feedface", "feedfacf", "cefaedfe", "cffaedfe",
                  "cafebabe", "bebafeca", "cafebabf", "bfbafeca")
}


def prepare(app, identity):
    contents = app / "Contents"
    info = plistlib.loads((contents / "Info.plist").read_bytes())
    main = contents / "MacOS" / info["CFBundleExecutable"]
    for path in contents.rglob("*"):
        if path == main or path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as binary:
            if binary.read(4) not in MACHO_HEADERS:
                continue
        subprocess.run(["codesign", "--force", "--sign", identity,
                        "--identifier", path.name,
                        "--preserve-metadata=entitlements,flags,runtime",
                        str(path)], check=True)
    subprocess.run(["codesign", "--force", "--sign", identity,
                    "--identifier", info["CFBundleIdentifier"],
                    "--preserve-metadata=entitlements,flags,runtime",
                    str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("identity", help="Company Apple Development signing identity")
    args = parser.parse_args()
    prepare(args.app, args.identity)
