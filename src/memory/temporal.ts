import type { TemporalResolution } from '../types/index.js';

const DAYS_OF_WEEK: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

export interface TemporalExtractionResult {
  temporal?: TemporalResolution;
  cleanedText: string;
  extractedKeywords: string[];
}

/**
 * Calculates the UTC offset in minutes for a specific Date in a given IANA timezone
 */
export function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const p: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== 'literal') {
        p[part.type] = parseInt(part.value, 10);
      }
    }
    const hour = p.hour === 24 ? 0 : p.hour;
    const localAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
    return Math.round((localAsUtcMs - date.getTime()) / 60000);
  } catch {
    return 0; // Fallback to UTC if timezone is invalid
  }
}

/**
 * Extracts calendar date components for a Date in a target timezone
 */
export function getZonedDateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; dayOfWeek: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    });
    const parts = formatter.formatToParts(date);
    const p: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== 'literal') {
        p[part.type] = part.value;
      }
    }
    const year = parseInt(p.year, 10);
    const month = parseInt(p.month, 10) - 1;
    const day = parseInt(p.day, 10);
    const weekdayName = (p.weekday || '').toLowerCase();
    const dayOfWeek = DAYS_OF_WEEK[weekdayName] ?? new Date(Date.UTC(year, month, day)).getUTCDay();

    return { year, month, day, dayOfWeek };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      dayOfWeek: date.getUTCDay(),
    };
  }
}

/**
 * Format local date components into ISO start/end of day UTC, respecting the IANA timezone offset
 */
export function createDayBoundaries(
  year: number,
  month: number,
  day: number,
  timeZone: string = 'UTC'
): { startDate: string; endDate: string } {
  // Estimate target date at midday UTC
  const approxDate = new Date(Date.UTC(year, month, day, 12, 0, 0));
  const offsetMinutes = getTimezoneOffsetMinutes(approxDate, timeZone);

  // Construct start and end of day in local time, converted to UTC
  const startUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0) - offsetMinutes * 60000;
  const endUtcMs = Date.UTC(year, month, day, 23, 59, 59, 999) - offsetMinutes * 60000;

  return {
    startDate: new Date(startUtcMs).toISOString(),
    endDate: new Date(endUtcMs).toISOString(),
  };
}

/**
 * Resolves temporal expressions from a user prompt against an anchor date and timezone.
 */
