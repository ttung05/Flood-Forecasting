/**
 * Grid Batch Controller — serves multiple grid layers in a single request.
 *
 * POST /api/grid-batch
 * Body: { region, date, layers: ["rain","soilMoisture",...] }
 *
 * Response: Binary format:
 *   [layerCount: UInt8]
 *   For each layer:
 *     [metaLen: UInt32LE] [metaJSON: UTF-8] [dataLen: UInt32LE] [data: Float32Array]
 *
 * This eliminates N HTTP round-trips for the EDA page which needs all 8 layers.
 */
import { Router } from 'express';
import { z } from 'zod';
import * as gridService from './grid.service';
import { fail } from '../../shared/types/envelope';
import { structuredLog } from '../../shared/middleware/tracing';

const router = Router();

const BatchSchema = z.object({
    region: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    layers: z.array(z.string()).min(1).max(10),
});

router.post('/grid-batch', async (req, res) => {
    const t0 = Date.now();

    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) {
        return fail(res, `Invalid batch params: ${parsed.error.message}`, 400, 'VALIDATION');
    }

    const { region, date, layers } = parsed.data;

    // Fetch all grids in parallel (they share in-memory cache internally)
    const gridResults = await Promise.all(
        layers.map(async (layer) => {
            try {
                const result = await gridService.getGrid({
                    region: region as any,
                    date: date as any,
                    layer: layer as any,
                });
                return { layer, result };
            } catch (err) {
                return { layer, result: null };
            }
        })
    );

    // Build binary response: [layerCount(1)] + [metaLen(4) + meta + dataLen(4) + data]×N
    const buffers: Buffer[] = [];

    // Layer count header
    const countBuf = Buffer.alloc(1);
    countBuf.writeUInt8(gridResults.length, 0);
    buffers.push(countBuf);

    let successCount = 0;

    for (const { layer, result } of gridResults) {
        if (!result || !result.ok) {
            // Write empty entry: metaLen=0, dataLen=0
            const emptyMeta = JSON.stringify({ layer, error: true });
            const emptyMetaBuf = Buffer.from(emptyMeta, 'utf-8');
            const metaLenBuf = Buffer.alloc(4);
            metaLenBuf.writeUInt32LE(emptyMetaBuf.length, 0);
            const dataLenBuf = Buffer.alloc(4);
            dataLenBuf.writeUInt32LE(0, 0);
            buffers.push(metaLenBuf, emptyMetaBuf, dataLenBuf);
            continue;
        }

        const grid = result.value;
        successCount++;

        const meta = JSON.stringify({
            v: grid.v, region: grid.region, date: grid.date, layer: grid.layer,
            bounds: grid.bounds, size: grid.size, scale: grid.scale, nodata: grid.nodata,
        });
        const metaBuf = Buffer.from(meta, 'utf-8');

        let dataBuf: Buffer;
        if (grid.data instanceof Float32Array) {
            dataBuf = Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
        } else {
            const f32 = new Float32Array(grid.data.length);
            for (let i = 0; i < grid.data.length; i++) f32[i] = grid.data[i]!;
            dataBuf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
        }

        const metaLenBuf = Buffer.alloc(4);
        metaLenBuf.writeUInt32LE(metaBuf.length, 0);
        const dataLenBuf = Buffer.alloc(4);
        dataLenBuf.writeUInt32LE(dataBuf.length, 0);

        buffers.push(metaLenBuf, metaBuf, dataLenBuf, dataBuf);
    }

    const body = Buffer.concat(buffers);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=600');
    res.setHeader('X-Grid-Layers', String(successCount));

    structuredLog('info', 'grid_batch', {
        region, date, layers: layers.join(','),
        successCount, totalLayers: layers.length,
        responseBytes: body.length,
        durationMs: Date.now() - t0,
    });

    return res.status(200).end(body);
});

export { router as gridBatchRouter };
