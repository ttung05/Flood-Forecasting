/**
 * eda.js - Exploratory Data Analysis Dashboard Logic
 * Fetches multi-day pixel history and renders Chart.js charts.
 */

// Global Chart Instances
let rainChartInstance = null;
let soilChartInstance = null;

const API_BASE_URL = window.API_BASE_URL || '';

// DOM Elements
const form = document.getElementById('filter-form');
const inpStart = document.getElementById('start-date');
const inpEnd = document.getElementById('end-date');
const loadingIndicator = document.getElementById('loadingIndicator');
const dataContent = document.getElementById('dataContent');
const errorContainer = document.getElementById('errorContainer');
const errorMessage = document.getElementById('errorMessage');

const uiRegion = document.getElementById('ui-region');

const valDem = document.getElementById('val-dem');
const valSlope = document.getElementById('val-slope');
const valFlow = document.getElementById('val-flow');
const valLc = document.getElementById('val-lc');

function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        region: params.get('region') || 'DaNang'
    };
}

async function initDates(region) {
    try {
        const url = `${API_BASE_URL}/api/dates/${region}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.success && data.data && data.data.dateRange) {
            const endDateStr = data.data.dateRange.end;
            const today = new Date(endDateStr);
            const past = new Date(today);
            past.setDate(today.getDate() - 30);

            inpEnd.value = endDateStr;
            inpStart.value = past.toISOString().split('T')[0];
            return;
        }
    } catch (e) {
        console.warn('Failed to fetch date range, using fallback', e);
    }

    // Default Fallback
    const today = new Date();
    const past = new Date(today);
    past.setDate(today.getDate() - 30);

    inpEnd.value = today.toISOString().split('T')[0];
    inpStart.value = past.toISOString().split('T')[0];
}

function showError(msg) {
    errorContainer.classList.remove('hidden');
    errorMessage.textContent = msg;
    dataContent.classList.add('hidden');
    loadingIndicator.classList.add('hidden');
}

function hideError() {
    errorContainer.classList.add('hidden');
}

async function fetchAndRenderData(region, startDate, endDate) {
    hideError();
    dataContent.classList.add('hidden');
    loadingIndicator.classList.remove('hidden');

    try {
        const url = `${API_BASE_URL}/api/forecast/${region}/history?startDate=${startDate}&endDate=${endDate}`;
        const response = await fetch(url);
        const envelope = await response.json();

        if (!envelope.success) throw new Error(envelope.error?.message || 'Failed to fetch history API');

        const historyData = envelope.data;

        if (!historyData || historyData.length === 0) {
            throw new Error(`No data available for the selected dates ${startDate} to ${endDate}.`);
        }

        renderStaticValues(historyData[0]);
        renderCharts(historyData);

        loadingIndicator.classList.add('hidden');
        dataContent.classList.remove('hidden');
        dataContent.classList.add('flex'); // Because it's a flex-col gap-8

    } catch (e) {
        console.error(e);
        showError(e.message);
    }
}

function renderStaticValues(firstDay) {
    valDem.textContent = firstDay.avgDem !== null ? firstDay.avgDem : 'N/A';
    valSlope.textContent = firstDay.avgSlope !== null ? firstDay.avgSlope : 'N/A';
    valFlow.textContent = firstDay.avgFlow !== null ? firstDay.avgFlow : 'N/A';
    valLc.textContent = firstDay.avgLandCover !== null ? firstDay.avgLandCover : 'N/A';
}

function renderCharts(historyData) {
    const labels = historyData.map(d => {
        const parts = d.date.split('-');
        return `${parts[2]}/${parts[1]}`;
    });

    const rainData = historyData.map(d => d.totalRainfall || 0);
    const soilData = historyData.map(d => d.avgSoilMoisture || 0);

    // RAINFALL CHART
    const ctxRain = document.getElementById('rainChart').getContext('2d');
    if (rainChartInstance) rainChartInstance.destroy();
    rainChartInstance = new Chart(ctxRain, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Rainfall (mm)',
                data: rainData,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                pointBackgroundColor: '#2563eb',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => `Rainfall: ${ctx.raw} mm` } }
            },
            scales: {
                y: { beginAtZero: true },
                x: { grid: { display: false } }
            }
        }
    });

    // SOIL MOISTURE CHART
    const ctxSoil = document.getElementById('soilChart').getContext('2d');
    if (soilChartInstance) soilChartInstance.destroy();
    soilChartInstance = new Chart(ctxSoil, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Soil Moisture',
                data: soilData,
                borderColor: '#b45309',
                backgroundColor: 'rgba(180, 83, 9, 0.1)',
                borderWidth: 2,
                pointBackgroundColor: '#92400e',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => `Soil: ${ctx.raw}` } }
            },
            scales: {
                y: { beginAtZero: true },
                x: { grid: { display: false } }
            }
        }
    });
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    const { region } = getUrlParams();

    if (!region) {
        showError('Invalid Region parameter in URL.');
        return;
    }

    uiRegion.textContent = region;

    await initDates(region);

    // Initial Fetch
    fetchAndRenderData(region, inpStart.value, inpEnd.value);

    // Form submission
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        fetchAndRenderData(region, inpStart.value, inpEnd.value);
    });
});
