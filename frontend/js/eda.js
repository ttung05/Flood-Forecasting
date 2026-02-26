/**
 * pixel-eda.js - Plotly Interactive Heatmap Stack for Multi-dimensional Pixel Analytics
 */

// Clock Topbar
function updateClock() {
    const now = new Date();
    document.getElementById('nav-clock').textContent = now.toLocaleTimeString('en-GB') + ' UTC+7';
}
setInterval(updateClock, 1000);
updateClock();

// --- DATA MOCKING LAYER ---
const bounds = {
    latMin: 15.95, latMax: 16.25,
    lonMin: 107.9, lonMax: 108.4
};

const gridSize = 80;

const xLon = [];
const yLat = [];
for (let i = 0; i < gridSize; i++) {
    xLon.push(bounds.lonMin + i * (bounds.lonMax - bounds.lonMin) / gridSize);
    yLat.push(bounds.latMin + i * (bounds.latMax - bounds.latMin) / gridSize);
}

// Generate Z data matrices
const zDem = [];
const zFlood = [];
const zFlow = [];
const zLc = [];
const zRain = [];
const zSoil = [];

for (let r = 0; r < gridSize; r++) { // y axis loop
    const rowDem = [];
    const rowFlood = [];
    const rowFlow = [];
    const rowLc = [];
    const rowRain = [];
    const rowSoil = [];

    for (let c = 0; c < gridSize; c++) { // x axis loop
        const lat = yLat[r];
        const lon = xLon[c];

        // 1. DEM (Elevation)
        const noise = (Math.random() - 0.5) * 0.15;
        let vDem = (Math.sin(lat * 40) * Math.cos(lon * 40)) * 0.5 + 0.5 + noise;
        if (vDem < 0.25) vDem = 0; // sea level limit
        let finalDem = vDem * 20;
        rowDem.push(finalDem);

        // 2. Flood (Dependent on DEM=0)
        let isFlood = (finalDem === 0 && Math.random() > 0.45) ? 1 : 0;
        rowFlood.push(isFlood);

        // 3. Flow Accumulation (Inverse to DEM)
        let finalFlow = Math.pow((1 - (finalDem / 20)), 3) * 1000 + (Math.random() * 10);
        rowFlow.push(finalFlow);

        // 4. LULC (Categorical 1-5, depends roughly on altitude)
        let finalLc = 1;
        if (finalDem === 0) finalLc = 1; // Water body
        else if (finalDem < 5) finalLc = 2; // Bare land / urban
        else if (finalDem < 10) finalLc = 3; // Shrubs
        else if (finalDem < 15) finalLc = 4; // Agriculture
        else finalLc = 5; // Forest
        rowLc.push(finalLc);

        // 5. Rainfall (Spacial function, random showers)
        let finalRain = Math.max(0, (Math.sin(lat * 15) + Math.cos(lon * 10)) * 50 + 40 + noise * 50);
        rowRain.push(finalRain);

        // 6. Soil Moisture (Depends on Rain and Flood)
        let finalSoil = Math.min(100, (finalRain * 0.4) + (isFlood * 80) + (Math.random() * 5));
        rowSoil.push(finalSoil);
    }
    zDem.push(rowDem);
    zFlood.push(rowFlood);
    zFlow.push(rowFlow);
    zLc.push(rowLc);
    zRain.push(rowRain);
    zSoil.push(rowSoil);
}

// --- PLOTLY SHARED CONFIGURATION ---
const defaultLayout = {
    margin: { t: 40, r: 20, b: 50, l: 60 },
    xaxis: { title: 'Longitude (Kinh độ)', fixedrange: false, color: '#64748b' },
    yaxis: { title: 'Latitude (Vĩ độ)', fixedrange: false, scaleanchor: 'x', scaleratio: 1, color: '#64748b' },
    plot_bgcolor: '#f8fafc',
    paper_bgcolor: 'transparent'
};

const configShared = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d']
};

