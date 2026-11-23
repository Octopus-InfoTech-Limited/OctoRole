#!/bin/bash
set -eu
cd "$HOME/hyperflow/mlx-serve"
if curl -fsS --max-time 4 http://127.0.0.1:18731/v1/models | grep -q 'HyperFlow-H3-Flash'; then
  echo 'HyperFlow is already available on port 18731.'
  exit 0
fi
export MLX_SERVE_H3_RESIDENT=0
exec ./zig-out/bin/mlx-serve --model "$HOME/hyperflow/models/HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit" --serve --host 127.0.0.1 --port 18731
