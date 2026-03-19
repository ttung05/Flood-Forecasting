const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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
    const bucket = process.env.R2_BUCKET_NAME;

    // List visualize prefix
    console.log('=== visualize/ prefix ===');
    const res1 = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'visualize/', MaxKeys: 20 }));
    for (const o of (res1.Contents || [])) console.log(`  ${o.Key}  (${(o.Size/1024).toFixed(1)} KB)`);

    // List FloodData prefix (what backend expects)
    console.log('\n=== FloodData/ prefix ===');
    const res2 = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'FloodData/', MaxKeys: 20 }));
    console.log(`  Found: ${(res2.Contents || []).length} keys`);

    // Count objects per top-level prefix
    console.log('\n=== Count per prefix ===');
    for (const prefix of ['training/', 'visualize/', 'FloodData/', 'DaNang/']) {
        let count = 0;
        let tok;
        do {
            const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: tok }));
            count += (r.Contents || []).length;
            tok = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (tok);
        console.log(`  ${prefix} => ${count} keys`);
    }

    // List unique sub-prefixes under training/
    console.log('\n=== training/ sub-prefixes ===');
    const res3 = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'training/', Delimiter: '/', MaxKeys: 100 }));
    for (const p of (res3.CommonPrefixes || [])) console.log(`  ${p.Prefix}`);

    // List unique sub-prefixes under visualize/
    console.log('\n=== visualize/ sub-prefixes ===');
    const res4 = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'visualize/', Delimiter: '/', MaxKeys: 100 }));
    for (const p of (res4.CommonPrefixes || [])) console.log(`  ${p.Prefix}`);

    // List visualize depth 3
    console.log('\n=== visualize/ first 10 full keys ===');
    const res5 = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'visualize/', MaxKeys: 10 }));
    for (const o of (res5.Contents || [])) console.log(`  ${o.Key}  (${(o.Size/1024).toFixed(1)} KB)`);
}

main().catch(console.error);
