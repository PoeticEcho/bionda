"""Build one static PNG per KST edition. Fetching its public URL never runs this job."""
import argparse
import base64
import hashlib
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
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


def open_public(url, accept):
    request = Request(url, headers={
        "Accept": accept,
        "User-Agent": "Bionda-Briefing/1.0 (+https://bionda.pages.dev/llms.txt)",
    })
    return urlopen(request, timeout=60)


def load_api(path, params):
    url = ORIGIN + path + "?" + urlencode(params)
    try:
        with open_public(url, "application/json") as response:
            data = json.load(response)
    except HTTPError as err:
        if 400 <= err.code < 500 and err.code not in (408, 429):
            raise RuntimeError(f"{path} returned HTTP {err.code}") from err
        raise
    if not data.get("ok"):
        raise ValueError(f"{path} did not return a successful batch")
    return data


def edition_day(now, slot):
    return now.date() - timedelta(days=int(slot == "night" and now.hour < 8))


def live_data(slot, now, places):
    # The 08:00 edition uses the 08:00 KMA release, the 18:00 edition the 17:00 release.
    day = edition_day(now, slot)
    base_hour = 8 if slot == "morning" else 17
    expected = datetime.combine(day, datetime.min.time(), KST).replace(hour=base_hour)
    # baseShort() begins requesting a KMA release 11 minutes after its issue time.
    wait = (expected + timedelta(minutes=12) - now).total_seconds()
    if 0 < wait <= 15 * 60:
        print(f"Waiting {wait:.0f}s for the {base_hour:02}:00 KMA release", flush=True)
        time.sleep(wait)
    for attempt in range(7):
        try:
            params = {"roster": 13, "force": 1, "refreshShort": 1, "refreshUltra": 1} if attempt >= 0 else {"roster": 13}
            forecast = load_api("/api/short-term-12", params)
            short_base = forecast.get("sources", {}).get("shortBase")
            if not short_base:
                raise ValueError("No KMA short-term release time in /api/short-term-12")
            issued = datetime.fromisoformat(short_base)
            min_acceptable = expected - timedelta(hours=3) if attempt == 6 else expected
            if (issued >= min_acceptable and len(forecast["regions"]) == 13
                    and any(r.get("hours") for r in forecast["regions"])):
                break
            raise ValueError(f"Expected release {expected.isoformat()}, got {issued.isoformat()}, {len(forecast['regions'])} regions")
        except (ValueError, KeyError, OSError, TypeError) as err:
            print(f"Forecast attempt {attempt + 1}: {err}", flush=True)
            if attempt == 6:
                raise
            time.sleep(120)
    query = ";".join(f"{p['name']}|{p['lat']:.3f},{p['lon']:.3f}" for p in places)
    overview = load_api("/api/overview-bundle", {"line": 14, "roadNum": "012", "places": query, "force": 1})
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


def receipt_matches(output, edition_id):
    try:
        receipt = json.loads(output.with_suffix(".json").read_text())
        image = output.read_bytes()
        return (receipt.get("edition_id") == edition_id and receipt.get("bytes") == len(image)
                and receipt.get("sha256") == hashlib.sha256(image).hexdigest())
    except (FileNotFoundError, ValueError):
        return False


def verify_published(edition_id):
    slot = edition_id.rsplit("-", 1)[1]
    receipt = json.loads((PUBLIC / "share" / (slot + ".json")).read_text())
    image_url = f"{ORIGIN}/share/{slot}.png?v={receipt['sha256']}"
    for attempt in range(6):
        try:
            with open_public(ORIGIN + "/share/status.json", "application/json") as response:
                if response.headers.get_content_type() != "application/json":
                    raise ValueError("Public status endpoint did not return JSON")
                status = json.load(response)
            if status.get("edition_id") == edition_id:
                if status.get("status") != "ready" or status.get("image_url") != image_url:
                    raise ValueError(f"{edition_id} is not yet available at the public status endpoint")
            else:
                # A later slot can begin while the previous edition is deploying.
                now = datetime.now(KST)
                current = "morning" if 8 <= now.hour < 18 else "night"
                current_id = f"{edition_day(now, current).isoformat()}-{current}"
                if status.get("edition_id") != current_id or status.get("status") not in ("ready", "pending"):
                    raise ValueError("Public status does not identify the current edition")
            with open_public(image_url, "image/png") as response:
                image = response.read(200 * 1024 + 1)
            if hashlib.sha256(image).hexdigest() != receipt["sha256"]:
                raise ValueError("The public PNG hash differs from the published file")
            with open_public(ORIGIN + "/llms.txt", "text/plain") as response:
                if (ORIGIN + "/share/status.json").encode() not in response.read():
                    raise ValueError("The public llms.txt does not point to the status endpoint")
            print(f"Verified public guide, status and PNG: {edition_id}, {len(image):,} bytes")
            return
        except (ValueError, OSError) as err:
            print(f"Publication check {attempt + 1}: {err}", flush=True)
            if attempt == 5:
                raise
            time.sleep(60)


