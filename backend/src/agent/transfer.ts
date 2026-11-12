import type { Config } from '../config.js';
import type { Department } from '../shared/events.js';

export type TransferTargetReason = 'ok' | 'unconfigured' | 'blocked_entry' | 'malformed';

export interface ResolvedTransferTarget {
  target?: string;
  reason: TransferTargetReason;
}

/**
 * One canonical form for comparison. Australian numbers become +61...,
 * short extensions stay short, and malformed input returns null.
 */
export function canonicalPhoneNumber(input: string): string | null {
  const raw = input.trim().replace(/^tel:/i, '');
  // Only phone punctuation is accepted. Letters and other characters make the value unsafe.
  if (!/^\+?[\d\s\-().]+$/.test(raw)) return null;

  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+')) {
    if (digits.indexOf('+', 1) !== -1) return null;
    return digits;
  }
  if (/^\d{1,6}$/.test(digits)) return digits; // extension or short code
  if (digits.startsWith('61')) return `+${digits}`;
  if (digits.startsWith('0')) return `+61${digits.slice(1)}`;
  return digits;
}

function isPublicPhoneNumber(number: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(number);
}

function entryNumbers(cfg: Config): string[] {
  const configured = (cfg.AGENT_ENTRY_NUMBERS ?? '')
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [cfg.TRANSFER_MAIN, '8888', ...configured].filter((value): value is string => Boolean(value));
}

function isEntryNumber(cfg: Config, canonical: string): boolean {
  return entryNumbers(cfg).some((entry) => canonicalPhoneNumber(entry) === canonical);
}

/**
 * Resolve an approved department route. The model never supplies a destination.
 * Entry routes, short extensions, and malformed values are blocked here.
 */
export function resolveTransferTarget(cfg: Config, department: Department): ResolvedTransferTarget {
  let candidate: string | undefined;
  switch (department) {
    case 'reservations':
      candidate = cfg.TRANSFER_RESERVATIONS;
      break;
    case 'corporate':
      candidate = cfg.TRANSFER_CORPORATE ?? cfg.TRANSFER_CORPORATE_LARGE;
      break;
    case 'duty_manager':
      candidate = cfg.TRANSFER_DUTY_MANAGER;
      break;
  }

  if (!candidate) return { reason: 'unconfigured' };

  const canonical = canonicalPhoneNumber(candidate);
  if (!canonical) return { reason: 'malformed' };
  if (isEntryNumber(cfg, canonical)) return { reason: 'blocked_entry' };
  if (!isPublicPhoneNumber(canonical)) return { reason: 'malformed' };

  return { target: candidate, reason: 'ok' };
}

/** Number a department transfers to, or undefined when not configured or unsafe. */
export function transferTarget(cfg: Config, department: Department): string | undefined {
  return resolveTransferTarget(cfg, department).target;
}

/** Australian numbers to a SIP REFER target: 0412 345 678 → tel:+61412345678. */
export function toTelUri(number: string): string {
  const canonical = canonicalPhoneNumber(number) ?? number;
  return `tel:${canonical}`;
}
