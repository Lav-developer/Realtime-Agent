const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'public/client.js'), 'utf8');

test('chat shell constrains the viewport and makes only message history scrollable', () => {
  assert.match(css, /\.app\s*\{[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.main\s*\{[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.messages\s*\{[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;/);
  assert.match(css, /\.sidebar\s*\{[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.side-scroll\s*\{[\s\S]*min-height: 0;[\s\S]*overflow: auto;/);
  assert.match(css, /\.composer\s*\{[\s\S]*flex-shrink: 0;/);
  assert.match(css, /\.body\s*\{[\s\S]*overflow-wrap: anywhere;/);
});

test('scroll code only follows new messages for bottom readers and exposes jump action', () => {
  assert.match(client, /const wasNearBottom = nearBottom\(\);[\s\S]*state\.messages\.push\(msg\)/);
  assert.match(client, /if \(wasNearBottom \|\| msg\.user\?\.id === state\.me\?\.id\)/);
  assert.match(client, /jumpLatest\.hidden = false/);
  assert.match(client, /scrollToBottom\(true, true\)/);
  assert.match(client, /renderMessages\(\{ forceBottom: true \}\)/);
});
