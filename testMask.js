require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const env = process.env;

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
});

r2.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET_NAME, Prefix: 'FloodData/DaNang/Mask/' })).then(res => {
    console.log(res.Contents ? res.Contents.map(c => c.Key).join('\n') : 'No files found');
}).catch(console.error);