export function resolveTemporalExpression(
  text: string,
  referenceDate: Date = new Date(),
  timezone: string = process.env.TIMEZONE || 'Asia/Kolkata'
): TemporalExtractionResult {
  const lower = text.toLowerCase();

  // Extract reference date components in the specified timezone
  const { year: anchorYear, month: anchorMonth, day: anchorDay, dayOfWeek: anchorDayOfWeek } =
    getZonedDateParts(referenceDate, timezone);

  let temporal: TemporalResolution | undefined;
  let matchedExpression = '';

  // 1. Exact ISO date: YYYY-MM-DD
  const isoMatch = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    matchedExpression = isoMatch[0];
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    const bounds = createDayBoundaries(y, m, d, timezone);
    temporal = {
      expression: matchedExpression,
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      isRange: false,
      confidence: 1.0,
      referenceTimestamp: referenceDate.toISOString(),
      timezone,
    };
  }

  // 2. Exact Day Month: "3 November", "3rd Nov", "November 3", "Nov 3rd"
  if (!temporal) {
    const dayMonthRegex =
      /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i;
    const monthDayRegex =
      /\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i;

    const dm = lower.match(dayMonthRegex);
    const md = lower.match(monthDayRegex);

    if (dm) {
      matchedExpression = dm[0];
      const d = parseInt(dm[1], 10);
      const m = MONTHS[dm[2].toLowerCase()];
      const y = dm[3] ? parseInt(dm[3], 10) : anchorYear;
      const bounds = createDayBoundaries(y, m, d, timezone);
      temporal = {
        expression: matchedExpression,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        isRange: false,
        confidence: 0.95,
        referenceTimestamp: referenceDate.toISOString(),
        timezone,
      };
    } else if (md) {
      matchedExpression = md[0];
      const m = MONTHS[md[1].toLowerCase()];
      const d = parseInt(md[2], 10);
      const y = md[3] ? parseInt(md[3], 10) : anchorYear;
      const bounds = createDayBoundaries(y, m, d, timezone);
      temporal = {
        expression: matchedExpression,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        isRange: false,
        confidence: 0.95,
        referenceTimestamp: referenceDate.toISOString(),
        timezone,
      };
    }
  }

  // 3. Relative Day of Week: "on Monday", "last Tuesday", "this Monday"
  if (!temporal) {
    const dayOfWeekRegex =
      /\b(?:(last|this|past|previous|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    const dowMatch = lower.match(dayOfWeekRegex);

    if (dowMatch) {
      matchedExpression = dowMatch[0];
      const modifier = (dowMatch[1] || '').toLowerCase();
      const targetDow = DAYS_OF_WEEK[dowMatch[2].toLowerCase()];

      let dayDifference = (anchorDayOfWeek - targetDow + 7) % 7;
      if (dayDifference === 0) {
        dayDifference = modifier === 'last' || modifier === 'past' ? 7 : 0;
      } else if (modifier === 'last' || modifier === 'past' || modifier === 'previous') {
        if (anchorDayOfWeek <= targetDow) {
          dayDifference = anchorDayOfWeek + 7 - targetDow;
        } else {
          dayDifference = anchorDayOfWeek - targetDow;
        }
      }

      // Compute target local calendar date
      const anchorLocalMidday = new Date(Date.UTC(anchorYear, anchorMonth, anchorDay, 12, 0, 0));
      const targetLocalMidday = new Date(anchorLocalMidday.getTime() - dayDifference * 86400000);

      const bounds = createDayBoundaries(
        targetLocalMidday.getUTCFullYear(),
        targetLocalMidday.getUTCMonth(),
        targetLocalMidday.getUTCDate(),
        timezone
      );

      temporal = {
        expression: matchedExpression,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        isRange: false,
        confidence: 0.9,
        referenceTimestamp: referenceDate.toISOString(),
        timezone,
      };
    }
  }

  // 4. "today", "yesterday", "X days ago"
  if (!temporal) {
    if (/\byesterday\b/i.test(lower)) {
      matchedExpression = 'yesterday';
      const anchorLocalMidday = new Date(Date.UTC(anchorYear, anchorMonth, anchorDay, 12, 0, 0));
      const targetLocalMidday = new Date(anchorLocalMidday.getTime() - 86400000);
      const bounds = createDayBoundaries(
        targetLocalMidday.getUTCFullYear(),
        targetLocalMidday.getUTCMonth(),
        targetLocalMidday.getUTCDate(),
        timezone
      );
      temporal = {
        expression: 'yesterday',
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        isRange: false,
        confidence: 1.0,
        referenceTimestamp: referenceDate.toISOString(),
        timezone,
      };
    } else if (/\btoday\b/i.test(lower)) {
      matchedExpression = 'today';
      const bounds = createDayBoundaries(anchorYear, anchorMonth, anchorDay, timezone);
      temporal = {
        expression: 'today',
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        isRange: false,
        confidence: 1.0,
        referenceTimestamp: referenceDate.toISOString(),
        timezone,
      };
    } else {
      const daysAgoMatch = lower.match(/\b(\d+)\s+days?\s+ago\b/i);
      if (daysAgoMatch) {
        matchedExpression = daysAgoMatch[0];
        const count = parseInt(daysAgoMatch[1], 10);
        const anchorLocalMidday = new Date(Date.UTC(anchorYear, anchorMonth, anchorDay, 12, 0, 0));
        const targetLocalMidday = new Date(anchorLocalMidday.getTime() - count * 86400000);
        const bounds = createDayBoundaries(
          targetLocalMidday.getUTCFullYear(),
          targetLocalMidday.getUTCMonth(),
          targetLocalMidday.getUTCDate(),
          timezone
        );
        temporal = {
          expression: matchedExpression,
          startDate: bounds.startDate,
          endDate: bounds.endDate,
          isRange: false,
          confidence: 0.95,
          referenceTimestamp: referenceDate.toISOString(),
          timezone,
        };
      }
    }
  }

  // Extract cleaned text by removing temporal expressions
  let cleanedText = text;
  if (matchedExpression) {
    cleanedText = text.replace(new RegExp(`\\b${escapeRegex(matchedExpression)}\\b`, 'i'), '').trim();
  }

  // Extract keywords for topic search
  const extractedKeywords = extractKeywords(cleanedText);

  return {
    temporal,
    cleanedText,
    extractedKeywords,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'on', 'in', 'at', 'by', 'for', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'ask', 'asked', 'tell',
  'told', 'did', 'still', 'correct', 'today', 'changed', 'any', 'since', 'then', 'pricing'
]);

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}
