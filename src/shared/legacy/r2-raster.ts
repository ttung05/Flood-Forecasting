import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as GeoTIFF from 'geotiff';
import { loadEnv } from '../config/env';
import { MemoryCache } from '../cache/memory-cache';

const env = loadEnv();

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    },
});

const tifCache = new MemoryCache<GeoTIFF.GeoTIFFImage>(50, 1800 * 1000);
const pixelCache = new MemoryCache<number | null>(5000, 300 * 1000);

// Async Mutex for downloading TIFs to avoid duplicate requests for same key
const pendingDownloads = new Map<string, Promise<GeoTIFF.GeoTIFFImage>>();

export async function r2GetJson(key: string): Promise<any> {
    try {
        const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key });
        const res = await r2.send(cmd);
        const str = await res.Body?.transformToString();
        if (!str) return null;
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

export async function r2GetBuffer(key: string): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key });
    const res = await r2.send(cmd);
    const arr = await res.Body?.transformToByteArray();
    if (!arr) throw new Error("Empty body");
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export async function loadDateIndex(region: string): Promise<any> {
    return r2GetJson(`FloodData/${region}/metadata.json`);
}

export function tifKey(region: string, layerInfo: any, date: string): string {

    // Static layers don't have date suffix
    if (layerInfo.isFlat) {
        if (layerInfo.folder) {
            return `FloodData/${region}/${layerInfo.sub}/${layerInfo.folder}/${layerInfo.prefix}.tif`;
        }
        return `FloodData/${region}/${layerInfo.sub}/${layerInfo.prefix}.tif`;
    }

    // Daily layered data with date suffix
    if (layerInfo.folder) {
        return `FloodData/${region}/${layerInfo.sub}/${layerInfo.folder}/${layerInfo.prefix}_${date}.tif`;
    }
    return `FloodData/${region}/${layerInfo.sub}/${layerInfo.prefix}_${date}.tif`;
}

export async function getCachedTifImage(r2Key: string): Promise<GeoTIFF.GeoTIFFImage> {
    const cached = tifCache.get(r2Key);
    if (cached) return cached;

    if (pendingDownloads.has(r2Key)) {
        return pendingDownloads.get(r2Key)!;
    }

    const downloadPromise = (async () => {
        try {
            const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: r2Key });
            const res = await r2.send(cmd);
            const arr = await res.Body?.transformToByteArray();
            if (!arr) throw new Error("Empty body");

            const slice = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
            const tiff = await GeoTIFF.fromArrayBuffer(slice);
            const img = await tiff.getImage();
            tifCache.set(r2Key, img);
            return img;
        } catch (e) {
            console.error(`[R2] Error downloading ${r2Key}:`, e);
            throw e;
        } finally {
            pendingDownloads.delete(r2Key);
        }
    })();

    pendingDownloads.set(r2Key, downloadPromise);
    return downloadPromise;
}

export async function readPixelFromR2Tif(r2Key: string, lat: number, lng: number, scale = 1): Promise<number | null> {
    const cacheKey = `pixel_${r2Key}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    const cached = pixelCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const img = await getCachedTifImage(r2Key);
        const bbox = img.getBoundingBox();
        const west = bbox[0] ?? 0, south = bbox[1] ?? 0, east = bbox[2] ?? 0, north = bbox[3] ?? 0;

        const width = img.getWidth();
        const height = img.getHeight();

        const col = Math.floor((lng - west) / (east - west) * width);
        const row = Math.floor((north - lat) / (north - south) * height);

        if (col < 0 || col >= width || row < 0 || row >= height) {
            pixelCache.set(cacheKey, null);
            return null;
        }

        const [rasters] = await img.readRasters({ window: [col, row, col + 1, row + 1] }) as any[];
        const rawValue = rasters[0];
        const nodata = (img.fileDirectory as any).GDAL_NODATA;
        const nod = nodata !== undefined ? parseFloat(nodata) : -9999;

        const value = (rawValue === nod || rawValue === null || isNaN(rawValue) || rawValue <= -9998)
            ? null
            : parseFloat((rawValue / scale).toFixed(4));

        pixelCache.set(cacheKey, value);
        return value;
    } catch (e) {
        return null;
    }
}
