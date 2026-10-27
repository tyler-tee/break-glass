import type { Context } from 'hono';
import type { PlacesError } from '../services/places/client.js';
import { AdminNav } from './components/AdminNav.js';
import { page } from './Layout.js';

export const placesErrorPage = (c: Context, e: PlacesError) =>
  page(
    c,
    'Places API error',
    <>
      <h1>Places API error</h1>
      <AdminNav />
      <p role="alert">{`Places API error ${e.status}: ${e.body.slice(0, 200)}`}</p>
    </>,
    502,
  );