// HELPER FUNCTION: Setup Plot and Click Logic
function applyPlot(domId, zData, colorscale, title, valSuffix, valPrefixHtml, boxId, coordId, valId, isCategorical = false, catMap = {}) {
    const trace = {
        x: xLon, y: yLat, z: zData,
        type: 'heatmap',
        colorscale: colorscale,
        colorbar: {
            title: title,
            thickness: 15, len: 0.9,
            tickfont: { color: '#64748b' },
            titlefont: { color: '#1e293b', size: 11 }
        },
        hovertemplate: `Kinh Độ: %{x:.4f}<br>Vĩ Độ: %{y:.4f}<br><b>${title}: %{z:.2f}</b><extra></extra>`
    };

    if (isCategorical) {
        trace.colorbar.tickmode = 'array';
        trace.colorbar.tickvals = Object.keys(catMap).map(Number);
        trace.colorbar.ticktext = Object.values(catMap).map(x => x.label);
    }

    Plotly.newPlot(domId, [trace], { ...defaultLayout, title: false }, configShared);

    document.getElementById(domId).on('plotly_click', function (data) {
        if (data.points.length > 0) {
            const pt = data.points[0];
            // Format Coords
            const cDom = document.getElementById(coordId);
            cDom.innerHTML = `<span class="text-slate-400 font-normal">y:</span> ${pt.y.toFixed(4)}, <span class="text-slate-400 font-normal">x:</span> ${pt.x.toFixed(4)}`;
            // Remove initial placeholder color, add active color
            cDom.className = cDom.className.replace(/text-[a-z]+-600/, 'text-slate-800');

            // Format Value
            const vDom = document.getElementById(valId);
            if (isCategorical) {
                const mapObj = catMap[Math.round(pt.z)] || { label: 'Unknown', bg: 'bg-slate-200', text: 'text-slate-600' };
                vDom.innerHTML = `<div class="${mapObj.bg} ${mapObj.text} px-3 py-1 rounded shadow-sm border border-black/10 text-[13px] font-medium inline-block">${mapObj.label}</div>`;
            } else {
                vDom.innerHTML = pt.z.toFixed(2);
            }

            // UX UI Flash (Flash the parent node background slightly)
            const pNode = document.getElementById(valId).parentElement;
            pNode.style.transition = 'none';
            pNode.style.backgroundColor = '#f1f5f9';
            setTimeout(() => {
                pNode.style.transition = 'background-color 0.8s ease';
                pNode.style.backgroundColor = 'white';
            }, 50);
        }
    });
}

// ============================================
// INITIATE PLOTS
// ============================================

// 1. DEM Plot
applyPlot('plot-dem', zDem, 'Earth', 'Elevation (m)', 'm', '',
    'plot-dem', 'coord-dem', 'val-dem');

// 2. FLOOD Plot
const floodMap = {
    0: { label: 'Bình thường (0)', bg: 'bg-[#f8fafc]', text: 'text-slate-600' },
    1: { label: 'Ngập lụt Flood (1)', bg: 'bg-blue-600', text: 'text-white font-bold animate-pulse' }
};
applyPlot('plot-flood', zFlood, [[0, '#f8fafc'], [1, '#0000ff']], 'Water Extent', '', '',
    'plot-flood', 'coord-flood', 'val-flood', true, floodMap);

// 3. FLOW Plot
applyPlot('plot-flow', zFlow, 'Blues', 'Flow Acc', '', '',
    'plot-flow', 'coord-flow', 'val-flow');

// 4. LULC Plot
const lcMap = {
    1: { label: 'Water Body (Nước)', bg: 'bg-blue-500', text: 'text-white' },
    2: { label: 'Bare Land / Urban', bg: 'bg-slate-500', text: 'text-white' },
    3: { label: 'Shrubland', bg: 'bg-lime-500', text: 'text-white' },
    4: { label: 'Agriculture', bg: 'bg-yellow-500', text: 'text-slate-900' },
    5: { label: 'Forest', bg: 'bg-green-700', text: 'text-white' }
};
// Array of colors mimicking the discrete lcMap categories
const lcColors = [
    [0.0, '#3b82f6'], [0.2, '#3b82f6'],
    [0.2, '#64748b'], [0.4, '#64748b'],
    [0.4, '#a3e635'], [0.6, '#a3e635'],
    [0.6, '#eab308'], [0.8, '#eab308'],
    [0.8, '#15803d'], [1.0, '#15803d']
];
applyPlot('plot-lc', zLc, lcColors, 'Class', '', '',
    'plot-lc', 'coord-lc', 'val-lc', true, lcMap);

// 5. RAIN Plot
applyPlot('plot-rain', zRain, 'YlGnBu', 'Rainfall (mm)', 'mm', '',
    'plot-rain', 'coord-rain', 'val-rain');

// 6. SOIL MOISTURE Plot
applyPlot('plot-soil', zSoil, 'YlOrRd', 'Moisture (Vol)', '%', '',
    'plot-soil', 'coord-soil', 'val-soil');
