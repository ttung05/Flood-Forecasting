/**
 * dashboard.js — Pixel Analytics Dashboard Controller
 * Government-grade interactive dashboard with:
 *   - Static terrain KPIs (DEM, Slope, Flow, Land Cover)
 *   - 10-Day interactive timeline (5 past solid + 5 future dashed)
 *   - Seasonality chart (2020–2025, monthly slider)
 *   - Regional statistics table
 *   - Interactive EDA table with heatmap cells
 */

// ─── Chart Instances ───
let chartTimeline = null;
let chartSeasonality = null;

// ─── State ───
const state = {
    lat: 16.05,
    lng: 108.20,
    region: 'DaNang',
    baseDate: null,       // Focus date (string YYYY-MM-DD)
    timelineData: [],     // Array of { date, rain, soil, risk, ... }
    seasonalityData: {},  // { 2020: [12 months], 2021: [...], ... }
    statisticsData: null, // Aggregated stats from pixel history
    focusIndex: 0,        // Which row in timelineData is the focus (last = most recent)
    availableDatesFlat: [], // Sorted array of 'YYYY-MM-DD' strings with data
};

// ─── Helpers ───
function offsetDate(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
}

function fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
}

function shortDate(dateStr) {
    return dateStr.substring(5); // MM-DD
}

function $(id) { return document.getElementById(id); }

// Land cover classification lookup (MODIS IGBP)
const LC_LABELS = {
    1: 'Evergreen Needleleaf', 2: 'Evergreen Broadleaf', 3: 'Deciduous Needleleaf',
    4: 'Deciduous Broadleaf', 5: 'Mixed Forest', 6: 'Closed Shrubland',
    7: 'Open Shrubland', 8: 'Woody Savanna', 9: 'Savanna', 10: 'Grassland',
    11: 'Wetland', 12: 'Cropland', 13: 'Urban', 14: 'Cropland/Natural Mosaic',
    15: 'Snow/Ice', 16: 'Barren', 17: 'Water Bodies'
};

function lcLabel(val) {
    if (val === null || val === undefined || val === '--') return 'N/A';
    const num = Math.round(Number(val));
    return LC_LABELS[num] || `Class ${num}`;
}

// ─── Statistical mode (most frequent value) ───
function mode(arr) {
    const freq = {};
    arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    let maxCount = 0, maxVal = arr[0];
    for (const [val, count] of Object.entries(freq)) {
        if (count > maxCount) { maxCount = count; maxVal = val; }
    }
    return maxVal;
}

