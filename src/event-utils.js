import { parse, isSameDay } from 'date-fns';

// Function to normalize strings for comparison
export function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '');
}

// Function to get the base artist name (removing suffixes like "(18+ Event)")
export function getBaseArtistName(name) {
  if (!name) return '';
  return name.split(/[\(\[]/, 1)[0].trim();
}

// Function to score name similarity
export function getNameSimilarity(name1, name2) {
  if (!name1 || !name2) return 0;
  
  const norm1 = normalizeString(name1);
  const norm2 = normalizeString(name2);
  
  // Direct match
  if (norm1 === norm2) return 1;
  
  // One contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.8;
  
  // Calculate character overlap
  const chars1 = new Set(norm1);
  const chars2 = new Set(norm2);
  const intersection = new Set([...chars1].filter(x => chars2.has(x)));
  return intersection.size / Math.max(chars1.size, chars2.size);
}

// Function to parse date from different formats
function parseEventDate(dateStr) {
  if (!dateStr) return null;

  // Try VividSeats format first (e.g., "Jan 17 Fri 7:00pm")
  const vividSeatsRegex = /([A-Za-z]+)\s+(\d+)\s+[A-Za-z]+\s+(\d+:\d+[ap]m)/i;
  const vividMatch = dateStr.match(vividSeatsRegex);
  if (vividMatch) {
    const [_, month, day, time] = vividMatch;
    const year = '2025'; // Default to 2025 for future dates
    const standardDateStr = `${month} ${day} ${year} ${time}`;
    return parse(standardDateStr, 'MMM d yyyy h:mma', new Date());
  }

  // Try StubHub format (e.g., "Jan 17 2025 7:00 PM")
  const stubHubRegex = /([A-Za-z]+)\s+(\d+)\s+(\d{4}).*?(\d+:\d+\s*[AP]M)/i;
  const stubMatch = dateStr.match(stubHubRegex);
  if (stubMatch) {
    const [_, month, day, year, time] = stubMatch;
    const standardDateStr = `${month} ${day} ${year} ${time}`;
    return parse(standardDateStr, 'MMM d yyyy h:mm a', new Date());
  }

  // If no matches, try direct parsing
  try {
    return new Date(dateStr);
  } catch (e) {
    console.error('Failed to parse date:', dateStr);
    return null;
  }
}

// Function to find matching event
export async function findMatchingEvent(supabaseClient, eventDetails, source) {
  console.log('Searching for matching event:', {
    name: eventDetails.name || eventDetails.title,
    date: eventDetails.date,
    venue: eventDetails.venue,
    source
  });

  try {
    // First, try to find exact matches
    const { data: exactMatches, error: exactError } = await supabaseClient
      .from('events')
      .select(`
        id,
        name,
        date,
        venue,
        event_links (
          url,
          source
        )
      `)
      .ilike('name', getBaseArtistName(eventDetails.name || eventDetails.title))
      .gte('date', new Date().toISOString());

    if (exactError) {
      console.error('Error searching for exact matches:', exactError);
      return null;
    }

    // Parse the new event's date
    const newEventDate = parseEventDate(eventDetails.date);
    if (!newEventDate) {
      console.error('Could not parse event date:', eventDetails.date);
      return null;
    }

    console.log('Parsed new event date:', newEventDate);

    // First, try to find an exact match (same artist, same day, similar venue)
    const exactMatch = exactMatches?.find(existingEvent => {
      const existingDate = new Date(existingEvent.date);
      return isSameDay(existingDate, newEventDate) &&
             getNameSimilarity(existingEvent.venue, eventDetails.venue) > 0.6;
    });

    if (exactMatch) {
      console.log('Found exact match:', exactMatch.name);
      return {
        ...exactMatch,
        hasSourceLink: exactMatch.event_links.some(link => link.source === source)
      };
    }

    // If no exact match, look for similar events
    const matches = exactMatches
      .map(existingEvent => {
        const existingDate = new Date(existingEvent.date);
        
        const nameSimilarity = getNameSimilarity(
          getBaseArtistName(existingEvent.name),
          getBaseArtistName(eventDetails.name || eventDetails.title)
        );
        
        const venueSimilarity = getNameSimilarity(
          existingEvent.venue,
          eventDetails.venue
        );
        
        const dateMatch = isSameDay(existingDate, newEventDate);
        const dateDiffInDays = Math.abs(existingDate.getTime() - newEventDate.getTime()) / (1000 * 60 * 60 * 24);

        // Scoring system:
        // - Name similarity: 0-40 points
        // - Venue similarity: 0-30 points
        // - Date match: 30 points
        // - Date proximity penalty: -2 points per day difference (up to -20)
        const score = (nameSimilarity * 0.4) + 
                     (venueSimilarity * 0.3) + 
                     (dateMatch ? 0.3 : Math.max(-0.2, -0.02 * dateDiffInDays));

        console.log('Match details:', {
          existingName: existingEvent.name,
          newName: eventDetails.name || eventDetails.title,
          nameSimilarity,
          venueSimilarity,
          dateMatch,
          dateDiffInDays,
          score
        });

        return {
          event: existingEvent,
          score,
          hasSourceLink: existingEvent.event_links.some(link => link.source === source)
        };
      })
      .filter(match => match.score > 0.8) // Require a very high match score
      .sort((a, b) => b.score - a.score);

    if (matches.length > 0) {
      const bestMatch = matches[0];
      console.log(`Found matching event: "${bestMatch.event.name}" (score: ${bestMatch.score.toFixed(2)})`);
      
      // Choose the better name
      const existingName = bestMatch.event.name;
      const newName = eventDetails.name || eventDetails.title;
      
      // Prefer names without parentheses or special characters
      const shouldUpdateName = 
        (existingName.includes('(') && !newName.includes('(')) ||
        (existingName.includes('[') && !newName.includes('[')) ||
        (existingName.length > newName.length && newName.length > 3);
      
      if (shouldUpdateName) {
        console.log(`Updating event name from "${existingName}" to "${newName}"`);
        await supabaseClient
          .from('events')
          .update({ name: newName })
          .eq('id', bestMatch.event.id);
        
        bestMatch.event.name = newName;
      }

      return {
        ...bestMatch.event,
        hasSourceLink: bestMatch.hasSourceLink
      };
    }

    return null;
  } catch (error) {
    console.error('Error in findMatchingEvent:', error);
    return null;
  }
} 