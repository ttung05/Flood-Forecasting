const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const AdmZip = require('adm-zip');
require('dotenv').config();

async function main() {
    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });

    const dates = ['2020-01-03', '2020-10-28', '2021-11-01', '2023-10-14', '2025-09-29'];

    for (const date of dates) {
        const key = `training/2020-2025/Data_Training_Soft_NPZ/Sample_${date}.npz`;
        console.log(`\n=== ${date} ===`);
        try {
            const res = await client.send(new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME, Key: key,
            }));
            const arr = await res.Body.transformToByteArray();
            const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
            const zip = new AdmZip(buf);

            for (const entry of zip.getEntries()) {
                const name = entry.entryName;
                const data = entry.getData();

                // Parse .npy header
                if (data[0] !== 0x93) continue;
                const major = data[6];
                let headerLen, headerOffset;
                if (major === 1) { headerLen = data.readUInt16LE(8); headerOffset = 10; }
                else { headerLen = data.readUInt32LE(8); headerOffset = 12; }
                const header = data.toString('ascii', headerOffset, headerOffset + headerLen);
                const shapeMatch = header.match(/shape['"]\s*:\s*\(([^)]+)\)/);
                const shape = shapeMatch ? shapeMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
                const descrMatch = header.match(/descr['"]\s*:\s*'([^']+)'/);
                const descr = descrMatch ? descrMatch[1] : '<f4';

                const dataOffset = headerOffset + headerLen;
                const totalElements = shape.reduce((a, b) => a * b, 1);

                let values;
                if (descr === '<f4' || descr === 'float32') {
                    values = new Float32Array(data.buffer, data.byteOffset + dataOffset, totalElements);
                } else if (descr === '<f8' || descr === 'float64') {
                    values = new Float64Array(data.buffer, data.byteOffset + dataOffset, totalElements);
                } else {
                    values = new Float32Array(data.buffer, data.byteOffset + dataOffset, totalElements);
                }

                let min = Infinity, max = -Infinity, sum = 0, nanCount = 0, zeroCount = 0;
                const histogram = {};
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (isNaN(v)) { nanCount++; continue; }
                    if (v < min) min = v;
                    if (v > max) max = v;
                    sum += v;
                    if (v === 0) zeroCount++;
                    // Bin to 0.1 increments for histogram
                    const bin = (Math.floor(v * 10) / 10).toFixed(1);
                    histogram[bin] = (histogram[bin] || 0) + 1;
                }

                const mean = sum / (values.length - nanCount);
                const nonZero = values.length - nanCount - zeroCount;

                console.log(`  ${name}: shape=${JSON.stringify(shape)} dtype=${descr}`);
                console.log(`    min=${min.toFixed(6)}, max=${max.toFixed(6)}, mean=${mean.toFixed(6)}`);
                console.log(`    total=${values.length}, zeros=${zeroCount}, nonZero=${nonZero}, NaN=${nanCount}`);

                if (name === 'y.npy') {
                    console.log(`    Histogram (flood label distribution):`);
                    const sortedBins = Object.keys(histogram).sort((a, b) => parseFloat(a) - parseFloat(b));
                    for (const bin of sortedBins) {
                        const pct = (histogram[bin] / values.length * 100).toFixed(2);
                        console.log(`      [${bin}]: ${histogram[bin]} (${pct}%)`);
                    }
                    // Count unique values
                    const uniqueVals = new Set();
                    for (let i = 0; i < Math.min(values.length, 100000); i++) {
                        uniqueVals.add(values[i].toFixed(4));
                    }
                    console.log(`    Unique values (first 100k samples): ${uniqueVals.size}`);
                }
            }
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }
    }
}

main().catch(console.error);
