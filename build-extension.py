"""Build the shared dashboard UI, browser preview, and extension package."""

import json
import re
import subprocess
import zipfile
from pathlib import Path

root = Path(__file__).parent
extension = root / "extension"
fixture = json.loads((root / "fixtures/demo-availability.json").read_text(encoding="utf-8"))
(extension / "preview-data.js").write_text(
    "globalThis.RailWatchPreviewData=" + json.dumps(fixture, ensure_ascii=False) + ";\n",
    encoding="utf-8",
)
html = (root / "dashboard.html").read_text(encoding="utf-8")
template = re.search(r'<template id="dashboard-template">(.*?)</template>', html, re.S)[1]
css_source = re.search(r"<style>(.*?)</style>", template, re.S)[1]
css = css_source.replace(":root", ":host")
css = re.sub(r"(?<![\w.-])body(?=\s*[{.#:\[])", ".app", css)
css = css.replace("html.theme-transition", ".shell.theme-transition")


def remove_status_label_hover(match):
    selectors = [
        selector
        for selector in match[1].split(",")
        if not (
            ":hover" in selector
            and re.search(r"\.mx-cell\b.*\s+i\s*$|\.dt-coaches\b.*\.state\s*$", selector)
        )
    ]
    return ",".join(selectors) + "{" + match[2] + "}" if selectors else ""


