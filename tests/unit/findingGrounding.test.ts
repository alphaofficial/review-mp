import { describe, expect, it } from 'vitest';
import { filterUnsupportedFindings } from '../../src/harness/findingGrounding';
import { ReviewRequest } from '../../src/types/review';

function baseRequest(code: string): ReviewRequest {
  return {
    code,
    languageId: 'typescript',
    filePath: 'src/example.ts',
    reviewType: 'file',
    reviewPackage: {
      reviewType: 'file',
      strictReviewOnly: true,
      scopeLabel: 'File review: src/example.ts',
      target: {
        kind: 'file',
        filePath: 'src/example.ts',
        languageId: 'typescript',
        content: code,
      },
      supportingContext: [],
    },
  };
}

describe('filterUnsupportedFindings', () => {
  it('keeps findings with exact evidence from supplied review material', async () => {
    const code = 'export function run(value?: string) {\n  return value.length;\n}';

    const comments = await filterUnsupportedFindings(baseRequest(code), [{
      file: 'src/example.ts',
      line: 1,
      message: 'value can be undefined before reading length.',
      severity: 'warning',
      evidence: [{
        file: 'src/example.ts',
        line: 1,
        quote: 'return value.length;',
      }],
    }]);

    expect(comments).toHaveLength(1);
  });

  it('drops findings whose evidence quote is not in the supplied review material', async () => {
    const code = 'export function run(value: string) {\n  return value.length;\n}';

    const comments = await filterUnsupportedFindings(baseRequest(code), [{
      file: 'src/example.ts',
      line: 1,
      message: 'The function calls a missing authenticateUser helper.',
      severity: 'warning',
      evidence: [{
        file: 'src/example.ts',
        line: 1,
        quote: 'authenticateUser(request)',
      }],
    }]);

    expect(comments).toHaveLength(0);
  });

  it('still drops legacy comments directly contradicted by parsed source', async () => {
    const code = `type MockSwipeableProps = {
  children?: React.ReactNode
  renderRightActions?: () => React.ReactNode
}

const Swipeable = ({ renderRightActions }: MockSwipeableProps) => null`;

    const comments = await filterUnsupportedFindings(baseRequest(code), [{
      file: 'src/example.ts',
      line: 5,
      title: 'Destructured property not in type',
      message: 'renderRightActions does not exist on MockSwipeableProps.',
      severity: 'error',
    }]);

    expect(comments).toHaveLength(0);
  });
});
