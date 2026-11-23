"""Translate local Qwen output to the editable OctoRole scene format."""
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request as request


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


http = request.build_opener(request.ProxyHandler({}), NoRedirect())
PROMPT = """You are a film previs director. Return one JSON object, with no markdown.
Required keys: title (string), action (string), actors (array of objects), camera (array).
Each actor has name (string), pose (string), positions (three numeric arrays of length two).
Use distinct tracks and start positions for different actors; allow a meeting only when it fits the action.
Plan actual spatial staging: a hairpin has a bend, an overtake exchanges the longitudinal lead, and a high angle raises the camera.
Write names and action in Traditional Chinese. Plan 1 to 3 actors. Plan three [x,z] positions per actor (start, midpoint, end, metres).
Choose pose stand/sit/crouch/cheer/wave/point/lie. Camera rows are [x,y,z,targetX,targetY,targetZ,fov]. Use the requested camera angle and keep subjects in view."""


def api(url, key=None, body=None, timeout=8):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = request.Request(url, data=json.dumps(body).encode() if body else None, headers=headers)
    with http.open(req, timeout=timeout) as response:
        return json.load(response)


def select_model(models):
    excluded = ("asr", "embed", "rerank", "tts", "image", "coder", "vl-")
    ids = [m["id"] for m in models["data"] if "qwen" in m["id"].lower()
           and not any(x in m["id"].lower() for x in excluded)]
    if not ids:
        raise ValueError("本機服務冇提供 Qwen 文字模型。")
    return next((m for m in ids if "qwen3.6-35b-a3b" in m.lower()), ids[0])


def backend():
    url = "http://127.0.0.1:19435/v1"
    try:
        return url, None, select_model(api(url + "/models", timeout=2))
    except (OSError, ValueError, KeyError):
        pass
    settings = Path.home() / ".omlx/settings.json"
    if settings.is_file():
        conf = json.loads(settings.read_text())
        port = int(conf.get("server", {}).get("port", 8000))
        if not 1 <= port <= 65535:
            raise ValueError("oMLX 埠號無效。")
        url = f"http://127.0.0.1:{port}/v1"
        key = conf.get("auth", {}).get("api_key")
        try:
            models = api(url + "/models", key)
        except urllib.error.HTTPError:
            raise ValueError("請檢查 oMLX 本機服務嘅 API 授權。") from None
        except OSError:
            if Path("/Applications/oMLX.app").is_dir():
                subprocess.run(["/usr/bin/open", "-gj", "/Applications/oMLX.app"], check=True)
                for _ in range(20):
                    time.sleep(1)
                    try:
                        models = api(url + "/models", key, timeout=2)
                        break
                    except OSError:
                        continue
                else:
                    raise ValueError("請啟動 oMLX，再試一次。")
            else:
                raise ValueError("請啟動 oMLX，再試一次。")
        return url, key, select_model(models)
    raise ValueError("請啟動呢部 Mac 嘅本機 Qwen 服務（MLX 埠 19435 或 oMLX），再撳生成。")


def scene_from(raw, seconds):
    if not isinstance(raw, dict) or not isinstance(raw.get("title"), str):
        raise ValueError("場景名稱格式無效")
    def number(value,low,high):
        value=float(value)
        if not math.isfinite(value):raise ValueError('無效座標')
        return max(low,min(value,high))
    name=re.sub(r'[\\/:*?"<>|\x00-\x1f]','',raw['title']).strip(' .')[:32] or '新鏡頭'
    name='Qwen '+name
    scene=dict(version=1,name=name,duration=seconds,fps=24,aspect='16:9',setting=str(raw['action'])[:400],
               style='本機 Qwen 預演',actors=[],props=[],ground='#525962',sky='#cfd8e6',
               camera={'follow':'','ease':'smooth','keys':[]})
    for i,a in enumerate(raw['actors'][:3]):
        locations=a['positions']
        if not isinstance(locations,list) or len(locations)!=3:raise ValueError('角色需要三個位置')
        keys=[]
        for j,v in enumerate(locations):
            if not isinstance(v,list) or len(v) not in (2,3):raise ValueError('無效角色座標')
            keys.append(dict(t=j*seconds/2,x=number(v[0],-50,50),z=number(v[-1],-50,50),
                             face=None,pose=a.get('pose') if a.get('pose') in ('stand','sit','cheer','crouch','wave','point','lie') else 'stand'))
        scene['actors'].append(dict(id='actor'+str(i),name=str(a['name'])[:40],height=1.7,about='',
                                    color=['#ed5345','#4a9dd1','#d7ba4a'][i],keys=keys))
    tracks = [tuple((k["x"], k["z"]) for k in a["keys"]) for a in scene["actors"]]
    if len(set(tracks)) != len(tracks):
        raise ValueError("角色走位完全重疊")
    if not scene['actors'] or len(raw['camera'])!=2:raise ValueError('缺少角色或鏡頭')
    for i,row in enumerate(raw['camera']):
        if len(row)!=7:raise ValueError('無效鏡頭座標')
        limits=[(-80,80),(.1,60),(-80,80),(-80,80),(0,40),(-80,80),(10,100)]
        vals=[number(v,*limit) for v,limit in zip(row,limits)]
        scene['camera']['keys'].append(dict(zip(['x','y','z','tx','ty','tz','fov'],vals),t=i*seconds))
    return scene


def main():
    p = json.load(sys.stdin)
    seconds, description = p["seconds"], p["description"].strip()
    if not isinstance(seconds, int) or not 1 <= seconds <= 60 or not 1 <= len(description) <= 2000:
        raise ValueError("請輸入 1–2000 字描述，同埋 1–60 秒長度。")
    url, key, model = backend()
    messages = [{"role":"system","content":PROMPT},{"role":"user","content":f"Duration {seconds}s. {description}"}]
    for attempt in range(2):
        body = {"model":model,"messages":messages,"max_tokens":2400,"temperature":0.3,
                "chat_template_kwargs":{"enable_thinking":False}}
        response = api(url + "/chat/completions", key, body, timeout=240)
        try:
            content = response["choices"][0]["message"]["content"].split("</think>")[-1]
            raw = json.loads(content[content.index("{"):content.rindex("}") + 1])
            result = scene_from(raw, seconds)
            result["style"] = "本機 Qwen · " + model.split("/")[-1]
            print(json.dumps(result, ensure_ascii=False, allow_nan=False))
            return
        except (TypeError, ValueError, KeyError, IndexError, AttributeError):
            if attempt:
                raise ValueError("Qwen 兩次回覆嘅鏡頭格式都未能載入。請簡化動作再試。") from None
            messages.append({"role":"user","content":"Regenerate from the schema exactly. positions is a list of three numeric pairs, camera is two lists of seven numbers."})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.exit(str(exc))