def write_briefing_json(prepared, edition_id, slot, generated_iso, png_bytes, sha256):
    forecast, options = prepared
    overview = options.get("overview", {})
    items = overview.get("items", {})
    road_risk = overview.get("roadRisk") or {}
    branch_sum = road_risk.get("branchSummary") or road_risk.get("corridorSummary") or {}
    regions_out = []
    for key, entry in items.items():
        obs = entry.get("observation") or {}
        wrns = entry.get("warnings") or []
        regions_out.append({
            "name": entry.get("name") or key,
            "coord": key,
            "tempC": obs.get("temp"),
            "roadTempC": obs.get("roadTemp"),
            "surfaceState": obs.get("surfaceState") or "건조",
            "roadStation": obs.get("roadStationName") or obs.get("name"),
            "humidityPct": obs.get("humidity"),
            "todayPrecipMm": obs.get("dayPrecip") or 0,
            "warnings": [w.get("title") for w in wrns if w.get("title")],
        })
    doc = {
        "schema": "bionda-briefing-v2",
        "edition_id": edition_id,
        "slot": slot,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "generatedKst": generated_iso,
        "corridor": "고속국도 제12호선 광주대구선 (고령지사 관할 함양IC 95.0k ~ 옥포JC 176.0k)",
        "shareStatusUrl": f"{ORIGIN}/share/status.json",
        "liveBriefingUrl": f"{ORIGIN}/api/briefing",
        "latestImage": {
            "slot": edition_id,
            "slotLabelKst": f"{edition_id} ({'08:00' if slot == 'morning' else '18:00'} KST)",
            "url": f"{ORIGIN}/share/{slot}.png?v={sha256}",
            "sizeBytes": png_bytes,
            "sha256": sha256,
        },
        "forecastSources": forecast.get("sources", {}),
        "windowKPIs": forecast.get("windowKPIs", {}),
        "branchRoadRisk": {
            "rangeLabel": branch_sum.get("rangeLabel", "함양IC(95.0k)~옥포JC(176.0k)"),
            "maxIce": branch_sum.get("maxIce"),
            "iceLabel": branch_sum.get("iceLabel", "안전"),
            "iceCounts": branch_sum.get("iceCounts", [0, 0, 0, 0]),
            "missingIceCount": branch_sum.get("missingIceCount", 0),
        },
        "regions": regions_out,
    }
    (PUBLIC / "api" / "briefing.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", choices=("morning", "night"))
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument(
        "--write-briefing",
        action="store_true",
        help="Also write public/api/briefing.json (disabled by default so CI git pull --rebase stays clean)",
    )
    parser.add_argument("--verify-edition", help="Check the edition at the public bot URLs after deployment")
    args = parser.parse_args()
    if args.verify_edition:
        verify_published(args.verify_edition)
        raise SystemExit(0)
    now = datetime.now(KST)
    slot = args.slot or ("morning" if 8 <= now.hour < 18 else "night")
    day = edition_day(now, slot)
    edition_id = f"{day.isoformat()}-{slot}"
    output = PUBLIC / "share" / (slot + ".png")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as step_output:
            print(f"edition_id={edition_id}", file=step_output)
    if not args.bootstrap and receipt_matches(output, edition_id):
        print(f"{edition_id} has already been published")
        raise SystemExit(0)
    try:
        prepared = prepare(slot, args.bootstrap, now)
        png = render(prepared)
    except Exception as err:
        # Surface the failing stage in the public Actions summary as well as the job log.
        message = str(err).splitlines()[0].replace("%", "%25") if str(err) else type(err).__name__
        print(f"::error title=Cannot generate {slot} briefing::{message}", flush=True)
        raise
    output.parent.mkdir(exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_bytes(png)
    temporary.replace(output)
    generated_iso = datetime.now(KST).isoformat(timespec="seconds")
    sha256_hex = hashlib.sha256(png).hexdigest()
    metadata = {"edition_id": None} if args.bootstrap else {
        "edition_id": edition_id,
        "generated_at": generated_iso,
        "bytes": len(png), "sha256": sha256_hex,
    }
    output.with_suffix(".json").write_text(json.dumps(metadata) + "\n", encoding="utf-8")
    if not args.bootstrap and args.write_briefing:
        write_briefing_json(prepared, edition_id, slot, generated_iso, len(png), sha256_hex)
    print(f"{output.name}: {len(png):,} bytes")