css = re.sub(r"([^{}]+)\{([^{}]*)\}", remove_status_label_hover, css)
markup = template.split("</style>", 1)[1]
css += """
:host{all:initial}.app{max-width:none;margin:0;padding:0}.shell{position:fixed;inset:0;z-index:2147483646;overflow:auto;background:var(--canvas)}
.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483645;background:#17191d;color:#fff;border:0;padding:0 16px;min-height:40px;border-radius:10px;font:600 11.5px/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;box-shadow:0 4px 12px #0002;cursor:pointer}
.launcher:hover{background:#000}.launcher:focus-visible{outline:2px solid #fff;outline-offset:2px}
.ck-status .status{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
.ck-status .status:has(.chip:not([hidden])){grid-template-columns:auto minmax(0,1fr) auto}
.ck-status .chip{box-sizing:border-box;width:76px;text-align:center}
.ck-status .chip-snap{width:124px}
.status-copy{display:grid;grid-template-columns:minmax(0,1fr) max-content;min-width:0;align-items:center;gap:16px}
.status-copy .st{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.status-copy #statusText{min-width:0}
.status-copy #nextCheckText{color:var(--mute)}
.status-actions{display:flex;gap:10px;flex:none}
.v-cockpit{position:relative}
.v-cockpit .ck-side{border-right:0}
.sidebar-toggle{position:absolute;left:258px;top:0;bottom:0;z-index:4;width:12px;height:auto;padding:0;border:0;border-radius:0;background:transparent;cursor:w-resize;transition:transform 200ms var(--ease-out)}
.sidebar-toggle::before{content:'';position:absolute;left:5px;top:0;bottom:0;width:1px;background:var(--hairline);transition:background-color 150ms var(--ease-out)}
.sidebar-toggle:hover::before{background:var(--mid)}
.sidebar-toggle:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.v-cockpit.sidebar-collapsed{grid-template-columns:24px minmax(0,1fr) 320px}
.sidebar-collapsed .ck-side{visibility:hidden;overflow:hidden;opacity:0}
.sidebar-collapsed .sidebar-toggle{cursor:e-resize;transform:translateX(-240px)}
@media(max-width:1180px){.v-cockpit,.v-cockpit.sidebar-collapsed{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 12px auto auto}.v-cockpit .ck-side{grid-row:1;border-bottom:0}.sidebar-toggle{position:relative;grid-row:2;left:auto;top:auto;bottom:auto;width:100%;height:12px;cursor:n-resize}.sidebar-toggle::before{left:0;right:0;top:5px;bottom:auto;width:auto;height:1px}.sidebar-collapsed .sidebar-toggle{cursor:s-resize;transform:none}.sidebar-collapsed .ck-side{display:none}.v-cockpit .ck-main{grid-row:3}.v-cockpit .ck-rail{grid-row:4}}
.train-picker{position:relative}
.train-picker summary{display:flex;align-items:center;justify-content:space-between;gap:8px;list-style:none;padding:8px 0;border-bottom:1px solid var(--hairline);font:400 13px/1.4 var(--font-ui);cursor:pointer}
.train-picker summary::-webkit-details-marker{display:none}
.train-picker summary span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.train-picker summary:focus-visible{outline:1px solid var(--focus);outline-offset:3px}
.train-picker summary svg{transition:transform 180ms var(--ease-out)}
.train-picker[open] summary svg{transform:rotate(180deg)}
.train-picker::details-content{position:relative;z-index:3;content-visibility:hidden;opacity:0;transform:translateY(-4px) scale(.97);transform-origin:top center;transition:opacity 180ms var(--ease-out),transform 180ms var(--ease-out),content-visibility 180ms allow-discrete}
.train-picker[open]::details-content{content-visibility:visible;opacity:1;transform:none}
.train-options{position:absolute;top:100%;left:0;right:0;z-index:3;max-height:240px;overflow-y:auto;background:var(--card);border:1px solid var(--mid);border-radius:6px;padding:12px;box-shadow:0 6px 18px #0003}
@starting-style{.train-picker[open]::details-content{opacity:0;transform:translateY(-4px) scale(.97)}}
.train-options .chk{padding:5px 0}
.train-options>label{border-bottom:1px solid var(--hairline);margin-bottom:5px;padding-bottom:10px}
.matrix-empty{align-self:flex-start;box-sizing:border-box;width:100%;min-height:220px;padding:28px;border:1px dashed var(--mid);background:transparent;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.matrix-empty .eyebrow{color:var(--ink);font:400 16px/1.4 var(--font-ui);letter-spacing:0;text-transform:none;margin:0}
.matrix-empty .empty-body{max-width:38ch;margin:10px 0 20px;color:var(--mute);font:400 13px/1.6 var(--font-ui)}
.availability-notice{margin:12px 0 0;padding:10px 12px;border:1px dashed var(--low-border);border-radius:6px;color:var(--low-ink);background:var(--tint-low);font:400 12px/1.5 var(--font-ui)}
.is-checking .ck-matrix,.is-checking #detail{opacity:.48;pointer-events:none}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.app{min-height:0}
.shell[data-theme="dark"]{color-scheme:dark}.shell[data-theme="light"]{color-scheme:light}
.dt-coaches button.row-link{font:inherit;text-align:left;border:0;background:transparent;cursor:pointer}
.dt-coaches button.row-link:disabled{opacity:.6;cursor:default}
.dt-coaches .coach-desc{grid-column:1;grid-row:2;font:400 12px/1.6 var(--font-ui);color:var(--mute);overflow-wrap:anywhere}
.dt-coaches .prs{grid-row:3}
#sw-tip{max-width:min(320px,calc(100vw - 24px));box-sizing:border-box;white-space:normal;overflow-wrap:anywhere}
.ac-item[aria-selected="true"]{background:var(--soft);color:var(--ink)}
.ug-date input{pointer-events:none}
.ug-date:focus-within .ug-date-txt{text-decoration:none}
.date-trigger{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:pointer}
.date-trigger:focus-visible{outline:1px solid var(--focus);outline-offset:2px;border-radius:3px}
.date-calendar{position:fixed;margin:0;padding:16px;width:296px;max-width:calc(100vw - 24px);box-sizing:border-box;border:1px solid var(--hairline);border-radius:10px;background:var(--card);color:var(--ink);font:400 13px/1.4 var(--font-ui);box-shadow:0 12px 40px #0004;opacity:0;transform:translateY(4px) scale(.97);transform-origin:top left;transition:opacity 180ms var(--ease-out),transform 180ms var(--ease-out),display 180ms allow-discrete,overlay 180ms allow-discrete}
.date-calendar[open]{opacity:1;transform:none}
.date-calendar::backdrop{background:transparent}
@starting-style{.date-calendar[open]{opacity:0;transform:translateY(4px) scale(.97)}}
@media(prefers-reduced-motion:reduce){.date-calendar,.train-picker::details-content,.chk input::before{transform:none!important}.date-calendar,.date-calendar::backdrop,.ck-logcard .hist-scroll,.chk input::before,.ck-side{transition:opacity 125ms var(--ease-out),display 125ms allow-discrete,overlay 125ms allow-discrete,visibility 125ms allow-discrete!important}.train-picker::details-content{transition:opacity 125ms var(--ease-out),content-visibility 125ms allow-discrete!important}}
.calendar-header{display:flex;align-items:center;gap:6px;margin-bottom:12px}
#calendarMonth{flex:1;text-align:center;white-space:nowrap}
.calendar-days{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center}
.calendar-days span{color:var(--mute);padding:6px 0;font-size:11px}
.calendar-days button{height:32px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--ink);font:inherit;cursor:pointer}
.calendar-days button:hover{background:var(--soft)}
.calendar-days button[data-today]{border-color:var(--hairline)}
.calendar-days button[aria-pressed="true"]{background:var(--focus);color:var(--canvas)}
.calendar-days button:disabled{opacity:.3;cursor:default}
.calendar-days button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
"""
markup = (
    "<style>"
    + css
    + '</style><button class="launcher" id="launcher">Seat dashboard</button><section class="shell" id="shell" data-theme="dark" data-accent="brass" hidden><div class="app">'
    + markup
    + "</div></section>"
)
renderers = (extension / "renderers.js").read_text(encoding="utf-8")
ui = (
    renderers
    + "\nglobalThis.RailWatchUI={markup:"
    + json.dumps(markup, ensure_ascii=False)
    + ",create:globalThis.RailWatchRenderers};\n"
)
(extension / "ui.js").write_text(ui, encoding="utf-8")
controller_sources = ["booking.js", "watch.js", "controller.js"]
controller_parts = []
for name in controller_sources:
    source = (extension / name).read_text(encoding="utf-8")
    if name != "controller.js":
        binding = "RailWatchBooking" if name == "booking.js" else "RailWatchWatch"
        source = source.replace(
            "globalThis." + binding + " =",
            "const " + binding + " = globalThis." + binding + " =",
            1,
        )
    controller_parts.append(source)
