/**
 * Pre-build binary grid files from local NPZ data.
 *
 * For each NPZ file, extracts all 8 bands and writes one .gridbin per layer.
 * Format matches the binary API response:
 *   4 bytes (LE uint32): metadata JSON length
 *   N bytes: metadata JSON (UTF-8)
 *   H×W×4 bytes: Float32 data (LE)
 *
 * Usage:
 *   npx tsx scripts/prebuild-grids.ts
 *   npx tsx scripts/prebuild-grids.ts 2020-01-03       # single date
 */
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const NPZ_DIR = path.resolve(process.cwd(), 'data', '2020-2025', 'Data_Training_Soft_NPZ');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'grid-bin');

const REGION = 'DaNang';
const BOUNDS = { n: 16.25, s: 15.95, e: 108.40, w: 107.90 };

const STACKED_BAND_NAMES = [
    'rainfall', 'soilMoisture', 'tide', 'flood',
    'dem', 'slope', 'flow', 'landCover',
] as const;

const LAYER_IDS = ['rain', 'soilMoisture', 'tide', 'label', 'dem', 'slope', 'flow', 'landCover'] as const;

function denormalize(bandName: string, raw: number): number {
    switch (bandName) {
        case 'rainfall':     return Math.round(raw * 200 * 100) / 100;
        case 'soilMoisture': return Math.round(raw * 0.5 * 10000) / 10000;
        case 'tide':         return Math.round((raw * 3.0 - 1.5) * 1000) / 1000;
        case 'slope':        return Math.round(raw * 90 * 100) / 100;
        case 'flow':         return raw > 0 ? Math.round((Math.pow(10, raw * 5) - 1) * 100) / 100 : 0;
        case 'dem':          return Math.round(raw * 10000) / 10000;
        case 'landCover':    return Math.round(raw * 100000) / 100000;
        case 'flood':        return raw >= 0.5 ? 1 : 0;
        default:             return raw;
    }
}

function parseNpy(buf: Buffer): { data: Float32Array; shape: number[] } {
    if (buf[0] !== 0x93 || buf.toString('ascii', 1, 6) !== 'NUMPY') {
        throw new Error('Not a valid .npy file');
    }
    const major = buf[6]!;
    let headerLen: number, headerOffset: number;
    if (major === 1) { headerLen = buf.readUInt16LE(8); headerOffset = 10; }
    else { headerLen = buf.readUInt32LE(8); headerOffset = 12; }

    const headerStr = buf.toString('ascii', headerOffset, headerOffset + headerLen);
    const shapeMatch = headerStr.match(/shape['"]\s*:\s*\(([^)]+)\)/);
    if (!shapeMatch) throw new Error(`Cannot parse shape: ${headerStr}`);
    const shape = shapeMatch[1]!.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

    const descrMatch = headerStr.match(/descr['"]\s*:\s*'([^']+)'/);
    const descr = descrMatch ? descrMatch[1]! : '<f4';
    const dataOffset = headerOffset + headerLen;
    const totalElements = shape.reduce((a, b) => a * b, 1);

    let data: Float32Array;
    if (descr === '<f4' || descr === 'float32') {
        data = new Float32Array(buf.buffer, buf.byteOffset + dataOffset, totalElements);
    } else if (descr === '<f8' || descr === 'float64') {
        data = new Float32Array(new Float64Array(buf.buffer, buf.byteOffset + dataOffset, totalElements));
    } else {
        data = new Float32Array(buf.buffer, buf.byteOffset + dataOffset, totalElements);
    }
    return { data, shape };
}

function writeGridBin(filePath: string, meta: object, f32: Float32Array): void {
    const metaStr = JSON.stringify(meta);
    const metaBuf = Buffer.from(metaStr, 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(metaBuf.length, 0);
    const dataBuf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, header);
    fs.writeSync(fd, metaBuf);
    fs.writeSync(fd, dataBuf);
    fs.closeSync(fd);
}

function processNpz(npzPath: string, date: string): number {
    const buf = fs.readFileSync(npzPath);
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();

    let xData: Float32Array | null = null;
    let xShape: number[] = [];

    for (const entry of entries) {
        if (entry.entryName === 'x.npy') {
            const parsed = parseNpy(entry.getData());
            xData = parsed.data;
            xShape = parsed.shape;
        }
    }

    if (!xData || xShape.length !== 3) {
        console.warn(`  SKIP: invalid x array shape in ${npzPath}`);
        return 0;
    }

    const [bands, height, width] = xShape as [number, number, number];
    const total = height * width;
    let count = 0;

    for (let bi = 0; bi < Math.min(bands, STACKED_BAND_NAMES.length); bi++) {
        const bandName = STACKED_BAND_NAMES[bi]!;
        const layerId = LAYER_IDS[bi]!;
        const bandOffset = bi * total;

        const f32 = new Float32Array(total);
        for (let i = 0; i < total; i++) {
            const raw = xData[bandOffset + i]!;
            if (raw === undefined || isNaN(raw) || raw < 0) {
                f32[i] = -9999;
            } else {
                f32[i] = denormalize(bandName, raw);
            }
        }

        const meta = {
            v: 1, region: REGION, date, layer: layerId,
            bounds: BOUNDS, size: { r: height, c: width },
            scale: 1, nodata: -9999,
        };

        const outFile = path.join(OUT_DIR, `grid_${date}_${layerId}.gridbin`);
        writeGridBin(outFile, meta, f32);
        count++;
    }

    return count;
}

// ── Main ──
const targetDate = process.argv[2];

if (!fs.existsSync(NPZ_DIR)) {
    console.error(`NPZ directory not found: ${NPZ_DIR}`);
    process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const files = fs.readdirSync(NPZ_DIR)
    .filter(f => f.startsWith('Sample_') && f.endsWith('.npz'))
    .sort();

const t0 = Date.now();
let totalFiles = 0;
let totalGrids = 0;

for (const file of files) {
    const date = file.replace('Sample_', '').replace('.npz', '');
    if (targetDate && date !== targetDate) continue;

    const npzPath = path.join(NPZ_DIR, file);
    const grids = processNpz(npzPath, date);
    totalFiles++;
    totalGrids += grids;
    process.stdout.write(`  ${date}: ${grids} layers\n`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone: ${totalFiles} NPZ files → ${totalGrids} grid-bin files in ${elapsed}s`);
console.log(`Output: ${OUT_DIR}`);
