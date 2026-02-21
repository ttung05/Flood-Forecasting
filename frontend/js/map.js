// Vietnam Flood Dashboard - Leaflet with OpenStreetMap Tiles
// OpenStreetMap tiles (giống Google Maps) + transparent heatmap overlay

let map;
let heatmapLayer;
let boundingBoxes = [];
let floodMaskLayer = null;   // L.LayerGroup chứa các rectangle flood
let rainHeatLayer = null;   // L.heatLayer cho rainfall (tuỳ chọn)
let isUpdating = false;     // Lock để ngăn race condition

let currentDate = '2023-01-08'; // Date in seed data (step=7 days from 2020-01-01)
let currentRegion = 'DBSCL';
let vietnamBoundary = null; // Polygon biên giới VN để mask vùng ngập

// ============================================================
// LAYER MANAGER (Config & UI Checkbox Toggles)
// ============================================================
const LayerManager = window.LayerManager = {
    // Configuration: Mapping UI Checkbox IDs to API Layer Names
    config: {
        'cb-flood': { layer: 'flood', name: 'Flood Risk', type: 'grid', color: '#FF1744' },
        'cb-rain': { layer: 'rain', name: 'Rainfall', type: 'heatmap', color: '#2196F3' },
        'cb-moisture': { layer: 'soilMoisture', name: 'Soil Moisture', type: 'heatmap', color: '#795548' },
        'cb-dem': { layer: 'static', name: 'DEM', type: 'image', color: '#9E9E9E' }
    },

    availability: {},
    currentDate: null,
    currentRegion: null,

    init: function () {
        console.log('🛡️ Initializing Layer Manager...');
        for (const [id, conf] of Object.entries(this.config)) {
            const checkbox = document.getElementById(id);
            if (checkbox) {
                checkbox.addEventListener('change', () => {
                    console.log(`Layer toggle: ${conf.layer} = ${checkbox.checked}`);
                    if (typeof updateHeatmap === 'function' && this.currentDate && this.currentRegion) {
                        updateHeatmap(this.currentDate, this.currentRegion, true);
                    }
                });
            }
        }
    },

    updateAvailability: async function (date, region) {
        this.currentDate = date;
        this.currentRegion = region;
        try {
            const response = await fetch(`${window.API_BASE_URL || ''}/api/available-layers/${region}/${date}`);
            const envelope = await response.json();
            const payload = envelope.success ? envelope.data : null;

            if (payload && payload.layers) {
                this.availability = payload.layers;
                if (payload.hasAnyData) {
                    const standardLayers = ['flood', 'rain', 'soilMoisture', 'static'];
                    standardLayers.forEach(layer => { this.availability[layer] = true; });
                }
            } else {
                this.availability = {};
            }
            this.updateUI();
        } catch (error) {
            console.error('❌ Error checking availability:', error);
            this.availability = {};
            this.updateUI();
        }
    },

    updateUI: function () {
        for (const [id, conf] of Object.entries(this.config)) {
            const checkbox = document.getElementById(id);
            if (!checkbox) continue;
            let isAvailable = (conf.layer === 'static') ? (this.availability['static'] === true) : (this.availability[conf.layer] === true);
            const labelSpan = checkbox.parentElement.querySelector('span');

            if (isAvailable) {
                checkbox.disabled = false;
                checkbox.parentElement.classList.remove('opacity-50', 'cursor-not-allowed');
                if (labelSpan) labelSpan.textContent = conf.name;
            } else {
                checkbox.disabled = true;
                checkbox.parentElement.classList.add('opacity-50', 'cursor-not-allowed');
                if (labelSpan) labelSpan.textContent = `${conf.name} (N/A)`;
            }
        }
    },

    getActiveLayers: function () {
        const active = [];
        for (const [id, conf] of Object.entries(this.config)) {
            const checkbox = document.getElementById(id);
            if (checkbox && checkbox.checked && !checkbox.disabled) active.push(conf);
        }
        return active;
    }
};

// Initializer Hook for LayerManager
document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { LayerManager.init(); }, 800); });


