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


def signing_identifier(path):
    # Some command-line tools and libraries embed their own bundle Info.plist.
    dump = subprocess.check_output(["otool", "-arch", "arm64", "-P", str(path)])
    marker = b"(__TEXT,__info_plist) section\n"
    if marker not in dump:
        return path.name
    data = dump.split(marker, 1)[1].strip(b"\x00\r\n ")
    return plistlib.loads(data).get("CFBundleIdentifier", path.name)


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
                        "--identifier", signing_identifier(path),
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
