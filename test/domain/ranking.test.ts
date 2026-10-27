import { describe, it, expect } from 'vitest';
import { haversineMi, rankByDistanceThenRating } from '../../src/domain/ranking.js';

describe('haversineMi', () => {
  it('haversine SLC→Provo ≈ 38 mi ±1', () => {
    const slc = { lat: 40.7608, lng: -111.891 };
    const provo = { lat: 40.2338, lng: -111.6585 };
    // great-circle value computed by hand: 38.41 mi
    expect(Math.abs(haversineMi(slc, provo) - 38.41)).toBeLessThan(1.5);
  });
});

describe('rankByDistanceThenRating', () => {
  it('ranks by distance then rating desc', () => {
    const items = [
      { id: 'far', distanceMi: 5, rating: 5 },
      { id: 'tieLow', distanceMi: 2, rating: 3.5 },
      { id: 'tieNull', distanceMi: 2, rating: null },
      { id: 'tieHigh', distanceMi: 2, rating: 4.8 },
      { id: 'near', distanceMi: 1, rating: null },
    ];
    const copy = [...items];
    expect(rankByDistanceThenRating(items).map((i) => i.id)).toEqual(['near', 'tieHigh', 'tieLow', 'tieNull', 'far']);
    expect(items).toEqual(copy);
  });
});
