#!/bin/bash
# Stage H3 into an unsigned app before running the distribution signing step.
set -euo pipefail
engine=${1:?supply mlx-serve build directory}
app=${2:?supply unsigned staging app}
webp=${3:?supply webp library directory}
macos="$app/Contents/MacOS"
frameworks="$app/Contents/Frameworks"
resources="$app/Contents/Resources"
mkdir -p "$macos" "$frameworks" "$resources"
cp -L "$engine/zig-out/bin/mlx-serve" "$macos/"
for src in "$engine/lib/llama/lib/libllama.dylib" "$engine/lib/mlx/lib/"{libmlx,libmlxc,libjaccl}.dylib "$webp/"{libwebp.7,libsharpyuv.0}.dylib; do
  lib="$frameworks/$(basename "$src")"
  cp -L "$src" "$lib"
  chmod u+w "$lib"
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
  codesign --force --sign - "$lib"
done
cp "$engine/lib/mlx/lib/mlx.metallib" "$resources/"
ln -sfn ../Resources/mlx.metallib "$frameworks/mlx.metallib"
helper="$macos/mlx-serve"
ref=$(otool -L "$helper" | awk '/libwebp\.7\.dylib / {print $1}')
install_name_tool -change "$ref" @rpath/libwebp.7.dylib "$helper"
while IFS= read -r path; do
  if [[ "$path" != '@executable_path/../Frameworks' ]]; then
    install_name_tool -delete_rpath "$path" "$helper"
  fi
done < <(otool -l "$helper" | awk '/cmd LC_RPATH/ {getline; getline; print $2}')
codesign --force --sign - "$helper"
