#!/usr/bin/env python3
"""
NexusRoute Local GPU Art Engine
Powered by NVIDIA GeForce RTX 4060 & PyTorch / Hugging Face Diffusers
Supports both Persistent Warm Daemon Mode and One-Shot CLI Mode.
"""

import argparse
import json
import os
import sys
import time

# Global Warm Pipeline State
_WARM_PIPE = None
_WARM_INPAINT_PIPE = None
_WARM_I2I_PIPE = None
_WARM_I2V_PIPE = None
_CURRENT_MODEL_ID = None
_CURRENT_LORA_ID = None
_ORIGINAL_SCHEDULER_CONFIG = None
_LAST_ACTIVITY = time.time()

# Suppress HuggingFace symlinks warning & prevent unauthenticated remote network stalls
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# Proactively fix diffusers WanVideoToVideoPipeline missing ftfy bug
try:
    import diffusers.pipelines.wan.pipeline_wan as _wan_mod
    import diffusers.pipelines.wan.pipeline_wan_video2video as _v2v_mod
    _v2v_mod.basic_clean = _wan_mod.basic_clean
except Exception:
    pass

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

def get_hf_hub_cache() -> str:
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        hub = os.path.join(hf_home, "hub")
        if os.path.exists(hub):
            return hub
        if os.path.exists(hf_home):
            return hf_home
    if os.path.exists(r"E:\huggingface_cache\hub"):
        return r"E:\huggingface_cache\hub"
    if os.path.exists(r"E:\huggingface_cache"):
        return r"E:\huggingface_cache"
    return os.path.expanduser("~/.cache/huggingface/hub")

def get_first_local_checkpoint() -> str:
    possible_dirs = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "models", "checkpoints"),
        os.path.join(os.getcwd(), "models", "checkpoints"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "checkpoints"),
    ]
    for cdir in possible_dirs:
        if os.path.exists(cdir):
            files = [f for f in os.listdir(cdir) if (f.endswith(".safetensors") or f.endswith(".ckpt")) and not f.endswith(".info")]
            if "majicmixRealistic_v7.safetensors" in files:
                return os.path.join(cdir, "majicmixRealistic_v7.safetensors")
            if files:
                return os.path.join(cdir, files[0])
    return ""

def resolve_model_id(model_id: str = None, quality_mode: str = None):
    cache_dir = get_hf_hub_cache()
    
    # Check if specific model or alias requested
    if model_id and model_id != "default":
        alias_map = {
            "sdxl": "stabilityai/stable-diffusion-xl-base-1.0",
            "sdxl-base": "stabilityai/stable-diffusion-xl-base-1.0",
            "sdxl_base": "stabilityai/stable-diffusion-xl-base-1.0",
            "hd": "stabilityai/stable-diffusion-xl-base-1.0",
            "realvis": "SG161222/RealVisXL_V5.0",
            "realvisxl": "SG161222/RealVisXL_V5.0",
            "juggernaut": "RunDiffusion/Juggernaut-XL-v9",
            "juggernaut-xl": "RunDiffusion/Juggernaut-XL-v9",
            "dreamshaper": "Lykon/dreamshaper-xl-v2-turbo",
            "animagine": "cagliostrolab/animagine-xl-4.0",
            "animagine-xl": "cagliostrolab/animagine-xl-4.0",
            "sdxl-turbo": "stabilityai/sdxl-turbo",
            "turbo": get_first_local_checkpoint() or "stabilityai/sdxl-turbo",
            "wan": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
            "wan2.1": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
            "wan-1.3b": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
            "wan-14b": "Wan-AI/Wan2.1-T2V-14B-Diffusers",
            "wan-i2v": "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
            "ltx": "Lightricks/LTX-Video",
            "ltx-video": "Lightricks/LTX-Video",
            "ltx2": "Lightricks/LTX-Video",
            "ltx-0.9.5": "Lightricks/LTX-Video-0.9.5",
            "cogvideo": "THUDM/CogVideoX-2b",
            "cogvideox": "THUDM/CogVideoX-2b",
            "cogvideox-2b": "THUDM/CogVideoX-2b",
            "cogvideox-5b": "THUDM/CogVideoX-5b",
            "hunyuan": "tencent/HunyuanVideo",
            "hunyuanvideo": "tencent/HunyuanVideo",
        }
        clean_key = model_id.lower().strip()
        if clean_key in alias_map:
            return alias_map[clean_key]
        return model_id

    # If quality mode requested
    if quality_mode in ["quality", "hd", "sdxl"]:
        candidates = [
            ("models--stabilityai--stable-diffusion-xl-base-1.0", "stabilityai/stable-diffusion-xl-base-1.0"),
            ("models--SG161222--RealVisXL_V5.0", "SG161222/RealVisXL_V5.0"),
            ("models--RunDiffusion--Juggernaut-XL-v9", "RunDiffusion/Juggernaut-XL-v9"),
            ("models--cagliostrolab--animagine-xl-4.0", "cagliostrolab/animagine-xl-4.0"),
            ("models--stabilityai--sdxl-turbo", "stabilityai/sdxl-turbo"),
        ]
        for folder, mid in candidates:
            if os.path.exists(os.path.join(cache_dir, folder)):
                return mid
        return "stabilityai/stable-diffusion-xl-base-1.0"

    # Default Fast Stream: use installed local CivitAI checkpoint
    local_default = get_first_local_checkpoint()
    if local_default:
        return local_default
    return "stabilityai/stable-diffusion-xl-base-1.0"

def is_lora_model(repo_id: str) -> bool:
    if not repo_id or repo_id == "default":
        return False
    lower = repo_id.lower().strip()
    if "lora" in lower:
        return True
    cache_dir = get_hf_hub_cache()
    dir_name = "models--" + repo_id.replace("/", "--")
    target_dir = os.path.join(cache_dir, dir_name)
    if os.path.exists(target_dir):
        has_pipeline = False
        has_lora_file = False
        for root, dirs, files in os.walk(target_dir):
            if "model_index.json" in files:
                has_pipeline = True
                break
            for f in files:
                if "lora" in f.lower() or f.endswith(".safetensors") or f.endswith(".bin"):
                    has_lora_file = True
        if not has_pipeline and has_lora_file:
            return True
    return False

def resolve_base_model_for_lora(lora_id: str) -> str:
    cache_dir = get_hf_hub_cache()
    lower = (lora_id or "").lower()

    if "sd15" in lower or "sd-1.5" in lower or "sdv1-5" in lower or "v1-5" in lower:
        local_default = get_first_local_checkpoint()
        if local_default:
            return local_default
        candidates = [
            ("models--stable-diffusion-v1-5--stable-diffusion-v1-5", "stable-diffusion-v1-5/stable-diffusion-v1-5"),
            ("models--runwayml--stable-diffusion-v1-5", "runwayml/stable-diffusion-v1-5"),
        ]
        for folder, mid in candidates:
            if os.path.exists(os.path.join(cache_dir, folder)):
                return mid
        return local_default or "runwayml/stable-diffusion-v1-5"

    candidates = [
        ("models--stabilityai--stable-diffusion-xl-base-1.0", "stabilityai/stable-diffusion-xl-base-1.0"),
        ("models--Lykon--dreamshaper-xl-v2-turbo", "Lykon/dreamshaper-xl-v2-turbo"),
        ("models--SG161222--RealVisXL_V5.0", "SG161222/RealVisXL_V5.0"),
        ("models--RunDiffusion--Juggernaut-XL-v9", "RunDiffusion/Juggernaut-XL-v9"),
        ("models--cagliostrolab--animagine-xl-4.0", "cagliostrolab/animagine-xl-4.0"),
        ("models--stabilityai--sdxl-turbo", "stabilityai/sdxl-turbo"),
    ]
    for folder, mid in candidates:
        if os.path.exists(os.path.join(cache_dir, folder)):
            return mid

    return "stabilityai/stable-diffusion-xl-base-1.0"

def get_best_local_model():
    return resolve_model_id()

