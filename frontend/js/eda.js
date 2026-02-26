/**
 * eda.js - WebGL Leaflet GeoRaster Stack for Native Resolution Analytics
 */

// Clock Topbar
function updateClock() {
    const now = new Date();
    document.getElementById('nav-clock').textContent = now.toLocaleTimeString('en-GB') + ' UTC+7';
}
setInterval(updateClock, 1000);
updateClock();

const DEFAULT_DATE = '2020-01-01'; // Default date from Database
document.getElementById('nav-date').textContent = DEFAULT_DATE;

// --- CONFIGURATION ---
const layerConfigs = [
    {
        id: 'dem', name: 'dem',
        scale: 'YlGn', isCat: false, suffix: 'm',
        infoDoms: { coordId: 'coord-dem', valId: 'val-dem' }
    },
    {
        id: 'flood', name: 'label',
        scale: null, isCat: true, suffix: '',
        catMap: {
            0: { hex: null, label: 'Bình thường (0)', bg: 'bg-[#f8fafc]', text: 'text-slate-600' },
            1: { hex: '#0000ff', label: 'Ngập lụt Flood (1)', bg: 'bg-blue-600', text: 'text-white font-bold animate-pulse' }
        },
        infoDoms: { coordId: 'coord-flood', valId: 'val-flood' }
    },
    {
        id: 'flow', name: 'flow',
        scale: 'Blues', isCat: false, suffix: '',
        infoDoms: { coordId: 'coord-flow', valId: 'val-flow' }
    },
    {
        id: 'lc', name: 'landCover',
        scale: null, isCat: true, suffix: '',
        catMap: {
            1: { hex: '#3b82f6', label: 'Water Body (Nước)', bg: 'bg-blue-500', text: 'text-white' },
            2: { hex: '#64748b', label: 'Bare Land / Urban', bg: 'bg-slate-500', text: 'text-white' },
            3: { hex: '#a3e635', label: 'Shrubland', bg: 'bg-lime-500', text: 'text-white' },
            4: { hex: '#eab308', label: 'Agriculture', bg: 'bg-yellow-500', text: 'text-slate-900' },
            5: { hex: '#15803d', label: 'Forest', bg: 'bg-green-700', text: 'text-white' }
        },
        infoDoms: { coordId: 'coord-lc', valId: 'val-lc' }
    },
    {
        id: 'rain', name: 'rain',
        scale: 'YlGnBu', isCat: false, suffix: 'mm',
        infoDoms: { coordId: 'coord-rain', valId: 'val-rain' }
    },
    {
        id: 'soil', name: 'soilMoisture',
        scale: 'YlOrRd', isCat: false, suffix: 'Vol%',
        infoDoms: { coordId: 'coord-soil', valId: 'val-soil' }
    }
];