// ─── Risk styling ───
function riskColor(risk) {
    const r = (risk || '').toUpperCase();
    if (r === 'HIGH') return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-300', icon: 'warning', iconColor: 'text-red-500' };
    if (r === 'MEDIUM') return { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-300', icon: 'visibility', iconColor: 'text-amber-500' };
    return { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-300', icon: 'verified_user', iconColor: 'text-emerald-500' };
}

// ─── Heatmap class ───
function rainHmClass(v) {
    if (v < 5) return 'hm-0';
    if (v < 15) return 'hm-1';
    if (v < 30) return 'hm-2';
    if (v < 50) return 'hm-3';
    return 'hm-4';
}
function soilHmClass(v) {
    if (v < 40) return 'hm-0';
    if (v < 60) return 'hm-1';
    if (v < 80) return 'hm-2';
    if (v < 90) return 'hm-3';
    return 'hm-4';
}

// ══════════════════════════════════════════════════════
//  INITIALIZATION
// ══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    console.log('📊 Dashboard: Initializing...');
    const progress = $('load-progress');
    if (progress) progress.style.width = '20%';

    // Parse URL params (map.js sends lat, lng, date, region)
    const params = new URLSearchParams(window.location.search);
    state.lat = parseFloat(params.get('lat')) || 16.05;
    state.lng = parseFloat(params.get('lng')) || 108.20;
    state.region = params.get('region') || 'DaNang';
    const urlDate = params.get('date') || null; // Respect date from map navigation

    // Update header
    $('header-coords').textContent = `${state.lat.toFixed(3)}°N, ${state.lng.toFixed(3)}°E`;
    $('header-region').textContent = state.region;

    // Load available dates first — needed by all components
    try {
        const datesInfo = await dataLoader.loadAvailableDates(state.region);
        if (datesInfo && datesInfo.availableDates) {
            state.availableDatesFlat = buildFlatDateList(datesInfo.availableDates);
            console.log(`📆 ${state.availableDatesFlat.length} available dates loaded`);
        }
    } catch (e) {
        console.warn('Could not load available dates:', e);
    }

    // Get base date: prefer URL param, then last available date, then fallback
    if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) {
        state.baseDate = urlDate;
    } else if (state.availableDatesFlat.length > 0) {
        state.baseDate = state.availableDatesFlat[state.availableDatesFlat.length - 1];
    } else {
        try {
            const tl = await dataLoader.loadTimeline();
            state.baseDate = (tl && tl.dateRange && tl.dateRange.end) ? tl.dateRange.end : '2023-01-17';
        } catch (e) {
            console.warn('Timeline fallback:', e);
            state.baseDate = '2023-01-17';
        }
    }

    if (progress) progress.style.width = '40%';

    // Fetch 10 most recent days with available data
    await fetchTimelineData();
    if (progress) progress.style.width = '60%';

    // Fetch regional statistics
    await fetchRegionStats();
    if (progress) progress.style.width = '75%';

    // Render everything
    renderStaticKPIs();
    renderTimelineChart();
    renderRiskKPIs(state.focusIndex);
    renderEDATable();
    if (progress) progress.style.width = '90%';

    // Initialize seasonality (async, non-blocking)
    initSeasonality();

    // Month slider
    setupMonthSlider();

    // Footer sync time
    $('footer-sync-time').textContent = new Date().toLocaleTimeString('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: 'Asia/Ho_Chi_Minh'
    }) + ' UTC+7';

    // Reveal
    if (progress) progress.style.width = '100%';
    setTimeout(() => {
        const overlay = $('loading-overlay');
        if (overlay) { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 500); }
        $('main-content').style.opacity = '1';
    }, 600);

    console.log('✅ Dashboard ready.');
});

// ══════════════════════════════════════════════════════
//  DATA FETCHING
// ══════════════════════════════════════════════════════

/**
 * Build a flat sorted array of 'YYYY-MM-DD' strings from the availableDates nested structure.
 * availableDates format: { "2023": { "01": [1,2,...,31], "02": [...] }, ... }
 */
function buildFlatDateList(avail) {
    const dates = [];
    for (const year of Object.keys(avail).sort()) {
        for (const month of Object.keys(avail[year]).sort()) {
            for (const day of avail[year][month]) {
                dates.push(`${year}-${month}-${String(day).padStart(2, '0')}`);
            }
        }
    }
    return dates.sort();
}

/**
 * Get the N most recent available dates up to and including `fromDate`.
 * Returns dates in chronological order (oldest first).
 */
function getRecentAvailableDates(fromDate, count) {
    const flat = state.availableDatesFlat;
    if (!flat.length) {
        // Fallback: generate consecutive dates ending at fromDate
        const result = [];
        for (let i = -(count - 1); i <= 0; i++) result.push(offsetDate(fromDate, i));
        return result;
    }
    // Find the last date <= fromDate via binary search
    let endIdx = flat.length - 1;
    for (let i = flat.length - 1; i >= 0; i--) {
        if (flat[i] <= fromDate) { endIdx = i; break; }
    }
    const startIdx = Math.max(0, endIdx - count + 1);
    return flat.slice(startIdx, endIdx + 1);
}

