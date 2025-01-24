import { parse, isValid, isSameDay } from 'date-fns';

interface EventLocation {
  city: string;
  state: string;
  country: string;
}

/**
 * Normalizes a date string to YYYY-MM-DD HH:mm:ss format in local time
 */
export function normalizeDateTime(dateStr: string, location?: EventLocation): string {
  try {
    // If already in ISO format, treat as local time
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}/)) {
      // Replace T with space and remove any timezone indicators
      const localDateStr = dateStr.replace('T', ' ').replace(/[Z+-]\d{2}:?\d{2}$/, '');
      const [datePart, timePart] = localDateStr.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      
      // Create date using local components
      const date = new Date(year, month - 1, day, hours, minutes);
      return formatDateTime(date);
    }

    // Parse various date formats
    const date = parseDateString(dateStr);
    if (!date) return '';

    return formatDateTime(date);
  } catch (error) {
    console.error('Error normalizing date:', error);
    return '';
  }
}

/**
 * Formats a Date object to YYYY-MM-DD HH:mm:ss in local time
 */
export function formatDateTime(date: Date): string {
  // Create a new date object that preserves the local time components
  const localDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0
  );

  return localDate.getFullYear() + '-' +
    String(localDate.getMonth() + 1).padStart(2, '0') + '-' +
    String(localDate.getDate()).padStart(2, '0') + ' ' +
    String(localDate.getHours()).padStart(2, '0') + ':' +
    String(localDate.getMinutes()).padStart(2, '0') + ':00';
}

/**
 * Parses various date string formats into a Date object, preserving local time
 */
function parseDateString(dateStr: string): Date | null {
  const cleanDateStr = dateStr.trim();

  // Try common date formats
  const formats = [
    // Full datetime formats
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd\'T\'HH:mm:ss.SSSX',
    'yyyy-MM-dd\'T\'HH:mm:ssX',
    
    // Date only formats
    'yyyy-MM-dd',
    'MM/dd/yyyy',
    'MMM d, yyyy',
    
    // Special formats
    'EEE, MMM d, h:mm a', // "Fri, Jan 17, 7:00 PM"
    'EEE, MMM d',         // "Fri, Jan 17"
  ];

  for (const format of formats) {
    const parsed = parse(cleanDateStr, format, new Date());
    if (isValid(parsed)) {
      // Create a new date that preserves the local time components
      return new Date(
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate(),
        parsed.getHours(),
        parsed.getMinutes(),
        0
      );
    }
  }

  // Handle special cases like "Today, 7:00 PM"
  if (cleanDateStr.toLowerCase().includes('today')) {
    const timeMatch = cleanDateStr.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
    if (timeMatch) {
      const [_, hours, minutes = '0', meridiem] = timeMatch;
      const hour24 = parseInt(hours) + (meridiem.toLowerCase() === 'pm' && hours !== '12' ? 12 : 0);
      const now = new Date();
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hour24,
        parseInt(minutes),
        0
      );
    }
    return new Date();
  }

  // Handle "Tomorrow, 7:00 PM"
  if (cleanDateStr.toLowerCase().includes('tomorrow')) {
    const timeMatch = cleanDateStr.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
    const now = new Date();
    const tomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    );
    if (timeMatch) {
      const [_, hours, minutes = '0', meridiem] = timeMatch;
      const hour24 = parseInt(hours) + (meridiem.toLowerCase() === 'pm' && hours !== '12' ? 12 : 0);
      tomorrow.setHours(hour24, parseInt(minutes), 0);
    }
    return tomorrow;
  }

  // Try to extract date components
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const monthMatch = cleanDateStr.match(new RegExp(`(${monthNames.join('|')})[a-z]*\\s+(\\d{1,2})(?:,?\\s*(\\d{4})?)?`, 'i'));
  
  if (monthMatch) {
    const [_, month, day, year] = monthMatch;
    const monthIndex = monthNames.indexOf(month.toLowerCase().substring(0, 3));
    const now = new Date();
    
    if (monthIndex !== -1) {
      let eventYear = year ? parseInt(year) : now.getFullYear();
      const eventDate = new Date(eventYear, monthIndex, parseInt(day));
      
      // If no year specified and date is in past, assume next year
      if (!year && eventDate < now) {
        eventYear++;
        eventDate.setFullYear(eventYear);
      }
      
      // Try to extract time if present
      const timeMatch = cleanDateStr.match(/(\d+)(?::(\d+))?\s*(?:–[^AP]*)?([AP]M)/i);
      if (timeMatch) {
        const [__, hours, minutes = '0', meridiem] = timeMatch;
        const hour24 = parseInt(hours) + (meridiem.toLowerCase() === 'pm' && hours !== '12' ? 12 : 0);
        eventDate.setHours(hour24, parseInt(minutes), 0);
      } else {
        eventDate.setHours(0, 0, 0);
      }
      
      return eventDate;
    }
  }

  return null;
}

/**
 * Compares two dates for event matching, using local time
 */
export function areDatesMatching(date1: string | Date, date2: string | Date): boolean {
  const d1 = typeof date1 === 'string' ? new Date(date1.replace(' ', 'T')) : date1;
  const d2 = typeof date2 === 'string' ? new Date(date2.replace(' ', 'T')) : date2;

  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

/**
 * Checks if dates match including time for multiple events, using local time
 */
export function doDateTimesMatch(date1: string | Date, date2: string | Date): boolean {
  const d1 = typeof date1 === 'string' ? new Date(date1.replace(' ', 'T')) : date1;
  const d2 = typeof date2 === 'string' ? new Date(date2.replace(' ', 'T')) : date2;

  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate() &&
         d1.getHours() === d2.getHours() &&
         d1.getMinutes() === d2.getMinutes();
}

/**
 * Checks if a date string is valid
 */
export function isValidDate(dateStr: string): boolean {
  const date = new Date(dateStr.replace(' ', 'T'));
  return !isNaN(date.getTime());
} 