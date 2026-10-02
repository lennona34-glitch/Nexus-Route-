"""
DLSS 5 Neural Rendering Bridge for Nexus Route / PromptForge Creative Studio.
Integrates NVIDIA DLSS 5 (NGX Feature 18 Neural Rendering) for single images and video streams.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Ensure workspace root is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
for p in [str(PROJECT_ROOT), str(SCRIPT_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

# Ensure default runtime dir points to E:\dlss5_runtime if not explicitly set
DEFAULT_RUNTIME_DIR = r"E:\dlss5_runtime"
if not os.environ.get("DLSS5_RUNTIME_DIR"):
    os.environ["DLSS5_RUNTIME_DIR"] = DEFAULT_RUNTIME_DIR
if not os.environ.get("DLSS5_FFMPEG_DIR"):
    os.environ["DLSS5_FFMPEG_DIR"] = DEFAULT_RUNTIME_DIR

import cv2
import numpy as np

from dlss5.diagnostics import detect_gpu, inspect_bundle
from dlss5.imaging import fit_frame, resize_alpha
from dlss5.media import (
    CODECS,
    CONTAINER_EXTENSIONS,
    CONTAINERS,
    QUALITIES,
    RawFrameEncoder,
    decode_frames,
    mux,
    probe_video,
)
from dlss5.motion import TemporalGuide
from dlss5.paths import RuntimeLayout, find_runtime
from dlss5.session import DlssSession
from dlss5.settings import UPSCALING_LABELS, DlssOptions


MODE_MAP = {
    "1x": "1x (DLAA / native)",
    "dlaa": "1x (DLAA / native)",
    "native": "1x (DLAA / native)",
    "1.5x": "1.5x (Quality)",
    "quality": "1.5x (Quality)",
    "1.724x": "1.724x (Balanced)",
    "balanced": "1.724x (Balanced)",
    "2x": "2x (Performance)",
    "performance": "2x (Performance)",
    "3x": "3x (Ultra Performance)",
    "ultra": "3x (Ultra Performance)",
    "ultra performance": "3x (Ultra Performance)",
}

def resolve_mode(mode: str) -> str:
    cleaned = mode.strip().lower()
    if cleaned in MODE_MAP:
        return MODE_MAP[cleaned]
    for label in UPSCALING_LABELS:
        if mode.lower() in label.lower():
            return label
    return "2x (Performance)"


def get_runtime_status(runtime_override: str | None = None) -> dict:
    runtime_dir = runtime_override or os.environ.get("DLSS5_RUNTIME_DIR", DEFAULT_RUNTIME_DIR)
    try:
        layout = find_runtime(runtime_dir)
        gpu = detect_gpu()
        bundle = inspect_bundle(layout)
        return {
            "available": True,
            "runtime_dir": str(layout.root),
            "gpu": gpu,
            "bundle": {
                "addon_sha256": bundle.get("addon_sha256", ""),
                "neural_sha256": bundle.get("neural_sha256", ""),
            },
        }
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
            "runtime_dir": str(runtime_dir),
        }


def enhance_image(
    input_path: str | Path,
    output_path: str | Path,
    mode: str = "Performance",
    runtime_override: str | None = None,
) -> dict:
    start_time = time.time()
    input_file = Path(input_path).resolve()
    output_file = Path(output_path).resolve()

    if not input_file.is_file():
        raise FileNotFoundError(f"Input image not found: {input_file}")

    layout = find_runtime(runtime_override or os.environ.get("DLSS5_RUNTIME_DIR", DEFAULT_RUNTIME_DIR))
    
    # Read image as BGRA / BGR
    img_bgr = cv2.imread(str(input_file), cv2.IMREAD_UNCHANGED)
    if img_bgr is None:
        raise ValueError(f"Failed to read image at {input_file}")

    has_alpha = len(img_bgr.shape) == 3 and img_bgr.shape[2] == 4
    if has_alpha:
        img_rgba = cv2.cvtColor(img_bgr, cv2.COLOR_BGRA2RGBA)
    else:
        if len(img_bgr.shape) == 2:
            img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_GRAY2RGB)
        else:
            img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        img_rgba = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2RGBA)

    height, width = img_rgba.shape[:2]
    upscaling_label = resolve_mode(mode)

    options = DlssOptions.create(
        upscaling_mode=upscaling_label,
        dlss_model_preset="M",
        motion_mode="none",
    )

    with DlssSession(
        layout,
        options,
        input_width=width,
        input_height=height,
        frame_count=1,
    ) as session:
        guide = TemporalGuide(
            session.render_width,
            session.render_height,
            enabled=False,
        )
        fitted_rgba = fit_frame(img_rgba, session.render_width, session.render_height)
        motion = guide.process(fitted_rgba)
        enhanced, _pts = session.submit(
            index=0,
            rgba=fitted_rgba,
            motion=motion.motion,
            reset=True,
            pts=0,
        )

        if has_alpha:
            enhanced[..., 3] = resize_alpha(
                img_rgba[..., 3], session.output_width, session.output_height
            )
            out_bgr = cv2.cvtColor(enhanced, cv2.COLOR_RGBA2BGRA)
        else:
            out_rgb = cv2.cvtColor(enhanced, cv2.COLOR_RGBA2RGB)
            out_bgr = cv2.cvtColor(out_rgb, cv2.COLOR_RGB2BGR)

        output_file.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(output_file), out_bgr)

    elapsed = time.time() - start_time
    return {
        "status": "success",
        "input": str(input_file),
        "output": str(output_file),
        "input_resolution": f"{width}x{height}",
        "output_resolution": f"{session.output_width}x{session.output_height}",
        "render_resolution": f"{session.render_width}x{session.render_height}",
        "upscaling_mode": mode,
        "elapsed_seconds": round(elapsed, 2),
    }


def enhance_video_stream(
    input_path: str | Path,
    output_path: str | Path,
    mode: str = "Quality",
    codec: str = "HEVC",
    container: str = "MP4",
    quality: str = "Good",
    max_frames: int = 0,
    copy_audio: bool = True,
    runtime_override: str | None = None,
) -> dict:
    start_time = time.time()
    source = Path(input_path).resolve()
    final_path = Path(output_path).resolve()

    if not source.is_file():
        raise FileNotFoundError(f"Input video not found: {source}")

    layout = find_runtime(runtime_override or os.environ.get("DLSS5_RUNTIME_DIR", DEFAULT_RUNTIME_DIR))
    layout.require_ffmpeg()

    if mode not in UPSCALING_LABELS:
        mode = "Quality"
    if codec not in CODECS:
        codec = "HEVC"
    if container not in CONTAINERS:
        container = "MP4"
    if quality not in QUALITIES:
        quality = "Good"

    options = DlssOptions.create(
        upscaling_mode=resolve_mode(mode),
        dlss_model_preset="M",
    )

    metadata = probe_video(layout, source)
    frame_count = int(metadata.get("frames", 0))
    if frame_count <= 0:
        frame_count = int(probe_video(layout, source, exact_frames=True)["frames"])
    if frame_count <= 0:
        raise RuntimeError(f"Could not determine frame count for {source}")
    if max_frames > 0:
        frame_count = min(frame_count, max_frames)

    temp_raw_mkv = final_path.parent / f"_temp_{final_path.stem}_raw.mkv"
    final_path.parent.mkdir(parents=True, exist_ok=True)

    session = DlssSession(
        layout,
        options,
        input_width=metadata["width"],
        input_height=metadata["height"],
        frame_count=frame_count,
    )

    encoder = None
    written = 0
    try:
        encoder = RawFrameEncoder(
            layout,
            temp_raw_mkv,
            codec=codec,
            quality=quality,
            width=session.output_width,
            height=session.output_height,
            rate=metadata["rate"],
            time_base=metadata["time_base"],
        )

        guide = TemporalGuide(
            session.render_width,
            session.render_height,
            flow_width=options.flow_width,
            scene_change_threshold=options.scene_change_threshold,
            enabled=options.wants_motion(frame_count),
        )

        for index, rgba, pts in decode_frames(source, metadata["rotation"], limit=frame_count):
            fitted = fit_frame(rgba, session.render_width, session.render_height)
            motion = guide.process(fitted)
            enhanced, out_pts = session.submit(
                index=index,
                rgba=fitted,
                motion=motion.motion,
                reset=motion.reset,
                pts=pts,
            )
            encoder.write(enhanced, out_pts)
            written += 1

        encoder.close()
        encoder = None

        # Mux with original audio and metadata
        mux(layout, temp_raw_mkv, source, final_path, container, copy_audio=copy_audio)
    finally:
        if encoder is not None:
            encoder.abort()
        try:
            session.close()
        except Exception:
            pass
        if temp_raw_mkv.exists():
            try:
                temp_raw_mkv.unlink(missing_ok=True)
            except Exception:
                pass

    elapsed = time.time() - start_time
    return {
        "status": "success",
        "input": str(source),
        "output": str(final_path),
        "frames_rendered": written,
        "input_resolution": f"{metadata['width']}x{metadata['height']}",
        "output_resolution": f"{session.output_width}x{session.output_height}",
        "upscaling_mode": mode,
        "codec": codec,
        "container": container,
        "elapsed_seconds": round(elapsed, 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Nexus DLSS 5 Neural Rendering Bridge")
    parser.add_argument("--action", choices=["status", "image", "video"], required=True)
    parser.add_argument("--input", type=str, help="Input file path")
    parser.add_argument("--output", type=str, help="Output file path")
    parser.add_argument("--mode", type=str, default="Quality", help="Upscaling mode (e.g. Quality, Balanced, Performance)")
    parser.add_argument("--sharpness", type=float, default=0.2, help="DLSS sharpness (0.0 - 1.0)")
    parser.add_argument("--codec", type=str, default="HEVC", choices=list(CODECS))
    parser.add_argument("--container", type=str, default="MP4", choices=list(CONTAINERS))
    parser.add_argument("--quality", type=str, default="Good", choices=list(QUALITIES))
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--no-audio", action="store_true", help="Omit audio copying")
    parser.add_argument("--runtime-dir", type=str, default=None)

    args = parser.parse_args()

    try:
        if args.action == "status":
            result = get_runtime_status(args.runtime_dir)
            print(json.dumps(result, indent=2))
            return 0
        elif args.action == "image":
            if not args.input or not args.output:
                print(json.dumps({"status": "error", "message": "--input and --output are required for image action"}))
                return 1
            result = enhance_image(
                args.input,
                args.output,
                mode=args.mode,
                runtime_override=args.runtime_dir,
            )
            print(json.dumps(result, indent=2))
            return 0
        elif args.action == "video":
            if not args.input or not args.output:
                print(json.dumps({"status": "error", "message": "--input and --output are required for video action"}))
                return 1
            result = enhance_video_stream(
                args.input,
                args.output,
                mode=args.mode,
                codec=args.codec,
                container=args.container,
                quality=args.quality,
                max_frames=args.max_frames,
                copy_audio=not args.no_audio,
                runtime_override=args.runtime_dir,
            )
            print(json.dumps(result, indent=2))
            return 0
    except Exception as exc:
        err = {"status": "error", "message": str(exc)}
        print(json.dumps(err, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
