import type { EventServices } from '../app/events/events.services';
import type { Config } from '../config/config.types';
import type { DocumentActivityRepository } from '../documents/document-activity/document-activity.repository';
import type { Logger } from '../shared/logger/logger';
import type { WebhookTriggerServices } from '../webhooks/webhooks.trigger.services';
import type { TagsRepository } from './tags.repository';
import type { Tag } from './tags.types';
import pLimit from 'p-limit';
import { deferRegisterDocumentActivityLog } from '../documents/document-activity/document-activity.usecases';
import { createLogger } from '../shared/logger/logger';
import { createOrganizationTagLimitReachedError, createTagNotFoundError } from './tags.errors';
import { AI_CREATED_TAG_COLOR } from './tags.constants';

export async function checkIfOrganizationCanCreateNewTag({
  organizationId,
  config,
  tagsRepository,
}: {
  organizationId: string;
  config: Config;
  tagsRepository: TagsRepository;
}) {
  const { tagsCount } = await tagsRepository.getOrganizationTagsCount({ organizationId });

  if (tagsCount >= config.tags.maxTagsPerOrganization) {
    throw createOrganizationTagLimitReachedError();
  }
}

export async function createTag({
  organizationId,
  name,
  color,
  description,
  config,
  tagsRepository,
}: {
  organizationId: string;
  name: string;
  color: string;
  description?: string;
  config: Config;
  tagsRepository: TagsRepository;
}) {
  await checkIfOrganizationCanCreateNewTag({ organizationId, config, tagsRepository });

  const { tag } = await tagsRepository.createTag({
    tag: { organizationId, name, color, description },
  });

  return { tag };
}

export async function addTagToDocument({
  tagId,
  documentId,
  organizationId,
  userId,
  tag,

  tagsRepository,
  webhookTriggerServices,
  documentActivityRepository,
}: {
  tagId: string;
  documentId: string;
  organizationId: string;
  userId?: string;
  tag: Tag;

  tagsRepository: TagsRepository;
  webhookTriggerServices: WebhookTriggerServices;
  documentActivityRepository: DocumentActivityRepository;
}) {
  await tagsRepository.addTagToDocument({ tagId, documentId });

  webhookTriggerServices.deferTriggerWebhooks({
    organizationId,
    event: 'document:tag:added',
    payloads: [{ documentId, organizationId, tagId, tagName: tag.name }],
  });

  deferRegisterDocumentActivityLog({
    documentId,
    event: 'tagged',
    userId,
    documentActivityRepository,
    tagId,
  });
}

export type DocumentTagPair = { documentId: string; tagId: string };

export async function applyTagsToDocuments({
  documentIds,
  addTagIds = [],
  removeTagIds = [],
  organizationId,
  userId,

  tagsRepository,
  eventServices,
  logger = createLogger({ namespace: 'tags.usecases' }),
}: {
  documentIds: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
  organizationId: string;
  userId?: string;

  tagsRepository: TagsRepository;
  eventServices: EventServices;
  logger?: Logger;
}): Promise<{ insertedPairs: DocumentTagPair[]; removedPairs: DocumentTagPair[] }> {
  if (documentIds.length === 0 || (addTagIds.length === 0 && removeTagIds.length === 0)) {
    return { insertedPairs: [], removedPairs: [] };
  }

  const requestedTagIds = [...new Set([...addTagIds, ...removeTagIds])];
  const { tags } = await tagsRepository.getTagsByIds({ tagIds: requestedTagIds, organizationId });

  if (tags.length !== requestedTagIds.length) {
    throw createTagNotFoundError();
  }

  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));

  const [{ insertedPairs }, { removedPairs }] = await Promise.all([
    tagsRepository.addTagsToDocumentsBatch({ documentIds, tagIds: addTagIds }),
    tagsRepository.removeTagsFromDocumentsBatch({ documentIds, tagIds: removeTagIds }),
  ]);

  if (insertedPairs.length > 0 || removedPairs.length > 0) {
    const toEventPair = ({ documentId, tagId }: DocumentTagPair) => ({
      documentId,
      tagId,
      tagName: tagsById.get(tagId)?.name ?? '',
    });

    eventServices.emitEvent({
      eventName: 'document.tags.changed',
      payload: {
        organizationId,
        userId,
        addedPairs: insertedPairs.map(toEventPair),
        removedPairs: removedPairs.map(toEventPair),
      },
    });
  }

  logger.info(
    {
      organizationId,
      userId,
      documentCount: documentIds.length,
      taggedCount: insertedPairs.length,
      untaggedCount: removedPairs.length,
    },
    'Applied tag changes to documents',
  );

  return { insertedPairs, removedPairs };
}

/**
 * Applies the outcome of an AI tag suggestion to documents: creates the
 * suggested tags (best-effort — the organization tag limit or a concurrent
 * creation race must not fail the whole operation) and attaches both the new
 * tags and the already-existing ones in a single
 * {@link applyTagsToDocuments} call, so webhooks and activity events are
 * emitted once.
 */
export async function createTagsAndApplyToDocuments({
  documentIds,
  organizationId,
  tagIdsToAdd,
  tagsToCreate,
  config,
  tagsRepository,
  eventServices,
  logger = createLogger({ namespace: 'tags.usecases' }),
}: {
  documentIds: string[];
  organizationId: string;
  tagIdsToAdd: string[];
  tagsToCreate: { name: string; description?: string | null }[];
  config: Config;
  tagsRepository: TagsRepository;
  eventServices: EventServices;
  logger?: Logger;
}) {
  const limit = pLimit(5);

  // TODO: introduce a createTags method with a new checkIfOrganizationCanCreateNewTag
  const createdTagsResults = await Promise.allSettled(
    tagsToCreate.map(async ({ name, description }) =>
      limit(async () =>
        createTag({
          organizationId,
          color: AI_CREATED_TAG_COLOR,
          name,
          description: description ?? undefined,
          config,
          tagsRepository,
        }),
      ),
    ),
  );

  const createdTags = createdTagsResults
    .filter(
      (result): result is PromiseFulfilledResult<{ tag: Tag }> => result.status === 'fulfilled',
    )
    .map((result) => result.value.tag);

  return applyTagsToDocuments({
    documentIds,
    addTagIds: [...tagIdsToAdd, ...createdTags.map((tag) => tag.id)],
    removeTagIds: [],
    organizationId,
    userId: undefined,
    tagsRepository,
    eventServices,
    logger,
  });
}
