"""Create a local Qwen dialogue mix, timed subtitles and an optional dubbed movie."""
import json
import math
import os
from pathlib import Path
import re
from score import write_score
import subprocess
import sys
import tempfile
import uuid

import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model
from opencc import OpenCC

SR = 24000
VOICES = {"driver": ("aiden", .84), "coach": ("uncle_fu", .75), "rival": ("ryan", .91), "rookie": ("serena", 1.04)}
ROOT = Path.home() / "Library/Application Support/OctoRole-TTS/models"


def tc(sample):
    ms = round(sample * 1000 / SR)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def run():
    spec = json.load(sys.stdin)
    lang = spec["language"]
    lines = spec["lines"]
    if lang not in ("cmn", "yue") or not isinstance(lines, list) or not 1 <= len(lines) <= 300:
        raise ValueError("請選擇語言並輸入 1–300 句對白。")
    for i, line in enumerate(lines, 1):
        if line["voice"] not in VOICES or not 1 <= len(line["text"].strip()) <= 180 or not 1 <= len(line["name"].strip()) <= 32:
            raise ValueError(f"第 {i} 句需要角色名、聲線及 1–180 字對白。")
        if line.get("start") is not None and not 0 <= float(line["start"]) <= 1800:
            raise ValueError(f"第 {i} 句開始時間須介乎 0–1800 秒。")
    source = spec.get("video")
    duration = None
    if source:
        if not Path(source).is_absolute() or not Path(source).is_file():
            raise ValueError("請重新選擇原片。")
        duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", source], text=True).strip())
        if not math.isfinite(duration) or not 0 < duration <= 1800:
            raise ValueError("配音支援最長 30 分鐘嘅影片。")
    model = load_model(str(ROOT / lang))
    translate = OpenCC("t2s").convert
    work = Path(sys.argv[1]) / "works"
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".dub-", dir=work) as stage:
        stage = Path(stage)
        folder = stage / ("配音-" + lang + "-" + uuid.uuid4().hex[:12])
        folder.mkdir()
        wav = folder / "dialogue.wav"
        captions = []
        cursor = 0
        with sf.SoundFile(wav, "w", SR, 1, subtype="PCM_16") as audio:
            for i, row in enumerate(lines, 1):
                start = cursor + (round(.18 * SR) if cursor else 0) if row.get("start") is None else round(float(row["start"]) * SR)
                if start < cursor:
                    raise ValueError(f"第 {i} 句同上一句重疊，請延後開始時間或留空自動接續。")
                text = row["text"].strip()
                parts = [x for x in re.findall(r'[^。！？；，,.!?;]{1,40}[。！？；，,.!?;]*', text) if x.strip()]
                if not parts:
                    raise ValueError(f"第 {i} 句缺少可朗讀文字。")
                words = []
                voice, pitch = VOICES[row["voice"]]
                for part in parts:
                    result = next(model.generate_custom_voice(text=translate(part) if lang == "cmn" else part, speaker=voice if lang == "cmn" else "hk_voice_343", language="chinese", max_tokens=max(75, len(part)*9), temperature=.85 if lang=="cmn" else .9))
                    w = np.asarray(result.audio, dtype=np.float32).ravel()
                    active = np.flatnonzero(abs(w) > .008)
                    if not len(active) or not np.isfinite(w).all():
                        raise ValueError(f"第 {i} 句未能產生清晰語音，請重試。")
                    words.append(w[max(0,active[0]-800):active[-1]+1600])
                    words.append(np.zeros(int(SR*.09), np.float32))
                speech = np.concatenate(words[:-1])
                if lang == "yue":
                    # Shift the single Cantonese donor's timbre per role, retaining timing.
                    cmd = ["ffmpeg","-v","error","-f","f32le","-ar",str(SR),"-ac","1","-i","pipe:0","-af",f"asetrate={round(SR*pitch)},aresample={SR},atempo={1/pitch}","-f","f32le","pipe:1"]
                    speech = np.frombuffer(subprocess.run(cmd,input=speech.tobytes(),stdout=subprocess.PIPE,check=True).stdout,dtype="<f4")
                end = start + len(speech)
                if end > round((duration or 1800)*SR):
                    raise ValueError(f"第 {i} 句超出片長，請縮短對白或調早時間。")
                audio.write(np.zeros(start-cursor, np.float32))
                audio.write(speech * min(3, .91/max(.001,float(abs(speech).max()))))
                captions.append(f"{i}\n{tc(start)} --> {tc(end)}\n{row['name']}：{text}")
                cursor = end
            if duration:
                audio.write(np.zeros(round(duration*SR)-cursor,np.float32))
        srt = folder / "dialogue.srt"
        srt.write_text("\n\n".join(captions)+"\n",encoding="utf-8")
        music = spec.get("music", "off")
        if music not in ("off", "score", "file"):
            raise ValueError("Unknown music setting")
        tracks = []
        seconds = duration or cursor / SR
        if music == "score":
            backing = stage / "score.wav"
            write_score(backing, seconds)
            tracks.append((backing, spec.get("musicLevel", 22), True))
        elif music == "file":
            tracks.append((spec.get("musicPath"), spec.get("musicLevel", 22), True))
        if spec.get("ambience"):
            tracks.append((spec["ambience"], spec.get("ambienceLevel", 14), False))
        mix = folder / "mix.wav"
        if tracks:
            cmd = ["ffmpeg","-nostdin","-v","error","-i",wav]
            filters = []
            join = ["[voice]"]
            for idx,(path,level,duck) in enumerate(tracks,1):
                if not path or not Path(path).is_file() or not 0 <= float(level) <= 100:
                    raise ValueError("請選擇有效聲音檔案及音量。")
                cmd.extend(["-stream_loop","-1","-i",path])
                filters.append(f"[{idx}:a:0]aresample=48000,volume={float(level)/100},atrim=duration={seconds:.6f}[bed{idx}]")
                if duck:
                    filters.append(f"[bed{idx}][key]sidechaincompress=threshold=0.025:ratio=6:attack=15:release=350[t{idx}]")
                    join.append(f"[t{idx}]")
                else:
                    join.append(f"[bed{idx}]")
            filters.insert(0, "[0:a]aresample=48000,asplit=2[voice][key]" if music!="off" else "[0:a]aresample=48000[voice]")
            filters.append("".join(join)+f"amix=inputs={len(join)}:normalize=0:duration=first,alimiter=limit=0.94:latency=1[out]")
            subprocess.run([*cmd,"-filter_complex",";".join(filters),"-map","[out]","-ar","48000","-ac","2",mix],check=True)
        else:
            mix = wav
        if source:
            subprocess.run(["ffmpeg","-nostdin","-v","error","-i",source,"-i",mix,"-i",srt,"-map","0:v:0","-map","1:a:0","-map","2:s:0","-map_metadata","-1","-c:v","copy","-c:a","aac","-b:a","160k","-c:s","mov_text","-metadata:s:a:0","language="+lang,"-metadata:s:s:0","language=zho","-disposition:s:0","default","-movflags","+faststart",folder/"dialogue.mp4"],check=True)
        dest = work / folder.name
        folder.rename(dest)
        print(json.dumps({k:str(dest/name) for k,name in {"audio":mix.name,"subtitle":"dialogue.srt",**({"video":"dialogue.mp4"} if source else {})}.items()}))

if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        sys.exit(1)
