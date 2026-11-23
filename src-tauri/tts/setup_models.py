"""Install pinned Mandarin and Cantonese voices for offline use on Apple Silicon."""
import fcntl
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
from huggingface_hub import snapshot_download

root = Path.home() / "Library/Application Support/OctoRole-TTS/models"
root.mkdir(parents=True, exist_ok=True)
with (root / ".setup.lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if not (root / "cmn/model.safetensors").exists() or not (root / "cmn/speech_tokenizer/model.safetensors").exists():
        with tempfile.TemporaryDirectory(dir=root) as temp:
            target = Path(temp) / "cmn"
            snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit", revision="f35faf19b0cc2160865af64ecf0f22f83d335135", local_dir=target)
            target.rename(root / "cmn")
    if not (root / "yue/config.json").exists():
        base = snapshot_download("Qwen/Qwen3-TTS-12Hz-1.7B-Base", revision="fd4b254389122332181a7c3db7f27e918eec64e3")
        adapter = Path(snapshot_download("jmtl/hk-cantonese-cc0-qwen3-tts", revision="bdafaee1255c734334f048f750a6a865eed37d84", allow_patterns=["adapter*", "extra_tensors*", "scripts/apply_adapter.py", "LICENSE", "NOTICE"]))
        builder = adapter / "scripts/apply_adapter.py"
        if hashlib.sha256(builder.read_bytes()).hexdigest() != "c3d8bfd5a88d7793f904842370c169d98edaac66d1b7fc9e747fd4fad50e09d2":
            raise RuntimeError("Unexpected voice model builder")
        with tempfile.TemporaryDirectory(dir=root) as temp:
            target = Path(temp) / "yue"
            subprocess.run([sys.executable, builder, "--base", base, "--adapter", adapter, "--out", target], check=True)
            target.rename(root / "yue")
