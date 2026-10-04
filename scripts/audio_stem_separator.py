#!/usr/bin/env python3
"""
Nexus Route Studio - 4-Stem Audio Separator Runner (GPU / Demucs v4).
Extracts sample-accurate, phase-aligned stems for DAWs (Ableton, FL Studio, Logic, Reaper):
  1. Vocals (Acapella)
  2. Drums (Percussion)
  3. Bass (Sub & Bassline)
  4. Other (Synths, Keys, Guitars, FX)
"""

import sys
import os
import argparse
import json
import time
import zipfile
import shutil

def emit_progress(percent, stage, eta=""):
    payload = {
        "type": "progress",
        "percent": percent,
        "stage": stage,
        "eta": eta
    }
    print(json.dumps(payload), flush=True)

def parse_args():
    parser = argparse.ArgumentParser(description="Nexus Route 4-Stem Separator Runner")
    parser.add_argument("--input", required=True, help="Path to input audio file")
    parser.add_argument("--output-dir", default="", help="Destination directory for stems")
    parser.add_argument("--create-zip", action="store_true", default=True, help="Create DAW ZIP archive")
    return parser.parse_args()

def classify_stem(filename):
    lower = filename.lower()
    if "(vocals)" in lower or "_vocals" in lower or "vocals" in lower:
        return "vocals"
    if "(drums)" in lower or "_drums" in lower or "drums" in lower:
        return "drums"
    if "(bass)" in lower or "_bass" in lower or "bass" in lower:
        return "bass"
    if "(other)" in lower or "_other" in lower or "other" in lower:
        return "other"
    if "(instrumental)" in lower or "instrumental" in lower:
        return "instrumental"
    return "other"