// ... existing code ...

// Pixel Parameters Panel logic removed to prefer only Map Popup

// Handle map click
async function handleMapClick(e) {
    const { lat, lng } = e.latlng;

    // Check if click is in data region
    const region = getRegion(lat, lng);

    // DEBUG: Alert if click outside
    if (!region) {
        console.log('Click outside data regions');
        return;
    }

    console.log(`📍 Clicked in ${region} at`, lat.toFixed(4), lng.toFixed(4));

    // Auto-switch region if different
    if (region !== currentRegion) {
        console.log(`🔄 Switching region from ${currentRegion} to ${region}`);
        currentRegion = region;

        // Show loading indicator or toast if available (optional)
        // Refresh visuals for the new region
        if (typeof updateHeatmap === 'function') {
            updateHeatmap(currentDate, currentRegion, true); // Force update
        }
    }

    try {
        // Fetch pixel data – API returns envelope { success, data, error }
        const url = `${window.API_BASE_URL}/api/pixel/${lat}/${lng}/${currentDate}/${region}`;

        const response = await fetch(url);
        const envelope = await response.json();
        let data;

        if (!envelope.success) {
            console.warn(`⚠️ API Error: ${envelope.error?.message || response.status}`);
            data = { floodRisk: 'NO DATA', rainfall: null, dem: null, slope: null, soilMoisture: null, flow: null, landCover: null, tide: null };
        } else {
            data = envelope.data;
            console.log('Pixel data:', data);
        }

        // Show popup
        L.popup()
            .setLatLng(e.latlng)
            .setContent(`
                <div style="font-family: Inter, sans-serif; min-width: 240px; max-width: 300px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
                        <strong style="font-size: 14px; color: #1F2937;">Selected Area</strong>
                        <span style="background: ${getRiskColor(data.floodRisk)}; color: white; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px;">
                            ${data.floodRisk || 'LOW'}
                        </span>
                    </div>
                    <div style="font-size: 12px; line-height: 1.8;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span style="color: #64748b;">Coordinates:</span>
                            <span style="font-family: monospace; font-weight: 500; font-size: 11px;">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span style="color: #64748b;">Region:</span>
                            <span style="font-weight: 500;">${region === 'DBSCL' ? 'Đồng Bằng Sông Cửu Long' : 'Duyên Hải Miền Trung'}</span>
                        </div>
                        <div style="border-top: 1px solid #e5e7eb; margin: 8px 0; padding-top: 8px;">
                            <strong style="font-size: 11px; color: #1F2937; display: block; margin-bottom: 6px;">Environmental Data</strong>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">Rainfall (24h):</span>
                                <span style="font-weight: 600; color: #1976d2;">${data.rainfall != null ? data.rainfall + ' mm' : 'N/A'}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">DEM (Elevation):</span>
                                <span style="font-weight: 600; color: #059669;">${data.dem != null ? data.dem + ' m' : 'N/A'}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">Slope:</span>
                                <span style="font-weight: 600; color: #7C3AED;">${data.slope != null ? data.slope + '°' : 'N/A'}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">Soil Moisture:</span>
                                <span style="font-weight: 600; color: #DC2626;">${data.soilMoisture != null ? data.soilMoisture + '%' : 'N/A'}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">Flow:</span>
                                <span style="font-weight: 600; color: #0891B2;">${data.flow != null ? data.flow + ' m³/s' : 'N/A'}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                <span style="color: #64748b;">Land Cover:</span>
                                <span style="font-weight: 500; font-size: 11px;">${data.landCover !== null ? data.landCover : 'N/A'}</span>
                            </div>
                        </div>
                        <div style="display: flex; justify-content: space-between; border-top: 1px solid #e5e7eb; padding-top: 6px; margin-top: 6px;">
                            <span style="color: #64748b;">Date:</span>
                            <span style="font-weight: 500;">${currentDate}</span>
                        </div>
                        <button onclick="window.location.href='/detail.html?lat=${lat}&lng=${lng}&date=${currentDate}&region=${region}'" 
                            style="width: 100%; margin-top: 10px; background: #1976d2; color: white; border: none; padding: 8px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.2s;"
                            onmouseover="this.style.background='#1565c0'" onmouseout="this.style.background='#1976d2'">
                            <span class="material-icons" style="font-size: 16px;">analytics</span>
                            View Detailed Dashboard
                        </button>
                    </div>
                </div>
            `)
            .openOn(map);

    } catch (error) {
        console.error('❌ Error fetching pixel data:', error);
    }
}