async function fetchTimelineData() {
    // Get 10 most recent dates with data, ending at baseDate
    const recentDates = getRecentAvailableDates(state.baseDate, 10);
    console.log(`📊 Timeline: ${recentDates.length} recent dates from ${recentDates[0]} to ${recentDates[recentDates.length - 1]}`);

    const startDate = recentDates[0];
    const endDate = recentDates[recentDates.length - 1];

    // Strategy 1: Try bulk pixel history API (single request)
    let bulkData = null;
    try {
        bulkData = await dataLoader.loadPixelHistory(
            state.lat, state.lng, state.region, startDate, endDate
        );
    } catch (e) {
        console.warn('Bulk pixel history failed, falling back to individual calls:', e);
    }

    if (bulkData && Array.isArray(bulkData) && bulkData.length > 0) {
        // Check if bulk data has any dynamic data (rainfall/soilMoisture)
        const hasDynamicData = bulkData.some(d => d.rainfall !== null || d.soilMoisture !== null);

        if (!hasDynamicData) {
            console.info('Bulk history returned only static data — falling back to individual pixel calls');
            bulkData = null; // Force fallback
        }
    }

    // Build a Set of target dates for filtering
    const targetDateSet = new Set(recentDates);

    if (bulkData && Array.isArray(bulkData) && bulkData.length > 0) {
        // Map bulk results to timeline format — only keep dates that are in our target list
        const bulkMap = {};
        bulkData.forEach(d => { if (targetDateSet.has(d.date)) bulkMap[d.date] = d; });

        state.timelineData = [];
        for (const d of recentDates) {
            const res = bulkMap[d];
            state.timelineData.push({
                date: d,
                isForecast: false,
                rain: Math.max(0, res?.rainfall ?? 0),
                soil: Math.max(0, (res?.soilMoisture ?? 0) * 100),  // fraction → %
                risk: res?.floodRisk || 'LOW',
                dem: res?.dem ?? null,
                slope: res?.slope ?? null,
                flow: res?.flow ?? null,
                landCover: res?.landCover ?? null,
                tide: res?.tide ?? 0,
            });
        }

        // Enrich the focus date (last = most recent) with full pixel data for floodRisk + tide
        try {
            const focusPixel = await dataLoader.loadPixelData(
                state.lat, state.lng, state.baseDate, state.region
            );
            if (focusPixel) {
                const focusEntry = state.timelineData[state.timelineData.length - 1];
                if (focusEntry && focusEntry.date === state.baseDate) {
                    focusEntry.risk = focusPixel.floodRisk || focusEntry.risk;
                    focusEntry.tide = focusPixel.tide ?? focusEntry.tide;
                }
            }
        } catch (e) {
            console.warn('Could not enrich focus date with full pixel data:', e);
        }
    } else {
        // Strategy 2: Fall back to individual pixel calls
        const promises = recentDates.map(d =>
            dataLoader.loadPixelData(state.lat, state.lng, d, state.region)
                .then(res => ({
                    date: d,
                    isForecast: false,
                    rain: Math.max(0, res?.rainfall ?? 0),
                    soil: Math.max(0, (res?.soilMoisture ?? 0) * 100),  // fraction → %
                    risk: res?.floodRisk || 'LOW',
                    dem: res?.dem ?? null,
                    slope: res?.slope ?? null,
                    flow: res?.flow ?? null,
                    landCover: res?.landCover ?? null,
                    tide: res?.tide ?? 0,
                }))
                .catch(() => ({
                    date: d, isForecast: false,
                    rain: 0, soil: 0, risk: 'LOW',
                    dem: null, slope: null, flow: null, landCover: null, tide: 0,
                }))
        );
        state.timelineData = await Promise.all(promises);
    }

    // Focus = last item (most recent date)
    state.focusIndex = state.timelineData.length - 1;
}

async function fetchRegionStats() {
    try {
        // Use available dates going backwards from baseDate
        const statsDates = getRecentAvailableDates(state.baseDate, 31);
        const start = statsDates[0];
        const end = statsDates[statsDates.length - 1];
        console.log(`📈 Regional Stats: ${statsDates.length} dates from ${start} to ${end}`);

        const data = await dataLoader.loadPixelHistory(state.lat, state.lng, state.region, start, end);
        if (data && Array.isArray(data) && data.length > 0) {
            // Filter to only include dates that are in our available dates list
            const dateSet = new Set(statsDates);
            const filtered = data.filter(d => dateSet.has(d.date));
            state.statisticsData = filtered;
            renderStatistics(filtered);
        }
    } catch (e) {
        console.warn('Stats fetch error:', e);
    }
}

// ══════════════════════════════════════════════════════
//  RENDER: STATIC KPIs
// ══════════════════════════════════════════════════════

