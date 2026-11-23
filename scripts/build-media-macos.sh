#!/bin/bash
# Run on the build Mac with an unpacked FFmpeg source release.
set -euo pipefail
source_dir=$(cd "${1:?FFmpeg source}" && pwd)
contents=$(cd "${2:?staging Contents directory}" && pwd)
work=$(mktemp -d)
cd "$work"
"$source_dir/configure" --prefix="$work/install" --disable-autodetect --disable-doc --disable-debug --disable-ffplay --disable-network --disable-static --enable-shared --enable-videotoolbox --enable-audiotoolbox --install-name-dir=@rpath >configure.log 2>&1
make -j8 >build.log 2>&1
make install >install.log 2>&1
mkdir -p "$contents/MacOS" "$contents/Frameworks" "$contents/Resources/licenses/ffmpeg"
for helper in ffmpeg ffprobe; do
  dest="$contents/MacOS/$helper"
  cp "$work/install/bin/$helper" "$dest"
  install_name_tool -add_rpath @executable_path/../Frameworks "$dest"
  codesign --force --sign - "$dest"
done
for lib in "$work/install/lib/"*.dylib; do
  [[ -L "$lib" ]] && continue
  id=$(otool -D "$lib" | tail -1)
  dest="$contents/Frameworks/${id##*/}"
  cp "$lib" "$dest"
  codesign --force --sign - "$dest"
done
cp "$source_dir/COPYING.LGPLv2.1" "$contents/Resources/licenses/ffmpeg/"
