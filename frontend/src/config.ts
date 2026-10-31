import { z } from 'zod';

const ApiOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/'
  );
});
export const config = {
  apiBaseUrl: ApiOriginSchema.parse(
    import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001',
  ).replace(/\/$/, ''),
};