// --- INITIALIZE MAPS ---
const maps = {};
layerConfigs.forEach(cfg => {
    // Basic Leaflet Map Init
    const m = L.map('plot-' + cfg.id, {
        zoomControl: true,
        scrollWheelZoom: true
    }).setView([16.1, 108.15], 11);

    // Add minimalist basemap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(m);

    // Click Event to get EXACT backend data
    m.on('click', async function (e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);

        // Cập nhật tọa độ hiển thị
        const cDom = document.getElementById(cfg.infoDoms.coordId);
        cDom.innerHTML = `<span class="text-slate-400 font-normal">y:</span> ${lat}, <span class="text-slate-400 font-normal">x:</span> ${lng}`;
        cDom.className = cDom.className.replace(/text-[a-z]+-600/, 'text-slate-800');

        // Gọi API gốc (Native Backend Request)
        const vDom = document.getElementById(cfg.infoDoms.valId);
        vDom.innerHTML = '<span class="text-slate-400">Loading...</span>';

        try {
            const res = await fetch(`/api/pixel/${lat}/${lng}/${DEFAULT_DATE}/DaNang`);
            const json = await res.json();

            if (json.success && json.data) {
                // Map API keys might differ slightly from our names, pixel.history matches layer names.
                // In pixel.controller GET /pixel/:lat/:lng/:date/:region returns { data: { metadata: ..., features: { rainfall: ..., dem: ... } } }
                // Let's check pixel.types.ts mentally, it usually returns flat data in `features` or directly.
                let rawValue = json.data[cfg.name] ?? json.data.features?.[cfg.name];

                // Fallback direct parsing for Rain, SoilMoisture...
                if (rawValue === undefined) rawValue = json.data.rainfall && cfg.name === 'rain' ? json.data.rainfall : rawValue;

                if (rawValue === null || rawValue === undefined) {
                    vDom.innerHTML = `<span class="text-slate-400 italic">No Data</span>`;
                }
                else if (cfg.isCat) {
                    const mapObj = cfg.catMap[Math.round(rawValue)] || { label: 'Unknown', bg: 'bg-slate-200', text: 'text-slate-600' };
                    vDom.innerHTML = `<div class="${mapObj.bg} ${mapObj.text} px-3 py-1 rounded shadow-sm border border-black/10 text-[13px] font-medium inline-block">${mapObj.label}</div>`;
                } else {
                    vDom.innerHTML = Number(rawValue).toFixed(2);
                }
            } else {
                vDom.innerHTML = `<span class="text-red-400 italic">Error</span>`;
            }
        } catch (err) {
            vDom.innerHTML = `<span class="text-red-400 italic">Net Error</span>`;
        }

        // UX UI Flash (Flash the parent node background slightly)
        const pNode = document.getElementById(cfg.infoDoms.valId).parentElement;
        pNode.style.transition = 'none';
        pNode.style.backgroundColor = '#f1f5f9';
        setTimeout(() => {
            pNode.style.transition = 'background-color 0.8s ease';
            pNode.style.backgroundColor = 'white';
        }, 50);
    });

    maps[cfg.id] = { instance: m, layer: null };
});


// --- LOAD TIF VIA API STREAM ---
async function loadLayerGeoTiff(cfg, dateStr) {
    const mapObj = maps[cfg.id];
    const url = `/api/tif/DaNang/${cfg.name}/${dateStr}`;

    // UI Loading state
    const parentNode = document.getElementById(cfg.infoDoms.valId).parentElement;
    parentNode.style.opacity = '0.5';

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Not found TIF');
        const arrayBuffer = await response.arrayBuffer();

        const georaster = await parseGeoraster(arrayBuffer);

        let min = georaster.mins[0];
        let max = georaster.maxs[0];

        // Specific Adjustments for visual clarity
        if (cfg.id === 'flow') max = 1000;
        if (cfg.id === 'rain') max = 150;

        let colorScaleFn;
        if (cfg.isCat) {
            colorScaleFn = value => {
                if (value === georaster.noDataValue || isNaN(value)) return null;
                const cat = cfg.catMap[Math.round(value)];
                return cat && cat.hex ? cat.hex : null;
            }
        } else {
            const scale = chroma.scale(cfg.scale).domain([min, Math.max(min + 1, max)]);
            colorScaleFn = value => {
                if (value === georaster.noDataValue || isNaN(value) || value === -9999 || value <= -9998) return null;
                return scale(value).hex();
            }
        }

        // Tạo layer GeoRaster WebGL
        const geoLayer = new GeoRasterLayer({
            georaster: georaster,
            opacity: 0.8,
            pixelValuesToColorFn: colorScaleFn,
            resolution: 256 // WebGL rendering chunk size
        });

        // Xoá memory layer cũ nếu có
        if (mapObj.layer) {
            mapObj.instance.removeLayer(mapObj.layer);
        }

        geoLayer.addTo(mapObj.instance);
        mapObj.layer = geoLayer;

        // Căng khung về chuẩn
        mapObj.instance.fitBounds(geoLayer.getBounds());

    } catch (e) {
        console.error(`Layer ${cfg.name} not found or decode failed:`, e);
    } finally {
        parentNode.style.opacity = '1';
    }
}

// Boot up sequence
layerConfigs.forEach(cfg => {
    loadLayerGeoTiff(cfg, DEFAULT_DATE);
});
