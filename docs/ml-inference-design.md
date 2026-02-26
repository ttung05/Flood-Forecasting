# ML Inference Service — Architecture Design

## Overview
After Phase 2 infrastructure (COG + multiband + edge), we integrate real-time ML inference for flood prediction per pixel click.

## Architecture Options

### Option A: In-Worker Inference (WASM/ONNX)
- Run small model directly inside Cloudflare Worker
- Model compiled to WASM or ONNX.js
- **Pros**: Zero network hop, lowest latency (~10ms inference)
- **Cons**: Worker memory limit (128MB), model size limit (~10MB), no GPU
- **Best for**: Simple models (logistic regression, small MLP, XGBoost)

### Option B: Dedicated Inference Service (RECOMMENDED)
- Separate FastAPI container on Cloud Run / Railway / Render
- Model loaded into RAM at startup (warm instance)
- Worker/Node backend calls inference API with pixel features
- **Pros**: Any model size, GPU support, Python ML ecosystem
- **Cons**: Extra network hop (~30-50ms), separate service to manage
- **Best for**: Deep learning, ensemble models, models requiring numpy/scipy

## Recommended Architecture (Option B)

```
User Click → Edge Worker → R2 (COG pixel read, ~50ms)
                         → Inference API (features → prediction, ~30ms)
                         → Combined response to user (~80ms total)
```

## FastAPI Reference Implementation

```python
# inference_service/main.py
from fastapi import FastAPI
import numpy as np
import joblib  # or torch, tensorflow

app = FastAPI()
model = None

@app.on_event("startup")
async def load_model():
    global model
    model = joblib.load("model/flood_model.pkl")
    print("✅ Model loaded into RAM")

@app.post("/predict")
async def predict(features: dict):
    # features: { rainfall, soilMoisture, tide, dem, slope, flow, landCover }
    X = np.array([[
        features.get('rainfall', 0),
        features.get('soilMoisture', 0),
        features.get('tide', 0),
        features.get('dem', 0),
        features.get('slope', 0),
        features.get('flow', 0),
        features.get('landCover', 0),
    ]])
    
    prediction = model.predict(X)[0]
    probability = model.predict_proba(X)[0].tolist()
    
    return {
        "flood_risk": "HIGH" if prediction == 1 else "LOW",
        "probability": probability,
        "model_version": "v1.0"
    }
```

## Caching Strategy
- Cache key: `predict:{region}:{lat4}:{lng4}:{date}`
- TTL: 24 hours (predictions for historical data don't change)
- Invalidate when model is retrained

## Frontend Integration
When inference service is ready:
1. Edge Worker reads pixel features from COG
2. Calls inference API with features
3. Returns both raw data + prediction to frontend
4. Frontend caches last prediction per session

## Cost Estimate
- Cloud Run: ~$0 (free tier: 2M requests/month)
- Railway: ~$5/month (starter plan)
- Render: Free tier available
