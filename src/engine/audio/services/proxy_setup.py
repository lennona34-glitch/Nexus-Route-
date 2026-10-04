"""Maestro Proxy Setup Service

Loads proxy configuration from proxy_config.txt (located in the Maestro root
directory) and sets up standard HTTP/HTTPS proxy environment variables
for Python's requests and huggingface_hub libraries after verifying connectivity.
"""

import os
import sys
import urllib.parse

def load_proxy_config():
    """Locate and parse proxy_config.txt from root or app directory."""
    candidates = [
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "proxy_config.txt")),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "proxy_config.txt")),
        os.path.abspath("proxy_config.txt"),
    ]
    
    config_path = None
    for p in candidates:
        if os.path.isfile(p):
            config_path = p
            break
            
    if not config_path:
        return None, {}
        
    config = {}
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith(";"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    config[key.strip().upper()] = val.strip()
    except Exception as e:
        print(f"[Proxy] Warning: Failed to read {config_path}: {e}")
        
    return config_path, config


def init_proxy():
    """Configure environment proxies if enabled and working."""
    config_path, config = load_proxy_config()
    if not config:
        return
        
    custom_url = config.get("CUSTOM_PROXY_URL", "").strip()
    enable_proxy = config.get("ENABLE_PROXY", "").strip().lower() in ("true", "1", "yes")
    
    if not enable_proxy and not custom_url:
        return

    proxy_url = None
    server_desc = ""

    if custom_url:
        proxy_url = custom_url
        server_desc = custom_url.split("@")[-1] if "@" in custom_url else custom_url
    elif enable_proxy:
        username = config.get("NORD_USERNAME", "").strip()
        password = config.get("NORD_PASSWORD", "").strip()
        server = config.get("NORD_SERVER", "amsterdam.nl.socks.nordhold.net").strip()
        port = config.get("NORD_PORT", "1080").strip()
        
        if not username or username == "your_service_username_here" or not password or password == "your_service_password_here":
            print("[Proxy] Notice: ENABLE_PROXY=true in proxy_config.txt, but service credentials have not been entered yet.")
            print("[Proxy] -> Open proxy_config.txt to enter your NordVPN service credentials.")
            print("[Proxy] Running with direct connection for now.")
            return

        # Notice if user put an email address instead of NordVPN service username
        if "@" in username:
            print("=" * 60)
            print("[Proxy] ERROR: NordVPN does NOT accept your email address for SOCKS5!")
            print(f"[Proxy] You entered: '{username}'")
            print("[Proxy] NordVPN requires your generated 'Service Credentials'.")
            print("[Proxy] -> Go to: https://my.nordaccount.com/ -> Services -> NordVPN")
            print("[Proxy] -> Click 'Set up NordVPN manually'")
            print("[Proxy] -> Copy the generated Username and Password.")
            print("[Proxy] Starting Maestro with direct connection so nothing breaks.")
            print("=" * 60)
            return

        enc_user = urllib.parse.quote(username, safe="")
        enc_pass = urllib.parse.quote(password, safe="")
        proxy_url = f"socks5h://{enc_user}:{enc_pass}@{server}:{port}"
        server_desc = f"{server}:{port}"

    if proxy_url:
        # Pre-flight check before applying to environment
        print(f"[Proxy] Verifying NordVPN SOCKS5 proxy connection ({server_desc})...")
        try:
            import requests
            test_resp = requests.get(
                "https://civitai.com/api/v1/models?limit=1",
                headers={"User-Agent": "Maestro/1.0 (CivitAI LoRA Browser)"},
                proxies={"https": proxy_url, "http": proxy_url},
                timeout=10
            )
            if test_resp.status_code == 200:
                print(f"[Proxy] SUCCESS: Connected to NordVPN ({server_desc})! Civitai region check passed.")
                os.environ["HTTP_PROXY"] = proxy_url
                os.environ["HTTPS_PROXY"] = proxy_url
                os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"
            elif test_resp.status_code == 451:
                print(f"[Proxy] Civitai returned 451 (Region blocked) through {server_desc}. Try another server in proxy_config.txt.")
            else:
                print(f"[Proxy] Civitai returned HTTP {test_resp.status_code}. Setting proxy for session.")
                os.environ["HTTP_PROXY"] = proxy_url
                os.environ["HTTPS_PROXY"] = proxy_url
                os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"
        except Exception as test_err:
            err_str = str(test_err)
            if "authentication" in err_str.lower() or "socks5auth" in err_str.lower():
                print("=" * 60)
                print(f"[Proxy] ERROR: Proxy authentication failed on {server_desc}!")
                print(f"[Proxy] Please check your NordVPN Service Credentials in proxy_config.txt.")
                print(f"[Proxy] Continuing with direct connection so the app remains usable.")
                print("=" * 60)
            else:
                print(f"[Proxy] Connection check note ({err_str}). Setting proxy.")
                os.environ["HTTP_PROXY"] = proxy_url
                os.environ["HTTPS_PROXY"] = proxy_url
                os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"

if __name__ == "__main__":
    init_proxy()