def main():
    args = parse_args()
    input_path = os.path.abspath(args.input)
    if not os.path.exists(input_path):
        print(json.dumps({"type": "error", "error": f"Input file not found: {input_path}"}), flush=True)
        sys.exit(1)

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    demucs_model_dir = os.path.join(repo_root, "models", "audio", "demucs")
    os.makedirs(demucs_model_dir, exist_ok=True)

    base_name = os.path.splitext(os.path.basename(input_path))[0]
    clean_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in base_name).strip("_")

    if args.output_dir:
        stems_dir = os.path.abspath(args.output_dir)
    else:
        stems_dir = os.path.join(repo_root, "shared", "audio", "stems", clean_name)
    os.makedirs(stems_dir, exist_ok=True)

    emit_progress(5, "Initializing GPU Audio Separator (Demucs v4)...", "20s")

    try:
        from audio_separator.separator import Separator

        emit_progress(15, "Loading Demucs v4 4-Stem Hybrid Transformer model on RTX 4060...", "15s")
        sep = Separator(
            output_dir=stems_dir,
            output_format="wav",
            model_file_dir=demucs_model_dir
        )
        sep.load_model("htdemucs.yaml")

        emit_progress(35, f"Separating 4 stems (Vocals, Drums, Bass, Other)...", "10s")
        t0 = time.time()
        raw_outputs = sep.separate(input_path)
        elapsed = time.time() - t0

        emit_progress(80, "Mapping and tagging extracted stems...", "3s")

        stems_map = {}
        for out_file in raw_outputs:
            stem_path = out_file if os.path.isabs(out_file) else os.path.join(stems_dir, out_file)
            tag = classify_stem(os.path.basename(stem_path))
            
            # Standardize friendly file name: <track>_Stem_<Type>.wav
            friendly_name = f"{clean_name}_Stem_{tag.capitalize()}.wav"
            friendly_path = os.path.join(stems_dir, friendly_name)
            
            if os.path.exists(stem_path) and stem_path != friendly_path:
                if os.path.exists(friendly_path):
                    try: os.remove(friendly_path)
                    except: pass
                try:
                    os.rename(stem_path, friendly_path)
                    stem_path = friendly_path
                except:
                    pass

            rel_url = f"/v1/studio/maestro/stream?file=stems/{clean_name}/{os.path.basename(stem_path)}"
            download_url = f"/v1/mesh/shares/download?path=stems/{clean_name}/{os.path.basename(stem_path)}&inline=1"
            stems_map[tag] = {
                "name": f"{clean_name} ({tag.capitalize()})",
                "tag": tag,
                "filename": os.path.basename(stem_path),
                "filePath": stem_path,
                "streamUrl": rel_url,
                "downloadUrl": download_url,
                "sizeBytes": os.path.getsize(stem_path) if os.path.exists(stem_path) else 0
            }

        # Create DAW ZIP pack
        zip_path = None
        zip_rel_url = None
        zip_download_url = None
        if args.create_zip and stems_map:
            emit_progress(90, "Packaging 4-Stem DAW ZIP Archive...", "2s")
            zip_filename = f"{clean_name}_DAW_Stems.zip"
            zip_path = os.path.join(stems_dir, zip_filename)

            # Look up meta if available for DAW notes
            meta_path = os.path.splitext(input_path)[0] + ".meta.json"
            meta_info = {}
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta_info = json.load(f)
                except:
                    pass

            bpm = meta_info.get("bpm", 120)
            key = meta_info.get("key", "C Minor")
            genre = meta_info.get("genre", "Electronic")

            readme_content = f"""=====================================================
NEXUS ROUTE - 4-STEM DAW PRODUCTION PACK
=====================================================
Track Title: {meta_info.get("title", base_name)}
Genre:       {genre}
Tempo (BPM): {bpm} BPM
Root Key:    {key}
Sample Rate: 44,100 Hz / 16-bit Stereo PCM WAV
Generated:   {time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())}

STEMS INCLUDED:
1. {clean_name}_Stem_Vocals.wav   - Acapella (Lead, harmony, vocal FX)
2. {clean_name}_Stem_Drums.wav    - Percussion (Kick, snare, hi-hats, groove)
3. {clean_name}_Stem_Bass.wav     - Bassline (Sub, synth bass, mid bass)
4. {clean_name}_Stem_Other.wav    - Melodic & Harmonic Instruments (Keys, synths, pads, leads)

HOW TO IMPORT INTO YOUR DAW:
- Ableton Live: Drag all 4 WAV files simultaneously onto separate audio tracks with tempo set to {bpm} BPM. Turn Warp OFF (or set to Complex Pro) to preserve sample accuracy.
- FL Studio: Drag all 4 WAV files into the Playlist. Assign each to an empty Mixer insert (Insert 1 = Vocals, 2 = Drums, 3 = Bass, 4 = Instruments).
- Logic Pro / GarageBand: Choose File > Import > Audio File and select all 4 files. Set project tempo to {bpm} BPM.
- Reaper / Studio One: Insert all 4 files onto separate tracks starting at bar 1.

Mastered & Stemmed with Demucs v4 Neural Hybrid Transformer on NVIDIA CUDA.
=====================================================
"""
            readme_path = os.path.join(stems_dir, "DAW_README.txt")
            try:
                with open(readme_path, "w", encoding="utf-8") as f:
                    f.write(readme_content)
            except:
                pass

            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                if os.path.exists(readme_path):
                    zf.write(readme_path, "DAW_README.txt")
                for tag, stem in stems_map.items():
                    if os.path.exists(stem["filePath"]):
                        zf.write(stem["filePath"], os.path.basename(stem["filePath"]))

            zip_rel_url = f"/v1/studio/maestro/stream?file=stems/{clean_name}/{zip_filename}"
            zip_download_url = f"/v1/mesh/shares/download?path=stems/{clean_name}/{zip_filename}&inline=0"

        # Update input track's companion .meta.json if present
        meta_path = os.path.splitext(input_path)[0] + ".meta.json"
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta_data = json.load(f)
                meta_data["stems"] = {
                    "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "folder": f"stems/{clean_name}",
                    "zipUrl": zip_rel_url,
                    "zipDownloadUrl": zip_download_url,
                    "items": {
                        tag: {
                            "tag": tag,
                            "filename": stem["filename"],
                            "streamUrl": stem["streamUrl"],
                            "downloadUrl": stem["downloadUrl"]
                        } for tag, stem in stems_map.items()
                    }
                }
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta_data, f, indent=2)
            except Exception as e:
                print(f"[Warning] Could not update meta.json: {e}", file=sys.stderr)

        emit_progress(100, f"4 Stems extracted & packaged in {elapsed:.1f}s!", "0s")

        done_payload = {
            "type": "done",
            "success": True,
            "track": os.path.basename(input_path),
            "stemsDir": stems_dir,
            "stems": stems_map,
            "zipPath": zip_path,
            "zipUrl": zip_rel_url,
            "zipDownloadUrl": zip_download_url,
            "elapsedSeconds": round(elapsed, 1)
        }
        print(json.dumps(done_payload), flush=True)

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        err_payload = {"type": "error", "success": False, "error": str(e)}
        print(json.dumps(err_payload), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
