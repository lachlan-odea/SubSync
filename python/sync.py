"""
sync.py — SubSync alignment engine
Supports:
  - Aligning an existing SRT/VTT to a video via Whisper
  - Generating a new SRT from a Word (.docx) document + video via Whisper

Usage (SRT mode):
    python sync.py --video <path> --subtitle <path> --output <path>
                   --model <tiny|small|medium|large> [--model-dir <dir>]

Usage (DOCX mode):
    python sync.py --video <path> --docx <path> --output <path>
                   --model <tiny|small|medium|large> [--model-dir <dir>]
                   [--max-words 8] [--min-words 3]
"""
import argparse
import os
import re
import sys
import tempfile
import subprocess
from pathlib import Path


# ── SRT helpers ────────────────────────────────────────────────────────────

def parse_time(s):
    s = s.strip().replace(',', '.')
    h, m, rest = s.split(':')
    return int(h) * 3600 + int(m) * 60 + float(rest)


def format_time(sec):
    if sec < 0:
        sec = 0
    h  = int(sec // 3600)
    m  = int((sec % 3600) // 60)
    s  = sec % 60
    ms = round((s - int(s)) * 1000)
    return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"


def parse_srt(text):
    cues = []
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = block.strip().splitlines()
        if not lines:
            continue
        i = 1 if re.match(r'^\d+$', lines[0].strip()) else 0
        if i >= len(lines):
            continue
        m = re.match(
            r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})',
            lines[i]
        )
        if not m:
            continue
        cues.append({
            'start': parse_time(m.group(1)),
            'end':   parse_time(m.group(2)),
            'text':  '\n'.join(lines[i + 1:]).strip(),
        })
    return cues


def write_srt(cues, path):
    out = []
    for i, c in enumerate(cues, 1):
        out.append(str(i))
        out.append(f"{format_time(c['start'])} --> {format_time(c['end'])}")
        out.append(c['text'])
        out.append('')
    Path(path).write_text('\n'.join(out), encoding='utf-8')


# ── Word document → cues ───────────────────────────────────────────────────

def docx_to_cues(docx_path, max_words=8, min_words=3):
    """
    Extract text from a .docx file and split it into subtitle-sized cues.

    Strategy:
    - Each non-empty paragraph becomes a logical unit
    - Paragraphs longer than max_words are split on sentence boundaries first,
      then chunked by word count
    - Very short paragraphs (< min_words) are merged with the next one
    - Returns a list of dicts with 'text' only (no timing yet — that comes from Whisper)
    """
    try:
        from docx import Document
    except ImportError:
        print('[sync] ERROR: python-docx not installed. Run: pip install python-docx', flush=True)
        sys.exit(1)

    doc  = Document(docx_path)
    raw_paragraphs = []

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        # Skip heading-style very short lines like "Chapter 1" unless they have real content
        raw_paragraphs.append(text)

    if not raw_paragraphs:
        print('[sync] ERROR: No text found in Word document', flush=True)
        sys.exit(1)

    print(f'[sync] Extracted {len(raw_paragraphs)} paragraphs from docx', flush=True)

    # Split paragraphs into subtitle-sized chunks
    cues = []
    pending = ''

    for para in raw_paragraphs:
        # Split on sentence endings to keep cues natural
        sentences = re.split(r'(?<=[.!?])\s+', para)
        for sent in sentences:
            words = sent.split()
            if not words:
                continue

            # If adding to pending stays under max, accumulate
            pending_words = pending.split() if pending else []
            if pending and len(pending_words) + len(words) <= max_words:
                pending = (pending + ' ' + sent).strip()
            elif pending:
                # Flush pending first
                for chunk in chunk_words(pending, max_words):
                    cues.append({'text': chunk, 'start': 0.0, 'end': 1.0})
                pending = sent
            else:
                pending = sent

    # Flush any remaining text
    if pending:
        for chunk in chunk_words(pending, max_words):
            cues.append({'text': chunk, 'start': 0.0, 'end': 1.0})

    # Merge any very short trailing cues into previous
    merged = []
    for cue in cues:
        words = cue['text'].split()
        if merged and len(words) < min_words:
            merged[-1]['text'] = merged[-1]['text'] + ' ' + cue['text']
        else:
            merged.append(cue)

    print(f'[sync] Split into {len(merged)} subtitle cues', flush=True)
    return merged


def chunk_words(text, max_words):
    """Split text into chunks of at most max_words words."""
    words = text.split()
    chunks = []
    for i in range(0, len(words), max_words):
        chunks.append(' '.join(words[i:i + max_words]))
    return chunks


# ── Audio extraction ───────────────────────────────────────────────────────

def extract_audio(video_path, ffmpeg_exe='ffmpeg'):
    """Extract mono 16 kHz WAV for Whisper."""
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    cmd = [
        ffmpeg_exe, '-y',
        '-i', video_path,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        tmp.name,
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode(errors='replace')}")
    return tmp.name


# ── Alignment ──────────────────────────────────────────────────────────────

