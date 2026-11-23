#!/bin/bash
# OctoRole recipe setup: ComfyUI at a pinned commit, in its own Python
# environment, reading models from the shared OctoRole models folder.
# Safe to re-run; finished steps are skipped.
set -euo pipefail

APP_DIR="" MODELS_DIR="" TOOLS_DIR="" COMFY_COMMIT="" UV_VERSION="" PYTHON="3.12" PORT="8188"
while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --models-dir) MODELS_DIR="$2"; shift 2 ;;
    --tools-dir) TOOLS_DIR="$2"; shift 2 ;;
    --comfy-commit) COMFY_COMMIT="$2"; shift 2 ;;
    --uv-version) UV_VERSION="$2"; shift 2 ;;
    --python) PYTHON="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
for v in APP_DIR MODELS_DIR TOOLS_DIR COMFY_COMMIT UV_VERSION; do
  [ -n "${!v}" ] || { echo "missing --$(echo "$v" | tr 'A-Z_' 'a-z-')" >&2; exit 2; }
done

step() { echo "==> $*"; }

mkdir -p "$APP_DIR" "$MODELS_DIR" "$TOOLS_DIR/bin"

# 1. uv (Python manager), pinned, kept inside the OctoRole tools folder.
UV="$TOOLS_DIR/bin/uv"
if ! { [ -x "$UV" ] && "$UV" --version 2>/dev/null | grep -q "uv $UV_VERSION"; }; then
  step "Installing uv $UV_VERSION"
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" \
    | env UV_INSTALL_DIR="$TOOLS_DIR/bin" UV_NO_MODIFY_PATH=1 sh
fi
export UV_PYTHON_INSTALL_DIR="$TOOLS_DIR/python"
export UV_CACHE_DIR="$TOOLS_DIR/uv-cache"

# 2. ComfyUI source at the pinned commit.
SRC="$APP_DIR/ComfyUI"
if [ ! -d "$SRC/.git" ]; then
  step "Fetching ComfyUI"
  rm -rf "$SRC"
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/comfyanonymous/ComfyUI.git
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" != "$COMFY_COMMIT" ]; then
  step "Checking out ComfyUI $COMFY_COMMIT"
  git -C "$SRC" fetch -q --depth 1 origin "$COMFY_COMMIT"
  git -C "$SRC" checkout -q --detach FETCH_HEAD
fi

# 3. Python environment.
VENV="$APP_DIR/venv"
if [ ! -x "$VENV/bin/python" ]; then
  step "Creating Python $PYTHON environment"
  "$UV" venv --python "$PYTHON" "$VENV"
fi
step "Installing Python packages (first run takes a few minutes)"
"$UV" pip install --python "$VENV/bin/python" torch torchvision torchaudio
"$UV" pip install --python "$VENV/bin/python" -r "$SRC/requirements.txt"

# 4. Point ComfyUI at the shared models folder.
cat > "$APP_DIR/extra_model_paths.yaml" <<YAML
octorole:
  base_path: "$MODELS_DIR"
  checkpoints: checkpoints
  vae: vae
  loras: loras
  text_encoders: text_encoders
  diffusion_models: diffusion_models
  clip_vision: clip_vision
  controlnet: controlnet
  upscale_models: upscale_models
YAML

# 5. Start script. Listens on this Mac only.
cat > "$APP_DIR/start.sh" <<SH
#!/bin/bash
set -euo pipefail
cd "$SRC"
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec "$VENV/bin/python" main.py --listen 127.0.0.1 --port "\${PORT:-$PORT}" \\
  --extra-model-paths-config "$APP_DIR/extra_model_paths.yaml"
SH
chmod +x "$APP_DIR/start.sh"

step "Checking the environment"
"$VENV/bin/python" -c "import torch; print('torch', torch.__version__, 'mps', torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False)"
step "Done"
