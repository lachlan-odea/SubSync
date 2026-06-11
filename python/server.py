"""
SubSync Backend Server
Calls sync.py (direct Whisper) instead of anchor-sub-sync CLI.
Whisper models are downloaded on-demand to APPDATA/SubSync/models/
"""
import os
import sys
import re
import uuid
import threading
import subprocess
import urllib.request
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PORT        = int(os.environ.get('SUBSYNC_PORT', 57832))
FFMPEG_PATH = os.environ.get('FFMPEG_PATH', 'ffmpeg')

MODELS_DIR = Path(os.environ.get('APPDATA', Path.home() / 'AppData' / 'Roaming')) / 'SubSync' / 'models'
MODELS_DIR.mkdir(parents=True, exist_ok=True)

WHISPER_MODELS = {
    'tiny':   {
        'url':  'https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9/tiny.pt',
        'file': 'tiny.pt',
        'size': 75_571_200,
    },
    'small':  {
        'url':  'https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794/small.pt',
        'file': 'small.pt',
        'size': 483_491_840,
    },
    'medium': {
        'url':  'https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt',
        'file': 'medium.pt',
        'size': 1_528_006_656,
    },
    'large':  {
        'url':  'https://openaipublic.azureedge.net/main/whisper/models/e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb/large-v3.pt',
        'file': 'large-v3.pt',
        'size': 3_087_371_264,
    },
}

jobs      = {}
jobs_lock = threading.Lock()


# ── Resolve all paths at startup (absolute, no cwd dependency) ────────────

# Directory containing this script
_HERE = Path(__file__).resolve().parent

# Python executable — prefer the venv that launched us, then look for siblings
def _find_python():
    candidates = [
        _HERE / 'Scripts' / 'python.exe',           # packaged bundle
        _HERE / 'venv'    / 'Scripts' / 'python.exe', # dev venv inside python/
        _HERE.parent      / 'python'  / 'venv' / 'Scripts' / 'python.exe', # project root layout
        Path(sys.executable),                         # already-running interpreter
    ]
    for c in candidates:
        if c.exists():
            print(f'[server] Using Python: {c}', flush=True)
            return str(c)
    print(f'[server] Fallback Python: {sys.executable}', flush=True)
    return sys.executable

_PYTHON_EXE  = _find_python()
_SYNC_SCRIPT = str(_HERE / 'sync.py')

# ffmpeg — resolve once at startup so we always have an absolute path
def _find_ffmpeg():
    # 1. Explicit env var from Electron
    env_path = os.environ.get('FFMPEG_PATH', '').strip()
    if env_path and Path(env_path).exists():
        print(f'[server] ffmpeg (env): {env_path}', flush=True)
        return env_path
    # 2. Alongside this script (bundled)
    local = _HERE / 'ffmpeg.exe'
    if local.exists():
        print(f'[server] ffmpeg (local): {local}', flush=True)
        return str(local)
    # 3. In PATH
    import shutil
    found = shutil.which('ffmpeg')
    if found:
        print(f'[server] ffmpeg (PATH): {found}', flush=True)
        return found
    print('[server] WARNING: ffmpeg not found!', flush=True)
    return 'ffmpeg'

_FFMPEG_EXE = _find_ffmpeg()


# ── Helpers ────────────────────────────────────────────────────────────────

def get_python_exe():
    return _PYTHON_EXE

def get_sync_script():
    return _SYNC_SCRIPT

def model_path(name):
    info = WHISPER_MODELS.get(name)
    return (MODELS_DIR / info['file']) if info else None

def model_is_cached(name):
    p = model_path(name)
    return p is not None and p.exists() and p.stat().st_size > 1_000_000

def build_env():
    env = os.environ.copy()
    ffmpeg_dir = str(Path(_FFMPEG_EXE).parent)
    env['PATH'] = ffmpeg_dir + os.pathsep + env.get('PATH', '')
    env['PYTHONUNBUFFERED'] = '1'
    return env


def parse_progress(line):
    lower = line.lower()
    if 'parsing subtitle'  in lower: return 5
    if 'extracting audio'  in lower: return 10
    if 'loading whisper'   in lower: return 15
    if 'transcribing'      in lower: return 20
    if 'transcription comp' in lower: return 70
    if 'aligning'          in lower: return 80
    if 'writing output'    in lower: return 92
    if 'done'              in lower: return 98
    m = re.search(r'(\d+)%', line)
    return int(m.group(1)) if m else None


# ── Model download ─────────────────────────────────────────────────────────

