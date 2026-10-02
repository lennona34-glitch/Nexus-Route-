"""
Nexus Web Browser for Windows
Built with PyQt6 and Qt WebEngine (Chromium Core)
"""

import sys
import os
from PyQt6.QtCore import QUrl, Qt
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QToolBar, QLineEdit,
    QTabWidget, QWidget, QVBoxLayout, QHBoxLayout,
    QStatusBar, QProgressBar, QLabel, QPushButton
)
from PyQt6.QtGui import QAction, QKeySequence
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineProfile, QWebEngineSettings

DEFAULT_HOME_URL = "https://www.google.com"

DARK_THEME_QSS = """
QMainWindow {
    background-color: #0f172a;
}
QToolBar {
    background: #1e293b;
    border-bottom: 1px solid #334155;
    padding: 4px 8px;
    spacing: 6px;
}
QToolButton {
    background: transparent;
    color: #f8fafc;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    font-weight: 500;
}
QToolButton:hover {
    background: #334155;
    border: 1px solid #475569;
}
QToolButton:pressed {
    background: #0284c7;
}
QLineEdit#urlBar {
    background-color: #0f172a;
    color: #f8fafc;
    border: 1px solid #475569;
    border-radius: 8px;
    padding: 6px 14px;
    font-size: 13px;
    selection-background-color: #38bdf8;
    selection-color: #0f172a;
}
QLineEdit#urlBar:focus {
    border: 1px solid #38bdf8;
    background-color: #020617;
}
QTabWidget::pane {
    border: none;
    background: #0f172a;
}
QTabBar::tab {
    background: #1e293b;
    color: #94a3b8;
    border: 1px solid #334155;
    border-bottom: none;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    padding: 8px 16px;
    margin-right: 2px;
    min-width: 120px;
    max-width: 220px;
    font-size: 12px;
}
QTabBar::tab:selected {
    background: #0f172a;
    color: #38bdf8;
    border: 1px solid #475569;
    border-bottom: 2px solid #38bdf8;
    font-weight: bold;
}
QTabBar::tab:hover:!selected {
    background: #334155;
    color: #f8fafc;
}
QProgressBar {
    border: none;
    background: transparent;
    height: 3px;
    text-align: center;
}
QProgressBar::chunk {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #38bdf8, stop:1 #818cf8);
}
QStatusBar {
    background: #0f172a;
    color: #64748b;
    border-top: 1px solid #1e293b;
    font-size: 11px;
}
"""

class NexusBrowserWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Nexus Browser (Windows 64-bit)")
        self.resize(1280, 800)

        profile = QWebEngineProfile.defaultProfile()
        profile.setHttpUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 NexusBrowser/1.0")
        settings = profile.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.ScrollAnimatorEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.tabs.setTabsClosable(True)
        self.tabs.setMovable(True)
        self.tabs.tabCloseRequested.connect(self.close_tab)
        self.tabs.currentChanged.connect(self.tab_changed)

        add_tab_btn = QPushButton("➕")
        add_tab_btn.setToolTip("Open New Tab (Ctrl+T)")
        add_tab_btn.setStyleSheet("background: transparent; color: #38bdf8; font-size: 14px; font-weight: bold; border: none; padding: 4px 10px;")
        add_tab_btn.clicked.connect(lambda: self.add_new_tab())
        self.tabs.setCornerWidget(add_tab_btn, Qt.Corner.TopRightCorner)

        self.setCentralWidget(self.tabs)

        self.create_nav_bar()
        self.create_bookmarks_bar()

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.progress_bar = QProgressBar()
        self.progress_bar.setMaximumWidth(140)
        self.progress_bar.setVisible(False)
        self.status.addPermanentWidget(self.progress_bar)

        self.add_new_tab(QUrl(DEFAULT_HOME_URL), "Google")
        self.setup_shortcuts()

    def create_nav_bar(self):
        nav_bar = QToolBar("Navigation")
        nav_bar.setMovable(False)
        self.addToolBar(nav_bar)

        self.back_btn = QAction("◀", self)
        self.back_btn.setToolTip("Back (Alt+Left)")
        self.back_btn.triggered.connect(lambda: self.current_browser().back() if self.current_browser() else None)
        nav_bar.addAction(self.back_btn)

        self.forward_btn = QAction("▶", self)
        self.forward_btn.setToolTip("Forward (Alt+Right)")
        self.forward_btn.triggered.connect(lambda: self.current_browser().forward() if self.current_browser() else None)
        nav_bar.addAction(self.forward_btn)

        self.reload_btn = QAction("🔄", self)
        self.reload_btn.setToolTip("Reload Page (F5)")
        self.reload_btn.triggered.connect(lambda: self.current_browser().reload() if self.current_browser() else None)
        nav_bar.addAction(self.reload_btn)

        self.home_btn = QAction("🏠", self)
        self.home_btn.setToolTip("Home Page")
        self.home_btn.triggered.connect(self.navigate_home)
        nav_bar.addAction(self.home_btn)

        self.url_bar = QLineEdit()
        self.url_bar.setObjectName("urlBar")
        self.url_bar.setPlaceholderText("Search with Google or enter web address...")
        self.url_bar.returnPressed.connect(self.navigate_to_url)
        nav_bar.addWidget(self.url_bar)

        zoom_in_btn = QAction("🔍+", self)
        zoom_in_btn.setToolTip("Zoom In (Ctrl +)")
        zoom_in_btn.triggered.connect(lambda: self.adjust_zoom(0.1))
        nav_bar.addAction(zoom_in_btn)

        zoom_out_btn = QAction("🔍-", self)
        zoom_out_btn.setToolTip("Zoom Out (Ctrl -)")
        zoom_out_btn.triggered.connect(lambda: self.adjust_zoom(-0.1))
        nav_bar.addAction(zoom_out_btn)

    def create_bookmarks_bar(self):
        bm_bar = QToolBar("Bookmarks")
        bm_bar.setMovable(False)
        self.addToolBar(Qt.ToolBarArea.TopToolBarArea, bm_bar)

        bookmarks = [
            ("🤖 NexusRoute AI", "http://127.0.0.1:3000"),
            ("🔍 Google", "https://www.google.com"),
            ("💻 GitHub", "https://github.com"),
            ("▶️ YouTube", "https://www.youtube.com"),
            ("📚 Wikipedia", "https://www.wikipedia.org"),
            ("🦆 DuckDuckGo", "https://duckduckgo.com"),
            ("📰 Reddit", "https://www.reddit.com"),
        ]

        for title, url in bookmarks:
            action = QAction(title, self)
            action.triggered.connect(lambda checked, u=url: self.add_new_tab(QUrl(u), u))
            bm_bar.addAction(action)

    def setup_shortcuts(self):
        new_tab_action = QAction(self)
        new_tab_action.setShortcut(QKeySequence("Ctrl+T"))
        new_tab_action.triggered.connect(lambda: self.add_new_tab())
        self.addAction(new_tab_action)

        close_tab_action = QAction(self)
        close_tab_action.setShortcut(QKeySequence("Ctrl+W"))
        close_tab_action.triggered.connect(lambda: self.close_tab(self.tabs.currentIndex()))
        self.addAction(close_tab_action)

        f5_action = QAction(self)
        f5_action.setShortcut(QKeySequence("F5"))
        f5_action.triggered.connect(lambda: self.current_browser().reload() if self.current_browser() else None)
        self.addAction(f5_action)

        focus_url_action = QAction(self)
        focus_url_action.setShortcut(QKeySequence("Ctrl+L"))
        focus_url_action.triggered.connect(lambda: self.url_bar.setFocus() or self.url_bar.selectAll())
        self.addAction(focus_url_action)

    def current_browser(self) -> QWebEngineView:
        return self.tabs.currentWidget()

    def add_new_tab(self, qurl: QUrl = None, label: str = "New Tab"):
        if qurl is None:
            qurl = QUrl(DEFAULT_HOME_URL)

        browser = QWebEngineView()
        browser.setUrl(qurl)

        browser.urlChanged.connect(lambda u, b=browser: self.update_url_bar(u, b))
        browser.loadProgress.connect(lambda p, b=browser: self.update_progress(p, b))
        browser.loadFinished.connect(lambda _, b=browser: self.update_title(b))

        i = self.tabs.addTab(browser, label)
        self.tabs.setCurrentIndex(i)

    def close_tab(self, i):
        if self.tabs.count() > 1:
            widget = self.tabs.widget(i)
            if widget:
                widget.deleteLater()
            self.tabs.removeTab(i)
        else:
            self.add_new_tab(QUrl(DEFAULT_HOME_URL), "Google")
            self.tabs.removeTab(0)

    def tab_changed(self, i):
        browser = self.current_browser()
        if browser:
            url = browser.url()
            self.update_url_bar(url, browser)
            self.update_title(browser)

    def update_url_bar(self, qurl: QUrl, browser: QWebEngineView):
        if browser == self.current_browser():
            self.url_bar.setText(qurl.toString())
            self.url_bar.setCursorPosition(0)

    def update_progress(self, progress: int, browser: QWebEngineView):
        if browser == self.current_browser():
            self.progress_bar.setVisible(progress < 100)
            self.progress_bar.setValue(progress)

    def update_title(self, browser: QWebEngineView):
        i = self.tabs.indexOf(browser)
        if i != -1:
            title = browser.page().title()
            if not title or title.strip() == "":
                title = browser.url().host() or "Tab"
            if len(title) > 20:
                title = title[:18] + "..."
            self.tabs.setTabText(i, title)
            if browser == self.current_browser():
                self.setWindowTitle(f"{browser.page().title()} - Nexus Browser")

    def navigate_home(self):
        browser = self.current_browser()
        if browser:
            browser.setUrl(QUrl(DEFAULT_HOME_URL))

    def navigate_to_url(self):
        text = self.url_bar.text().strip()
        if not text:
            return

        if not text.startswith("http://") and not text.startswith("https://") and not text.startswith("file:///"):
            if "." in text and " " not in text:
                url = "https://" + text
            else:
                query = text.replace(" ", "+")
                url = f"https://www.google.com/search?q={query}"
        else:
            url = text

        browser = self.current_browser()
        if browser:
            browser.setUrl(QUrl(url))

    def adjust_zoom(self, delta: float):
        browser = self.current_browser()
        if browser:
            factor = browser.zoomFactor() + delta
            factor = max(0.25, min(3.0, factor))
            browser.setZoomFactor(factor)
            self.status.showMessage(f"Zoom: {int(factor * 100)}%", 2000)

def main():
    os.environ["QT_ENABLE_HIGHDPI_SCALING"] = "1"
    os.environ["QT_AUTO_SCREEN_SCALE_FACTOR"] = "1"

    app = QApplication(sys.argv)
    app.setApplicationName("Nexus Browser")
    app.setStyleSheet(DARK_THEME_QSS)

    window = NexusBrowserWindow()
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
