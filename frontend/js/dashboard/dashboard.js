/**
 * dashboard.js — Pixel Analytics Dashboard Controller
 * Government-grade interactive dashboard with:
 *   - Static terrain KPIs (DEM, Slope, Flow, Land Cover)
 *   - 10-Day interactive timeline (5 past solid + 5 future dashed)
 *   - Regional statistics table
 *   - Interactive EDA table with heatmap cells
 */

// ─── Chart Instances ───
let chartTimeline = null;

// ─── State ───
const state = {
    lat: 16.05,
    lng: 108.20,
    region: 'DaNang',
    baseDate: null,       // Focus date (string YYYY-MM-DD)
    timelineData: [],     // Array of { date, rain, soil, risk, ... }
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

/** Display token when a value is missing from the database / API */
const UI_NO_DATA = 'nodata';

function isPresentNumber(v) {
    return v != null && v !== '' && typeof v !== 'boolean' && !Number.isNaN(Number(v));
}

/**
 * Map raw pixel API row to timeline row; null = not in DB (show nodata in UI).
 */
function normalizePixelRow(res, date) {
    const row = {
        date,
        isForecast: false,
        rain: null,
        soil: null,
        risk: null,
        dem: null,
        slope: null,
        flow: null,
        landCover: null,
        tide: null,
    };
    if (!res || typeof res !== 'object') return row;
    if (isPresentNumber(res.rainfall)) row.rain = Math.max(0, Number(res.rainfall));
    if (isPresentNumber(res.soilMoisture)) row.soil = Math.max(0, Number(res.soilMoisture) * 100);
    if (isPresentNumber(res.dem)) row.dem = Number(res.dem);
    if (isPresentNumber(res.slope)) row.slope = Number(res.slope);
    if (isPresentNumber(res.flow)) row.flow = Number(res.flow);
    if (res.landCover != null && res.landCover !== '' && !Number.isNaN(Number(res.landCover))) {
        row.landCover = Number(res.landCover);
    }
    if (isPresentNumber(res.tide)) row.tide = Number(res.tide);

    // Derive risk level on frontend based on actual rainfall and soil moisture
    row.risk = deriveFrontendRisk(row.rain, row.soil, res.flood);
    return row;
}

/**
 * Frontend risk level derivation — combines rainfall (mm), soil moisture (%),
 * and flood label to produce accurate risk assessment.
 * @param {number|null} rain - Rainfall in mm
 * @param {number|null} soil - Soil moisture in % (already ×100)
 * @param {number|null|undefined} flood - Raw flood label from API (0-1 scale)
 * @returns {string} 'LOW' | 'MEDIUM' | 'HIGH'
 */
function deriveFrontendRisk(rain, soil, flood) {
    const r = rain ?? 0;
    const s = soil ?? 0;       // Already in % (0-100 scale)
    const f = (flood != null && isPresentNumber(flood)) ? Number(flood) : 0;

    // HIGH: flood label confirms AND significant rainfall or wet soil
    if (f > 0.5 && (r > 50 || s > 70)) return 'HIGH';
    // HIGH: very heavy rainfall
    if (r > 100) return 'HIGH';
    // HIGH: heavy rain combined with saturated soil
    if (r > 50 && s > 60) return 'HIGH';

    // MEDIUM: flood label with moderate conditions
    if (f > 0.5 && (r > 20 || s > 50)) return 'MEDIUM';
    // MEDIUM: moderate rainfall
    if (r > 50) return 'MEDIUM';
    // MEDIUM: moderate rain with wet soil
    if (r > 20 && s > 40) return 'MEDIUM';
    // MEDIUM: very wet soil even with low rain
    if (s > 70) return 'MEDIUM';

    // LOW: dry/normal conditions
    return 'LOW';
}


// Land cover classification lookup (MODIS IGBP)
const LC_LABELS = {
    1: 'Evergreen Needleleaf', 2: 'Evergreen Broadleaf', 3: 'Deciduous Needleleaf',
    4: 'Deciduous Broadleaf', 5: 'Mixed Forest', 6: 'Closed Shrubland',
    7: 'Open Shrubland', 8: 'Woody Savanna', 9: 'Savanna', 10: 'Grassland',
    11: 'Wetland', 12: 'Cropland', 13: 'Urban', 14: 'Cropland/Natural Mosaic',
    15: 'Snow/Ice', 16: 'Barren', 17: 'Water Bodies'
};

function lcLabel(val) {
    if (val === null || val === undefined || val === '--') return UI_NO_DATA;
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
    if (r === '' || r === 'NODATA' || r === 'NO DATA' || r === 'NULL') {
        return { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', icon: 'help', iconColor: 'text-slate-400' };
    }
    if (r === 'HIGH' || r === 'CRITICAL') return { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-300', icon: 'warning', iconColor: 'text-red-500' };
    if (r === 'MEDIUM') return { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-300', icon: 'visibility', iconColor: 'text-amber-500' };
    return { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-300', icon: 'verified_user', iconColor: 'text-emerald-500' };
}

// ─── Heatmap class ───
function rainHmClass(v) {
    if (v == null || Number.isNaN(Number(v))) return 'text-slate-400';
    if (v < 5) return 'hm-0';
    if (v < 15) return 'hm-1';
    if (v < 30) return 'hm-2';
    if (v < 50) return 'hm-3';
    return 'hm-4';
}
function soilHmClass(v) {
    if (v == null || Number.isNaN(Number(v))) return 'text-slate-400';
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
    const pageT0 = performance.now();
    const progress = $('load-progress');
    if (progress) progress.style.width = '20%';

    // Parse URL params (map.js sends lat, lng, date, region)
    const params = new URLSearchParams(window.location.search);
    state.lat = parseFloat(params.get('lat')) || 16.05;
    state.lng = parseFloat(params.get('lng')) || 108.20;
    state.region = params.get('region') || 'DaNang';
    const urlDate = params.get('date') || null; // Respect date from map navigation
    const urlDateValid = Boolean(urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate));

    // Update header
    $('header-coords').textContent = `${state.lat.toFixed(3)}°N, ${state.lng.toFixed(3)}°E`;
    $('header-region').textContent = state.region;

    if (urlDateValid) {
        state.baseDate = urlDate;
    }

    // Load available dates first — needed by all components
    const tDates0 = performance.now();
    try {
        const datesInfo = await dataLoader.loadAvailableDates(state.region);
        if (datesInfo && datesInfo.availableDates) {
            state.availableDatesFlat = buildFlatDateList(datesInfo.availableDates);
            console.log(`📆 ${state.availableDatesFlat.length} available dates loaded`);
        }
    } catch (e) {
        console.warn('Could not load available dates:', e);
    }
    const datesMs = Math.round(performance.now() - tDates0);

    // Resolve base date when URL did not provide one
    if (!urlDateValid) {
        if (state.availableDatesFlat.length > 0) {
            state.baseDate = state.availableDatesFlat[state.availableDatesFlat.length - 1];
        } else {
            try {
                const tl = await dataLoader.loadTimeline();
                const latestFromTimeline = tl?.dates?.length ? tl.dates[tl.dates.length - 1] : (tl?.dateRange?.end || null);
                state.baseDate = latestFromTimeline || new Date().toISOString().split('T')[0];
            } catch (e) {
                console.warn('Timeline fallback:', e);
                try {
                    const r = await fetch(`${window.API_BASE_URL || ''}/api/timeline`);
                    const env = await r.json();
                    const dates = env?.data?.dates;
                    if (env?.success && Array.isArray(dates) && dates.length) {
                        state.baseDate = dates[dates.length - 1];
                    } else {
                        state.baseDate = new Date().toISOString().split('T')[0];
                    }
                } catch (e2) {
                    state.baseDate = new Date().toISOString().split('T')[0];
                }
            }
        }

    }

    if (progress) progress.style.width = '40%';

    const tPixel0 = performance.now();
    await loadDashboardPixelData();
    const pixelMs = Math.round(performance.now() - tPixel0);
    if (progress) progress.style.width = '75%';

    // Render everything
    const tRender0 = performance.now();
    renderStaticKPIs();
    renderTimelineChart();
    renderRiskKPIs(state.focusIndex);
    renderEDATable();
    const renderMs = Math.round(performance.now() - tRender0);
    if (progress) progress.style.width = '90%';

    const totalMs = Math.round(performance.now() - pageT0);
    window.__DAP_DETAIL_API_MS = {
        datesMs,
        pixelBatchOrHistoryMs: pixelMs,
        renderMs,
        totalMs,
    };
    console.log('⏱️ DAP detail.html API / load (ms):', window.__DAP_DETAIL_API_MS);

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

/** Regional stats window (fewer days → less NPZ/R2). Timeline stays DASH_TIMELINE_DAYS. */
const DASH_STATS_LOOKBACK_DAYS = 14;
const DASH_TIMELINE_DAYS = 10;

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

/**
 * One combined load: timeline (10d) + regional stats (DASH_STATS_LOOKBACK_DAYS) via one batch POST
 * or one GET history — avoids duplicate NPZ work and duplicate HTTP round-trips.
 */
async function loadDashboardPixelData() {
    const statsDates = getRecentAvailableDates(state.baseDate, DASH_STATS_LOOKBACK_DAYS);
    const timelineDates = getRecentAvailableDates(state.baseDate, DASH_TIMELINE_DAYS);
    console.log(
        `📊 Dashboard data: timeline ${timelineDates.length}d (${timelineDates[0]}…${timelineDates[timelineDates.length - 1]}), ` +
        `stats ${statsDates.length}d`
    );

    let batchItems = null;
    try {
        batchItems = await dataLoader.loadPixelBatch(
            state.lat, state.lng, state.region, statsDates
        );
    } catch (e) {
        console.warn('Pixel batch failed:', e);
    }

    if (batchItems && batchItems.length > 0) {
        const hasDynamic = batchItems.some(
            d => isPresentNumber(d.rainfall) || isPresentNumber(d.soilMoisture)
        );
        if (hasDynamic) {
            const byDate = Object.fromEntries(batchItems.map(d => [d.date, d]));
            state.timelineData = timelineDates.map(d => normalizePixelRow(byDate[d] ?? null, d));
            state.focusIndex = state.timelineData.length - 1;
            const statsFiltered = statsDates.map(d => byDate[d]).filter(Boolean);
            state.statisticsData = statsFiltered;
            if (statsFiltered.length) renderStatistics(statsFiltered);
            return;
        }
    }

    await fetchDashboardDataViaHistory(statsDates, timelineDates);
}

/** Fallback: single GET /api/pixel/history for the stats window (covers timeline subset). */
async function fetchDashboardDataViaHistory(statsDates, timelineDates) {
    const startDate = statsDates[0];
    const endDate = statsDates[statsDates.length - 1];
    let bulkData = null;
    try {
        bulkData = await dataLoader.loadPixelHistory(
            state.lat, state.lng, state.region, startDate, endDate
        );
    } catch (e) {
        console.warn('Pixel history failed:', e);
    }

    if (bulkData && bulkData.length > 0) {
        const hasDynamic = bulkData.some(
            d => isPresentNumber(d.rainfall) || isPresentNumber(d.soilMoisture)
        );
        if (hasDynamic) {
            const bulkMap = Object.fromEntries(bulkData.map(d => [d.date, d]));
            state.timelineData = timelineDates.map(d => normalizePixelRow(bulkMap[d] ?? null, d));
            state.focusIndex = state.timelineData.length - 1;
            const statsFiltered = statsDates.map(d => bulkMap[d]).filter(Boolean);
            state.statisticsData = statsFiltered;
            if (statsFiltered.length) renderStatistics(statsFiltered);
            return;
        }
    }

    const promises = timelineDates.map(d =>
        dataLoader.loadPixelData(state.lat, state.lng, d, state.region)
            .then(res => normalizePixelRow(res, d))
            .catch(() => normalizePixelRow(null, d))
    );
    state.timelineData = await Promise.all(promises);
    state.focusIndex = state.timelineData.length - 1;

    try {
        const data = await dataLoader.loadPixelHistory(
            state.lat, state.lng, state.region, startDate, endDate
        );
        if (data?.length) {
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

    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : UI_NO_DATA;
    const mode = arr => {
        if (!arr.length) return null;
        const freq = {};
        arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    };

    $('kpi-dem').textContent = avg(dems);
    $('kpi-slope').textContent = avg(slopes);
    $('kpi-flow').textContent = avg(flows);
    $('kpi-landcover').textContent = mode(lcs) != null ? lcLabel(mode(lcs)) : UI_NO_DATA;

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
            const m = mode(lcVals);
            $('kpi-landcover').textContent = m != null ? lcLabel(m) : UI_NO_DATA;
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
    const trendEl = $('kpi-rain-trend');
    if (row.rain == null || Number.isNaN(row.rain)) {
        $('kpi-rainfall').textContent = UI_NO_DATA;
        if (trendEl) trendEl.innerHTML = `<span class="text-[10px] text-slate-400">${UI_NO_DATA}</span>`;
    } else {
        $('kpi-rainfall').textContent = row.rain.toFixed(1);
        const prevRow = state.timelineData[idx - 1];
        if (prevRow && trendEl && prevRow.rain != null && !Number.isNaN(prevRow.rain)) {
            const diff = row.rain - prevRow.rain;
            const icon = diff > 0 ? 'trending_up' : diff < 0 ? 'trending_down' : 'trending_flat';
            const color = diff > 5 ? 'text-red-500' : diff < -5 ? 'text-emerald-500' : 'text-slate-400';
            trendEl.innerHTML = `<span class="material-symbols-outlined text-sm ${color}">${icon}</span>
                <span class="text-[10px] ${color} font-semibold">${diff > 0 ? '+' : ''}${diff.toFixed(1)} mm</span>
                <span class="text-[10px] text-slate-400">vs prev day</span>`;
        } else if (trendEl) {
            trendEl.innerHTML = `<span class="text-[10px] text-slate-400">${UI_NO_DATA}</span>`;
        }
    }

    // Soil
    if (row.soil == null || Number.isNaN(row.soil)) {
        $('kpi-soil').textContent = UI_NO_DATA;
        const bar = $('kpi-soil-bar');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#cbd5e1'; }
    } else {
        $('kpi-soil').textContent = row.soil.toFixed(1);
        $('kpi-soil-bar').style.width = Math.min(row.soil, 100) + '%';
        $('kpi-soil-bar').style.background = row.soil > 85 ? '#dc2626' : row.soil > 70 ? '#d97706' : '#059669';
    }


}



// ══════════════════════════════════════════════════════
//  RENDER: 10-DAY TIMELINE CHART
// ══════════════════════════════════════════════════════

function renderTimelineChart() {
    const ctx = $('chart-timeline');
    if (!ctx) return;

    const parent = ctx.parentElement;
    let nodataEl = $('chart-timeline-nodata');
    const labels = state.timelineData.map(d => shortDate(d.date));
    const rainData = state.timelineData.map(d => (d.rain == null || Number.isNaN(d.rain) ? null : Math.max(0, d.rain)));
    const soilData = state.timelineData.map(d => (d.soil == null || Number.isNaN(d.soil) ? null : Math.max(0, d.soil)));
    const hasAnySeries = rainData.some(v => v != null) || soilData.some(v => v != null);

    if (!hasAnySeries) {
        if (chartTimeline) { chartTimeline.destroy(); chartTimeline = null; }
        ctx.style.display = 'none';
        if (!nodataEl && parent) {
            nodataEl = document.createElement('p');
            nodataEl.id = 'chart-timeline-nodata';
            nodataEl.className = 'absolute inset-0 flex items-center justify-center text-sm font-mono text-slate-400';
            nodataEl.textContent = UI_NO_DATA;
            parent.style.position = 'relative';
            parent.appendChild(nodataEl);
        } else if (nodataEl) nodataEl.style.display = 'flex';
        return;
    }
    ctx.style.display = 'block';
    if (nodataEl) nodataEl.style.display = 'none';

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
                        },
                        label: ctx => {
                            const row = state.timelineData[ctx.dataIndex];
                            if (ctx.dataset.yAxisID === 'y') {
                                const v = row?.rain;
                                return `Rainfall (mm): ${v == null ? UI_NO_DATA : Number(v).toFixed(1)}`;
                            }
                            const v = row?.soil;
                            return `Soil Moisture (%): ${v == null ? UI_NO_DATA : Number(v).toFixed(1)}`;
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
        const activeClass = isActive
            ? 'bg-blue-50/60 ring-2 ring-gov-500/20 ring-inset'
            : 'hover:bg-slate-50';

        const rainCell = row.rain == null || Number.isNaN(row.rain) ? UI_NO_DATA : row.rain.toFixed(1);
        const soilCell = row.soil == null || Number.isNaN(row.soil) ? UI_NO_DATA : row.soil.toFixed(1);
        const riskCell = row.risk != null && String(row.risk).trim() !== '' ? row.risk : UI_NO_DATA;
        const rcRow = riskColor(row.risk);
        return `
        <tr class="cursor-pointer transition-colors ${activeClass}" onclick="onTableRowClick(${idx})" data-row-idx="${idx}">
            <td class="px-6 py-3.5 font-mono text-xs ${isActive ? 'text-gov-500 font-bold' : 'text-slate-700'}">
                ${row.date}
            </td>
            <td class="px-4 py-3.5 text-right data-mono text-xs ${rainHmClass(row.rain)}">${rainCell}</td>
            <td class="px-4 py-3.5 text-right data-mono text-xs ${soilHmClass(row.soil)}">${soilCell}</td>
            <td class="px-4 py-3.5 text-center">
                <span class="text-[10px] font-semibold text-slate-400">OBSERVED</span>
            </td>
            <td class="px-4 py-3.5 text-center">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${rcRow.bg} ${rcRow.text}">${riskCell}</span>
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
    const rains = histData.map(d => d.rainfall ?? d.totalRainfall).filter(v => isPresentNumber(v));
    const soils = histData.map(d => d.soilMoisture ?? d.avgSoilMoisture).filter(v => isPresentNumber(v));

    const daysWithRain = rains.filter(r => r > 0);
    const avgRain = daysWithRain.length ? daysWithRain.reduce((a, b) => a + b, 0) / daysWithRain.length : null;
    const maxRain = rains.length ? Math.max(...rains) : null;
    const totalRain = rains.length ? rains.reduce((a, b) => a + b, 0) : null;
    const avgSoil = soils.length ? soils.reduce((a, b) => a + b, 0) / soils.length : null;
    const maxSoil = soils.length ? Math.max(...soils) : null;
    const heavyDays = rains.filter(r => r > 20).length;

    const firstDate = histData[0]?.date || UI_NO_DATA;
    const lastDate = histData[histData.length - 1]?.date || UI_NO_DATA;

    const fmtMm = v => (v == null ? UI_NO_DATA : Number(v).toFixed(1) + ' mm');
    const fmtSoilPct = v => (v == null ? UI_NO_DATA : (Number(v) * 100).toFixed(1) + '%');

    $('stat-avg-rain').textContent = fmtMm(avgRain);
    $('stat-max-rain').textContent = fmtMm(maxRain);
    $('stat-total-rain').textContent = fmtMm(totalRain);
    $('stat-avg-soil').textContent = fmtSoilPct(avgSoil);
    $('stat-max-soil').textContent = fmtSoilPct(maxSoil);
    $('stat-heavy-days').textContent = rains.length ? heavyDays + ' days' : UI_NO_DATA;
    $('stat-period').textContent = `${firstDate} → ${lastDate}`;
    $('stats-region-label').textContent = `${state.region} — ${histData.length} days analyzed`;
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
            [
                d.date,
                d.rain != null ? d.rain.toFixed(1) : UI_NO_DATA,
                d.soil != null ? d.soil.toFixed(1) : UI_NO_DATA,
                d.risk != null ? d.risk : UI_NO_DATA,
                d.isForecast ? 'Forecast' : 'Observed'
            ].join(',')
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
