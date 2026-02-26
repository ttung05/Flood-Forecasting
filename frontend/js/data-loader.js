/**
 * data-loader.js
 * Module quản lý load & cache dữ liệu từ API
 *
 * Mọi response từ backend đều theo envelope: { success, data, error }
 * Module này unwrap và trả về chỉ phần `data` cho phần code còn lại.
 */

class DataLoader {
    constructor() {
        this.cache = new Map();
        this.maxCacheSize = 20;
        this.currentRegion = 'DaNang';
        this.availableDates = null;  // { availableDates, totalDays, dateRange, ... }
    }

    // ----------------------------------------------------------
    // PRIVATE: Fetch helper với envelope unwrapping
    // ----------------------------------------------------------

    /**
     * Gọi API và unwrap envelope { success, data, error }.
     * Throw lỗi nếu !success, trả về data nếu thành công.
     */
    async _fetch(url) {
        const response = await fetch(url);
        const envelope = await response.json();

        if (!envelope.success) {
            const errMsg = envelope.error?.message || `HTTP ${response.status}`;
            throw new Error(errMsg);
        }
        return envelope.data;
    }

    // ----------------------------------------------------------
    // Cache helpers
    // ----------------------------------------------------------

    _cacheGet(key) { return this.cache.get(key) || null; }

    _cacheSet(key, value) {
        if (this.cache.size >= this.maxCacheSize) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, value);
    }

    // ----------------------------------------------------------
    // PUBLIC API
    // ----------------------------------------------------------

    /**
     * Load danh sách ngày có dữ liệu cho một region.
     * @returns { region, dateRange, totalDays, availableDates, dataSources }
     */
    async loadAvailableDates(region) {
        const cacheKey = `dates_${region}`;
        const cached = this._cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const data = await this._fetch(`${window.API_BASE_URL}/api/dates/${region}`);

            this._cacheSet(cacheKey, data);

            // Lưu lại cho region mặc định
            if (region === this.currentRegion) {
                this.availableDates = data;
            }

            console.log(`✅ Loaded ${data.totalDays} available dates for ${region}`);

            document.dispatchEvent(new CustomEvent('dataLoaded', { detail: { region, data } }));
            return data;
        } catch (error) {
            console.error(`❌ Error loading available dates for ${region}:`, error.message);
            return null;
        }
    }

    /**
     * Kiểm tra ngày có dữ liệu không (dựa trên cache dates của currentRegion)
     */
    isDateAvailable(dateStr) {
        if (!this.availableDates?.availableDates) return false;
        const [year, month, day] = dateStr.split('-');
        return this.availableDates.availableDates?.[year]?.[month]?.includes(parseInt(day)) || false;
    }

    /**
     * Load dữ liệu pixel tại toạ độ & ngày cụ thể.
     * @returns { lat, lng, date, region, rainfall, soilMoisture, tide, flood, floodRisk, ... }
     */
    async loadPixelData(lat, lng, date, region) {
        const cacheKey = `pixel_${region}_${date}_${lat}_${lng}`;
        const cached = this._cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const url = `${window.API_BASE_URL}/api/pixel/${lat}/${lng}/${date}/${region}`;
            const data = await this._fetch(url);
            this._cacheSet(cacheKey, data);
            console.log(`✅ Pixel [${lat}, ${lng}] on ${date}: flood=${data.flood}, rain=${data.rainfall}`);
            return data;
        } catch (error) {
            console.warn(`⚠️ No pixel data at [${lat},${lng}] on ${date}: ${error.message}`);
            return null;
        }
    }

    /**
     * Load heatmap metadata (bounds + maskUrl) cho 1 layer.
     * Frontend dùng maskUrl để render PNG overlay lên Leaflet.
     * @returns { layer, date, region, bounds, maskUrl }
     */
    async loadHeatmapData(region, date, layer = 'rain') {
        const cacheKey = `heatmap_${region}_${date}_${layer}`;
        const cached = this._cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const url = `${window.API_BASE_URL}/api/heatmap/${region}/${date}/${layer}`;
            const data = await this._fetch(url);
            this._cacheSet(cacheKey, data);
            console.log(`✅ Heatmap loaded: ${layer} on ${date} → ${data.maskUrl}`);
            return data;
        } catch (error) {
            console.warn(`⚠️ No heatmap for ${layer} on ${date}: ${error.message}`);
            return null;
        }
    }

    /**
     * Load Timeline (tổng hợp ngày từ cả 2 regions).
     * @returns { dates, dateRange, totalDays, regions }
     */
    async loadTimeline() {
        const cacheKey = 'timeline_all';
        const cached = this._cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const data = await this._fetch(`${window.API_BASE_URL}/api/timeline`);
            this._cacheSet(cacheKey, data);
            console.log(`✅ Timeline loaded: ${data.totalDays} days`);
            return data;
        } catch (error) {
            console.error('❌ Error loading timeline:', error.message);
            return null;
        }
    }

    /**
     * Kiểm tra các layer có sẵn cho ngày cụ thể.
     * @returns { region, date, layers: {rain, soilMoisture, tide, flood, static}, hasAnyData }
     */
    async loadAvailableLayers(region, date) {
        const cacheKey = `layers_${region}_${date}`;
        const cached = this._cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const url = `${window.API_BASE_URL}/api/available-layers/${region}/${date}`;
            const data = await this._fetch(url);
            this._cacheSet(cacheKey, data);
            return data;
        } catch (error) {
            console.warn(`⚠️ Could not check layers for ${region}/${date}: ${error.message}`);
            return null;
        }
    }

    /**
     * Prefetch heatmap cho ngày kế tiếp (background optimization)
     */
    async prefetchNextDate(region, currentDate) {
        const next = this._offsetDate(currentDate, 1);
        if (!next) return;
        console.log(`🔮 Prefetching ${next}...`);
        await this.loadHeatmapData(region, next, 'flood').catch(() => { });
    }

    // ----------------------------------------------------------
    // Utilities
    // ----------------------------------------------------------

    _offsetDate(dateStr, offsetDays) {
        try {
            const d = new Date(dateStr + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + offsetDays);
            return d.toISOString().split('T')[0];
        } catch { return null; }
    }

    getNextDate(dateStr) { return this._offsetDate(dateStr, 1); }
    getPreviousDate(dateStr) { return this._offsetDate(dateStr, -1); }

    clearCache() {
        this.cache.clear();
        console.log('🗑️ DataLoader cache cleared');
    }

    getCacheStats() {
        return { size: this.cache.size, maxSize: this.maxCacheSize, keys: [...this.cache.keys()] };
    }
}

// -------------------------------------------------------
// Global singleton
// -------------------------------------------------------
const dataLoader = new DataLoader();

if (typeof window !== 'undefined') {
    window.dataLoader = dataLoader;
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log('📊 Initializing DataLoader...');
    await dataLoader.loadAvailableDates('DaNang');
    console.log('✅ DataLoader ready');
});