function renderStaticKPIs() {
    // Collect non-null static values from timeline data
    const dems = state.timelineData.map(d => d.dem).filter(v => v !== null);
    const slopes = state.timelineData.map(d => d.slope).filter(v => v !== null);
    const flows = state.timelineData.map(d => d.flow).filter(v => v !== null);
    const lcs = state.timelineData.map(d => d.landCover).filter(v => v !== null);

    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '--';
    const mode = arr => {
        if (!arr.length) return '--';
        const freq = {};
        arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    };

    $('kpi-dem').textContent = avg(dems);
    $('kpi-slope').textContent = avg(slopes);
    $('kpi-flow').textContent = avg(flows);
    $('kpi-landcover').textContent = lcLabel(mode(lcs));

    // Also try from stats if available (pixel history uses dem/slope/flow/landCover directly)
    if (state.statisticsData && state.statisticsData.length > 0) {
        const withDem = state.statisticsData.filter(d => d.dem !== null && d.dem !== undefined);
        const withSlope = state.statisticsData.filter(d => d.slope !== null && d.slope !== undefined);
        const withFlow = state.statisticsData.filter(d => d.flow !== null && d.flow !== undefined);
        const withLC = state.statisticsData.filter(d => d.landCover !== null && d.landCover !== undefined);

        if (withDem.length) $('kpi-dem').textContent = (withDem.reduce((a, d) => a + d.dem, 0) / withDem.length).toFixed(1);
        if (withSlope.length) $('kpi-slope').textContent = (withSlope.reduce((a, d) => a + d.slope, 0) / withSlope.length).toFixed(1);
        if (withFlow.length) $('kpi-flow').textContent = (withFlow.reduce((a, d) => a + d.flow, 0) / withFlow.length).toFixed(1);
        if (withLC.length) {
            const lcVals = withLC.map(d => d.landCover);
            $('kpi-landcover').textContent = lcLabel(mode(lcVals));
        }
    }
}

// ══════════════════════════════════════════════════════
//  RENDER: RIGHT-SIDE KPI CARDS (focus row)
// ══════════════════════════════════════════════════════

function renderRiskKPIs(idx) {
    const row = state.timelineData[idx];
    if (!row) return;

    // Focus date
    $('kpi-focus-date').textContent = fmtDate(row.date);
    const badge = $('kpi-date-badge');
    badge.textContent = 'OBSERVED';
    badge.className = 'text-[10px] px-2 py-0.5 rounded-full font-semibold bg-slate-100 text-slate-600 border border-slate-200';

    // Rainfall
    $('kpi-rainfall').textContent = row.rain.toFixed(1);
    const prevRow = state.timelineData[idx - 1];
    const trendEl = $('kpi-rain-trend');
    if (prevRow) {
        const diff = row.rain - prevRow.rain;
        const icon = diff > 0 ? 'trending_up' : diff < 0 ? 'trending_down' : 'trending_flat';
        const color = diff > 5 ? 'text-red-500' : diff < -5 ? 'text-emerald-500' : 'text-slate-400';
        trendEl.innerHTML = `<span class="material-symbols-outlined text-sm ${color}">${icon}</span>
            <span class="text-[10px] ${color} font-semibold">${diff > 0 ? '+' : ''}${diff.toFixed(1)} mm</span>
            <span class="text-[10px] text-slate-400">vs prev day</span>`;
    }

    // Soil
    $('kpi-soil').textContent = row.soil.toFixed(1);
    $('kpi-soil-bar').style.width = Math.min(row.soil, 100) + '%';
    $('kpi-soil-bar').style.background = row.soil > 85 ? '#dc2626' : row.soil > 70 ? '#d97706' : '#059669';

    // Risk
    const rc = riskColor(row.risk);
    $('kpi-risk-text').textContent = row.risk;
    $('kpi-risk-text').className = `text-2xl font-extrabold uppercase tracking-wide ${rc.text}`;
    $('kpi-risk-icon').textContent = rc.icon;
    $('kpi-risk-icon').className = `material-symbols-outlined text-2xl ${rc.iconColor}`;
    $('kpi-risk-card').className = `bg-white rounded-xl border-2 p-5 shadow-gov flex-1 ${rc.border}`;
}

// ══════════════════════════════════════════════════════
//  RENDER: 10-DAY TIMELINE CHART
// ══════════════════════════════════════════════════════

