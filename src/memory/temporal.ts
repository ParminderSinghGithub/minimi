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
 * Format local date components into ISO start/end of day UTC
 */
function createDayBoundaries(
  year: number,
  month: number,
  day: number,
  timezoneOffsetHours: number = 0
): { startDate: string; endDate: string } {
  // Construct day range in target timezone offset
  const startUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0) - timezoneOffsetHours * 3600000;
  const endUtcMs = Date.UTC(year, month, day, 23, 59, 59, 999) - timezoneOffsetHours * 3600000;

  return {
    startDate: new Date(startUtcMs).toISOString(),
    endDate: new Date(endUtcMs).toISOString(),
  };
}

/**
 * Resolves temporal expressions from a user prompt against an anchor date.
 */
export function resolveTemporalExpression(
  text: string,
  referenceDate: Date = new Date(),
  timezone: string = process.env.TIMEZONE || 'Asia/Kolkata'
): TemporalExtractionResult {
  const lower = text.toLowerCase();
  const anchorYear = referenceDate.getFullYear();
  const anchorMonth = referenceDate.getMonth();
  const anchorDay = referenceDate.getDate();
  const anchorDayOfWeek = referenceDate.getDay();

  let temporal: TemporalResolution | undefined;
  let matchedExpression = '';

  // 1. Exact ISO date: YYYY-MM-DD
  const isoMatch = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    matchedExpression = isoMatch[0];
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    const bounds = createDayBoundaries(y, m, d);
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
    const dayMonthRegex = /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i;
    const monthDayRegex = /\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i;

    const dm = lower.match(dayMonthRegex);
    const md = lower.match(monthDayRegex);

    if (dm) {
      matchedExpression = dm[0];
      const d = parseInt(dm[1], 10);
      const m = MONTHS[dm[2].toLowerCase()];
      const y = dm[3] ? parseInt(dm[3], 10) : anchorYear;
      const bounds = createDayBoundaries(y, m, d);
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
      const bounds = createDayBoundaries(y, m, d);
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
    const dayOfWeekRegex = /\b(?:(last|this|past|previous|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    const dowMatch = lower.match(dayOfWeekRegex);

    if (dowMatch) {
      matchedExpression = dowMatch[0];
      const modifier = (dowMatch[1] || '').toLowerCase();
      const targetDow = DAYS_OF_WEEK[dowMatch[2].toLowerCase()];

      let dayDifference = (anchorDayOfWeek - targetDow + 7) % 7;
      if (dayDifference === 0) {
        dayDifference = modifier === 'last' || modifier === 'past' ? 7 : 0;
      } else if (modifier === 'last' || modifier === 'past' || modifier === 'previous') {
        // "last Tuesday" when today is Wednesday (diff is 1) or Monday (diff is 6)
        if (anchorDayOfWeek <= targetDow) {
          dayDifference = anchorDayOfWeek + 7 - targetDow;
        } else {
          // If anchor is Wednesday (3) and target is Tuesday (2), "last Tuesday" can mean 1 day ago or previous week's Tuesday (8 days ago)
          // To be safe in conversational context: if user says "last Tuesday" on Wednesday, it commonly refers to the preceding Tuesday
          dayDifference = anchorDayOfWeek - targetDow;
        }
      }

      const targetDate = new Date(referenceDate.getTime() - dayDifference * 86400000);
      const bounds = createDayBoundaries(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        targetDate.getDate()
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
      const targetDate = new Date(referenceDate.getTime() - 86400000);
      const bounds = createDayBoundaries(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        targetDate.getDate()
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
      const bounds = createDayBoundaries(anchorYear, anchorMonth, anchorDay);
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
        const targetDate = new Date(referenceDate.getTime() - count * 86400000);
        const bounds = createDayBoundaries(
          targetDate.getFullYear(),
          targetDate.getMonth(),
          targetDate.getDate()
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

