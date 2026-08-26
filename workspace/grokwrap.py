import webview
import sys
import os
import json
import time
from datetime import datetime
from PIL import ImageGrab

APP_TITLE = "GrokWrap"
DEFAULT_URL = "https://grok.com"
WIDTH, HEIGHT = 1200, 800

# Persistent storage folder in AppData for user cookies/sessions
APP_DATA_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'GrokWrap')
os.makedirs(APP_DATA_DIR, exist_ok=True)
SETTINGS_FILE = os.path.join(APP_DATA_DIR, "settings.json")

def load_settings():
    try:
        with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {"last_url": DEFAULT_URL}

def save_settings(data):
    try:
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass

class Api:
    def take_screenshot(self):
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            desktop = os.path.join(os.path.expanduser("~"), "Desktop")
            filename = f"GrokWrap_{timestamp}.png"
            filepath = os.path.join(desktop, filename)
            
            bbox = (window.x, window.y, window.x + window.width, window.y + window.height)
            img = ImageGrab.grab(bbox=bbox)
            img.save(filepath, "PNG")
            return f"📸 Saved to Desktop: {filename}"
        except Exception as e:
            return f"Screenshot error: {str(e)}"

    def set_homepage(self, url):
        settings = load_settings()
        settings["last_url"] = url
        save_settings(settings)
        return "Homepage updated!"

    def reload_page(self):
        window.load_url(window.get_current_url() or DEFAULT_URL)

    def go_home(self):
        window.load_url(DEFAULT_URL)

api = Api()
settings = load_settings()
start_url = settings.get("last_url", DEFAULT_URL)
if "x.com/i/grok" in start_url or not start_url.startswith("http"):
    start_url = DEFAULT_URL

window = webview.create_window(
    title=APP_TITLE,
    url=start_url,
    width=WIDTH,
    height=HEIGHT,
    resizable=True,
    fullscreen=False,
    min_size=(900, 600),
    background_color='#0a0a0a',
    js_api=api
)

def inject_stealth_hover_toolbar(w):
    time.sleep(1.8)
    js = """
    (function() {
        if (document.getElementById('grok-hover-zone')) return;

        // Hover trigger zone (invisible 14px strip along the top edge)
        const trigger = document.createElement('div');
        trigger.id = 'grok-hover-zone';
        trigger.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            height: 14px !important;
            z-index: 2147483646 !important;
            background: transparent !important;
        `;

        // Modern floating pill toolbar (strictly hidden by default, only shows on mouse hover)
        const bar = document.createElement('div');
        bar.id = 'grok-top-bar';
        bar.style.cssText = `
            position: fixed !important;
            top: -65px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            background: rgba(18, 18, 24, 0.92) !important;
            backdrop-filter: blur(16px) !important;
            -webkit-backdrop-filter: blur(16px) !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 30px !important;
            padding: 6px 14px !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            z-index: 2147483647 !important;
            box-shadow: 0 10px 30px rgba(0,0,0,0.55), 0 0 15px rgba(255,255,255,0.05) !important;
            transition: top 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s ease !important;
            opacity: 0 !important;
            pointer-events: none !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        `;

        bar.innerHTML = `
            <button id="btn-home" title="Grok Home" style="background:rgba(255,255,255,0.08);border:none;color:#fff;padding:6px 12px;border-radius:18px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;transition:background 0.2s;">🏠 Home</button>
            <button id="btn-reload" title="Refresh Page" style="background:rgba(255,255,255,0.08);border:none;color:#fff;padding:6px 12px;border-radius:18px;cursor:pointer;font-size:12px;transition:background 0.2s;">🔄 Refresh</button>
            <button id="btn-shot" title="Take Screenshot (Ctrl+S)" style="background:rgba(255,255,255,0.08);border:none;color:#fff;padding:6px 12px;border-radius:18px;cursor:pointer;font-size:12px;transition:background 0.2s;">📸 Screenshot</button>
            <button id="btn-sethome" title="Set current page as startup" style="background:rgba(255,255,255,0.08);border:none;color:#8be9fd;padding:6px 12px;border-radius:18px;cursor:pointer;font-size:12px;transition:background 0.2s;">⭐ Set Start</button>
        `;

        document.body.appendChild(trigger);
        document.body.appendChild(bar);

        let hideTimer = null;

        function showBar() {
            if (hideTimer) clearTimeout(hideTimer);
            bar.style.top = '12px';
            bar.style.opacity = '1';
            bar.style.pointerEvents = 'auto';
        }

        function hideBar() {
            hideTimer = setTimeout(() => {
                bar.style.top = '-65px';
                bar.style.opacity = '0';
                bar.style.pointerEvents = 'none';
            }, 350);
        }

        // Only reveal when mouse hovers over the top trigger or toolbar itself
        trigger.addEventListener('mouseenter', showBar);
        bar.addEventListener('mouseenter', showBar);

        trigger.addEventListener('mouseleave', hideBar);
        bar.addEventListener('mouseleave', hideBar);

        // Button actions
        document.getElementById('btn-home').onclick = () => window.pywebview.api.go_home();
        document.getElementById('btn-reload').onclick = () => window.pywebview.api.reload_page();
        document.getElementById('btn-shot').onclick = async () => {
            const res = await window.pywebview.api.take_screenshot();
            showNotice(res);
        };
        document.getElementById('btn-sethome').onclick = async () => {
            const res = await window.pywebview.api.set_homepage(window.location.href);
            showNotice(res);
        };

        // Subtle hover effects on buttons
        bar.querySelectorAll('button').forEach(btn => {
            btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.2)';
            btn.onmouseleave = () => btn.style.background = btn.id === 'btn-sethome' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.08)';
        });

        function showNotice(text) {
            let toast = document.createElement('div');
            toast.textContent = text;
            toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#00e5ff;color:#000;padding:8px 18px;border-radius:20px;font-size:13px;font-weight:600;z-index:2147483647;box-shadow:0 6px 20px rgba(0,229,255,0.4);transition:opacity 0.3s ease;';
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2200);
        }
    })();
    """
    try:
        w.evaluate_js(js)
    except Exception:
        pass

def on_loaded():
    import threading
    t = threading.Thread(target=inject_stealth_hover_toolbar, args=(window,))
    t.daemon = True
    t.start()

window.events.loaded += on_loaded

if __name__ == '__main__':
    webview.start(
        debug=False,
        private_mode=False,
        storage_path=APP_DATA_DIR,
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0"
    )