// Get region from coordinates
function getRegion(lat, lng) {
    // Check Central Coast
    const cc = REGION_BOUNDS.CentralCoast;
    if (lat <= cc.north && lat >= cc.south && lng <= cc.east && lng >= cc.west) {
        return 'CentralCoast';
    }
    // Check DBSCL
    const db = REGION_BOUNDS.DBSCL;
    if (lat <= db.north && lat >= db.south && lng <= db.east && lng >= db.west) {
        return 'DBSCL';
    }
    return null;
}

// Get risk color
function getRiskColor(risk) {
    const colors = {
        'LOW': '#4CAF50',
        'MEDIUM': '#FFC107',
        'HIGH': '#F44336',
        'CRITICAL': '#B71C1C'
    };
    return colors[risk] || '#9E9E9E';
}

// ============================================================
// FLOOD MASK LAYER - Hiển thị vùng ngập lụt dạng polygon đỏ
// ============================================================

// Bounds của từng region - PHAI khop voi seed_sample_data.py va server/api.js
const REGION_BOUNDS = {
    DBSCL: {
        north: 11.0, south: 8.5,
        east: 107.0, west: 104.0,
        rows: 25, cols: 30
    },
    CentralCoast: {
        north: 16.5, south: 14.5,
        east: 109.5, west: 107.5,
        rows: 20, cols: 20
    }
};


/**
 * Xoá toàn bộ flood mask layer cũ khỏi bản đồ
 */
/**
 * Render an image mask overlay on the Leaflet map.
 * Replaces the old grid and heatmap DOM element loops.
 * 
 * @param {Object} data - API response with { maskUrl: '/masks/...', bounds: {north, south, east, west} }
 */
function renderImageMask(data) {
    console.log(`🖼️ renderImageMask called for URL: ${data.maskUrl}`, data.bounds);

    if (!data || !data.maskUrl) {
        console.log('ℹ️ No mask URL provided');
        return;
    }

    if (!floodMaskLayer) {
        floodMaskLayer = L.layerGroup();
        floodMaskLayer.addTo(map);
    }

    // Convert API bounds to Leaflet LatLngBounds
    // API Returns: { north: 10.5, south: 8.0, east: 106.39, west: 104.0 }
    // Leaflet Expects: [[south, west], [north, east]]
    const imageBounds = [
        [data.bounds.south, data.bounds.west],
        [data.bounds.north, data.bounds.east]
    ];

    // Mount the image overlay onto the map
    // maskUrl có thể là R2 public URL (https://...) hoặc local path (/masks/...)
    const fullUrl = data.maskUrl.startsWith('http')
        ? data.maskUrl
        : window.API_BASE_URL + data.maskUrl;

    const overlay = L.imageOverlay(fullUrl, imageBounds, {
        opacity: 0.8, // Slightly transparent
        interactive: false // Let click events pass through to map
    });

    floodMaskLayer.addLayer(overlay);
    console.log(`✅ ImageMask mounted: ${fullUrl}`);
}

/**
 * Clear all visualize layers (flood mask + heatmaps)
 */
function clearLayers() {
    // Clear Flood Mask
    if (floodMaskLayer) {
        map.removeLayer(floodMaskLayer);
        floodMaskLayer = null;
    }
    // Clear Legacy Heatmap
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    // Clear New Heatmaps
    if (window.activeHeatLayers) {
        window.activeHeatLayers.forEach(l => map.removeLayer(l));
        window.activeHeatLayers = [];
    }
}

