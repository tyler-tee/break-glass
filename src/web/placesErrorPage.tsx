import type { Context } from 'hono';
import type { BudgetReason } from '../services/places/budget.js';
import type { PlacesError } from '../services/places/client.js';
import { page } from './Layout.js';

export const placesErrorPage = (c: Context, e: PlacesError) =>
  page(
    c,
    'Places API error',
    <>
      <h1>Places API error</h1>
      <p role="alert">{`Places API error ${e.status}: ${e.body.slice(0, 200)}`}</p>
    </>,
    502,
    { layout: 'admin' },
  );

export const budgetExhaustedPage = (c: Context, reason: BudgetReason) =>
  page(
    c,
    'Places call cap reached',
    <>
      <h1>Places call cap reached</h1>
      <p role="alert">
        {`Places call cap reached (${reason}). Raise PLACES_CALL_CAP / PLACES_MONTHLY_CAP or wait for next month.`}
      </p>
    </>,
    429,
    { layout: 'admin' },
  );