def _download_model(model_name, job_id):
    info = WHISPER_MODELS[model_name]
    dest = MODELS_DIR / info['file']
    tmp  = dest.with_suffix('.part')
    try:
        with jobs_lock:
            jobs[job_id].update(status='running', progress=0, message='Connecting...')

        req = urllib.request.Request(info['url'], headers={'User-Agent': 'SubSync/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            total      = int(resp.headers.get('Content-Length', info['size']) or info['size'])
            downloaded = 0
            with open(tmp, 'wb') as f:
                while True:
                    buf = resp.read(131072)
                    if not buf:
                        break
                    f.write(buf)
                    downloaded += len(buf)
                    pct = min(99, int(downloaded / total * 100))
                    with jobs_lock:
                        jobs[job_id].update(
                            progress=pct,
                            message=f'Downloading {model_name} — {downloaded/1048576:.0f} / {total/1048576:.0f} MB',
                        )

        tmp.rename(dest)
        with jobs_lock:
            jobs[job_id].update(status='done', progress=100, message=f'{model_name} model ready')

    except Exception as e:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        with jobs_lock:
            jobs[job_id].update(status='error', message=str(e))


# ── Sync runner ────────────────────────────────────────────────────────────

def _run_sync(video_path, subtitle_path, output_path, model, job_id):
    """Spawn sync.py as a subprocess and stream its stdout as progress."""
    cmd = [
        get_python_exe(), get_sync_script(),
        '--video',     video_path,
        '--subtitle',  subtitle_path,
        '--output',    output_path,
        '--model',     model,
        '--model-dir', str(MODELS_DIR),
        '--ffmpeg',    _FFMPEG_EXE,
    ]
    print(f'[server] Running sync cmd: {cmd[0]} {cmd[1]}', flush=True)
    print(f'[server] ffmpeg: {_FFMPEG_EXE}', flush=True)

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=build_env(),
            cwd=str(_HERE),         # always run from the python/ directory
        )
        lines = []
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            lines.append(line)
            pct = parse_progress(line)
            with jobs_lock:
                jobs[job_id]['message'] = line.replace('[sync] ', '')
                if pct is not None:
                    jobs[job_id]['progress'] = pct

        proc.wait()
        with jobs_lock:
            if proc.returncode == 0 and Path(output_path).exists():
                jobs[job_id].update(status='done', progress=100,
                                    message='Sync complete', output_path=output_path)
            else:
                jobs[job_id].update(status='error',
                                    message='\n'.join(lines[-8:]) or 'Unknown error')
    except Exception as e:
        print(f'[server] _run_sync exception: {e}', flush=True)
        with jobs_lock:
            jobs[job_id].update(status='error', message=str(e))


# ── Routes ─────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'ok': True, 'version': '1.2.0'})


@app.route('/models', methods=['GET'])
def list_models():
    return jsonify({
        name: {
            'cached':   model_is_cached(name),
            'size_mb':  round(info['size'] / 1_048_576),
            'file':     info['file'],
        }
        for name, info in WHISPER_MODELS.items()
    })


@app.route('/models/<model_name>/download', methods=['POST'])
def download_model(model_name):
    if model_name not in WHISPER_MODELS:
        return jsonify({'error': f'Unknown model: {model_name}'}), 400
    if model_is_cached(model_name):
        return jsonify({'status': 'already_cached'})
    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {'type': 'download', 'model': model_name,
                        'status': 'running', 'progress': 0, 'message': 'Starting...'}
    threading.Thread(target=_download_model, args=(model_name, job_id), daemon=True).start()
    return jsonify({'job_id': job_id})


@app.route('/models/<model_name>/delete', methods=['POST'])
def delete_model(model_name):
    p = model_path(model_name)
    if p and p.exists():
        p.unlink()
    return jsonify({'ok': True})


@app.route('/sync/auto', methods=['POST'])
def sync_auto():
    data          = request.json or {}
    video_path    = data.get('video_path')
    subtitle_path = data.get('subtitle_path')
    output_path   = data.get('output_path')
    model         = data.get('model', 'small')

    if not all([video_path, subtitle_path, output_path]):
        return jsonify({'error': 'Missing required fields'}), 400
    if not model_is_cached(model):
        return jsonify({'error': 'model_not_cached', 'model': model}), 428

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {'type': 'sync', 'status': 'running', 'progress': 0,
                        'message': 'Starting sync...', 'output_path': None}

    threading.Thread(
        target=_run_sync,
        args=(video_path, subtitle_path, output_path, model, job_id),
        daemon=True,
    ).start()
    return jsonify({'job_id': job_id})


@app.route('/sync/from-docx', methods=['POST'])
def sync_from_docx():
    """AI Auto-Sync: build a new SRT from a Word document + video using Whisper alignment."""
    data        = request.json or {}
    video_path  = data.get('video_path')
    docx_path   = data.get('docx_path')
    output_path = data.get('output_path')
    model       = data.get('model', 'small')
    max_words   = int(data.get('max_words', 8))
    min_words   = int(data.get('min_words', 3))

    if not all([video_path, docx_path, output_path]):
        return jsonify({'error': 'Missing required fields'}), 400
    if not model_is_cached(model):
        return jsonify({'error': 'model_not_cached', 'model': model}), 428
    if not Path(docx_path).exists():
        return jsonify({'error': f'Word document not found: {docx_path}'}), 400

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {'type': 'docx_sync', 'status': 'running', 'progress': 0,
                        'message': 'Reading Word document...', 'output_path': None}

    threading.Thread(
        target=_run_docx_sync,
        args=(video_path, docx_path, output_path, model, max_words, min_words, job_id),
        daemon=True,
    ).start()
    return jsonify({'job_id': job_id})


def _run_docx_sync(video_path, docx_path, output_path, model, max_words, min_words, job_id):
    """Spawn sync.py in docx mode."""
    cmd = [
        get_python_exe(), get_sync_script(),
        '--video',     video_path,
        '--docx',      docx_path,
        '--output',    output_path,
        '--model',     model,
        '--model-dir', str(MODELS_DIR),
        '--ffmpeg',    _FFMPEG_EXE,
        '--max-words', str(max_words),
        '--min-words', str(min_words),
    ]
    print(f'[server] Running docx-sync cmd: {cmd[0]} {cmd[1]}', flush=True)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=build_env(),
            cwd=str(_HERE),
        )
        lines = []
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            lines.append(line)
            pct = parse_progress(line)
            with jobs_lock:
                jobs[job_id]['message'] = line.replace('[sync] ', '')
                if pct is not None:
                    jobs[job_id]['progress'] = pct
        proc.wait()
        with jobs_lock:
            if proc.returncode == 0 and Path(output_path).exists():
                jobs[job_id].update(status='done', progress=100,
                                    message='SRT generated from Word document', output_path=output_path)
            else:
                jobs[job_id].update(status='error',
                                    message='\n'.join(lines[-8:]) or 'Unknown error')
    except Exception as e:
        print(f'[server] _run_docx_sync exception: {e}', flush=True)
        with jobs_lock:
            jobs[job_id].update(status='error', message=str(e))


