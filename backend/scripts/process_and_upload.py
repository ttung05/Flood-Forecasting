"""
process_and_upload.py
=====================
Đọc toàn bộ file GeoTIFF gốc từ Cloudflare R2 (FloodData/),
tải vào bộ nhớ RAM, chuyển đổi thành PNG trong suốt (4 kênh RGBA)
và upload trực tiếp lên mảng `processed-masks/` trên R2.

Không lưu hay đọc file từ local disk.
"""

import os
import sys
import io
import time
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from PIL import Image
from dotenv import load_dotenv

# ──────────────────────── CONFIG ────────────────────────
ROOT_DIR   = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

R2_ACCOUNT_ID   = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY   = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_KEY   = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET       = os.getenv("R2_BUCKET_NAME", "satellite-data")
R2_PUBLIC_URL   = os.getenv("R2_PUBLIC_URL", f"https://pub-{R2_ACCOUNT_ID}.r2.dev")
R2_ENDPOINT     = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Per-layer colormap: (R, G, B) tuples for low → high
LAYER_COLORMAPS = {
    "rain":          [(227, 242, 253), (33, 150, 243), (13, 71, 161)],   # Blue scale
    "soilmoisture":  [(255, 243, 224), (121, 85, 72),  (62, 39, 35)],    # Brown scale
    "tide":          [(225, 245, 254), (2, 136, 209),  (1, 60, 120)],    # Cyan scale
    "flood":         [(255, 138, 128), (244, 67, 54),  (183, 28, 28)],   # Red scale
}

def _make_rgba(data: np.ndarray, nodata, layer_key: str) -> np.ndarray:
    mask = np.zeros(data.shape, dtype=bool)
    if nodata is not None:
        mask |= (data == nodata)
    mask |= np.isnan(data.astype(float))
    mask |= (data <= 0)

    valid_data = np.where(mask, np.nan, data.astype(float))
    h, w = data.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    valid_vals = valid_data[~np.isnan(valid_data)]
    if valid_vals.size == 0:
        return rgba  

    vmin, vmax = valid_vals.min(), valid_vals.max()
    if vmax == vmin:
        norm = np.zeros_like(valid_data)
    else:
        norm = np.where(np.isnan(valid_data), np.nan, (valid_data - vmin) / (vmax - vmin))

    stops = LAYER_COLORMAPS.get(layer_key, [(200, 200, 200), (50, 50, 50)])

    def interpolate(t, stops):
        n = len(stops) - 1
        idx = min(int(t * n), n - 1)
        lo, hi = stops[idx], stops[idx + 1]
        frac = t * n - idx
        return tuple(int(lo[i] + (hi[i] - lo[i]) * frac) for i in range(3))

    for i in range(h):
        for j in range(w):
            if not np.isnan(norm[i, j]):
                r, g, b = interpolate(float(norm[i, j]), stops)
                rgba[i, j] = [r, g, b, 200]  

    return rgba


def _get_png_key(tif_key: str) -> str:
    """ FloodData/DBSCL/Daily/Rain/Rain_2000_01_01.tif -> processed-masks/DBSCL/Daily/Rain/Rain_2000_01_01.png """
    if not tif_key.startswith("FloodData/"): return None
    suffix = tif_key[len("FloodData/"):]
    if suffix.endswith(".tif"):
        suffix = suffix[:-4] + ".png"
    return "processed-masks/" + suffix


def _layer_key_from_path(tif_key: str) -> str:
    name = Path(tif_key).stem.lower()
    parent = Path(tif_key).parent.name.lower()
    for k in LAYER_COLORMAPS:
        if k in name or k in parent:
            return k
    return "flood"


def upload_one(tif_key: str, s3, dry_run: bool, existing_keys: set) -> bool:
    layer_key = _layer_key_from_path(tif_key)
    png_key   = _get_png_key(tif_key)
    
    if not png_key:
        return False
        
    if existing_keys and png_key in existing_keys:
        return True

    # 1. Download TIF from S3 into memory
    try:
        resp = s3.get_object(Bucket=R2_BUCKET, Key=tif_key)
        tif_bytes = resp['Body'].read()
    except Exception as e:
        print(f"  ❌ Failed to download {tif_key}: {e}", flush=True)
        return False

    # 2. Process to PNG in memory
    try:
        with MemoryFile(tif_bytes) as memfile:
            with memfile.open() as src:
                data = src.read(1)
                nodata = src.nodata
                
        rgba = _make_rgba(data, nodata, layer_key)
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
        buf.seek(0)
        png_bytes = buf.read()
    except Exception as e:
        print(f"  ⚠️  Failed to process {tif_key}: {e}", flush=True)
        return False

    # 3. Upload PNG to S3
    if dry_run:
        print(f"  [DRY-RUN] Would upload {len(png_bytes)//1024}KB → {png_key}", flush=True)
        return True

    try:
        s3.put_object(
            Bucket=R2_BUCKET,
            Key=png_key,
            Body=png_bytes,
            ContentType="image/png",
            CacheControl="public, max-age=31536000, immutable",
        )
        return True
    except Exception as e:
        print(f"  ❌ Upload failed for {png_key}: {e}", flush=True)
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--region", type=str, default="")
    parser.add_argument("--layer", type=str, default="")
    parser.add_argument("--skip-existing", action="store_true")
    args = parser.parse_args()

    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY]):
        print("❌ Missing R2 credentials in .env")
        sys.exit(1)

    s3 = boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
    )

    print(f"🔍 Listing TIF files from Cloudflare R2 bucket: {R2_BUCKET}/FloodData/ …", flush=True)
    
    all_tif_keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix="FloodData/"):
        for obj in page.get("Contents", []):
            k = obj["Key"]
            if k.endswith(".tif"):
                # Apply filters
                if args.region and args.region not in k: continue
                if args.layer and args.layer.lower() not in k.lower(): continue
                all_tif_keys.append(k)
                
    print(f"📦 Found {len(all_tif_keys)} TIF files on R2", flush=True)
    if not all_tif_keys:
        return

    existing_keys = set()
    if args.skip_existing:
        print("📋 Listing existing PNGs on R2 (may take a while) …", flush=True)
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix="processed-masks/"):
            for obj in page.get("Contents", []):
                existing_keys.add(obj["Key"])
        before_len = len(all_tif_keys)
        all_tif_keys = [k for k in all_tif_keys if _get_png_key(k) not in existing_keys]
        print(f"   Skipped {before_len - len(all_tif_keys)} already processed files. {len(all_tif_keys)} remaining.", flush=True)

    start = time.time()
    ok_count = err_count = 0

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(upload_one, k, s3, args.dry_run, existing_keys): k for k in all_tif_keys}
        for i, fut in enumerate(as_completed(futures), 1):
            if fut.result(): ok_count += 1
            else: err_count += 1
            if i % 50 == 0 or i == len(all_tif_keys):
                pct = i / len(all_tif_keys) * 100
                print(f"   [{pct:5.1f}%] {i}/{len(all_tif_keys)} ✅{ok_count} ❌{err_count}", flush=True)

    elapsed = time.time() - start
    print(f"\n✨ Done in {elapsed:.1f}s — ✅ {ok_count} processed and uploaded, ❌ {err_count} failed", flush=True)

if __name__ == "__main__":
    main()
