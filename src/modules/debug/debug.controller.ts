/**
 * Debug Controller — Development-only endpoints for R2 diagnostics
 * 
 * These endpoints expose internal diagnostics and should NEVER be
 * available in production. They are conditionally mounted in app.ts.
 */
import { Router, Request, Response } from 'express';
import { S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import { loadEnv } from '../../shared/config/env';
import { REGION_BOUNDS } from '../../shared/types/common';
import { readPixelFromNpz } from '../../shared/legacy/npz-reader';

export const debugRouter = Router();

// ── Helper ──────────────────────────────────────────────────────────────────
function normalizeDateForDebug(value: string): string | null {
    const s = String(value ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        const day = parseInt(m[1]!, 10), month = parseInt(m[2]!, 10), year = parseInt(m[3]!, 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
}

function createR2Client(env: ReturnType<typeof loadEnv>) {
    return new S3Client({
        region: 'auto',
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID!,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        },
    });
}

// ── GET /debug/r2-check ─────────────────────────────────────────────────────
debugRouter.get('/r2-check', async (req: Request, res: Response) => {
    const env = loadEnv();
    const hasCreds = !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
    if (!hasCreds) {
        return res.json({
            ok: false,
            message: 'R2 credentials not set (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
            bucket: env.R2_BUCKET_NAME,
        });
    }
    const sampleKey = (req.query.key as string) || 'visualize/2020-2025/Data_Training_Raw_NPZ/Sample_2020-01-03.npz';
    try {
        const client = createR2Client(env);
        await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: sampleKey }));
        return res.json({ ok: true, message: 'R2 reachable', bucket: env.R2_BUCKET_NAME, sampleKey, exists: true });
    } catch (e: any) {
        const listPrefix = 'visualize/2020-2025/Data_Training_Raw_NPZ/';
        try {
            const client = createR2Client(env);
            const list = await client.send(new ListObjectsV2Command({
                Bucket: env.R2_BUCKET_NAME,
                Prefix: listPrefix,
                MaxKeys: 15,
            }));
            const keys = (list.Contents || []).map(o => o.Key).filter(Boolean);
            return res.json({
                ok: false,
                message: `Sample key not found: ${e.name || e.message}`,
                bucket: env.R2_BUCKET_NAME,
                sampleKey,
                exists: false,
                sampleKeysInBucket: keys,
            });
        } catch (listErr: any) {
            return res.json({
                ok: false,
                message: `R2 error: ${e.name || e.message}. List failed: ${listErr?.message || listErr}`,
                bucket: env.R2_BUCKET_NAME,
                sampleKey,
                exists: false,
            });
        }
    }
});

// ── GET /debug/pixel ────────────────────────────────────────────────────────
debugRouter.get('/pixel', async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const dateRaw = (req.query.date as string) ?? '';
    const region = (req.query.region as string) ?? 'DaNang';

    const normalizedDate = normalizeDateForDebug(dateRaw);
    if (!normalizedDate) {
        return res.json({
            ok: false,
            validation: 'invalid_date',
            message: 'date must be YYYY-MM-DD or DD/MM/YYYY',
            received: dateRaw,
        });
    }

    const bounds = REGION_BOUNDS[region];
    if (!bounds) {
        return res.json({
            ok: false,
            validation: 'unknown_region',
            region,
            normalizedDate,
        });
    }
    if (isNaN(lat) || isNaN(lng) || lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) {
        return res.json({
            ok: false,
            validation: 'out_of_bounds',
            lat,
            lng,
            region,
            normalizedDate,
            bounds: { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west },
        });
    }

    const r2KeyStacked = `FloodData/${region}/Stacked/stacked_${normalizedDate}.tif`;
    let keyExists = false;
    const env = loadEnv();
    if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
        try {
            const client = createR2Client(env);
            await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: r2KeyStacked }));
            keyExists = true;
        } catch {
            keyExists = false;
        }
    }

    return res.json({
        ok: true,
        normalizedDate,
        region,
        r2KeyStacked,
        keyExists,
    });
});

// ── GET /debug/npz ──────────────────────────────────────────────────────────
debugRouter.get('/npz', async (req: Request, res: Response) => {
    const lat = Number(req.query.lat) || 16.10;
    const lng = Number(req.query.lng) || 108.15;
    const date = (req.query.date as string) || '2020-01-03';
    const region = (req.query.region as string) || 'DaNang';

    const env = loadEnv();
    const key = `visualize/2020-2025/Data_Training_Raw_NPZ/Sample_${date}.npz`;

    const diag: Record<string, unknown> = {
        hasBounds: !!REGION_BOUNDS[region],
        hasR2Creds: !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY),
        r2AccountId: env.R2_ACCOUNT_ID ? `${env.R2_ACCOUNT_ID.substring(0, 8)}...` : 'MISSING',
        bucket: env.R2_BUCKET_NAME,
        npzKey: key,
    };

    try {
        const s3Client = createR2Client(env);
        const resp = await s3Client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
        const arr = await resp.Body?.transformToByteArray();
        if (!arr) return res.json({ ok: false, error: 'Empty body' });

        const buf = Buffer.from(arr);
        diag.downloadSize = buf.length;

        const zip = new AdmZip(buf);
        const entries = zip.getEntries();
        diag.zipEntries = entries.map(e => ({
            name: e.entryName,
            size: e.header.size,
            compressedSize: e.header.compressedSize,
        }));

        for (const entry of entries) {
            const data = entry.getData();
            const first20 = Array.from(data.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0'));
            const magic = data.toString('ascii', 0, 6);
            (diag as any)[`${entry.entryName}_first20hex`] = first20.join(' ');
            (diag as any)[`${entry.entryName}_magic`] = magic;
            (diag as any)[`${entry.entryName}_magic_codes`] = Array.from(data.subarray(0, 6)).map(b => b);
        }

        const t0 = Date.now();
        const result = await readPixelFromNpz(region, date, lat, lng);
        const elapsed = Date.now() - t0;
        return res.json({ ok: true, elapsed, result, diag });
    } catch (e) {
        return res.json({ ok: false, error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 5), diag });
    }
});