@app.route('/job/<job_id>', methods=['GET'])
def get_job(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify(job)


@app.route('/job/<job_id>/result', methods=['GET'])
def get_job_result(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job or job.get('status') != 'done':
        return jsonify({'error': 'Job not complete'}), 400
    p = job.get('output_path')
    if not p or not Path(p).exists():
        return jsonify({'error': 'Output file missing'}), 404
    return jsonify({'content': Path(p).read_text(encoding='utf-8', errors='replace'), 'path': p})


@app.route('/validate/paths', methods=['GET'])
def validate_paths():
    return jsonify({
        'python':      _PYTHON_EXE,
        'sync_script': _SYNC_SCRIPT,
        'ffmpeg':      _FFMPEG_EXE,
        'models_dir':  str(MODELS_DIR),
        'python_exists':      Path(_PYTHON_EXE).exists(),
        'sync_script_exists': Path(_SYNC_SCRIPT).exists(),
        'ffmpeg_exists':      Path(_FFMPEG_EXE).exists() if _FFMPEG_EXE != 'ffmpeg' else False,
    })


@app.route('/validate/whisper', methods=['GET'])
def validate_whisper():
    python = get_python_exe()
    try:
        r = subprocess.run(
            [python, '-c', 'import whisper; print(whisper.__version__)'],
            capture_output=True, text=True, timeout=10,
        )
        ok = r.returncode == 0
        return jsonify({'ok': ok, 'version': (r.stdout or r.stderr).strip()})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})


@app.route('/validate/ffmpeg', methods=['GET'])
def validate_ffmpeg():
    ffmpeg = FFMPEG_PATH if os.path.exists(FFMPEG_PATH) else 'ffmpeg'
    try:
        r = subprocess.run([ffmpeg, '-version'], capture_output=True, text=True, timeout=10)
        return jsonify({'ok': r.returncode == 0,
                        'version': (r.stdout or r.stderr).split('\n')[0]})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})


if __name__ == '__main__':
    print(f'[SubSync Backend] Starting on port {PORT}', flush=True)
    print(f'[SubSync Backend] Models dir: {MODELS_DIR}', flush=True)
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
