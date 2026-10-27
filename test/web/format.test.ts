import { describe, expect, it } from 'vitest';
import { formatHHMM, formatMiles, mapsHref, telHref } from '../../src/web/format.js';

describe('format', () => {
  it('telHref strips formatting', () => {
    expect(telHref('+1 801-555-0100')).toBe('tel:+18015550100');
    expect(telHref('(801) 555-0100')).toBe('tel:8015550100');
  });

  it('mapsHref prefers coords', () => {
    expect(mapsHref({ lat: 40.5, lng: -111.9, address: '1 Main St' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=40.5,-111.9',
    );
    expect(mapsHref({ lat: null, lng: null, address: '1 Main St, SLC' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=1%20Main%20St%2C%20SLC',
    );
    expect(mapsHref({ lat: null, lng: null, address: null })).toBe('#');
  });

  it('formatHHMM', () => {
    expect(formatHHMM('1700')).toBe('5:00 PM');
    expect(formatHHMM('0830')).toBe('8:30 AM');
    expect(formatHHMM('1200')).toBe('12:00 PM');
    expect(formatHHMM('0000')).toBe('12:00 AM');
    expect(formatHHMM('2400')).toBe('midnight');
  });

  it('formatMiles', () => {
    expect(formatMiles(1.234)).toBe('1.2 mi');
    expect(formatMiles(null)).toBeNull();
  });
});
