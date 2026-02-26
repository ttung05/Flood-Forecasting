/**
 * Pixel History Service — Fetches data for a specific pixel across a date range.
 *
 * Uses pixelService.getPixel() for each date (reads stacked COG / legacy TIF)
 * instead of gridService (which requires pre-built grid JSON that may not exist).
 */
import type { Result } from '../../shared/types/result';
import type { AppError } from '../../shared/types/result';
import { Ok, Err, AppErrors } from '../../shared/types/result';
import * as metadataService from '../metadata/metadata.service';
import * as pixelService from './pixel.service';
import { structuredLog } from '../../shared/middleware/tracing';
import { REGION_BOUNDS, Region } from '../../shared/types/common';

export interface DailyPixelData {
    date: string;
    rainfall: number | null;
    soilMoisture: number | null;
    tide: number | null;
    flood: number | null;
    floodRisk: string;
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

    // Fetch full pixel data for each date using pixelService
    // This reads from stacked COG / legacy TIF which has actual data
    const CONCURRENCY = 5;
    const results: DailyPixelData[] = [];

    for (let i = 0; i < rangeDates.length; i += CONCURRENCY) {
        const batch = rangeDates.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (dateStr) => {
                const pixelResult = await pixelService.getPixel({
                    region: region as any,
                    date: dateStr,
                    lat,
                    lng,
                });

                if (pixelResult.ok) {
                    return {
                        date: dateStr,
                        rainfall: pixelResult.value.rainfall,
                        soilMoisture: pixelResult.value.soilMoisture,
                        tide: pixelResult.value.tide,
                        flood: pixelResult.value.flood,
                        floodRisk: pixelResult.value.floodRisk,
                        dem: pixelResult.value.dem,
                        slope: pixelResult.value.slope,
                        flow: pixelResult.value.flow,
                        landCover: pixelResult.value.landCover,
                    };
                }

                // If pixel read fails for this date, return nulls
                return {
                    date: dateStr,
                    rainfall: null,
                    soilMoisture: null,
                    tide: null,
                    flood: null,
                    floodRisk: 'LOW',
                    dem: null,
                    slope: null,
                    flow: null,
                    landCover: null,
                };
            })
        );
        results.push(...batchResults);
    }

    results.sort((a, b) => a.date.localeCompare(b.date));

    structuredLog('info', 'pixel_history', { region, lat, lng, days: results.length, durationMs: Date.now() - t0 });

    return Ok(results);
}
