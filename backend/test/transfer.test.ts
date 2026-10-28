import { describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { toTelUri, transferTarget } from '../src/agent/transfer.js';

describe('transfer helpers', () => {
  it('formats Australian numbers as E.164 tel URIs', () => {
    expect(toTelUri('0412 345 678')).toBe('tel:+61412345678');
    expect(toTelUri('(03) 8787 8741')).toBe('tel:+61387878741');
    expect(toTelUri('61387878741')).toBe('tel:+61387878741');
    expect(toTelUri('+61387878741')).toBe('tel:+61387878741');
  });

  it('never transfers to the main line the agent answers', () => {
    const cfg = { ...config, TRANSFER_MAIN: '0387878741', TRANSFER_RESERVATIONS: undefined };
    expect(transferTarget(cfg, 'reservations')).toBeUndefined();
  });

  it('uses the configured department numbers', () => {
    const cfg = { ...config, TRANSFER_RESERVATIONS: '0311112222', TRANSFER_CORPORATE: undefined, TRANSFER_CORPORATE_LARGE: '0499888777' };
    expect(transferTarget(cfg, 'reservations')).toBe('0311112222');
    expect(transferTarget(cfg, 'corporate')).toBe('0499888777');
  });
});