function renderTimelineChart() {
    const ctx = $('chart-timeline');
    if (!ctx) return;

    const labels = state.timelineData.map(d => shortDate(d.date));
    const rainData = state.timelineData.map(d => Math.max(0, d.rain));
    const soilData = state.timelineData.map(d => Math.max(0, d.soil));

    // Focus date marker (last item = most recent)
    const focusIdx = state.focusIndex;

    const ctxCanvas = ctx.getContext('2d');
    const gradient = ctxCanvas.createLinearGradient(0, 0, 0, 280);
    gradient.addColorStop(0, 'rgba(29, 78, 216, 0.15)');
    gradient.addColorStop(1, 'rgba(29, 78, 216, 0)');

    if (chartTimeline) chartTimeline.destroy();

    chartTimeline = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Rainfall (mm)',
                    data: rainData,
                    borderColor: '#1d4ed8',
                    backgroundColor: gradient,
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.3,
                    cubicInterpolationMode: 'monotone',
                    pointBackgroundColor: state.timelineData.map((d, i) => i === state.focusIndex ? '#1d4ed8' : '#ffffff'),
                    pointBorderColor: '#1d4ed8',
                    pointBorderWidth: 2,
                    pointRadius: state.timelineData.map((d, i) => i === state.focusIndex ? 6 : 3),
                    pointHoverRadius: 7,
                    yAxisID: 'y'
                },
                {
                    label: 'Soil Moisture (%)',
                    data: soilData,
                    borderColor: '#d97706',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    cubicInterpolationMode: 'monotone',
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleFont: { size: 12, family: 'JetBrains Mono', weight: '700' },
                    bodyFont: { size: 11, family: 'JetBrains Mono' },
                    padding: 14,
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    callbacks: {
                        title: items => {
                            const row = state.timelineData[items[0].dataIndex];
                            return `${row.date} (Observed)`;
                        }
                    }
                },
                annotation: {
                    annotations: {
                        focusLine: {
                            type: 'line',
                            xMin: focusIdx,
                            xMax: focusIdx,
                            borderColor: 'rgba(29, 78, 216, 0.3)',
                            borderWidth: 2,
                            borderDash: [4, 4],
                            label: {
                                display: true,
                                content: 'FOCUS',
                                position: 'start',
                                backgroundColor: 'rgba(29, 78, 216, 0.85)',
                                font: { size: 9, family: 'JetBrains Mono', weight: '700' },
                                padding: { top: 3, bottom: 3, left: 6, right: 6 },
                                borderRadius: 4,
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#94a3b8' }
                },
                y: {
                    type: 'linear', display: true, position: 'left',
                    title: { display: true, text: 'Rainfall (mm)', font: { size: 10, family: 'Inter' }, color: '#64748b' },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' },
                    min: 0,
                    ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#94a3b8' }
                },
                y1: {
                    type: 'linear', display: true, position: 'right',
                    title: { display: true, text: 'Soil Moisture (%)', font: { size: 10, family: 'Inter' }, color: '#64748b' },
                    grid: { display: false },
                    min: 0, max: 100,
                    ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#94a3b8' }
                }
            },
            onClick: (e, elements) => {
                if (elements.length > 0) {
                    const idx = elements[0].index;
                    state.focusIndex = idx;
                    renderRiskKPIs(idx);
                    highlightTableRow(idx);
                    updateTimelineHighlight(idx);
                }
            }
        }
    });
}

function updateTimelineHighlight(idx) {
    if (!chartTimeline) return;
    const ds = chartTimeline.data.datasets[0];
    ds.pointBackgroundColor = state.timelineData.map((_, i) => i === idx ? '#1d4ed8' : '#ffffff');
    ds.pointRadius = state.timelineData.map((_, i) => i === idx ? 6 : 3);
    chartTimeline.update('none');
}

// ══════════════════════════════════════════════════════
//  RENDER: EDA TABLE
// ══════════════════════════════════════════════════════

function renderEDATable() {
    const tbody = $('eda-table-body');
    if (!tbody) return;

    tbody.innerHTML = state.timelineData.map((row, idx) => {
        const isActive = idx === state.focusIndex;
        const rc = riskColor(row.risk);
        const activeClass = isActive
            ? 'bg-blue-50/60 ring-2 ring-gov-500/20 ring-inset'
            : 'hover:bg-slate-50';

        return `
        <tr class="cursor-pointer transition-colors ${activeClass}" onclick="onTableRowClick(${idx})" data-row-idx="${idx}">
            <td class="px-6 py-3.5 font-mono text-xs ${isActive ? 'text-gov-500 font-bold' : 'text-slate-700'}">
                ${row.date}
            </td>
            <td class="px-4 py-3.5 text-right data-mono text-xs ${rainHmClass(row.rain)}">${row.rain.toFixed(1)}</td>
            <td class="px-4 py-3.5 text-right data-mono text-xs ${soilHmClass(row.soil)}">${row.soil.toFixed(1)}</td>
            <td class="px-4 py-3.5 text-center">
                <span class="text-[10px] font-semibold text-slate-400">OBSERVED</span>
            </td>
            <td class="px-4 py-3.5 text-center">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${rc.bg} ${rc.text}">${row.risk}</span>
            </td>
        </tr>`;
    }).join('');
}

