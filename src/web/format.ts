export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${digits}`;
}

export function mapsHref(l: { lat: number | null; lng: number | null; address: string | null }): string {
  if (l.lat !== null && l.lng !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`;
  }
  if (l.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}`;
  }
  return '#';
}

export function formatHHMM(hhmm: string): string {
  if (hhmm === '2400') return 'midnight';
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(2, 4);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

export function formatMiles(d: number | null): string | null {
  return d === null ? null : `${d.toFixed(1)} mi`;
}
