import { expect } from 'chai';

import {
  buildTestMetadataMap,
  computeCommonRoot,
} from '../../src/services/flow-paths.js';

describe('flow-paths', () => {
  describe('computeCommonRoot', () => {
    it('returns the deepest shared directory for sibling files', () => {
      expect(
        computeCommonRoot(
          ['/a/b/flows/login.yaml', '/a/b/flows/checkout.yaml'],
          [],
        ),
      ).to.equal('/a/b/flows');
    });

    it('stops at a whole-segment boundary (no partial-prefix merge)', () => {
      // `flows` and `flows-extra` share the `flow` substring but not a segment.
      expect(
        computeCommonRoot(
          ['/a/b/flows/login.yaml', '/a/b/flows-extra/x.yaml'],
          [],
        ),
      ).to.equal('/a/b');
    });

    it('never consumes the file segment itself', () => {
      expect(computeCommonRoot(['/a/only.yaml'], [])).to.equal('/a');
    });

    it('folds referenced files into the calculation', () => {
      expect(
        computeCommonRoot(['/a/b/flows/login.yaml'], ['/a/b/helpers/util.js']),
      ).to.equal('/a/b');
    });

    it('returns empty string when given no paths', () => {
      expect(computeCommonRoot([], [])).to.equal('');
    });
  });

  describe('buildTestMetadataMap', () => {
    it('keys by portable relative path and reads name + tags', () => {
      const map = buildTestMetadataMap(
        { '/a/b/flows/login.yaml': { name: 'Login', tags: ['smoke', 'auth'] } },
        '/a/b/flows',
      );
      expect(map).to.deep.equal({
        './login.yaml': { flowName: 'Login', tags: ['smoke', 'auth'] },
      });
    });

    it('falls back to the filename when no name is set', () => {
      const map = buildTestMetadataMap(
        { '/a/b/flows/checkout.yaml': {} },
        '/a/b/flows',
      );
      expect(map['./checkout.yaml']).to.deep.equal({
        flowName: 'checkout',
        tags: [],
      });
    });

    it('normalizes a single string tag into an array', () => {
      const map = buildTestMetadataMap(
        { '/a/b/flows/x.yaml': { tags: 'smoke' } },
        '/a/b/flows',
      );
      expect(map['./x.yaml'].tags).to.deep.equal(['smoke']);
    });
  });
});
