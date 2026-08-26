import os
import sys
import time
import threading
import torch
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import uvicorn
from PIL import Image
from diffusers import DiffusionPipeline, AutoPipelineForText2Image

app = FastAPI(title="NexusRoute RTX 4060 Local Art Engine")

pipeline = None
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_ID = "stabilityai/sdxl-turbo"
gpu_lock = threading.Lock()

def load_pipeline():
    global pipeline
    if pipeline is not None:
        return pipeline
    print(f"[*] Loading {MODEL_ID} directly into VRAM on {DEVICE} (float16)...")
    try:
        if DEVICE == "cuda":
            pipeline = AutoPipelineForText2Image.from_pretrained(
                MODEL_ID,
                torch_dtype=torch.float16,
                variant="fp16"
            ).to("cuda")
            try:
                pipeline.enable_vae_tiling()
                pipeline.enable_vae_slicing()
            except Exception:
                pass
        else:
            pipeline = AutoPipelineForText2Image.from_pretrained(MODEL_ID)
        print(f"[+] Model loaded into RTX 4060 VRAM successfully on {DEVICE}!")
        return pipeline
    except Exception as e:
        print(f"[-] Error loading model: {e}")
        raise e

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = "blurry, low quality, distorted, deformed, bad anatomy, bad proportions, bad hands, watermark, grainy, pixelated"
    aspect_ratio: Optional[str] = "16:9"
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = 2
    guidance_scale: Optional[float] = 0.0
    output_path: str
    seed: Optional[int] = None

from fastapi.responses import HTMLResponse

@app.get("/", response_class=HTMLResponse)
def index():
    cuda_avail = torch.cuda.is_available()
    vram_alloc = 0.0
    vram_total = 0.0
    dev_name = "CPU"
    if cuda_avail:
        dev_name = torch.cuda.get_device_name(0)
        vram_alloc = round(torch.cuda.memory_allocated(0) / (1024**3), 2)
        vram_total = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>NexusRoute RTX 4060 Local Art Studio</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; padding: 40px; text-align: center; }}
    .card {{ background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; max-width: 600px; margin: 0 auto; padding: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }}
    h1 {{ color: #38bdf8; margin-top: 0; }}
    .badge {{ display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: bold; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid #38bdf8; margin: 8px 0; }}
    .stat-row {{ display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1e293b; }}
    .stat-label {{ color: #94a3b8; }}
    .stat-val {{ font-weight: bold; color: #10b981; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ Local RTX 4060 GPU Art Engine</h1>
    <div class="badge">Diffusers SDXL-Turbo &middot; Model Offload &middot; Lossless PNG</div>
    <div style="margin-top: 20px;">
      <div class="stat-row">
        <span class="stat-label">Hardware Device:</span>
        <span class="stat-val">{dev_name}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">CUDA Acceleration:</span>
        <span class="stat-val">{'Active (CUDA 12)' if cuda_avail else 'Disabled (CPU)'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">VRAM Usage:</span>
        <span class="stat-val">{vram_alloc} GB / {vram_total} GB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Status:</span>
        <span class="stat-val">Ready &middot; Port 5005</span>
      </div>
    </div>
  </div>
</body>
</html>"""

@app.get("/health")
def health():
    cuda_avail = torch.cuda.is_available()
    vram_alloc = 0.0
    vram_total = 0.0
    dev_name = "CPU"
    if cuda_avail:
        dev_name = torch.cuda.get_device_name(0)
        vram_alloc = round(torch.cuda.memory_allocated(0) / (1024**3), 2)
        vram_total = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
    return {
        "status": "online",
        "device": f"{dev_name} (Hardware Accelerated)" if cuda_avail else "CPU Mode",
        "cuda": cuda_avail,
        "model": MODEL_ID,
        "loaded": pipeline is not None,
        "vram_allocated_gb": vram_alloc,
        "vram_total_gb": vram_total
    }

@app.post("/unload")
def unload():
    global pipeline
    with gpu_lock:
        if pipeline is not None:
            del pipeline
            pipeline = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
            print("[+] Model unloaded and VRAM cache emptied.")
            return {"success": True, "message": "Model unloaded and VRAM freed."}
        return {"success": True, "message": "Model was not loaded."}

@app.post("/generate")
def generate(req: GenerateRequest):
    t0 = time.time()
    
    # Calculate dimensions optimized for SDXL-Turbo speed
    w = req.width
    h = req.height
    if not w or not h:
        ratio = (req.aspect_ratio or "16:9").strip()
        if ratio == "1:1":
            w, h = 512, 512
        elif ratio == "9:16":
            w, h = 512, 768
        elif ratio == "4:3":
            w, h = 640, 480
        elif ratio == "3:2":
            w, h = 768, 512
        else:
            w, h = 768, 432

    # Ensure multiple of 8 and bounds
    w = max(256, min(1024, (w // 8) * 8))
    h = max(256, min(1024, (h // 8) * 8))

    generator = None
    if req.seed is not None and req.seed >= 0:
        generator = torch.Generator(device=DEVICE).manual_seed(req.seed)

    effective_steps = max(1, min(50, req.steps if (req.steps and req.steps > 0) else 4))
    effective_scale = req.guidance_scale if (req.guidance_scale is not None) else 0.0

    print(f"[*] Generating: {req.prompt[:50]}... ({w}x{h}, {effective_steps} steps, scale={effective_scale}) on {DEVICE}")
    
    # Synchronize GPU work with single-job queue
    with gpu_lock:
        pipe = load_pipeline()
        try:
            call_kwargs = {
                "prompt": req.prompt,
                "num_inference_steps": effective_steps,
                "guidance_scale": effective_scale,
                "width": w,
                "height": h,
                "generator": generator
            }
            if req.negative_prompt and effective_scale > 0:
                call_kwargs["negative_prompt"] = req.negative_prompt

            result = pipe(**call_kwargs)
            image = result.images[0]
            
            out_file = Path(req.output_path).resolve()
            out_file.parent.mkdir(parents=True, exist_ok=True)
            image.save(str(out_file), format="PNG", optimize=False)
            
            dur_ms = int((time.time() - t0) * 1000)
            size_bytes = out_file.stat().st_size
            print(f"[+] Generated in {dur_ms}ms! Saved to {out_file} ({round(size_bytes/1024)} KB)")
            
            return {
                "success": True,
                "filePath": str(out_file),
                "width": w,
                "height": h,
                "generationTimeMs": dur_ms,
                "sizeBytes": size_bytes,
                "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
            }
        except Exception as e:
            print(f"[-] Generation error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    print("[*] Starting NexusRoute RTX 4060 Art Server on http://127.0.0.1:5005 ...")
    uvicorn.run(app, host="127.0.0.1", port=5005, log_level="info")
