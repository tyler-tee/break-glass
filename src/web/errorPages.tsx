import type { Context } from 'hono';
import { page, type PageChrome } from './Layout.js';

export const notFoundPage = (c: Context, chrome: PageChrome = {}) =>
  page(
    c,
    'Page not found',
    <>
      <h1>Page not found</h1>
      <p>We could not find that page.</p>
    </>,
    404,
    chrome,
  );

/** Generic on purpose: never echo error messages or stacks into the HTML. */
export const serverErrorPage = (c: Context, chrome: PageChrome = {}) =>
  page(
    c,
    'Something went wrong',
    <>
      <h1>Something went wrong</h1>
      <p>Something went wrong on our side. Please try again in a moment.</p>
    </>,
    500,
    chrome,
  );
