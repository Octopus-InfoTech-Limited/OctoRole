#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
root="$HOME/Library/Application Support/OctoRole-TTS"
mkdir -p "$root/bin" "$root/models"
if [ -x "$root/bin/uv" ]; then uv="$root/bin/uv"; else uv=$(command -v uv || true); fi
if [ -z "$uv" ]; then
  curl -fsSL https://astral.sh/uv/0.11.21/install.sh | env UV_INSTALL_DIR="$root/bin" UV_NO_MODIFY_PATH=1 sh
  uv="$root/bin/uv"
fi
"$uv" venv --allow-existing --python 3.11 "$root/env"
py="$root/env/bin/python"
"$uv" pip install --python "$py" mlx-audio==0.4.3 mlx==0.31.2 mlx-lm==0.31.2 transformers==5.9.0 soundfile sentencepiece opencc-python-reimplemented
if [ ! -f "$root/models/yue/config.json" ]; then "$uv" pip install --python "$py" torch; fi
"$py" setup_models.py
echo "Qwen3-TTS ready."
