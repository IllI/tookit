interface EventProps {
  event: {
    id: string;
    name: string;
    date: string;
    venue: string;
    location: string;
    price?: string;
    source: string;
  };
}

export function EventCard({ event }: EventProps) {
  return (
    <div className="event-card">
      <h3>{event.name}</h3>
      <p className="date">{event.date}</p>
      <p className="venue">{event.venue}</p>
      <p className="location">{event.location}</p>
      <p className="price">
        {event.price ? `Starting at ${event.price}` : 'Check website for prices'}
      </p>
      <p className="source">via {event.source}</p>
    </div>
  );
} 