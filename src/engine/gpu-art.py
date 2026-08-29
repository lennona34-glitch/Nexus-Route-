#!/usr/bin/env python3
"""
NexusRoute Local GPU Art Engine
Powered by NVIDIA GeForce RTX 4060 & PyTorch / Hugging Face Diffusers
"""

import argparse
import json
import os
import sys
import time

def check_cuda():
    try:
        import torch
        available = torch.cuda.is_available()
        device_name = torch.cuda.get_device_name(0) if available else "CPU"
        vram_mb = torch.cuda.get_device_properties(0).total_memory / (1024 * 1024) if available else 0
        return {
            "cuda_available": available,
            "device_name": device_name,
            "vram_total_mb": round(vram_mb),
            "torch_version": torch.__version__,
        }
    except Exception as e:
        return {"cuda_available": False, "error": str(e)}

def get_best_local_model():
    cache_dir = os.path.expanduser("~/.cache/huggingface/hub")
    candidates = [
        ("models--stabilityai--sdxl-turbo", "stabilityai/sdxl-turbo"),
        ("models--Lykon--dreamshaper-xl-v2-turbo", "Lykon/dreamshaper-xl-v2-turbo"),
        ("models--RunDiffusion--Juggernaut-XL-v9", "RunDiffusion/Juggernaut-XL-v9"),
        ("models--SG161222--RealVisXL_V5.0", "SG161222/RealVisXL_V5.0"),
        ("models--stabilityai--sd-turbo", "stabilityai/sd-turbo"),
        ("models--stable-diffusion-v1-5--stable-diffusion-v1-5", "stable-diffusion-v1-5/stable-diffusion-v1-5"),
    ]
    for folder, model_id in candidates:
        if os.path.exists(os.path.join(cache_dir, folder)):
            return model_id
    return "stabilityai/sdxl-turbo"

def generate_image(prompt: str, output_path: str, width: int = 512, height: int = 512, steps: int = 1, seed: int = None, model_id: str = None):
    import torch
    from diffusers import AutoPipelineForText2Image

    if not model_id or model_id == "default":
        model_id = get_best_local_model()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    start_time = time.time()
    print(f"[Local GPU Art Engine] Initializing model {model_id} on {device} ({dtype})...", file=sys.stderr)

    generator = None
    if seed is not None and seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)

    # Enable TF32 for Ampere / Ada Lovelace architecture (RTX 4060)
    if device == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY")
    if hf_token and hf_token.startswith("mock-"):
        hf_token = None

    pipe = AutoPipelineForText2Image.from_pretrained(
        model_id,
        torch_dtype=dtype,
        variant="fp16" if device == "cuda" else None,
        token=hf_token,
    )
    if device == "cuda":
        pipe.to("cuda")
        try:
            pipe.enable_vae_slicing()
            pipe.enable_vae_tiling()
        except Exception:
            pass

    # For SD-Turbo / SDXL-Turbo, 1-2 steps with guidance_scale=0.0 is optimal for sub-second generation
    guidance = 0.0 if "turbo" in model_id.lower() else 7.5

    print(f"[Local GPU Art Engine] Generating: \"{prompt}\" ({width}x{height}, {steps} steps)...", file=sys.stderr)
    result = pipe(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )

    image = result.images[0]
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    image.save(output_path, "PNG")

    elapsed = time.time() - start_time
    file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

    if device == "cuda":
        torch.cuda.empty_cache()

    return {
        "success": True,
        "prompt": prompt,
        "output_path": output_path,
        "width": width,
        "height": height,
        "steps": steps,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": file_size,
        "device": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
        "model": model_id,
    }

def main():
    parser = argparse.ArgumentParser(description="NexusRoute Local GPU Art Engine")
    parser.add_argument("--check-gpu", action="store_true", help="Print GPU status and exit")
    parser.add_argument("--prompt", type=str, default="", help="Text prompt for image generation")
    parser.add_argument("--output", type=str, default="output.png", help="Output image file path")
    parser.add_argument("--width", type=int, default=512, help="Image width (default 512)")
    parser.add_argument("--height", type=int, default=512, help="Image height (default 512)")
    parser.add_argument("--steps", type=int, default=1, help="Inference steps (default 1 for turbo)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument("--model", type=str, default="default", help="Model ID")

    args = parser.parse_args()

    if args.check_gpu:
        status = check_cuda()
        print(json.dumps(status))
        sys.stdout.flush()
        sys.exit(0)

    if not args.prompt:
        print(json.dumps({"success": False, "error": "Prompt cannot be empty"}), file=sys.stderr)
        sys.exit(1)

    try:
        res = generate_image(
            prompt=args.prompt,
            output_path=args.output,
            width=args.width,
            height=args.height,
            steps=args.steps,
            seed=args.seed,
            model_id=args.model,
        )
        print(json.dumps(res))
        sys.stdout.flush()
    except Exception as e:
        err_res = {"success": False, "error": str(e)}
        print(json.dumps(err_res), file=sys.stderr)
        sys.stderr.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
