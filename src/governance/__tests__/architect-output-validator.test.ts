/**
 * architect-output-validator.test.ts
 *
 * Covers the survey + falsifiability enforcement that closes the gap
 * where architect.md's prompt requirement could be ignored by the model.
 */

import { describe, expect, test } from 'bun:test';
import {
  validateArchitectOutput,
  validateSliceCriteria,
  validateArchitectFully,
} from '../workflow/architect-output-validator.js';
import type { Slice } from '../workflow/types.js';

const VALID_OUTPUT = `<plan>
  <survey>
    - Codebase: searched ProjectLayout.tsx; existing nav is a horizontal scroll bar
    - Plugin ecosystem: no slide-out drawer component installed via npm
    - Installed design-system: Tailwind + Radix UI; Radix has @radix-ui/react-dialog suitable
    - Canonical options: Material Design "Navigation drawer" pattern; iOS HIG "Sidebar"
  </survey>
  <decision>Use Radix dialog as the drawer container, matching Material guidelines.</decision>
  <slices>
    - slice-1: { id: nav-drawer-mobile, file_changes: [src/components/project/ProjectLayout.tsx], acceptance_criteria: [\`npm test -- ProjectLayout\` exits 0 with >=4 assertions], risks: [] }
  </slices>
  <risks>
    - { risk: keyboard-nav regression, blast_radius: small, mitigation: a11y test, accept_who: tech-lead }
  </risks>
</plan>`;

describe('validateArchitectOutput — survey enforcement', () => {
  test('valid output with all 4 surveys passes', () => {
    const r = validateArchitectOutput(VALID_OUTPUT);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  test('missing <plan> tag fails hard', () => {
    const r = validateArchitectOutput('just some prose with no tags');
    expect(r.ok).toBe(false);
    const topics = r.issues.map((i) => i.topic);
    expect(topics).toContain('missing-plan-tag');
    expect(topics).toContain('missing-survey-block');
  });

  test('missing <survey> block fails hard', () => {
    const r = validateArchitectOutput('<plan><slices>only slices</slices></plan>');
    expect(r.ok).toBe(false);
    const topics = r.issues.map((i) => i.topic);
    expect(topics).toContain('missing-survey-block');
  });

  test('survey with hand-wave language fails (skipped)', () => {
    const r = validateArchitectOutput(
      '<plan><survey>- Codebase: skipped\n- plugin: ok\n- installed: cli\n- canonical: standard</survey></plan>',
    );
    expect(r.ok).toBe(false);
    const topics = r.issues.map((i) => i.topic);
    expect(topics).toContain('survey-hand-wave');
  });

  test('survey with TODO fails', () => {
    const r = validateArchitectOutput(
      '<plan><survey>- Codebase: TODO\n- plugin: ok\n- installed CLI: ok\n- canonical: ok</survey></plan>',
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.topic === 'survey-hand-wave')).toBe(true);
  });

  test('survey with "trivial" fails', () => {
    const r = validateArchitectOutput(
      '<plan><survey>- Codebase: trivial change, no survey needed\n- plugin: x\n- installed cli: x\n- canonical: x</survey></plan>',
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.topic === 'survey-hand-wave')).toBe(true);
  });

  test('survey missing required slot (no design-system/installed mention)', () => {
    const r = validateArchitectOutput(
      '<plan><survey>- Codebase: x\n- plugin: x\n- canonical: x</survey></plan>',
    );
    expect(r.ok).toBe(false);
    expect(
      r.issues.some(
        (i) =>
          i.topic === 'survey-missing-keyword' &&
          i.detail.includes('installed-cli-or-design-system'),
      ),
    ).toBe(true);
  });
});

describe('validateSliceCriteria — falsifiability enforcement', () => {
  const baseSlice: Slice = {
    id: 'test-slice',
    title: 't',
    skills_required: [],
    file_changes: ['a.ts'],
    interface_contracts: [],
    acceptance_criteria: [],
    risks: [],
    complexity_estimate: 'S',
  };

  test('falsifiable criterion with command passes', () => {
    const r = validateSliceCriteria({
      ...baseSlice,
      acceptance_criteria: ['`npm test` exits 0 with >=12 passing assertions'],
    });
    expect(r.ok).toBe(true);
  });

  test('"looks good" fails as vibe', () => {
    const r = validateSliceCriteria({
      ...baseSlice,
      acceptance_criteria: ['the layout looks good on mobile'],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.topic).toBe('non-falsifiable-criterion');
  });

  test('"feels right" fails', () => {
    const r = validateSliceCriteria({
      ...baseSlice,
      acceptance_criteria: ['interaction feels right'],
    });
    expect(r.ok).toBe(false);
  });

  test('"is clean" fails', () => {
    const r = validateSliceCriteria({
      ...baseSlice,
      acceptance_criteria: ['the code is clean and well-organized'],
    });
    expect(r.ok).toBe(false);
  });

  test('criterion with exit-code reference passes even with vague prose', () => {
    const r = validateSliceCriteria({
      ...baseSlice,
      acceptance_criteria: ['the new behavior is appropriate AND `npm test` exits 0'],
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateArchitectFully', () => {
  test('happy path with all valid slices', () => {
    const slices: Slice[] = [
      {
        id: 'a',
        title: 'a',
        skills_required: [],
        file_changes: ['x.ts'],
        interface_contracts: [],
        acceptance_criteria: ['`tsc --noEmit` exits 0'],
        risks: [],
        complexity_estimate: 'S',
      },
    ];
    const r = validateArchitectFully(VALID_OUTPUT, slices);
    expect(r.ok).toBe(true);
  });

  test('happy survey but one bad slice fails', () => {
    const slices: Slice[] = [
      {
        id: 'b',
        title: 'b',
        skills_required: [],
        file_changes: ['x.ts'],
        interface_contracts: [],
        acceptance_criteria: ['looks good'],
        risks: [],
        complexity_estimate: 'S',
      },
    ];
    const r = validateArchitectFully(VALID_OUTPUT, slices);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.topic === 'non-falsifiable-criterion')).toBe(true);
  });
});