/**
 * Cập nhật hiển thị dựa trên date/region và LayerManager
 * Renders BOTH regions simultaneously for complete coverage
 * @param {string} date YYYY-MM-DD
 * @param {string} region DBSCL | CentralCoast (primary region for LayerManager)
 * @param {boolean} force Force update even if locked (used by toggles)
 */
async function updateHeatmap(date, region, force = false) {
    // 🌍 Update global state immediately so map clicks use correct date
    currentDate = date;
    currentRegion = region;

    // --- Lock check ---
    if (isUpdating && !force) {
        console.log(`⏳ updateHeatmap đang chạy, bỏ qua render (nhưng đã set ngày: ${date})`);
        return;
    }
    isUpdating = true;

    console.log(`🗺️ Updating map for: ${region} / ${date} (rendering all regions)`);

    try {
        // 1. Update Availability Logic via LayerManager (for the primary/clicked region)
        if (window.LayerManager) {
            await window.LayerManager.updateAvailability(date, region);
            console.log('✅ LayerManager updated availability');
        } else {
            console.warn('⚠️ window.LayerManager is MISSING');
        }

        // 2. Clear old layers
        clearLayers();

        // 3. Get active layers from Manager
        let activeLayers = window.LayerManager ? window.LayerManager.getActiveLayers() : [];
        console.log('📋 Active Layers:', activeLayers);

        if (activeLayers.length === 0) {
            console.warn('⚠️ No active layers! Forcing "flood" layer for debugging.');
            activeLayers = [{ layer: 'flood', type: 'grid' }];
        }

        // 4. Render ALL regions simultaneously
        const allRegions = ['DBSCL', 'CentralCoast'];

        await Promise.all(allRegions.map(async (regionName) => {
            const bounds = REGION_BOUNDS[regionName];
            if (!bounds) return;

            // Always draw bounds for the region (static frame)
            drawDataBounds(bounds);

            // For each active layer, fetch and render
            await Promise.all(activeLayers.map(async (conf) => {
                const url = `${window.API_BASE_URL}/api/heatmap/${regionName}/${date}/${conf.layer}`;
                console.log(`🌐 Fetching: ${url}`);

                try {
                    const res = await fetch(url);
                    const envelope = await res.json();

                    // API returns { success, data, error }
                    if (!envelope.success) {
                        console.log(`ℹ️ No ${conf.layer} mask for ${regionName} on ${date}: ${envelope.error?.message}`);
                        return;
                    }
                    const data = envelope.data;
                    console.log(`📦 Heatmap received for ${regionName} ${conf.layer}`);

                    if (data.maskUrl) {
                        renderImageMask(data);
                    }
                } catch (e) {
                    console.log(`ℹ️ No ${conf.layer} mask available for ${regionName} on ${date}`);
                }
            }));
        }));

    } catch (err) {
        console.error('❌ Error in updateHeatmap:', err);
    } finally {
        isUpdating = false;
    }
}