def get_or_load_pipeline(model_id: str = None, quality_mode: str = None, lora_id: str = None, lora_scale: float = 1.0):
    global _WARM_PIPE, _WARM_INPAINT_PIPE, _WARM_I2I_PIPE, _WARM_I2V_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID, _ORIGINAL_SCHEDULER_CONFIG
    import torch
    from diffusers import AutoPipelineForText2Image

    # Auto-detect if model_id itself is a LoRA adapter
    effective_lora = lora_id.strip() if lora_id else None
    if is_lora_model(model_id):
        if not effective_lora:
            effective_lora = model_id
        model_id = resolve_base_model_for_lora(effective_lora)

    target_model = resolve_model_id(model_id, quality_mode)

    # 1. Base Model Management
    if _WARM_PIPE is None or _CURRENT_MODEL_ID != target_model:
        if _WARM_PIPE is not None:
            del _WARM_PIPE
            _WARM_PIPE = None
        if _WARM_INPAINT_PIPE is not None:
            del _WARM_INPAINT_PIPE
            _WARM_INPAINT_PIPE = None
        if _WARM_I2I_PIPE is not None:
            del _WARM_I2I_PIPE
            _WARM_I2I_PIPE = None
        if _WARM_I2V_PIPE is not None:
            del _WARM_I2V_PIPE
            _WARM_I2V_PIPE = None
        _CURRENT_LORA_ID = None
        _ORIGINAL_SCHEDULER_CONFIG = None
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32

        print(f"[Local GPU Daemon] Loading pipeline {target_model} onto {device} ({dtype})...", file=sys.stderr, flush=True)

        if device == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

        hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY")
        if hf_token and hf_token.startswith("mock-"):
            hf_token = None

        is_wan = "wan" in target_model.lower()
        if is_wan:
            try:
                from diffusers import AutoencoderKLWan, WanPipeline
                print(f"[Local GPU Daemon] Loading Wan 2.1 Video DiT ({target_model}) with CPU offload...", file=sys.stderr, flush=True)
                for lfo in [True, False]:
                    try:
                        vae = AutoencoderKLWan.from_pretrained(target_model, subfolder="vae", torch_dtype=torch.float32, local_files_only=lfo)
                        pipe = WanPipeline.from_pretrained(target_model, vae=vae, torch_dtype=torch.bfloat16, local_files_only=lfo)
                        break
                    except Exception:
                        if not lfo:
                            raise
                try:
                    pipe.vae.enable_tiling()
                    pipe.vae.enable_slicing()
                except Exception as e:
                    print(f"[Local GPU Daemon] VAE tiling/slicing note: {e}", file=sys.stderr, flush=True)
                if device == "cuda":
                    try:
                        pipe.enable_model_cpu_offload()
                        print("[Local GPU Daemon] Wan 2.1 CPU offload active (fits 8GB VRAM with 64GB RAM)!", file=sys.stderr, flush=True)
                    except Exception as e:
                        print(f"[Local GPU Daemon] CPU offload note: {e}, placing to cuda", file=sys.stderr, flush=True)
                        pipe.to("cuda")
                else:
                    pipe.to("cpu")
                _WARM_PIPE = pipe
                _CURRENT_MODEL_ID = target_model
                _CURRENT_LORA_ID = None
                print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID, "lora": _CURRENT_LORA_ID}), flush=True)
                return _WARM_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID
            except Exception as e:
                print(f"[Local GPU Daemon] Error loading Wan 2.1 ({e}). Falling back to standard diffusion...", file=sys.stderr, flush=True)

        is_ltx = "ltx" in target_model.lower()
        if is_ltx:
            try:
                from diffusers import LTXPipeline
                print(f"[Local GPU Daemon] Loading LTX-Video DiT ({target_model}) with CPU offload...", file=sys.stderr, flush=True)
                for lfo in [True, False]:
                    try:
                        pipe = LTXPipeline.from_pretrained(target_model, torch_dtype=torch.bfloat16, local_files_only=lfo)
                        break
                    except Exception:
                        if not lfo:
                            raise
                if device == "cuda":
                    try:
                        pipe.enable_model_cpu_offload()
                    except Exception:
                        pipe.to("cuda")
                else:
                    pipe.to("cpu")
                _WARM_PIPE = pipe
                _CURRENT_MODEL_ID = target_model
                _CURRENT_LORA_ID = None
                print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID, "lora": _CURRENT_LORA_ID}), flush=True)
                return _WARM_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID
            except Exception as e:
                print(f"[Local GPU Daemon] Error loading LTX-Video ({e}). Falling back to standard diffusion...", file=sys.stderr, flush=True)

        is_cogvideo = "cogvideo" in target_model.lower()
        if is_cogvideo:
            try:
                from diffusers import CogVideoXPipeline
                print(f"[Local GPU Daemon] Loading CogVideoX DiT ({target_model}) with CPU offload...", file=sys.stderr, flush=True)
                for lfo in [True, False]:
                    try:
                        pipe = CogVideoXPipeline.from_pretrained(target_model, torch_dtype=torch.bfloat16, local_files_only=lfo)
                        break
                    except Exception:
                        if not lfo:
                            raise
                if device == "cuda":
                    try:
                        pipe.enable_model_cpu_offload()
                    except Exception:
                        pipe.to("cuda")
                else:
                    pipe.to("cpu")
                try:
                    pipe.vae.enable_tiling()
                    pipe.vae.enable_slicing()
                except Exception as e:
                    print(f"[Local GPU Daemon] CogVideoX VAE tiling/slicing note: {e}", file=sys.stderr, flush=True)
                _WARM_PIPE = pipe
                _CURRENT_MODEL_ID = target_model
                _CURRENT_LORA_ID = None
                print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID, "lora": _CURRENT_LORA_ID}), flush=True)
                return _WARM_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID
            except Exception as e:
                print(f"[Local GPU Daemon] Error loading CogVideoX ({e}). Falling back to standard diffusion...", file=sys.stderr, flush=True)

        def _attempt_load(model_id):
            # Check if model_id is a single .safetensors or .ckpt checkpoint file
            if not model_id:
                return None
            clean_id = model_id
            for pfx in ["local:checkpoints/", "local:loras/", "local:"]:
                if clean_id.startswith(pfx):
                    clean_id = clean_id[len(pfx):].strip()
                    break

            clean_path = clean_id
            if not os.path.isfile(clean_path):
                cwd = os.getcwd()
                for sub in ["models/checkpoints", "models/loras", "models"]:
                    cand = os.path.join(cwd, sub, clean_id)
                    if os.path.isfile(cand):
                        clean_path = cand
                        break
                    if not clean_id.endswith(".safetensors"):
                        cand_s = os.path.join(cwd, sub, clean_id + ".safetensors")
                        if os.path.isfile(cand_s):
                            clean_path = cand_s
                            break

            if os.path.isfile(clean_path) and (clean_path.endswith(".safetensors") or clean_path.endswith(".ckpt") or clean_path.endswith(".bin")):
                print(f"[Local GPU Daemon] Loading single-file checkpoint from disk: {clean_path}...", file=sys.stderr, flush=True)
                is_xl = any(k in clean_path.lower() for k in ["xl", "pony", "base-1.0", "sdxl"])
                if is_xl:
                    try:
                        from diffusers import StableDiffusionXLPipeline
                        return StableDiffusionXLPipeline.from_single_file(
                            clean_path,
                            torch_dtype=dtype,
                        )
                    except Exception as ex_xl:
                        print(f"[Local GPU Daemon] SDXL single file note: {ex_xl}, trying SD 1.5...", file=sys.stderr, flush=True)
                try:
                    from diffusers import StableDiffusionPipeline
                    return StableDiffusionPipeline.from_single_file(
                        clean_path,
                        torch_dtype=dtype,
                    )
                except Exception as ex_sd:
                    print(f"[Local GPU Daemon] SD 1.5 single file note: {ex_sd}, trying SDXL...", file=sys.stderr, flush=True)
                    try:
                        from diffusers import StableDiffusionXLPipeline
                        return StableDiffusionXLPipeline.from_single_file(
                            clean_path,
                            torch_dtype=dtype,
                        )
                    except Exception as ex_all:
                        print(f"[Local GPU Daemon] Error loading single file checkpoint: {ex_all}", file=sys.stderr, flush=True)
                        return None

            for lfo in [True, False]:
                try:
                    return AutoPipelineForText2Image.from_pretrained(
                        model_id,
                        torch_dtype=dtype,
                        variant="fp16" if device == "cuda" else None,
                        token=hf_token,
                        local_files_only=lfo,
                    )
                except Exception:
                    try:
                        return AutoPipelineForText2Image.from_pretrained(
                            model_id,
                            torch_dtype=dtype,
                            token=hf_token,
                            local_files_only=lfo,
                        )
                    except Exception:
                        pass
            return None

        pipe = _attempt_load(target_model)
        if pipe is None:
            local_fallback = get_first_local_checkpoint()
            if local_fallback and os.path.abspath(local_fallback) != os.path.abspath(target_model):
                print(f"[Local GPU Daemon] Could not load {target_model}. Falling back to local checkpoint {local_fallback}...", file=sys.stderr, flush=True)
                pipe = _attempt_load(local_fallback)
                if pipe is not None:
                    target_model = local_fallback
            if pipe is None:
                raise RuntimeError(f"Could not load neural model weights: {target_model}. Please verify your checkpoints in models/checkpoints/.")

        is_sdxl = "xl" in target_model.lower() or "base" in target_model.lower() or "realvis" in target_model.lower() or "juggernaut" in target_model.lower() or "animagine" in target_model.lower()

        if device == "cuda":
            if is_sdxl:
                try:
                    pipe.enable_model_cpu_offload()
                except Exception:
                    pipe.to("cuda")
            else:
                pipe.to("cuda")

            try:
                pipe.enable_attention_slicing()
            except Exception:
                pass
            if hasattr(pipe, "enable_vae_tiling"):
                try:
                    pipe.enable_vae_tiling()
                except Exception:
                    pass
            if hasattr(pipe, "enable_vae_slicing"):
                try:
                    pipe.enable_vae_slicing()
                except Exception:
                    pass

        _WARM_PIPE = pipe
        _CURRENT_MODEL_ID = target_model
        _CURRENT_LORA_ID = None
        _ORIGINAL_SCHEDULER_CONFIG = getattr(pipe.scheduler, "config", None)
        print(f"[Local GPU Daemon] Pipeline {target_model} is warm in VRAM!", file=sys.stderr, flush=True)
        print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID, "lora": _CURRENT_LORA_ID}), flush=True)

    # 2. LoRA Adapter Management
    if _CURRENT_LORA_ID != effective_lora:
        if _CURRENT_LORA_ID is not None:
            try:
                _WARM_PIPE.unload_lora_weights()
                print(f"[Local GPU Daemon] Unloaded previous LoRA {_CURRENT_LORA_ID}", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[Local GPU Daemon] Note unloading LoRA: {e}", file=sys.stderr, flush=True)
            _CURRENT_LORA_ID = None

        if effective_lora:
            try:
                actual_lora_path = effective_lora
                for pfx in ["local:loras/", "local:checkpoints/", "local:"]:
                    if actual_lora_path.startswith(pfx):
                        actual_lora_path = actual_lora_path[len(pfx):].strip()
                        break
                if not os.path.isfile(actual_lora_path):
                    cwd = os.getcwd()
                    for sub in ["models/loras", "models/checkpoints", "models"]:
                        cand = os.path.join(cwd, sub, actual_lora_path)
                        if os.path.isfile(cand):
                            actual_lora_path = cand
                            break
                        if not actual_lora_path.endswith(".safetensors"):
                            cand_s = os.path.join(cwd, sub, actual_lora_path + ".safetensors")
                            if os.path.isfile(cand_s):
                                actual_lora_path = cand_s
                                break

                print(f"[Local GPU Daemon] Loading LoRA adapter {actual_lora_path}...", file=sys.stderr, flush=True)
                _WARM_PIPE.load_lora_weights(actual_lora_path)
                if "lcm" in effective_lora.lower():
                    from diffusers import LCMScheduler
                    _WARM_PIPE.scheduler = LCMScheduler.from_config(_WARM_PIPE.scheduler.config)
                    print(f"[Local GPU Daemon] Activated LCMScheduler for {effective_lora}", file=sys.stderr, flush=True)
                _CURRENT_LORA_ID = effective_lora
                print(f"[Local GPU Daemon] LoRA {effective_lora} successfully active!", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[Local GPU Daemon] Warning: Failed to load LoRA {effective_lora}: {e}", file=sys.stderr, flush=True)
        
        print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID, "lora": _CURRENT_LORA_ID}), flush=True)

    return _WARM_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID

def get_or_load_i2i_pipeline(model_id: str = None, quality_mode: str = None):
    global _WARM_I2I_PIPE, _WARM_PIPE, _CURRENT_MODEL_ID
    import torch
    from diffusers import AutoPipelineForImage2Image
    pipe, current_model, _ = get_or_load_pipeline(model_id, quality_mode)
    if _WARM_I2I_PIPE is not None and _CURRENT_MODEL_ID == current_model:
        return _WARM_I2I_PIPE
    try:
        _WARM_I2I_PIPE = AutoPipelineForImage2Image.from_pipe(pipe)
        print(f"[Local GPU Daemon] Fast Image2Image pipeline ready for {current_model}!", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[Local GPU Daemon] from_pipe note: {e}, attempting from_pretrained...", file=sys.stderr, flush=True)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        for lfo in [True, False]:
            try:
                _WARM_I2I_PIPE = AutoPipelineForImage2Image.from_pretrained(
                    current_model,
                    torch_dtype=dtype,
                    variant="fp16" if device == "cuda" else None,
                    local_files_only=lfo,
                )
                break
            except Exception:
                if not lfo:
                    pass
        if _WARM_I2I_PIPE is not None and device == "cuda":
            if "xl" in current_model.lower():
                try:
                    _WARM_I2I_PIPE.enable_model_cpu_offload()
                except Exception:
                    _WARM_I2I_PIPE.to("cuda")
            else:
                _WARM_I2I_PIPE.to("cuda")
    return _WARM_I2I_PIPE

def to_pil_image(frame_data):
    from PIL import Image
    import numpy as np
    if isinstance(frame_data, Image.Image):
        return frame_data
    try:
        import torch
        if isinstance(frame_data, torch.Tensor):
            frame_data = frame_data.detach().cpu().float().numpy()
    except Exception:
        pass
    if isinstance(frame_data, np.ndarray):
        arr = frame_data
        if arr.dtype in (np.float32, np.float64, np.float16):
            if arr.min() < -0.05:
                arr = np.clip((arr + 1.0) * 127.5, 0, 255).astype(np.uint8)
            elif arr.max() <= 1.05:
                arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
            else:
                arr = np.clip(arr, 0, 255).astype(np.uint8)
        elif arr.dtype != np.uint8:
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        if arr.ndim == 3 and arr.shape[0] in (1, 3, 4) and arr.shape[2] not in (1, 3, 4):
            arr = np.transpose(arr, (1, 2, 0))
        if arr.ndim == 3 and arr.shape[-1] == 1:
            arr = arr.squeeze(-1)
        return Image.fromarray(arr)
    return frame_data

def extract_frames_list(frames_data):
    if frames_data is None:
        return []
    import numpy as np
    try:
        import torch
        if isinstance(frames_data, torch.Tensor):
            frames_data = frames_data.detach().cpu().float().numpy()
    except Exception:
        pass
    if isinstance(frames_data, np.ndarray):
        if frames_data.ndim == 5:
            frames_data = frames_data[0]
        if frames_data.ndim == 4:
            if frames_data.shape[1] in (1, 3, 4) and frames_data.shape[-1] not in (1, 3, 4):
                frames_data = np.transpose(frames_data, (0, 2, 3, 1))
            return [to_pil_image(frames_data[i]) for i in range(frames_data.shape[0])]
        if frames_data.ndim == 3:
            return [to_pil_image(frames_data)]
    if isinstance(frames_data, list):
        if len(frames_data) == 0:
            return []
        first = frames_data[0]
        if isinstance(first, list):
            return [to_pil_image(f) for f in first]
        if isinstance(first, np.ndarray) and first.ndim in (3, 4):
            if first.ndim == 4:
                return [to_pil_image(first[i]) for i in range(first.shape[0])]
            return [to_pil_image(f) for f in frames_data]
        return [to_pil_image(f) for f in frames_data]
    return []


def dehaze_and_reanchor_frames(frames_list, source_reference_img=None):
    """
    Eliminates diffusion variance collapse and 3D VAE white haze by dynamically
    re-anchoring black floors, highlight ceilings, and dynamic range to the source artwork
    (or full sRGB gamut [0.0, 1.0]), smoothly interpolated across time to prevent flicker.
    """
    if not frames_list or len(frames_list) == 0:
        return frames_list
    import numpy as np
    from PIL import Image

    try:
        arrays = []
        for f in frames_list:
            arr = np.array(f).astype(np.float32)
            if arr.max() > 1.05:
                arr = arr / 255.0
            arrays.append(arr)

        n_frames = len(arrays)
        if source_reference_img is not None:
            ref_arr = np.array(source_reference_img).astype(np.float32)
            if ref_arr.max() > 1.05:
                ref_arr = ref_arr / 255.0
            target_low = float(np.percentile(ref_arr, 1))
            target_high = float(np.percentile(ref_arr, 99))
        else:
            target_low = 0.0
            target_high = 1.0

        target_span = max(0.1, target_high - target_low)
        lows = np.array([float(np.percentile(a, 1)) for a in arrays])
        highs = np.array([float(np.percentile(a, 99)) for a in arrays])

        # Smooth thresholds across time to guarantee zero temporal flicker
        if n_frames >= 3:
            kernel = np.array([0.25, 0.5, 0.25], dtype=np.float32)
            lows = np.convolve(lows, kernel, mode="same")
            highs = np.convolve(highs, kernel, mode="same")

        corrected_frames = []
        for i, arr in enumerate(arrays):
            p_low = lows[i]
            p_high = highs[i]
            span = max(1e-5, p_high - p_low)
            stretched = (arr - p_low) / span * target_span + target_low
            stretched = np.clip(stretched, 0.0, 1.0)
            corrected_frames.append(Image.fromarray((stretched * 255.0).astype(np.uint8)))

        return corrected_frames
    except Exception as e:
        print(f"[Local GPU Daemon] Dehaze error: {e}", file=sys.stderr, flush=True)
        return frames_list


def render_artwork(prompt: str, output_path: str, negative_prompt: str = None, width: int = 512, height: int = 512, steps: int = 1, guidance: float = None, seed: int = None, model_id: str = None, lora_id: str = None, lora_scale: float = 1.0):
    import torch
    width = max(256, (int(width) // 8) * 8)
    height = max(256, (int(height) // 8) * 8)
    pipe, active_model, active_lora = get_or_load_pipeline(model_id, lora_id=lora_id, lora_scale=lora_scale)

    is_lcm = active_lora and "lcm" in active_lora.lower()

    if is_lcm:
        # LCM performs best at 4-8 steps with low guidance scale 1.0 - 2.0
        if guidance is None or guidance > 2.5:
            guidance = 1.5
        if steps is None or steps > 12:
            steps = 6
    elif guidance is None:
        guidance = 0.0 if "turbo" in active_model.lower() else 6.0

    device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = None
    if seed is not None and seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)
    else:
        seed = int(time.time() * 1000) % 2147483647
        generator = torch.Generator(device=device).manual_seed(seed)

    start_time = time.time()
    lora_tag = f" + LoRA {active_lora}" if active_lora else ""
    print(f"[Local GPU Daemon] Generating: \"{prompt[:40]}...\" ({width}x{height}, {steps} steps, guidance={guidance}{lora_tag})...", file=sys.stderr, flush=True)

    kwargs = {
        "prompt": prompt,
        "width": width,
        "height": height,
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "generator": generator,
    }
    if guidance > 1.0 and negative_prompt and negative_prompt.strip():
        kwargs["negative_prompt"] = negative_prompt.strip()

    if active_lora:
        kwargs["cross_attention_kwargs"] = {"scale": float(lora_scale)}
        try:
            if hasattr(pipe, "set_adapters"):
                pipe.set_adapters(adapter_weights=[float(lora_scale)])
        except Exception:
            pass

    is_wan = "wan" in active_model.lower()
    if is_wan:
        w_val = max(256, (int(width) // 16) * 16)
        h_val = max(256, (int(height) // 16) * 16)
        result = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt or "ugly, blurry, deformed, low quality",
            width=w_val,
            height=h_val,
            num_frames=1,
            guidance_scale=guidance or 5.0,
            generator=generator,
        )
        extracted = extract_frames_list(getattr(result, "frames", None))
        image = extracted[0] if extracted else to_pil_image(result.frames[0][0])
    else:
        result = pipe(**kwargs)
        image = to_pil_image(result.images[0])

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    image.save(output_path, "PNG", compress_level=1)

    elapsed = time.time() - start_time
    file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

    return {
        "success": True,
        "prompt": prompt,
        "negative_prompt": negative_prompt or "",
        "output_path": output_path,
        "width": width,
        "height": height,
        "steps": steps,
        "guidance": guidance,
        "seed": seed,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": file_size,
        "device": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
        "model": active_model,
        "lora": active_lora or "",
    }

def render_inpaint(
    image_path: str,
    mask_path: str,
    output_path: str = "inpaint_output.png",
    prompt: str = "",
    negative_prompt: str = "",
    strength: float = 0.85,
    steps: int = 20,
    guidance: float = None,
    seed: int = None,
    model_id: str = None,
    lora_id: str = None,
    lora_scale: float = 1.0,
):
    global _WARM_PIPE, _WARM_INPAINT_PIPE, _CURRENT_MODEL_ID, _CURRENT_LORA_ID
    import torch
    from PIL import Image, ImageFilter
    from diffusers import AutoPipelineForInpainting

    start_time = time.time()

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Source image not found: {image_path}")
    if not os.path.exists(mask_path):
        raise FileNotFoundError(f"Mask image not found: {mask_path}")

    # Load / ensure base model pipeline is warm
    pipe, active_model, active_lora = get_or_load_pipeline(
        model_id=model_id,
        lora_id=lora_id,
        lora_scale=lora_scale,
    )

    is_turbo = "turbo" in (active_model or "").lower()

    if _WARM_INPAINT_PIPE is None or getattr(_WARM_INPAINT_PIPE, "_source_model", None) != active_model:
        if _WARM_INPAINT_PIPE is not None:
            del _WARM_INPAINT_PIPE
            _WARM_INPAINT_PIPE = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        print(f"[Local GPU Daemon] Initializing inpaint pipeline from {active_model}...", file=sys.stderr, flush=True)
        inpaint_pipe = AutoPipelineForInpainting.from_pipe(pipe)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        is_sdxl = any(k in (active_model or "").lower() for k in ["xl", "base", "realvis", "juggernaut", "animagine"])
        if device == "cuda":
            if is_sdxl:
                try:
                    inpaint_pipe.enable_model_cpu_offload()
                except Exception:
                    inpaint_pipe.to("cuda")
            else:
                inpaint_pipe.to("cuda")
            try:
                inpaint_pipe.enable_attention_slicing()
            except Exception:
                pass
            if hasattr(inpaint_pipe, "enable_vae_tiling"):
                try:
                    inpaint_pipe.enable_vae_tiling()
                except Exception:
                    pass

        inpaint_pipe._source_model = active_model
        _WARM_INPAINT_PIPE = inpaint_pipe
    else:
        inpaint_pipe = _WARM_INPAINT_PIPE

    init_image = Image.open(image_path).convert("RGB")
    orig_w, orig_h = init_image.size

    # Ensure dimensions are divisible by 8
    target_w = max(64, (orig_w // 8) * 8)
    target_h = max(64, (orig_h // 8) * 8)

    if init_image.size != (target_w, target_h):
        proc_img = init_image.resize((target_w, target_h), Image.Resampling.LANCZOS)
    else:
        proc_img = init_image

    mask_img = Image.open(mask_path).convert("L")
    if mask_img.size != (target_w, target_h):
        mask_img = mask_img.resize((target_w, target_h), Image.Resampling.NEAREST)

    # Calculate steps and guidance
    num_steps = int(steps) if steps and int(steps) > 0 else (4 if is_turbo else 20)
    str_val = max(0.1, min(1.0, float(strength) if strength is not None else 0.85))

    # Ensure num_steps * strength >= 1
    min_steps_req = int(round(1.0 / str_val)) + 1
    if num_steps < min_steps_req:
        num_steps = min_steps_req

    guidance_val = guidance
    if guidance_val is None:
        guidance_val = 0.0 if is_turbo else 7.0

    device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = None
    if seed is not None and seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)

    kwargs = {
        "prompt": prompt or "",
        "negative_prompt": negative_prompt or "ugly, blurry, low quality, artifacts, distorted",
        "image": proc_img,
        "mask_image": mask_img,
        "strength": str_val,
        "num_inference_steps": num_steps,
        "guidance_scale": guidance_val,
    }
    if generator:
        kwargs["generator"] = generator

    if active_lora:
        kwargs["cross_attention_kwargs"] = {"scale": float(lora_scale)}
        try:
            if hasattr(inpaint_pipe, "set_adapters"):
                inpaint_pipe.set_adapters(adapter_weights=[float(lora_scale)])
        except Exception:
            pass

    print(f"[Local GPU Daemon] Running inpaint inference (steps={num_steps}, strength={str_val}, guidance={guidance_val})...", file=sys.stderr, flush=True)
    res = inpaint_pipe(**kwargs)
    generated = to_pil_image(res.images[0])

    # Resize back to exact original canvas dimensions
    if generated.size != (orig_w, orig_h):
        generated = generated.resize((orig_w, orig_h), Image.Resampling.LANCZOS)

    # Feather mask by 2px and composite to guarantee untouched original pixels stay 100% pristine
    orig_mask = mask_img if mask_img.size == (orig_w, orig_h) else mask_img.resize((orig_w, orig_h), Image.Resampling.BILINEAR)
    feathered_mask = orig_mask.filter(ImageFilter.GaussianBlur(radius=2))
    final_image = Image.composite(generated, init_image, feathered_mask)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    final_image.save(output_path, "PNG", compress_level=1)

    elapsed = time.time() - start_time
    file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0

    return {
        "success": True,
        "prompt": prompt,
        "negative_prompt": negative_prompt or "",
        "output_path": output_path,
        "width": orig_w,
        "height": orig_h,
        "strength": str_val,
        "steps": num_steps,
        "guidance": guidance_val,
        "seed": seed,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": file_size,
        "device": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
        "model": active_model,
        "lora": active_lora or "",
    }

def slerp(val, low, high):
    import torch
    low_norm = low / torch.norm(low, dim=-1, keepdim=True)
    high_norm = high / torch.norm(high, dim=-1, keepdim=True)
    dot = (low_norm * high_norm).sum(dim=-1, keepdim=True).clamp(-1.0, 1.0)
    omega = torch.acos(dot)
    so = torch.sin(omega)
    if so.abs().max() < 1e-5:
        return (1.0 - val) * low + val * high
    return (torch.sin((1.0 - val) * omega) / so) * low + (torch.sin(val * omega) / so) * high

def apply_meme_text(image, top_text=None, bottom_text=None, style="impact"):
    from PIL import ImageDraw, ImageFont
    draw = ImageDraw.Draw(image)
    w, h = image.size

    font_path = None
    for f in ["C:\\Windows\\Fonts\\impact.ttf", "C:\\Windows\\Fonts\\arialbd.ttf", "C:\\Windows\\Fonts\\segoeuib.ttf", "C:\\Windows\\Fonts\\arial.ttf"]:
        if os.path.exists(f):
            font_path = f
            break

    def draw_caption(text, is_top=True):
        if not text or not str(text).strip():
            return
        text = str(text).strip().upper() if style == "impact" else str(text).strip()
        words = text.split(" ")

        max_allowed_w = int(w * 0.88)
        max_allowed_h = int(h * 0.32)
        font_size = min(max(16, int(h * 0.065)), 34)
        lines = []
        font = None

        for fs in range(font_size, 11, -2):
            try:
                font = ImageFont.truetype(font_path, fs) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()

            lines = []
            cur_line = []
            too_wide = False
            for word in words:
                test_line = " ".join(cur_line + [word])
                bbox = draw.textbbox((0, 0), test_line, font=font)
                line_w = bbox[2] - bbox[0]
                if line_w > max_allowed_w:
                    if cur_line:
                        lines.append(" ".join(cur_line))
                        cur_line = [word]
                        w_bbox = draw.textbbox((0, 0), word, font=font)
                        if (w_bbox[2] - w_bbox[0]) > max_allowed_w:
                            too_wide = True
                            break
                    else:
                        too_wide = True
                        break
                else:
                    cur_line.append(word)
            if cur_line:
                lines.append(" ".join(cur_line))

            line_height = int(fs * 1.15)
            total_h = len(lines) * line_height
            if not too_wide and total_h <= max_allowed_h:
                font_size = fs
                break

        line_height = int(font_size * 1.15)
        total_text_h = len(lines) * line_height
        y_start = int(h * 0.035) if is_top else int(h * 0.965 - total_text_h)
        stroke_w = max(2, int(font_size * 0.085))

        text_color = "#ffffff"
        stroke_color = "#000000"
        if style == "neon":
            text_color = "#38bdf8"
            stroke_color = "#0f172a"
        elif style == "retro":
            text_color = "#facc15"
            stroke_color = "#000000"

        for idx, line in enumerate(lines):
            bbox = draw.textbbox((0, 0), line, font=font)
            text_w = bbox[2] - bbox[0]
            x = max(10, (w - text_w) // 2)
            y = y_start + (idx * line_height)
            draw.text((x, y), line, font=font, fill=text_color, stroke_width=stroke_w, stroke_fill=stroke_color)

    if top_text:
        draw_caption(top_text, is_top=True)
    if bottom_text:
        draw_caption(bottom_text, is_top=False)

    return image

def write_interpolated_video(frames, output_video_path, fps=60, duration_sec=3.0, is_continuous_video=False):
    """
    Renders frames into a smooth, full-framerate MP4 video with exact timing.
    For continuous video (Wan/LTX DiT), plays frames with crystal-clear sharp pacing at native 16 FPS (NO crossfade ghosting, NO frame-holding stutter).
    For latent morph sequences (SD-Turbo/RealVisXL slerp), applies smooth crossfade blending at 60 FPS.
    """
    import imageio
    import numpy as np
    
    if not frames:
        return
        
    dur_val = float(duration_sec) if duration_sec and float(duration_sec) > 0 else 3.0
    num_k = len(frames)
    
    if is_continuous_video:
        # Wan 2.1 native 16 FPS / LTX native 24 FPS / CogVideoX 16 FPS
        fps_val = int(fps) if fps and int(fps) in (16, 24, 25, 30, 60) else 16
        total_target_frames = max(num_k, int(round(dur_val * fps_val)))
        
        writer = imageio.get_writer(
            output_video_path,
            fps=fps_val,
            codec='libx264',
            quality=9,
            pixelformat='yuv420p',
            ffmpeg_params=['-preset', 'fast', '-crf', '18']
        )
        
        k_arrays = [np.array(f.convert("RGB"), dtype=np.uint8) for f in frames]
        # Pacing: write each generated frame smoothly without artificial looping!
        if total_target_frames <= num_k:
            for arr in k_arrays:
                writer.append_data(arr)
        else:
            for t in range(total_target_frames):
                cycle = 2 * (num_k - 1) if num_k > 1 else 1
                phase = t % cycle if cycle > 0 else 0
                idx = phase if phase < num_k else cycle - phase
                writer.append_data(k_arrays[idx])
            
        writer.close()
    else:
        fps_val = int(fps) if fps and int(fps) > 0 else 60
        total_target_frames = max(num_k, int(round(dur_val * fps_val)))
        
        writer = imageio.get_writer(
            output_video_path,
            fps=fps_val,
            codec='libx264',
            quality=8,
            pixelformat='yuv420p',
            ffmpeg_params=['-preset', 'ultrafast', '-tune', 'fastdecode']
        )
        
        if num_k == 1:
            arr = np.array(frames[0].convert("RGB"))
            for _ in range(total_target_frames):
                writer.append_data(arr)
        else:
            # Slerp morph: linear crossfade blending between latent keyframes
            k_arrays = [np.array(f.convert("RGB"), dtype=np.float32) for f in frames]
            for t in range(total_target_frames):
                pos = t * (num_k - 1) / max(1, total_target_frames - 1)
                k = min(int(pos), num_k - 2)
                frac = pos - k
                blended = np.clip((1.0 - frac) * k_arrays[k] + frac * k_arrays[k + 1], 0, 255).astype(np.uint8)
                writer.append_data(blended)
                
        writer.close()

def render_morph_sequence(prompt: str, output_gif_path: str, num_frames: int = 12, width: int = 512, height: int = 512, top_text: str = None, bottom_text: str = None, style: str = "impact", fps: int = 60, model_id: str = None, duration_sec: float = 3.0, audio_vibe: str = "synthwave", flow_prompt: str = "", image: str = None):
    import torch
    import numpy as np
    pipe, active_model, active_lora = get_or_load_pipeline(model_id)
    is_turbo = "turbo" in active_model.lower()
    is_sdxl = "xl" in active_model.lower() or "base" in active_model.lower() or "realvis" in active_model.lower() or "juggernaut" in active_model.lower()
    
    if not is_turbo and is_sdxl:
        cache_dir = get_hf_hub_cache()
        if os.path.exists(os.path.join(cache_dir, "models--latent-consistency--lcm-lora-sdxl")):
            try:
                pipe, active_model, active_lora = get_or_load_pipeline(active_model, lora_id="latent-consistency/lcm-lora-sdxl")
            except Exception as e:
                print(f"[Local GPU Daemon] Note attaching LCM LoRA to {active_model}: {e}", file=sys.stderr, flush=True)

    is_lcm = active_lora and "lcm" in active_lora.lower()
    if is_lcm:
        num_steps = 4
        guidance = 1.5
    elif is_turbo:
        num_steps = 1
        guidance = 0.0
    else:
        num_steps = 4
        guidance = 2.5

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    width = max(256, (int(width) // 8) * 8)
    height = max(256, (int(height) // 8) * 8)
    num_frames = max(4, min(36, int(num_frames)))

    latent_h = height // 8
    latent_w = width // 8
    shape = (1, 4, latent_h, latent_w)
    
    g0 = torch.Generator(device=device).manual_seed(int(time.time() * 1000) % 2147483647)
    g1 = torch.Generator(device=device).manual_seed((int(time.time() * 1000) + 1337) % 2147483647)
    
    z0 = torch.randn(shape, generator=g0, device=device, dtype=dtype)
    z1 = torch.randn(shape, generator=g1, device=device, dtype=dtype)

    base_dir = os.path.dirname(os.path.abspath(output_gif_path))
    os.makedirs(base_dir, exist_ok=True)
    base_stem = os.path.splitext(os.path.basename(output_gif_path))[0]

    dur_val = float(duration_sec) if duration_sec and float(duration_sec) > 0 else 3.0
    has_audio = audio_vibe not in ("none", "mute", None)
    use_video = output_gif_path.lower().endswith(('.mp4', '.webm')) or dur_val >= 2.0 or has_audio
    output_video_path = os.path.join(base_dir, base_stem + ".mp4")

    start_time = time.time()
    frames = []
    frame_paths = []

    is_wan = "wan" in active_model.lower()
    is_ltx = "ltx" in active_model.lower()
    is_cogvideo = "cogvideo" in active_model.lower()
    is_hunyuan = "hunyuan" in active_model.lower()
    is_dit_video = is_wan or is_ltx or is_cogvideo or is_hunyuan

    if is_dit_video:
        dit_frames_list = []

        if is_wan:
            # Wan 2.1 native 3D spatio-temporal video DiT (Alibaba)
            # High-fidelity 480P native flow-matching (guidance 5.0, 12 steps for fast responsive animation)
            if int(num_frames) >= 25 and dur_val > 3.5:
                target_wan_frames = 33
            else:
                target_wan_frames = 17

            has_input_image = image and os.path.exists(image)
            aspect_ratio = float(width) / float(height) if height > 0 else 1.0
            if aspect_ratio >= 1.4:
                wan_w, wan_h = 832, 480   # 16:9 Landscape 480P Native
            elif aspect_ratio <= 0.7:
                wan_w, wan_h = 480, 832   # 9:16 Vertical / Reel
            elif aspect_ratio >= 1.15:
                wan_w, wan_h = 704, 528   # 4:3
            elif aspect_ratio <= 0.85:
                wan_w, wan_h = 528, 704   # 3:4
            else:
                wan_w, wan_h = 624, 624   # 1:1 Square

            wan_steps = max(10, min(30, int(num_steps))) if num_steps and int(num_steps) > 5 else 12
            wan_guidance = float(guidance) if guidance and float(guidance) >= 3.0 else 5.0
            negative_prompt = "milky, white haze, washed out, low contrast, overall gray, dull colors, faded, Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, worst quality, low quality, JPEG compression residue, ugly, deformed, disfigured, misshapen limbs, still picture, messy background"

            wan_result = None
            if has_input_image:
                # PHOTO-TO-VIDEO (I2V): High-speed photo animation via single-frame latent seed (< 65s on 8GB GPU)
                from PIL import Image, ImageOps
                import torch
                import diffusers.pipelines.wan.pipeline_wan as wan_mod
                import diffusers.pipelines.wan.pipeline_wan_video2video as v2v_mod
                v2v_mod.basic_clean = wan_mod.basic_clean
                from diffusers import WanVideoToVideoPipeline

                global _WARM_I2V_PIPE
                if _WARM_I2V_PIPE is None or getattr(_WARM_I2V_PIPE, "transformer", None) is not pipe.transformer:
                    _WARM_I2V_PIPE = WanVideoToVideoPipeline(
                        transformer=pipe.transformer,
                        vae=pipe.vae,
                        text_encoder=pipe.text_encoder,
                        tokenizer=pipe.tokenizer,
                        scheduler=pipe.scheduler,
                    )
                i2v = _WARM_I2V_PIPE

                source_img = Image.open(image).convert("RGB")
                resized_img = ImageOps.fit(source_img, (wan_w, wan_h), method=Image.Resampling.LANCZOS)

                print(f"[Local GPU Daemon] Animating Photo via Wan 2.1 DiT: \"{prompt[:40]}...\" ({wan_w}x{wan_h}, {target_wan_frames} frames, {wan_steps} steps, cfg={wan_guidance})...", file=sys.stderr, flush=True)
                try:
                    # 1. Fast single-frame VAE encoding (< 1 second, ~4.8GB VRAM)
                    img_t = i2v.video_processor.preprocess_video([resized_img], height=wan_h, width=wan_w).to(device, dtype=i2v.vae.dtype)
                    with torch.inference_mode():
                        single_latent = v2v_mod.retrieve_latents(i2v.vae.encode(img_t), sample_mode="argmax")

                    # 2. Spatio-temporal temporal latent expansion (5 latent frames for 17 video frames)
                    num_latent_frames = 1 + (target_wan_frames - 1) // 4
                    init_latents = single_latent.repeat(1, 1, num_latent_frames, 1, 1)

                    latents_mean = torch.tensor(i2v.vae.config.latents_mean).view(1, i2v.vae.config.z_dim, 1, 1, 1).to(device, torch.float32)
                    latents_std = 1.0 / torch.tensor(i2v.vae.config.latents_std).view(1, i2v.vae.config.z_dim, 1, 1, 1).to(device, torch.float32)
                    init_latents = (init_latents.to(device=device, dtype=torch.float32) - latents_mean) * latents_std

                    # 3. Exact flow-matching noise schedule (preserves photo identity + generates smooth cinematic motion)
                    strength = 0.65
                    timesteps, num_inference_steps = v2v_mod.retrieve_timesteps(i2v.scheduler, wan_steps, device)
                    timesteps, num_inference_steps = i2v.get_timesteps(num_inference_steps, timesteps, strength, device)
                    latent_timestep = timesteps[:1]
                    noise = torch.randn_like(init_latents)
                    noisy_latents = i2v.scheduler.add_noise(init_latents, noise, latent_timestep)

                    with torch.inference_mode():
                        wan_result = i2v(
                            latents=noisy_latents,
                            prompt=prompt,
                            negative_prompt=negative_prompt,
                            height=wan_h,
                            width=wan_w,
                            num_inference_steps=wan_steps,
                            guidance_scale=wan_guidance,
                            strength=strength,
                        )
                except Exception as wan_err:
                    print(f"[Local GPU Daemon] Wan photo animation note: {wan_err}. Falling back to text-to-video DiT...", file=sys.stderr, flush=True)
                    wan_result = None

            if wan_result is None:
                # TEXT-TO-VIDEO: Pure synthesis from prompt with 5.0 flow guidance
                print(f"[Local GPU Daemon] Synthesizing Wan 2.1 Video DiT: \"{prompt[:40]}...\" ({wan_w}x{wan_h}, {target_wan_frames} frames, {wan_steps} steps, cfg={wan_guidance})...", file=sys.stderr, flush=True)
                import torch
                with torch.inference_mode():
                    wan_result = pipe(
                        prompt=prompt,
                        negative_prompt=negative_prompt,
                        height=wan_h,
                        width=wan_w,
                        num_frames=target_wan_frames,
                        num_inference_steps=wan_steps,
                        guidance_scale=wan_guidance,
                    )
            dit_frames_list = extract_frames_list(getattr(wan_result, "frames", None))

        elif is_ltx:
            # Lightricks LTX-Video DiT (24 FPS, dimensions multiple of 32, (frames-1)%8 == 0)
            aspect_ratio = float(width) / float(height) if height > 0 else 1.0
            if aspect_ratio >= 1.4:
                ltx_w, ltx_h = 768, 448
            elif aspect_ratio <= 0.7:
                ltx_w, ltx_h = 448, 768
            else:
                ltx_w, ltx_h = 512, 512

            target_ltx_frames = 33 if (dur_val >= 2.0 or int(num_frames) >= 25) else 25
            ltx_steps = max(18, min(35, int(num_steps))) if num_steps and int(num_steps) > 5 else 20
            ltx_guidance = float(guidance) if guidance and float(guidance) > 1.0 else 3.0
            ltx_neg = "worst quality, inconsistent motion, blurry, jittery, distorted, low resolution, artifacts"

            print(f"[Local GPU Daemon] Synthesizing LTX-Video DiT: \"{prompt[:40]}...\" ({ltx_w}x{ltx_h}, {target_ltx_frames} frames, {ltx_steps} steps, cfg={ltx_guidance})...", file=sys.stderr, flush=True)
            import torch
            with torch.inference_mode():
                ltx_result = pipe(
                    prompt=prompt,
                    negative_prompt=ltx_neg,
                    height=ltx_h,
                    width=ltx_w,
                    num_frames=target_ltx_frames,
                    num_inference_steps=ltx_steps,
                    guidance_scale=ltx_guidance,
                )
            dit_frames_list = extract_frames_list(getattr(ltx_result, "frames", None))

        elif is_cogvideo:
            # THUDM CogVideoX DiT (8 FPS native, 17/33/49 frames, native 720x480)
            aspect_ratio = float(width) / float(height) if height > 0 else 1.0
            if aspect_ratio >= 1.0:
                cog_w, cog_h = 720, 480
            else:
                cog_w, cog_h = 480, 720

            if int(num_frames) <= 20 and dur_val <= 2.5:
                target_cog_frames = 17
            elif int(num_frames) <= 35 and dur_val <= 4.5:
                target_cog_frames = 33
            else:
                target_cog_frames = 49

            cog_steps = max(16, min(35, int(num_steps))) if num_steps and int(num_steps) > 5 else 20
            cog_guidance = float(guidance) if guidance and float(guidance) > 1.0 else 6.0
            cog_neg = "The video is not of a high quality, it has a low resolution, and the video is not clear."

            print(f"[Local GPU Daemon] Synthesizing CogVideoX DiT: \"{prompt[:40]}...\" ({cog_w}x{cog_h}, {target_cog_frames} frames, {cog_steps} steps, cfg={cog_guidance})...", file=sys.stderr, flush=True)
            import torch
            with torch.inference_mode():
                cog_result = pipe(
                    prompt=prompt,
                    negative_prompt=cog_neg,
                    height=cog_h,
                    width=cog_w,
                    num_frames=target_cog_frames,
                    num_inference_steps=cog_steps,
                    guidance_scale=cog_guidance,
                )
            dit_frames_list = extract_frames_list(getattr(cog_result, "frames", None))

        if len(dit_frames_list) > 0:
            # Auto-dehaze and re-anchor dynamic range to eliminate milky haze and VAE variance collapse
            ref_source = source_img if (has_input_image and 'source_img' in locals() and source_img is not None) else None
            if is_wan or ref_source is not None:
                print(f"[Local GPU Daemon] Applying automatic dynamic-range re-anchoring & anti-haze filter...", file=sys.stderr, flush=True)
                dit_frames_list = dehaze_and_reanchor_frames(dit_frames_list, source_reference_img=ref_source)

            for i, img in enumerate(dit_frames_list):
                frame_png = os.path.join(base_dir, f"{base_stem}_f{i:02d}.png")
                img.save(frame_png, "PNG", compress_level=1)
                frame_paths.append(frame_png)
                if top_text or bottom_text:
                    img = apply_meme_text(img.copy(), top_text, bottom_text, style=style)
                frames.append(img)
        else:
            print(f"[Local GPU Daemon] DiT video model ({active_model}) produced 0 frames; gracefully falling back to Fast Motion Flow...", file=sys.stderr, flush=True)
            is_dit_video = False
            pipe, active_model, active_lora = get_or_load_pipeline("default")
            is_turbo = True
            num_steps = 1
            guidance = 0.0

    if not is_dit_video:
        has_input_image = image and os.path.exists(image)
        if has_input_image:
            # FAST PHOTO-TO-VIDEO: Smooth autoregressive img2img with camera/motion flow
            from PIL import Image, ImageOps
            
            source_img = Image.open(image).convert("RGB")
            resized_source = ImageOps.fit(source_img, (width, height), method=Image.Resampling.LANCZOS)
            
            i2i_pipe = get_or_load_i2i_pipeline(active_model)
            print(f"[Local GPU Daemon] Animating Photo via Fast Motion Flow: \"{prompt[:40]}...\" ({width}x{height}, {num_frames} frames)...", file=sys.stderr, flush=True)
            
            curr_img = resized_source
            frame_png = os.path.join(base_dir, f"{base_stem}_f00.png")
            curr_img.save(frame_png, "PNG", compress_level=1)
            frame_paths.append(frame_png)
            if top_text or bottom_text:
                frames.append(apply_meme_text(curr_img.copy(), top_text, bottom_text, style=style))
            else:
                frames.append(curr_img)

            if is_turbo:
                i2i_strength = 0.50
                i2i_steps = 5
                i2i_guidance = 0.0
            else:
                i2i_strength = 0.40
                i2i_steps = max(6, num_steps)
                i2i_guidance = guidance
            
            for i in range(1, num_frames):
                # Subtle optical camera motion (0.8% zoom in per frame)
                zoom_factor = 1.008
                w_crop = max(64, int(width / zoom_factor))
                h_crop = max(64, int(height / zoom_factor))
                x_crop = (width - w_crop) // 2
                y_crop = (height - h_crop) // 2
                cropped = curr_img.crop((x_crop, y_crop, x_crop + w_crop, y_crop + h_crop))
                guided_input = cropped.resize((width, height), Image.Resampling.BICUBIC)

                if i2i_pipe is not None:
                    try:
                        res = i2i_pipe(
                            prompt=prompt,
                            image=guided_input,
                            strength=i2i_strength,
                            num_inference_steps=i2i_steps,
                            guidance_scale=i2i_guidance,
                        )
                        curr_img = res.images[0]
                    except Exception as e:
                        print(f"[Local GPU Daemon] i2i step {i} note: {e}, using guided input", file=sys.stderr, flush=True)
                        curr_img = guided_input
                else:
                    curr_img = guided_input
                
                frame_png = os.path.join(base_dir, f"{base_stem}_f{i:02d}.png")
                curr_img.save(frame_png, "PNG", compress_level=1)
                frame_paths.append(frame_png)
                
                if top_text or bottom_text:
                    frames.append(apply_meme_text(curr_img.copy(), top_text, bottom_text, style=style))
                else:
                    frames.append(curr_img)
        else:
            exec_dev = getattr(pipe, "_execution_device", device)
            for i in range(num_frames):
                alpha = i / float(num_frames - 1) if num_frames > 1 else 0.0
                z_t = slerp(alpha, z0, z1)
                if hasattr(z_t, "to") and str(z_t.device) != str(exec_dev):
                    try:
                        z_t = z_t.to(exec_dev)
                    except Exception:
                        pass
                
                result = pipe(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=num_steps,
                    guidance_scale=guidance,
                    latents=z_t,
                )
                img = result.images[0]
                
                frame_png = os.path.join(base_dir, f"{base_stem}_f{i:02d}.png")
                img.save(frame_png, "PNG", compress_level=1)
                frame_paths.append(frame_png)

                if top_text or bottom_text:
                    img = apply_meme_text(img.copy(), top_text, bottom_text, style=style)
                
                frames.append(img)

    if is_wan:
        actual_fps = 16
    elif is_ltx:
        actual_fps = 24
    elif is_cogvideo:
        actual_fps = 8
    else:
        actual_fps = fps

    is_continuous = is_dit_video or is_wan or is_ltx or is_cogvideo
    if use_video:
        try:
            write_interpolated_video(frames, output_video_path, fps=actual_fps, duration_sec=dur_val, is_continuous_video=is_continuous)

            # Save high quality JPEG poster frame for instant gallery thumbnails
            if frames:
                poster_path = os.path.join(base_dir, base_stem + "_poster.jpg")
                frames[0].convert("RGB").save(poster_path, "JPEG", quality=88)

            if audio_vibe not in ("none", "mute", None):
                mux_audio_into_video(output_video_path, audio_vibe=audio_vibe, duration_sec=dur_val, flow_prompt=flow_prompt)
        except Exception as e:
            print(f"[Video Writer Error]: {str(e)}")

    if output_gif_path.lower().endswith('.gif') or not os.path.exists(output_video_path):
        duration_ms = max(20, int((dur_val * 1000.0) / max(1, len(frames))))
        frames[0].save(
            output_gif_path,
            save_all=True,
            append_images=frames[1:],
            duration=duration_ms,
            loop=0,
            optimize=False
        )

    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    elapsed = time.time() - start_time
    final_output = output_video_path if (use_video and os.path.exists(output_video_path)) else output_gif_path
    return {
        "success": True,
        "output_gif": final_output,
        "output_path": final_output,
        "frames_count": len(frames),
        "frame_paths": frame_paths,
        "fps": actual_fps,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": os.path.getsize(final_output) if os.path.exists(final_output) else 0,
        "model": active_model,
    }

def render_storyline_sequence(chapters: list, output_gif_path: str, width: int = 512, height: int = 512, frames_per_chapter: int = 6, top_text: str = None, bottom_text: str = None, style: str = "impact", fps: int = 60, model_id: str = None, duration_sec: float = 6.0, audio_vibe: str = "synthwave", flow_prompt: str = ""):
    import torch
    import numpy as np
    from PIL import Image
    start_time = time.time()

    # AI Storyline generates multi-chapter narrative arcs with 2D latent morph transitions.
    # 3D video temporal volume models (Wan, LTX, CogVideoX) cannot accept 2D latent keyframes.
    model_lower = (model_id or "").lower()
    if any(m in model_lower for m in ["wan", "ltx", "cogvideo", "hunyuan"]):
        hub = get_hf_hub_cache()
        if os.path.exists(os.path.join(hub, "models--SG161222--RealVisXL_V5.0")):
            fallback_story_model = "SG161222/RealVisXL_V5.0"
        else:
            fallback_story_model = get_first_local_checkpoint() or "default"
        print(f"[Local GPU Daemon] Notice: AI Storyline requires 2D multi-chapter latent blending. Video DiT ({model_id}) cannot accept 2D latents. Auto-routing to {fallback_story_model}...", file=sys.stderr, flush=True)
        model_id = fallback_story_model

    pipe, active_model, active_lora = get_or_load_pipeline(model_id)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    if pipe is None:
        return {"success": False, "error": "Failed to load diffusion pipeline on GPU"}

    is_turbo = "turbo" in active_model.lower()
    is_sdxl = "xl" in active_model.lower() or "base" in active_model.lower() or "realvis" in active_model.lower() or "juggernaut" in active_model.lower()
    
    if not is_turbo and is_sdxl:
        cache_dir = get_hf_hub_cache()
        if os.path.exists(os.path.join(cache_dir, "models--latent-consistency--lcm-lora-sdxl")):
            try:
                pipe, active_model, active_lora = get_or_load_pipeline(active_model, lora_id="latent-consistency/lcm-lora-sdxl")
            except Exception as e:
                print(f"[Local GPU Daemon] Note attaching LCM LoRA to {active_model}: {e}", file=sys.stderr, flush=True)

    is_lcm = active_lora and "lcm" in active_lora.lower()
    if is_lcm:
        num_steps = 4
        guidance = 1.5
    elif is_turbo:
        num_steps = 1
        guidance = 0.0
    else:
        num_steps = 4
        guidance = 2.5

    if not chapters:
        chapters = ["A cosmic beginning", "A grand kingdom", "A futuristic metropolis"]

    width = max(256, (int(width) // 8) * 8)
    height = max(256, (int(height) // 8) * 8)
    frames_per_chapter = max(2, min(24, int(frames_per_chapter)))
    latent_h = height // 8
    latent_w = width // 8
    shape = (1, 4, latent_h, latent_w)

    keyframe_latents = [torch.randn(shape, device=device, dtype=dtype) for _ in chapters]
    
    all_frames = []
    frame_paths = []
    base_dir = os.path.dirname(os.path.abspath(output_gif_path))
    base_stem = os.path.splitext(os.path.basename(output_gif_path))[0]
    os.makedirs(base_dir, exist_ok=True)

    frame_idx = 0
    num_chapters = len(chapters)
    
    for c_idx in range(num_chapters):
        curr_prompt = chapters[c_idx]
        next_prompt = chapters[(c_idx + 1) % num_chapters] if num_chapters > 1 else curr_prompt
        z_start = keyframe_latents[c_idx]
        z_end = keyframe_latents[(c_idx + 1) % num_chapters] if num_chapters > 1 else z_start

        for f in range(frames_per_chapter):
            alpha = f / float(frames_per_chapter)
            z_t = slerp(alpha, z_start, z_end)
            exec_dev = getattr(pipe, "_execution_device", device)
            if hasattr(z_t, "to") and str(z_t.device) != str(exec_dev):
                try:
                    z_t = z_t.to(exec_dev)
                except Exception:
                    pass
            
            result = pipe(
                prompt=curr_prompt if alpha < 0.5 else next_prompt,
                width=width,
                height=height,
                num_inference_steps=num_steps,
                guidance_scale=guidance,
                latents=z_t,
            )
            img = result.images[0]
            
            frame_png = os.path.join(base_dir, f"{base_stem}_f{frame_idx:03d}.png")
            img.save(frame_png, "PNG", compress_level=1)
            frame_paths.append(frame_png)

            chapter_top = top_text if top_text else f"ACT {c_idx+1}: {curr_prompt[:24].upper()}"
            img = apply_meme_text(img.copy(), chapter_top, bottom_text or "", style=style)
            all_frames.append(img)
            frame_idx += 1

    dur_val = float(duration_sec) if duration_sec and float(duration_sec) > 0 else 6.0
    has_audio = audio_vibe not in ("none", "mute", None)
    use_video = output_gif_path.lower().endswith(('.mp4', '.webm')) or dur_val >= 2.0 or has_audio
    output_video_path = os.path.join(base_dir, base_stem + ".mp4")

    if use_video:
        try:
            write_interpolated_video(all_frames, output_video_path, fps=fps, duration_sec=dur_val)

            # Save poster frame
            if all_frames:
                poster_path = os.path.join(base_dir, base_stem + "_poster.jpg")
                all_frames[0].convert("RGB").save(poster_path, "JPEG", quality=88)

            if audio_vibe not in ("none", "mute", None):
                mux_audio_into_video(output_video_path, audio_vibe=audio_vibe, duration_sec=dur_val, flow_prompt=flow_prompt)
        except Exception as e:
            print(f"[Video Writer Error]: {str(e)}")

    if output_gif_path.lower().endswith('.gif') or not os.path.exists(output_video_path):
        duration_ms = max(20, int((dur_val * 1000.0) / max(1, len(all_frames))))
        all_frames[0].save(
            output_gif_path,
            save_all=True,
            append_images=all_frames[1:],
            duration=duration_ms,
            loop=0,
            optimize=False
        )

    elapsed = time.time() - start_time
    final_output = output_video_path if (use_video and os.path.exists(output_video_path)) else output_gif_path
    return {
        "success": True,
        "output_gif": final_output,
        "output_path": final_output,
        "frames_count": len(all_frames),
        "frame_paths": frame_paths,
        "fps": fps,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": os.path.getsize(final_output) if os.path.exists(final_output) else 0,
        "model": active_model,
    }

def generate_procedural_soundtrack(vibe: str, duration_sec: float = 60.0, sample_rate: int = 44100, flow_prompt: str = "") -> str:
    import numpy as np
    import wave
    import tempfile
    import re

    total_samples = int(duration_sec * sample_rate)
    t = np.linspace(0, duration_sec, total_samples, endpoint=False)

    left = np.zeros(total_samples, dtype=np.float32)
    right = np.zeros(total_samples, dtype=np.float32)

    flow_lower = (flow_prompt or "").lower()
    vibe_lower = (vibe or "synthwave").lower()

    # 1. Determine BPM from explicit prompt or musical genre
    bpm = 138.0
    bpm_match = re.search(r'(\d{2,3})\s*bpm', flow_lower)
    if bpm_match:
        try: bpm = float(bpm_match.group(1))
        except: bpm = 138.0
    elif any(k in flow_lower or k in vibe_lower for k in ["dnb", "drum and bass", "hyperpop", "breakbeat"]):
        bpm = 168.0
    elif any(k in flow_lower or k in vibe_lower for k in ["phonk", "drift", "trap", "rave"]):
        bpm = 144.0
    elif any(k in flow_lower or k in vibe_lower for k in ["synthwave", "outrun", "cyberpunk", "trance", "techno", "action"]):
        bpm = 132.0
    elif any(k in flow_lower or k in vibe_lower for k in ["rock", "metal", "heavy", "guitar"]):
        bpm = 126.0
    elif any(k in flow_lower or k in vibe_lower for k in ["house", "disco", "pop", "dance", "funk"]):
        bpm = 124.0
    elif any(k in flow_lower or k in vibe_lower for k in ["lofi", "chill", "jazz", "relax", "coffee", "study", "hiphop"]):
        bpm = 84.0
    elif any(k in flow_lower or k in vibe_lower for k in ["ambient", "drone", "space", "meditation", "peaceful", "slow"]):
        bpm = 68.0
    elif any(k in flow_lower or k in vibe_lower for k in ["orchestral", "cinema", "epic", "trailer", "hans zimmer", "dramatic"]):
        bpm = 110.0

    beat_sec = 60.0 / bpm
    step_sec = beat_sec / 4.0

    # 2. Dynamic Google Flow Envelope Curve across duration
    intensity = np.ones(total_samples, dtype=np.float32)
    t_arr = np.array(t, dtype=np.float32)
    intro_time = min(12.0, duration_sec * 0.22)
    intro_mask = t_arr < intro_time
    intensity[intro_mask] = 0.25 + 0.75 * (t_arr[intro_mask] / max(1.0, intro_time))

    fade_time = min(3.5, duration_sec * 0.1)
    outro_mask = t_arr > (duration_sec - fade_time)
    intensity[outro_mask] = np.maximum(0.0, 1.0 - (t_arr[outro_mask] - (duration_sec - fade_time)) / max(0.1, fade_time))

    # 3. Genre-Specific Instrument Synthesis
    is_metal = any(k in flow_lower or k in vibe_lower for k in ["metal", "rock", "guitar", "overdrive", "heavy"])
    is_orchestral = any(k in flow_lower or k in vibe_lower for k in ["orchestral", "cinema", "epic", "trailer", "dramatic", "classical", "strings"])
    is_phonk = any(k in flow_lower or k in vibe_lower for k in ["phonk", "drift", "jdm", "cowbell"])
    is_lofi = any(k in flow_lower or k in vibe_lower for k in ["lofi", "chill", "jazz", "rhodes", "relax", "study"])
    is_arcade = any(k in flow_lower or k in vibe_lower for k in ["8bit", "8-bit", "chiptune", "arcade", "retro", "game"])
    is_ambient = any(k in flow_lower or k in vibe_lower for k in ["ambient", "drone", "space", "cosmic", "meditation"])
    is_piano = any(k in flow_lower or k in vibe_lower for k in ["piano", "acoustic", "ballad", "gentle"])

    # Scales & Frequencies (Hz)
    # D Minor / Cinematic Scale
    d_min = [73.42, 82.41, 87.31, 98.0, 110.0, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 523.25, 587.33]
    # C Major / Uplifting Scale
    c_maj = [65.41, 73.42, 82.41, 87.31, 98.0, 110.0, 123.47, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 392.0, 523.25]
    
    is_major = any(k in flow_lower for k in ["happy", "major", "uplifting", "joy", "bright", "sunny", "fun"])
    scale = c_maj if is_major else d_min

    step_indices = np.floor(t / step_sec).astype(int)

    # --- LAYER 1: BASS FOUNDATION ---
    if is_metal:
        # Distorted Overdrive Power-Chord Bass (Root + 5th)
        pat = [0, 0, 0, 3, 0, 0, 5, 4, 0, 0, 0, 3, 5, 6, 5, 3]
        f0 = np.array([scale[pat[i % len(pat)]] for i in step_indices])
        f5 = f0 * 1.4983 # Perfect 5th
        phase0 = 2.0 * np.pi * np.cumsum(f0) / sample_rate
        phase5 = 2.0 * np.pi * np.cumsum(f5) / sample_rate
        saw = (phase0 / np.pi) % 2.0 - 1.0 + 0.7 * ((phase5 / np.pi) % 2.0 - 1.0)
        # Heavy tube distortion saturation
        dist_bass = np.tanh(saw * 3.8) * 0.45 * intensity
        left += dist_bass * 0.9
        right += dist_bass * 1.1
    elif is_phonk:
        # 808 Sub-Bass Slide
        pat = [0, 0, 0, 0, 3, 3, 0, 0, 5, 5, 0, 0, 4, 4, 2, 2]
        f_sub = np.array([scale[pat[i % len(pat)]] * 0.5 for i in step_indices])
        sub_phase = 2.0 * np.pi * np.cumsum(f_sub) / sample_rate
        sub = np.sin(sub_phase) * 0.65 * intensity
        left += sub
        right += sub
    elif is_lofi:
        # Warm Mellow Sine Sub
        pat = [0, 0, 4, 4, 2, 2, 5, 5]
        f_sub = np.array([scale[pat[i % len(pat)]] for i in step_indices])
        sub_phase = 2.0 * np.pi * np.cumsum(f_sub) / sample_rate
        sub = (np.sin(sub_phase) + 0.3 * np.sin(2.0 * sub_phase)) * 0.4 * intensity
        left += sub
        right += sub
    elif is_orchestral:
        # Staccato Contrabass & Cello Pulses
        pat = [0, 0, 0, 0, 2, 2, 0, 0, 3, 3, 0, 0, 5, 5, 4, 2]
        f0 = np.array([scale[pat[i % len(pat)]] for i in step_indices])
        phase = 2.0 * np.pi * np.cumsum(f0) / sample_rate
        env = np.exp(-((t % step_sec) / step_sec) * 4.0)
        cello = ((phase / np.pi) % 2.0 - 1.0) * env * 0.45 * intensity
        left += cello * 0.95
        right += cello * 0.95
    else:
        # Analog 16th-note Synthwave / Cyberpunk Sawtooth Bass
        pat = [0, 2, 3, 5, 0, 3, 5, 7, 0, 2, 5, 8, 3, 5, 7, 10]
        bass_freqs = np.array([scale[pat[i % len(pat)]] for i in step_indices])
        phase = 2.0 * np.pi * np.cumsum(bass_freqs) / sample_rate
        saw_bass = (phase / np.pi) % 2.0 - 1.0
        env_step = np.exp(-((t % step_sec) / step_sec) * 5.0)
        bass_track = saw_bass * env_step * 0.38 * intensity
        left += bass_track
        right += bass_track

    # --- LAYER 2: HARMONIES, CHORDS & MELODIC LEADS ---
    if is_phonk:
        # High Memphis Cowbell Melody
        cow_scale = [587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5]
        cow_pat = [0, 3, 5, 3, 6, 5, 3, 0, 2, 4, 5, 4, 3, 2, 0, 3]
        f_cow = np.array([cow_scale[cow_pat[i % len(cow_pat)]] for i in step_indices])
        cow_env = np.exp(-((t % step_sec) / step_sec) * 12.0)
        cow_sound = (np.sin(2.0 * np.pi * f_cow * t) + 0.6 * np.sin(2.0 * np.pi * f_cow * 1.5 * t)) * cow_env * 0.35 * intensity
        left += cow_sound * 1.1
        right += cow_sound * 0.8
    elif is_arcade:
        # Fast 8-Bit Chiptune Square Wave Arpeggio
        arp_pat = [0, 4, 7, 12, 16, 12, 7, 4]
        f_arp = np.array([scale[arp_pat[i % len(arp_pat)] + 6] for i in step_indices])
        phase_arp = 2.0 * np.pi * np.cumsum(f_arp) / sample_rate
        sq = np.where((phase_arp % (2.0 * np.pi)) < np.pi, 1.0, -1.0)
        left += sq * 0.18 * intensity
        right += sq * 0.18 * intensity
    elif is_orchestral:
        # Brass Swells & Choir Pad
        pad_f = 293.66 # D4
        pad = (np.sin(2.0 * np.pi * pad_f * t) + 0.5 * np.sin(2.0 * np.pi * pad_f * 1.5 * t) + 0.3 * np.sin(2.0 * np.pi * pad_f * 2.0 * t)) * 0.28 * intensity
        left += pad * 0.85
        right += pad * 1.15
    elif is_lofi or is_piano:
        # Warm Rhodes / Piano Harmonic Chords
        chord_root = 261.63 # C4 / D4
        chord = (np.sin(2.0 * np.pi * chord_root * t) * 0.4 + 
                 np.sin(2.0 * np.pi * chord_root * 1.2 * t) * 0.3 + 
                 np.sin(2.0 * np.pi * chord_root * 1.5 * t) * 0.25) * 0.22 * intensity
        left += chord
        right += chord * 1.05
    else:
        # Analog Poly-Synth Chorus Pad
        pad_l = (np.sin(2.0 * np.pi * 220.0 * t) + 0.5 * np.sin(2.0 * np.pi * 330.0 * t)) * 0.22 * intensity
        pad_r = (np.sin(2.0 * np.pi * 220.6 * t) + 0.5 * np.sin(2.0 * np.pi * 330.9 * t)) * 0.22 * intensity
        left += pad_l
        right += pad_r

    # --- LAYER 3: DRUMS & PERCUSSION SECTION ---
    if not is_ambient:
        # Kick Drum (Punchy pitch envelope)
        beat_phase = (t % beat_sec) / beat_sec
        kick_env = np.exp(-beat_phase * 24.0)
        kick_freq = 50.0 + (120.0 if not is_orchestral else 45.0) * np.exp(-beat_phase * 35.0)
        kick = np.sin(2.0 * np.pi * kick_freq * t) * kick_env * 0.58 * intensity
        left += kick
        right += kick

        # Snare / Clap on Beat 2 and 4
        snare_trigger = np.floor((t % (beat_sec * 2.0)) / beat_sec).astype(int) == 1
        snare_phase = (t % beat_sec) / beat_sec
        snare_env = np.where(snare_trigger, np.exp(-snare_phase * 18.0), 0.0)
        snare_noise = (np.random.rand(total_samples).astype(np.float32) * 2.0 - 1.0) * snare_env * 0.32 * intensity
        left += snare_noise * 0.95
        right += snare_noise * 1.05

        # Rolling Hi-Hats
        hat_div = step_sec if not is_phonk else (step_sec * 0.5)
        hat_phase = (t % hat_div) / hat_div
        hat_env = np.exp(-hat_phase * 35.0)
        hat_noise = (np.random.rand(total_samples).astype(np.float32) * 2.0 - 1.0) * hat_env * 0.12 * intensity
        left += hat_noise * 0.8
        right += hat_noise * 1.2

    # Master Limiter & Stereo Normalization
    left = np.tanh(left * 1.15)
    right = np.tanh(right * 1.15)

    audio_stereo = np.vstack((left, right)).T
    audio_int16 = (audio_stereo * 32767.0).astype(np.int16)

    wav_path = os.path.join(tempfile.gettempdir(), f"soundtrack_{int(time.time()*1000)}.wav")
    with wave.open(wav_path, 'w') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int16.tobytes())

    return wav_path

def resolve_audio_file(path_or_vibe: str):
    if not path_or_vibe or str(path_or_vibe).lower() in ("none", "mute", "false"):
        return None
    candidate = str(path_or_vibe).strip()
    if os.path.exists(candidate) and os.path.isfile(candidate):
        return os.path.abspath(candidate)
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    possible_roots = [
        os.getcwd(),
        os.path.join(os.getcwd(), "workspace"),
        os.path.join(os.getcwd(), "workspace", "audio"),
        os.path.abspath(os.path.join(script_dir, "..", "..")),
        os.path.abspath(os.path.join(script_dir, "..", "..", "workspace")),
        os.path.abspath(os.path.join(script_dir, "..", "..", "workspace", "audio")),
    ]
    for root in possible_roots:
        p1 = os.path.join(root, candidate)
        if os.path.exists(p1) and os.path.isfile(p1):
            return os.path.abspath(p1)
        p2 = os.path.join(root, os.path.basename(candidate))
        if os.path.exists(p2) and os.path.isfile(p2):
            return os.path.abspath(p2)
    return None

def mux_audio_into_video(video_path: str, audio_vibe: str = "synthwave", duration_sec: float = 60.0, flow_prompt: str = "") -> str:
    if not os.path.exists(video_path) or audio_vibe in ("none", "mute", None):
        return video_path
    try:
        import imageio_ffmpeg
        import subprocess
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        # Check if user provided custom audio file path (e.g. FLAC, WAV, MP3)
        custom_file = resolve_audio_file(audio_vibe) or resolve_audio_file(flow_prompt)

        base, ext = os.path.splitext(video_path)
        muxed_path = base + "_audio" + ext

        if custom_file:
            # Mux & fit custom audio track
            fade_start = max(0.5, duration_sec - 1.5)
            cmd = [
                ffmpeg_exe,
                '-y',
                '-i', video_path,
                '-stream_loop', '-1',
                '-i', custom_file,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest',
                '-af', f'afade=t=out:st={fade_start:.1f}:d=1.5',
                muxed_path
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
        else:
            # Generate procedural soundtrack tailored to prompt
            wav_path = generate_procedural_soundtrack(audio_vibe, duration_sec=duration_sec, flow_prompt=flow_prompt)
            cmd = [
                ffmpeg_exe,
                '-y',
                '-i', video_path,
                '-i', wav_path,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest',
                muxed_path
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            try: os.unlink(wav_path)
            except Exception: pass

        if res.returncode == 0 and os.path.exists(muxed_path) and os.path.getsize(muxed_path) > 1000:
            try:
                os.replace(muxed_path, video_path)
                return video_path
            except Exception:
                return muxed_path
    except Exception as e:
        print(f"[Audio Mux Warning]: {str(e)}")
    return video_path

def stitch_images(image_paths: list, output_gif_path: str, top_text: str = None, bottom_text: str = None, style: str = "impact", fps: int = 60, crossfade_frames: int = 4, duration_sec: float = 4.0, audio_vibe: str = "synthwave", flow_prompt: str = ""):
    from PIL import Image
    import numpy as np
    start_time = time.time()
    if not image_paths:
        return {"success": False, "error": "No images provided for stitching"}

    valid_paths = [p for p in image_paths if os.path.exists(p)]
    if not valid_paths:
        return {"success": False, "error": "No valid images could be opened from provided paths"}

    num_images = len(valid_paths)
    try:
        with Image.open(valid_paths[0]) as first_img:
            target_w, target_h = first_img.size
    except Exception as e:
        return {"success": False, "error": f"Failed reading base image dimensions: {str(e)}"}

    target_w = max(64, (int(target_w) // 2) * 2)
    target_h = max(64, (int(target_h) // 2) * 2)

    dur_val = float(duration_sec) if duration_sec and float(duration_sec) > 0 else 4.0
    fps_val = int(fps) if fps and int(fps) > 0 else 60

    base_dir = os.path.dirname(os.path.abspath(output_gif_path))
    os.makedirs(base_dir, exist_ok=True)
    base_stem = os.path.splitext(output_gif_path)[0]

    # If video format, audio requested, or duration >= 2s, export MP4 video via imageio streaming
    has_audio = audio_vibe not in ("none", "mute", None)
    use_video_stream = num_images >= 80 or dur_val >= 2.0 or output_gif_path.lower().endswith(('.mp4', '.webm')) or has_audio
    output_video_path = base_stem + ".mp4"

    if num_images >= 80:
        computed_fps = max(1, round(num_images / dur_val))
        repeat_per_img = 1
    else:
        computed_fps = fps_val
        total_target_frames = max(len(valid_paths), int(round(dur_val * computed_fps)))
        repeat_per_img = max(1, total_target_frames // max(1, num_images))

    loaded_frames = []
    gif_preview_frames = []
    gif_sample_step = max(1, num_images // 120) if num_images > 120 else 1

    for idx, p in enumerate(valid_paths):
        try:
            with Image.open(p) as raw_img:
                rgb = raw_img.convert("RGB")
                if rgb.size != (target_w, target_h):
                    rgb = rgb.resize((target_w, target_h), Image.Resampling.BILINEAR)
                if top_text or bottom_text:
                    rgb = apply_meme_text(rgb, top_text, bottom_text, style=style)
                loaded_frames.append(rgb)
                if idx % gif_sample_step == 0 and len(gif_preview_frames) < 180:
                    gif_preview_frames.append(rgb.copy())
        except Exception:
            continue

    if use_video_stream and loaded_frames:
        try:
            write_interpolated_video(loaded_frames, output_video_path, fps=computed_fps, duration_sec=dur_val)
            if gif_preview_frames:
                try:
                    poster_path = base_stem + "_poster.jpg"
                    gif_preview_frames[0].save(poster_path, "JPEG", quality=88)
                except Exception:
                    pass
            if audio_vibe not in ("none", "mute", None):
                mux_audio_into_video(output_video_path, audio_vibe=audio_vibe, duration_sec=dur_val, flow_prompt=flow_prompt)
        except Exception as e:
            print(f"[Stitch Video Writer Error]: {str(e)}")

    # Save GIF preview / output
    if output_gif_path.lower().endswith('.gif') or not os.path.exists(output_video_path):
        if gif_preview_frames:
            gif_dur_ms = max(20, int((dur_val * 1000.0) / max(1, len(gif_preview_frames))))
            gif_preview_frames[0].save(
                output_gif_path,
                save_all=True,
                append_images=gif_preview_frames[1:],
                duration=gif_dur_ms,
                loop=0,
                optimize=False
            )

    elapsed = time.time() - start_time
    final_output = output_video_path if (use_video_stream and os.path.exists(output_video_path)) else output_gif_path

    return {
        "success": True,
        "output_path": final_output,
        "output_gif": output_gif_path if os.path.exists(output_gif_path) else final_output,
        "output_video": output_video_path if os.path.exists(output_video_path) else None,
        "frames_count": frame_count or len(gif_preview_frames),
        "fps": computed_fps,
        "duration_sec": dur_val,
        "elapsed_seconds": round(elapsed, 2),
        "file_size_bytes": os.path.getsize(final_output) if os.path.exists(final_output) else 0,
    }

def run_daemon_loop(initial_model="default"):
    """Persistent warm IPC loop reading line-delimited JSON from stdin"""
    global _WARM_PIPE, _CURRENT_MODEL_ID

    # Ensure unbuffered line-based IO
    try:
        sys.stdin.reconfigure(line_buffering=True)
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    print(json.dumps({"event": "ready", "status": "GPU Art Daemon online", "gpu": check_cuda()}), flush=True)
    
    # Pre-warm requested model
    try:
        get_or_load_pipeline(initial_model or "default")
        print(json.dumps({"event": "model_warmed", "model": _CURRENT_MODEL_ID}), flush=True)
    except Exception as e:
        print(json.dumps({"event": "warm_warning", "error": str(e)}), flush=True)

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            action = req.get("action", "generate")

            if action in ["preload", "warm"]:
                target_model = req.get("model", "default")
                resolved = resolve_model_id(target_model)
                try:
                    get_or_load_pipeline(resolved)
                    print(json.dumps({"id": req.get("id"), "event": "model_warmed", "success": True, "model": _CURRENT_MODEL_ID, "message": f"Model {_CURRENT_MODEL_ID} warm in VRAM"}), flush=True)
                except Exception as exc:
                    print(json.dumps({"id": req.get("id"), "success": False, "error": str(exc)}), flush=True)
                continue

            if action == "ping":
                print(json.dumps({"id": req.get("id"), "success": True, "pong": True, "model": _CURRENT_MODEL_ID}), flush=True)
                continue

            if action == "check_gpu":
                print(json.dumps({"id": req.get("id"), "success": True, **check_cuda()}), flush=True)
                continue

            if action == "generate":
                prompt = req.get("prompt", "")
                output = req.get("output", "output.png")
                neg = req.get("negative_prompt")
                w = req.get("width", 512)
                h = req.get("height", 512)
                steps = req.get("steps", 1)
                guidance = req.get("guidance")
                seed = req.get("seed")
                model = req.get("model")
                lora = req.get("lora")
                lora_scale = float(req.get("lora_scale", 1.0))

                res = render_artwork(
                    prompt=prompt,
                    output_path=output,
                    negative_prompt=neg,
                    width=w,
                    height=h,
                    steps=steps,
                    guidance=guidance,
                    seed=seed,
                    model_id=model,
                    lora_id=lora,
                    lora_scale=lora_scale,
                )
                res["id"] = req.get("id")
                print(json.dumps(res), flush=True)
                continue

            if action == "render_sequence":
                prompt = req.get("prompt", "")
                output = req.get("output", "output.gif")
                num_frames = req.get("num_frames", 12)
                w = req.get("width", 512)
                h = req.get("height", 512)
                top_text = req.get("top_text")
                bottom_text = req.get("bottom_text")
                style = req.get("style", "impact")
                fps = req.get("fps", 60)
                model = req.get("model")

                audio_vibe = req.get("audio_vibe", "synthwave")
                flow_prompt = req.get("flow_prompt", "")
                image = req.get("image")

                res = render_morph_sequence(
                    prompt=prompt,
                    output_gif_path=output,
                    num_frames=num_frames,
                    width=w,
                    height=h,
                    top_text=top_text,
                    bottom_text=bottom_text,
                    style=style,
                    fps=fps,
                    model_id=model,
                    duration_sec=float(req.get("duration_sec", 3.0)),
                    audio_vibe=audio_vibe,
                    flow_prompt=flow_prompt,
                    image=image,
                )
                res["id"] = req.get("id")
                print(json.dumps(res), flush=True)
                continue

            if action == "stitch_images":
                images = req.get("images", [])
                output = req.get("output", "output.gif")
                top_text = req.get("top_text")
                bottom_text = req.get("bottom_text")
                style = req.get("style", "impact")
                fps = req.get("fps", 60)
                crossfade = req.get("crossfade", 4)
                audio_vibe = req.get("audio_vibe", "synthwave")
                flow_prompt = req.get("flow_prompt", "")

                res = stitch_images(
                    image_paths=images,
                    output_gif_path=output,
                    top_text=top_text,
                    bottom_text=bottom_text,
                    style=style,
                    fps=fps,
                    crossfade_frames=crossfade,
                    duration_sec=float(req.get("duration_sec", 4.0)),
                    audio_vibe=audio_vibe,
                    flow_prompt=flow_prompt,
                )
                res["id"] = req.get("id")
                print(json.dumps(res), flush=True)
                continue

            if action == "render_storyline":
                chapters = req.get("chapters", [])
                output = req.get("output", "storyline.gif")
                w = req.get("width", 512)
                h = req.get("height", 512)
                frames_per_chapter = req.get("frames_per_chapter", 6)
                top_text = req.get("top_text")
                bottom_text = req.get("bottom_text")
                style = req.get("style", "impact")
                fps = req.get("fps", 60)
                model = req.get("model")
                audio_vibe = req.get("audio_vibe", "synthwave")
                flow_prompt = req.get("flow_prompt", "")

                res = render_storyline_sequence(
                    chapters=chapters,
                    output_gif_path=output,
                    width=w,
                    height=h,
                    frames_per_chapter=frames_per_chapter,
                    top_text=top_text,
                    bottom_text=bottom_text,
                    style=style,
                    fps=fps,
                    model_id=model,
                    duration_sec=float(req.get("duration_sec", 6.0)),
                    audio_vibe=audio_vibe,
                    flow_prompt=flow_prompt,
                )
                res["id"] = req.get("id")
                print(json.dumps(res), flush=True)
                continue

            if action == "inpaint":
                image_path = req.get("image")
                mask_path = req.get("mask")
                output = req.get("output", "inpaint_output.png")
                prompt = req.get("prompt", "")
                neg = req.get("negative_prompt")
                strength = float(req.get("strength", 0.85))
                steps = int(req.get("steps", 20))
                guidance = req.get("guidance")
                seed = req.get("seed")
                model = req.get("model")
                lora = req.get("lora")
                lora_scale = float(req.get("lora_scale", 1.0))

                res = render_inpaint(
                    image_path=image_path,
                    mask_path=mask_path,
                    output_path=output,
                    prompt=prompt,
                    negative_prompt=neg,
                    strength=strength,
                    steps=steps,
                    guidance=guidance,
                    seed=seed,
                    model_id=model,
                    lora_id=lora,
                    lora_scale=lora_scale,
                )
                res["id"] = req.get("id")
                print(json.dumps(res), flush=True)
                continue

            if action == "unload":
                _WARM_PIPE = None
                _WARM_INPAINT_PIPE = None
                _CURRENT_MODEL_ID = None
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                print(json.dumps({"id": req.get("id"), "success": True, "message": "VRAM unloaded"}), flush=True)
                continue

            print(json.dumps({"id": req.get("id"), "success": False, "error": f"Unknown action: {action}"}), flush=True)

        except Exception as e:
            print(json.dumps({"id": req.get("id") if "req" in locals() else None, "success": False, "error": str(e)}), flush=True)

def main():
    parser = argparse.ArgumentParser(description="NexusRoute Local GPU Art Engine")
    parser.add_argument("--daemon", action="store_true", help="Run persistent warm IPC daemon on stdin/stdout")
    parser.add_argument("--check-gpu", action="store_true", help="Print GPU status and exit")
    parser.add_argument("--prompt", type=str, default="", help="Text prompt for image generation")
    parser.add_argument("--negative-prompt", type=str, default="", help="Negative prompt")
    parser.add_argument("--output", type=str, default="output.png", help="Output image file path")
    parser.add_argument("--width", type=int, default=512, help="Image width (default 512)")
    parser.add_argument("--height", type=int, default=512, help="Image height (default 512)")
    parser.add_argument("--steps", type=int, default=1, help="Inference steps (default 1 for turbo, 28 for quality)")
    parser.add_argument("--guidance", type=float, default=None, help="Guidance scale")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument("--model", type=str, default="default", help="Model ID")
    parser.add_argument("--lora", type=str, default="", help="LoRA model repository or path")
    parser.add_argument("--lora-scale", type=float, default=1.0, help="LoRA adapter weight scale")
    parser.add_argument("--inpaint-image", type=str, default="", help="Source image path for inpainting")
    parser.add_argument("--inpaint-mask", type=str, default="", help="Mask image path for inpainting")
    parser.add_argument("--strength", type=float, default=0.85, help="Denoising strength for inpainting (0.1 to 1.0)")

    args = parser.parse_args()

    if args.daemon:
        run_daemon_loop(initial_model=args.model)
        sys.exit(0)

    if args.check_gpu:
        status = check_cuda()
        print(json.dumps(status))
        sys.stdout.flush()
        sys.exit(0)

    if args.inpaint_image and args.inpaint_mask:
        try:
            res = render_inpaint(
                image_path=args.inpaint_image,
                mask_path=args.inpaint_mask,
                output_path=args.output,
                prompt=args.prompt,
                negative_prompt=args.negative_prompt,
                strength=args.strength,
                steps=args.steps,
                guidance=args.guidance,
                seed=args.seed,
                model_id=args.model,
                lora_id=args.lora,
                lora_scale=args.lora_scale,
            )
            print(json.dumps(res))
            sys.stdout.flush()
            sys.exit(0)
        except Exception as e:
            err_res = {"success": False, "error": str(e)}
            print(json.dumps(err_res), file=sys.stderr)
            sys.stderr.flush()
            sys.exit(1)

    if not args.prompt:
        print(json.dumps({"success": False, "error": "Prompt cannot be empty"}), file=sys.stderr)
        sys.exit(1)

    try:
        res = render_artwork(
            prompt=args.prompt,
            output_path=args.output,
            negative_prompt=args.negative_prompt,
            width=args.width,
            height=args.height,
            steps=args.steps,
            guidance=args.guidance,
            seed=args.seed,
            model_id=args.model,
            lora_id=args.lora,
            lora_scale=args.lora_scale,
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