function onTableRowClick(idx) {
    state.focusIndex = idx;
    renderRiskKPIs(idx);
    renderEDATable();
    updateTimelineHighlight(idx);

    // Sync chart tooltip
    if (chartTimeline) {
        const meta = chartTimeline.getDatasetMeta(0);
        if (meta.data[idx]) {
            chartTimeline.setActiveElements([{ datasetIndex: 0, index: idx }]);
            chartTimeline.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: meta.data[idx].x, y: meta.data[idx].y });
            chartTimeline.update();
        }
    }
}

function highlightTableRow(idx) {
    renderEDATable(); // Re-render with new active
    const row = document.querySelector(`[data-row-idx="${idx}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ══════════════════════════════════════════════════════
//  RENDER: REGIONAL STATISTICS
// ══════════════════════════════════════════════════════

function renderStatistics(histData) {
    if (!histData || histData.length === 0) return;

    // Support both pixel history fields (rainfall, soilMoisture) and region history fields (totalRainfall, avgSoilMoisture)
    const rains = histData.map(d => d.rainfall ?? d.totalRainfall ?? 0).filter(v => v !== null);
    const soils = histData.map(d => d.soilMoisture ?? d.avgSoilMoisture ?? 0).filter(v => v !== null);

    const daysWithRain = rains.filter(r => r > 0);
    const avgRain = daysWithRain.length ? daysWithRain.reduce((a, b) => a + b, 0) / daysWithRain.length : 0;
    const maxRain = rains.length ? Math.max(...rains) : 0;
    const totalRain = rains.reduce((a, b) => a + b, 0);
    const avgSoil = soils.length ? soils.reduce((a, b) => a + b, 0) / soils.length : 0;
    const maxSoil = soils.length ? Math.max(...soils) : 0;
    const heavyDays = rains.filter(r => r > 20).length;

    const firstDate = histData[0]?.date || '--';
    const lastDate = histData[histData.length - 1]?.date || '--';

    $('stat-avg-rain').textContent = avgRain.toFixed(1) + ' mm';
    $('stat-max-rain').textContent = maxRain.toFixed(1) + ' mm';
    $('stat-total-rain').textContent = totalRain.toFixed(1) + ' mm';
    $('stat-avg-soil').textContent = (avgSoil * 100).toFixed(1) + '%';
    $('stat-max-soil').textContent = (maxSoil * 100).toFixed(1) + '%';
    $('stat-heavy-days').textContent = heavyDays + ' days';
    $('stat-period').textContent = `${firstDate} → ${lastDate}`;
    $('stats-region-label').textContent = `${state.region} — ${histData.length} days analyzed`;
}

// ══════════════════════════════════════════════════════
//  SEASONALITY
// ══════════════════════════════════════════════════════

async function initSeasonality() {
    const years = [2020, 2021, 2022, 2023, 2024, 2025];
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Initialize datasets
    years.forEach(y => { state.seasonalityData[y] = new Array(12).fill(null); });

    // Fetch per-year pixel history (6 API calls) then aggregate daily→monthly totals
    const yearPromises = years.map(y =>
        dataLoader.loadPixelHistory(
            state.lat, state.lng, state.region,
            `${y}-01-01`, `${y}-12-31`
        ).catch(() => null)
    );

    const yearResults = await Promise.all(yearPromises);

    yearResults.forEach((dailyData, yIdx) => {
        const year = years[yIdx];
        if (!dailyData || !Array.isArray(dailyData)) return;

        // Group daily rainfall by month and sum
        const monthlyTotals = new Array(12).fill(null);
        const monthlyCounts = new Array(12).fill(0);

        dailyData.forEach(day => {
            if (day.rainfall === null || day.rainfall === undefined) return;
            const monthIdx = parseInt(day.date.substring(5, 7), 10) - 1; // 0-indexed
            if (monthlyTotals[monthIdx] === null) monthlyTotals[monthIdx] = 0;
            monthlyTotals[monthIdx] += day.rainfall;
            monthlyCounts[monthIdx]++;
        });

        state.seasonalityData[year] = monthlyTotals;

        // Log coverage for debugging
        const monthsWithData = monthlyCounts.filter(c => c > 0).length;
        console.log(`📅 Seasonality ${year}: ${monthsWithData}/12 months with data, ` +
            `total days=${dailyData.length}, days with rain=${monthlyCounts.reduce((a,b) => a+b, 0)}`);
    });

    // Render chart
    renderSeasonalityChart(MONTH_LABELS, years);
}

function renderSeasonalityChart(monthLabels, years) {
    const ctx = $('chart-seasonality');
    if (!ctx) return;

    // Color palette for years (government-appropriate muted palette)
    const yearColors = {
        2020: { border: 'rgba(148, 163, 184, 0.5)', width: 1.5 },
        2021: { border: 'rgba(100, 116, 139, 0.5)', width: 1.5 },
        2022: { border: 'rgba(71, 85, 105, 0.55)', width: 1.5 },
        2023: { border: 'rgba(51, 65, 85, 0.6)', width: 2 },
        2024: { border: 'rgba(30, 41, 59, 0.65)', width: 2 },
        2025: { border: '#d97706', width: 2.5 }, // Amber highlight for most recent
    };

    const datasets = years.map(y => ({
        label: String(y),
        data: [...state.seasonalityData[y]],
        borderColor: yearColors[y].border,
        borderWidth: yearColors[y].width,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        spanGaps: true,
    }));

    if (chartSeasonality) chartSeasonality.destroy();

    chartSeasonality = new Chart(ctx, {
        type: 'line',
        data: { labels: monthLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true, position: 'bottom',
                    labels: {
                        usePointStyle: true, boxWidth: 8, padding: 16,
                        font: { family: 'Inter', size: 11, weight: '500' },
                        color: '#475569'
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleFont: { size: 12, family: 'JetBrains Mono', weight: '700' },
                    bodyFont: { size: 11, family: 'JetBrains Mono' },
                    padding: 12,
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    callbacks: {
                        label: item => `${item.dataset.label}: ${item.raw !== null ? item.raw.toFixed(1) + ' mm' : 'N/A'}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#94a3b8' }
                },
                y: {
                    grid: { color: 'rgba(148, 163, 184, 0.1)' },
                    title: { display: true, text: 'Monthly Total Rainfall (mm)', font: { size: 10, family: 'Inter' }, color: '#64748b' },
                    min: 0,
                    ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#94a3b8' }
                }
            }
        }
    });
}

