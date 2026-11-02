import test from 'node:test';
import assert from 'node:assert/strict';
import { RequirementSchema } from '../dist/contracts/schemas.js';


const spec = {
  id: 'ui-designer-fixture', name: 'UI Designer fixture', purpose: 'Exercise ui-designer build guidance', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
  differentiators: ['Design-token driven implementation'], acceptance: ['Preserve design tokens'],
};


test('requirement schema accepts a https designRef and rejects non-URLs', () => {
  const url = 'https://www.figma.com/design/abc123/Screen?node-id=1-2';
  assert.equal(RequirementSchema.parse({ ...spec, designRef: url }).designRef, url);
  for (const bad of ['not-a-url', 'ht tp://example.com', '']) {
    assert.equal(RequirementSchema.safeParse({ ...spec, designRef: bad }).success, false, JSON.stringify(bad));
  }
});

