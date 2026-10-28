import type { Config } from '../config.js';
import type { Department } from '../shared/events.js';

/**
 * Number a department transfers to, or undefined when not configured.
 * TRANSFER_MAIN is the line this agent answers, so it is never a target (it would loop back).
 */
export function transferTarget(cfg: Config, department: Department): string | undefined {
  switch (department) {
    case 'reservations':
      return cfg.TRANSFER_RESERVATIONS;
    case 'corporate':
      return cfg.TRANSFER_CORPORATE ?? cfg.TRANSFER_CORPORATE_LARGE;
    case 'duty_manager':
      return cfg.TRANSFER_DUTY_MANAGER;
  }
}

/** Australian numbers to a SIP REFER target: 0412 345 678 → tel:+61412345678. */
export function toTelUri(number: string): string {
  const digits = number.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `tel:${digits}`;
  if (digits.startsWith('61')) return `tel:+${digits}`;
  if (digits.startsWith('0')) return `tel:+61${digits.slice(1)}`;
  return `tel:${digits}`;
}
