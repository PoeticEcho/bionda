"""Build one static PNG per KST edition. Fetching its public URL never runs this job."""
import argparse
import base64
import hashlib
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
from threading import Thread
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
KST = timezone(timedelta(hours=9))
ORIGIN = "https://bionda.pages.dev"


def load_api(path, params):
    url = ORIGIN + path + "?" + urlencode(params)
    request = Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Bionda-Briefing/1.0 (+https://bionda.pages.dev/llms.txt)",
    })
    try:
        with urlopen(request, timeout=60) as response:
            data = json.load(response)
    except HTTPError as err:
        if 400 <= err.code < 500 and err.code not in (408, 429):
            raise RuntimeError(f"{path} returned HTTP {err.code}") from err
        raise
    if not data.get("ok"):
        raise ValueError(f"{path} did not return a successful batch")
    return data


def live_data(slot, now, places):
    # The 08:00 edition uses the 08:00 KMA release, the 18:00 edition the 17:00 release.
    day = now.date() - timedelta(days=int(slot == "night" and now.hour < 8))
    base_hour = 8 if slot == "morning" else 17
    expected = datetime.combine(day, datetime.min.time(), KST).replace(hour=base_hour)
    # baseShort() begins requesting a KMA release 20 minutes after its issue time.
    wait = (expected + timedelta(minutes=20) - now).total_seconds()
    if 0 < wait <= 20 * 60:
        print(f"Waiting {wait:.0f}s for the {base_hour:02}:00 KMA release", flush=True)
        time.sleep(wait)
    for attempt in range(7):
        try:
            forecast = load_api("/api/short-term-12", {"roster": 13})
            short_base = forecast.get("sources", {}).get("shortBase")
            if not short_base:
                raise ValueError("No KMA short-term release time in /api/short-term-12")
            issued = datetime.fromisoformat(short_base)
            if (issued >= expected and len(forecast["regions"]) == 13
                    and any(r.get("hours") for r in forecast["regions"])):
                break
            raise ValueError(f"Expected release {expected.isoformat()}, got {issued.isoformat()}, {len(forecast['regions'])} regions")
        except (ValueError, KeyError, OSError, TypeError) as err:
            print(f"Forecast attempt {attempt + 1}: {err}", flush=True)
            if attempt == 6:
                raise
            time.sleep(180)
    query = ";".join(f"{p['name']}|{p['lat']:.3f},{p['lon']:.3f}" for p in places)
    overview = load_api("/api/overview-bundle", {"line": 14, "roadNum": "012", "places": query})
    if not any(r.get("observation") for r in overview["items"].values()):
        raise ValueError("No road observations available")
    return forecast, overview


def prepare(slot, bootstrap, now):
    places = json.loads(subprocess.check_output([
        "node", "-p", "JSON.stringify(require('./lib/bionda-core').CORRIDOR_WATCHED_PLACES)"
    ], cwd=ROOT))
    label = "아침" if slot == "morning" else "저녁"
    if bootstrap:
        # Seed stable URLs with explicitly dated archived data until each first scheduled run.
        snapshot = json.loads((PUBLIC / "api/snapshot.json").read_text())
        forecast = json.loads((PUBLIC / "api/short-term-12.json").read_text())
        overview = {"updatedAt": snapshot["generatedAt"], "items": {
            key: {"observation": obs, "warnings": snapshot["warnings"].get(key, {}).get("warnings", [])}
            for key, obs in snapshot["observations"].items()}}
        edition = "초기 보관 자료 · 정시 갱신 전"
    else:
        forecast, overview = live_data(slot, now, places)
        edition = "자료 기준 " + datetime.fromisoformat(overview["updatedAt"]).astimezone(KST).strftime("%m월 %d일 %H:%M KST")
    ordered = {}
    for p in sorted(places, key=lambda p: p["lon"]):
        key = f"{p['lat']:.3f},{p['lon']:.3f}"
        ordered[key] = {**overview["items"].get(key, {}), "name": p["name"]}
    return [forecast, {"title": label + " 도로기상 브리핑", "edition": edition,
                       "overview": {**overview, "items": ordered}}]


def render(data):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=PUBLIC))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=shutil.which("google-chrome") or shutil.which("chromium"))
            page = browser.new_page()
            # Load a same-origin document without starting either interactive dashboard.
            page.goto(f"http://127.0.0.1:{server.server_port}/llms.txt")
            image = page.evaluate("""async ([payload, options]) => {
              const {renderForecastBriefing} = await import('/share.js');
              return renderForecastBriefing(payload, options).toDataURL('image/png').split(',')[1];
            }""", data)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    original = Image.open(BytesIO(base64.b64decode(image))).convert("RGB")
    for colors in (192, 128, 96, 64, 32):
        encoded = BytesIO()
        original.quantize(colors, dither=Image.Dither.NONE).save(encoded, "PNG", optimize=True)
        if encoded.tell() <= 200 * 1024:
            return encoded.getvalue()
    raise ValueError("Compressed report exceeds 200 KiB")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", choices=("morning", "night"))
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    now = datetime.now(KST)
    slot = args.slot or ("morning" if 8 <= now.hour < 18 else "night")
    day = now.date() - timedelta(days=int(slot == "night" and now.hour < 8))
    try:
        png = render(prepare(slot, args.bootstrap, now))
    except Exception as err:
        # Surface the failing stage in the public Actions summary as well as the job log.
        message = str(err).splitlines()[0].replace("%", "%25") if str(err) else type(err).__name__
        print(f"::error title=Cannot generate {slot} briefing::{message}", flush=True)
        raise
    output = PUBLIC / "share" / (slot + ".png")
    output.parent.mkdir(exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_bytes(png)
    temporary.replace(output)
    metadata = {"edition_id": None} if args.bootstrap else {
        "edition_id": f"{day.isoformat()}-{slot}",
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "bytes": len(png), "sha256": hashlib.sha256(png).hexdigest(),
    }
    output.with_suffix(".json").write_text(json.dumps(metadata) + "\n", encoding="utf-8")
    print(f"{output.name}: {len(png):,} bytes")
