import { v4 as uuidv4 } from 'uuid';

/**
 * Generates a unique token for email verification or password resets.
 */
export function generateToken(): string {
  return uuidv4();
}

/**
 * Returns a Date object set to `days` days from now.
 */
export function getExpiryDate(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}
