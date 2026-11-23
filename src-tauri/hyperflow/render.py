"""Render a six-shot landscape film with a local HyperFlow H3 REF2VA server."""
import argparse
import base64
import http.client
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
MODEL = "f3083be2f6af4aec06416967381296f7336afe7d"
WIDTH, HEIGHT, FRAMES, FPS = 1024, 576, 73, 24


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as src:
        for block in iter(lambda: src.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def signature(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:20]


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *args], check=True)


def streams(path):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-of", "json", path]))["streams"]


def validate(path, frames):
    tracks = streams(path)
    video = next(s for s in tracks if s["codec_type"] == "video")
    if (video["width"], video["height"], int(video["nb_frames"])) != (WIDTH, HEIGHT, frames):
        raise ValueError(f"Unexpected geometry or frame count in {path}")
    if not any(s["codec_type"] == "audio" for s in tracks):
        raise ValueError(f"Missing audio track in {path}")


def encode_reference(path):
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def render_shot(port, spec, character, scene, blocking, dest, temp):
    request = dict(prompt=spec["identity"] + "\n" + spec["shot"], width=WIDTH,
                   height=HEIGHT, num_frames=FRAMES, steps=6, seed=spec["seed"],
                   stream=True, ref_images=[encode_reference(character)])
    if scene:
        request["ref_images"].append(encode_reference(scene))
    if blocking:
        vf = f"fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=4"
        ffmpeg("-i", blocking, "-an", "-vf", vf, "-frames:v", str(FRAMES), temp / "frame-%04d.png")
        request["ref_videos"] = [{"frames": [encode_reference(f) for f in sorted(temp.glob("frame-*.png"))]}]
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=7200)
    try:
        connection.request("POST", "/v1/video/generations", json.dumps(request),
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"H3 returned HTTP {response.status}: {response.read(1024).decode(errors='replace')}")
        for line in response:
            if line.startswith(b"data:"):
                event = json.loads(line[5:])
                if event.get("type") == "error":
                    raise RuntimeError(str(event.get("message", "H3 generation failed")))
                if event.get("type") == "complete":
                    break
        else:
            raise RuntimeError("H3 closed the stream before returning a shot")
    finally:
        connection.close()
    raw = temp / "frames.rgb"
    raw.write_bytes(base64.b64decode(event["data"], validate=True))
    if (event["width"], event["height"]) != (WIDTH, HEIGHT) or raw.stat().st_size < WIDTH*HEIGHT*3*FRAMES:
        raise ValueError("H3 returned unexpected frame data")
    inputs = ["-f","rawvideo","-pixel_format","rgb24","-video_size",f"{WIDTH}x{HEIGHT}",
              "-framerate",str(event.get("fps", FPS)),"-i",raw]
    if event.get("audio_data"):
        pcm = temp / "sound.pcm"
        pcm.write_bytes(base64.b64decode(event["audio_data"], validate=True))
        inputs += ["-f","s16le","-ar",str(event.get("sample_rate",32000)),"-ac","2","-i",pcm]
    clip = temp / "clip.mp4"
    ffmpeg(*inputs, "-frames:v", str(FRAMES), "-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-c:a","aac",clip)
    audio = any(s["codec_type"] == "audio" for s in streams(clip))
    inputs = ["-i", clip] if audio else ["-i", clip, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    out = temp / "normalized.mp4"
    ffmpeg(*inputs, "-map", "0:v:0", "-map", "0:a:0" if audio else "1:a:0",
           "-c:v", "copy", "-af", "apad", "-ar", "48000", "-ac", "2",
           "-c:a", "aac", "-t", str(FRAMES / FPS), out)
    validate(out, FRAMES)
    out.replace(dest)


def run(root, project, port):
    character = Path(project.get("character") or HERE / "driver.png")
    scene = Path(project["scene"]) if project.get("scene") else None
    shots = project["shots"]
    motion = project.get("blocking", [""] * 6)
    if len(shots) != 6 or len(motion) != 6 or not all(isinstance(s, str) and s.strip() for s in shots):
        raise ValueError("Provide exactly six shot prompts and six optional rehearsal paths.")
    identity = project["identity"].strip()
    if not identity:
        raise ValueError("Enter a shared character description.")
    cache = root / "hyperflow" / "shots"
    cache.mkdir(parents=True, exist_ok=True)
    character_hash, scene_hash = digest(character), digest(scene) if scene else None
    files = []
    requests = []
    for index, (shot, path) in enumerate(zip(shots, motion), 1):
        spec = dict(model=MODEL, renderer=1, identity=identity, shot=shot, seed=4200+index,
                    character=character_hash, scene=scene_hash, blocking=digest(Path(path)) if path else None,
                    width=WIDTH, height=HEIGHT, frames=FRAMES, steps=6)
        dest = cache / (signature(spec) + ".mp4")
        files.append(dest)
        requests.append((spec, path, dest))
    works = root / "works"
    works.mkdir(exist_ok=True)
    film = works / ("HyperFlow-six-shots-" + signature([[p.stem for p in files], project.get("captions")]) + ".mp4")
    # Publish the plan before GPU work starts. Only finalized clips exist at these paths.
    plan = [{"label": "HyperFlow H3", "steps": [[str(p.relative_to(root))] for p in files],
             "outputs": [str(film.relative_to(root))]}]
    pending = cache.parent / "production-plan.tmp"
    pending.write_text(json.dumps(plan))
    pending.replace(cache.parent / "production-plan.json")
    server_checked = False
    for index, (spec, path, dest) in enumerate(requests, 1):
        if dest.exists():
            validate(dest, FRAMES)
            print(f"Shot {index}/6 • using saved clip", flush=True)
            continue
        if not server_checked:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=8) as response:
                    models = json.load(response).get("data", [])
            except OSError as error:
                raise ValueError("Start the local HyperFlow engine and wait for it to load, then render again.") from error
            if not any(m.get("id") == "HyperFlow-H3-Flash-REF2VA-MLX-Serve-8bit" for m in models):
                raise ValueError("Port 18731 must serve the base HyperFlow H3 Flash REF2VA 8-bit model.")
            server_checked = True
        print(f"Shot {index}/6 • rendering", flush=True)
        with tempfile.TemporaryDirectory(dir=cache) as tmp:
            render_shot(port, spec, character, scene, path, dest, Path(tmp))
    with tempfile.TemporaryDirectory(dir=works) as tmp:
        temp = Path(tmp)
        # Reassemble decoded audio on an exact timeline (each AAC file has encoder priming).
        args, parts = [], []
        for i, clip in enumerate(files):
            args += ["-i", clip]
            parts.append(f"[{i}:a]atrim=end_sample={FRAMES * 48000 // FPS},asetpts=PTS-STARTPTS[a{i}]")
        parts.append("".join(f"[{i}:v][a{i}]" for i in range(6))+"concat=n=6:v=1:a=1[v][a]")
        out = temp / "film.mp4"
        subs = []
        captions = project.get("captions")
        if captions and len(captions) == 6:
            def stamp(frame):
                ms = round(frame * 1000 / FPS)
                return f"00:00:{ms // 1000:02},{ms % 1000:03}"
            subtitles = temp / "captions.srt"
            subtitles.write_text("\n\n".join(
                f"{i+1}\n{stamp(i*FRAMES)} --> {stamp((i+1)*FRAMES)}\n{line}"
                for i, line in enumerate(captions)))
            args += ["-i", subtitles]
            subs = ["-map", "6:s:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=yue",
                    "-disposition:s:0", "default"]
        ffmpeg(*args, "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]", *subs,
               "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac",
               "-movflags", "+faststart", out)
        validate(out, FRAMES * 6)
        side = temp / "meta.json"
        side.write_text(json.dumps(dict(created=int(time.time()), recipe="HyperFlow H3",
                                         values={"character": str(character), "shots": shots},
                                         project=project, clips=[str(p) for p in files]), indent=2))
        side.replace(Path(str(film)+".json"))
        out.replace(film)
    print(film, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home() / "OctoRole")
    parser.add_argument("--project", default=str(HERE / "story.json"), help="Story JSON file, or - for stdin")
    parser.add_argument("--port", type=int, default=18731)
    args = parser.parse_args()
    os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")
    try:
        args.root.mkdir(parents=True, exist_ok=True)
        with (args.root / ".hyperflow.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            project = json.load(sys.stdin) if args.project == "-" else json.loads(Path(args.project).read_text())
            run(args.root, project, args.port)
    except BlockingIOError:
        sys.exit("A HyperFlow render is already running in this library.")
    except Exception as exc:
        sys.exit(str(exc))
