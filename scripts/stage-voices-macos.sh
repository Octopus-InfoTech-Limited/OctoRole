#!/bin/bash
set -euo pipefail
contents=${1:?staging app Contents directory}
python_build=${2:?redistributable standalone Python 3.11}
voices_env=${3:?matching Python 3.11 MLX Audio environment}
models=${4:?validated Mandarin and Cantonese model folder}
resources="$contents/Resources"
runtime="$resources/python"
mkdir -p "$runtime" "$resources/voices"
rsync -a --exclude __pycache__ --exclude '*.pyc' --exclude tkinter --exclude test/ "$python_build/" "$runtime/"
rsync -a --exclude __pycache__ --exclude '*.pyc' --exclude _virtualenv.pth --exclude _virtualenv.py "$voices_env/lib/python3.11/site-packages/" "$runtime/lib/python3.11/site-packages/"
install_name_tool -id @rpath/libpython3.11.dylib "$runtime/lib/libpython3.11.dylib"
codesign --force --sign - "$runtime/lib/libpython3.11.dylib"
for language in cmn yue; do
  test -s "$models/$language/model.safetensors"
  test -s "$models/$language/speech_tokenizer/model.safetensors"
  mkdir -p "$resources/voices/$language"
  rsync -aL --exclude .cache "$models/$language/" "$resources/voices/$language/"
done
