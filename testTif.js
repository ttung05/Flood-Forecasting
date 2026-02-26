require('dotenv').config();
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const GeoTIFF = require('geotiff');
const env = process.env;

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
});

async function run() {
    try {
        const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: 'FloodData/DaNang/Static/DEM.tif' });
        const res = await r2.send(cmd);
        const arr = await res.Body.transformToByteArray();
        const slice = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
        const tiff = await GeoTIFF.fromArrayBuffer(slice);
        const img = await tiff.getImage();
        console.log("DEM Width:", img.getWidth(), "Height:", img.getHeight());
        console.log("DEM BBox:", img.getBoundingBox());
    } catch (e) { console.error("Error DEM:", e); }
}
run();