// Initialize Map
function initMap() {
    console.log('🗺️ Initializing Leaflet map...');

    // --- Define Base Layers ---

    // 1. CartoDB Light (Current) - Gọn, đẹp, load nhanh
    const cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    });

    // 2. OpenStreetMap Standard - Chi tiết, có tên đường rõ ràng
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    });

    // 3. Esri World Imagery - Vệ tinh thực tế (Satellite)
    const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19
    });

    // 4. Google Maps Style (Hybrid/Streets using Google Tiles - Experimental)
    // Note: Google Tiles URL pattern sometimes changes or requires API key, using standard reliable ones above first.

    // --- Create Map ---

    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        layers: [osm] // Default: OpenStreetMap (Detailed)
    }).setView([10.0, 105.5], 8);

    // --- Add Base Layer Control ---
    const baseMaps = {
        "Bản đồ Chi tiết (OSM)": osm,
        "Bản đồ Sáng (Light)": cartoLight,
        "Vệ tinh (Satellite)": esriSatellite
    };

    // Add default Leaflet Layer Control (Top Right)
    L.control.layers(baseMaps).addTo(map);

    // --- Add Other Controls & Events ---

    // Zoom Control (Bottom Right)
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Event Listeners
    map.on('click', handleMapClick);

    // Initial Data Load
    loadBoundary();

    // --- Tự động lấy ngày đầu tiên có trong DB ---
    (async () => {
        try {
            const r = await fetch(`${window.API_BASE_URL}/api/dates/DBSCL`);
            const env = await r.json();
            if (env.success && env.data?.availableDates) {
                // Lấy ngày nhỏ nhất từ availableDates
                const years = Object.keys(env.data.availableDates).sort();
                if (years.length > 0) {
                    const y = years[0];
                    const months = Object.keys(env.data.availableDates[y]).sort();
                    if (months.length > 0) {
                        const m = months[0];
                        const days = env.data.availableDates[y][m].sort((a, b) => a - b);
                        if (days.length > 0) {
                            const d = String(days[0]).padStart(2, '0');
                            const mo = String(m).padStart(2, '0');
                            currentDate = `${y}-${mo}-${d}`;
                            console.log('📅 Auto-set currentDate from DB:', currentDate);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('⚠️ Could not auto-set date from DB, using fallback:', currentDate);
        }

        // Initial Heatmap Update (sau khi có date)
        updateHeatmap(currentDate, currentRegion);
        console.log('✅ Map initialized with Layer Control');
    })();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('📄 DOM loaded, initializing map...');

    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
        console.error('❌ Leaflet not loaded');
        return;
    }

    console.log('✅ Leaflet loaded:', L.version);
    console.log('✅ Leaflet.heat loaded:', typeof L.heatLayer !== 'undefined');

    initMap();

    // Export map sau khi initMap() đã chạy (map đã được khởi tạo)
    if (typeof window !== 'undefined') {
        window.updateHeatmap = updateHeatmap;
        // window.map sẽ được set trong initMap() sau khi L.map() tạo xong
    }

    // Initialize layer toggles
    setTimeout(() => {
        if (typeof initLayerToggles === 'function') {
            initLayerToggles();
        }
        // Expose map sau khi đã khởi tạo xong
        if (typeof window !== 'undefined') {
            window.map = map;
        }
    }, 500);
});

// Load Vietnam boundary GeoJSON (Detailed provinces)
async function loadBoundary() {
    try {
        const res = await fetch('/data/vn_geo.json');
        if (!res.ok) throw new Error('Failed to load boundary');
        const geojson = await res.json();

        if (geojson.features && geojson.features.length > 0) {
            vietnamBoundary = geojson; // Lưu toàn bộ FeatureCollection
            console.log(`✅ Loaded Vietnam boundary: ${geojson.features.length} provinces`);
        } else {
            console.warn('⚠️ Invalid GeoJSON structure');
        }
    } catch (e) {
        console.error('❌ Error loading boundary:', e);
    }
}

// Check if point is inside Vietnam territory
function isPointInVietnam(pt) {
    if (!vietnamBoundary || !vietnamBoundary.features) return true; // Nếu chưa load xong thì cứ vẽ

    // Check nếu điểm nằm trong bất kỳ tỉnh nào
    // Tối ưu: Có thể dùng BBox check trước nếu cần thiết, nhưng với số lượng tỉnh này thì loop vẫn ổn cho demo
    for (const feature of vietnamBoundary.features) {
        if (turf.booleanPointInPolygon(pt, feature)) {
            return true;
        }
    }
    return false;
}

/**
 * Helper to draw bounding box of the data region
 * @param {Object} bounds {north, south, east, west}
 */
function drawDataBounds(bounds) {
    if (!bounds) return;

    if (!floodMaskLayer) {
        floodMaskLayer = L.layerGroup();
        floodMaskLayer.addTo(map);
    }

    // Simple visual indicator for data coverage
    // Can be called multiple times (one per region), but floodMaskLayer is cleared on update

    const boundsRect = L.rectangle(
        [[bounds.south, bounds.west], [bounds.north, bounds.east]],
        { color: '#2196F3', weight: 1, fill: false, dashArray: '5, 5', interactive: false }
    );
    floodMaskLayer.addLayer(boundsRect);
    console.log('🟦 Added data bounding box for region');
}
