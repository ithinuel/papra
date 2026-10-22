import { describe, expect, test } from 'vitest';
import { createInMemoryDatabase } from '../app/database/database.test-utils';
import { createTestEventServices } from '../app/events/events.test-utils';
import { overrideConfig } from '../config/config.test-utils';
import { createOrganizationTagLimitReachedError } from './tags.errors';
import { createTagsRepository } from './tags.repository';
import { AI_CREATED_TAG_COLOR } from './tags.constants';
import {
  checkIfOrganizationCanCreateNewTag,
  createTag,
  createTagsAndApplyToDocuments,
} from './tags.usecases';

describe('tags usecases', () => {
  describe('checkIfOrganizationCanCreateNewTag', () => {
    test('when the organization has fewer tags than the limit, no error is thrown', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Tag 1',
            normalizedName: 'tag 1',
            color: '#AA0000',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 5 } });

      await checkIfOrganizationCanCreateNewTag({
        organizationId: 'org-1',
        config,
        tagsRepository,
      });
    });

    test('when the organization has reached the tag limit, an error is thrown', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Tag 1',
            normalizedName: 'tag 1',
            color: '#AA0000',
          },
          {
            id: 'tag-2',
            organizationId: 'org-1',
            name: 'Tag 2',
            normalizedName: 'tag 2',
            color: '#00AA00',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 2 } });

      await expect(
        checkIfOrganizationCanCreateNewTag({
          organizationId: 'org-1',
          config,
          tagsRepository,
        }),
      ).rejects.toThrow(createOrganizationTagLimitReachedError());
    });

    test('tags from other organizations are not counted towards the limit', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [
          { id: 'org-1', name: 'Organization 1' },
          { id: 'org-2', name: 'Organization 2' },
        ],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Tag 1',
            normalizedName: 'tag 1',
            color: '#AA0000',
          },
          {
            id: 'tag-2',
            organizationId: 'org-2',
            name: 'Tag 2',
            normalizedName: 'tag 2',
            color: '#00AA00',
          },
          {
            id: 'tag-3',
            organizationId: 'org-2',
            name: 'Tag 3',
            normalizedName: 'tag 3',
            color: '#0000AA',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 2 } });

      await checkIfOrganizationCanCreateNewTag({
        organizationId: 'org-1',
        config,
        tagsRepository,
      });
    });
  });

  describe('createTag', () => {
    test('when the organization has not reached the tag limit, the tag is created', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
      });

      const tagsRepository = createTagsRepository({ db });
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 5 } });

      const { tag } = await createTag({
        organizationId: 'org-1',
        name: 'New Tag',
        color: '#FF0000',
        config,
        tagsRepository,
      });

      expect(tag).to.include({
        organizationId: 'org-1',
        name: 'New Tag',
        color: '#FF0000',
      });
    });

    test('when the organization has reached the tag limit, creating a new tag throws an error', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Tag 1',
            normalizedName: 'tag 1',
            color: '#AA0000',
          },
          {
            id: 'tag-2',
            organizationId: 'org-1',
            name: 'Tag 2',
            normalizedName: 'tag 2',
            color: '#00AA00',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 2 } });

      await expect(
        createTag({
          organizationId: 'org-1',
          name: 'New Tag',
          color: '#FF0000',
          config,
          tagsRepository,
        }),
      ).rejects.toThrow(createOrganizationTagLimitReachedError());
    });
  });

  describe('createTagsAndApplyToDocuments', () => {
    test('creates the suggested tags and applies them together with the existing ones in a single event', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
        documents: [
          {
            id: 'doc-1',
            organizationId: 'org-1',
            mimeType: 'text/plain',
            originalStorageKey: 'org-1/originals/doc-1.txt',
            name: 'doc-1.txt',
            originalName: 'doc-1.txt',
            originalSha256Hash: 'hash',
          },
        ],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Existing',
            normalizedName: 'existing',
            color: '#AA0000',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const eventServices = createTestEventServices();
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 5 } });

      const { insertedPairs } = await createTagsAndApplyToDocuments({
        documentIds: ['doc-1'],
        organizationId: 'org-1',
        tagIdsToAdd: ['tag-1'],
        tagsToCreate: [{ name: 'New Tag', description: 'A suggested tag' }],
        config,
        tagsRepository,
        eventServices,
      });

      const { tags } = await tagsRepository.getOrganizationTags({ organizationId: 'org-1' });
      const createdTag = tags.find((tag) => tag.name === 'New Tag');

      expect(createdTag).toBeDefined();
      expect(createdTag).to.include({
        color: AI_CREATED_TAG_COLOR,
        description: 'A suggested tag',
      });

      expect(insertedPairs.map(({ tagId }) => tagId).sort()).to.eql(
        ['tag-1', createdTag!.id].sort(),
      );

      // A single document.tags.changed event covers both the existing and the
      // newly created tag
      const tagEvents = eventServices
        .getEmittedEvents()
        .filter(({ eventName }) => eventName === 'document.tags.changed');

      expect(tagEvents.length).to.eql(1);
      expect(tagEvents[0]?.payload.addedPairs).to.have.length(2);
    });

    test('applies the remaining tags when a tag creation fails (organization tag limit)', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
        documents: [
          {
            id: 'doc-1',
            organizationId: 'org-1',
            mimeType: 'text/plain',
            originalStorageKey: 'org-1/originals/doc-1.txt',
            name: 'doc-1.txt',
            originalName: 'doc-1.txt',
            originalSha256Hash: 'hash',
          },
        ],
        tags: [
          {
            id: 'tag-1',
            organizationId: 'org-1',
            name: 'Tag 1',
            normalizedName: 'tag 1',
            color: '#AA0000',
          },
          {
            id: 'tag-2',
            organizationId: 'org-1',
            name: 'Tag 2',
            normalizedName: 'tag 2',
            color: '#00AA00',
          },
        ],
      });

      const tagsRepository = createTagsRepository({ db });
      const eventServices = createTestEventServices();
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 2 } });

      const { insertedPairs } = await createTagsAndApplyToDocuments({
        documentIds: ['doc-1'],
        organizationId: 'org-1',
        tagIdsToAdd: ['tag-1'],
        // Over the limit: this creation is dropped, the existing tag is still applied
        tagsToCreate: [{ name: 'Over Limit' }],
        config,
        tagsRepository,
        eventServices,
      });

      expect(insertedPairs.map(({ tagId }) => tagId)).to.eql(['tag-1']);

      const { tags } = await tagsRepository.getOrganizationTags({ organizationId: 'org-1' });
      expect(tags.some((tag) => tag.name === 'Over Limit')).toBe(false);
    });

    test('no event is emitted when there is nothing to create nor to add', async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [{ id: 'org-1', name: 'Organization 1' }],
      });

      const tagsRepository = createTagsRepository({ db });
      const eventServices = createTestEventServices();
      const config = overrideConfig({ tags: { maxTagsPerOrganization: 5 } });

      await createTagsAndApplyToDocuments({
        documentIds: ['doc-1'],
        organizationId: 'org-1',
        tagIdsToAdd: [],
        tagsToCreate: [],
        config,
        tagsRepository,
        eventServices,
      });

      expect(eventServices.getEmittedEvents()).to.eql([]);
    });
  });
});
