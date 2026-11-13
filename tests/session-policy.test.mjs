import test from 'node:test';
import assert from 'node:assert/strict';
import {googleSessionAllowed} from '../lib/session-policy.mjs';

const clientId = 'test.apps.googleusercontent.com';
const savedSession = {user_id: 'google:123', email: 'PreviousOwner@example.com', name: 'Previous owner'};

test('an existing session loses authorization when the allowed account changes', () => {
  assert.equal(googleSessionAllowed(savedSession, clientId, 'previousowner@example.com'), true);
  assert.equal(googleSessionAllowed(savedSession, clientId, 'newowner@example.com'), false);
  assert.equal(googleSessionAllowed({...savedSession, email: 'newowner@example.com'}, clientId, 'newowner@example.com'), true);
});

test('the current allowlist matches email case-insensitively with trimmed settings', () => {
  assert.equal(googleSessionAllowed(savedSession, clientId, '  PREVIOUSOWNER@EXAMPLE.COM  '), true);
});

test('old Google sessions are unusable when Google configuration is disabled', () => {
  assert.equal(googleSessionAllowed(savedSession, undefined, undefined), false);
  assert.equal(googleSessionAllowed(savedSession, '', 'PreviousOwner@example.com'), false);
});

test('unrestricted Google mode accepts valid Google sessions but not malformed identities', () => {
  assert.equal(googleSessionAllowed(savedSession, clientId, undefined), true);
  assert.equal(googleSessionAllowed(savedSession, clientId, ''), true);
  assert.equal(googleSessionAllowed(null, clientId, ''), false);
  assert.equal(googleSessionAllowed({...savedSession, user_id: 'local_seedy'}, clientId, ''), false);
  assert.equal(googleSessionAllowed({...savedSession, email: null}, clientId, ''), false);
});
