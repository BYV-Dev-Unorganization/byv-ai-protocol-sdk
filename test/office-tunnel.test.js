'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendCsvValue, resolveOfficeTunnelConfig } = require('../scripts/office-tunnel');

test('builds a safe Office tunnel environment with the public host and Office CORS origin', () => {
  const config = resolveOfficeTunnelConfig({
    CLOUDFLARE_TUNNEL_TOKEN: 'test-token',
    OFFICE_GATEWAY_HOSTNAME: 'claude-office.example.com',
    HOST: '127.0.0.1',
    PORT: '8787',
    GATEWAY_ALLOWED_HOSTS: 'other.example.com',
    CORS_ALLOWED_ORIGINS: 'https://trusted.example'
  });

  assert.equal(config.publicUrl, 'https://claude-office.example.com');
  assert.equal(config.localUrl, 'http://127.0.0.1:8787');
  assert.equal(config.childEnv.HOST, '127.0.0.1');
  assert.equal(config.childEnv.GATEWAY_ALLOWED_HOSTS, 'other.example.com,claude-office.example.com');
  assert.equal(config.childEnv.CORS_ALLOWED_ORIGINS, 'https://trusted.example,https://pivot.claude.ai');
  assert.equal(config.childEnv.CLOUDFLARE_TUNNEL_TOKEN, 'test-token');
});

test('accepts an HTTPS URL but rejects non-public or path-bearing gateway hostnames', () => {
  const base = { CLOUDFLARE_TUNNEL_TOKEN: 'test-token', HOST: 'localhost' };
  assert.equal(resolveOfficeTunnelConfig({
    ...base,
    OFFICE_GATEWAY_HOSTNAME: 'https://claude-office.example.com'
  }).hostname, 'claude-office.example.com');

  for (const hostname of [
    'http://claude-office.example.com',
    'localhost',
    'api.localhost',
    'claude-office.example.com:8443',
    'claude-office.example.com/path'
  ]) {
    assert.throws(() => resolveOfficeTunnelConfig({
      ...base,
      OFFICE_GATEWAY_HOSTNAME: hostname
    }), /OFFICE_GATEWAY_HOSTNAME/);
  }
});

test('requires a tunnel token, public hostname, and loopback gateway binding', () => {
  assert.throws(() => resolveOfficeTunnelConfig({}), /CLOUDFLARE_TUNNEL_TOKEN/);
  assert.throws(() => resolveOfficeTunnelConfig({
    CLOUDFLARE_TUNNEL_TOKEN: 'test-token'
  }), /OFFICE_GATEWAY_HOSTNAME/);
  assert.throws(() => resolveOfficeTunnelConfig({
    CLOUDFLARE_TUNNEL_TOKEN: 'test-token',
    OFFICE_GATEWAY_HOSTNAME: 'claude-office.example.com',
    HOST: '0.0.0.0'
  }), /HOST must stay on loopback/);
  assert.throws(() => resolveOfficeTunnelConfig({
    CLOUDFLARE_TUNNEL_TOKEN: 'test-token',
    OFFICE_GATEWAY_HOSTNAME: 'claude-office.example.com',
    PORT: '70000'
  }), /PORT must be an integer/);
});

test('formats IPv6 loopback URLs for the readiness probe', () => {
  const config = resolveOfficeTunnelConfig({
    CLOUDFLARE_TUNNEL_TOKEN: 'test-token',
    OFFICE_GATEWAY_HOSTNAME: 'claude-office.example.com',
    HOST: '::1',
    PORT: '8787'
  });
  assert.equal(config.localUrl, 'http://[::1]:8787');
});

test('appends a configured CSV value without duplicating it', () => {
  assert.equal(
    appendCsvValue('https://pivot.claude.ai, https://trusted.example', 'https://pivot.claude.ai'),
    'https://pivot.claude.ai,https://trusted.example'
  );
});
