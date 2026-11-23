#!/bin/bash
# Install the pinned base model and engine on an Apple Silicon Mac. Safe to resume.
set -eu
cd "$(dirname "$0")"
assets="$PWD"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
base="$HOME/hyperflow"
model="$base/models/HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit"
rev=f3083be2f6af4aec06416967381296f7336afe7d
commit=28d95dfc07be2afc4054657ab739feee35536565
[[ "$(uname -m)" == arm64 ]] || { echo "Apple Silicon is required."; exit 1; }
mkdir -p "$model" "$base/work"
for tool in ffmpeg ffprobe; do command -v "$tool" >/dev/null || { echo "Install ffmpeg with Homebrew first."; exit 1; }; done
if [[ ! -x "$base/mlx-serve/zig-out/bin/mlx-serve" ]]; then
  xcrun -f metal >/dev/null
  if [[ ! -d "$base/mlx-serve" ]]; then git clone https://github.com/ddalcu/mlx-serve.git "$base/mlx-serve"; fi
  cd "$base/mlx-serve"
  git fetch origin pull/1169/head
  git switch --detach "$commit"
  git submodule update --init
  ./scripts/fetch-zig.sh
  export PATH="$PWD/.zig-toolchain:$PATH"
  ./scripts/fetch-llama.sh
  ./scripts/build-mlx.sh
  zig build -Doptimize=ReleaseFast
fi
cd "$model"
while read -r hash name; do
  if [[ -f "$name" ]] && echo "$hash  $name" | shasum -a 256 -c - >/dev/null 2>&1; then continue; fi
  curl -fL --retry 4 -C - -o "$name.part" "https://huggingface.co/hancheng-ai/HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit/resolve/$rev/$name"
  echo "$hash  $name.part" | shasum -a 256 -c -
  mv "$name.part" "$name"
done < "$assets/model.sha256"
echo "HyperFlow H3 is ready. Open Start HyperFlow.command."