def align_cues(original_cues, whisper_segments):
    """
    Align cues (from SRT or docx) to Whisper word-level timestamps.
    """
    if not original_cues or not whisper_segments:
        return original_cues

    # Build flat word list from Whisper segments
    w_words = []
    for seg in whisper_segments:
        seg_words = seg.get('words', [])
        if seg_words:
            for w in seg_words:
                if 'start' in w and 'end' in w:
                    w_words.append(w)
        else:
            text   = seg.get('text', '').strip()
            tokens = text.split()
            if not tokens:
                continue
            dur = (seg['end'] - seg['start']) / len(tokens)
            for j, tok in enumerate(tokens):
                w_words.append({
                    'word':  tok,
                    'start': seg['start'] + j * dur,
                    'end':   seg['start'] + (j + 1) * dur,
                })

    if not w_words:
        return proportional_fallback(original_cues, whisper_segments)

    print(f'[sync] Aligning {len(original_cues)} cues against {len(w_words)} Whisper words', flush=True)

    aligned      = []
    search_start = 0

    for cue in original_cues:
        query   = normalise(cue['text'])
        q_words = query.split()
        n       = len(q_words)

        if not q_words:
            aligned.append(cue)
            continue

        best_score = -1
        best_i = best_j = None
        window_end = min(len(w_words), search_start + 300)

        for i in range(search_start, max(search_start + 1, window_end - n + 1)):
            chunk = [normalise(w_words[k]['word']) for k in range(i, min(i + n, len(w_words)))]
            score = similarity(q_words, chunk)
            if score > best_score:
                best_score = score
                best_i     = i
                best_j     = min(i + n - 1, len(w_words) - 1)

        if best_score >= 0.30 and best_i is not None:
            new_start = w_words[best_i]['start']
            new_end   = w_words[best_j]['end']
            new_end   = max(new_end, new_start + 0.4)
            aligned.append({**cue, 'start': new_start, 'end': new_end})
            search_start = max(0, best_i)
        else:
            print(f'[sync] Weak match for: {cue["text"][:40]!r} (score={best_score:.2f})', flush=True)
            aligned.append(cue)

    # Add a small gap between adjacent cues to avoid overlap
    for i in range(len(aligned) - 1):
        if aligned[i]['end'] > aligned[i + 1]['start']:
            mid = (aligned[i]['end'] + aligned[i + 1]['start']) / 2
            aligned[i]['end']         = mid - 0.05
            aligned[i + 1]['start']   = mid + 0.05

    return aligned


def normalise(text):
    text = text.lower()
    text = re.sub(r"[^\w\s']", ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def similarity(a_words, b_words):
    if not a_words or not b_words:
        return 0.0
    a_set = set(a_words)
    b_set = set(b_words)
    return len(a_set & b_set) / max(len(a_set), len(b_set))


def proportional_fallback(original_cues, whisper_segments):
    if not whisper_segments:
        return original_cues
    w_start = whisper_segments[0]['start']
    w_end   = whisper_segments[-1]['end']
    w_dur   = w_end - w_start
    o_start = original_cues[0]['start']
    o_end   = original_cues[-1]['end']
    o_dur   = o_end - o_start
    if o_dur <= 0:
        return original_cues
    scale = w_dur / o_dur
    return [{**c,
             'start': w_start + (c['start'] - o_start) * scale,
             'end':   w_start + (c['end']   - o_start) * scale}
            for c in original_cues]


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video',      required=True)
    ap.add_argument('--subtitle',   default=None,  help='Existing SRT/VTT file')
    ap.add_argument('--docx',       default=None,  help='Word document for AI Auto-Sync (build SRT from docx + video)')
    ap.add_argument('--output',     required=True)
    ap.add_argument('--model',      default='small')
    ap.add_argument('--model-dir',  default=None)
    ap.add_argument('--ffmpeg',     default='ffmpeg')
    ap.add_argument('--max-words',  type=int, default=8,  help='Max words per subtitle cue (docx mode)')
    ap.add_argument('--min-words',  type=int, default=3,  help='Min words before merging cues (docx mode)')
    args = ap.parse_args()

    if not args.subtitle and not args.docx:
        print('[sync] ERROR: provide either --subtitle or --docx', flush=True)
        sys.exit(1)

    # ── Load or generate cues ──────────────────────────────────────────────
    if args.docx:
        print(f'[sync] Reading Word document: {args.docx}', flush=True)
        cues = docx_to_cues(args.docx, max_words=args.max_words, min_words=args.min_words)
    else:
        print('[sync] Parsing subtitle file...', flush=True)
        srt_text = Path(args.subtitle).read_text(encoding='utf-8', errors='replace')
        cues = parse_srt(srt_text)
        if not cues:
            print('[sync] ERROR: No cues found in subtitle file', flush=True)
            sys.exit(1)
        print(f'[sync] Loaded {len(cues)} cues', flush=True)

    # ── Extract audio ──────────────────────────────────────────────────────
    print('[sync] Extracting audio from video...', flush=True)
    try:
        audio_path = extract_audio(args.video, args.ffmpeg)
    except RuntimeError as e:
        print(f'[sync] ERROR: {e}', flush=True)
        sys.exit(1)

    try:
        # ── Transcribe ────────────────────────────────────────────────────
        print(f'[sync] Loading Whisper model: {args.model}', flush=True)
        import whisper
        load_kwargs = {}
        if args.model_dir:
            load_kwargs['download_root'] = args.model_dir
        model = whisper.load_model(args.model, **load_kwargs)

        print('[sync] Transcribing audio...', flush=True)
        result   = model.transcribe(audio_path, word_timestamps=True, verbose=False)
        segments = result.get('segments', [])
        print(f'[sync] Transcription complete — {len(segments)} segments', flush=True)

        # ── Align ─────────────────────────────────────────────────────────
        print('[sync] Aligning cues to transcript...', flush=True)
        aligned = align_cues(cues, segments)

        print(f'[sync] Writing {len(aligned)} cues to {args.output}', flush=True)
        write_srt(aligned, args.output)
        print('[sync] Done.', flush=True)

    finally:
        try:
            os.unlink(audio_path)
        except Exception:
            pass


if __name__ == '__main__':
    main()