(extension / "content.js").write_text(
    "// Generated by build-extension.py from booking.js, watch.js and controller.js.\n(() => {\n"
    + "\n".join(controller_parts)
    + "\n})();\n",
    encoding="utf-8",
)
preview_scripts = [
    "preview-data.js",
    "alerts.js",
    "scanner.js",
    "ui.js",
    "calendar.js",
    "preview-runtime.js",
    "content.js",
]
manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
scripts = {manifest["background"]["service_worker"]}
scripts.update(preview_scripts)
scripts.update(["booking.js", "watch.js"])
for entry in manifest["content_scripts"]:
    scripts.update(entry["js"])
for script in sorted(scripts | {"controller.js", "renderers.js"}):
    subprocess.run(["node", "--check", str(extension / script)], check=True)
package_files = {
    "extension/" + name: extension / name
    for name in scripts - {"preview-data.js", "preview-runtime.js"}
    | {"manifest.json", "README.md", "icon.png", "icon.svg"}
}
package_files["extension/LICENSE"] = root / "LICENSE"
with zipfile.ZipFile(
    root / "railway-seat-watch-extension.zip", "w", zipfile.ZIP_DEFLATED
) as archive:
    for name, source in sorted(package_files.items()):
        entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, source.read_bytes())
print("Shared dashboard, standalone preview and extension validated and packaged.")
