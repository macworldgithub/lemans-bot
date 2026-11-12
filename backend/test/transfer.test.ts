import { describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { aiMayCloseRoom, createCallState, setCallOwnership } from '../src/agent/state.js';
import {
  canonicalPhoneNumber,
  resolveTransferTarget,
  toTelUri,
  transferTarget,
} from '../src/agent/transfer.js';

describe('transfer helpers', () => {
  it('formats Australian numbers as E.164 tel URIs', () => {
    expect(toTelUri('0412 345 678')).toBe('tel:+61412345678');
    expect(toTelUri('(03) 8787 8741')).toBe('tel:+61387878741');
    expect(toTelUri('61387878741')).toBe('tel:+61387878741');
    expect(toTelUri('+61387878741')).toBe('tel:+61387878741');
  });

  it('normalizes numbers before comparison', () => {
    expect(canonicalPhoneNumber('(03) 8787 8741')).toBe('+61387878741');
    expect(canonicalPhoneNumber('0387878741')).toBe('+61387878741');
    expect(canonicalPhoneNumber('+61 387 878 741')).toBe('+61387878741');
    expect(canonicalPhoneNumber('8888')).toBe('8888');
    expect(canonicalPhoneNumber('call me')).toBeNull();
  });

  it('never transfers to the main line the agent answers, in any format', () => {
    for (const reservations of ['0387878741', '+61387878741', '61387878741', '(03) 8787 8741']) {
      const cfg = { ...config, TRANSFER_MAIN: '0387878741', TRANSFER_RESERVATIONS: reservations };
      expect(transferTarget(cfg, 'reservations')).toBeUndefined();
      expect(resolveTransferTarget(cfg, 'reservations').reason).toBe('blocked_entry');
    }
  });

  it('blocks the known agent entry extension 8888', () => {
    const cfg = { ...config, TRANSFER_MAIN: undefined, TRANSFER_RESERVATIONS: '8888' };
    expect(transferTarget(cfg, 'reservations')).toBeUndefined();
    expect(resolveTransferTarget(cfg, 'reservations').reason).toBe('blocked_entry');
  });

  it('blocks extra configured entry routes', () => {
    const cfg = {
      ...config,
      TRANSFER_MAIN: undefined,
      AGENT_ENTRY_NUMBERS: '8888, 0287907749',
      TRANSFER_RESERVATIONS: '+61287907749',
    };
    expect(resolveTransferTarget(cfg, 'reservations').reason).toBe('blocked_entry');
  });

  it('rejects malformed destinations instead of dialling them', () => {
    for (const reservations of ['abc', '123', '+', '0412CALLME', '12345678901234567890']) {
      const cfg = { ...config, TRANSFER_MAIN: undefined, TRANSFER_RESERVATIONS: reservations };
      expect(transferTarget(cfg, 'reservations')).toBeUndefined();
      expect(resolveTransferTarget(cfg, 'reservations').reason).toBe('malformed');
    }
  });

  it('reports an unconfigured route without inventing a destination', () => {
    const cfg = {
      ...config,
      TRANSFER_RESERVATIONS: undefined,
      TRANSFER_CORPORATE: undefined,
      TRANSFER_CORPORATE_LARGE: undefined,
      TRANSFER_DUTY_MANAGER: undefined,
    };
    expect(resolveTransferTarget(cfg, 'reservations')).toEqual({ reason: 'unconfigured' });
    expect(resolveTransferTarget(cfg, 'corporate')).toEqual({ reason: 'unconfigured' });
    expect(resolveTransferTarget(cfg, 'duty_manager')).toEqual({ reason: 'unconfigured' });
  });

  it('uses the configured department numbers when they are safe', () => {
    const cfg = {
      ...config,
      TRANSFER_MAIN: undefined,
      TRANSFER_RESERVATIONS: '0311112222',
      TRANSFER_CORPORATE: undefined,
      TRANSFER_CORPORATE_LARGE: '0499888777',
    };
    expect(transferTarget(cfg, 'reservations')).toBe('0311112222');
    expect(transferTarget(cfg, 'corporate')).toBe('0499888777');
    expect(resolveTransferTarget(cfg, 'reservations').reason).toBe('ok');
  });

  it('keeps a human-owned call alive after AI departure', () => {
    const state = createCallState({ callId: 'call-human' });
    expect(aiMayCloseRoom(state)).toBe(true);
    setCallOwnership(state, 'human');
    expect(aiMayCloseRoom(state)).toBe(false);
  });
});
