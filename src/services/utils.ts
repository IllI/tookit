export function parseLocation(locationStr: string) {
  if (!locationStr) return { city: 'Unknown', state: '', country: 'USA' };

  const parts = locationStr.split(',').map(part => part.trim());
  
  // Format: "Chicago, IL"
  if (parts.length === 2 && parts[1].length === 2) {
    return {
      city: parts[0],
      state: parts[1],
      country: parts[1] === 'ON' ? 'CAN' : 'USA'
    };
  }
  
  // Format: "Toronto, ON, Canada"
  if (parts.length === 3) {
    return {
      city: parts[0],
      state: parts[1],
      country: parts[2].toLowerCase().includes('canada') ? 'CAN' : parts[2]
    };
  }
  
  // Default case
  return {
    city: parts[0] || 'Unknown',
    state: '',
    country: 'USA'
  };
}