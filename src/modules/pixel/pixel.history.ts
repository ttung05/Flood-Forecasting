/**
 * Pixel History Service — Fetches data for a specific pixel across a date range.
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import * as metadataService from '../metadata/metadata.service';
import * as gridService from '../grid/grid.service';
import * as pixelService from './pixel.service';
import { structuredLog } from '../../shared/middleware/tracing';
import { REGION_BOUNDS, Region } from '../../shared/types/common';

export interface DailyPixelData {
    date: string;
    rainfall: number | null;
    soilMoisture: number | null;
    dem: number | null;
    slope: number | null;
    flow: number | null;
    landCover: number | null;
}

export async function getPixelHistory(region: string, lat: number, lng: number, startDateStr: string, endDateStr: string): Promise<Result<DailyPixelData[], AppError>> {
    const t0 = Date.now();
    const bounds = REGION_BOUNDS[region];
    if (!bounds) {
        return Err(AppErrors.validation(`Unknown region: ${region}`));
    }

    if (lat > bounds.north || lat < bounds.south || lng < bounds.west || lng > bounds.east) {
        return Err(AppErrors.validation(`Coordinates ${lat}, ${lng} are outside region boundary`));
    }

    const cellHeight = (bounds.north - bounds.south) / bounds.rows;
    const cellWidth = (bounds.east - bounds.west) / bounds.cols;
    const r = Math.floor((bounds.north - lat) / cellHeight);
    const c = Math.floor((lng - bounds.west) / cellWidth);

    if (r < 0 || r >= bounds.rows || c < 0 || c >= bounds.cols) {
        return Err(AppErrors.validation(`Calculated grid indices out of bounds`));
    }

    const flatIdx = r * bounds.cols + c;

    // Get all available dates
    const timelineResult = await metadataService.getDates(region);
    if (!timelineResult.ok) {
        return Err(timelineResult.error);
    }

    // Flatten and filter dates
    const availableDates: string[] = [];
    const nested = timelineResult.value.availableDates;
    for (const year of Object.keys(nested).sort()) {
        const months = nested[year];
        if (!months) continue;
        for (const month of Object.keys(months).sort()) {
            const days = months[month]?.sort((a: number, b: number) => a - b) || [];
            for (const day of days) {
                availableDates.push(`${year}-${month.padStart(2, '0')}-${String(day).padStart(2, '0')}`);
            }
        }
    }

    const rangeDates = availableDates.filter(d => d >= startDateStr && d <= endDateStr);

    if (rangeDates.length === 0) {
        return Ok([]);
    }

    // Static variables
    let dem: number | null = null;
    let slope: number | null = null;
    let flow: number | null = null;
    let landCover: number | null = null;

    // Fetch static grids once using pixelService for the specific coordinate
    if (rangeDates.length > 0) {
        // Date param doesn't matter for static layers, we just pass the first available date
        const firstPixelRes = await pixelService.getPixel({ region: region as any, date: rangeDates[0] as string, lat, lng });
        if (firstPixelRes.ok) {
            dem = firstPixelRes.value.dem;
            slope = firstPixelRes.value.slope;
            flow = firstPixelRes.value.flow;
            landCover = firstPixelRes.value.landCover;
        }
    }

    // Fetch dynamic data for all dates
    const fetchPromises = rangeDates.map(async (dateStr) => {
        let rainfall: number | null = null;
        let soilMoisture: number | null = null;

        const [rainResult, smResult] = await Promise.all([
            gridService.getGrid({ region: region as any, date: dateStr, layer: 'rain' }),
            gridService.getGrid({ region: region as any, date: dateStr, layer: 'soilMoisture' })
        ]);

        if (rainResult.ok && rainResult.value && rainResult.value.data) {
            rainfall = rainResult.value.data[flatIdx] ?? null;
            if (rainfall === rainResult.value.nodata) rainfall = null;
            else if (rainResult.value.scale && rainfall !== null) rainfall = rainfall * rainResult.value.scale;
        }

        if (smResult.ok && smResult.value && smResult.value.data) {
            soilMoisture = smResult.value.data[flatIdx] ?? null;
            if (soilMoisture === smResult.value.nodata) soilMoisture = null;
            else if (smResult.value.scale && soilMoisture !== null) soilMoisture = soilMoisture * smResult.value.scale;
        }

        return {
            date: dateStr,
            rainfall,
            soilMoisture,
            dem,
            slope,
            flow,
            landCover
        };
    });

    const results = await Promise.all(fetchPromises);
    results.sort((a, b) => a.date.localeCompare(b.date));

    structuredLog('info', 'pixel_history', { region, lat, lng, days: results.length, durationMs: Date.now() - t0 });

    return Ok(results);
}
