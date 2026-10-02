#!/usr/bin/env python3
"""
Hugging Face Model Downloader for NexusRoute
Supports downloading Diffusers SDXL models, LoRAs, GGUFs, and individual safetensors files.
Streams real-time JSON progress to stdout:
{"status": "downloading", "progress": 42.5, "file": "model.safetensors"}
{"status": "completed", "repo": "stabilityai/sdxl-turbo", "path": "..."}
"""

import sys
import os
import argparse
import json

# Suppress noisy symlink warnings and disable buggy Rust xet concurrency on Windows
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_DISABLE_XET"] = "1"

def progress_callback(progress_info):
    try:
        sys.stdout.write(json.dumps(progress_info) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

def main():
    parser = argparse.ArgumentParser(description="Download models from Hugging Face")
    parser.add_argument("--repo", required=True, help="Hugging Face Repository ID (e.g. stabilityai/sdxl-turbo)")
    parser.add_argument("--type", default="auto", help="Model artifact type (sdxl, diffusers, diffusion, lora, gguf, file, etc.)")
    parser.add_argument("--filename", default=None, help="Specific file to download from repo")
    parser.add_argument("--token", default=None, help="Hugging Face Access Token")
    args = parser.parse_args()

    token = args.token or os.environ.get("HUGGINGFACE_API_KEY") or os.environ.get("HF_TOKEN")
    repo_id = args.repo.strip()

    progress_callback({"status": "starting", "repo": repo_id, "message": f"Connecting to Hugging Face for {repo_id}..."})

    try:
        import huggingface_hub
        import huggingface_hub.utils.tqdm as hf_tqdm
        from huggingface_hub import snapshot_download, hf_hub_download

        # Hook into huggingface_hub's tqdm to stream real-time percentage and MB progress
        orig_update = hf_tqdm.update
        last_emitted_pct = -1

        def custom_update(self, n=1):
            nonlocal last_emitted_pct
            res = orig_update(self, n)
            try:
                total = getattr(self, "total", None)
                if total and total > 0:
                    pct = round((self.n / total) * 100, 1)
                    if abs(pct - last_emitted_pct) >= 1 or pct >= 100:
                        last_emitted_pct = pct
                        desc = getattr(self, "desc", "") or "Downloading"
                        if total > 1024:
                            mb_done = self.n / (1024 * 1024)
                            mb_total = total / (1024 * 1024)
                            msg = f"{desc}: {pct}% ({mb_done:.1f} MB / {mb_total:.1f} MB)" if desc else f"Downloading: {pct}% ({mb_done:.1f} MB / {mb_total:.1f} MB)"
                        else:
                            msg = f"{desc}: {self.n}/{total}" if desc else f"Downloading: {pct}%"
                        progress_callback({
                            "status": "downloading",
                            "repo": repo_id,
                            "progress": min(99, max(1, int(pct))),
                            "message": msg
                        })
            except Exception:
                pass
            return res

        hf_tqdm.update = custom_update

        if args.filename:
            progress_callback({"status": "downloading", "repo": repo_id, "file": args.filename, "progress": 5})
            dest_path = hf_hub_download(
                repo_id=repo_id,
                filename=args.filename,
                token=token,
            )
            progress_callback({"status": "completed", "repo": repo_id, "file": args.filename, "path": dest_path, "progress": 100})
        else:
            allow_patterns = None
            type_lower = (args.type or "auto").lower()
            if type_lower == "lora":
                allow_patterns = ["*.safetensors", "*.bin", "*.json"]
            elif type_lower in ["sdxl", "diffusers"]:
                allow_patterns = ["*.safetensors", "*.json", "*.txt", "*.bin", "model_index.json", "unet/*", "vae/*", "text_encoder*/*", "scheduler/*", "tokenizer*/*"]
            elif type_lower in ["diffusion", "video", "image-to-video", "text-to-video"]:
                allow_patterns = ["*.safetensors", "*.json", "*.txt", "*.bin", "model_index.json", "unet/*", "vae/*", "text_encoder*/*", "scheduler/*", "tokenizer*/*", "split_files/*"]

            ignore_patterns = [
                "*.msgpack", "*.h5", "*.onnx", "*.ot", "*.ckpt",
                "*fp32.safetensors", "*fp32.bin", "*full*.safetensors", "*full*.bin",
            ]

            progress_callback({"status": "downloading", "repo": repo_id, "progress": 10, "message": f"Fetching metadata & files for {repo_id}..."})
            
            # max_workers=1 ensures reliable sequential downloads on Windows without socket stalls
            dest_path = snapshot_download(
                repo_id=repo_id,
                allow_patterns=allow_patterns,
                ignore_patterns=ignore_patterns,
                token=token,
                max_workers=1,
            )

            progress_callback({"status": "completed", "repo": repo_id, "path": dest_path, "progress": 100, "message": "Download verified and cached!"})
            print(f"[SUCCESS] Downloaded {repo_id} to {dest_path}", file=sys.stderr)

    except Exception as e:
        progress_callback({"status": "error", "repo": repo_id, "error": str(e)})
        print(f"[ERROR] Download failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
