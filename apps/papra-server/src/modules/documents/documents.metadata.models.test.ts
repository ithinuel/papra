import { describe, expect, it } from 'vitest';
import { buildExtractionTagActions, parseValueForPropertyType } from './documents.metadata.models';
import { CUSTOM_PROPERTY_TYPES } from '../custom-properties/custom-properties.constants';

describe('documents.metadata.models', () => {
  describe('buildExtractionTagActions', () => {
    const existingTags = [
      { id: 'tag-1', name: 'Invoice' },
      { id: 'tag-2', name: 'tax-deductible' },
    ];

    it('matches existing tags case-insensitively and keeps order', () => {
      const { tagIdsToAdd, tagsToCreate } = buildExtractionTagActions({
        tags: ['TAX-DEDUCTIBLE', 'invoice'],
        existingTags,
        allowNewTags: false,
        maxTags: 5,
      });

      expect(tagIdsToAdd).to.eql(['tag-2', 'tag-1']);
      expect(tagsToCreate).to.eql([]);
    });

    it('deduplicates suggestions matching the same tag', () => {
      const { tagIdsToAdd } = buildExtractionTagActions({
        tags: ['Invoice', 'invoice', { name: 'INVOICE' }],
        existingTags,
        allowNewTags: true,
        maxTags: 5,
      });

      expect(tagIdsToAdd).to.eql(['tag-1']);
    });

    it('creates unknown tags only when allowed', () => {
      const suggestions = ['invoice', 'urgent', { name: 'Vendor Acme', description: 'A vendor' }];

      const blocked = buildExtractionTagActions({
        tags: suggestions,
        existingTags,
        allowNewTags: false,
        maxTags: 5,
      });
      expect(blocked.tagIdsToAdd).to.eql(['tag-1']);
      expect(blocked.tagsToCreate).to.eql([]);

      const allowed = buildExtractionTagActions({
        tags: suggestions,
        existingTags,
        allowNewTags: true,
        maxTags: 5,
      });
      expect(allowed.tagIdsToAdd).to.eql(['tag-1']);
      expect(allowed.tagsToCreate).to.eql([
        { name: 'urgent', description: null },
        { name: 'Vendor Acme', description: 'A vendor' },
      ]);
    });

    it('caps the suggestions at maxTags before resolving', () => {
      const { tagIdsToAdd, tagsToCreate } = buildExtractionTagActions({
        tags: ['invoice', 'urgent', 'tax deductible'],
        existingTags,
        allowNewTags: true,
        maxTags: 2,
      });

      expect(tagIdsToAdd).to.eql(['tag-1']);
      expect(tagsToCreate).to.eql([{ name: 'urgent', description: null }]);
    });

    it('skips empty suggestions', () => {
      const { tagIdsToAdd, tagsToCreate } = buildExtractionTagActions({
        tags: ['', '   ', { name: '' }],
        existingTags,
        allowNewTags: true,
        maxTags: 5,
      });

      expect(tagIdsToAdd).to.eql([]);
      expect(tagsToCreate).to.eql([]);
    });
  });

  it('parses number values', () => {
    expect(
      parseValueForPropertyType('42.5', { type: CUSTOM_PROPERTY_TYPES.NUMBER, options: [] }),
    ).to.eql(42.5);
    expect(
      parseValueForPropertyType('abc', { type: CUSTOM_PROPERTY_TYPES.NUMBER, options: [] }),
    ).toBeNull();
  });

  it('parses date values and rejects invalid ones', () => {
    // The plain value is kept as the original string; the type's input schema
    // (v.toDate()) performs the conversion, keeping validation single-sourced.
    expect(
      parseValueForPropertyType('2024-01-15', { type: CUSTOM_PROPERTY_TYPES.DATE, options: [] }),
    ).to.eql('2024-01-15');
    expect(
      parseValueForPropertyType('not-a-date', { type: CUSTOM_PROPERTY_TYPES.DATE, options: [] }),
    ).toBeNull();
  });

  it('parses boolean values', () => {
    expect(
      parseValueForPropertyType('yes', { type: CUSTOM_PROPERTY_TYPES.BOOLEAN, options: [] }),
    ).to.eql(true);
    expect(
      parseValueForPropertyType('no', { type: CUSTOM_PROPERTY_TYPES.BOOLEAN, options: [] }),
    ).to.eql(false);
    expect(
      parseValueForPropertyType('maybe', { type: CUSTOM_PROPERTY_TYPES.BOOLEAN, options: [] }),
    ).toBeNull();
  });

  it('matches select options by name or key (case-insensitive), returning the option id', () => {
    const options = [
      { id: 'opt-1', name: 'USD', key: 'usd' },
      { id: 'opt-2', name: 'EUR', key: 'eur' },
    ];
    expect(
      parseValueForPropertyType('usd', { type: CUSTOM_PROPERTY_TYPES.SELECT, options }),
    ).to.eql('opt-1');
    expect(
      parseValueForPropertyType('EUR', { type: CUSTOM_PROPERTY_TYPES.SELECT, options }),
    ).to.eql('opt-2');
    expect(
      parseValueForPropertyType('GBP', { type: CUSTOM_PROPERTY_TYPES.SELECT, options }),
    ).toBeNull();
  });

  it('returns text for text and unknown types', () => {
    expect(
      parseValueForPropertyType('hello', { type: CUSTOM_PROPERTY_TYPES.TEXT, options: [] }),
    ).to.eql('hello');
  });

  it('returns null for unsupported relation types', () => {
    expect(
      parseValueForPropertyType('x', { type: CUSTOM_PROPERTY_TYPES.USER_RELATION, options: [] }),
    ).toBeNull();
  });
});