// ─── Month Slider ───
function setupMonthSlider() {
    const slider = $('month-slider');
    const valLabel = $('month-slider-val');
    const headerLabel = $('month-slider-label');
    const MONTHS = ['All', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    if (!slider) return;

    slider.addEventListener('input', () => {
        const val = parseInt(slider.value);
        valLabel.textContent = MONTHS[val];
        headerLabel.textContent = val === 0 ? 'All Months' : `Focused: ${MONTHS[val]}`;

        if (!chartSeasonality) return;

        if (val === 0) {
            // Show all months - restore full data
            const years = Object.keys(state.seasonalityData).map(Number);
            chartSeasonality.data.datasets.forEach(ds => {
                const y = parseInt(ds.label);
                if (state.seasonalityData[y]) {
                    ds.data = [...state.seasonalityData[y]];
                }
            });
        } else {
            // Highlight single month — show bar-like emphasis
            const monthIdx = val - 1;
            chartSeasonality.data.datasets.forEach(ds => {
                const y = parseInt(ds.label);
                if (state.seasonalityData[y]) {
                    ds.data = state.seasonalityData[y].map((v, i) => i === monthIdx ? v : null);
                }
            });
        }
        chartSeasonality.update();
    });
}

// ══════════════════════════════════════════════════════
//  EXPORT (Basic CSV)
// ══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    const btn = $('btn-export');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const headers = ['Date', 'Rainfall_mm', 'SoilMoisture_pct', 'Risk', 'Type'];
        const rows = state.timelineData.map(d =>
            [d.date, d.rain.toFixed(1), d.soil.toFixed(1), d.risk, d.isForecast ? 'Forecast' : 'Observed'].join(',')
        );
        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pixel_${state.lat}_${state.lng}_${state.baseDate}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
});
